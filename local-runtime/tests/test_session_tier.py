"""Session permission tiers (#74): three tiers, folder-anchored, audited.

The tier is a per-chat-session device policy: ``ask_first`` (the default for
every newly loaded session) keeps today's per-action consent; ``autonomous``
runs authorized-folder writes without asking; ``full`` also opens the command
line. Outside the authorized folder and protected paths are refused in every
tier, and the tier never overrides a local DENY or the platform capability
intersection - it only ever resolves a ``CONSENT_REQUIRED`` ask.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.audit import AuditKind
from core.policy import PolicyDecision
from core.protocol import MessageType
from core.session_tier import (
    DEFAULT_SESSION_TIER,
    SessionTier,
    SessionTierRegistry,
    tier_gate_decision,
)
from core.settings import RuntimeSettings
from core.tray import TrayController

from helpers_fake_broker import FakeBroker


# ---------------------------------------------------------------------------
# The policy matrix: three tiers x (inside / outside / protected).
# ---------------------------------------------------------------------------


def _write_payload(path: str = "/workspace/abc/report.txt") -> dict:
    return {"operation": "local.files.write",
            "arguments": {"path": path, "content": "AFTER\n"}, "run_id": "run-1"}


def _python_payload(root: str = "/workspace/abc") -> dict:
    return {"operation": "local.python", "working_root": root, "script": "pass"}


def _classify_inside(path: str) -> str:
    return "inside"


def _classify_outside(path: str) -> str:
    return "outside"


def _classify_protected(path: str) -> str:
    return "protected"


@pytest.mark.parametrize("classify", [_classify_inside, _classify_outside, _classify_protected])
def test_ask_first_tier_keeps_every_capability_on_the_ask_path(classify) -> None:
    """The lowest tier is today's behavior for every capability and target."""
    for payload in (_write_payload(), _python_payload()):
        assert tier_gate_decision(SessionTier.ASK_FIRST, payload["operation"], payload, classify) == "ask"


@pytest.mark.parametrize("classify", [_classify_inside, _classify_outside, _classify_protected])
def test_tiers_never_widen_capabilities_outside_the_folder_anchor(classify) -> None:
    """Skill scripts, material reads, MCP tools and ungraded capabilities stay
    on the consent path in every tier: the tier's scope is the folder."""
    for capability in ("local.skill.script", "local.knowledge.material", "local.mcp.demo.tool"):
        for tier in (SessionTier.ASK_FIRST, SessionTier.AUTONOMOUS, SessionTier.FULL):
            assert tier_gate_decision(tier, capability, {"operation": capability}, classify) == "ask"


def test_autonomous_tier_runs_folder_inside_writes_without_asking() -> None:
    assert tier_gate_decision(
        SessionTier.AUTONOMOUS, "local.files.write", _write_payload(), _classify_inside
    ) == "allow"


@pytest.mark.parametrize("classify", [_classify_outside, _classify_protected])
def test_autonomous_tier_refuses_outside_and_protected_writes_without_asking(classify) -> None:
    """夹外仍拒: in the autonomous tier an unprovable target is refused, not asked."""
    assert tier_gate_decision(
        SessionTier.AUTONOMOUS, "local.files.write", _write_payload(), classify
    ) == "deny"


@pytest.mark.parametrize("classify", [_classify_inside, _classify_outside, _classify_protected])
def test_command_line_stays_on_the_ask_path_until_the_full_tier(classify) -> None:
    """自主 does not include the command line; 完全 does (夹内含命令行)."""
    payload = _python_payload()
    assert tier_gate_decision(SessionTier.AUTONOMOUS, "local.python", payload, classify) == "ask"
    assert tier_gate_decision(SessionTier.FULL, "local.python", payload, _classify_inside) == "allow"


@pytest.mark.parametrize("classify", [_classify_outside, _classify_protected])
def test_full_tier_refuses_outside_and_protected_command_lines(classify) -> None:
    payload = _python_payload()
    assert tier_gate_decision(SessionTier.FULL, "local.python", payload, classify) == "deny"


def test_unanchored_requests_cannot_be_auto_run_in_upgraded_tiers() -> None:
    """A payload without its folder anchor is never proven in-folder, so the
    upgraded tiers refuse it instead of guessing."""
    bare_write = {"operation": "local.files.write"}
    bare_python = {"operation": "local.python"}
    assert tier_gate_decision(SessionTier.AUTONOMOUS, "local.files.write", bare_write, _classify_inside) == "deny"
    assert tier_gate_decision(SessionTier.FULL, "local.python", bare_python, _classify_inside) == "deny"


def test_flat_write_payload_shape_is_classified_too() -> None:
    """The tray-era payload shape carries the path at the top level."""
    payload = {"operation": "local.files.write", "path": "/projects/a.txt", "content": "one"}
    assert tier_gate_decision(SessionTier.AUTONOMOUS, "local.files.write", payload, _classify_inside) == "allow"
    assert tier_gate_decision(SessionTier.AUTONOMOUS, "local.files.write", payload, _classify_outside) == "deny"


# ---------------------------------------------------------------------------
# Registry: default tier, per-thread memory, reset, audit.
# ---------------------------------------------------------------------------


class _FakeAudit:
    def __init__(self) -> None:
        self.entries: list[dict] = []

    def record(self, kind, action, **kwargs):
        self.entries.append({"kind": kind, "action": action, **kwargs})
        return kwargs


def test_every_thread_starts_at_the_lowest_tier() -> None:
    registry = SessionTierRegistry()
    assert DEFAULT_SESSION_TIER is SessionTier.ASK_FIRST
    assert registry.tier_for("thread-A") is SessionTier.ASK_FIRST
    assert registry.tier_for("") is SessionTier.ASK_FIRST


def test_setting_a_tier_is_scoped_to_one_thread_and_recorded() -> None:
    audit = _FakeAudit()
    registry = SessionTierRegistry(audit=audit)
    registry.set("thread-A", SessionTier.AUTONOMOUS)
    registry.set("thread-B", SessionTier.FULL)
    assert registry.tier_for("thread-A") is SessionTier.AUTONOMOUS
    assert registry.tier_for("thread-B") is SessionTier.FULL
    assert registry.tier_for("thread-C") is SessionTier.ASK_FIRST
    assert [entry["action"] for entry in audit.entries] == ["session_tier_changed", "session_tier_changed"]
    first = audit.entries[0]
    assert first["kind"] is AuditKind.CONFIG
    assert first["detail"]["thread_id"] == "thread-A"
    assert first["detail"]["from"] == "ask_first"
    assert first["detail"]["to"] == "autonomous"


def test_reset_clears_every_session_memory() -> None:
    registry = SessionTierRegistry()
    registry.set("thread-A", SessionTier.FULL)
    registry.reset()
    assert registry.tier_for("thread-A") is SessionTier.ASK_FIRST


def test_tier_switch_back_down_is_recorded_with_both_directions() -> None:
    audit = _FakeAudit()
    registry = SessionTierRegistry(audit=audit)
    registry.set("thread-A", SessionTier.FULL)
    registry.set("thread-A", SessionTier.ASK_FIRST)
    directions = [(entry["detail"]["from"], entry["detail"]["to"]) for entry in audit.entries]
    assert directions == [("ask_first", "full"), ("full", "ask_first")]


# ---------------------------------------------------------------------------
# The real classifier: the confirmed workspace grant decides the scope.
# ---------------------------------------------------------------------------


def _workspace_service(tmp_path: Path):
    from core.file_service import WorkspaceFileService, WorkspaceSelection

    config, work = tmp_path / "profile" / "settings.json", tmp_path / "W1"
    work.mkdir()
    config.parent.mkdir(parents=True)
    (work / "node_modules").mkdir()
    RuntimeSettings(server_url="https://test.invalid", user_id="A", device_id="D1",
                    device_public_key="key", server_public_key="broker").save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(work, confirmed=True)["logicalRoot"]
    return WorkspaceFileService(selection), root


def test_classifier_proves_folder_inside_targets(tmp_path) -> None:
    service, root = _workspace_service(tmp_path)
    assert service.classify(root + "/report.txt") == "inside"
    assert service.classify(root + "/deep/dir/file.txt") == "inside"


def test_classifier_refuses_outside_roots(tmp_path) -> None:
    service, root = _workspace_service(tmp_path)
    assert service.classify("/workspace/other-directory/file.txt") == "outside"
    assert service.classify("C:/Windows/system32/config.sys") == "outside"
    assert service.classify(root + "/../sibling.txt") == "outside"
    assert service.classify("not-a-logical-path") == "outside"


def test_classifier_names_protected_paths(tmp_path) -> None:
    service, root = _workspace_service(tmp_path)
    assert service.classify(root + "/.env") == "protected"
    assert service.classify(root + "/.ssh/id_rsa") == "protected"
    assert service.classify(root + "/node_modules/pkg/index.js") == "protected"
    assert service.classify(root + "/.git/config") == "protected"
    # Traversal out of the root is refused as outside before any name check.
    assert service.classify(root + "/../profile/settings.json") == "outside"


def test_classifier_never_forges_inside_for_the_profile_directory(tmp_path) -> None:
    """When the profile directory itself sits inside an approved folder, its
    files stay protected: the store's protected_roots still refuses them."""
    from core.file_service import WorkspaceFileService, WorkspaceSelection

    work = tmp_path / "W1"
    work.mkdir()
    config = tmp_path / "profile" / "settings.json"
    config.parent.mkdir(parents=True)
    RuntimeSettings(server_url="https://test.invalid", user_id="A", device_id="D1",
                    device_public_key="key", server_public_key="broker").save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(tmp_path, confirmed=True)["logicalRoot"]
    service = WorkspaceFileService(selection)
    assert service.classify(root + "/profile/settings.json") == "protected"


def test_classifier_without_a_ready_workspace_refuses_everything(tmp_path) -> None:
    from core.file_service import WorkspaceFileService, WorkspaceSelection
    from core.settings import RuntimeSettings

    config, work = tmp_path / "profile" / "settings.json", tmp_path / "W1"
    work.mkdir()
    config.parent.mkdir(parents=True)
    RuntimeSettings(server_url="https://test.invalid", user_id="A", device_id="D1",
                    device_public_key="key", server_public_key="broker").save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(work, confirmed=True)["logicalRoot"]
    service = WorkspaceFileService(selection)
    from core.settings import load_settings

    settings = load_settings(config)
    settings.signed_out = True
    settings.save(config)
    assert service.classify(root + "/report.txt") == "outside"


# ---------------------------------------------------------------------------
# The consent hook: an upgraded tier settles CONSENT_REQUIRED asks itself.
# ---------------------------------------------------------------------------


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


def wait_for(predicate, *, timeout: float = 5.0, what: str = "condition") -> None:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture
def broker() -> FakeBroker:
    instance = FakeBroker()
    try:
        yield instance
    finally:
        instance.stop()


def test_autonomous_tier_writes_inside_the_folder_without_a_prompt(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        registry = SessionTierRegistry()
        controller.client.session_tiers = registry
        registry.set("thread-A", SessionTier.AUTONOMOUS)
        controller.client.file_service.classify = lambda path: "inside"
        # The tray-era flat task shape carries the target at the top level.
        broker.send(MessageType.TASK, {"operation": "local.files.write",
                                       "path": "/projects/a.txt", "content": "AFTER\n",
                                       "run_id": "run-1", "thread_id": "thread-A"},
                   task_id="task-1")

        result = broker.expect(MessageType.TASK_RESULT)
        assert result["task_id"] == "task-1"
        assert result["payload"]["receipt"]["consent_decision"] == "tier:autonomous"
        assert (tmp_path / "work" / "a.txt").read_text() == "AFTER\n"
        # No ask was ever raised: the tier itself is the standing answer.
        assert controller.pending_consents() == ()
        consent = controller.audit_recent(kind=AuditKind.CONSENT)
        assert consent[0].action == "approved"
        assert consent[0].actor_id == "session-tier"
        assert consent[0].detail["basis"] == "tier:autonomous"
        assert consent[0].detail["origin"] == "session-tier"
    finally:
        controller.stop()


def test_autonomous_tier_refuses_outside_targets_without_a_prompt(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        registry = SessionTierRegistry()
        controller.client.session_tiers = registry
        registry.set("thread-A", SessionTier.AUTONOMOUS)
        controller.client.file_service.classify = lambda path: "outside"
        broker.send(MessageType.TASK, {"operation": "local.files.write",
                                       "path": "/projects/leak.txt", "content": "AFTER\n",
                                       "run_id": "run-1", "thread_id": "thread-A"},
                   task_id="task-2")

        error = broker.expect(MessageType.ERROR)
        assert error["task_id"] == "task-2"
        assert error["payload"]["error_code"] == "DENIED"
        assert error["payload"]["receipt"]["status"] == "denied"
        assert error["payload"]["receipt"]["consent_decision"] == "denied"
        assert not (tmp_path / "work" / "leak.txt").exists()
        assert controller.pending_consents() == ()
        consent = controller.audit_recent(kind=AuditKind.CONSENT)
        assert consent[0].action == "denied"
        assert consent[0].actor_id == "session-tier"
    finally:
        controller.stop()


def test_local_deny_still_beats_the_autonomous_tier(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """The tier never overrides a local DENY: denied capabilities are refused
    before the tier is ever consulted."""
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        registry = SessionTierRegistry()
        controller.client.session_tiers = registry
        registry.set("thread-A", SessionTier.FULL)
        controller.client.file_service.classify = lambda path: "inside"
        from core.settings import CapabilityRule

        controller.set_rule("local.files.write", CapabilityRule.DENY)
        broker.send(MessageType.TASK, {"operation": "local.files.write",
                                       "path": "/projects/a.txt", "content": "AFTER\n",
                                       "run_id": "run-1", "thread_id": "thread-A"},
                   task_id="task-3")

        error = broker.expect(MessageType.ERROR)
        assert error["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
        assert error["payload"]["receipt"]["policy_decision"] == PolicyDecision.DENY.value
        assert not (tmp_path / "work" / "a.txt").exists()
    finally:
        controller.stop()


def test_command_line_still_asks_in_the_autonomous_tier(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        registry = SessionTierRegistry()
        controller.client.session_tiers = registry
        registry.set("thread-A", SessionTier.AUTONOMOUS)
        controller.client.file_service.classify = lambda path: "inside"
        payload = {**_python_payload("/projects"), "thread_id": "thread-A", "run_id": "run-1"}
        broker.send(MessageType.TASK, payload, task_id="task-4")

        wait_for(lambda: controller.pending_consents(), what="a pending consent")
        request = controller.pending_consents()[0]
        assert request.task_id == "task-4"
    finally:
        controller.stop()


def test_default_tier_keeps_the_prompt_even_with_a_registry_attached(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """A thread with no tier choice behaves exactly like today."""
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        controller.client.session_tiers = SessionTierRegistry()
        controller.client.file_service.classify = lambda path: "inside"
        broker.send(MessageType.TASK, {"operation": "local.files.write",
                                       "path": "/projects/a.txt", "content": "AFTER\n",
                                       "run_id": "run-1", "thread_id": "thread-A"},
                   task_id="task-5")

        wait_for(lambda: controller.pending_consents(), what="a pending consent")
        assert controller.pending_consents()[0].task_id == "task-5"
        assert not (tmp_path / "work" / "a.txt").exists()
    finally:
        controller.stop()


# ---------------------------------------------------------------------------
# Review follow-ups (#74): the full-tier write cells of the matrix, the
# fail-closed thread_id downgrade, and the audited fall-back on reset.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("classify,expected", [
    (_classify_inside, "allow"),
    (_classify_outside, "deny"),
    (_classify_protected, "deny"),
])
def test_full_tier_write_matrix_matches_the_autonomous_cells(classify, expected) -> None:
    """The ticket matrix needs the full x write cells asserted explicitly."""
    assert tier_gate_decision(SessionTier.FULL, "local.files.write", _write_payload(), classify) == expected


def test_full_tier_writes_inside_the_folder_without_a_prompt(
    broker: FakeBroker, tmp_path: Path
) -> None:
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        registry = SessionTierRegistry()
        controller.client.session_tiers = registry
        registry.set("thread-A", SessionTier.FULL)
        controller.client.file_service.classify = lambda path: "inside"
        broker.send(MessageType.TASK, {"operation": "local.files.write",
                                       "path": "/projects/a.txt", "content": "AFTER\n",
                                       "run_id": "run-1", "thread_id": "thread-A"},
                   task_id="task-6")

        result = broker.expect(MessageType.TASK_RESULT)
        assert result["task_id"] == "task-6"
        assert result["payload"]["receipt"]["consent_decision"] == "tier:full"
        assert (tmp_path / "work" / "a.txt").read_text() == "AFTER\n"
        assert controller.pending_consents() == ()
    finally:
        controller.stop()


def test_a_task_without_its_thread_id_fails_closed_to_asking(
    broker: FakeBroker, tmp_path: Path
) -> None:
    """The tier resolves from the task's own thread_id; an unidentifiable
    session never meets a tier, even when one is set on a known thread."""
    controller = _controller(broker, tmp_path)
    controller.start()
    try:
        broker.await_device()
        registry = SessionTierRegistry()
        controller.client.session_tiers = registry
        registry.set("thread-A", SessionTier.FULL)
        controller.client.file_service.classify = lambda path: "inside"
        broker.send(MessageType.TASK, {"operation": "local.files.write",
                                       "path": "/projects/a.txt", "content": "AFTER\n",
                                       "run_id": "run-1"}, task_id="task-7")

        wait_for(lambda: controller.pending_consents(), what="a pending consent")
        assert controller.pending_consents()[0].task_id == "task-7"
        assert not (tmp_path / "work" / "a.txt").exists()
    finally:
        controller.stop()


def test_reset_records_the_fall_back_of_every_upgraded_thread() -> None:
    audit = _FakeAudit()
    registry = SessionTierRegistry(audit=audit)
    registry.set("thread-A", SessionTier.FULL)
    registry.reset()
    assert [entry["action"] for entry in audit.entries] == ["session_tier_changed", "session_tier_expired"]
    expired = audit.entries[1]
    assert expired["kind"] is AuditKind.CONFIG
    assert expired["detail"] == {"thread_id": "thread-A", "from": "full", "to": "ask_first"}


def test_reset_without_any_choice_records_nothing() -> None:
    audit = _FakeAudit()
    registry = SessionTierRegistry(audit=audit)
    registry.set("thread-A", SessionTier.ASK_FIRST)
    registry.reset()
    assert [entry["action"] for entry in audit.entries] == ["session_tier_changed"]
