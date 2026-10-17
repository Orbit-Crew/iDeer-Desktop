"""Durable at-most-once admission before any task side effect or approval."""
from __future__ import annotations

import sqlite3
from pathlib import Path


class TaskGuard:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self._memory = sqlite3.connect(":memory:", check_same_thread=False) if self.path == ":memory:" else None
        db = self._connection()
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS admitted_tasks (device TEXT, task TEXT, PRIMARY KEY(device, task))")
        if self._memory is None:
            db.close()

    def _connection(self):
        return self._memory or sqlite3.connect(self.path)

    def claim(self, device_id: str, task_id: str) -> bool:
        # Commit before dispatch. A crash leaves an uncertain task claimed;
        # it must be reconciled by the Server, never executed again locally.
        db = self._connection()
        try:
            with db:
                cursor = db.execute("INSERT OR IGNORE INTO admitted_tasks VALUES (?, ?)", (device_id, task_id))
                return cursor.rowcount == 1
        finally:
            if self._memory is None:
                db.close()
