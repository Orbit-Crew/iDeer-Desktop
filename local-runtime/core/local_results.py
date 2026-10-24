"""Device-local registry of workspace results; display-only until an explicit upload.

Rows keep the task fact and its verification metadata (logical path, content
hash, size) for the identity that produced them. Nothing here uploads, and no
physical path or file content is ever stored: cross-device history can only
distinguish "registered on the original device" from "platform artifact" using
the logical view and the recorded platform reference.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .receipts import content_hash

BINDING_FIELDS = ("server_origin", "user_id", "device_id", "device_public_key", "broker_public_key")
RESULT_FIELDS = ("task_id", "run_id", "thread_id", "capability", "logical_root", "logical_path", "name", "sha256", "bytes")


class LocalResultError(RuntimeError):
    """A fixed-category registry failure; safe to surface as an error code."""


class LocalResultRegistry:
    """One immutable registered fact per (identity, task), plus its upload state."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS local_results (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
                    capability TEXT NOT NULL, logical_root TEXT NOT NULL, logical_path TEXT NOT NULL,
                    name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
                    artifact_ref TEXT NOT NULL DEFAULT '', uploaded_at TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "RESULT_STORAGE_UNAVAILABLE"

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
        # Every operation retries live storage and re-latches on failure, so a
        # read that succeeds again can clear an advisory error, but a broken
        # registry still fails each individual operation closed.
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                self._error = ""
                return result
            except (sqlite3.Error, OSError) as exc:
                self._error = "RESULT_STORAGE_UNAVAILABLE"
                raise LocalResultError(self._error) from exc

    @staticmethod
    def _binding(binding) -> dict[str, str]:
        return {key: str((binding or {}).get(key, "")) for key in BINDING_FIELDS}

    @classmethod
    def _identity(cls, binding, task_id) -> str:
        return content_hash({**cls._binding(binding), "task_id": str(task_id)})

    def record(self, binding, row: dict[str, Any]) -> bool:
        """Register one completed result; the first fact per task is immutable."""
        fields = {key: str(row.get(key, "")) for key in RESULT_FIELDS}
        fields["bytes"] = int(row.get("bytes", 0) or 0)

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO local_results (identity, binding, thread_id, run_id, task_id, capability,"
                " logical_root, logical_path, name, sha256, bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (self._identity(binding, fields["task_id"]), json.dumps(self._binding(binding), sort_keys=True),
                 fields["thread_id"], fields["run_id"], fields["task_id"], fields["capability"],
                 fields["logical_root"], fields["logical_path"], fields["name"], fields["sha256"], fields["bytes"]))
            return cursor.rowcount == 1

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {key: row[key] for key in (*RESULT_FIELDS, "artifact_ref", "uploaded_at")}

    def _find(self, db, identity):
        return db.execute("SELECT * FROM local_results WHERE identity=?", (identity,)).fetchone()

    def get(self, binding, task_id) -> dict[str, Any] | None:
        identity = self._identity(binding, task_id)
        return self._execute(lambda db: (lambda row: self._view(row) if row is not None else None)(
            self._find(db, identity)))

    def view(self, binding, thread_id, run_ids=()) -> list[dict[str, Any]]:
        """Rows for one original thread, visible only to their owning identity."""
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        wanted_runs = {str(run_id) for run_id in run_ids}

        def read(db):
            rows = []
            for row in db.execute("SELECT * FROM local_results WHERE binding=? ORDER BY rowid DESC", (encoded,)):
                if row["thread_id"] != str(thread_id) and row["run_id"] not in wanted_runs:
                    continue
                rows.append(self._view(row))
            return rows

        return self._execute(read)

    def mark_uploaded(self, binding, task_id, artifact_ref) -> bool:
        """Bind the platform artifact to the task; same ref replays, another conflicts."""
        identity = self._identity(binding, task_id)

        def write(db):
            row = self._find(db, identity)
            if row is None:
                raise LocalResultError("RESULT_NOT_ADMITTED")
            if row["artifact_ref"] == str(artifact_ref):
                return False
            if row["artifact_ref"]:
                raise LocalResultError("RESULT_UPLOAD_CONFLICT")
            db.execute("UPDATE local_results SET artifact_ref=?, uploaded_at=? WHERE identity=? AND artifact_ref=''",
                       (str(artifact_ref), datetime.now(timezone.utc).isoformat(), identity))
            return True

        return self._execute(write)
