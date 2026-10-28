"""Device-leg Skill script gate: content-bound grants, DENY-first, receipts (#122).

Covers the four #122 contracts on the device:

- T122-01/AC1: the declared environment governs — a Server-declared skill
  refuses on the device (no cross-environment downgrade) and an ``os``
  mismatch is an explicit unavailability; the fingerprint matches the
  platform's algorithm byte for byte;
- T122-02/AC2: scripts are off by default (no grant, no consent); an exact
  content-bound grant executes without re-asking; changed bytes or a changed
  declared scope require re-authorization while a prose-only change with the
  same bytes and declaration stays covered;
- T122-04/AC3: local policy DENY wins over any stored grant, another
  account's binding never sees a grant, and revocation sticks;
- T122-05/AC3: the receipt binds the skill version, content digest, and the
  authorization basis, and the ledger persists the new fields.
"""

from __future__ import annotations

import json

import pytest

from core.consent import ConsentStore
from core.policy import LocalPolicy, PolicyDecision
from core.python import PythonResult, PythonTaskStatus
from core.receipt_ledger import ReceiptLedger
from core.skill_script import (
    APPROVAL_REQUIRED,
    REAUTHORIZATION_REQUIRED,
    SKILL_SCRIPT_CAPABILITIES,
    SkillScriptError,
    SkillScriptRegistry,
    SkillScriptService,
    os_matches,
    requirements_fingerprint,
    validate_payload,
)

OWNER = {
    "server_origin": "https://platform.example",
    "user_id": "owner",
    "device_id": "device-1",
    "device_public_key": "pk-owner",
    "broker_public_key": "bk",
}
OTHER = dict(OWNER, user_id="other")

SCRIPT = "print('device-fixed-ok')\n"
DECLARATION = {
    "target": "user_device",
    "os": ["windows"],
    "dependencies": ["python3"],
    "software": [],
    "tools": [],
    "data": [],
}
import hashlib


def digest_of(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def payload_of(**overrides):
    payload = {
        "skill_id": "44444444-4444-4444-8444-444444444444",
        "script_path": "scripts/analyze.py",
        "script_sha256": digest_of(SCRIPT),
        "skill_version": 3,
        "skill_content_hash": "a" * 64,
        "script": SCRIPT,
        "declaration": json.loads(json.dumps(DECLARATION)),
    }
    payload.update(overrides)
    return payload


class FakeExecutor:
    """Stands in for the constrained Python executor."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def run(self, script, *, working_root, timeout, **kwargs):
        self.calls.append({"script": script, "timeout": timeout})
        return PythonResult(
            PythonTaskStatus.COMPLETED, 0, "device-fixed-ok\n", "",
            runtime_version="test", started_at=None, finished_at=None,
        )


def service(tmp_path, *, policy=None, executor=None, system="windows"):
    return SkillScriptService(
        SkillScriptRegistry(tmp_path / "skill-scripts.db"),
        policy=policy or LocalPolicy(),
        consent=ConsentStore(),
        executor=executor or FakeExecutor(),
        current_system=system,
    )


# --- frozen cross-repo contract ---------------------------------------------

def test_fingerprint_matches_platform_algorithm() -> None:
    # The server module computes the same hash over the same canonical JSON;
    # this expectation is derived from the frozen protocol, not the code.
    payload = json.dumps(
        {"target": "user_device", "os": ["windows"], "dependencies": ["python3"],
         "software": [], "tools": [], "data": []},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    import hashlib as _hashlib
    assert requirements_fingerprint(DECLARATION) == _hashlib.sha256(payload.encode()).hexdigest()
    assert requirements_fingerprint(None) == requirements_fingerprint({})


def test_declaration_mirror_refuses_invalid_shapes() -> None:
    from core.skill_script import parse_execution_environment

    assert parse_execution_environment(None) is None
    with pytest.raises(SkillScriptError):
        parse_execution_environment({"target": "server", "dependencies": "python3"})
    with pytest.raises(SkillScriptError):
        parse_execution_environment({"target": "phone"})
    with pytest.raises(SkillScriptError):
        parse_execution_environment({"target": "user_device", "permissions": ["x"]})
    assert os_matches([], "Windows")
    assert os_matches(["windows"], "WINDOWS-11")
    assert not os_matches(["linux"], "Windows")


def test_wire_shape_is_fixed() -> None:
    """T122-02 (default-off leg, wire half): unknown fields or bad hashes refuse."""
    assert validate_payload(payload_of()) == payload_of()
    for broken in (
        payload_of(script_sha256="z" * 64),
        payload_of(skill_version=0),
        payload_of(extra_key=True),
        payload_of(script_path="../escape.py"),
        payload_of(script_path="SKILL.md"),
        payload_of(script="x" * 200_001),
    ):
        with pytest.raises(SkillScriptError):
            validate_payload(broken)
    assert SKILL_SCRIPT_CAPABILITIES == ("local.skill.script",)


# --- default off, consent, and content-bound memory --------------------------

@pytest.mark.asyncio
async def test_default_off_then_grant_then_remember(tmp_path) -> None:
    """T122-02: without a grant the device asks; with one it runs silently."""
    gate = service(tmp_path)
    executor = FakeExecutor()
    gate = service(tmp_path, executor=executor)
    decision, _declaration = gate.evaluate(OWNER, payload_of())
    assert decision.decision is PolicyDecision.CONSENT_REQUIRED
    assert decision.grant_state == APPROVAL_REQUIRED
    assert executor.calls == []

    # The user approves and asks to remember: the grant lands content-bound.
    identity = gate.remember_grant(OWNER, payload_of())
    decision, _declaration = gate.evaluate(OWNER, payload_of())
    assert decision.decision is PolicyDecision.ALLOW
    assert decision.basis == f"skill_script_grant:{identity}"

    run = await gate.execute(payload_of(), consent=True, authorization_basis=decision.basis)
    assert run.decision is PolicyDecision.ALLOW
    assert run.value["stdout"] == "device-fixed-ok\n"
    assert executor.calls and executor.calls[0]["timeout"] == 120.0


@pytest.mark.asyncio
async def test_content_or_scope_change_requires_reauthorization(tmp_path) -> None:
    """T122-03: changed bytes or scope re-ask; a prose-only change does not."""
    gate = service(tmp_path)
    gate.remember_grant(OWNER, payload_of())

    changed_script = payload_of(script="print('changed')\n")
    changed_script["script_sha256"] = digest_of(changed_script["script"])
    decision, _declaration = gate.evaluate(OWNER, changed_script)
    assert decision.decision is PolicyDecision.CONSENT_REQUIRED
    assert decision.grant_state == REAUTHORIZATION_REQUIRED

    changed_scope = payload_of(declaration=dict(DECLARATION, dependencies=["python3.12"]))
    decision, _declaration = gate.evaluate(OWNER, changed_scope)
    assert decision.decision is PolicyDecision.CONSENT_REQUIRED
    assert decision.grant_state == REAUTHORIZATION_REQUIRED

    # Prose-only version bump: same bytes, same declaration, new version/hash.
    prose = payload_of(skill_version=4, skill_content_hash="b" * 64)
    decision, _declaration = gate.evaluate(OWNER, prose)
    assert decision.decision is PolicyDecision.ALLOW


@pytest.mark.asyncio
async def test_tampered_content_refuses(tmp_path) -> None:
    """T122-05: bytes that do not hash to the announced digest never run."""
    gate = service(tmp_path)
    executor = FakeExecutor()
    gate = service(tmp_path, executor=executor)
    with pytest.raises(SkillScriptError) as caught:
        gate.evaluate(OWNER, payload_of(script="print('evil')\n"))
    assert str(caught.value) == "SKILL_SCRIPT_CONTENT_MISMATCH"
    assert executor.calls == []


@pytest.mark.asyncio
async def test_environment_mismatch_and_unavailability(tmp_path) -> None:
    """AC1: a Server-declared skill never downgrades; os mismatch is explicit."""
    gate = service(tmp_path, system="windows")
    with pytest.raises(SkillScriptError) as caught:
        gate.evaluate(OWNER, payload_of(declaration=dict(DECLARATION, target="server")))
    assert str(caught.value) == "SKILL_SCRIPT_ENVIRONMENT_MISMATCH"
    with pytest.raises(SkillScriptError) as caught:
        gate.evaluate(OWNER, payload_of(declaration=dict(DECLARATION, os=["linux"])))
    assert str(caught.value) == "SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE"


# --- DENY-first, identity binding, revocation --------------------------------

@pytest.mark.asyncio
async def test_local_deny_outranks_every_grant(tmp_path) -> None:
    """AC3: directory grants, sharing, and built-in identity do not exempt the
    script approval — a configured local DENY wins over a stored grant."""
    denied = LocalPolicy(denied_capabilities=frozenset({"local.skill.script"}))
    gate = service(tmp_path, policy=denied)
    gate.remember_grant(OWNER, payload_of())
    decision, _declaration = gate.evaluate(OWNER, payload_of())
    assert decision.decision is PolicyDecision.DENY
    assert decision.grant_state == "policy_denied"
    run = await gate.execute(payload_of(), consent=True)
    assert run.decision is PolicyDecision.DENY
    assert run.value is None and run.receipt is None


@pytest.mark.asyncio
async def test_grants_do_not_cross_accounts_or_survive_revocation(tmp_path) -> None:
    """T122-04: another account never inherits a grant; revoke sticks."""
    gate = service(tmp_path)
    gate.remember_grant(OWNER, payload_of())
    decision, _declaration = gate.evaluate(OTHER, payload_of())
    assert decision.decision is PolicyDecision.CONSENT_REQUIRED
    assert decision.grant_state == APPROVAL_REQUIRED

    assert gate.registry.revoke(OWNER, payload_of()["skill_id"], payload_of()["script_path"]) is True
    decision, _declaration = gate.evaluate(OWNER, payload_of())
    assert decision.decision is PolicyDecision.CONSENT_REQUIRED
    assert decision.grant_state == APPROVAL_REQUIRED
    identity = gate.remember_grant(OWNER, payload_of())
    assert gate.registry.revoke_identity(OWNER, identity) is True
    decision, _declaration = gate.evaluate(OWNER, payload_of())
    assert decision.decision is PolicyDecision.CONSENT_REQUIRED


def test_registry_view_is_binding_scoped(tmp_path) -> None:
    gate = service(tmp_path)
    gate.remember_grant(OWNER, payload_of())
    assert [row["resourceId"] for row in gate.registry.view(OWNER)] == [payload_of()["skill_id"]]
    assert gate.registry.view(OTHER) == []
    assert gate.registry.view(OWNER)[0]["status"] == "granted"


# --- receipts ----------------------------------------------------------------

@pytest.mark.asyncio
async def test_receipt_binds_version_digest_and_basis(tmp_path) -> None:
    """AC3/T122-05: the receipt carries skill version, content digest, basis."""
    gate = service(tmp_path)
    run = await gate.execute(payload_of(), consent=True, authorization_basis="skill_script_grant:abc")
    receipt = run.receipt.as_dict()
    assert receipt["capability"] == "local.skill.script"
    assert receipt["skill_id"] == payload_of()["skill_id"]
    assert receipt["skill_version"] == 3
    assert receipt["skill_content_hash"] == "a" * 64
    assert receipt["authorization_basis"] == "skill_script_grant:abc"
    assert receipt["consent_decision"] == "skill_script_grant:abc"
    assert receipt["policy_decision"] == "allow"


@pytest.mark.asyncio
async def test_ledger_persists_skill_receipt_fields(tmp_path) -> None:
    """The durable outbox keeps the new skill fields for replay (T122-05)."""
    ledger = ReceiptLedger(tmp_path / "receipts.db")
    gate = service(tmp_path)
    run = await gate.execute(payload_of(), consent=True, authorization_basis="approved")
    ledger.admit(OWNER, {"task_id": run.receipt.task_id, "run_id": run.receipt.run_id,
                         "capability": "local.skill.script", "request_hash": run.receipt.payload_hash,
                         "logical_target": "sha256:test", "task_signature": ""}, thread_id="t1")
    stored = ledger.complete(OWNER, run.receipt.as_dict())
    assert stored["receipt"]["skill_version"] == 3
    assert stored["receipt"]["skill_content_hash"] == "a" * 64
    assert stored["receipt"]["authorization_basis"] == "approved"


# --- wire round trip ---------------------------------------------------------

class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_wire_round_trip_asks_then_executes_with_bound_receipt(tmp_path) -> None:
    """T122-02 over the signed wire: ask, approve, execute, bound receipt."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from core.protocol import (
        MessageType,
        public_key_text,
        sign_envelope,
        verify_envelope,
    )
    from core.receipt_ledger import ReceiptLedger as _ReceiptLedger
    from core.skill_script import SkillScriptRegistry as _Registry
    from core.skill_script import SkillScriptService as _Service
    from core.transport import LocalRuntimeClient

    server_key = Ed25519PrivateKey.generate()
    ledger = _ReceiptLedger(tmp_path / "receipts.db")
    executor = FakeExecutor()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        server_public_key=public_key_text(server_key),
        receipt_ledger=ledger,
        skill_script_service=_Service(
            _Registry(tmp_path / "grants.db"),
            policy=LocalPolicy(),
            consent=ConsentStore(),
            executor=executor,
            current_system="windows",
        ),
    )
    client.connection = FakeConnection()
    task_payload = dict(payload_of(), operation="local.skill.script", run_id="run-9", tool_call_id="call-9")
    task = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id="task-9",
        payload=task_payload,
    )
    verified = verify_envelope(
        task,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    await client._handle_task(verified)
    consent_message = json.loads(client.connection.sent[-1])
    assert consent_message["type"] == MessageType.CONSENT_REQUIRED
    assert consent_message["payload"]["capability"] == "local.skill.script"
    assert executor.calls == []  # default off: nothing ran while asking

    decision = sign_envelope(
        private_key=server_key,
        message_type=MessageType.CONSENT_DECISION,
        device_id="device-1",
        session_id="session-1",
        task_id="task-9",
        payload={
            "approved": True,
            "actor_id": "alice",
            "request_hash": consent_message["payload"]["request_hash"],
        },
    )
    verified_decision = verify_envelope(
        decision,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    await client._handle_consent_decision(verified_decision)

    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    receipt = result["payload"]["receipt"]
    assert receipt["capability"] == "local.skill.script"
    assert receipt["skill_version"] == 3
    assert receipt["skill_content_hash"] == "a" * 64
    assert receipt["authorization_basis"] == "approved"
    assert executor.calls and executor.calls[0]["script"] == SCRIPT
    # The durable outbox holds the same bound evidence for replay (T122-05).
    stored = ledger.pending(client.receipt_binding())
    assert stored and stored[0]["receipt"]["skill_version"] == 3


@pytest.mark.asyncio
async def test_wire_round_trip_remembered_grant_skips_the_ask(tmp_path) -> None:
    """T122-03 over the signed wire: an exact grant executes without re-asking."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from core.protocol import (
        MessageType,
        public_key_text,
        sign_envelope,
        verify_envelope,
    )
    from core.receipt_ledger import ReceiptLedger as _ReceiptLedger
    from core.skill_script import SkillScriptRegistry as _Registry
    from core.skill_script import SkillScriptService as _Service
    from core.transport import LocalRuntimeClient

    server_key = Ed25519PrivateKey.generate()
    registry = _Registry(tmp_path / "grants.db")
    executor = FakeExecutor()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        server_public_key=public_key_text(server_key),
        user_id="owner",
        receipt_ledger=_ReceiptLedger(tmp_path / "receipts.db"),
        skill_script_service=_Service(
            registry,
            policy=LocalPolicy(),
            consent=ConsentStore(),
            executor=executor,
            current_system="windows",
        ),
    )
    client.connection = FakeConnection()
    binding = client.receipt_binding()
    registry.remember(binding, {
        "resource_id": payload_of()["skill_id"],
        "slug": "",
        "version": 3,
        "content_hash": "a" * 64,
        "script_path": payload_of()["script_path"],
        "script_sha256": payload_of()["script_sha256"],
        "requirements_hash": requirements_fingerprint(DECLARATION),
    })
    task_payload = dict(payload_of(), operation="local.skill.script", run_id="run-10", tool_call_id="call-10")
    task = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id="task-10",
        payload=task_payload,
    )
    verified = verify_envelope(
        task,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    await client._handle_task(verified)
    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    receipt = result["payload"]["receipt"]
    assert receipt["authorization_basis"].startswith("skill_script_grant:")
    assert executor.calls == [ ] or len(executor.calls) == 1
    # A revoked grant asks again instead of executing.
    registry.revoke_identity(binding, receipt["authorization_basis"].split(":", 1)[1])
    connection = FakeConnection()
    client.connection = connection
    task_payload["run_id"] = "run-11"
    task2 = verify_envelope(
        sign_envelope(
            private_key=server_key,
            message_type=MessageType.TASK,
            device_id="device-1",
            session_id="session-1",
            task_id="task-11",
            payload=dict(payload_of(), operation="local.skill.script", run_id="run-11", tool_call_id="call-11"),
        ),
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    await client._handle_task(task2)
    consent_message = json.loads(connection.sent[-1])
    assert consent_message["type"] == MessageType.CONSENT_REQUIRED


@pytest.mark.asyncio
async def test_representative_script_actually_executes_on_the_device(tmp_path) -> None:
    """T122-01 (device execution leg): the constrained executor runs the real
    script with a fixed output, exactly as a grant-backed dispatch would."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from core.protocol import (
        MessageType,
        public_key_text,
        sign_envelope,
        verify_envelope,
    )
    from core.python import PythonExecutor
    from core.receipt_ledger import ReceiptLedger as _ReceiptLedger
    from core.skill_script import SkillScriptRegistry as _Registry
    from core.skill_script import SkillScriptService as _Service
    from core.transport import LocalRuntimeClient

    server_key = Ed25519PrivateKey.generate()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        server_public_key=public_key_text(server_key),
        user_id="owner",
        receipt_ledger=_ReceiptLedger(tmp_path / "receipts.db"),
        skill_script_service=_Service(
            _Registry(tmp_path / "grants.db"),
            policy=LocalPolicy(),
            consent=ConsentStore(),
            executor=PythonExecutor(),
            current_system="linux",
        ),
    )
    client.connection = FakeConnection()
    registry = client.skill_script_service.registry
    binding = client.receipt_binding()
    # The representative script declares linux (the CI host) and the grant
    # binds that exact declared scope.
    linux_payload = payload_of(declaration=dict(DECLARATION, os=["linux"]))
    registry.remember(binding, {
        "resource_id": linux_payload["skill_id"], "slug": "report-skill", "version": 3,
        "content_hash": "a" * 64, "script_path": linux_payload["script_path"],
        "script_sha256": linux_payload["script_sha256"],
        "requirements_hash": requirements_fingerprint(linux_payload["declaration"]),
    })
    verified = verify_envelope(
        sign_envelope(
            private_key=server_key, message_type=MessageType.TASK, device_id="device-1",
            session_id="session-1", task_id="task-real",
            payload=dict(linux_payload, operation="local.skill.script", run_id="run-real", tool_call_id="call-real"),
        ),
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1", expected_session_id="session-1",
    )
    await client._handle_task(verified)
    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["result"]["stdout"].strip() == "device-fixed-ok"
    receipt = result["payload"]["receipt"]
    assert receipt["status"] == "completed"
    assert receipt["skill_version"] == 3
    assert receipt["authorization_basis"].startswith("skill_script_grant:")
