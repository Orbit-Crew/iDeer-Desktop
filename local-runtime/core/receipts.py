"""Immutable local execution receipts."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class LocalExecutionReceipt:
    run_id: str
    task_id: str
    capability: str
    policy_decision: str
    status: str
    payload_hash: str
    result_hash: str | None = None
    policy_version: str = "1"
    consent_decision: str | None = None
    stdout_hash: str | None = None
    stderr_hash: str | None = None
    stdout_log_path: str | None = None
    stderr_log_path: str | None = None
    artifact_refs: tuple[str, ...] = ()
    runtime_version: str | None = None
    exit_code: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error_code: str | None = None
    # Issue 122: skill script receipts bind the executed skill identity and
    # the authorization basis the device accepted (AC3). All four stay None
    # for every other capability.
    skill_id: str | None = None
    skill_version: int | None = None
    skill_content_hash: str | None = None
    authorization_basis: str | None = None

    @property
    def request_hash(self) -> str:
        """Protocol name for the M7-compatible payload hash."""
        return self.payload_hash

    def as_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "task_id": self.task_id,
            "capability": self.capability,
            "policy_decision": self.policy_decision,
            "status": self.status,
            "payload_hash": self.payload_hash,
            "request_hash": self.request_hash,
            "result_hash": self.result_hash,
            "policy_version": self.policy_version,
            "consent_decision": self.consent_decision,
            "stdout_hash": self.stdout_hash,
            "stderr_hash": self.stderr_hash,
            "artifact_refs": list(self.artifact_refs),
            "runtime_version": self.runtime_version,
            "exit_code": self.exit_code,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "error_code": self.error_code,
            "skill_id": self.skill_id,
            "skill_version": self.skill_version,
            "skill_content_hash": self.skill_content_hash,
            "authorization_basis": self.authorization_basis,
        }

    def cleanup_local_logs(self) -> None:
        """Remove local full-output files after the receipt is archived."""
        for log_path in (self.stdout_log_path, self.stderr_log_path):
            if log_path:
                Path(log_path).unlink(missing_ok=True)


def content_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def safe_logical_target(payload: dict[str, Any]) -> str:
    """Keep logical paths only; arbitrary physical or malformed input is hashed."""
    arguments = payload.get('arguments', payload.get('args', payload))
    value = arguments.get('path') if isinstance(arguments, dict) else None
    if (isinstance(value, str) and re.match(r'^/workspace/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:/|$)', value) and len(value) <= 1024
            and not any(character in value for character in ('\\', ':', '\x00'))
            and '..' not in value.split('/')):
        return value
    return 'sha256:' + content_hash(value)
