"""Device-local project folder bindings: one row per platform project+device (#92).

The desktop keeps no project roster (issue 91), but each device may bind a
local working folder to a platform project as an optional accessory. Rows are
keyed by the whole profile binding (server, account, device identity), so a
binding never migrates: the same account on another machine reads an empty
view and shows 未绑定（原设备绑定不迁移）. Deleting or archiving the platform
project never touches these rows and binding never touches local files or
directory grants — the registry only names the folder the user confirmed.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

MAX_TEXT = 1024


class ProjectBindingError(RuntimeError):
    """No binding read or write may be trusted while storage is unavailable."""


class ProjectBindingRegistry:
    """Binding-scoped device-local facts about project folder bindings.

    Like every device registry, rows carry identity fields and the local
    binding facts; the physical layout stays derivable from the profile and
    is never projected across the Desktop boundary.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS project_bindings (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    project_id TEXT NOT NULL, path TEXT NOT NULL,
                    device_name TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "PROJECT_BINDING_STORAGE_UNAVAILABLE"

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
                self._error = "PROJECT_BINDING_STORAGE_UNAVAILABLE"
                raise ProjectBindingError(self._error) from exc

    @staticmethod
    def _identity(binding, project_id: str) -> str:
        return hashlib.sha256(json.dumps(
            [json.dumps(binding, sort_keys=True), project_id], sort_keys=True).encode()).hexdigest()

    def set(self, binding, project_id: str, path: str, device_name: str) -> None:
        """Record or replace this device's binding for one project (补绑)."""

        def write(db):
            db.execute(
                "INSERT INTO project_bindings (identity, binding, project_id, path, device_name)"
                " VALUES (?,?,?,?,?)"
                " ON CONFLICT(identity) DO UPDATE SET path=excluded.path,"
                " device_name=excluded.device_name",
                (self._identity(binding, project_id), json.dumps(binding, sort_keys=True),
                 project_id, path[:MAX_TEXT], device_name[:MAX_TEXT]))

        self._execute(write)

    def clear(self, binding, project_id: str) -> bool:
        def write(db):
            cursor = db.execute("DELETE FROM project_bindings WHERE identity=?",
                                (self._identity(binding, project_id),))
            return cursor.rowcount == 1

        return self._execute(write)

    def bound_path(self, binding, project_id: str) -> str | None:
        def read(db):
            row = db.execute("SELECT path FROM project_bindings WHERE identity=?",
                             (self._identity(binding, project_id),)).fetchone()
            return row["path"] if row is not None else None

        return self._execute(read)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {"projectId": row["project_id"], "path": row["path"],
                "deviceName": row["device_name"], "createdAt": row["created_at"]}

    def view(self, binding) -> list[dict[str, Any]]:
        def read(db):
            return [self._view(row) for row in db.execute(
                "SELECT * FROM project_bindings WHERE binding=? ORDER BY project_id",
                (json.dumps(binding, sort_keys=True),))]

        return self._execute(read)
