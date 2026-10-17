"""Broker public-key binding: pairing pins the key, TOFU is opt-in only.

The HELLO handshake is the trust seam (05-H1): before this change the first
``ws://`` connection accepted and persisted whatever ``server_public_key`` the
peer offered, so a MITM on the first connection could pin its own key and pull
LEVEL_0 file data without any local consent. These tests pin the new contract:

  - a key captured by pairing is the only trusted broker identity and never
    gets replaced by the HELLO payload;
  - a replaced key fails the handshake;
  - an unbound client refuses to connect at all unless the fallback is
    explicitly enabled in configuration;
  - LEVEL_0 file capabilities are denied while no broker key is bound.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from core.file_service import LocalFileService
from core.files import LocalFileStore, RootConfig
from core.protocol import (
    MessageType,
    ProtocolError,
    public_key_text,
    sign_envelope,
    verify_envelope,
)
from core.transport import LocalRuntimeClient
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class FakeConnection:
    """A socket that plays one prepared HELLO and then goes quiet."""

    def __init__(self, incoming: tuple[str, ...] = ()) -> None:
        self.sent: list[str] = []
        self._incoming = list(incoming)

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def recv(self) -> str:
        if self._incoming:
            return self._incoming.pop(0)
        raise StopAsyncIteration

    async def close(self) -> None:
        pass

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        if self._incoming:
            return self._incoming.pop(0)
        raise StopAsyncIteration


def _client(**overrides) -> LocalRuntimeClient:
    kwargs = {
        "server_url": "ws://unused",
        "device_id": "device-1",
        "session_token": "token",
        "private_key": Ed25519PrivateKey.generate(),
        "session_id": "session-1",
    }
    kwargs.update(overrides)
    return LocalRuntimeClient(**kwargs)


def _broker_hello(signing_key: Ed25519PrivateKey) -> str:
    """A HELLO reply as a broker (or a MITM posing as one) would send it."""
    return json.dumps(
        sign_envelope(
            private_key=signing_key,
            message_type=MessageType.HELLO,
            device_id="device-1",
            session_id="session-1",
            payload={
                "server_public_key": public_key_text(signing_key),
                "protocol_version": "1",
            },
        )
    )


def _file_client(tmp_path: Path, **overrides) -> LocalRuntimeClient:
    overrides.setdefault(
        "file_service",
        LocalFileService(LocalFileStore([RootConfig("/projects", tmp_path)])),
    )
    return _client(**overrides)


def _signed_task(server_key: Ed25519PrivateKey, operation: str, payload: dict):
    """A TASK frame signed by the (claimed) broker and verified on the device."""
    signed = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id="task-1",
        payload={"operation": operation, "run_id": "run-1", **payload},
    )
    return verify_envelope(
        signed,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )


# --- criterion 1: pairing pins the key, later connections verify against it --


def test_a_pinned_broker_key_survives_the_hello_round_trip() -> None:
    """A bound key verifies the HELLO and is never swapped for the offered one."""
    broker_key = Ed25519PrivateKey.generate()
    client = _client(server_public_key=public_key_text(broker_key))
    client.connection = FakeConnection((_broker_hello(broker_key),))

    asyncio.run(client.run())

    assert client.server_public_key == public_key_text(broker_key)
    assert client.connected is False  # the quiet fake socket just ended cleanly


def test_a_pinned_broker_key_rejects_a_rotated_key() -> None:
    """Pairing bound key_a; a HELLO signed by key_b must not verify."""
    broker_key = Ed25519PrivateKey.generate()
    rotated_key = Ed25519PrivateKey.generate()
    observed: list[str] = []
    client = _client(
        server_public_key=public_key_text(broker_key),
        on_server_public_key=observed.append,
    )
    client.connection = FakeConnection((_broker_hello(rotated_key),))

    with pytest.raises(ProtocolError):
        asyncio.run(client.run())

    assert client.server_public_key == public_key_text(broker_key)
    assert observed == []


# --- criterion 2: a replaced key on the first connection fails the handshake --


def test_first_connection_replaced_key_fails_the_handshake() -> None:
    """An unbound client must refuse to pin the key a MITM offers (05-H1)."""
    attacker_key = Ed25519PrivateKey.generate()
    observed: list[str] = []
    client = _client(on_server_public_key=observed.append)
    client.connection = FakeConnection((_broker_hello(attacker_key),))

    with pytest.raises(ProtocolError):
        asyncio.run(client.run())

    assert client.server_public_key is None
    assert observed == []


def test_the_explicit_fallback_still_pins_the_first_observed_key() -> None:
    """The legacy first-connection trust is available only when configured."""
    broker_key = Ed25519PrivateKey.generate()
    observed: list[str] = []
    client = _client(
        allow_unpinned_broker_key=True, on_server_public_key=observed.append
    )
    client.connection = FakeConnection((_broker_hello(broker_key),))

    asyncio.run(client.run())

    assert client.server_public_key == public_key_text(broker_key)
    assert observed == [public_key_text(broker_key)]


# --- criterion 3: LEVEL_0 file capabilities stay shut while unbound ----------


def test_unbound_client_denies_level_0_file_listing(tmp_path: Path) -> None:
    server_key = Ed25519PrivateKey.generate()
    (tmp_path / "secret.txt").write_text("local-only", encoding="utf-8")
    client = _file_client(tmp_path)
    client.connection = FakeConnection()
    task = _signed_task(server_key, "local.files.list", {"path": "/projects"})

    asyncio.run(client._handle_task(task))

    frames = [json.loads(raw) for raw in client.connection.sent]
    outcomes = [
        frame["type"] for frame in frames if frame["type"] != MessageType.TASK_ACK
    ]
    assert outcomes == [MessageType.ERROR]
    assert frames[-1]["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
    assert frames[-1]["payload"]["receipt"]["policy_decision"] == "deny"


def test_unbound_client_denies_level_0_file_read(tmp_path: Path) -> None:
    server_key = Ed25519PrivateKey.generate()
    (tmp_path / "secret.txt").write_text("local-only", encoding="utf-8")
    client = _file_client(tmp_path)
    client.connection = FakeConnection()
    task = _signed_task(
        server_key, "local.files.read", {"path": "/projects/secret.txt"}
    )

    asyncio.run(client._handle_task(task))

    frames = [json.loads(raw) for raw in client.connection.sent]
    outcomes = [
        frame["type"] for frame in frames if frame["type"] != MessageType.TASK_ACK
    ]
    assert outcomes == [MessageType.ERROR]
    assert frames[-1]["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
    assert "local-only" not in json.dumps(frames)


def test_a_bound_client_still_serves_level_0_file_listing(tmp_path: Path) -> None:
    """Positive control: once a broker key is bound, LEVEL_0 works as before."""
    server_key = Ed25519PrivateKey.generate()
    (tmp_path / "visible.txt").write_text("fine", encoding="utf-8")
    client = _file_client(tmp_path, server_public_key=public_key_text(server_key))
    client.connection = FakeConnection()
    task = _signed_task(server_key, "local.files.list", {"path": "/projects"})

    asyncio.run(client._handle_task(task))

    frames = [json.loads(raw) for raw in client.connection.sent]
    assert any(frame["type"] == MessageType.TASK_RESULT for frame in frames)
