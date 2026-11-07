"""Device-side document similarity for the Desktop knowledge entry (#99).

The similarity layer is computed on this device from the frozen revision the
current identity registered (binding-scoped registry lookup before this
module runs). Every document is re-validated content-addressed against the
live workspace before its tokens are used: a drifted, missing, undecodable,
or too-short document is reported as its own status and never substituted
with current content. The measure is a deterministic token-set Jaccard over
ASCII words plus CJK bigrams (stdlib only) — no model runs locally, nothing
about the workspace leaves the device, and the answer echoes the frozen
revision identity so the panel can show what the layer was built from.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from .files import FileAccessError

# Aligned with the frozen #112 import contract: at most 200 documents, each
# up to 50 MiB. The workspace walk keeps the #113 scan bound.
MAX_SIMILARITY_DOCUMENTS = 200
MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024
MAX_SEARCH_FILES = 500
# Documents whose verified text yields fewer tokens cannot say anything
# about similarity: they get their own status instead of a silent skip.
MIN_TOKENS = 8
# The device computes one bounded candidate edge set at this baseline; the
# panel's threshold slider filters this set for display and never asks for
# more than the device stated.
BASE_THRESHOLD = 0.05
MAX_EDGES = 2000

_ASCII_WORD = re.compile(r"[A-Za-z0-9_]+")
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")


class KnowledgeSimilarityError(RuntimeError):
    """A fixed-category similarity failure; the code crosses the boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def tokenize(text: str) -> set[str]:
    """ASCII words (lowercased) plus CJK bigrams; deterministic and stdlib.

    A standalone small tokenizer: when #97's index tokenizer merges, the two
    can be unified behind one helper without changing this module's contract.
    """

    tokens: set[str] = set()
    for word in _ASCII_WORD.findall(text):
        tokens.add(word.lower())
    for run in _CJK_RUN.findall(text):
        for index in range(len(run) - 1):
            tokens.add(run[index:index + 2])
    return tokens


def _workspace_candidates(files: Any, logical_root: str) -> dict[str, list[str]]:
    """Logical workspace paths grouped by lowercased file name (#113 idiom)."""

    candidates: dict[str, list[str]] = {}
    scanned = 0
    pending = [logical_root]
    while pending:
        scanned += 1
        if scanned > MAX_SEARCH_FILES:
            break
        current = pending.pop()
        try:
            resolved = files.resolve(current)
        except FileAccessError:
            continue
        if resolved.is_dir():
            try:
                entries, _scan_limited = files.list_with_limit(current)
            except FileAccessError:
                continue
            pending.extend(reversed(entries[:MAX_SEARCH_FILES]))
            continue
        if not resolved.is_file():
            continue
        name = current.rstrip("/").rsplit("/", 1)[-1].lower()
        candidates.setdefault(name, []).append(current)
    return candidates


def similarity_view(registration: dict[str, Any], *, files: Any, logical_root: str) -> dict[str, Any]:
    """Compute the similarity layer for one registered frozen revision.

    View status: ``completed`` when every frozen document could contribute
    tokens, ``failed`` when none could, ``partial`` in between — a shortened
    or drifted library is shown as exactly that, never as a complete graph.
    """

    # The #112 import contract already caps a registry row at 200 documents;
    # the slice below is only a defensive bound against anomalous rows.
    documents = [document for document in (registration.get("documents") or [])
                 if isinstance(document, dict) and isinstance(document.get("filename"), str)
                 and isinstance(document.get("sha256"), str)][:MAX_SIMILARITY_DOCUMENTS]
    if not documents:
        raise KnowledgeSimilarityError("KNOWLEDGE_SIMILARITY_NO_DOCUMENTS")

    rows: list[dict[str, Any]] = []
    token_sets: list[set[str] | None] = []
    candidates = _workspace_candidates(files, logical_root)
    for document in documents:
        status, tokens = "file_unavailable", None
        for logical_path in candidates.get(str(document["filename"]).lower(), []):
            try:
                raw = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES + 1)
            except FileAccessError:
                continue
            if len(raw) > MAX_IMPORT_FILE_BYTES or hashlib.sha256(raw).hexdigest() != document["sha256"]:
                # Same name, different bytes: the frozen version is gone here.
                if status in ("file_unavailable", "content_drift"):
                    status = "content_drift"
                continue
            try:
                text = raw.decode("utf-8")
                if "\x00" in text:
                    raise UnicodeError()
            except UnicodeError:
                # Frozen bytes verified, but no text model exists for the
                # content: report it instead of tokenizing binary noise.
                status = "not_searchable"
                break
            status = "matched"
            tokens = tokenize(text)
            break
        rows.append({"filename": str(document["filename"]), "contentHash": str(document["sha256"]),
                     "status": status, "tokenCount": len(tokens) if tokens is not None else 0})
        token_sets.append(tokens)

    # The manifest filename is unique; a repeated basename (two folders
    # importing the same name) is disambiguated by its frozen digest so the
    # canvas never merges two different documents.
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["filename"]] = counts.get(row["filename"], 0) + 1
    for row in rows:
        row["id"] = row["filename"] if counts[row["filename"]] == 1 \
            else f"{row['filename']}#{row['contentHash'][:12]}"

    eligible: list[int] = []
    for index, row in enumerate(rows):
        tokens = token_sets[index]
        if row["status"] == "matched" and tokens is not None and len(tokens) >= MIN_TOKENS:
            eligible.append(index)
        elif row["status"] == "matched":
            # Verified bytes, but too little text to say anything honest.
            row["status"] = "not_enough_content"

    edges: list[dict[str, Any]] = []
    for first in range(len(eligible)):
        for second in range(first + 1, len(eligible)):
            left, right = token_sets[eligible[first]], token_sets[eligible[second]]
            union = len(left | right)
            if union == 0:
                continue
            weight = len(left & right) / union
            if weight >= BASE_THRESHOLD:
                edges.append({"source": rows[eligible[first]]["id"], "target": rows[eligible[second]]["id"],
                              "weight": round(weight, 4)})
    # Deterministic order, then a bounded cut that the answer flags honestly.
    edges.sort(key=lambda edge: (-edge["weight"], edge["source"], edge["target"]))
    truncated = len(edges) > MAX_EDGES
    edges = edges[:MAX_EDGES]

    usable = len(eligible)
    if usable == 0:
        status = "failed"
    elif usable == len(rows):
        status = "completed"
    else:
        status = "partial"
    return {"kbId": registration.get("kbId", ""), "revisionId": registration.get("revisionId", ""),
            "revisionNo": registration.get("revisionNo", 0), "manifestHash": registration.get("manifestHash", ""),
            "status": status, "threshold": BASE_THRESHOLD, "truncated": truncated,
            "documents": rows, "edges": edges}
