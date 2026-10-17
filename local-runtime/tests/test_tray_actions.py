"""Tests for tray control surface actions (spec requirement)."""

import json
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.audit import AuditKind
from core.python import _WindowsExtendedLimit
from core.secrets import InMemorySecretStore
from core.settings import CapabilityRule, RuntimeSettings, load_settings
from core.transport import RePairRequired
from core.tray import TrayController, _load_or_create_key


def test_open_settings_and_view_audit_are_exposed(tmp_path: Path) -> None:
    """The control surface must expose Open Settings and View Local Audit.

    Spec: "控制：Pause / Disconnect / Open Settings / View Local Audit".
    """
    settings = RuntimeSettings(
        server_url="ws://127.0.0.1:8001",
        device_id="device-1",
        session_token="token",
        audit_db_path=str(tmp_path / "audit.db"),
    )
    config_path = tmp_path / "runtime.json"
    settings.config_path = str(config_path)
    controller = TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )

    # open_settings() returns the live settings object the UI edits in place
    settings_view = controller.open_settings()
    assert settings_view is controller.settings
    assert settings_view.device_id == "device-1"

    controller._remember_server_public_key("pinned-broker-key")
    assert load_settings(config_path).server_public_key == "pinned-broker-key"

    # view_local_audit() returns a view object the UI can render
    controller.settings.set_rule("local.files.write", CapabilityRule.DENY)
    controller.save_settings()
    audit_view = controller.view_local_audit()
    assert hasattr(audit_view, "entries")
    assert hasattr(audit_view, "clear")
    assert hasattr(audit_view, "integrity")
    # Entries are newest-first
    assert audit_view.entries, "audit should have CONFIG entries after save"
    assert audit_view.entries[0].kind == AuditKind.CONFIG
    # clear is callable and records the clear itself
    clearance = audit_view.clear(actor_id="alice")
    assert "entries_removed" in clearance


def test_windows_job_limit_structure_includes_peak_memory_fields() -> None:
    names = [name for name, _ in _WindowsExtendedLimit._fields_]
    assert names[-2:] == ["peak_process_memory_used", "peak_job_memory_used"]


def test_saving_roots_creates_and_removes_runtime_services(tmp_path: Path) -> None:
    config_path = tmp_path / "runtime.json"
    settings = RuntimeSettings(config_path=str(config_path))
    controller = TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )

    assert controller.client.file_service is None
    assert controller.client.python_service is None

    controller.settings.add_root("/projects", tmp_path)
    controller.save_settings()
    assert controller.client.file_service is not None
    assert controller.client.python_service is not None

    controller.settings.remove_root("/projects")
    controller.save_settings()
    assert controller.client.file_service is None
    assert controller.client.python_service is None


def test_saving_mcp_config_rebuilds_the_runtime_projection(tmp_path: Path) -> None:
    config_path = tmp_path / "runtime.json"
    mcp_path = tmp_path / "mcp.json"
    mcp_path.write_text(
        json.dumps(
            {
                "servers": [
                    {
                        "name": "fs",
                        "transport": "stdio",
                        "command": ["missing-mcp"],
                        "enabled": False,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    controller = TrayController(
        settings=RuntimeSettings(config_path=str(config_path)),
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )

    controller.set_mcp_config_path(mcp_path)
    assert controller.client.mcp_service is not None
    assert controller.client.mcp_service.supervisor.server_names() == ("fs",)

    controller.set_mcp_config_path("")
    assert controller.client.mcp_service is None


def test_device_key_uses_secure_store_when_available(tmp_path: Path) -> None:
    store = InMemorySecretStore()
    key_path = tmp_path / "runtime-key"

    first = _load_or_create_key(key_path, secure_store=store, key_ref="device-key")
    assert not key_path.exists()
    second = _load_or_create_key(key_path, secure_store=store, key_ref="device-key")

    assert (
        second.public_key().public_bytes_raw() == first.public_key().public_bytes_raw()
    )


def test_tray_pairing_methods_bind_claim_and_session(
    monkeypatch, tmp_path: Path
) -> None:
    store = InMemorySecretStore()
    responses = iter(
        (
            {
                "device": {"id": "device-paired"},
                "pairing_id": "pairing-1",
                "claim_token": "claim-token-value",
                "claim_expires_at": "later",
            },
            {
                "device": {"id": "device-paired", "name": "Desk"},
                "session_id": "session-1",
                "session_token": "session-token-value",
            },
        )
    )
    monkeypatch.setattr("core.tray.create_default_secret_store", lambda: store)
    monkeypatch.setattr(
        TrayController,
        "_pairing_post",
        staticmethod(lambda endpoint, payload: next(responses)),
    )
    config_path = tmp_path / "runtime.json"
    controller = TrayController(
        settings=RuntimeSettings(config_path=str(config_path)),
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )

    started = controller.pair_start(
        server_url="http://server",
        pairing_code="ABCDEFGH",
        device_name="Desk",
    )
    assert started["device_id"] == "device-paired"
    controller.pair_complete()

    assert controller.settings.session_id == "session-1"
    assert controller.client.session_token == "session-token-value"


def test_pairing_pins_the_broker_public_key_from_the_pairing_responses(
    monkeypatch, tmp_path: Path
) -> None:
    """Pairing distributes the broker key; the tray binds it before any ws://.

    05-H1: the pairing flow never captured the broker public key, so the first
    connection had to trust whatever key the peer offered. The register and
    register/complete responses now carry it, and both pairing steps pin it.
    """
    store = InMemorySecretStore()
    broker_key = (
        "pq1GpXaS1wF8W3aP9r5wJcDl0V5x7Yq2zK0mN4bC6dE8fGhIjKlMnOpQrStUvWx"  # noqa: S105 - fake key text
    )
    responses = iter(
        (
            {
                "device": {"id": "device-paired"},
                "pairing_id": "pairing-1",
                "claim_token": "claim-token-value",
                "claim_expires_at": "later",
                "server_public_key": broker_key,
            },
            {
                "device": {"id": "device-paired", "name": "Desk"},
                "session_id": "session-1",
                "session_token": "session-token-value",
                "server_public_key": broker_key,
            },
        )
    )
    monkeypatch.setattr("core.tray.create_default_secret_store", lambda: store)
    monkeypatch.setattr(
        TrayController,
        "_pairing_post",
        staticmethod(lambda endpoint, payload: next(responses)),
    )
    config_path = tmp_path / "runtime.json"
    controller = TrayController(
        settings=RuntimeSettings(config_path=str(config_path)),
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )

    controller.pair_start(
        server_url="http://server",
        pairing_code="ABCDEFGH",
        device_name="Desk",
    )
    assert controller.settings.server_public_key == broker_key
    assert controller.client.server_public_key == broker_key

    controller.pair_complete()
    assert controller.settings.server_public_key == broker_key
    assert controller.client.server_public_key == broker_key
    assert load_settings(config_path).server_public_key == broker_key


@pytest.mark.asyncio
async def test_session_rejection_stops_supervisor_instead_of_reconnecting(
    tmp_path: Path,
) -> None:
    controller = TrayController(
        settings=RuntimeSettings(
            server_url="ws://127.0.0.1:8001",
            device_id="device-1",
            session_token="token",
            audit_db_path=str(tmp_path / "audit.db"),
        ),
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )

    async def rejected() -> None:
        raise RePairRequired("session revoked")

    controller.client.run = rejected
    await controller._supervise()

    assert controller._stopping is True
    assert (
        controller.audit_recent(kind=AuditKind.CONNECTION)[0].action
        == "pairing_required"
    )


def test_status_caches_audit_integrity_between_polls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """05-M7: the tray UI polls status() every second; walking the full
    audit hash chain per poll is O(history) on a display field."""
    import core.tray as tray_module

    settings = RuntimeSettings(
        server_url="ws://127.0.0.1:8001",
        device_id="device-1",
        session_token="token",
        audit_db_path=str(tmp_path / "audit.db"),
    )
    settings.config_path = str(tmp_path / "runtime.json")
    controller = TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )
    real_verify = controller.audit.verify
    calls: list[int] = []

    def counting_verify():
        calls.append(1)
        return real_verify()

    monkeypatch.setattr(controller.audit, "verify", counting_verify)

    controller.status()
    controller.status()
    assert len(calls) == 1, "the integrity walk must be cached between polls"

    monkeypatch.setattr(tray_module, "AUDIT_VERIFY_INTERVAL_SECONDS", 0.0)
    controller.status()
    assert len(calls) == 2, "an expired interval must re-verify"


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits do not exist on Windows")
def test_written_private_key_is_never_world_readable(tmp_path: Path) -> None:
    """05-L3: the key file is created at 0600, not written wide then chmodded."""
    import os
    import stat

    from core.tray import _write_private_key

    path = tmp_path / "device.pem"
    key = Ed25519PrivateKey.generate()
    _write_private_key(path, key)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600
    assert b"PRIVATE KEY" in path.read_bytes()


def test_written_private_key_contents_round_trip_on_windows(tmp_path: Path) -> None:
    """The Windows half of the 05-L3 seam: os.open creation-mode is ignored by
    Windows, so assert the write contract (valid PEM at the path) instead of
    POSIX mode bits there."""
    from core.tray import _write_private_key

    path = tmp_path / "device.pem"
    key = Ed25519PrivateKey.generate()
    _write_private_key(path, key)
    assert b"PRIVATE KEY" in path.read_bytes()
