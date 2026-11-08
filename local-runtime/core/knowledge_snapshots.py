"""Offline knowledge snapshots (#101): the last successful graph/wiki view.

决策票 62: 离线可查看已生成内容并标注"离线快照". The store keeps, per frozen
revision identity, the last successful projected view of the platform's
knowledge graph, wiki page list, single wiki page reads, and the wiki
navigation index. When the platform is unreachable, a ``view``-family read
falls back to the cached copy annotated ``offline`` — a read-only display of
what was actually generated, never a re-generation and never a fabricated
answer. Everything is binding-scoped like every other knowledge store, and a
cache is display fact only: writing one never fails a successful view, and
the user's separate 清理 action purges it with the index.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# A snapshot is a bounded display projection, never an archive: the projected
# graph/wiki payloads are bounded at the seam already, and anything larger is
# refused instead of silently truncating into a dishonest partial view.
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
SNAPSHOT_KINDS = ("graph", "wiki", "wiki-navigation")
PAGE_KIND_PREFIX = "wiki-page:"


def _valid_kind(kind: str) -> bool:
    """One graph/wiki view family, or one page read keyed by its frozen
    document id (``wiki-page:<documentId>``, so two pages never collide).
    The accepted shapes bound the kind's length by construction."""
    if kind in SNAPSHOT_KINDS:
        return True
    if kind.startswith(PAGE_KIND_PREFIX):
        page_id = kind[len(PAGE_KIND_PREFIX):]
        return 0 < len(page_id) <= 64 and all(
            c in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in page_id)
    return False


class KnowledgeSnapshotError(RuntimeError):
    """A fixed-category snapshot failure; safe to surface as an error code."""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class KnowledgeSnapshotStore:
    """SQLite-backed per-revision offline snapshot cache (#101).

    Rows are keyed by the frozen identity (binding, kb id, revision id, kind)
    — the same binding-scoped lookup the registries perform — so another
    account or device never inherits a snapshot. The newest successful view
    wins; there is no history here, only the one honest copy per kind.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_snapshots (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    kb_id TEXT NOT NULL, revision_id TEXT NOT NULL,
                    revision_no INTEGER NOT NULL DEFAULT 0,
                    manifest_hash TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
                    captured_at TEXT NOT NULL DEFAULT '')""")
        except (sqlite3.Error, OSError):
            self._error = "KNOWLEDGE_SNAPSHOT_STORAGE_UNAVAILABLE"

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
                self._error = "KNOWLEDGE_SNAPSHOT_STORAGE_UNAVAILABLE"
                raise KnowledgeSnapshotError(self._error) from exc

    @staticmethod
    def _encoded(binding) -> str:
        return json.dumps(binding, sort_keys=True)

    def _identity(self, binding, kb_id: str, revision_id: str, kind: str) -> str:
        material = json.dumps([self._encoded(binding), str(kb_id)[:128],
                               str(revision_id)[:128], kind])
        return hashlib.sha256(material.encode()).hexdigest()

    def save(self, binding, kb_id: str, revision_id: str, revision_no: int,
             manifest_hash: str, kind: str, payload: dict[str, Any]) -> bool:
        """Keep the newest successful projected view for one revision/kind."""
        if not isinstance(kind, str) or not _valid_kind(kind) or not isinstance(payload, dict):
            raise KnowledgeSnapshotError("KNOWLEDGE_SNAPSHOT_INVALID")
        try:
            serialized = json.dumps(payload, ensure_ascii=False)
        except (ValueError, TypeError) as exc:
            raise KnowledgeSnapshotError("KNOWLEDGE_SNAPSHOT_INVALID") from exc
        if len(serialized.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
            raise KnowledgeSnapshotError("KNOWLEDGE_SNAPSHOT_TOO_LARGE")

        def write(db):
            cursor = db.execute(
                """INSERT INTO knowledge_snapshots
                    (identity, binding, kb_id, revision_id, revision_no, manifest_hash,
                     kind, payload, captured_at)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(identity) DO UPDATE SET
                    revision_no=excluded.revision_no, manifest_hash=excluded.manifest_hash,
                    payload=excluded.payload, captured_at=excluded.captured_at""",
                (self._identity(binding, kb_id, revision_id, kind),
                 self._encoded(binding), str(kb_id)[:128], str(revision_id)[:128],
                 max(0, int(revision_no or 0)), str(manifest_hash)[:64], kind,
                 serialized, _now()))
            return cursor.rowcount > 0

        return self._execute(write)

    def fetch(self, binding, kb_id: str, revision_id: str, kind: str) -> dict[str, Any] | None:
        """The cached copy for one revision/kind, with its honest capture time.

        Returns ``{'payload': …, 'capturedAt': …}`` or None; a corrupt stored
        payload reads as absent instead of impersonating a cached view."""

        def read(db):
            row = db.execute(
                "SELECT payload, captured_at FROM knowledge_snapshots WHERE identity=?",
                (self._identity(binding, kb_id, revision_id, kind),)).fetchone()
            if row is None:
                return None
            try:
                payload = json.loads(row["payload"])
            except (ValueError, TypeError):
                return None
            if not isinstance(payload, dict):
                return None
            return {"payload": payload, "capturedAt": str(row["captured_at"] or "")}

        return self._execute(read)

    def purge(self, binding, kb_id: str, revision_id: str) -> int:
        """Delete every cached kind for one revision (the user's 清理 action)."""

        def write(db):
            return db.execute(
                "DELETE FROM knowledge_snapshots WHERE binding=? AND kb_id=? AND revision_id=?",
                (self._encoded(binding), str(kb_id)[:128], str(revision_id)[:128])).rowcount

        return self._execute(write)
