"""Explicit local knowledge import: device freeze plus platform registration (#112).

The user explicitly picks files inside the confirmed workspace; the device
reads them, computes content fingerprints, and registers one immutable
private KnowledgeBase Revision manifest on the platform. Original bytes and
the device-side index never upload: the registration request carries only
document identity fields (plain file name, size, MIME type, SHA-256), and the
path-to-hash mapping stays a device-local display fact for this identity.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .compat import is_junction
from .files import FileAccessError

# Frozen cross-repo contract (server backend/app/agentplatform/knowledge):
# the platform accepts at most 200 documents per import, each within the
# document upload size cap, with the same supported-extension whitelist.
MAX_IMPORT_DOCUMENTS = 200
MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".csv", ".doc", ".docx", ".json", ".md", ".pdf", ".ppt", ".pptx", ".txt", ".xls", ".xlsx"}
DOCUMENT_FIELDS = ("filename", "sha256", "bytes", "mime")


class KnowledgeImportError(RuntimeError):
    """A fixed-category import failure; safe to surface as an error code."""


def category_for(error: BaseException) -> str:
    """Map device-side failures onto the fixed import categories."""
    if isinstance(error, KnowledgeImportError):
        return str(error)
    if isinstance(error, FileAccessError):
        mapped = {
            "WORKSPACE_UNAVAILABLE": "KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE",
            "OUTSIDE_ALLOWED_ROOTS": "KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS",
            "PROTECTED_PATH": "KNOWLEDGE_IMPORT_PROTECTED_PATH",
        }
        return mapped.get(error.code, "KNOWLEDGE_IMPORT_FILE_UNAVAILABLE")
    return "KNOWLEDGE_IMPORT_FAILED"


def logical_paths_for(grant: dict[str, Any], physical_paths: list[str]) -> list[str]:
    """Map picked physical files onto the confirmed workspace logical view.

    Every path is verified against the selected root and its recorded
    directory generation before any read: a file outside the confirmed
    workspace, or reached through a link or junction, is refused outright.
    """
    root = Path(grant["physical_root"])
    identity = [root.stat().st_dev, root.stat().st_ino]
    if list(grant.get("identity") or []) != identity:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE")
    logical: list[str] = []
    for raw in physical_paths:
        if not isinstance(raw, str) or not raw or len(raw) > 32768 or "\x00" in raw:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
        picked = Path(raw)
        # Check every ancestor before resolve, so a junctioned selection can
        # never masquerade as a workspace member (same rule as select()).
        for component in [*reversed(picked.parents), picked]:
            if component.is_symlink() or is_junction(component):
                raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
        try:
            resolved = picked.resolve(strict=True)
            relative = resolved.relative_to(root)
        except (OSError, ValueError) as exc:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS") from exc
        logical.append(f"{grant['logical_root']}/{relative.as_posix()}")
    if len(logical) != len(set(logical)):
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_DUPLICATE_PATH")
    return logical


def build_manifest(files: Any, logical_paths: list[str]) -> list[dict[str, Any]]:
    """Read each workspace file once and freeze its identity only.

    Reading reuses the workspace store boundary, so protected names, links
    and out-of-root paths fail closed before a single byte leaves the device.
    """
    if len(logical_paths) > MAX_IMPORT_DOCUMENTS:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_TOO_MANY_DOCUMENTS")
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for logical_path in logical_paths:
        filename = logical_path.rstrip("/").rsplit("/", 1)[-1]
        if not filename or Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_UNSUPPORTED_TYPE")
        try:
            raw = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES + 1)
        except FileAccessError as exc:
            raise KnowledgeImportError(category_for(exc)) from exc
        if len(raw) > MAX_IMPORT_FILE_BYTES:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_FILE_TOO_LARGE")
        digest = hashlib.sha256(raw).hexdigest()
        if digest in seen:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_DUPLICATE_CONTENT")
        seen.add(digest)
        entries.append({
            "filename": filename,
            "sha256": digest,
            "bytes": len(raw),
            "mime": mimetypes.guess_type(filename)[0] or "application/octet-stream",
        })
    return entries


def registration_payload(entries: list[dict[str, Any]], device_id: str) -> dict[str, Any]:
    """The complete registration request: identity fields only, never content."""
    return {
        "documents": [dict(filename=entry["filename"], content_hash=entry["sha256"],
                           size_bytes=entry["bytes"], mime_type=entry["mime"]) for entry in entries],
        "device_id": device_id[:128],
    }


class KnowledgeImportRegistry:
    """Device-local display facts for one identity's explicit imports.

    A failed import is recorded as failed with its real error category: the
    display must never impersonate a registered revision. Rows keep the
    manifest identity so a later view can compare hashes after the originals
    drift, but never the physical paths or any file content.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_imports (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    kb_id TEXT NOT NULL, revision_id TEXT NOT NULL DEFAULT '',
                    revision_no INTEGER NOT NULL DEFAULT 0, manifest_hash TEXT NOT NULL DEFAULT '',
                    document_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
                    error_code TEXT NOT NULL DEFAULT '', documents TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "IMPORT_STORAGE_UNAVAILABLE"

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
                self._error = "IMPORT_STORAGE_UNAVAILABLE"
                raise KnowledgeImportError(self._error) from exc

    @staticmethod
    def _encoded(binding) -> str:
        return json.dumps(binding, sort_keys=True)

    def record(self, binding, row: dict[str, Any]) -> bool:
        """Keep the first fact per (identity, import attempt); later rows win a new identity."""
        fields = {
            "kb_id": str(row.get("kb_id", ""))[:128],
            "revision_id": str(row.get("revision_id", ""))[:128],
            "revision_no": int(row.get("revision_no", 0) or 0),
            "manifest_hash": str(row.get("manifest_hash", ""))[:64],
            "document_count": int(row.get("document_count", 0) or 0),
            "status": "registered" if row.get("status") == "registered" else "failed",
            "error_code": str(row.get("error_code", ""))[:128],
            "documents": json.dumps([{key: document.get(key) for key in DOCUMENT_FIELDS}
                                     for document in (row.get("documents") or [])][:MAX_IMPORT_DOCUMENTS]),
        }
        fields["identity"] = hashlib.sha256(json.dumps(
            [self._encoded(binding), fields["kb_id"], fields["status"], fields["error_code"],
             sorted(document["sha256"] for document in json.loads(fields["documents"]))]).encode()).hexdigest()

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO knowledge_imports (identity, binding, kb_id, revision_id, revision_no,"
                " manifest_hash, document_count, status, error_code, documents) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (fields["identity"], self._encoded(binding), fields["kb_id"], fields["revision_id"],
                 fields["revision_no"], fields["manifest_hash"], fields["document_count"],
                 fields["status"], fields["error_code"], fields["documents"]))
            return cursor.rowcount == 1

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        try:
            documents = json.loads(row["documents"])
        except (ValueError, TypeError):
            documents = []
        return {
            "id": row["identity"], "kbId": row["kb_id"], "revisionId": row["revision_id"],
            "revisionNo": row["revision_no"], "manifestHash": row["manifest_hash"],
            "documentCount": row["document_count"], "status": row["status"],
            "errorCode": row["error_code"], "createdAt": row["created_at"],
            "documents": [dict(filename=document.get("filename", ""), sha256=document.get("sha256", ""),
                               bytes=document.get("bytes", 0), mime=document.get("mime", ""))
                          for document in documents if isinstance(document, dict)],
        }

    def view(self, binding, limit: int = 20) -> list[dict[str, Any]]:
        """Rows for the current identity only; another account never inherits them."""

        def read(db):
            rows = db.execute("SELECT * FROM knowledge_imports WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                              (self._encoded(binding), int(limit))).fetchall()
            return [self._view(row) for row in rows]

        return self._execute(read)
