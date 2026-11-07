"""Frozen-revision local retrieval: the unique Runtime re-validates (#113).

The broker task carries the frozen manifest identity only — query, revision
id, manifest hash, and per-document identity fields. Every document is
re-validated content-addressed before a single line is returned: a manifest
entry matches at most one live workspace file by (file name, SHA-256), so a
drifted, missing, or unreadable document is reported as structured missing
and never substituted with current content. Results reference documents by
platform identity and workspace logical paths only; physical paths never
leave the device.

Since #97 the answering itself has two engines. The device BM25 index
(``search_frozen_revision_indexed``) ranks the hash-verified frozen content
and locates hits by line and page anchor; the original literal line scan
(``search_frozen_revision``) stays as the visible degraded fallback for a
revision whose index is missing, incomplete, or failed, and the result
always names the engine that answered.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any, Callable

from .files import FileAccessError

# Aligned with the frozen #112 import contract: at most 200 documents, each
# up to 50 MiB. Retrieval scans the same bound it froze.
MAX_PAYLOAD_DOCUMENTS = 200
MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024
MAX_QUERY_CHARS = 512
MAX_MATCHES = 100
MAX_SEARCH_FILES = 500
MAX_LINE_CHARS = 1000

_FILENAME = re.compile(r"\A[^/\\\x00-\x1f]{1,255}\Z")
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")


class KnowledgeSearchError(RuntimeError):
    """A fixed-category retrieval failure; the code crosses the boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_search_payload(args: Any) -> dict[str, Any]:
    """Validate the frozen identity payload before any file is touched."""

    if not isinstance(args, dict):
        raise KnowledgeSearchError("INVALID_MANIFEST")
    query = args.get("query")
    if not isinstance(query, str) or not 1 <= len(query) <= MAX_QUERY_CHARS or "\n" in query:
        raise KnowledgeSearchError("INVALID_QUERY")
    revision_id = args.get("revision_id")
    try:
        if not isinstance(revision_id, str) or str(uuid.UUID(revision_id)) != revision_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise KnowledgeSearchError("INVALID_MANIFEST") from None
    manifest_hash = args.get("manifest_hash")
    if not isinstance(manifest_hash, str) or _HEX64.match(manifest_hash) is None:
        raise KnowledgeSearchError("INVALID_MANIFEST")
    documents = args.get("documents")
    if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_PAYLOAD_DOCUMENTS:
        raise KnowledgeSearchError("INVALID_MANIFEST")
    parsed: list[dict[str, str]] = []
    seen: set[str] = set()
    for document in documents:
        if not isinstance(document, dict):
            raise KnowledgeSearchError("INVALID_MANIFEST")
        document_id = document.get("document_id")
        try:
            if not isinstance(document_id, str) or str(uuid.UUID(document_id)) != document_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise KnowledgeSearchError("INVALID_MANIFEST") from None
        if document_id in seen:
            raise KnowledgeSearchError("INVALID_MANIFEST")
        seen.add(document_id)
        filename = document.get("filename")
        if not isinstance(filename, str) or _FILENAME.match(filename) is None:
            raise KnowledgeSearchError("INVALID_MANIFEST")
        content_hash = document.get("content_hash")
        if not isinstance(content_hash, str) or _HEX64.match(content_hash) is None:
            raise KnowledgeSearchError("INVALID_MANIFEST")
        parsed.append({"document_id": document_id, "filename": filename, "content_hash": content_hash})
    return {"query": query, "revision_id": revision_id, "manifest_hash": manifest_hash, "documents": parsed}


def locate_frozen_files(files: Any, logical_root: str) -> tuple[dict[str, list[str]], bool]:
    """The bounded workspace walk shared by retrieval and index rebuild (#97).

    Maps lowercase file names to their workspace-logical paths, bounded by
    ``MAX_SEARCH_FILES``; ``truncated`` reports honestly when the bound cut
    the walk. Every read goes through the workspace store boundary, so
    links, junctions, protected paths, and out-of-root files fail closed.
    """
    candidates: dict[str, list[str]] = {}
    scanned = 0
    truncated = False
    pending = [logical_root]
    while pending:
        scanned += 1
        if scanned > MAX_SEARCH_FILES:
            truncated = True
            break
        current = pending.pop()
        try:
            resolved = files.resolve(current)
        except FileAccessError:
            continue
        if resolved.is_dir():
            try:
                entries, scan_limited = files.list_with_limit(current)
            except FileAccessError:
                continue
            pending.extend(reversed(entries[:MAX_SEARCH_FILES]))
            truncated = truncated or scan_limited or len(entries) > MAX_SEARCH_FILES
            continue
        if not resolved.is_file():
            continue
        name = current.rstrip("/").rsplit("/", 1)[-1].lower()
        candidates.setdefault(name, []).append(current)
    return candidates, truncated


def revalidate_frozen_documents(payload: dict[str, Any], *, files: Any, candidates: dict[str, list[str]],
                                serve: Callable[[dict[str, Any], str, bytes], bool] | None = None
                                ) -> tuple[dict[str, str], list[dict[str, Any]]]:
    """Content-addressed revalidation of every frozen manifest document.

    Each document must still live at a name-matched workspace path and hash
    to its frozen digest before it can contribute anything. The digest and
    the served content always come from the same single read, so there is no
    window where a line is answered from bytes the digest does not describe.
    ``serve`` (when given) is called once per verified document with those
    exact bytes and returns False to mark it not_searchable — content that
    verifies but offers no honest line model. Returns the verified
    ``{document_id: logical_path}`` mapping and the structured ``missing``
    list (content_drift / not_searchable / file_unavailable) for the rest.
    """
    verified: dict[str, str] = {}
    missing: list[dict[str, Any]] = []
    reasons = {"drift": "content_drift", "not_searchable": "not_searchable"}
    for document in payload["documents"]:
        outcome = "unavailable"
        for logical_path in candidates.get(document["filename"].lower(), []):
            try:
                raw = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES + 1)
            except FileAccessError:
                continue
            if len(raw) > MAX_IMPORT_FILE_BYTES or hashlib.sha256(raw).hexdigest() != document["content_hash"]:
                # Same name, different bytes: the frozen version is gone here.
                if outcome == "unavailable":
                    outcome = "drift"
                continue
            if serve is not None and not serve(document, logical_path, raw):
                outcome = "not_searchable"
                break
            verified[document["document_id"]] = logical_path
            outcome = "matched"
            break
        if outcome != "matched":
            missing.append({"document_id": document["document_id"],
                            "reason": reasons.get(outcome, "file_unavailable")})
    return verified, missing


def search_frozen_revision(payload: dict[str, Any], *, files: Any, logical_root: str) -> dict[str, Any]:
    """Re-validate every frozen document against live bytes, then scan.

    The degraded literal-scan path (#97): kept as the visible fallback for a
    revision whose index is missing, incomplete, or failed, and for queries
    that tokenize to nothing. A document whose bytes no longer hash to the
    frozen digest contributes nothing: the answer is never impersonated with
    current content.
    """

    query = payload["query"]
    frozen = payload["documents"]
    candidates, truncated = locate_frozen_files(files, logical_root)
    chunks: list[dict[str, Any]] = []
    overflow = [False]

    def scan(document: dict[str, Any], logical_path: str, raw: bytes) -> bool:
        try:
            text = raw.decode("utf-8")
            if "\x00" in text:
                raise UnicodeError()
        except UnicodeError:
            # Frozen bytes verified, but no line model exists for the
            # content: report it instead of pretending to search it.
            return False
        for number, line in enumerate(text.splitlines(), 1):
            if query in line:
                chunks.append({
                    "document_id": document["document_id"],
                    "document_keyword": document["filename"],
                    "content": line[:MAX_LINE_CHARS],
                    "position": {"logical_path": logical_path, "line": number},
                })
                if len(chunks) >= MAX_MATCHES:
                    overflow[0] = True
                    break
        return True

    verified, missing = revalidate_frozen_documents(payload, files=files, candidates=candidates, serve=scan)
    return {
        "chunks": chunks,
        "missing": missing,
        "truncated": truncated or overflow[0],
        "documentsMatched": len(frozen) - len(missing),
        "engine": "literal",
    }


def search_frozen_revision_indexed(payload: dict[str, Any], *, files: Any, logical_root: str,
                                   index: Any, binding: Any) -> dict[str, Any]:
    """Answer a frozen revision's retrieval from the device BM25 index (#97).

    The #113 contract holds unchanged: every document is re-validated
    content-addressed before anything is served — the walk and the digest
    comparison still run per search, so a drifted or missing document is
    reported as structured missing and never answered from the index. What
    changes is the answering itself: intact documents are ranked by BM25
    over the index that was built from their hash-verified frozen bytes,
    and each hit carries the line and the page anchor of the frozen parse.
    A verified document the index cannot honestly serve text for (it parsed
    as skipped or failed at import) is reported ``not_searchable`` — the
    same structured missing the literal engine answers, never a silent gap.

    The per-document facts the search observed (verified or drifted) are
    recorded on the index store so the doc library can annotate 已过期
    instead of pretending the index is current.
    """
    from .knowledge_index import line_page_marks, page_for_line

    frozen = payload["documents"]
    candidates, truncated = locate_frozen_files(files, logical_root)
    verified, missing = revalidate_frozen_documents(payload, files=files, candidates=candidates)
    by_id = {document["document_id"]: document for document in frozen}
    # Verified bytes the index cannot serve text for are not_searchable —
    # the honest structured missing, exactly what the literal scan reports.
    try:
        servable = index.servable_identities(binding, payload["revision_id"], payload["manifest_hash"])
    except Exception:
        servable = None
    unservable: list[dict[str, Any]] = []
    if servable is not None:
        for document_id, _logical_path in list(verified.items()):
            document = by_id[document_id]
            if (document["filename"], document["content_hash"]) not in servable:
                verified.pop(document_id)
                unservable.append({"document_id": document_id, "reason": "not_searchable"})
    missing.extend(unservable)
    chunks: list[dict[str, Any]] = []
    if verified:
        matches = index.search(binding, payload["revision_id"], payload["manifest_hash"],
                               payload["query"], limit=MAX_MATCHES)
        by_name = {(document["filename"], document["contentHash"]): document for document in matches["documents"]}
        truncated = truncated or bool(matches.get("moreAvailable"))
        for document in frozen:
            logical_path = verified.get(document["document_id"])
            if logical_path is None:
                continue
            ranked = by_name.get((document["filename"], document["content_hash"]))
            if ranked is None:
                continue
            lines = ranked["text"].splitlines()
            marks = line_page_marks(ranked["layout"])
            hit_lines = sorted({line for positions in ranked["termLines"].values() for line in positions})
            for number in hit_lines:
                if not 1 <= number <= len(lines):
                    continue
                chunks.append({
                    "document_id": document["document_id"],
                    "document_keyword": document["filename"],
                    "content": lines[number - 1][:MAX_LINE_CHARS],
                    "position": {"logical_path": logical_path, "line": number,
                                 "page": page_for_line(marks, number)},
                })
                if len(chunks) >= MAX_MATCHES:
                    truncated = True
                    break
            if len(chunks) >= MAX_MATCHES:
                break
    verified_pairs = [(by_id[document_id]["filename"], by_id[document_id]["content_hash"])
                      for document_id in verified]
    drifted_pairs = [(by_id[entry["document_id"]]["filename"], by_id[entry["document_id"]]["content_hash"])
                     for entry in missing if entry["reason"] == "content_drift"]
    try:
        index.observe_documents(binding, payload["revision_id"], payload["manifest_hash"],
                                verified=verified_pairs, drifted=drifted_pairs)
        view = index.revision_view(binding, payload["revision_id"], payload["manifest_hash"])
    except Exception:
        view = None
    return {
        "chunks": chunks,
        "missing": missing,
        "truncated": truncated,
        "documentsMatched": len(frozen) - len(missing),
        "engine": "bm25",
        "index": view,
    }
