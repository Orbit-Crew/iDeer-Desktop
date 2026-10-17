"""Replay-safe local consent decisions."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def request_hash(payload: object) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ConsentRequest:
    capability: str
    payload: dict[str, Any]
    request_hash: str


def render_consent_summary(
    capability: str, payload: dict[str, Any], *, request_hash: str = ""
) -> dict[str, str]:
    """The human-readable essentials of a consent request (§9 risk grading).

    The user is shown what the agent wants to do, not the raw envelope: the
    target path, the command, or the MCP tool, plus the ``request_hash`` the
    approval binds to. Values are truncated; nothing here is a credential —
    payload secret slots hold ``local:<name>`` references, never plaintext.
    """

    def text(value: Any, limit: int = 240) -> str:
        rendered = "" if value is None else str(value)
        rendered = " ".join(rendered.split())
        return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"

    summary = {
        "capability": capability,
        "action": {
            "local.files.write": "write a file inside an allowed root",
            "local.python": "run a script on this machine",
            "local.artifacts.upload": "send a local file to the server",
        }.get(capability, ""),
    }
    if capability.startswith("local.mcp."):
        summary["action"] = "call a tool on a local MCP server"
        summary["target"] = summary["capability"]
        summary["arguments"] = text(
            json.dumps(payload.get("arguments", {}), ensure_ascii=False)
        )
    elif "path" in payload:
        summary["target"] = text(payload["path"])
        summary["size"] = text(len(str(payload.get("content", "")))) + " characters"
    elif "script" in payload:
        summary["target"] = text(payload.get("working_root", ""))
        summary["command"] = text(payload["script"])
    if payload.get("secrets"):
        summary["secrets"] = text(", ".join(str(name) for name in payload["secrets"]))
    if request_hash:
        summary["request_hash"] = request_hash
    return {key: value for key, value in summary.items() if value}


@dataclass
class ConsentStore:
    _approved: set[tuple[str, str]] = field(default_factory=set)
    _always_allowed: set[str] = field(default_factory=set)
    audit: list[dict[str, str]] = field(default_factory=list)
    db_path: str | Path | None = None

    def __post_init__(self) -> None:
        if self.db_path is None:
            return
        path = Path(self.db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS approvals (capability TEXT NOT NULL, request_hash TEXT NOT NULL, PRIMARY KEY (capability, request_hash))"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS always_allowed (capability TEXT PRIMARY KEY)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS consent_audit (capability TEXT, request_hash TEXT, decision TEXT, actor_id TEXT, decided_at TEXT)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS pending_consents (capability TEXT NOT NULL, request_hash TEXT PRIMARY KEY, payload TEXT NOT NULL)"
            )
            self._approved.update(
                db.execute("SELECT capability, request_hash FROM approvals").fetchall()
            )
            self._always_allowed.update(
                row[0] for row in db.execute("SELECT capability FROM always_allowed")
            )
            self.audit.extend(
                {
                    "capability": row[0],
                    "request_hash": row[1],
                    "decision": row[2],
                    "actor_id": row[3],
                    "decided_at": row[4],
                }
                for row in db.execute(
                    "SELECT capability, request_hash, decision, actor_id, decided_at FROM consent_audit ORDER BY rowid"
                )
            )

    def _persist(self, capability: str, digest: str, approved: bool) -> None:
        if self.db_path is None:
            return
        with sqlite3.connect(self.db_path) as db:
            if approved:
                db.execute(
                    "INSERT OR REPLACE INTO approvals VALUES (?, ?)",
                    (capability, digest),
                )
            else:
                db.execute(
                    "DELETE FROM approvals WHERE capability = ? AND request_hash = ?",
                    (capability, digest),
                )

    def approve(
        self,
        capability: str,
        digest: str,
        *,
        actor_id: str = "local-user",
        decided_at: str | None = None,
    ) -> None:
        self._approved.add((capability, digest))
        self._persist(capability, digest, True)
        self._remove_pending(digest)
        self.audit.append(
            self._audit_entry(capability, digest, "approved", actor_id, decided_at)
        )
        self._persist_audit(self.audit[-1])

    def deny(
        self,
        capability: str,
        digest: str,
        *,
        actor_id: str = "local-user",
        decided_at: str | None = None,
    ) -> None:
        self._approved.discard((capability, digest))
        self._persist(capability, digest, False)
        self._remove_pending(digest)
        self.audit.append(
            self._audit_entry(capability, digest, "denied", actor_id, decided_at)
        )
        self._persist_audit(self.audit[-1])

    def _persist_audit(self, entry: dict[str, str]) -> None:
        if self.db_path is not None:
            with sqlite3.connect(self.db_path) as db:
                db.execute(
                    "INSERT INTO consent_audit VALUES (?, ?, ?, ?, ?)",
                    tuple(
                        entry[k]
                        for k in (
                            "capability",
                            "request_hash",
                            "decision",
                            "actor_id",
                            "decided_at",
                        )
                    ),
                )

    def _remove_pending(self, digest: str) -> None:
        if self.db_path is not None:
            with sqlite3.connect(self.db_path) as db:
                db.execute(
                    "DELETE FROM pending_consents WHERE request_hash = ?", (digest,)
                )

    @staticmethod
    def _audit_entry(
        capability: str,
        digest: str,
        decision: str,
        actor_id: str,
        decided_at: str | None,
    ) -> dict[str, str]:
        from datetime import datetime

        from .compat import UTC

        return {
            "capability": capability,
            "request_hash": digest,
            "decision": decision,
            "actor_id": actor_id,
            "decided_at": decided_at or datetime.now(UTC).isoformat(),
        }

    def set_always_allow(self, capability: str) -> None:
        self._always_allowed.add(capability)
        if self.db_path is not None:
            with sqlite3.connect(self.db_path) as db:
                db.execute(
                    "INSERT OR REPLACE INTO always_allowed VALUES (?)", (capability,)
                )

    def consume(self, capability: str, digest: str) -> bool:
        if capability in self._always_allowed:
            return True
        key = (capability, digest)
        if key not in self._approved:
            return False
        self._approved.remove(key)
        self._persist(capability, digest, False)
        return True


@dataclass(frozen=True)
class PendingConsent:
    """One consent request awaiting a decision, from either answering surface.

    ``silenceable`` is the tray's "always allow" affordance: a Level 2 request
    is shown but can never be moved out of the ask-first path (Local 方案 §9).
    """

    task_id: str
    capability: str
    payload: dict[str, Any]
    request_hash: str
    risk_level: str
    silenceable: bool
    summary: dict[str, str]
    requested_at: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "capability": self.capability,
            "request_hash": self.request_hash,
            "risk_level": self.risk_level,
            "silenceable": self.silenceable,
            "summary": dict(self.summary),
            "requested_at": self.requested_at,
        }


class ConsentExchange:
    """The device-to-user consent round trip at the local runtime boundary."""

    def __init__(self, store: ConsentStore) -> None:
        self.store = store

    def create_request(
        self, capability: str, payload: dict[str, Any]
    ) -> ConsentRequest:
        digest = request_hash(payload)
        if self.store.db_path is not None:
            with sqlite3.connect(self.store.db_path) as db:
                db.execute(
                    "INSERT OR REPLACE INTO pending_consents VALUES (?, ?, ?)",
                    (
                        capability,
                        digest,
                        json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    ),
                )
        return ConsentRequest(capability, dict(payload), digest)

    def decide(
        self,
        request: ConsentRequest,
        *,
        approved: bool,
        actor_id: str,
        decided_at: str | None = None,
    ) -> None:
        if approved:
            self.store.approve(
                request.capability,
                request.request_hash,
                actor_id=actor_id,
                decided_at=decided_at,
            )
        else:
            self.store.deny(
                request.capability,
                request.request_hash,
                actor_id=actor_id,
                decided_at=decided_at,
            )

    def authorize(self, request: ConsentRequest, payload: dict[str, Any]) -> bool:
        if request_hash(payload) != request.request_hash:
            return False
        return self.store.consume(request.capability, request.request_hash)
