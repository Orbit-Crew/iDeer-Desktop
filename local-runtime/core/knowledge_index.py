"""Device-side BM25 full-text index over frozen knowledge revisions (#97).

Every explicit import (#112/#96) already parses its documents on the device;
this store keeps the extracted text and an inverted term index behind the
frozen revision identity, so ``local.knowledge.search`` answers from a real
BM25 ranking with document and page locations instead of re-scanning raw
bytes line by line. The index is device-local display and retrieval state:
original bytes and index content never leave the device, and a revision the
device never registered has no rows here at all.

Honesty is the design constraint. A document row records the frozen digest
its text was indexed from, so an intact revision's index text is exactly the
hash-verified frozen content — the #113 contract (never substitute current
content for a frozen revision) holds unchanged; only the scan is replaced.
Documents that cannot honestly serve text (unsupported legacy formats,
failed parses, files that no longer hash to their frozen digest) keep
explicit non-servable rows or no row at all, the search reports them as
structured ``missing``, and the observed drift count is stored so the doc
library can say 已过期 instead of pretending the index is current. A search
never writes content; it may only record the drift fact it observed.

Rebuilds (#97) re-verify every manifest document against the live workspace
bytes and re-index what still hashes to its frozen digest. A canceled
rebuild keeps the per-document rows written so far — each row is
self-consistent frozen content — and a revision only reads as complete once
every manifest document has a row, so partial work never impersonates a
ready index. Rebuild cannot recover drifted content: the frozen revision's
bytes for a changed file are simply gone, and the row stays non-servable
with the drift counted, not faked from current bytes.

The implementation is stdlib-only (the runtime's dependency set is frozen)
and deterministic: the same text always produces the same tokens, scores,
and row layout.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable

from .document_parse import parse_document

# Aligned with the frozen import bounds (#112): at most 200 documents per
# revision, each parsed to at most 400k characters. The term and hit-line
# caps keep one pathological document from ballooning the store or a single
# query result; caps are applied deterministically (first-seen order), so
# the same text always indexes the same terms.
MAX_INDEX_DOCUMENTS = 200
MAX_INDEX_TEXT_CHARS = 400_000
MAX_INDEX_TERMS_PER_DOC = 50_000
MAX_TERM_CHARS = 40
MAX_TERM_LINE_HITS = 200
# Classic BM25 parameters.
BM25_K1 = 1.5
BM25_B = 0.75

_TOKEN_RUN = re.compile(r"\w+", re.UNICODE)
_ASCII_RUN = re.compile(r"[0-9a-z_]+")


class KnowledgeIndexError(RuntimeError):
    """A fixed-category index failure; the code crosses the boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def tokenize(text: str) -> list[str]:
    """Deterministic mixed-script tokens: ASCII word runs and CJK bigrams.

    ASCII runs stay whole words (casefolded); every contiguous non-ASCII
    word segment becomes overlapping character bigrams (a lone character
    stays a unigram), which is the stdlib-only recall/precision compromise
    for Chinese text. Tokens longer than ``MAX_TERM_CHARS`` are truncated
    consistently for both documents and queries, so the index and the query
    always speak the same vocabulary.
    """
    tokens: list[str] = []
    for run in _TOKEN_RUN.findall(text.casefold()):
        buffer = ""
        for char in run:
            if char.isascii():
                buffer += char
                continue
            if buffer:
                tokens.extend(_ascii_tokens(buffer))
                buffer = ""
            tokens.append(char)
        if buffer:
            tokens.extend(_ascii_tokens(buffer))
    if len(tokens) > 1:
        # Non-ASCII single characters collected above become bigrams with
        # their neighbours inside one contiguous run; rebuild them here so
        # 全文索引 yields 全文/文索/索引 instead of 全/文/索/引.
        tokens = _merge_bigrams(tokens)
    return [token[:MAX_TERM_CHARS] for token in tokens]


def _ascii_tokens(buffer: str) -> list[str]:
    return _ASCII_RUN.findall(buffer)


def _merge_bigrams(tokens: list[str]) -> list[str]:
    """Overlapping bigrams over contiguous single-character CJK tokens."""
    merged: list[str] = []
    run: list[str] = []
    for token in tokens:
        if len(token) == 1 and not token.isascii():
            run.append(token)
            continue
        if len(run) == 1:
            merged.append(run[0])
        elif len(run) > 1:
            merged.extend(run[i] + run[i + 1] for i in range(len(run) - 1))
        run = []
        merged.append(token)
    if len(run) == 1:
        merged.append(run[0])
    elif len(run) > 1:
        merged.extend(run[i] + run[i + 1] for i in range(len(run) - 1))
    return merged


def document_terms(text: str) -> dict[str, dict[str, Any]]:
    """One document's inverted-index rows: term → {tf, lines}.

    Lines are the 1-based numbers of the lines a term occurs on (first
    ``MAX_TERM_LINE_HITS`` occurrences, in text order). The vocabulary cap
    keeps first-seen terms, so indexing is a deterministic function of the
    text alone.
    """
    terms: dict[str, dict[str, Any]] = {}
    lines = text.splitlines()
    for number, line in enumerate(lines, 1):
        for term in tokenize(line):
            entry = terms.get(term)
            if entry is None:
                if len(terms) >= MAX_INDEX_TERMS_PER_DOC:
                    continue
                entry = terms[term] = {"tf": 0, "lines": []}
            entry["tf"] += 1
            if len(entry["lines"]) < MAX_TERM_LINE_HITS and (not entry["lines"] or entry["lines"][-1] != number):
                entry["lines"].append(number)
    return terms


def line_page_marks(layout: Any) -> list[tuple[int, int]]:
    """Sorted (start_line, page) marks from one parse record's layout."""
    if not isinstance(layout, list):
        return []
    marks: list[tuple[int, int]] = []
    for entry in layout:
        if not isinstance(entry, dict) or entry.get("kind") != "page":
            continue
        page = entry.get("page")
        line = entry.get("line")
        if type(page) is int and page >= 1 and type(line) is int and line >= 1:
            marks.append((line, page))
    marks.sort()
    return marks


def page_for_line(marks: list[tuple[int, int]], line: int) -> int | None:
    """The page whose anchor covers this text line, or None before the first."""
    page: int | None = None
    for start, value in marks:
        if start > line:
            break
        page = value
    return page


def table_line_marks(layout: Any) -> list[tuple[int, int, int]]:
    """Sorted (start_line, end_line, table) spans from one parse record's
    table anchors (#98). Unlike a page anchor, a table covers exactly its
    own anchored line range — a hit line outside every span cites no table."""
    if not isinstance(layout, list):
        return []
    marks: list[tuple[int, int, int]] = []
    for entry in layout:
        if not isinstance(entry, dict) or entry.get("kind") != "table":
            continue
        table = entry.get("table")
        start = entry.get("line")
        lines = entry.get("lines")
        if type(table) is int and table >= 1 and type(start) is int and start >= 1 \
                and type(lines) is int and lines >= 1:
            marks.append((start, start + lines - 1, table))
    marks.sort()
    return marks


def table_for_line(marks: list[tuple[int, int, int]], line: int) -> int | None:
    """The table whose anchored span contains this line, or None (#98).

    Spans come sorted by start; the first containing span wins, so a
    degenerate overlapping parse still resolves deterministically."""
    for start, end, table in marks:
        if start > line:
            break
        if line <= end:
            return table
    return None


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class KnowledgeIndexStore:
    """SQLite-backed per-revision inverted index (device-local, #97).

    Rows are keyed by the frozen identity (binding, revision id, manifest
    hash) — the same binding-scoped lookup the registry performs, so a
    foreign or unknown manifest has no rows to serve. State is derived from
    the rows, never stored as a claim: a revision reads ready only while
    every manifest document has a row.
    """

    def __init__(self, path: str) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_index_revisions (
                    binding TEXT NOT NULL, revision_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    document_count INTEGER NOT NULL DEFAULT 0,
                    built_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (binding, revision_id, manifest_hash))""")
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_index_documents (
                    binding TEXT NOT NULL, revision_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    filename TEXT NOT NULL, content_hash TEXT NOT NULL,
                    servable INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0,
                    note TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', layout TEXT NOT NULL DEFAULT '[]',
                    drift INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (binding, revision_id, manifest_hash, filename, content_hash))""")
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_index_terms (
                    binding TEXT NOT NULL, revision_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    filename TEXT NOT NULL, content_hash TEXT NOT NULL, term TEXT NOT NULL,
                    tf INTEGER NOT NULL, lines TEXT NOT NULL DEFAULT '[]',
                    PRIMARY KEY (binding, revision_id, manifest_hash, filename, content_hash, term))""")
                db.execute("""CREATE INDEX IF NOT EXISTS knowledge_index_terms_lookup
                    ON knowledge_index_terms (binding, revision_id, manifest_hash, term)""")
        except (sqlite3.Error, OSError):
            self._error = "KNOWLEDGE_INDEX_STORAGE_UNAVAILABLE"

    @property
    def error(self) -> str:
        return self._error

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, uri=self.path.startswith("file:"))
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def _execute(self, operation):
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                self._error = ""
                return result
            except (sqlite3.Error, OSError) as exc:
                self._error = "KNOWLEDGE_INDEX_STORAGE_UNAVAILABLE"
                raise KnowledgeIndexError(self._error) from exc

    @staticmethod
    def _encoded(binding) -> str:
        return json.dumps(binding, sort_keys=True)

    @staticmethod
    def _key(binding, revision_id: str, manifest_hash: str) -> tuple[str, str, str]:
        return (json.dumps(binding, sort_keys=True), str(revision_id)[:128], str(manifest_hash)[:64])

    # --- building -----------------------------------------------------------

    def index_revision(self, binding, revision_id: str, manifest_hash: str,
                       entries: list[dict[str, Any]]) -> dict[str, Any]:
        """Index one freshly registered revision from its parsed entries.

        Each import entry carries its parse record and (for honestly parsed
        documents) the extracted text under the transient ``_text`` key; the
        wire and the registry never see it. The whole revision is written in
        one transaction, replacing any previous rows for the identity, so an
        interrupted build leaves the previous state, never a half-claimed
        one. Unsupported or failed parses keep explicit non-servable rows:
        the index remembers they exist and that they cannot serve text.
        """
        encoded, revision, digest = self._key(binding, revision_id, manifest_hash)
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_INDEX_DOCUMENTS:
            raise KnowledgeIndexError("KNOWLEDGE_INDEX_INVALID")
        documents: list[tuple[Any, ...]] = []
        terms: list[tuple[Any, ...]] = []
        for entry in entries:
            filename = str(entry.get("filename", ""))[:255]
            content_hash = str(entry.get("sha256", ""))[:64]
            parse = entry.get("parse") if isinstance(entry.get("parse"), dict) else {}
            text = entry.get("_text")
            servable = parse.get("status") == "parsed" and isinstance(text, str)
            if servable:
                text = text[:MAX_INDEX_TEXT_CHARS]
            else:
                text = ""
            layout = json.dumps(parse.get("layout") or [], ensure_ascii=False) if servable else "[]"
            documents.append((encoded, revision, digest, filename, content_hash,
                              1 if servable else 0, len(text), parse.get("errorCode", "") if not servable else "",
                              text, layout))
            if servable:
                for term, facts in document_terms(text).items():
                    terms.append((encoded, revision, digest, filename, content_hash,
                                  term, facts["tf"], json.dumps(facts["lines"])))
        built_at = _now()

        def write(db):
            db.execute("DELETE FROM knowledge_index_terms WHERE binding=? AND revision_id=? AND manifest_hash=?",
                       (encoded, revision, digest))
            db.execute("DELETE FROM knowledge_index_documents WHERE binding=? AND revision_id=? AND manifest_hash=?",
                       (encoded, revision, digest))
            db.execute("""INSERT INTO knowledge_index_revisions
                (binding, revision_id, manifest_hash, document_count, built_at, error)
                VALUES (?,?,?,?,?,'')
                ON CONFLICT(binding, revision_id, manifest_hash) DO UPDATE SET
                document_count=excluded.document_count, built_at=excluded.built_at, error=''""",
                (encoded, revision, digest, len(entries), built_at))
            db.executemany("""INSERT OR REPLACE INTO knowledge_index_documents
                (binding, revision_id, manifest_hash, filename, content_hash, servable, char_count, note, text, layout, drift)
                VALUES (?,?,?,?,?,?,?,?,?,?,0)""", documents)
            db.executemany("""INSERT OR REPLACE INTO knowledge_index_terms
                (binding, revision_id, manifest_hash, filename, content_hash, term, tf, lines)
                VALUES (?,?,?,?,?,?,?,?)""", terms)
            return {"state": "ready" if documents else "missing", "documents": len(entries), "builtAt": built_at}

        return self._execute(write)

    def begin_revision(self, binding, revision_id: str, manifest_hash: str, document_count: int) -> None:
        """Open a rebuild: the revision row exists from the first written
        document on, so a canceled or crashed rebuild shows its honest
        partial state (indexed vs manifest documents) instead of vanishing."""

        def write(db):
            db.execute("""INSERT OR IGNORE INTO knowledge_index_revisions
                (binding, revision_id, manifest_hash, document_count, built_at, error)
                VALUES (?,?,?,?,'','')""", (*self._key(binding, revision_id, manifest_hash),
                                            max(0, int(document_count))))

        self._execute(write)

    def mark_build_error(self, binding, revision_id: str, manifest_hash: str, error: str) -> None:
        """Record an honest build failure for the display; the rows, if any,
        stay what they are and the derived state never claims readiness."""

        def write(db):
            db.execute("""INSERT INTO knowledge_index_revisions
                (binding, revision_id, manifest_hash, document_count, built_at, error)
                VALUES (?,?,?,0,'',?)
                ON CONFLICT(binding, revision_id, manifest_hash) DO UPDATE SET error=excluded.error""",
                (*self._key(binding, revision_id, manifest_hash), str(error)[:128]))

        try:
            self._execute(write)
        except KnowledgeIndexError:
            pass

    def update_document(self, binding, revision_id: str, manifest_hash: str, *, filename: str,
                        content_hash: str, servable: bool, text: str, layout: Any,
                        note: str = "", parse_error: str = "", drift: bool = False) -> None:
        """One rebuilt document row (rebuild path); the revision's totals and
        built_at are refreshed by ``finish_revision`` when the walk ends."""
        encoded, revision, digest = self._key(binding, revision_id, manifest_hash)
        if servable:
            text = str(text)[:MAX_INDEX_TEXT_CHARS]
            layout_json = json.dumps(layout or [], ensure_ascii=False)
            note_value, parse_error_value, char_count = "", "", len(text)
        else:
            text, layout_json, char_count = "", "[]", 0
            note_value, parse_error_value = str(note)[:64], str(parse_error)[:128]
            if not note_value:
                note_value = "unavailable"

        def write(db):
            db.execute("""INSERT OR REPLACE INTO knowledge_index_documents
                (binding, revision_id, manifest_hash, filename, content_hash, servable, char_count, note, text, layout, drift)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (encoded, revision, digest, str(filename)[:255], str(content_hash)[:64],
                 1 if servable else 0, char_count, note_value or parse_error_value, text, layout_json,
                 1 if drift else 0))
            db.execute("""DELETE FROM knowledge_index_terms
                WHERE binding=? AND revision_id=? AND manifest_hash=? AND filename=? AND content_hash=?""",
                (encoded, revision, digest, str(filename)[:255], str(content_hash)[:64]))
            if servable:
                db.executemany("""INSERT OR REPLACE INTO knowledge_index_terms
                    (binding, revision_id, manifest_hash, filename, content_hash, term, tf, lines)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    [(encoded, revision, digest, str(filename)[:255], str(content_hash)[:64], term,
                      facts["tf"], json.dumps(facts["lines"])) for term, facts in document_terms(text).items()])

        self._execute(write)

    def observe_documents(self, binding, revision_id: str, manifest_hash: str, *,
                          verified: list[tuple[str, str]], drifted: list[tuple[str, str]]) -> None:
        """Record the per-document facts one search observed (#97).

        Drift is tracked per document row, never as one overwriting count: a
        later subset search must not erase the 已过期 annotation for documents
        it did not look at. Verification is authoritative for the documents it
        actually verified (their bytes matched the frozen digest at that
        moment), so their marks clear; drifted marks are added for the rest.
        Only rows that exist are touched — an index that was never built has
        no baseline to be stale from, and its 未建索引 display is the honest
        one."""
        encoded, revision, digest = self._key(binding, revision_id, manifest_hash)
        verified_pairs = [(str(name)[:255], str(content)[:64]) for name, content in verified]
        drifted_pairs = [(str(name)[:255], str(content)[:64]) for name, content in drifted]

        def write(db):
            for name, content in verified_pairs:
                db.execute("""UPDATE knowledge_index_documents SET drift=0
                    WHERE binding=? AND revision_id=? AND manifest_hash=? AND filename=? AND content_hash=?""",
                    (encoded, revision, digest, name, content))
            for name, content in drifted_pairs:
                db.execute("""UPDATE knowledge_index_documents SET drift=1
                    WHERE binding=? AND revision_id=? AND manifest_hash=? AND filename=? AND content_hash=?""",
                    (encoded, revision, digest, name, content))

        try:
            self._execute(write)
        except KnowledgeIndexError:
            pass

    def servable_identities(self, binding, revision_id: str, manifest_hash: str) -> set[tuple[str, str]]:
        """The (filename, content_hash) pairs this index can honestly serve
        text for — the indexed search's classification of verified-but-
        unparsable documents (the literal engine's not_searchable)."""

        def read(db):
            return {(row["filename"], row["content_hash"]) for row in db.execute(
                """SELECT filename, content_hash FROM knowledge_index_documents
                   WHERE binding=? AND revision_id=? AND manifest_hash=? AND servable=1""",
                self._key(binding, revision_id, manifest_hash))}

        return self._execute(read)

    def document_layouts(self, binding, revision_id: str, manifest_hash: str) -> dict[tuple[str, str], list]:
        """The frozen parse layouts keyed by (lowercased filename, content
        hash) (#98). The literal engine consults these so a degraded-answer
        hit still cites the page/table the frozen parse anchored — and a
        revision whose layout was never stored simply cites none."""

        def read(db):
            layouts: dict[tuple[str, str], list] = {}
            for row in db.execute(
                    """SELECT filename, content_hash, layout FROM knowledge_index_documents
                       WHERE binding=? AND revision_id=? AND manifest_hash=?""",
                    self._key(binding, revision_id, manifest_hash)):
                try:
                    layout = json.loads(row["layout"])
                except (ValueError, TypeError):
                    continue
                if isinstance(layout, list) and layout:
                    layouts[(row["filename"].lower(), row["content_hash"])] = layout
            return layouts

        return self._execute(read)

    def finish_revision(self, binding, revision_id: str, manifest_hash: str,
                        document_count: int) -> None:
        """Close one rebuild: refresh the totals. The drift fact stays on the
        per-document rows the rebuild just rewrote."""

        def write(db):
            db.execute("""INSERT INTO knowledge_index_revisions
                (binding, revision_id, manifest_hash, document_count, built_at, error)
                VALUES (?,?,?,?,?,'')
                ON CONFLICT(binding, revision_id, manifest_hash) DO UPDATE SET
                document_count=excluded.document_count, built_at=excluded.built_at, error=''""",
                (*self._key(binding, revision_id, manifest_hash),
                 max(0, int(document_count)), _now()))

        self._execute(write)

    # --- reading ------------------------------------------------------------

    def revision_view(self, binding, revision_id: str, manifest_hash: str) -> dict[str, Any]:
        """The bounded display fact for one revision's index: derived state,
        honest counts, and the observed drift — never a readiness claim."""

        def read(db):
            row = db.execute(
                """SELECT document_count, built_at, error FROM knowledge_index_revisions
                   WHERE binding=? AND revision_id=? AND manifest_hash=?""",
                self._key(binding, revision_id, manifest_hash)).fetchone()
            if row is None:
                return {"state": "missing", "documents": 0, "indexedDocuments": 0,
                        "servableDocuments": 0, "driftedDocuments": 0, "builtAt": "", "error": ""}
            counts = db.execute(
                """SELECT COUNT(*) AS rows, COALESCE(SUM(servable), 0) AS servable,
                          COALESCE(SUM(drift), 0) AS drifted FROM knowledge_index_documents
                   WHERE binding=? AND revision_id=? AND manifest_hash=?""",
                self._key(binding, revision_id, manifest_hash)).fetchone()
            total = int(row["document_count"])
            indexed = int(counts["rows"])
            if row["error"] and indexed < total:
                state = "failed"
            elif total > 0 and indexed >= total:
                state = "ready"
            elif indexed > 0:
                state = "partial"
            else:
                state = "missing"
            return {"state": state, "documents": total, "indexedDocuments": indexed,
                    "servableDocuments": int(counts["servable"]),
                    "driftedDocuments": int(counts["drifted"]),
                    "builtAt": row["built_at"], "error": row["error"]}

        return self._execute(read)

    def search(self, binding, revision_id: str, manifest_hash: str, query: str,
               *, limit: int) -> dict[str, Any]:
        """BM25 over the revision's servable documents.

        Returns the ranked documents that contain at least one query term,
        each with the lines its terms hit (bounded per term at index time),
        the stored text for chunk assembly, and its layout anchors for the
        page lookup. Documents are ranked by score; ``moreAvailable`` says
        whether ranking was cut by ``limit``. A term no document contains
        simply contributes nothing — the answer stays honest by construction.
        """
        encoded, revision, digest = self._key(binding, revision_id, manifest_hash)
        terms = list(dict.fromkeys(token for token in tokenize(query) if token))[:256]

        def read(db):
            stats = db.execute(
                """SELECT COUNT(*) AS documents, COALESCE(SUM(char_count), 0) AS total_chars
                   FROM knowledge_index_documents
                   WHERE binding=? AND revision_id=? AND manifest_hash=? AND servable=1""",
                (encoded, revision, digest)).fetchone()
            count = int(stats["documents"])
            if count == 0 or not terms:
                return {"documents": [], "moreAvailable": False, "documentCount": count}
            averages = max(1, int(stats["total_chars"]) / count)
            hits: dict[str, int] = {}
            for start in range(0, len(terms), 200):
                chunk = terms[start:start + 200]
                marks = ",".join("?" * len(chunk))
                for row in db.execute(
                        f"""SELECT term, COUNT(*) AS df FROM knowledge_index_terms
                            WHERE binding=? AND revision_id=? AND manifest_hash=? AND term IN ({marks})
                            GROUP BY term""", (encoded, revision, digest, *chunk)):
                    hits[row["term"]] = int(row["df"])
            if not hits:
                return {"documents": [], "moreAvailable": False, "documentCount": count}
            weights: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
            for start in range(0, len(terms), 200):
                chunk = terms[start:start + 200]
                marks = ",".join("?" * len(chunk))
                for row in db.execute(
                        f"""SELECT filename, content_hash, term, tf, lines FROM knowledge_index_terms
                            WHERE binding=? AND revision_id=? AND manifest_hash=? AND term IN ({marks})""",
                        (encoded, revision, digest, *chunk)):
                    # Keyed by the full (filename, content_hash) identity: a
                    # revision may hold two same-name documents with different
                    # digests, and they must never merge (review finding).
                    weights.setdefault((row["filename"], row["content_hash"]), {})[row["term"]] = {
                        "tf": int(row["tf"]),
                        "lines": json.loads(row["lines"]) if row["lines"] else []}
            lengths = {(row["filename"], row["content_hash"]): int(row["char_count"]) for row in db.execute(
                """SELECT filename, content_hash, char_count FROM knowledge_index_documents
                   WHERE binding=? AND revision_id=? AND manifest_hash=? AND servable=1""",
                (encoded, revision, digest))}
            scored: list[dict[str, Any]] = []
            for identity, by_term in weights.items():
                length = lengths.get(identity, 0)
                score = 0.0
                for term, facts in by_term.items():
                    df = hits.get(term, 0)
                    if df <= 0:
                        continue
                    idf = math.log(1 + (count - df + 0.5) / (df + 0.5))
                    tf = facts["tf"]
                    score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * length / averages))
                scored.append({"filename": identity[0], "contentHash": identity[1],
                               "score": score, "terms": by_term, "charCount": length})
            scored.sort(key=lambda item: (-item["score"], item["filename"], item["contentHash"]))
            ranked = scored[:limit]
            more = len(scored) > len(ranked)
            # Re-read the served rows once with text and layout for assembly.
            documents: list[dict[str, Any]] = []
            for document in ranked:
                row = db.execute(
                    """SELECT text, layout FROM knowledge_index_documents
                       WHERE binding=? AND revision_id=? AND manifest_hash=? AND filename=? AND content_hash=?""",
                    (encoded, revision, digest, document["filename"], document["contentHash"])).fetchone()
                if row is None:
                    continue
                documents.append({"filename": document["filename"], "contentHash": document["contentHash"],
                                  "score": document["score"],
                                  "termLines": {term: facts["lines"] for term, facts in document["terms"].items()},
                                  "text": row["text"], "layout": json.loads(row["layout"])})
            return {"documents": documents, "moreAvailable": more, "documentCount": count}

        return self._execute(read)


class KnowledgeIndexRebuild:
    """One cancellable background index rebuild (#97).

    The job re-verifies every manifest document of one registered revision
    against the live workspace bytes — the same guarded walk the search
    uses — and re-indexes what still hashes to its frozen digest. Drifted,
    missing, and unreadable documents are counted and marked non-servable,
    never faked from current content. Exactly one rebuild runs at a time;
    cancel lands at the next document boundary, the rows written so far
    stay (each is self-consistent frozen content), and the derived state
    shows the honest partial/missing outcome until a rebuild completes.
    """

    def __init__(self, knowledge_files: Callable[[], Any], registry: Any, index: KnowledgeIndexStore) -> None:
        self._knowledge_files = knowledge_files
        self._registry = registry
        self._index = index
        self._lock = threading.Lock()
        self._job: dict[str, Any] | None = None
        self._cancel = threading.Event()

    @staticmethod
    def _empty_job(kb_id: str, revision_id: str, manifest_hash: str) -> dict[str, Any]:
        return dict(state='running', kbId=kb_id, revisionId=revision_id, manifestHash=manifest_hash,
                    totalDocuments=0, processedDocuments=0, indexedDocuments=0,
                    driftedDocuments=0, unavailableDocuments=0, error='')

    def status(self) -> dict[str, Any] | None:
        with self._lock:
            if self._job is None:
                return None
            return dict(self._job)

    def cancel(self) -> bool:
        """Ask the running rebuild to stop at the next document boundary."""
        with self._lock:
            running = self._job is not None and self._job['state'] == 'running'
        if running:
            self._cancel.set()
        return running

    def start(self, kb_id: str, revision_id: str, manifest_hash: str) -> dict[str, Any]:
        """Start one rebuild; refuses before anything runs when the
        workspace boundary is unavailable or a job is already running."""
        if not isinstance(kb_id, str) or not kb_id:
            raise KnowledgeIndexError("KNOWLEDGE_INDEX_KB_INVALID")
        if not isinstance(revision_id, str) or not revision_id or not isinstance(manifest_hash, str) or not manifest_hash:
            raise KnowledgeIndexError("KNOWLEDGE_INDEX_INVALID")
        try:
            self._knowledge_files()
        except Exception as exc:
            raise KnowledgeIndexError("KNOWLEDGE_INDEX_WORKSPACE_UNAVAILABLE") from exc
        with self._lock:
            if self._job is not None and self._job['state'] == 'running':
                raise KnowledgeIndexError("KNOWLEDGE_INDEX_BUSY")
            self._cancel = threading.Event()
            self._job = self._empty_job(kb_id, revision_id, manifest_hash)
        worker = threading.Thread(target=self._run, args=(kb_id, revision_id, manifest_hash), daemon=True)
        try:
            worker.start()
        except BaseException:
            # A worker that cannot start must never leave a running phantom.
            with self._lock:
                self._job = None
            raise
        return self.status()

    def _update(self, **fields) -> None:
        with self._lock:
            if self._job is not None:
                self._job.update(fields)

    def _run(self, kb_id: str, revision_id: str, manifest_hash: str) -> None:
        from .knowledge_search import locate_frozen_files
        from .receipt_ledger import profile_binding
        try:
            settings, grant, files = self._knowledge_files()
            binding = profile_binding(settings)
            if binding is None:
                raise KnowledgeIndexError("KNOWLEDGE_INDEX_IDENTITY_UNAVAILABLE")
            registration = self._registry.find_registration(binding, revision_id, manifest_hash)
            if registration is None:
                raise KnowledgeIndexError("KNOWLEDGE_INDEX_REVISION_UNKNOWN")
            documents = [document for document in registration.get("documents") or []
                         if isinstance(document, dict) and document.get("filename") and document.get("sha256")]
            if not documents or len(documents) > MAX_INDEX_DOCUMENTS:
                raise KnowledgeIndexError("KNOWLEDGE_INDEX_INVALID")
            self._update(totalDocuments=len(documents))
            candidates, _truncated = locate_frozen_files(files, grant['logical_root'])
            self._index.begin_revision(binding, revision_id, manifest_hash, document_count=len(documents))
            drifted = 0
            unavailable = 0
            indexed = 0
            for processed, document in enumerate(documents, 1):
                if self._cancel.is_set():
                    self._update(state='canceled', driftedDocuments=drifted,
                                 unavailableDocuments=unavailable, indexedDocuments=indexed)
                    return
                outcome, text, layout, note = self._rebuild_document(files, candidates, document)
                if outcome == 'indexed':
                    indexed += 1
                elif outcome == 'drift':
                    drifted += 1
                else:
                    unavailable += 1
                self._index.update_document(binding, revision_id, manifest_hash,
                                            filename=document['filename'], content_hash=document['sha256'],
                                            servable=outcome == 'indexed', text=text, layout=layout, note=note,
                                            drift=outcome == 'drift')
                self._update(processedDocuments=processed,
                             indexedDocuments=indexed, driftedDocuments=drifted,
                             unavailableDocuments=unavailable)
            self._index.finish_revision(binding, revision_id, manifest_hash,
                                        document_count=len(documents))
            self._update(state='completed', indexedDocuments=indexed, driftedDocuments=drifted,
                         unavailableDocuments=unavailable)
        except KnowledgeIndexError as exc:
            self._update(state='failed', error=str(exc))
        except Exception:
            self._update(state='failed', error="KNOWLEDGE_INDEX_FAILED")

    def _rebuild_document(self, files: Any, candidates: dict[str, list[str]],
                          document: dict[str, Any]) -> tuple[str, str, Any, str]:
        """Verify one manifest document against live bytes and index the truth.

        Returns (outcome, text, layout, note): outcome is 'indexed' (the live
        bytes still hash to the frozen digest and were parsed), 'drift' (the
        digest no longer matches — the frozen content is not re-faked from
        current bytes), or 'unavailable' (no readable candidate at all).
        """
        from .files import FileAccessError
        from .knowledge_search import MAX_IMPORT_FILE_BYTES
        outcome, text, layout, note = 'unavailable', '', [], 'file_unavailable'
        for logical_path in candidates.get(document['filename'].lower(), []):
            try:
                raw = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES + 1)
            except FileAccessError:
                continue
            if len(raw) > MAX_IMPORT_FILE_BYTES:
                continue
            if hashlib.sha256(raw).hexdigest() != document['sha256']:
                if outcome == 'unavailable':
                    outcome, note = 'drift', 'content_drift'
                continue
            parsed = parse_document(raw, document['filename'])
            if parsed.get('status') == 'parsed':
                return 'indexed', parsed.get('text', ''), parsed.get('layout') or [], ''
            return 'unavailable', '', [], str(parsed.get('reason', 'PARSE_FAILED'))[:64]
        return outcome, text, layout, note
