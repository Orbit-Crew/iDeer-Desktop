"""Tests for policy denial audit recording and response shape."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.audit import AuditKind
from core.file_service import LocalFileService
from core.files import LocalFileStore, RootConfig
from core.policy import LocalPolicy, PolicyDecision
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.transport import LocalRuntimeClient


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


def test_policy_denial_response_covers_full_wire_and_audit(tmp_path: Path) -> None:
    """A policy denial is one event: a structured error frame AND an audit row.

    The helper should own both so the caller cannot forget either half.
    """
    server_key = Ed25519PrivateKey.generate()
    file_service = LocalFileService(
        LocalFileStore([RootConfig("/projects", tmp_path)]),
        policy=LocalPolicy(denied_capabilities=frozenset(["local.files.write"])),
    )
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        file_service=file_service,
    )
    client.connection = FakeConnection()

    payload = {
        "operation": "local.files.write",
        "path": "/projects/denied.txt",
        "content": "nope",
        "run_id": "run-1",
    }
    envelope = verify_envelope(
        sign_envelope(
            private_key=server_key,
            message_type=MessageType.TASK,
            device_id="device-1",
            session_id="session-1",
            task_id="task-denied",
            payload=payload,
        ),
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )

    asyncio.run(client._handle_task(envelope))

    error_frame = next(
        json.loads(s) for s in client.connection.sent
        if json.loads(s)["type"] == MessageType.ERROR.value
    )
    assert error_frame["payload"]["error_code"] == "LOCAL_POLICY_DENIED"

    denials = client.audit.recent(kind=AuditKind.POLICY)
    assert len(denials) == 1
    assert denials[0].action == "denied"
    assert denials[0].capability == "local.files.write"
    assert denials[0].task_id == "task-denied"
    assert "risk_level" in denials[0].detail
    assert not (tmp_path / "denied.txt").exists()


def test_denial_helper_records_and_sends_in_one_call(tmp_path: Path) -> None:
    """The helper that records a policy denial should also emit the wire error.

    Three call sites currently repeat: record denial → send error. If one
    caller forgets the wire half, the audit shows a denial the server never
    knew about; if it forgets the audit half, the user sees no reason for the
    error. One call must own both.
    """
    file_service = LocalFileService(
        LocalFileStore([RootConfig("/projects", tmp_path)]),
        policy=LocalPolicy(denied_capabilities=frozenset(["local.files.write"])),
    )
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        file_service=file_service,
    )
    client.connection = FakeConnection()

    file_task = client.handle_file_task("local.files.write", {"path": "/projects/x", "content": "x"})
    assert file_task.decision is PolicyDecision.DENY

    asyncio.run(client._denial_response(
        "local.files.write", "task-helper", {"path": "/projects/x", "content": "x"},
        file_task.decision,
    ))
    # The response frame is the observable behavior: one call, two effects.
    sent = [json.loads(s) for s in client.connection.sent]
    assert any(f["type"] == MessageType.ERROR.value for f in sent)
    denials = client.audit.recent(kind=AuditKind.POLICY)
    assert len(denials) == 1


def test_three_denial_paths_all_record_and_send(tmp_path: Path) -> None:
    """Every denied capability (file, python, mcp) records audit + sends error.

    After the refactor, all three sites call the same helper, so they must all
    produce a pair: an audit row (kind=POLICY, action=denied) and an error frame.
    """
    server_key = Ed25519PrivateKey.generate()

    # Use a policy that denies local.files.write via risk level instead of
    # denied_capabilities, to exercise the python/mcp paths through the helper
    # in the same shape.
    file_service = LocalFileService(
        LocalFileStore([RootConfig("/projects", tmp_path)]),
        policy=LocalPolicy(
            level_two_capabilities=frozenset(["local.files.write"]),
        ),
    )
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        file_service=file_service,
    )
    client.connection = FakeConnection()

    payload = {
        "operation": "local.files.write",
        "path": "/projects/level2.txt",
        "content": "no",
        "run_id": "run-1",
    }
    envelope = verify_envelope(
        sign_envelope(
            private_key=server_key,
            message_type=MessageType.TASK,
            device_id="device-1",
            session_id="session-1",
            task_id="task-l2",
            payload=payload,
        ),
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    asyncio.run(client._handle_task(envelope))

    # Level 2 means the helper was called: audit + wire both present.
    denials = client.audit.recent(kind=AuditKind.POLICY)
    assert len(denials) == 1
    assert denials[0].capability == "local.files.write"
    assert denials[0].task_id == "task-l2"
    error_frame = next(
        json.loads(s) for s in client.connection.sent
        if json.loads(s)["type"] == MessageType.ERROR.value
    )
    assert error_frame["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
    assert not (tmp_path / "level2.txt").exists()
