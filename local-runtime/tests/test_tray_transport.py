from __future__ import annotations

import asyncio
import json
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from core.audit import AuditKind
from core.file_service import LocalFileService
from core.files import LocalFileStore, RootConfig
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.transport import LocalRuntimeClient



class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)


def _client(tmp_path: Path) -> LocalRuntimeClient:
    return LocalRuntimeClient(
        server_url="wss://server.invalid/ws",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        file_service=LocalFileService(LocalFileStore([RootConfig("/projects", tmp_path)])),
    )


def _write_task(client, server_key, tmp_path):
    payload = {
        "operation": "local.files.write",
        "path": "/projects/paused.txt",
        "content": "must not be written",
        "run_id": "run-1",
    }
    envelope = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id="task-paused",
        payload=payload,
    )
    return verify_envelope(
        envelope,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )


def test_pausing_the_runtime_rejects_new_tasks_instead_of_losing_them(tmp_path: Path) -> None:
    server_key = Ed25519PrivateKey.generate()
    client = _client(tmp_path)
    client.connection = FakeConnection()
    client.pause()

    asyncio.run(client._handle_task(_write_task(client, server_key, tmp_path)))

    message = json.loads(client.connection.sent[-1])
    assert message["type"] == MessageType.ERROR
    assert message["payload"]["error_code"] == "DEVICE_PAUSED"
    assert message["payload"]["receipt"]["status"] == "denied"
    assert message["payload"]["receipt"]["task_id"] == "task-paused"
    assert not (tmp_path / "paused.txt").exists()


def test_local_consent_decision_is_audited_with_actor_and_outcome(tmp_path: Path) -> None:
    server_key = Ed25519PrivateKey.generate()
    client = _client(tmp_path)
    client.connection = FakeConnection()
    task = _write_task(client, server_key, tmp_path)

    async def round_trip() -> None:
        await client._handle_task(task)
        request_hash = json.loads(client.connection.sent[-1])["payload"]["request_hash"]
        decision = verify_envelope(
            sign_envelope(
                private_key=server_key,
                message_type=MessageType.CONSENT_DECISION,
                device_id="device-1",
                session_id="session-1",
                task_id="task-paused",
                payload={
                    "approved": False,
                    "actor_id": "tray-user",
                    "request_hash": request_hash,
                },
            ),
            server_public_key=public_key_text(server_key),
            expected_device_id="device-1",
            expected_session_id="session-1",
        )
        await client._handle_consent_decision(decision)

    asyncio.run(round_trip())

    consent_entries = client.audit.recent(kind=AuditKind.CONSENT)
    assert [(entry.action, entry.actor_id) for entry in consent_entries] == [
        ("denied", "tray-user"),
        ("required", None),
    ]
    assert consent_entries[0].capability == "local.files.write"
    assert (tmp_path / "paused.txt").exists() is False


def test_completed_execution_is_audited_once_with_receipt_hashes(tmp_path: Path) -> None:
    server_key = Ed25519PrivateKey.generate()
    client = _client(tmp_path)
    client.connection = FakeConnection()
    task = _write_task(client, server_key, tmp_path)

    async def round_trip() -> None:
        await client._handle_task(task)
        request_hash = json.loads(client.connection.sent[-1])["payload"]["request_hash"]
        decision = verify_envelope(
            sign_envelope(
                private_key=server_key,
                message_type=MessageType.CONSENT_DECISION,
                device_id="device-1",
                session_id="session-1",
                task_id="task-paused",
                payload={
                    "approved": True,
                    "actor_id": "tray-user",
                    "request_hash": request_hash,
                },
            ),
            server_public_key=public_key_text(server_key),
            expected_device_id="device-1",
            expected_session_id="session-1",
        )
        await client._handle_consent_decision(decision)

    asyncio.run(round_trip())

    execution = client.audit.recent(kind=AuditKind.EXECUTION)[0]
    assert execution.action == "completed"
    assert execution.detail["result_hash"]
    assert (tmp_path / "paused.txt").read_text() == "must not be written"


def test_the_audit_row_exists_the_moment_the_result_frame_is_sent(
    tmp_path: Path,
) -> None:
    """Ordering, asserted at the send: history must not lag the wire.

    Waiting for the frame and then reading the log cannot prove this — the
    record lands microseconds after the send and the read sees it either way.
    The only honest check is to look at the log from inside the send itself.
    """
    server_key = Ed25519PrivateKey.generate()
    seen: dict[str, list[str]] = {}

    class InspectingConnection(FakeConnection):
        async def send(self, value: str) -> None:
            message = json.loads(value)
            if message["type"] == MessageType.TASK_RESULT.value:
                seen["actions"] = [
                    entry.action
                    for entry in client.audit.recent(kind=AuditKind.EXECUTION)
                ]
            await super().send(value)

    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        file_service=LocalFileService(
            LocalFileStore([RootConfig("/projects", tmp_path)])
        ),
    )
    client.connection = InspectingConnection()

    async def round_trip() -> None:
        await client._handle_task(
            verify_envelope(
                sign_envelope(
                    private_key=server_key,
                    message_type=MessageType.TASK,
                    device_id="device-1",
                    session_id="session-1",
                    task_id="task-order",
                    payload={
                        "operation": "local.files.write",
                        "path": "/projects/ordered.txt",
                        "content": "ordered",
                        "run_id": "run-1",
                    },
                ),
                server_public_key=public_key_text(server_key),
                expected_device_id="device-1",
                expected_session_id="session-1",
            )
        )
        request_hash = json.loads(client.connection.sent[-1])["payload"]["request_hash"]
        await client._handle_consent_decision(
            verify_envelope(
                sign_envelope(
                    private_key=server_key,
                    message_type=MessageType.CONSENT_DECISION,
                    device_id="device-1",
                    session_id="session-1",
                    task_id="task-order",
                    payload={
                        "approved": True,
                        "actor_id": "alice",
                        "request_hash": request_hash,
                    },
                ),
                server_public_key=public_key_text(server_key),
                expected_device_id="device-1",
                expected_session_id="session-1",
            )
        )

    asyncio.run(round_trip())
    assert seen["actions"] == ["completed"]
