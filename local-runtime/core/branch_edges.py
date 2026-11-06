"""Issue 113: the device-observed branch edges behind the Synapse session map.

The platform's branch endpoint answers with the Server's own parent facts
(``parent_thread_id`` / ``branched_from_message_id``) at the one moment a
branch succeeds on this device; this ledger is where those facts survive a
restart. Rows are keyed by the chat scope, so another account or origin on
the same device never sees them, and a child keeps exactly one edge — the
platform creates a fresh Thread per branch, so a re-branch is a new child,
never an update of an old one.

The map draws an edge only where both endpoints exist as platform rows. A
missing record, a pruned parent or a storage failure therefore renders as
an unconnected session — an honest absence, never a guessed relation.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path


class BranchEdgeLedger:
    """Best-effort storage for the branch facts this device observed.

    Recording never fails a branch — the branch is already platform truth
    when the record runs — and reading never fails a list: a storage error
    surfaces as an empty edge set, which the map renders as unconnected
    sessions instead of inventing relations. Every call opens its own
    connection and SQLite serializes the file, so no lock of our own.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS branch_edges (
                    scope TEXT NOT NULL, child_id TEXT NOT NULL,
                    parent_id TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (scope, child_id))""")
        except (sqlite3.Error, OSError):
            pass

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, uri=self.path.startswith('file:'))
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def record(self, scope: str, child_id: str, parent_id: str, message_id: str) -> bool:
        """Record one observed edge; idempotent per (scope, child)."""
        if not scope or not child_id or not parent_id:
            return False
        try:
            with self._db() as db:
                db.execute('INSERT OR REPLACE INTO branch_edges (scope, child_id, parent_id, message_id) VALUES (?,?,?,?)',
                           (scope, child_id, parent_id, message_id))
            return True
        except (sqlite3.Error, OSError):
            return False

    def edges_for_scope(self, scope: str) -> dict:
        """One scope's edges keyed by child id, bounded like the list page."""
        if not scope:
            return {}
        try:
            with self._db() as db:
                rows = db.execute(
                    'SELECT child_id, parent_id, message_id FROM branch_edges WHERE scope=? '
                    'ORDER BY created_at DESC, child_id LIMIT 1000', (scope,)).fetchall()
        except (sqlite3.Error, OSError):
            return {}
        return {row['child_id']: {'parent_id': row['parent_id'], 'message_id': row['message_id']}
                for row in rows}
