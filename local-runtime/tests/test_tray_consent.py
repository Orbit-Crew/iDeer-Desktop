"""Consent on the tray: shown, answered here, executed locally, recorded."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.audit import AuditKind
from core.consent import PendingConsent
from core.policy import RiskLevel
from core.protocol import MessageType
from core.settings import CapabilityRule, RuntimeSettings
from core.tray import TrayController, TrayError

from helpers_fake_broker import FakeBroker


def _controller(broker: FakeBroker, tmp_path: Path) -> TrayController:
    settings = RuntimeSettings(
        server_url=broker.url,
        device_id="device-1",
        session_token="paired-token",
        device_name="workstation",
        user_name="alice",
        audit_db_path=str(tmp_path / "audit.db"),
    )
    settings.add_root("/projects", tmp_path / "work")
    (tmp_path / "work").mkdir(exist_ok=True)
    return TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        server_public_key=broker.public_key,
        consent_store_path=tmp_path / "consent.db",
    )


def _write_payload(*, content: str = "hello") -> dict:
    return {
        "operation": "local.files.write",
        "path": "/projects/a.txt",
        "content": content,
        "run_id": "run-1",
    }


@pytest.fixture
def broker() -> FakeBroker:
    instance = FakeBroker()
    try:
        yield instance
    finally:
        instance.stop()


def _hello_count(broker: FakeBroker) -> int:
    """How many device sessions the server has been offered."""
    with broker._lock:
        return sum(
            1 for frame in broker.received if frame["type"] == MessageType.HELLO.value
        )


def wait_for(predicate, *, timeout: float = 5.0, what: str = "condition") -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def test_the_tray_shows_a_pending_request_with_target_and_hash(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        broker.send(MessageType.TASK, _write_payload(), task_id="task-1")

        wait_for(lambda: controller.pending_consents(), what="a pending consent")
        request = controller.pending_consents()[0]
        assert request.task_id == "task-1"
        assert request.summary["target"] == "/projects/a.txt"
        assert request.risk_level == RiskLevel.LEVEL_1.value
        assert request.silenceable is True
        assert len(request.request_hash) == 64
        # The device asks locally: no CONSENT_REQUIRED goes upstream when a
        # tray is attached to answer it (baseline §24).
        frames = [m["type"] for m in broker.received]
        assert MessageType.CONSENT_REQUIRED.value not in frames
    finally:
        controller.stop()


def test_approving_on_the_tray_writes_the_file_and_reports_the_result(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        broker.send(
            MessageType.TASK, _write_payload(content="on device"), task_id="task-1"
        )
        wait_for(lambda: controller.pending_consents(), what="a pending consent")

        controller.decide(
            controller.pending_consents()[0], approved=True, actor_id="alice"
        )

        result = broker.expect(MessageType.TASK_RESULT)
        assert result["task_id"] == "task-1"
        assert (tmp_path / "work" / "a.txt").read_text() == "on device"
        assert result["payload"]["receipt"]["consent_decision"] == "approved"
        consent = controller.audit_recent(kind=AuditKind.CONSENT)
        assert [(e.action, e.actor_id) for e in consent][0] == ("approved", "alice")
    finally:
        controller.stop()


def test_refusing_on_the_tray_touches_nothing_and_is_recorded(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        broker.send(MessageType.TASK, _write_payload(), task_id="task-2")
        wait_for(lambda: controller.pending_consents(), what="a pending consent")

        controller.decide(
            controller.pending_consents()[0], approved=False, actor_id="alice"
        )

        error = broker.expect(MessageType.ERROR)
        assert error["payload"]["error_code"] == "DENIED"
        assert not (tmp_path / "work" / "a.txt").exists()
        assert [
            (e.action, e.actor_id)
            for e in controller.audit_recent(kind=AuditKind.CONSENT)
        ][0] == (
            "denied",
            "alice",
        )
    finally:
        controller.stop()


def test_always_allow_stops_asking_about_that_capability(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        broker.send(MessageType.TASK, _write_payload(content="first"), task_id="task-3")
        wait_for(lambda: controller.pending_consents(), what="a pending consent")
        controller.decide(
            controller.pending_consents()[0],
            approved=True,
            actor_id="alice",
            always=True,
        )
        broker.expect(MessageType.TASK_RESULT)

        broker.await_device()
        broker.send(
            MessageType.TASK, _write_payload(content="second"), task_id="task-4"
        )
        second = broker.expect(MessageType.TASK_RESULT)
        assert second["task_id"] == "task-4"
        assert controller.pending_consents() == ()
        assert (tmp_path / "work" / "a.txt").read_text() == "second"
        assert (
            controller.audit_recent(kind=AuditKind.CONSENT)[0].action
            == "always_allowed"
        )
    finally:
        controller.stop()


def test_a_level_two_capability_is_denied_without_asking(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.set_rule("local.python", CapabilityRule.ASK_FIRST)
    controller.set_risk_level("local.python", RiskLevel.LEVEL_2)
    controller.start()
    try:
        broker.await_device()
        broker.send(
            MessageType.TASK,
            {
                "operation": "local.python",
                "working_root": "/projects",
                "script": "print('dangerous')",
                "run_id": "run-1",
            },
            task_id="task-5",
        )

        error = broker.expect(MessageType.ERROR)
        assert error["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
        assert controller.pending_consents() == ()
        denied = controller.audit_recent(kind=AuditKind.POLICY)
        assert [(e.capability, e.action) for e in denied] == [
            ("local.python", "denied")
        ]
    finally:
        controller.stop()


def test_a_level_two_request_can_never_be_always_allowed(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        dangerous = PendingConsent(
            task_id="task-6",
            capability="local.python",
            payload={},
            request_hash="0" * 64,
            risk_level=RiskLevel.LEVEL_2.value,
            silenceable=False,
            summary={},
            requested_at=time.monotonic(),
        )
        with pytest.raises(TrayError, match="level 2"):
            controller.decide(dangerous, approved=True, always=True)
    finally:
        controller.stop()


def test_paused_tray_answers_new_tasks_with_a_structured_denial(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """Pause must never lose a task silently (issue 04, Pause/Disconnect 语义)."""
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        controller.pause(actor_id="alice")

        broker.send(MessageType.TASK, _write_payload(), task_id="task-paused")

        error = broker.expect(MessageType.ERROR)
        assert error["payload"]["error_code"] == "DEVICE_PAUSED"
        assert error["payload"]["receipt"]["status"] == "denied"
        assert not (tmp_path / "work" / "a.txt").exists()
        assert controller.audit_recent(kind=AuditKind.CONTROL)[0].action == "paused"

        controller.resume(actor_id="alice")
        broker.send(MessageType.TASK, _write_payload(), task_id="task-resumed")
        wait_for(lambda: controller.pending_consents(), what="the prompt after resume")
        assert controller.pending_consents()[0].task_id == "task-resumed"
    finally:
        controller.stop()


def test_disconnect_ends_the_session_and_stops_reconnecting(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        wait_for(
            lambda: controller.status().connection == "connected",
            what="the initial connection",
        )

        controller.disconnect(actor_id="alice")

        assert controller.status().connection == "offline"
        assert controller._thread is None
        kinds = [
            (entry.kind, entry.action) for entry in controller.audit_recent(limit=6)
        ]
        assert (AuditKind.CONNECTION, "disconnecting") in kinds
        # No reconnect storm: the device stays away until the user asks again.
        time.sleep(0.2)
        assert controller.status().connection == "offline"

        controller.reconnect()
        wait_for(
            lambda: controller.status().connection == "connected",
            what="the reconnect",
        )
    finally:
        controller.stop()


def test_the_status_panel_reports_identity_roots_capabilities_and_history(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        broker.send(MessageType.TASK, _write_payload(content="shown"), task_id="task-s")
        wait_for(lambda: controller.pending_consents(), what="a pending consent")
        controller.decide(
            controller.pending_consents()[0], approved=True, actor_id="alice"
        )
        broker.expect(MessageType.TASK_RESULT)

        status = controller.status()
        assert status.connection == "connected"
        assert status.user_name == "alice"
        assert status.device_name == "workstation"
        assert status.allowed_roots == ("/projects",)
        assert "local.files.write" in status.capabilities
        assert status.recent_execution == "local.files.write → completed"
        assert status.audit_integrity == "ok"
        assert status.audit_entries > 0
        assert status.as_dict()["pending_consents"] == 0
    finally:
        controller.stop()


def test_the_audit_view_lists_events_newest_first_and_clearing_leaves_a_marker(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        controller.pause()
        controller.resume()

        actions = [entry.action for entry in controller.audit_recent(limit=20)]
        assert actions.index("resumed") < actions.index("paused")

        # connection/connected, then paused, then resumed.
        before = controller.audit_recent(limit=0)
        assert [(entry.kind, entry.action) for entry in before] == [
            (AuditKind.CONTROL, "resumed"),
            (AuditKind.CONTROL, "paused"),
            (AuditKind.CONNECTION, "connected"),
        ]
        marker = controller.clear_audit(actor_id="alice")
        assert marker["entries_removed"] == len(before)
        assert marker["last_entry_hash"] == before[0].entry_hash
        assert [entry.action for entry in controller.audit_recent(limit=5)] == [
            "cleared"
        ]
        assert controller.audit_integrity() == "ok"
        # The evidence of a history survives the clear.
        assert controller.audit.clearances()[0]["actor_id"] == "alice"
    finally:
        controller.stop()


def test_a_live_audit_view_appends_only_what_arrived_since_the_last_pull(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    assert controller.audit_new_since() == []
    controller.pause(actor_id="alice")

    fresh = controller.audit_new_since()

    assert [entry.action for entry in fresh] == ["paused"]
    assert controller.audit_new_since() == []
    controller.resume(actor_id="alice")
    assert [entry.action for entry in controller.audit_new_since()] == ["resumed"]


def test_settings_edits_are_written_back_and_take_effect_without_a_restart(
    broker: FakeBroker, tmp_path: Path
) -> None:
    path = tmp_path / "runtime.json"
    settings = RuntimeSettings(
        server_url=broker.url,
        device_id="device-1",
        session_token="paired-token",
        audit_db_path=str(tmp_path / "audit.db"),
    )
    settings.add_root("/projects", tmp_path)
    controller = TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        server_public_key=broker.public_key,
        consent_store_path=tmp_path / "consent.db",
    )
    settings.config_path = str(path)
    controller.start()
    try:
        broker.await_device()
        controller.set_rule("local.files.write", CapabilityRule.DENY)

        written = json.loads(path.read_text()) if controller.save_settings() else {}
        assert written["rules"] == {"local.files.write": "deny"}

        broker.send(MessageType.TASK, _write_payload(), task_id="task-denied")
        error = broker.expect(MessageType.ERROR)
        assert error["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
        assert not (tmp_path / "a.txt").exists()
    finally:
        controller.stop()


def test_secret_management_exposes_names_and_usage_never_values(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """Settings shows which credentials exist and when they were used, not them."""
    settings = RuntimeSettings(
        server_url=broker.url,
        device_id="device-1",
        session_token="paired-token",
        secret_backend="memory",
        audit_db_path=str(tmp_path / "audit.db"),
    )
    settings.add_root("/projects", tmp_path)
    controller = TrayController(
        settings=settings,
        private_key=Ed25519PrivateKey.generate(),
        server_public_key=broker.public_key,
        consent_store_path=tmp_path / "consent.db",
    )
    assert controller.secret_names() == ()

    controller.store_secret("git_token", "sup3r-secret-value")

    assert controller.secret_names() == ("git_token",)
    assert "sup3r-secret-value" not in json.dumps(
        [entry.as_dict() for entry in controller.secret_usage()]
    )
    assert [entry.action for entry in controller.secret_usage()] == ["stored"]

    controller.delete_secret("git_token")

    assert controller.secret_names() == ()
    assert [entry.action for entry in controller.secret_usage()] == [
        "deleted",
        "stored",
    ]


def test_disconnect_then_reconnect_moves_the_icon_and_back(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """An offline icon must mean no thread is dialing; reconnect must resume."""
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        wait_for(
            lambda: controller.status().connection == "connected",
            what="a connected session",
        )

        hellos = _hello_count(broker)
        assert hellos == 1

        controller.disconnect(actor_id="alice")

        assert controller.status().connection == "offline"
        # The session is really down: the device records dropping it, and a
        # lingering loop would keep answering the server behind an offline icon.
        assert (
            next(
                entry.action
                for entry in controller.audit_recent(kind=AuditKind.CONNECTION)
            )
            == "disconnecting"
        )
        assert _hello_count(broker) == hellos

        controller.reconnect()
        wait_for(
            lambda: controller.status().connection == "connected",
            what="the session to come back",
        )
        assert _hello_count(broker) == hellos + 1
        broker.send(
            MessageType.TASK, _write_payload(content="reconnected"), task_id="task-r"
        )
        wait_for(
            lambda: controller.pending_consents(), what="a prompt after reconnecting"
        )
        controller.decide(
            controller.pending_consents()[0], approved=True, actor_id="alice"
        )
        target = tmp_path / "work" / "a.txt"
        wait_for(
            lambda: target.exists() and target.read_text() == "reconnected",
            what="the write to land after reconnecting",
        )
    finally:
        controller.stop()


def test_reconnecting_a_running_tray_is_refused(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """A second start would be a duplicate session, not a resume."""
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        with pytest.raises(TrayError, match="already running"):
            controller.reconnect()
    finally:
        controller.stop()


def test_a_dropped_session_retries_instead_of_killing_the_runtime_thread(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """The server hanging up is a reconnect, not a dead tray.

    websockets reports a dropped connection as ConnectionClosed, which is not
    an OSError, so a supervisor that caught only OSError would exit and leave
    `status()` reading "connected" over a session that no longer exists.
    """
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        wait_for(
            lambda: controller.status().connection == "connected",
            what="the first session",
        )

        broker.drop_device()

        wait_for(
            lambda: _hello_count(broker) >= 2,
            what="a second hello after the drop",
        )
        assert controller._thread.is_alive()
        wait_for(
            lambda: controller.status().connection == "connected",
            what="the retry to reattach the icon",
        )
        failures = [
            entry
            for entry in controller.audit_recent(kind=AuditKind.CONNECTION)
            if entry.action == "connection_failed"
        ]
        assert failures, "a dropped session must be recorded, not swallowed"
        assert not (tmp_path / "work" / "a.txt").exists()
    finally:
        controller.stop()
