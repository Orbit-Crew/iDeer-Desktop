"""Issue 111: the Agent terminal pane's desktop wire.

The pane reads this identity's own terminal history through one scope-gated
command, stops a Run through the same durable fence the chat surface uses,
and the status snapshot carries the in-flight commands. Malformed frames are
dropped by the reader; the wire answers with fixed categories only.
"""
import base64
import json
import queue
import threading
import types
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.file_service import WorkspaceSelection
from core.protocol import public_key_text
from core.settings import RuntimeSettings

REPLY_TYPES = {"terminal-history", "terminal-stop"}


class TerminalHarness:
    """Drive desktop.main() in a thread with scripted terminal commands."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        config = tmp_path / "profile" / "settings.json"
        key = Ed25519PrivateKey.generate()
        settings = RuntimeSettings(
            server_url="http://127.0.0.1:108", user_id="account-108", device_id="device-108",
            session_token_ref="fixture-session", device_key_ref="fixture-key",
            device_public_key=public_key_text(key), server_public_key=public_key_text(key))
        settings.save(config)
        self.config = config
        self.login_state = {"value": "authenticated"}
        self.frames: list[dict] = []
        self.stopped_runs: list[str] = []
        self._pending = ""
        self._reply = threading.Event()
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._exit: dict[str, int] = {}

        class Client:
            connected = True
            active = 0
            file_service = None
            terminal_service = None

            def begin_install_drain(self):
                pass

            def active_task_count(self):
                return self.active

        class Controller:
            settings = types.SimpleNamespace(session_token="synthetic")

            def __init__(self):
                self.client = Client()
                # The connect path re-points the file service's availability
                # gate; a bare namespace is what the real client exposes.
                self.client.file_service = types.SimpleNamespace()

            def start(self):
                pass

            def status(self):
                return types.SimpleNamespace(connection="connected")

            def stop(self):
                pass

            def stop_run(self, run_id: str) -> None:
                harness.stopped_runs.append(run_id)

        harness = self
        self.controller = Controller()

        class Input:
            def __iter__(self):
                return self

            def __next__(self):
                line = self.lines.get()
                if line is None:
                    raise StopIteration
                return line

        Input.lines = self._lines

        class Output:
            def write(self, value):
                self.sink._write(value)
                return len(value)

            def flush(self):
                pass

        Output.sink = self

        secure = types.SimpleNamespace(get=lambda reference: base64.b64encode(
            key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        login = types.SimpleNamespace(
            secure=secure, restore=lambda: None, server_origin=lambda: "http://127.0.0.1:108",
            status=lambda: {"state": self.login_state["value"]})
        gate = types.SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        # The stdin/stdout patches land in start() (the test body's call
        # phase), after the runner re-arms its own capture around sys.stdout;
        # applied at construction (setup phase) they would land under the
        # runner's capture and the wire frames would bypass the harness.
        self._patches = (monkeypatch, secure, login, gate, Input, Output)

    def select_workspace(self, path: Path) -> str:
        selection = WorkspaceSelection(self.config)
        selection.select(str(path), confirmed=True)
        self.scope = selection.scope()
        return self.scope

    def _write(self, value: str) -> None:
        self._pending += value
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get("type") in REPLY_TYPES:
                self._reply.set()

    def start(self) -> None:
        monkeypatch, secure, login, gate, Input, Output = self._patches
        monkeypatch.setattr(desktop, "own_process_tree", lambda: None)
        monkeypatch.setattr(desktop, "create_default_secret_store", lambda: secure)
        monkeypatch.setattr(desktop, "BrowserLogin", lambda *args: login)
        monkeypatch.setattr(desktop, "CompatibilityGate", lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, "load_controller", lambda *args, **kwargs: self.controller)
        monkeypatch.setattr(desktop.sys, "argv", ["desktop", "--config", str(self.config)])
        monkeypatch.setattr(desktop.sys, "stdin", Input())
        monkeypatch.setattr(desktop.sys, "stdout", Output())
        self._thread = threading.Thread(
            target=lambda: self._exit.update(code=desktop.main()), daemon=True)
        self._thread.start()

    def command(self, payload: dict, *, expect_reply: bool = True) -> dict | None:
        self._reply.clear()
        self._lines.put(json.dumps(payload) + "\n")
        if not expect_reply:
            return None
        if not self._reply.wait(15):
            kinds = [frame.get("type") for frame in self.frames]
            raise RuntimeError(
                f"no terminal reply for {payload.get('id')}; exit={self._exit} frames={kinds[-12:]}")
        with self._lock:
            for frame in reversed(self.frames):
                if frame.get("type") in REPLY_TYPES and frame.get("id") == payload.get("id"):
                    return frame
        raise AssertionError("reply frame vanished")

    def snapshot(self) -> dict:
        with self._lock:
            for frame in reversed(self.frames):
                if "connection" in frame and "tasks" in frame:
                    return frame
        raise AssertionError("no status snapshot observed")

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), "desktop.main did not stop"
        return self._exit.get("code", 1)


@pytest.fixture()
def harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TerminalHarness:
    return TerminalHarness(tmp_path, monkeypatch)


def workdir(tmp_path: Path) -> Path:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return work


def test_history_and_stop_round_trip_over_the_desktop_wire(harness, tmp_path):
    harness.select_workspace(workdir(tmp_path))
    harness.start()
    history = harness.command({"type": "terminal-history", "id": "t-1",
                               "scope": harness.scope})
    assert history["error"] == ""
    assert history["result"] == {"commands": [], "storageError": ""}
    # Narrowed to one chat thread the answer stays this identity's own rows.
    threaded = harness.command({"type": "terminal-history", "id": "t-2",
                                "scope": harness.scope, "threadId": "thread-1"})
    assert threaded["result"]["commands"] == []
    stop = harness.command({"type": "terminal-stop", "id": "s-1",
                            "scope": harness.scope, "runId": "run-77"})
    assert stop["error"] == ""
    assert stop["result"] == {"requested": True}
    assert harness.stopped_runs == ["run-77"]
    snapshot = harness.snapshot()
    assert snapshot["agentTerminal"] == {"running": []}
    assert snapshot["agentTerminalStorageError"] == ""
    assert harness.finish() == 0


def test_history_refuses_a_stale_scope(harness, tmp_path):
    harness.select_workspace(workdir(tmp_path))
    harness.start()
    stale = harness.command({"type": "terminal-history", "id": "t-1",
                             "scope": "stale-scope"})
    assert stale["error"] == "IDENTITY_CHANGED"
    assert stale["result"] is None
    assert harness.finish() == 0


def test_malformed_terminal_frames_are_dropped_by_the_reader(harness, tmp_path):
    harness.select_workspace(workdir(tmp_path))
    harness.start()
    # Extra key, wrong type, missing bound, wrong id type — all dropped.
    for broken in (
        {"type": "terminal-history", "id": "t-x", "scope": harness.scope, "extra": 1},
        {"type": "terminal-history", "id": "t-x", "scope": ""},
        {"type": "terminal-history", "id": 7, "scope": harness.scope},
        {"type": "terminal-history", "id": "t-x", "scope": harness.scope, "threadId": 5},
        {"type": "terminal-stop", "id": "s-x"},
        {"type": "terminal-stop", "id": "s-x", "runId": ""},
        {"type": "terminal-stop", "id": "s-x", "scope": harness.scope, "runId": ""},
    ):
        harness.command(broken, expect_reply=False)
    reply = harness.command({"type": "terminal-history", "id": "t-ok",
                             "scope": harness.scope})
    assert reply["id"] == "t-ok"
    with harness._lock:
        terminal_frames = [frame for frame in harness.frames
                           if frame.get("type") in REPLY_TYPES]
    assert [frame["id"] for frame in terminal_frames] == ["t-ok"]
    assert harness.finish() == 0
