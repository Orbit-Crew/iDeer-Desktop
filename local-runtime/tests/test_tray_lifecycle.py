"""Lifecycle regression for the start() ready-timeout path (05-M1)."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core import tray as tray_module
from core.audit import AuditKind
from core.settings import RuntimeSettings
from core.tray import TrayController, TrayError


def _controller(tmp_path: Path) -> TrayController:
    settings = RuntimeSettings(
        server_url="ws://127.0.0.1:9",  # nothing listens here; a dial would be audited
        device_id="device-1",
        session_token="token",
        audit_db_path=str(tmp_path / "audit.db"),
    )
    settings.config_path = str(tmp_path / "runtime.json")
    return TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        consent_store_path=tmp_path / "consent.db",
    )


def test_start_ready_timeout_reaps_thread_and_late_runner_never_dials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    controller = _controller(tmp_path)
    monkeypatch.setattr(tray_module, "READY_TIMEOUT_SECONDS", 0.05)
    real_new_event_loop = asyncio.new_event_loop

    def slow_new_event_loop() -> asyncio.AbstractEventLoop:
        # Simulate a runner the scheduler never picks up before the timeout.
        time.sleep(0.3)
        return real_new_event_loop()

    monkeypatch.setattr(asyncio, "new_event_loop", slow_new_event_loop)

    with pytest.raises(TrayError, match="did not start"):
        controller.start()

    # The dead session is reaped: the controller is genuinely restartable
    # instead of being stuck on "already started".
    assert controller._thread is None

    # The late runner has been joined and can no longer clobber state.
    assert controller._loop is None

    # And it never dialed: no CONNECTION entry (connection_failed /
    # pairing_required / reconnecting) may exist for the reaped session.
    connection_entries = [
        entry
        for entry in controller.view_local_audit().entries
        if entry.kind is AuditKind.CONNECTION
    ]
    assert connection_entries == [], "the reaped runner must never dial"
