"""Frozen-document material for server-orchestrated graph generation (#116).

The broker task carries the frozen manifest identity and exactly one
document. The unique Runtime re-validates the document content-addressed
before its text leaves the device: a manifest entry matches at most one live
workspace file by (file name, SHA-256), and a drifted, missing, oversized,
or non-text document is reported as a structured missing reason instead of
substituted with current content. Physical paths never leave the device,
and the text travels only after the device user approves the material
request (a LEVEL_1 capability, like content-creating writes).
"""
from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any

from .files import FileAccessError

# Aligned with the frozen #112 import contract and the server-side material
# bound: a document the device refuses here can never reach the model.
MAX_MATERIAL_BYTES = 524_288

_FILENAME = re.compile(r"\A[^/\\\x00-\x1f]{1,255}\Z")
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")


class KnowledgeMaterialError(RuntimeError):
    """A fixed-category material failure; the code crosses the boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_material_payload(args: Any) -> dict[str, Any]:
    """Validate the frozen identity payload before any file is touched.

    Exactly one document per request: the device is not a bulk library
    source, and a multi-document material request is refused outright no
    matter who signed it.
    """

    if not isinstance(args, dict):
        raise KnowledgeMaterialError("INVALID_MANIFEST")
    revision_id = args.get("revision_id")
    try:
        if not isinstance(revision_id, str) or str(uuid.UUID(revision_id)) != revision_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise KnowledgeMaterialError("INVALID_MANIFEST") from None
    manifest_hash = args.get("manifest_hash")
    if not isinstance(manifest_hash, str) or _HEX64.match(manifest_hash) is None:
        raise KnowledgeMaterialError("INVALID_MANIFEST")
    documents = args.get("documents")
    if not isinstance(documents, list) or len(documents) != 1:
        if isinstance(documents, list) and len(documents) > 1:
            raise KnowledgeMaterialError("BULK_REQUEST_REFUSED")
        raise KnowledgeMaterialError("INVALID_MANIFEST")
    parsed: list[dict[str, str]] = []
    for document in documents:
        if not isinstance(document, dict):
            raise KnowledgeMaterialError("INVALID_MANIFEST")
        document_id = document.get("document_id")
        try:
            if not isinstance(document_id, str) or str(uuid.UUID(document_id)) != document_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise KnowledgeMaterialError("INVALID_MANIFEST") from None
        filename = document.get("filename")
        if not isinstance(filename, str) or _FILENAME.match(filename) is None:
            raise KnowledgeMaterialError("INVALID_MANIFEST")
        content_hash = document.get("content_hash")
        if not isinstance(content_hash, str) or _HEX64.match(content_hash) is None:
            raise KnowledgeMaterialError("INVALID_MANIFEST")
        parsed.append({"document_id": document_id, "filename": filename, "content_hash": content_hash})
    return {"revision_id": revision_id, "manifest_hash": manifest_hash, "documents": parsed}


def material_frozen_document(payload: dict[str, Any], *, files: Any, logical_root: str) -> dict[str, Any]:
    """Re-validate the frozen document against live bytes, then return its text.

    The workspace store boundary performs every read, so links, junctions,
    protected paths, and out-of-root files fail closed exactly as for the
    #113 search. The document's bytes must hash to the frozen digest: the
    graph is only ever built from the content that was frozen at import.
    """

    document = payload["documents"][0]
    candidates: list[str] = []
    scanned = 0
    pending = [logical_root]
    while pending:
        scanned += 1
        if scanned > 500:
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
            pending.extend(reversed(entries[:500]))
            continue
        if not resolved.is_file():
            continue
        name = current.rstrip("/").rsplit("/", 1)[-1].lower()
        if name == document["filename"].lower():
            candidates.append(current)

    outcome = "document_unavailable"
    for logical_path in candidates:
        try:
            raw = files.read_bytes(logical_path, max_bytes=MAX_MATERIAL_BYTES + 1)
        except FileAccessError:
            continue
        if len(raw) > MAX_MATERIAL_BYTES:
            outcome = "document_too_large"
            continue
        if hashlib.sha256(raw).hexdigest() != document["content_hash"]:
            # Same name, different bytes: the frozen version is gone here.
            outcome = "content_drift"
            continue
        try:
            text = raw.decode("utf-8")
            if "\x00" in text:
                raise UnicodeError()
        except UnicodeError:
            # Frozen bytes verified, but no text model exists for the
            # content: report it instead of returning binary noise.
            outcome = "not_text"
            break
        return {
            "document_id": document["document_id"],
            "filename": document["filename"],
            "content_hash": document["content_hash"],
            "text": text,
        }
    return {"document_id": document["document_id"], "missing": True, "reason": outcome}
def locate_frozen_document(payload: dict[str, Any], *, files: Any, logical_root: str) -> dict[str, Any]:
    """Find the live workspace file behind one frozen document (#116).

    Used by the Desktop graph entry's "locate source" action: the answer is
    the workspace logical path of the file whose bytes still hash to the
    frozen digest, or a structured missing reason. The path stays on this
    device — it is shown to the local user only.
    """

    document = payload["documents"][0]
    result = material_frozen_document(payload, files=files, logical_root=logical_root)
    if result.get("missing") is True:
        return {"document_id": document["document_id"], "missing": True, "reason": result["reason"]}
    candidates: list[str] = []
    scanned = 0
    pending = [logical_root]
    while pending:
        scanned += 1
        if scanned > 500:
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
            pending.extend(reversed(entries[:500]))
            continue
        if not resolved.is_file():
            continue
        name = current.rstrip("/").rsplit("/", 1)[-1].lower()
        if name == document["filename"].lower():
            candidates.append(current)
    for logical_path in candidates:
        try:
            raw = files.read_bytes(logical_path, max_bytes=MAX_MATERIAL_BYTES + 1)
        except FileAccessError:
            continue
        if hashlib.sha256(raw).hexdigest() == document["content_hash"]:
            return {"document_id": document["document_id"], "filename": document["filename"], "logical_path": logical_path}
    return {"document_id": document["document_id"], "missing": True, "reason": "document_unavailable"}
