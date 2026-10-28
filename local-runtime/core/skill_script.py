"""Device-leg Skill script execution behind content-bound local grants (#122).

The unique Runtime is the only path a Skill script may take onto this device.
A ``local.skill.script`` task carries the exact script bytes of one frozen
Skill version plus the version's declared execution environment; before
anything runs the device re-derives every fact locally:

1. the bytes must hash to the announced ``script_sha256`` (tamper refuses as
   ``SKILL_SCRIPT_CONTENT_MISMATCH``);
2. the frozen declaration must target ``user_device`` — a Server-declared
   Skill never downgrades onto the device (``SKILL_SCRIPT_ENVIRONMENT_MISMATCH``);
3. the declared ``os`` requirements must match this machine, otherwise the
   execution is explicitly unavailable (``SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE``);
4. local policy decides first: a configured DENY wins over every grant,
   directory grant, sharing status, or built-in identity (AC3);
5. scripts are OFF by default. Execution needs either an exact content-bound
   grant remembered in the binding-scoped registry, or a fresh consent. A
   changed script or a changed declared scope is a different grant identity
   (re-authorization), while a prose-only SKILL.md change with identical
   bytes and declaration stays covered (AC2).

The registry stores device-local display facts only, keyed by the profile
binding like every other registry: another account never inherits a grant,
and another device never had one. Receipts bind the skill version, content
digest, and the authorization basis (AC3).
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .consent import ConsentStore, request_hash
from .policy import LocalPolicy, PolicyDecision

# Frozen cross-repo contract (server backend/app/agentplatform/resources/
# skill_environment.py): the same bounded declaration shape, the same
# fingerprint algorithm, and the same fixed decision categories on both legs.
EXECUTION_ENVIRONMENT_KEY = "execution-environment"
SCRIPT_TARGETS = ("server", "user_device")
DECLARATION_FIELDS = ("os", "dependencies", "software", "tools", "data")
MAX_DECLARATION_ENTRIES = 16
MAX_ENTRY_CHARS = 128
_SCRIPTS_DIR = "scripts"
_OS_PLATFORMS = ("windows", "linux", "darwin")

APPROVAL_REQUIRED = "SCRIPT_APPROVAL_REQUIRED"
REAUTHORIZATION_REQUIRED = "SCRIPT_REAUTHORIZATION_REQUIRED"
AUTHORIZATION_REVOKED = "SCRIPT_AUTHORIZATION_REVOKED"
GRANTED = "granted"

#: The one capability the device announces for Skill scripts.
SKILL_SCRIPT_CAPABILITIES = ("local.skill.script",)

MAX_SCRIPT_CHARS = 200_000
MAX_SCRIPT_PATH_CHARS = 512

#: Fixed execution timeout; no payload can move it (the wire shape has no
#: timeout field by design).
SKILL_SCRIPT_TIMEOUT_SECONDS = 120.0

_SKILL_ID_PATTERN = re.compile(r"^[0-9a-fA-F-]{1,64}$")
_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class SkillScriptError(RuntimeError):
    """A fixed-category skill-script failure; safe to surface as an error code."""


def category_for(error: BaseException) -> str:
    """Map device-side failures onto the fixed skill-script categories."""
    if isinstance(error, SkillScriptError):
        return str(error)
    return "SKILL_SCRIPT_FAILED"


def _refuse(message: str) -> SkillScriptError:
    return SkillScriptError(message)


def parse_execution_environment(raw: Any) -> dict | None:
    """The device-side mirror of the platform's declaration parser."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
    if set(raw) - {"target", *DECLARATION_FIELDS}:
        raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
    target = raw.get("target")
    if not isinstance(target, str) or target not in SCRIPT_TARGETS:
        raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
    declaration: dict = {"target": target}
    for field in DECLARATION_FIELDS:
        entries_raw = raw.get(field)
        if entries_raw is None:
            entries = []
        elif not isinstance(entries_raw, list) or len(entries_raw) > MAX_DECLARATION_ENTRIES:
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
        else:
            entries = []
            for item in entries_raw:
                if not isinstance(item, str):
                    raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
                value = " ".join(item.split())
                if not value or len(value) > MAX_ENTRY_CHARS:
                    raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
                entries.append(value)
        if field == "os":
            entries = sorted({entry.lower() for entry in entries})
        declaration[field] = entries
    return declaration


def requirements_fingerprint(declaration: dict | None) -> str:
    """The canonical scope identity; the same bytes as the server computes."""
    normalized = declaration or {}
    payload: dict = {"target": None}
    payload.update({field: [] for field in DECLARATION_FIELDS})
    payload.update({key: normalized[key] for key in payload if key in normalized})
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def os_matches(declared_os: list[str], current_system: str) -> bool:
    if not declared_os:
        return True
    current = str(current_system or "").lower()
    return any(
        current.startswith(entry.lower())
        for entry in declared_os
        if any(entry.lower().startswith(platform) for platform in _OS_PLATFORMS)
    )


def normalize_script_path(raw: Any) -> str:
    if not isinstance(raw, str) or not raw or len(raw) > MAX_SCRIPT_PATH_CHARS or "\x00" in raw:
        raise _refuse("SKILL_SCRIPT_INVALID")
    parts = raw.split("/")
    if (
        "/" != raw[:1]
        and "\\" not in raw
        and ".." not in parts
        and len(parts) >= 2
        and parts[0] == _SCRIPTS_DIR
        and all(part for part in parts)
        and raw == "/".join(parts)
    ):
        return raw
    raise _refuse("SKILL_SCRIPT_INVALID")


def validate_payload(payload: Any) -> dict:
    """The fixed wire shape of one ``local.skill.script`` task.

    The skill fields are all required; the only tolerated extras are the
    transport's own envelope fields (operation/run_id/tool_call_id/thread_id)
    which every capability's payload carries. Anything else refuses exactly
    like a missing field: the gate is a fixed key set.
    """
    required = {
        "skill_id", "script_path", "script_sha256", "skill_version",
        "skill_content_hash", "script", "declaration",
    }
    transport_fields = {"operation", "run_id", "tool_call_id", "thread_id"}
    if not isinstance(payload, dict) or not required.issubset(payload) or set(payload) - required - transport_fields:
        raise _refuse("SKILL_SCRIPT_INVALID")
    for field in ("skill_id", "script_path", "script_sha256", "skill_content_hash", "script"):
        if not isinstance(payload.get(field), str):
            raise _refuse("SKILL_SCRIPT_INVALID")
    version = payload.get("skill_version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise _refuse("SKILL_SCRIPT_INVALID")
    if not payload["skill_id"] or len(payload["skill_id"]) > 64:
        raise _refuse("SKILL_SCRIPT_INVALID")
    if not _HASH_PATTERN.fullmatch(payload["script_sha256"]) or not _HASH_PATTERN.fullmatch(payload["skill_content_hash"]):
        raise _refuse("SKILL_SCRIPT_INVALID")
    if len(payload["script"]) > MAX_SCRIPT_CHARS:
        raise _refuse("SKILL_SCRIPT_TOO_LARGE")
    if normalize_script_path(payload["script_path"]) != payload["script_path"]:
        raise _refuse("SKILL_SCRIPT_INVALID")
    return payload


@dataclass(frozen=True)
class SkillScriptDecision:
    """What the device decided about one script execution request."""

    decision: PolicyDecision
    value: Any = None
    #: The authorization basis when execution rode a stored grant or policy.
    basis: str | None = None
    #: Set when a stored grant exists but no longer matches (AC2 evidence).
    grant_state: str = ""
    #: The completed receipt for an ALLOW decision that already executed.
    receipt: Any = None


class SkillScriptRegistry:
    """Binding-scoped device grants for exact Skill script contents.

    Rows are display facts keyed by the profile binding, like every device
    registry: a grant made by one account can never surface for another, and
    the identity hash binds the exact script bytes plus the declared scope.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS skill_script_grants (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    resource_id TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL DEFAULT '',
                    script_path TEXT NOT NULL, script_sha256 TEXT NOT NULL,
                    requirements_hash TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "SKILL_SCRIPT_STORAGE_UNAVAILABLE"

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
                self._error = "SKILL_SCRIPT_STORAGE_UNAVAILABLE"
                raise SkillScriptError(self._error) from exc

    @staticmethod
    def _identity(binding, resource_id: str, script_path: str, script_sha256: str, requirements_hash: str) -> str:
        payload = [json.dumps(binding, sort_keys=True), resource_id, script_path, script_sha256, requirements_hash]
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(encoded.encode()).hexdigest()

    def remember(self, binding, row: dict[str, Any]) -> str:
        """Grant (or re-grant) one exact content/scope binding; returns its identity."""
        resource_id = str(row.get("resource_id", ""))[:64]
        script_path = str(row.get("script_path", ""))[:MAX_SCRIPT_PATH_CHARS]
        script_digest = str(row.get("script_sha256", ""))[:64]
        requirements_hash = str(row.get("requirements_hash", ""))[:64]
        identity = self._identity(binding, resource_id, script_path, script_digest, requirements_hash)
        fields = (
            identity,
            json.dumps(binding, sort_keys=True),
            resource_id,
            str(row.get("slug", ""))[:128],
            int(row.get("version", 0) or 0),
            str(row.get("content_hash", ""))[:64],
            script_path,
            script_digest,
            requirements_hash,
            "granted",
        )

        def write(db):
            db.execute(
                "INSERT OR REPLACE INTO skill_script_grants (identity, binding, resource_id, slug, version,"
                " content_hash, script_path, script_sha256, requirements_hash, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
                fields,
            )
            # A superseded binding (older bytes/scope for the same path) is no
            # longer a grant; only the exact identity stays.
            db.execute(
                "DELETE FROM skill_script_grants WHERE binding=? AND resource_id=? AND script_path=? AND identity<>?",
                (fields[1], resource_id, script_path, identity),
            )
            return identity

        return self._execute(write)

    def status(self, binding, resource_id: str, script_path: str, script_sha256: str, requirements_hash: str) -> str:
        """``granted``, ``revoked`` (nothing here revokes to a tombstone today), or ``absent``."""

        def read(db):
            row = db.execute(
                "SELECT status FROM skill_script_grants WHERE binding=? AND resource_id=? AND script_path=?"
                " AND script_sha256=? AND requirements_hash=?",
                (json.dumps(binding, sort_keys=True), resource_id, script_path, script_sha256, requirements_hash),
            ).fetchone()
            return dict(row) if row is not None else None

        row = self._execute(read)
        if row is None:
            return "absent"
        return "granted" if row["status"] == "granted" else "absent"

    def grant_state(self, binding, resource_id: str, script_path: str) -> dict[str, Any] | None:
        """The live binding row for one path regardless of content, for re-auth evidence."""

        def read(db):
            row = db.execute(
                "SELECT identity, script_sha256, requirements_hash, status FROM skill_script_grants"
                " WHERE binding=? AND resource_id=? AND script_path=?",
                (json.dumps(binding, sort_keys=True), resource_id, script_path),
            ).fetchone()
            return dict(row) if row is not None else None

        return self._execute(read)

    def revoke(self, binding, resource_id: str, script_path: str) -> bool:
        """Revoke one path's grant for this binding; later asks need new consent."""

        def write(db):
            cursor = db.execute(
                "DELETE FROM skill_script_grants WHERE binding=? AND resource_id=? AND script_path=?",
                (json.dumps(binding, sort_keys=True), resource_id, script_path),
            )
            return cursor.rowcount > 0

        return self._execute(write)

    def revoke_identity(self, binding, identity: str) -> bool:
        """Revoke by the grant identity the UI lists; never another account's."""

        def write(db):
            cursor = db.execute(
                "DELETE FROM skill_script_grants WHERE binding=? AND identity=?",
                (json.dumps(binding, sort_keys=True), str(identity)[:128]),
            )
            return cursor.rowcount > 0

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {
            "id": row["identity"], "resourceId": row["resource_id"], "slug": row["slug"],
            "version": row["version"], "contentHash": row["content_hash"], "scriptPath": row["script_path"],
            "scriptSha256": row["script_sha256"], "requirementsHash": row["requirements_hash"],
            "status": row["status"], "createdAt": row["created_at"],
        }

    def view(self, binding, limit: int = 20) -> list[dict[str, Any]]:
        """Rows for the current identity only; another account never inherits them."""

        def read(db):
            rows = db.execute(
                "SELECT * FROM skill_script_grants WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                (json.dumps(binding, sort_keys=True), int(limit)),
            ).fetchall()
            return [self._view(row) for row in rows]

        return self._execute(read)


class SkillScriptService:
    """Policy-first, grant-or-consent facade around one constrained script run."""

    def __init__(
        self,
        registry: SkillScriptRegistry,
        *,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
        executor=None,
        current_system: str | None = None,
    ) -> None:
        self.registry = registry
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()
        self._executor = executor
        self._current_system = current_system

    def _system(self) -> str:
        if self._current_system is not None:
            return self._current_system
        if sys.platform.startswith("win"):
            return "windows"
        if sys.platform.startswith("linux"):
            return "linux"
        return "darwin"

    def binding(self, owner: dict | None) -> dict:
        """The profile binding rows key on; None when not authenticated."""
        return owner or {}

    def remember_grant(self, binding, payload: dict[str, Any]) -> str:
        """Persist the exact content/scope binding a user just approved.

        The declared scope is re-derived from the payload so the stored
        fingerprint can only describe the bytes the user actually saw.
        """
        payload = validate_payload(payload)
        declaration = parse_execution_environment(payload["declaration"])
        if declaration is None or declaration["target"] != "user_device":
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_MISMATCH")
        digest = hashlib.sha256(payload["script"].encode("utf-8")).hexdigest()
        if digest != payload["script_sha256"]:
            raise _refuse("SKILL_SCRIPT_CONTENT_MISMATCH")
        return self.registry.remember(binding, {
            "resource_id": payload["skill_id"],
            "slug": "",
            "version": payload["skill_version"],
            "content_hash": payload["skill_content_hash"],
            "script_path": payload["script_path"],
            "script_sha256": payload["script_sha256"],
            "requirements_hash": requirements_fingerprint(declaration),
        })

    def evaluate(self, binding, payload: dict[str, Any]) -> tuple[SkillScriptDecision, dict]:
        """Validate, check environment and policy, then grant or ask.

        Returns the decision plus the normalized declaration (for the
        executor and the consent summary). Fixed refusals raise
        :class:`SkillScriptError`; policy denials return a DENY decision so
        the caller reports a local policy refusal, not a crash.
        """
        payload = validate_payload(payload)
        digest = hashlib.sha256(payload["script"].encode("utf-8")).hexdigest()
        if digest != payload["script_sha256"]:
            raise _refuse("SKILL_SCRIPT_CONTENT_MISMATCH")
        declaration = parse_execution_environment(payload["declaration"])
        if declaration is None:
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_INVALID")
        if declaration["target"] != "user_device":
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_MISMATCH")
        if not os_matches(declaration["os"], self._system()):
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE")

        # Local policy is the first and final authority on this device: a
        # DENY (explicitly configured, or anything graded Level 2) outranks
        # every stored grant, directory grant, sharing status, or built-in
        # identity (AC3).
        decision = self.policy.authorize("local.skill.script", payload)
        if decision is PolicyDecision.DENY:
            return SkillScriptDecision(decision, grant_state="policy_denied"), declaration
        if decision is PolicyDecision.ALLOW:
            return SkillScriptDecision(decision, basis="policy"), declaration

        requirements_hash = requirements_fingerprint(declaration)
        resource_id = payload["skill_id"]
        stored = self.registry.grant_state(binding, resource_id, payload["script_path"])
        if stored is not None and stored["status"] == "granted":
            if stored["script_sha256"] == payload["script_sha256"] and stored["requirements_hash"] == requirements_hash:
                return (
                    SkillScriptDecision(PolicyDecision.ALLOW, basis=f"skill_script_grant:{stored['identity']}"),
                    declaration,
                )
            # Content or scope changed: the old grant never carries over (AC2).
            return (
                SkillScriptDecision(PolicyDecision.CONSENT_REQUIRED, grant_state=REAUTHORIZATION_REQUIRED),
                declaration,
            )
        return SkillScriptDecision(PolicyDecision.CONSENT_REQUIRED, grant_state=APPROVAL_REQUIRED), declaration

    async def execute(
        self,
        payload: dict[str, Any],
        *,
        consent: bool = False,
        authorization_basis: str | None = None,
    ) -> SkillScriptDecision:
        """The consented execution path (transport dispatch or consent settle).

        The script runs through the unique Runtime's own constrained Python
        executor — suspended start, job-owned cleanup on Windows, bounded
        output — with a fixed timeout that no payload can move.
        """
        payload = validate_payload(payload)
        digest = hashlib.sha256(payload["script"].encode("utf-8")).hexdigest()
        if digest != payload["script_sha256"]:
            raise _refuse("SKILL_SCRIPT_CONTENT_MISMATCH")
        decision = self.policy.authorize("local.skill.script", payload, consent=consent)
        if decision is not PolicyDecision.ALLOW:
            return SkillScriptDecision(decision)
        declaration = parse_execution_environment(payload["declaration"])
        if declaration is None or declaration["target"] != "user_device":
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_MISMATCH")
        if not os_matches(declaration["os"], self._system()):
            raise _refuse("SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE")
        executor = self._executor
        if executor is None:
            from .python import PythonExecutor

            executor = PythonExecutor()
        from .python import PythonResult  # noqa: F401 - documents the contract
        from .receipts import LocalExecutionReceipt, content_hash

        workdir = tempfile.mkdtemp(prefix="skill-script-")
        try:
            result = await executor.run(
                payload["script"],
                working_root=Path(workdir),
                timeout=SKILL_SCRIPT_TIMEOUT_SECONDS,
            )
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        receipt = LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id=str(payload.get("task_id", "")),
            capability="local.skill.script",
            policy_decision=PolicyDecision.ALLOW.value,
            status=result.status.value,
            payload_hash=request_hash(payload),
            result_hash=content_hash({
                "status": result.status.value,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }),
            consent_decision=authorization_basis,
            stdout_hash=result.stdout_hash,
            stderr_hash=result.stderr_hash,
            runtime_version=result.runtime_version,
            exit_code=result.exit_code,
            started_at=result.started_at,
            finished_at=result.finished_at,
            skill_id=payload["skill_id"],
            skill_version=payload["skill_version"],
            skill_content_hash=payload["skill_content_hash"],
            authorization_basis=authorization_basis,
        )
        value = {
            "status": result.status.value,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "skill_id": payload["skill_id"],
            "skill_version": payload["skill_version"],
            "skill_content_hash": payload["skill_content_hash"],
            "script_path": payload["script_path"],
            "authorization_basis": authorization_basis or "",
        }
        return SkillScriptDecision(PolicyDecision.ALLOW, value=value, basis=authorization_basis, receipt=receipt)
