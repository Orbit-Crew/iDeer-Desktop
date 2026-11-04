"""The human file-browsing seam: guard-checked workspace reads, no consent (#94).

The Desktop shell reaches the confirmed workspace only through the ``files``
control command: a fixed per-action wire gate, the profile scope binding, and
the same path discipline as the Agent's read path. Nothing here touches the
consent store, the policy engine or the directory-grant ledger — a human
looking at their own bound folder is free, and Agent material-taking keeps its
approval flow. Physical paths leave the runtime only through ``locate``,
addressed to the trusted main process and never rendered to the renderer.
"""
import base64
import json
import os
import queue
import threading
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.file_service import (
    MAX_ENTRIES,
    MAX_PREVIEW_IMAGE_BYTES,
    MAX_PREVIEW_TEXT_BYTES,
    WorkspaceFileStore,
    WorkspaceSelection,
)
from core.files import FileAccessError, RootConfig
from core.protocol import public_key_text
from core.settings import RuntimeSettings

PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8


class FilesHarness:
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
        self.login_state = {"value": "authenticated"}
        self.frames: list[dict] = []
        self._pending = ""
        self._reply = threading.Event()
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._exit: dict[str, int] = {}

        class Client:
            connected = True
            active = 0
            file_service = None

            def begin_install_drain(self):
                pass

            def active_task_count(self):
                return self.active

        class Controller:
            settings = __import__("types").SimpleNamespace(session_token="synthetic")

            def __init__(self):
                self.client = Client()
                self.client.file_service = __import__("types").SimpleNamespace()

            def start(self):
                pass

            def status(self):
                return __import__("types").SimpleNamespace(connection="connected")

            def stop(self):
                pass

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

        secure = __import__("types").SimpleNamespace(get=lambda reference: base64.b64encode(
            key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        login = __import__("types").SimpleNamespace(
            secure=secure, restore=lambda: None, server_origin=lambda: "http://127.0.0.1:108",
            status=lambda: {"state": self.login_state["value"]})
        gate = __import__("types").SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        monkeypatch.setattr(desktop, "own_process_tree", lambda: None)
        monkeypatch.setattr(desktop, "create_default_secret_store", lambda: secure)
        monkeypatch.setattr(desktop, "BrowserLogin", lambda *args: login)
        monkeypatch.setattr(desktop, "CompatibilityGate", lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, "load_controller", lambda *args, **kwargs: self.controller)
        monkeypatch.setattr(desktop.sys, "argv", ["desktop", "--config", str(config)])
        monkeypatch.setattr(desktop.sys, "stdin", Input())
        monkeypatch.setattr(desktop.sys, "stdout", Output())

    # -- harness driving ----------------------------------------------------

    def select_workspace(self, path: Path) -> str:
        selection = WorkspaceSelection(self.config)
        root = selection.select(str(path), confirmed=True)["logicalRoot"]
        self.scope = selection.scope()
        return root

    def _write(self, value: str) -> None:
        self._pending += value
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get("type") == "files":
                self._reply.set()

    def start(self) -> None:
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
                f"no files reply for {payload.get('id')}; exit={self._exit} frames={kinds[-12:]}")
        with self._lock:
            for frame in reversed(self.frames):
                if frame.get("type") == "files" and frame.get("id") == payload.get("id"):
                    return frame
        raise AssertionError("reply frame vanished")

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), "desktop.main did not stop"
        return self._exit.get("code", 1)


def make_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FilesHarness:
    # Built inside the test body, like the connectors harness: the stdin/stdout
    # patches must land during the call phase, after the runner re-arms its own
    # capture around sys.stdout.
    return FilesHarness(tmp_path, monkeypatch)


def browse(harness: FilesHarness, action: str, path: str, *, scope: str | None = None) -> dict:
    frame = harness.command({"type": "files", "id": "f-1", "action": action, "path": path,
                             "scope": harness.scope if scope is None else scope})
    return frame


def seeded_work(tmp_path: Path) -> Path:
    work = tmp_path / "work"
    (work / "src").mkdir(parents=True)
    # Exact bytes: text-mode writes would translate newlines on Windows.
    (work / "src" / "main.py").write_bytes(b"print('hi')\n")
    (work / "README.md").write_bytes(b"# hello\n")
    (work / ".env").write_bytes(b"SECRET=1\n")
    (work / ".git").mkdir()
    (work / "node_modules").mkdir()
    return work


def test_browse_lists_directories_first_and_hides_protected_entries(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        frame = browse(harness, "list", root)
        assert frame["error"] == ""
        result = frame["result"]
        # Directories first; .env, .git and node_modules stay invisible.
        assert [(entry["name"], entry["kind"]) for entry in result["entries"]] == [
            ("src", "dir"), ("README.md", "file")]
        assert result["truncated"] is False
        assert result["entries"][1]["size"] == len("# hello\n")
    finally:
        harness.finish()


def test_browse_read_text_exact_and_truncated_at_cap(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        frame = browse(harness, "read", root + "/README.md")
        assert frame["error"] == ""
        assert frame["result"] == {"kind": "text", "content": "# hello\n", "truncated": False}
        big = work / "big.log"
        big.write_text("x" * (MAX_PREVIEW_TEXT_BYTES + 10), encoding="utf-8")
        frame = browse(harness, "read", root + "/big.log")
        assert frame["error"] == ""
        assert frame["result"]["truncated"] is True
        assert len(frame["result"]["content"]) == MAX_PREVIEW_TEXT_BYTES
    finally:
        harness.finish()


def test_browse_read_image_returns_base64_and_rejects_oversize(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        (work / "logo.png").write_bytes(PNG_MAGIC)
        frame = browse(harness, "read", root + "/logo.png")
        assert frame["error"] == ""
        assert frame["result"]["kind"] == "image"
        assert frame["result"]["mime"] == "image/png"
        assert base64.b64decode(frame["result"]["data"]) == PNG_MAGIC
        (work / "huge.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (MAX_PREVIEW_IMAGE_BYTES + 1))
        frame = browse(harness, "read", root + "/huge.png")
        assert frame["error"] == "FILE_TOO_LARGE"
    finally:
        harness.finish()


def test_browse_read_rejects_binary_as_external_only(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        (work / "blob.bin").write_bytes(b"ok\x00binary")
        frame = browse(harness, "read", root + "/blob.bin")
        assert frame["error"] == "FILE_BINARY"
        frame = browse(harness, "read", root + "/missing.txt")
        assert frame["error"] == "NOT_FOUND"
        frame = browse(harness, "read", root + "/src")
        assert frame["error"] == "NOT_A_FILE"
    finally:
        harness.finish()


def test_browse_locate_returns_physical_path_for_main_only(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        frame = browse(harness, "locate", root + "/README.md")
        assert frame["error"] == ""
        assert Path(frame["result"]["physical"]) == (work / "README.md")
        frame = browse(harness, "locate", root + "/../../outside.txt")
        assert frame["error"] in {"OUTSIDE_ALLOWED_ROOTS", "INVALID_PATH"}
    finally:
        harness.finish()


def test_browse_rejects_scope_mismatch_and_unauthenticated(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        frame = browse(harness, "list", root, scope="stale-scope")
        assert frame["error"] == "WORKSPACE_UNAVAILABLE"
        harness.login_state["value"] = "signed-out"
        frame = browse(harness, "list", root)
        assert frame["error"] == "WORKSPACE_UNAVAILABLE"
    finally:
        harness.finish()


def test_browse_records_no_consent_and_no_grant_rows(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        for action, path in (("list", root), ("read", root + "/README.md"), ("locate", root)):
            frame = browse(harness, action, path)
            assert frame["error"] == ""
    finally:
        harness.finish()
    settings = RuntimeSettings.from_dict(json.loads(harness.config.read_text(encoding="utf-8")))
    assert settings.directory_grants == []


def test_wire_gate_drops_malformed_files_commands(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    root = harness.select_workspace(work)
    harness.start()
    try:
        bad = [
            {"type": "files", "id": "x1", "action": "write", "path": root, "scope": harness.scope},
            {"type": "files", "id": "x2", "action": "list", "path": root},
            {"type": "files", "id": "x3", "action": "list", "path": root, "scope": harness.scope,
             "extra": 1},
            {"type": "files", "id": "x4", "action": "read", "path": "relative/path",
             "scope": harness.scope},
            {"type": "files", "id": "x5", "action": "list", "path": "/" + "a" * 5000,
             "scope": harness.scope},
        ]
        for payload in bad:
            harness.command(payload, expect_reply=False)
    finally:
        harness.finish()
    replies = [frame for frame in harness.frames if frame.get("type") == "files"]
    assert replies == []


def test_store_preview_and_list_details_discipline(tmp_path) -> None:
    work = tmp_path / "ws"
    (work / "sub").mkdir(parents=True)
    (work / "sub" / "note.txt").write_bytes("数据\n".encode("utf-8"))
    store = WorkspaceFileStore([RootConfig("/ws", work, resolve_root=False)])
    entries, truncated = store.list_details_with_limit("/ws")
    assert [(entry["name"], entry["kind"]) for entry in entries] == [("sub", "dir")]
    entries, _ = store.list_details_with_limit("/ws/sub")
    assert entries == [{"name": "note.txt", "kind": "file", "size": 7}]
    assert store.preview("/ws/sub/note.txt") == {
        "kind": "text", "content": "数据\n", "truncated": False}
    with pytest.raises(FileAccessError) as rejected:
        store.list_details_with_limit("/ws/sub/note.txt")
    assert rejected.value.code == "NOT_A_DIRECTORY"


def test_store_preview_handles_truncated_utf8_boundary(tmp_path) -> None:
    work = tmp_path / "ws"
    work.mkdir()
    payload = ("鹿" * 400000).encode("utf-8")  # 3 bytes per character, over the cap
    (work / "cut.txt").write_bytes(payload)
    store = WorkspaceFileStore([RootConfig("/ws", work, resolve_root=False)])
    result = store.preview("/ws/cut.txt")
    assert result["truncated"] is True
    # The capped read ends inside one multibyte character; the decoder drops
    # the cut tail instead of failing, so the kept bytes stay whole characters.
    kept = MAX_PREVIEW_TEXT_BYTES - (MAX_PREVIEW_TEXT_BYTES % 3)
    assert result["content"].encode("utf-8") == payload[:kept]
    assert len(result["content"]) == kept // 3


def test_store_preview_enforces_entry_cap(tmp_path) -> None:
    work = tmp_path / "ws"
    work.mkdir()
    for index in range(MAX_ENTRIES + 2):
        (work / f"f{index:04d}.txt").write_text("x", encoding="utf-8")
    store = WorkspaceFileStore([RootConfig("/ws", work, resolve_root=False)])
    entries, truncated = store.list_details_with_limit("/ws")
    # One past-cap read proves the truncation; the visible list itself is
    # trimmed to the cap so the honest notice never overcounts.
    assert truncated is True
    assert len(entries) == MAX_ENTRIES


@pytest.mark.skipif(__import__("os").name != "nt", reason="requires Windows junctions")
def test_browse_skips_a_junction_entry_and_keeps_the_directory_browsable(tmp_path, monkeypatch) -> None:
    harness = make_harness(tmp_path, monkeypatch)
    work = seeded_work(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"secret")
    junction = work / "linked"
    if os.system(f'cmd /c mklink /J "{junction}" "{outside}" >NUL') != 0:
        pytest.skip("junction creation is unavailable")
    root = harness.select_workspace(work)
    harness.start()
    try:
        frame = browse(harness, "list", root)
        assert frame["error"] == ""
        names = [entry["name"] for entry in frame["result"]["entries"]]
        # The junction never surfaces, but the rest of the folder stays
        # browsable instead of failing wholesale.
        assert "linked" not in names
        assert "src" in names and "README.md" in names
        frame = browse(harness, "read", root + "/linked/secret.txt")
        assert frame["error"] == "OUTSIDE_ALLOWED_ROOTS"
    finally:
        harness.finish()
