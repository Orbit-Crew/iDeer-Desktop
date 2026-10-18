"""Append-only local audit log: what the agent actually did on this machine.

The log is the device-side counterpart of the server audit trail (Local 方案
§35). It is written on the device only, ordered by time, and exposes two
operations: append and read. There is deliberately no update and no delete —
the one destructive operation, :meth:`LocalAuditLog.clear`, seals the history
behind a marker row that records what was dropped, so a cleared log can never
be mistaken for a log where nothing happened.

Every row is chained: ``entry_hash`` covers the row content plus the previous
row's hash, so :meth:`LocalAuditLog.verify` detects rewriting or splicing.
Entries never carry secret plaintext: only ``local:<name>`` references and
hashes are recorded, and free-text detail is scrubbed by the caller's redactor.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .compat import UTC, StrEnum


class AuditKind(StrEnum):
    """The event families §35 requires a device to keep locally."""

    CONNECTION = "connection"
    TASK = "task"
    CONSENT = "consent"
    EXECUTION = "execution"
    MCP = "mcp"
    SECRET = "secret"
    POLICY = "policy"
    CONFIG = "config"
    CONTROL = "control"
    AUDIT = "audit"


GENESIS_HASH = "0" * 64


@dataclass(frozen=True)
class AuditEntry:
    """One recorded audit event."""

    seq: int
    kind: AuditKind
    action: str
    at: str
    capability: str | None = None
    digest: str | None = None
    run_id: str | None = None
    task_id: str | None = None
    detail: dict[str, Any] | None = None
    actor_id: str | None = None
    entry_hash: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "kind": self.kind.value,
            "action": self.action,
            "at": self.at,
            "capability": self.capability,
            "digest": self.digest,
            "run_id": self.run_id,
            "task_id": self.task_id,
            "detail": self.detail or {},
            "actor_id": self.actor_id,
            "entry_hash": self.entry_hash,
        }


@dataclass(frozen=True)
class AuditIntegrity:
    """Result of walking the hash chain."""

    ok: bool
    entries: int
    problem: str | None = None


def _paged(entries: list[AuditEntry], limit: int) -> list[AuditEntry]:
    """First ``limit`` entries; 0 means the whole list, the reading default."""
    return entries[:limit] if limit > 0 else entries


def _entry_hash(previous: str, seq: int, at: str, row: dict[str, Any]) -> str:
    body = json.dumps(
        {"prev": previous, "seq": seq, "at": at, "row": row},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    action TEXT NOT NULL,
    capability TEXT,
    digest TEXT,
    run_id TEXT,
    task_id TEXT,
    actor_id TEXT,
    detail TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_cleared (
    cleared_at TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    entries_removed INTEGER NOT NULL,
    last_entry_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    head_hash TEXT NOT NULL
);
"""


@dataclass
class LocalAuditLog:
    """Device-local, append-only audit history backed by SQLite."""

    db_path: str | Path | None = None

    def __post_init__(self) -> None:
        self._buffer: list[AuditEntry] = []
        self._cleared: list[dict[str, Any]] = []
        self._head = GENESIS_HASH
        self._next_seq = 1
        if self.db_path is None:
            return
        path = Path(self.db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.executescript(_SCHEMA)
            if db.execute("SELECT 1 FROM audit_meta WHERE id = 1").fetchone() is None:
                db.execute("INSERT INTO audit_meta VALUES (1, ?)", (GENESIS_HASH,))
                db.commit()

    # --- writing ---------------------------------------------------------

    def record(
        self,
        kind: AuditKind,
        action: str,
        *,
        capability: str | None = None,
        digest: str | None = None,
        run_id: str | None = None,
        task_id: str | None = None,
        actor_id: str | None = None,
        detail: dict[str, Any] | None = None,
        redactor: Any = None,
        at: str | None = None,
    ) -> AuditEntry:
        """Append one event; secret material never enters the row."""
        row = {
            "kind": kind.value,
            "action": action,
            "capability": capability,
            "digest": digest,
            "run_id": run_id,
            "task_id": task_id,
            "actor_id": actor_id,
            "detail": _redacted(detail, redactor),
        }
        stamp = at or datetime.now(UTC).isoformat().replace("+00:00", "Z")
        if self.db_path is None:
            seq = self._next_seq
            self._next_seq += 1
            entry_hash = _entry_hash(self._head, seq, stamp, row)
            self._head = entry_hash
            entry = _entry(seq, stamp, row, entry_hash)
            self._buffer.append(entry)
            return entry
        with sqlite3.connect(self.db_path) as db:
            head = _head(db)
            seq = db.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_entries"
            ).fetchone()[0]
            entry_hash = _entry_hash(head, seq, stamp, row)
            db.execute(
                "INSERT INTO audit_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    seq,
                    stamp,
                    row["kind"],
                    row["action"],
                    row["capability"],
                    row["digest"],
                    row["run_id"],
                    row["task_id"],
                    row["actor_id"],
                    json.dumps(row["detail"], ensure_ascii=False, sort_keys=True),
                    head,
                    entry_hash,
                ),
            )
            db.execute("INSERT OR REPLACE INTO audit_meta VALUES (1, ?)", (entry_hash,))
            db.commit()
        return _entry(seq, stamp, row, entry_hash)

    # --- reading ---------------------------------------------------------

    def recent(
        self, *, limit: int = 50, kind: AuditKind | None = None
    ) -> list[AuditEntry]:
        """Newest first, so the user sees what just happened without paging."""
        if self.db_path is None:
            entries = list(reversed(self._buffer))
            if kind is not None:
                entries = [entry for entry in entries if entry.kind is kind]
            return _paged(entries, limit)
        # Filter and page inside SQLite: the tray polls recent(limit=1) every
        # second, so loading the whole table per poll would make the status
        # refresh O(history) as the audit log grows (05-M7).
        sql = (
            "SELECT seq, at, kind, action, capability, digest, run_id, task_id,"
            " actor_id, detail, entry_hash FROM audit_entries"
        )
        params: list[Any] = []
        if kind is not None:
            sql += " WHERE kind = ?"
            params.append(kind.value)
        sql += " ORDER BY seq DESC"
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        with sqlite3.connect(self.db_path) as db:
            rows = db.execute(sql, params).fetchall()
        return [_from_row(row) for row in rows]

    def since(self, seq: int, *, limit: int = 200) -> list[AuditEntry]:
        """Entries newer than ``seq``, oldest first: what a live view must append."""
        entries = [entry for entry in self.recent(limit=0) if entry.seq > seq]
        return _paged(entries, limit)

    def filter(
        self,
        *,
        kinds: tuple[AuditKind, ...] = (),
        capability: str | None = None,
        limit: int = 100,
    ) -> list[AuditEntry]:
        """Narrow the history by event family and capability."""
        entries = self.recent(limit=0)
        if kinds:
            wanted = frozenset(kinds)
            entries = [entry for entry in entries if entry.kind in wanted]
        if capability is not None:
            entries = [entry for entry in entries if entry.capability == capability]
        return _paged(entries, limit)

    def verify(self) -> AuditIntegrity:
        """Walk the chain; a rewritten or spliced row makes ``ok`` false.

        A cleared log is not a broken one: the first surviving row may chain
        from a clearance seal — the hash of the last row before that clear —
        instead of the row before it, which is deliberately gone. Every other
        link is checked exactly, so splicing or rewriting is still detected.
        """
        if self.db_path is None:
            return AuditIntegrity(ok=True, entries=len(self._buffer))
        with sqlite3.connect(self.db_path) as db:
            rows = db.execute(
                "SELECT seq, at, kind, action, capability, digest, run_id, task_id,"
                " actor_id, detail, prev_hash, entry_hash FROM audit_entries ORDER BY seq"
            ).fetchall()
            head = _head(db)
        previous = GENESIS_HASH
        seals = {row["last_entry_hash"] for row in self.clearances()}
        for position, row in enumerate(rows):
            if position == 0 and row[10] != GENESIS_HASH and row[10] in seals:
                previous = row[10]
            body = {
                "kind": row[2],
                "action": row[3],
                "capability": row[4],
                "digest": row[5],
                "run_id": row[6],
                "task_id": row[7],
                "actor_id": row[8],
                "detail": json.loads(row[9]),
            }
            if (
                row[10] != previous
                or _entry_hash(previous, row[0], row[1], body) != row[11]
            ):
                return AuditIntegrity(
                    ok=False,
                    entries=len(rows),
                    problem=f"chain broken at entry {row[0]}",
                )
            previous = row[11]
        if head != previous:
            return AuditIntegrity(
                ok=False,
                entries=len(rows),
                problem="head hash does not match the chain",
            )
        return AuditIntegrity(ok=True, entries=len(rows))

    def clearances(self) -> list[dict[str, Any]]:
        """The record of every past clear: a cleared log stays explainable."""
        if self.db_path is None:
            return list(self._cleared)
        with sqlite3.connect(self.db_path) as db:
            return [
                {
                    "cleared_at": row[0],
                    "actor_id": row[1],
                    "entries_removed": row[2],
                    "last_entry_hash": row[3],
                }
                for row in db.execute(
                    "SELECT cleared_at, actor_id, entries_removed, last_entry_hash"
                    " FROM audit_cleared ORDER BY rowid"
                )
            ]

    # --- the one destructive operation ----------------------------------

    def clear(self, *, actor_id: str = "local-user") -> dict[str, Any]:
        """Drop stored events, sealing them behind an immutable marker.

        The marker is appended to the chain first, so the evidence that a
        history existed — how many entries and the hash of the last one —
        survives the clear. Individual entries cannot be removed or edited.
        """
        entries = self.recent(limit=0)
        last = entries[0] if entries else None
        marker = self.record(
            AuditKind.AUDIT,
            "cleared",
            actor_id=actor_id,
            detail={
                "entries_removed": len(entries),
                "last_entry_hash": last.entry_hash if last else None,
            },
        )
        clearance = _clearance(marker, len(entries), last)
        if self.db_path is None:
            self._buffer = [entry for entry in self._buffer if entry.seq == marker.seq]
            self._cleared.append(clearance)
            return clearance
        with sqlite3.connect(self.db_path) as db:
            db.execute("DELETE FROM audit_entries WHERE seq < ?", (marker.seq,))
            db.execute(
                "INSERT INTO audit_cleared VALUES (?, ?, ?, ?)",
                (
                    marker.at,
                    actor_id,
                    len(entries),
                    last.entry_hash if last else GENESIS_HASH,
                ),
            )
            db.commit()
        return clearance


def _clearance(
    marker: AuditEntry, removed: int, last: AuditEntry | None
) -> dict[str, Any]:
    return {
        "cleared_at": marker.at,
        "actor_id": marker.actor_id,
        "entries_removed": removed,
        "last_entry_hash": last.entry_hash if last else GENESIS_HASH,
    }


def _head(db: sqlite3.Connection) -> str:
    row = db.execute("SELECT head_hash FROM audit_meta WHERE id = 1").fetchone()
    return row[0] if row else GENESIS_HASH


def _entry(seq: int, at: str, row: dict[str, Any], entry_hash: str) -> AuditEntry:
    return AuditEntry(
        seq=seq,
        kind=AuditKind(row["kind"]),
        action=row["action"],
        at=at,
        capability=row["capability"],
        digest=row["digest"],
        run_id=row["run_id"],
        task_id=row["task_id"],
        actor_id=row["actor_id"],
        detail=row["detail"],
        entry_hash=entry_hash,
    )


def _from_row(row: tuple[Any, ...]) -> AuditEntry:
    return AuditEntry(
        seq=row[0],
        kind=AuditKind(row[2]),
        action=row[3],
        at=row[1],
        capability=row[4],
        digest=row[5],
        run_id=row[6],
        task_id=row[7],
        actor_id=row[8],
        detail=json.loads(row[9]),
        entry_hash=row[10],
    )


def _redacted(detail: dict[str, Any] | None, redactor: Any) -> dict[str, Any]:
    if not detail:
        return {}
    if redactor is None:
        return dict(detail)
    scrubbed = redactor.redact(
        json.dumps(detail, ensure_ascii=False, sort_keys=True, default=str)
    )
    try:
        parsed = json.loads(scrubbed)
    except (TypeError, ValueError):
        return {"detail": scrubbed}
    return parsed if isinstance(parsed, dict) else {"detail": scrubbed}
