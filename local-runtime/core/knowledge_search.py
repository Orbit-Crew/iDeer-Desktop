"""Frozen-revision local retrieval: the unique Runtime re-validates (#113).

The broker task carries the frozen manifest identity only — query, revision
id, manifest hash, and per-document identity fields. Every document is
re-validated content-addressed before a single line is returned: a manifest
entry matches at most one live workspace file by (file name, SHA-256), so a
drifted, missing, or unreadable document is reported as structured missing
and never substituted with current content. Results reference documents by
platform identity and workspace logical paths only; physical paths never
leave the device.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any

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


def search_frozen_revision(payload: dict[str, Any], *, files: Any, logical_root: str) -> dict[str, Any]:
    """Re-validate every frozen document against live bytes, then search.

    The workspace store boundary performs every read, so links, junctions,
    protected paths, and out-of-root files fail closed exactly as for
    ``local.files.search``. A document whose bytes no longer hash to the
    frozen digest contributes nothing: the answer is never impersonated with
    current content.
    """

    query = payload["query"]
    frozen = payload["documents"]
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

    chunks: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    reasons = {"drift": "content_drift", "not_searchable": "not_searchable"}
    for document in frozen:
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
            try:
                text = raw.decode("utf-8")
                if "\x00" in text:
                    raise UnicodeError()
            except UnicodeError:
                # Frozen bytes verified, but no line model exists for the
                # content: report it instead of pretending to search it.
                outcome = "not_searchable"
                break
            outcome = "matched"
            for number, line in enumerate(text.splitlines(), 1):
                if query in line:
                    chunks.append({
                        "document_id": document["document_id"],
                        "document_keyword": document["filename"],
                        "content": line[:MAX_LINE_CHARS],
                        "position": {"logical_path": logical_path, "line": number},
                    })
                    if len(chunks) >= MAX_MATCHES:
                        truncated = True
                        break
            break
        if outcome != "matched":
            missing.append({"document_id": document["document_id"], "reason": reasons.get(outcome, "file_unavailable")})
    return {
        "chunks": chunks,
        "missing": missing,
        "truncated": truncated,
        "documentsMatched": len(frozen) - len(missing),
    }
