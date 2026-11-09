"""The user's library search across the real desktop loop (#98).

The only test that drives the whole device path at once: the stdin command
passes the exact-shape wire gate, the dispatch threads its own command id
into the seam, the seam writes the durable audit row into the profile's real
audit log before the reply leaves, and the emitted ``knowledge-search``
frame carries the citation view whose ``auditTaskId`` names that row. A
refusal keeps its fixed category on the same path.
"""
import base64
import json
import queue
import hashlib
import threading
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.audit import AuditKind, LocalAuditLog
from core.file_service import WorkspaceSelection
from core.knowledge_import import KnowledgeImportRegistry
from core.knowledge_index import KnowledgeIndexStore
from core.protocol import public_key_text
from core.receipt_ledger import profile_binding
from core.settings import RuntimeSettings, load_settings

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '88888888-8888-4888-8888-888888888888'
MANIFEST = hashlib.sha256(b'manifest-loop').hexdigest()
REPORT = 'report header line\nalpha in table body\nalpha after the table\n'
REPORT_LAYOUT = [{'kind': 'page', 'page': 4, 'line': 1, 'lines': 3},
                 {'kind': 'table', 'table': 2, 'line': 2, 'lines': 1}]


class SearchHarness:
    """Drive desktop.main() in a thread; await knowledge-search replies."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        config = tmp_path / "profile" / "settings.json"
        key = Ed25519PrivateKey.generate()
        settings = RuntimeSettings(
            server_url="http://127.0.0.1:108", user_id="account-108", device_id="device-108",
            session_token_ref="fixture-session", device_key_ref="fixture-key",
            device_public_key=public_key_text(key), server_public_key=public_key_text(key))
        settings.save(config)
        self.config = config
        self.frames: list[dict] = []
        self._pending = ""
        self._reply = threading.Event()
        self._reply_id = ""
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
            status=lambda: {"state": "authenticated"})
        gate = __import__("types").SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        monkeypatch.setattr(desktop, "own_process_tree", lambda: None)
        monkeypatch.setattr(desktop, "create_default_secret_store", lambda: secure)
        monkeypatch.setattr(desktop, "BrowserLogin", lambda *args: login)
        monkeypatch.setattr(desktop, "CompatibilityGate", lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, "load_controller", lambda *args, **kwargs: self.controller)
        monkeypatch.setattr(desktop.sys, "argv", ["desktop", "--config", str(config)])
        monkeypatch.setattr(desktop.sys, "stdin", Input())
        monkeypatch.setattr(desktop.sys, "stdout", Output())

    def select_workspace(self, path: Path) -> str:
        selection = WorkspaceSelection(self.config)
        selection.select(str(path), confirmed=True)
        return selection.scope()

    def _write(self, value: str) -> None:
        self._pending += value
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get("type") == "knowledge-search" and frame.get("id") == self._reply_id:
                self._reply.set()

    def start(self) -> None:
        self._thread = threading.Thread(
            target=lambda: self._exit.update(code=desktop.main()), daemon=True)
        self._thread.start()

    def search(self, payload: dict) -> dict:
        self._reply.clear()
        self._reply_id = payload["id"]
        self._lines.put(json.dumps(payload) + "\n")
        if not self._reply.wait(15):
            with self._lock:
                kinds = [frame.get("type") for frame in self.frames]
            raise RuntimeError(
                f"no knowledge-search reply for {payload.get('id')}; exit={self._exit} frames={kinds[-12:]}")
        with self._lock:
            for frame in reversed(self.frames):
                if frame.get("type") == "knowledge-search" and frame.get("id") == payload.get("id"):
                    return frame
        raise AssertionError("reply frame vanished")

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), "desktop.main did not stop"
        return self._exit.get("code", 1)


def _register_revision(config, space: Path) -> None:
    binding = profile_binding(load_settings(config))
    documents = [{'filename': 'report.txt', 'sha256': hashlib.sha256(REPORT.encode()).hexdigest(),
                  'bytes': len(REPORT), 'mime': 'text/plain'}]
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    registry.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=2,
                                  manifest_hash=MANIFEST, document_count=1,
                                  status='registered', error_code='', documents=documents))
    parse = {'status': 'parsed', 'parser': 'text-utf8', 'parserVersion': '1', 'errorCode': '',
             'layout': REPORT_LAYOUT}
    entries = [{'filename': 'report.txt', 'sha256': documents[0]['sha256'], 'bytes': len(REPORT),
                'mime': 'text/plain', 'parse': parse, '_text': REPORT}]
    index = KnowledgeIndexStore(config.with_name('knowledge-index.db'))
    index.index_revision(binding, REVISION, MANIFEST, entries)


def test_loop_search_threads_command_id_into_audit_and_reply(tmp_path, monkeypatch) -> None:
    harness = SearchHarness(tmp_path, monkeypatch)
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'report.txt').write_bytes(REPORT.encode('utf-8'))
    scope = harness.select_workspace(work)
    _register_revision(harness.config, work)
    harness.start()
    try:
        frame = harness.search({"type": "knowledge-search", "id": "ks-loop-1",
                                "kbId": KB, "revisionId": REVISION, "query": "ALPHA", "scope": scope})
        assert frame["error"] == ""
        result = frame["result"]
        # The command's own id names the durable audit record, on the wire
        # and in the profile's real audit log — a citation stays traceable.
        assert result["auditTaskId"] == "ks-loop-1"
        assert result["kbId"] == KB and result["revisionNo"] == 2
        assert result["engine"] == "bm25" and result["evidenceComplete"] is True
        hit = [chunk for chunk in result["chunks"] if chunk["position"]["line"] == 2][0]
        assert hit["position"]["page"] == 4 and hit["position"]["table"] == 2
        assert str(work) not in json.dumps(result)

        audit = LocalAuditLog(str(harness.config.with_name("audit.db")))
        rows = audit.recent(kind=AuditKind.EXECUTION)
        assert len(rows) == 1
        row = rows[0]
        assert row.capability == "local.knowledge.search" and row.task_id == "ks-loop-1"
        assert row.digest == MANIFEST
        assert row.detail["queryDigest"] == hashlib.sha256(b"ALPHA").hexdigest()
        assert row.detail["evidenceComplete"] is True
        assert "ALPHA" not in json.dumps(row.as_dict())
    finally:
        harness.finish()


def test_loop_search_refusal_keeps_its_fixed_category(tmp_path, monkeypatch) -> None:
    harness = SearchHarness(tmp_path, monkeypatch)
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'report.txt').write_bytes(REPORT.encode('utf-8'))
    scope = harness.select_workspace(work)
    harness.start()
    try:
        # No registration for this identity: the honest refusal crosses the
        # loop with its fixed category and no result at all.
        frame = harness.search({"type": "knowledge-search", "id": "ks-loop-2",
                                "kbId": KB, "revisionId": REVISION, "query": "ALPHA", "scope": scope})
        assert frame["error"] == "KNOWLEDGE_SEARCH_REVISION_UNREGISTERED"
        assert frame["result"] is None
    finally:
        harness.finish()
