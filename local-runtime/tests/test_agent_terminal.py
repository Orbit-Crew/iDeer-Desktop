"""Issue 111: the Agent's controlled terminal — gates, executor, history.

The service refuses any anchor that is not provably inside the confirmed
workspace in every tier, before any consent flow; the session tier answers
full-tier asks; every executed command lands in the binding-scoped history
with honest end states (cancelled/timed-out/interrupted are 效果待核实) and
the receipt binds the Run/Tool Call identity.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.agent_terminal import (
    MAX_COMMAND_LENGTH,
    TERMINAL_CAPABILITY,
    AgentTerminalHistory,
    AgentTerminalService,
    ShellExecutor,
    TerminalHistoryError,
    TerminalResult,
    TerminalTaskStatus,
)
from core.consent import ConsentStore, request_hash
from core.files import LocalFileStore, RootConfig
from core.policy import LocalPolicy, PolicyDecision
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.session_tier import (
    GateDecision,
    SessionTier,
    SessionTierRegistry,
    payload_anchor,
    tier_gate_decision,
)
from core.transport import LocalRuntimeClient

BINDING = {"server_origin": "http://fixture.invalid", "user_id": "account-111",
           "device_id": "device-111", "device_public_key": "fixture-device-key",
           "broker_public_key": "fixture-broker-key"}

# Platform-fair command forms: cmd.exe and /bin/sh agree on these.
ECHO_HELLO = "echo hello"
FAIL_EXIT_3 = "exit 3"
SECRET_ECHO = "echo api_key=supersecret"
if os.name == "nt":
    LONG_SLEEP = "ping -n 30 127.0.0.1 > nul"
else:
    LONG_SLEEP = "sleep 30"


def stub_classify(root: str = "/projects") -> object:
    def classify(path: str) -> str:
        if path == root or path.startswith(root + "/"):
            if "/.git" in path or path.endswith("/.env") or "/.ssh" in path:
                return "protected"
            return "inside"
        return "outside"
    return classify


def make_store(tmp_path: Path) -> LocalFileStore:
    (tmp_path / "projects").mkdir(parents=True, exist_ok=True)
    return LocalFileStore([RootConfig("/projects", tmp_path / "projects")])


def make_service(tmp_path: Path, *, classify=..., history=None,
                 policy: LocalPolicy | None = None,
                 consent: ConsentStore | None = None,
                 files: LocalFileStore | None = None) -> AgentTerminalService:
    # ``classify=...`` (sentinel) means "wire the stub"; an explicit None
    # builds the fail-closed no-classifier service the tests assert on.
    if classify is ...:
        classify = stub_classify()
    return AgentTerminalService(
        files if files is not None else make_store(tmp_path),
        policy=policy or LocalPolicy(),
        consent=consent or ConsentStore(),
        history=history,
        classify=classify,
    )


def payload_for(command: str = ECHO_HELLO, **overrides) -> dict[str, object]:
    row = {"operation": TERMINAL_CAPABILITY, "command": command,
           "working_root": "/projects", "timeout": 15,
           "run_id": "run-111", "task_id": "task-111", "thread_id": "thread-111",
           "tool_call_id": "call-111"}
    row.update(overrides)
    return row


# --- executor -------------------------------------------------------------


def test_shell_executor_runs_one_command_and_hashes_canonical_output(tmp_path):
    result = asyncio.run(ShellExecutor().run(
        ECHO_HELLO, working_root=tmp_path, timeout=15))
    assert result.status is TerminalTaskStatus.COMPLETED
    assert result.exit_code == 0
    assert result.stdout.strip() == "hello"
    assert result.stderr == ""
    assert result.stdout_hash and len(result.stdout_hash) == 64
    assert result.effects_uncertain is False


def test_shell_executor_reports_nonzero_exit_as_failed(tmp_path):
    result = asyncio.run(ShellExecutor().run(
        FAIL_EXIT_3, working_root=tmp_path, timeout=15))
    assert result.status is TerminalTaskStatus.FAILED
    assert result.exit_code == 3


def test_shell_executor_timeout_kills_the_process_and_marks_uncertain(tmp_path):
    result = asyncio.run(ShellExecutor().run(
        LONG_SLEEP, working_root=tmp_path, timeout=1.5))
    assert result.status is TerminalTaskStatus.TIMED_OUT
    assert result.exit_code is None
    assert result.effects_uncertain is True
    assert "timed out" in result.stderr


def test_shell_executor_cancellation_kills_the_process(tmp_path):
    async def run_and_cancel():
        task = asyncio.create_task(ShellExecutor().run(
            LONG_SLEEP, working_root=tmp_path, timeout=30))
        await asyncio.sleep(1.0)
        task.cancel()
        return await task

    result = asyncio.run(run_and_cancel())
    assert result.status is TerminalTaskStatus.CANCELLED
    assert result.exit_code is None
    assert result.effects_uncertain is True
    assert "cancelled" in result.stderr


def test_shell_executor_streams_redacted_output_tails(tmp_path):
    tails: list[tuple[str, str]] = []

    async def on_output(stream: str, text: str) -> None:
        tails.append((stream, text))

    result = asyncio.run(ShellExecutor().run(
        SECRET_ECHO, working_root=tmp_path, timeout=15, on_output=on_output))
    assert result.status is TerminalTaskStatus.COMPLETED
    joined = "".join(text for _, text in tails)
    assert "supersecret" not in joined
    assert "[REDACTED]" in joined
    assert "supersecret" not in result.stdout


def test_shell_executor_refuses_a_missing_working_root(tmp_path):
    with pytest.raises(ValueError, match="working_root must be a directory"):
        asyncio.run(ShellExecutor().run(
            ECHO_HELLO, working_root=tmp_path / "missing", timeout=15))


# --- history store --------------------------------------------------------


def admit_row(store: AgentTerminalHistory, task_id: str = "task-1", **overrides) -> bool:
    row = {"thread_id": "thread-1", "run_id": "run-1", "task_id": task_id,
           "tool_call_id": "call-1", "command": ECHO_HELLO,
           "working_root": "/projects", "authorization_basis": "consent:allow_once",
           "started_at": "2026-11-08T00:00:00+00:00"}
    row.update(overrides)
    return store.admit(BINDING, row)


def test_history_rows_are_binding_scoped_and_completion_is_immutable(tmp_path):
    store = AgentTerminalHistory(tmp_path / "terminal.db")
    assert admit_row(store) is True
    other = {**BINDING, "user_id": "account-B"}
    assert store.view(other, "thread-1") == []
    assert store.complete(other, "task-1", status=TerminalTaskStatus.COMPLETED,
                          exit_code=0, stdout_tail="", stderr_tail="",
                          stdout_hash="a" * 64, stderr_hash="b" * 64,
                          finished_at="2026-11-08T00:01:00+00:00") is False
    assert store.complete(BINDING, "task-1", status=TerminalTaskStatus.COMPLETED,
                          exit_code=0, stdout_tail="hello", stderr_tail="",
                          stdout_hash="a" * 64, stderr_hash="b" * 64,
                          finished_at="2026-11-08T00:01:00+00:00") is True
    # The first end state wins: a later complete (or replay) cannot rewrite it.
    assert store.complete(BINDING, "task-1", status=TerminalTaskStatus.FAILED,
                          exit_code=1, stdout_tail="", stderr_tail="",
                          stdout_hash=None, stderr_hash=None,
                          finished_at="2026-11-08T00:02:00+00:00") is False
    row = store.view(BINDING, "thread-1")[0]
    assert row["status"] == "completed"
    assert row["effectsUncertain"] is False
    assert row["stdoutTail"] == "hello"
    assert row["authorizationBasis"] == "consent:allow_once"


def test_history_running_rows_sweep_to_interrupted_at_process_start(tmp_path):
    store = AgentTerminalHistory(tmp_path / "terminal.db")
    admit_row(store, task_id="stale-1")
    admit_row(store, task_id="stale-2", command=LONG_SLEEP)
    assert len(store.running()) == 2
    swept = store.sweep_interrupted()
    assert swept == 2
    assert store.running() == []
    rows = store.view(BINDING, "thread-1")
    assert all(row["status"] == "interrupted" for row in rows)
    assert all(row["effectsUncertain"] is True for row in rows)
    assert all(row["finishedAt"] for row in rows)
    # The sweep is a startup fact, not a repeated one: finished rows stay.
    assert store.sweep_interrupted() == 0


def test_history_tail_updates_touch_running_rows_only(tmp_path):
    store = AgentTerminalHistory(tmp_path / "terminal.db")
    admit_row(store)
    store.update_output(BINDING, "task-1", stdout_tail="partial", stderr_tail="warn")
    row = store.view(BINDING, "thread-1")[0]
    assert row["stdoutTail"] == "partial"
    assert store.complete(BINDING, "task-1", status=TerminalTaskStatus.COMPLETED,
                          exit_code=0, stdout_tail="final", stderr_tail="",
                          stdout_hash=None, stderr_hash=None,
                          finished_at="2026-11-08T00:01:00+00:00") is True
    store.update_output(BINDING, "task-1", stdout_tail="late write", stderr_tail="")
    assert store.view(BINDING, "thread-1")[0]["stdoutTail"] == "final"


def test_history_refused_rows_never_complete_and_prune_keeps_recent(tmp_path):
    store = AgentTerminalHistory(tmp_path / "terminal.db")
    assert store.record_refused(BINDING, {
        "thread_id": "thread-1", "run_id": "run-1", "task_id": "refused-1",
        "tool_call_id": "call-1", "command": "del /q C:\\Windows",
        "working_root": "/projects", "authorization_basis": "policy"}) is True
    row = store.view(BINDING, "thread-1")[0]
    assert row["status"] == "refused"
    assert store.complete(BINDING, "refused-1", status=TerminalTaskStatus.COMPLETED,
                          exit_code=0, stdout_tail="", stderr_tail="",
                          stdout_hash=None, stderr_hash=None,
                          finished_at="now") is False
    for index in range(250):
        admit_row(store, task_id=f"bulk-{index}")
        store.complete(BINDING, f"bulk-{index}", status=TerminalTaskStatus.COMPLETED,
                       exit_code=0, stdout_tail="", stderr_tail="",
                       stdout_hash=None, stderr_hash=None, finished_at="now")
    assert len(store.view(BINDING, "thread-1", limit=200)) == 200
    assert store.view(BINDING, "thread-1", limit=200)[0]["taskId"].startswith("bulk-2")


def test_history_storage_failure_uses_one_fixed_category(tmp_path):
    broken = AgentTerminalHistory(tmp_path / "missing" / "terminal.db")
    with pytest.raises(TerminalHistoryError, match="TERMINAL_STORAGE_UNAVAILABLE"):
        admit_row(broken)
    assert broken.error == "TERMINAL_STORAGE_UNAVAILABLE"


# --- service gates --------------------------------------------------------


def test_payload_validation_bounds_command_and_timeout(tmp_path):
    service = make_service(tmp_path)
    with pytest.raises(TypeError):
        service._validate_payload({"working_root": "/projects"})
    with pytest.raises(ValueError, match="characters"):
        service._validate_payload({"command": "x" * (MAX_COMMAND_LENGTH + 1)})
    with pytest.raises(ValueError, match="NUL"):
        service._validate_payload({"command": "echo\x00"})
    with pytest.raises(ValueError, match="timeout"):
        service._validate_payload({"command": "echo", "timeout": 0})
    with pytest.raises(ValueError, match="timeout"):
        service._validate_payload({"command": "echo", "timeout": 100000})
    service._validate_payload(payload_for())


def test_service_refuses_outside_and_protected_anchors_in_every_tier(tmp_path):
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)
    # Outside anchor: refused without asking, no execution, honest row.
    result = asyncio.run(service.execute(
        payload_for("del /q C:\\Windows", working_root="/elsewhere",
                    task_id="task-outside"),
        ledger_binding=BINDING))
    assert result is PolicyDecision.DENY
    assert not (tmp_path / "projects" / "marker.txt").exists()
    refused = history.view(BINDING, "thread-111")
    assert len(refused) == 1 and refused[0]["status"] == "refused"
    assert refused[0]["taskId"] == "task-outside"
    # Protected anchor: same refusal.
    result = asyncio.run(service.execute(
        payload_for("type secrets", working_root="/projects/.ssh",
                    task_id="task-protected"), ledger_binding=BINDING))
    assert result is PolicyDecision.DENY
    assert len(history.view(BINDING, "thread-111")) == 2
    # A classifier failure refuses rather than widens.
    def broken_classify(path: str) -> str:
        raise RuntimeError("classifier exploded")
    broken = make_service(tmp_path, classify=broken_classify)
    assert asyncio.run(broken.execute(payload_for())) is PolicyDecision.DENY
    # A runtime wired without a classifier has no terminal channel at all.
    unclassified = make_service(tmp_path, classify=None)
    assert asyncio.run(unclassified.execute(payload_for())) is PolicyDecision.DENY


def test_service_anchor_defaults_to_the_single_bound_root(tmp_path):
    service = make_service(tmp_path)
    assert service._anchor_of({"working_root": None}) == "/projects"
    assert service.normalize({"command": "echo"}) == {
        "command": "echo", "working_root": "/projects"}
    multi = make_service(tmp_path, files=LocalFileStore([
        RootConfig("/projects", tmp_path / "projects"),
        RootConfig("/other", tmp_path / "other")]))
    with pytest.raises(ValueError, match="working_root is required"):
        multi._anchor_of({})


def test_service_asks_for_consent_below_full_tier_and_runs_consented(tmp_path):
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)
    outcome = asyncio.run(service.execute(payload_for(), ledger_binding=BINDING))
    assert outcome is PolicyDecision.CONSENT_REQUIRED
    # Nothing ran and nothing is recorded while the ask is pending.
    assert history.view(BINDING, "thread-111") == []
    assert not (tmp_path / "projects" / "marker.txt").exists()

    outcome = asyncio.run(service.execute(payload_for(), consent=True,
                                          ledger_binding=BINDING))
    assert isinstance(outcome, TerminalResult)
    assert outcome.status is TerminalTaskStatus.COMPLETED
    assert outcome.receipt.capability == TERMINAL_CAPABILITY
    assert outcome.receipt.status == "completed"
    assert outcome.receipt.consent_decision == "approved"
    assert outcome.receipt.run_id == "run-111"
    assert outcome.receipt.task_id == "task-111"
    assert outcome.receipt.error_code is None
    row = history.view(BINDING, "thread-111")[0]
    assert row["status"] == "completed"
    assert row["exitCode"] == 0
    assert row["stdoutHash"] == outcome.stdout_hash
    assert row["runId"] == "run-111" and row["toolCallId"] == "call-111"


def test_service_full_tier_runs_inside_anchor_and_denies_outside(tmp_path):
    # The session tier gate resolves a full-tier ask whose anchor is inside;
    # the service is the one refusing outside/protected ahead of any tier.
    classify = stub_classify()
    inside = payload_for()
    assert payload_anchor(inside, TERMINAL_CAPABILITY) == "/projects"
    assert tier_gate_decision(SessionTier.FULL, TERMINAL_CAPABILITY, inside, classify) is GateDecision.ALLOW
    assert tier_gate_decision(SessionTier.FULL, TERMINAL_CAPABILITY,
                              payload_for(working_root="/elsewhere"), classify) is GateDecision.DENY
    assert tier_gate_decision(SessionTier.FULL, TERMINAL_CAPABILITY,
                              payload_for(working_root="/projects/.ssh"), classify) is GateDecision.DENY
    # Below full the terminal always asks (自主档每条命令仍逐条询问).
    assert tier_gate_decision(SessionTier.AUTONOMOUS, TERMINAL_CAPABILITY, inside, classify) is GateDecision.ASK
    assert tier_gate_decision(SessionTier.ASK_FIRST, TERMINAL_CAPABILITY, inside, classify) is GateDecision.ASK


def test_service_records_cancelled_and_failed_commands_honestly(tmp_path):
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)

    async def run_and_cancel():
        task = asyncio.create_task(service.execute(
            payload_for(LONG_SLEEP, timeout=30), consent=True, ledger_binding=BINDING))
        await asyncio.sleep(1.0)
        task.cancel()
        return await task

    outcome = asyncio.run(run_and_cancel())
    assert outcome.status is TerminalTaskStatus.CANCELLED
    assert outcome.effects_uncertain is True
    assert outcome.receipt.error_code == "RESULT_UNCERTAIN"
    row = history.view(BINDING, "thread-111")[0]
    assert row["status"] == "cancelled" and row["effectsUncertain"] is True

    failed = asyncio.run(service.execute(payload_for(FAIL_EXIT_3, task_id="task-failed"),
                                         consent=True, ledger_binding=BINDING))
    assert failed.status is TerminalTaskStatus.FAILED
    assert failed.exit_code == 3
    assert failed.effects_uncertain is False
    row = history.view(BINDING, "thread-111")[0]
    assert row["status"] == "failed" and row["taskId"] == "task-failed"


def test_service_survives_history_storage_failures(tmp_path):
    broken_history = AgentTerminalHistory(tmp_path / "missing" / "terminal.db")
    service = make_service(tmp_path, history=broken_history)
    outcome = asyncio.run(service.execute(payload_for(), consent=True,
                                          ledger_binding=BINDING))
    # The command still runs; the history stays honest about being unreadable.
    assert outcome.status is TerminalTaskStatus.COMPLETED
    assert broken_history.error == "TERMINAL_STORAGE_UNAVAILABLE"


# --- transport dispatch ---------------------------------------------------


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


def signed_task(server_key, payload: dict, task_id: str):
    return verify_envelope(
        sign_envelope(
            private_key=server_key,
            message_type=MessageType.TASK,
            device_id="device-111",
            session_id="session-111",
            task_id=task_id,
            payload=payload,
        ),
        server_public_key=public_key_text(server_key),
        expected_device_id="device-111",
        expected_session_id="session-111",
    )


def make_client(tmp_path: Path, service: AgentTerminalService) -> LocalRuntimeClient:
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-111",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-111",
        terminal_service=service,
    )
    # The tier gate reads its workspace classifier off the wire's file
    # service, exactly as the desktop wiring binds them together.
    import types as _types

    client.file_service = _types.SimpleNamespace(classify=stub_classify())
    client.connection = FakeConnection()
    return client


def test_transport_terminal_task_round_trip_with_consent(tmp_path):
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)
    client = make_client(tmp_path, service)
    server_key = Ed25519PrivateKey.generate()

    async def round_trip():
        task = signed_task(server_key, payload_for(), "task-dispatch")
        await client._handle_task(task)
        consent_message = json.loads(client.connection.sent[-1])
        assert consent_message["type"] == MessageType.CONSENT_REQUIRED
        decision = sign_envelope(
            private_key=server_key,
            message_type=MessageType.CONSENT_DECISION,
            device_id="device-111",
            session_id="session-111",
            task_id="task-dispatch",
            payload={
                "approved": True,
                "actor_id": "alice",
                "request_hash": consent_message["payload"]["request_hash"],
            },
        )
        await client._handle_consent_decision(verify_envelope(
            decision,
            server_public_key=public_key_text(server_key),
            expected_device_id="device-111",
            expected_session_id="session-111",
        ))

    asyncio.run(round_trip())
    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    body = result["payload"]["result"]
    assert body["status"] == "completed"
    assert body["working_root"] == "/projects"
    assert body["effects_uncertain"] is False
    receipt = result["payload"]["receipt"]
    assert receipt["capability"] == TERMINAL_CAPABILITY
    assert receipt["consent_decision"] == "approved"
    assert receipt["status"] == "completed"
    assert history.view(client.receipt_binding(), "thread-111")[0]["status"] == "completed"


def test_transport_terminal_refusal_denies_without_an_ask(tmp_path):
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)
    client = make_client(tmp_path, service)
    server_key = Ed25519PrivateKey.generate()

    asyncio.run(client._handle_task(signed_task(
        server_key,
        payload_for("del /q C:\\Windows", working_root="/elsewhere"),
        "task-refused")))
    message = json.loads(client.connection.sent[-1])
    # The refusal never renders an ask: outside anchors are refused directly.
    assert message["type"] == MessageType.ERROR
    assert message["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
    assert message["payload"]["receipt"]["status"] == "denied"
    # The refused row carries the dispatch's own receipt binding identity.
    assert history.view(client.receipt_binding(), "thread-111")[0]["status"] == "refused"


def test_transport_without_terminal_service_denies_the_capability(tmp_path):
    client = LocalRuntimeClient(
        server_url="ws://unused", device_id="device-111", session_token="token",
        private_key=Ed25519PrivateKey.generate(), session_id="session-111",
        terminal_service=None,
    )
    client.connection = FakeConnection()
    server_key = Ed25519PrivateKey.generate()
    asyncio.run(client._handle_task(signed_task(
        server_key, payload_for(), "task-absent")))
    message = json.loads(client.connection.sent[-1])
    assert message["type"] == MessageType.ERROR
    assert message["payload"]["receipt"]["status"] == "denied"


def test_transport_stop_run_cancels_a_running_terminal_command(tmp_path):
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)
    client = make_client(tmp_path, service)
    server_key = Ed25519PrivateKey.generate()
    # Pre-approved consent so the stop lands mid-command, not mid-ask.
    stopped_payload = payload_for(LONG_SLEEP, timeout=60)
    service.consent.approve(TERMINAL_CAPABILITY, request_hash(stopped_payload))

    async def stop_mid_command():
        task = asyncio.create_task(client._handle_task(signed_task(
            server_key,
            stopped_payload,
            "task-stopped")))
        # The delivery loop owns this registration; the test mirrors it so
        # stop_run can find the in-flight task exactly as production would.
        client._task_runs["task-stopped"] = "run-111"
        client._running_tasks["task-stopped"] = task
        await asyncio.sleep(1.5)
        await client.stop_run("run-111")
        await task

    asyncio.run(stop_mid_command())
    messages = [json.loads(frame) for frame in client.connection.sent]
    assert any(message["type"] == MessageType.TASK_RESULT
               and message["payload"]["receipt"]["status"] == "cancelled"
               for message in messages)
    row = history.view(client.receipt_binding(), "thread-111")[0]
    assert row["status"] == "cancelled"
    assert row["effectsUncertain"] is True


def test_full_tier_thread_auto_runs_an_inside_command_end_to_end(tmp_path):
    """The FULL tier resolves the ask standing: no consent round trip, the
    settle basis ``tier:full`` rides both the receipt and the history row."""
    history = AgentTerminalHistory(tmp_path / "terminal.db")
    service = make_service(tmp_path, history=history)
    client = make_client(tmp_path, service)
    client.session_tiers = SessionTierRegistry()
    client.session_tiers.set("thread-111", SessionTier.FULL)
    server_key = Ed25519PrivateKey.generate()

    asyncio.run(client._handle_task(signed_task(
        server_key, payload_for("echo tier-full"), "task-tier-full")))
    messages = [json.loads(frame) for frame in client.connection.sent]
    # No CONSENT_REQUIRED frame: the tier is the standing answer.
    assert not any(message["type"] == MessageType.CONSENT_REQUIRED
                   for message in messages)
    result = messages[-1]
    assert result["type"] == MessageType.TASK_RESULT
    receipt = result["payload"]["receipt"]
    assert receipt["status"] == "completed"
    assert receipt["consent_decision"] == "tier:full"
    row = history.view(client.receipt_binding(), "thread-111")[0]
    assert row["status"] == "completed"
    assert row["authorizationBasis"] == "tier:full"


def test_shell_executor_opens_no_pty_and_redirects_both_streams(
    tmp_path, monkeypatch: pytest.MonkeyPatch,
):
    """AC1 is a property of the executor: both streams are redirected files
    under a pinned shell argv — never a PTY, never a console pipe."""
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4242
        _handle = 9999
        returncode = 0

        def poll(self) -> int:
            return 0

    class FakeJob:
        def close(self) -> None:
            pass

    def fake_popen(args: list[str], **kwargs: object) -> FakeProcess:
        captured.update(args=args, **kwargs)
        return FakeProcess()

    import core.agent_terminal as agent_terminal_module
    import subprocess

    monkeypatch.setattr(agent_terminal_module.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(agent_terminal_module, "_WindowsJob",
                        lambda pid, process_handle=None: FakeJob())
    monkeypatch.setattr(agent_terminal_module, "_resume_initial_thread",
                        lambda pid: None)
    monkeypatch.setattr(agent_terminal_module.os, "name", "nt")

    result = asyncio.run(ShellExecutor().run(
        ECHO_HELLO, working_root=tmp_path, timeout=5))

    assert result.status is TerminalTaskStatus.COMPLETED
    argv = captured["args"]
    assert argv[0] == agent_terminal_module.os.environ.get("COMSPEC", "cmd.exe")
    # stdout/stderr are redirected handles (NamedTemporaryFile objects), so
    # the child renders no console of its own and no PTY anywhere is opened.
    assert captured["stdout"] is not subprocess.PIPE
    assert captured["stderr"] is not subprocess.PIPE
    assert captured["creationflags"] & 0x4  # CREATE_SUSPENDED under the Job


def test_terminal_capability_rides_the_desktop_announcement_only(tmp_path):
    client = make_client(tmp_path, make_service(tmp_path))
    assert "local.terminal" in client._current_capabilities()
    bare = LocalRuntimeClient(
        server_url="ws://unused", device_id="device-111", session_token="token",
        private_key=Ed25519PrivateKey.generate(), session_id="session-111",
    )
    assert "local.terminal" not in bare._current_capabilities()
