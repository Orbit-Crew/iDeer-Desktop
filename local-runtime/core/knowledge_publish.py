"""Explicit server-side publication of a local KB revision from the device (#115).

Publishing is the owner's confirmed decision to create an independent server
copy of one frozen local-import revision: the device re-reads the exact files
behind that revision inside the confirmed workspace, verifies every hash
against the registration record, and only then — after the platform preview
and the user's explicit confirmation — uploads content through the platform's
own document upload endpoint. The device KB itself stays private; the copy's
visibility is governed exclusively by the platform's visibility application
flow, and nothing syncs automatically in either direction.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

# Frozen cross-repo contract (server backend/app/agentplatform/knowledge/
# local_publish.py): fixed categories the Server and Desktop both understand.
PUBLISH_CONFIRMATION_REQUIRED = "LOCAL_PUBLISH_CONFIRMATION_REQUIRED"
PUBLISH_CONTENT_DRIFTED = "LOCAL_PUBLISH_CONTENT_DRIFTED"

MAX_PUBLISH_DOCUMENTS = 200


class KnowledgePublishError(RuntimeError):
    """A fixed-category publication failure; safe to surface as an error code."""


def verify_against_registration(entries: list[dict[str, Any]], registered: dict[str, Any]) -> None:
    """The picked files must be exactly the registered revision's documents.

    Every manifest identity (name, SHA-256, size) must match the registration
    record; drifted, missing, or extra content is refused before a single
    byte leaves the device.
    """

    expected = {
        (document.get("filename"), document.get("sha256"), document.get("bytes"))
        for document in registered.get("documents") or []
        if isinstance(document, dict)
    }
    picked = {
        (entry.get("filename"), entry.get("sha256"), entry.get("bytes"))
        for entry in entries
    }
    if not expected or picked != expected:
        raise KnowledgePublishError(PUBLISH_CONTENT_DRIFTED)


class KnowledgePublicationRegistry:
    """Device-local display facts for one identity's explicit publications.

    Rows record the outcome of an explicit attempt only: a preview is
    side-effect free and never recorded, a failed attempt is recorded as
    failed with its real error category, and a published row keeps the server
    copy identity so the display can show where content went. No file paths
    and no content are ever stored.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_publications (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    kb_id TEXT NOT NULL, revision_id TEXT NOT NULL,
                    copy_resource_id TEXT NOT NULL DEFAULT '', copy_slug TEXT NOT NULL DEFAULT '',
                    copy_revision_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
                    error_code TEXT NOT NULL DEFAULT '', document_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "PUBLISH_STORAGE_UNAVAILABLE"

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
                self._error = "PUBLISH_STORAGE_UNAVAILABLE"
                raise KnowledgePublishError(self._error) from exc

    @staticmethod
    def _encoded(binding) -> str:
        return json.dumps(binding, sort_keys=True)

    def record(self, binding, row: dict[str, Any]) -> bool:
        """Keep the first fact per (identity, attempt); identical retries dedupe."""
        fields = {
            "kb_id": str(row.get("kb_id", ""))[:128],
            "revision_id": str(row.get("revision_id", ""))[:128],
            "copy_resource_id": str(row.get("copy_resource_id", ""))[:128],
            "copy_slug": str(row.get("copy_slug", ""))[:255],
            "copy_revision_id": str(row.get("copy_revision_id", ""))[:128],
            "status": "published" if row.get("status") == "published" else "failed",
            "error_code": str(row.get("error_code", ""))[:128],
            "document_count": int(row.get("document_count", 0) or 0),
        }
        fields["identity"] = hashlib.sha256(json.dumps(
            [self._encoded(binding), fields["kb_id"], fields["revision_id"], fields["status"],
             fields["error_code"], fields["copy_resource_id"]]).encode()).hexdigest()

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO knowledge_publications (identity, binding, kb_id, revision_id,"
                " copy_resource_id, copy_slug, copy_revision_id, status, error_code, document_count)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (fields["identity"], self._encoded(binding), fields["kb_id"], fields["revision_id"],
                 fields["copy_resource_id"], fields["copy_slug"], fields["copy_revision_id"],
                 fields["status"], fields["error_code"], fields["document_count"]))
            return cursor.rowcount == 1

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {
            "id": row["identity"], "kbId": row["kb_id"], "revisionId": row["revision_id"],
            "copyResourceId": row["copy_resource_id"], "copySlug": row["copy_slug"],
            "copyRevisionId": row["copy_revision_id"], "status": row["status"],
            "errorCode": row["error_code"], "documentCount": row["document_count"],
            "createdAt": row["created_at"],
        }

    def view(self, binding, limit: int = 20) -> list[dict[str, Any]]:
        """Rows for the current identity only; another account never inherits them."""

        def read(db):
            rows = db.execute("SELECT * FROM knowledge_publications WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                              (self._encoded(binding), int(limit))).fetchall()
            return [self._view(row) for row in rows]

        return self._execute(read)
