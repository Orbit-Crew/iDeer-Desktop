"""The connectors control channel: fixed wire gate, owner-scoped flow (#123).

The Electron shell reaches the connector installer only through the
``connectors`` control command: a fixed per-action key set, the profile scope
binding, and fixed ``CONNECTOR_*`` categories on the way out. The roundtrip
here exercises the real service — preview writes nothing, a confirmed install
registers the canonical identity first, commits the managed copy and the
controlled configuration, and the supervisor swap runs twice (install and
remove) so the running projection can never outlive the registry.
"""
import base64
import json
import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop, platform_chat
from core.connector_install import (
    MANIFEST_NAME,
    ConnectorInstallService,
    ConnectorRegistry,
    connectors_config_path,
)
from core.file_service import WorkspaceSelection
from core.protocol import public_key_text
from core.receipt_ledger import profile_binding
from core.settings import RuntimeSettings

FIXTURE_ENTRY = Path(__file__).parent / "fixtures" / "connector_mcp_server.py"


def build_package(root: Path, *, slug: str = "demo-echo") -> Path:
    package = root / f"candidate-{slug}"
    package.mkdir(parents=True)
    manifest = {
        "connector": slug,
        "displayName": "Demo Echo Connector",
        "version": "1.2.0",
        "entry": "server.py",
        "requirements": {"python": ">=3.9"},
    }
    (package / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    (package / "server.py").write_text(FIXTURE_ENTRY.read_text(encoding="utf-8"), encoding="utf-8")
    return package


class DesktopHarness:
    """Drive desktop.main() in a thread with scripted commands and replies."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.tmp_path = tmp_path
        config = tmp_path / "profile" / "settings.json"
        key = Ed25519PrivateKey.generate()
        settings = RuntimeSettings(
            server_url="http://127.0.0.1:108", user_id="account-108", device_id="device-108",
            session_token_ref="fixture-session", device_key_ref="fixture-key",
            device_public_key=public_key_text(key), server_public_key=public_key_text(key))
        settings.save(config)
        self.config = config
        self.scope = WorkspaceSelection(config).scope()
        self.owner = profile_binding(settings)
        self.refreshes: list[str] = []
        self.registrations: list[tuple[str, str, str, str]] = []
        self.unregistrations: list[str] = []
        self.frames: list[dict] = []
        self._pending = ""
        self._reply = threading.Event()
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._exit: dict[str, int] = {}

        service = ConnectorInstallService(
            ConnectorRegistry(config.with_name("connectors.db")), config_path=config)

        class Client:
            connected = True
            active = 0
            file_service = SimpleNamespace()

            def begin_install_drain(self):
                pass

            def active_task_count(self):
                return self.active

        class Controller:
            settings = SimpleNamespace(session_token="synthetic")

            def __init__(self):
                self.client = Client()
                self.connector_service = service

            def start(self):
                pass

            def refresh_connectors(self):
                self.refreshes.append("swap")

            def status(self):
                return SimpleNamespace(connection="connected")

            def stop(self):
                pass

        self.controller = Controller()
        # The recorder list is shared: the controller instance appends into
        # the same list the test asserts on.
        self.controller.refreshes = self.refreshes

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

        secure = SimpleNamespace(get=lambda reference: base64.b64encode(
            key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        login = SimpleNamespace(secure=secure, restore=lambda: None,
            status=lambda: {"state": "authenticated"}, server_origin=lambda: "http://127.0.0.1:108")
        gate = SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        def fake_register(_self, slug, display_name, version, manifest_hash):
            self.registrations.append((slug, display_name, version, manifest_hash))
            return {"connectorId": "platform-conn-123"}

        def fake_unregister(_self, connector_id):
            self.unregistrations.append(connector_id)
            return {"unregistered": True}

        monkeypatch.setattr(desktop, "own_process_tree", lambda: None)
        monkeypatch.setattr(desktop, "create_default_secret_store", lambda: secure)
        monkeypatch.setattr(desktop, "BrowserLogin", lambda *args: login)
        monkeypatch.setattr(desktop, "CompatibilityGate", lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, "load_controller", lambda *args, **kwargs: self.controller)
        monkeypatch.setattr(platform_chat.DesktopChat, "register_connector_identity", fake_register)
        monkeypatch.setattr(platform_chat.DesktopChat, "unregister_connector_identity", fake_unregister)
        monkeypatch.setattr(desktop.sys, "argv", ["desktop", "--config", str(config)])
        monkeypatch.setattr(desktop.sys, "stdin", Input())
        monkeypatch.setattr(desktop.sys, "stdout", Output())

    # -- harness driving ----------------------------------------------------

    def _write(self, value: str) -> None:
        self._pending += value
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get("type") == "connectors":
                self._reply.set()

    def start(self) -> None:
        self._thread = threading.Thread(
            target=lambda: self._exit.update(code=desktop.main()), daemon=True)
        self._thread.start()

    def command(self, payload: dict, *, expect_reply: bool = True) -> dict | None:
        """Send one control command; optionally wait for its typed reply."""
        self._reply.clear()
        self._lines.put(json.dumps(payload) + "\n")
        if not expect_reply:
            return None
        if not self._reply.wait(15):
            kinds = [frame.get("type") for frame in self.frames]
            raise RuntimeError(
                f"no connectors reply for {payload.get('id')}; exit={self._exit} frames={kinds[-12:]}")
        with self._lock:
            for frame in reversed(self.frames):
                if frame.get("type") == "connectors" and frame.get("id") == payload.get("id"):
                    return frame
        raise AssertionError("reply frame vanished")

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), "desktop.main did not stop"
        return self._exit.get("code", 1)


def make_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> DesktopHarness:
    return DesktopHarness(tmp_path, monkeypatch)


def test_wire_gate_refuses_malformed_connector_commands(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    harness.start()
    bad = [
        {"type": "connectors", "id": "a1", "action": "deploy", "scope": harness.scope},
        {"type": "connectors", "id": "a2", "action": "install", "path": "x", "confirmed": "yes",
         "scope": harness.scope},
        {"type": "connectors", "id": "a3", "action": "list", "extra": 1, "scope": harness.scope},
        {"type": "connectors", "id": "a4", "action": "remove", "slug": "", "confirmed": True,
         "scope": harness.scope},
        {"type": "connectors", "id": "a5", "action": "install", "path": 5, "confirmed": True,
         "scope": harness.scope},
    ]
    for payload in bad:
        harness.command(payload, expect_reply=False)
    # A well-formed list still answers; the malformed ones were dropped.
    harness.command({"type": "connectors", "id": "ok", "action": "list", "scope": harness.scope})
    assert harness.finish() == 0
    connector_frames = [frame for frame in harness.frames if frame.get("type") == "connectors"]
    assert [frame["id"] for frame in connector_frames] == ["ok"]
    assert connector_frames[0]["result"] == {"connectors": []}
    assert connector_frames[0]["error"] == ""


def test_preview_install_list_remove_roundtrip(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    package = build_package(tmp_path / "candidates")
    service = harness.controller.connector_service
    harness.start()

    def send(action, **extra):
        payload = {"type": "connectors", "id": f"{action}-{len(harness.frames)}", "action": action,
                   "scope": harness.scope, **extra}
        frame = harness.command(payload)
        assert frame["error"] == "", f"{action}: {frame['error']}"
        return frame

    first_list = send("list")
    assert first_list["result"] == {"connectors": []}

    preview = send("preview", path=str(package), confirmed=False)["result"]
    assert preview["slug"] == "demo-echo"
    assert preview["installed"] is False
    # A preview registers nothing and writes nothing.
    assert harness.registrations == []
    assert not connectors_config_path(harness.config).exists()

    installed = send("install", path=str(package), confirmed=True)["result"]
    assert installed["installed"] is True
    assert installed["serverConnectorId"] == "platform-conn-123"
    assert len(harness.registrations) == 1
    assert harness.registrations[0][0] == "demo-echo"
    assert len(harness.registrations[0][3]) == 64
    row = service.registry.find(harness.owner, "demo-echo")
    assert row is not None and row["server_connector_id"] == "platform-conn-123"
    config = json.loads(connectors_config_path(harness.config).read_text(encoding="utf-8"))
    assert [spec["name"] for spec in config["servers"]] == ["demo-echo"]
    assert harness.refreshes == ["swap"]

    listed = send("list")["result"]["connectors"]
    assert [entry["slug"] for entry in listed] == ["demo-echo"]
    assert listed[0]["serverConnectorId"] == "platform-conn-123"

    removed = send("remove", slug="demo-echo", confirmed=True)["result"]
    assert removed["removed"] is True
    assert harness.unregistrations == ["platform-conn-123"]
    assert json.loads(connectors_config_path(harness.config).read_text(encoding="utf-8"))["servers"] == []
    assert harness.refreshes == ["swap", "swap"]
    assert send("list")["result"] == {"connectors": []}
    assert harness.finish() == 0


def test_identity_change_and_unavailable_are_actionable(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    package = build_package(tmp_path / "candidates")
    harness.start()
    foreign = harness.scope + "x"
    frame = harness.command({"type": "connectors", "id": "f1", "action": "install",
                             "path": str(package), "confirmed": True, "scope": foreign})
    assert frame["error"] == "CONNECTOR_IDENTITY_CHANGED"
    assert frame["result"] is None
    assert harness.controller.connector_service.registry.find(harness.owner, "demo-echo") is None
    assert not connectors_config_path(harness.config).exists()

    # Without the installer service nothing is runnable or installable.
    harness.controller.connector_service = None
    frame = harness.command({"type": "connectors", "id": "f2", "action": "list",
                             "scope": harness.scope})
    assert frame["error"] == "CONNECTOR_UNAVAILABLE"
    assert harness.finish() == 0
