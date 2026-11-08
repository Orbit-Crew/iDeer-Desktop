"""Knowledge version semantics unification (#101, decision 62).

一套版本规矩: the five families bind to the frozen Revision, 删除=库新版本,
物理清理 is the user's separate choice, caches expire in place until that
cleanup, and an unreachable platform serves the cached graph/wiki view
annotated 离线快照. Every test drives the real seams: the chat methods
against a protocol fixture, the stores directly, and — for the two new wire
commands — the real desktop.main() loop with a scripted stdin/stdout.
"""
from __future__ import annotations

import base64
import hashlib
import json
import queue
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.file_service import WorkspaceFileStore, WorkspaceSelection
from core.files import RootConfig
from core.knowledge_import import KnowledgeImportError, KnowledgeImportRegistry
from core.knowledge_index import KnowledgeIndexStore
from core.knowledge_snapshots import KnowledgeSnapshotError, KnowledgeSnapshotStore
from core.platform_chat import ChatError, DesktopChat
from core.receipt_ledger import profile_binding
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings
from core.protocol import public_key_text

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '77777777-7777-4777-8777-777777777777'
MANIFEST = 'c' * 64
GUIDE = '# marker\nlocal bytes that never upload\n'
NOTES = 'plain text notes\n'
GUIDE_HASH = hashlib.sha256(GUIDE.encode()).hexdigest()
NOTES_HASH = hashlib.sha256(NOTES.encode()).hexdigest()


def revision_payload(path, body, serial):
    documents = body['documents']
    manifest = hashlib.sha256(json.dumps(sorted(d['content_hash'] for d in documents)).encode()).hexdigest()
    return dict(id=f'rev-{serial}', resource_id=path.split('/')[3], revision_no=serial, status='draft',
                manifest_hash=manifest, document_count=len(documents))


@contextmanager
def platform(local_import_status=201):
    """The frozen local-imports endpoint, exactly as the #112 fixture."""
    records = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))

        def respond(self, body):
            records.append((self.path, body))
            status, data = 200, {}
            if self.path == '/api/v1/auth/me':
                data = {'id': 'A', 'email': 'a@test.invalid', 'system_role': 'user', 'permissions': ['runs:create']}
            elif self.path.endswith('/knowledge-revisions/local-imports'):
                status = local_import_status
                data = revision_payload(self.path, body, len(records)) if status == 201 else {}
            else:
                status, data = 404, {}
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}', records
    finally:
        server.shutdown()
        server.server_close()


def prepare(tmp_path: Path, origin: str, *, index=True, snapshots=True):
    """A DesktopChat with the knowledge stores wired, mirroring desktop.py."""
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    space = tmp_path / 'work'
    space.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-101', server_public_key='broker-key-101',
        session_token_ref='device-session-101',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    WorkspaceSelection(config).select(str(space), confirmed=True)
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    index_store = KnowledgeIndexStore(str(config.with_name('knowledge-index.db'))) if index else None
    snapshot_store = KnowledgeSnapshotStore(config.with_name('knowledge-snapshots.db')) if snapshots else None

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       knowledge_imports=registry, knowledge_files=knowledge_files,
                       knowledge_index=index_store, knowledge_snapshots=snapshot_store)
    return chat, registry, index_store, snapshot_store, config, space, profile_binding(load_settings(config))


def import_posts(records):
    return [(path, body) for path, body in records
            if path.endswith('/knowledge-revisions/local-imports')]


# --- 删除=库新版本: the document-level delete seam --------------------------


def test_delete_documents_registers_successor_and_keeps_history(tmp_path):
    """The successor revision carries exactly the surviving documents; the
    historical record stays with a pointer to its successor and the device
    index hands the surviving rows to the successor content-addressed."""
    with platform() as (origin, records):
        chat, registry, index_store, snapshots, config, space, binding = prepare(tmp_path, origin)
        guide = space / 'guide.md'
        notes = space / 'notes.txt'
        guide.write_bytes(GUIDE.encode('utf-8'))
        notes.write_bytes(NOTES.encode('utf-8'))
        chat.register_local_import(KB, [str(guide), str(notes)])
        assert index_store is not None
        # The fresh revision indexed both documents servable.
        old = registry.view(binding)[0]
        first_view = index_store.revision_view(binding, old['revisionId'], old['manifestHash'])
        assert first_view['state'] == 'ready' and first_view['servableDocuments'] == 2

        outcome = chat.delete_revision_documents(KB, old['revisionId'], [GUIDE_HASH])

        posts = import_posts(records)
        assert len(posts) == 2
        # The successor registration carries identity fields only, and only
        # the surviving document's.
        _, body = posts[1]
        assert [d['filename'] for d in body['documents']] == ['notes.txt']
        assert body['documents'][0]['content_hash'] == NOTES_HASH
        assert outcome['removedDocuments'] == 1
        assert outcome['revision']['revisionId'] == 'rev-2'
        assert outcome['revision']['documentCount'] == 1
        assert outcome['supersededRecordId'] == old['id']
        rows = registry.view(binding)
        assert len(rows) == 2
        by_revision = {row['revisionId']: row for row in rows}
        # The historical record keeps its frozen documents and gains the
        # pointer to the successor: history stays traceable device-side.
        assert by_revision['rev-1']['supersededBy'] == 'rev-2'
        assert by_revision['rev-1']['originalsMissing'] is False
        assert len(by_revision['rev-1']['documents']) == 2
        assert by_revision['rev-2']['supersededBy'] == ''
        # The successor serves exactly what survived; the deleted document
        # has no row content-addressed behind it.
        successor = index_store.revision_view(binding, 'rev-2', outcome['revision']['manifestHash'])
        assert successor['state'] == 'ready' and successor['servableDocuments'] == 1
        assert successor['documents'] == 1


def test_delete_refuses_unknown_revision_document_and_empty_library(tmp_path):
    """Every refusal is fixed-category and sends nothing: an unknown
    revision, a hash not frozen in it, deleting the whole library."""
    with platform() as (origin, records):
        chat, registry, index_store, snapshots, config, space, binding = prepare(tmp_path, origin)
        guide = space / 'guide.md'
        guide.write_bytes(GUIDE.encode('utf-8'))
        chat.register_local_import(KB, [str(guide)])
        old = registry.view(binding)[0]
        with pytest.raises(KnowledgeImportError) as unknown_revision:
            chat.delete_revision_documents(KB, '99999999-9999-4999-8999-999999999999', [GUIDE_HASH])
        assert unknown_revision.value.args[0] == 'KNOWLEDGE_DELETE_REVISION_UNKNOWN'
        with pytest.raises(KnowledgeImportError) as unknown_document:
            chat.delete_revision_documents(KB, old['revisionId'], ['a' * 64])
        assert unknown_document.value.args[0] == 'KNOWLEDGE_DELETE_DOCUMENT_UNKNOWN'
        with pytest.raises(KnowledgeImportError) as empty:
            chat.delete_revision_documents(KB, old['revisionId'], [GUIDE_HASH])
        assert empty.value.args[0] == 'KNOWLEDGE_DELETE_LIBRARY_EMPTY'
        with pytest.raises(ChatError) as malformed:
            chat.delete_revision_documents(KB, old['revisionId'], ['not-a-hash'])
        assert malformed.value.args[0] == 'CHAT_COMMAND_INVALID'
        # Nothing refused ever reached the platform or rewrote the record:
        # the one registration POST is the import this test started from.
        assert len(import_posts(records)) == 1
        rows = registry.view(binding)
        assert len(rows) == 1 and rows[0]['supersededBy'] == ''


# --- offline snapshots: the 离线快照 fallback -------------------------------

WIKI_VIEW = {
    'knowledge_base_id': KB, 'revision_id': REVISION, 'revision_no': 1, 'manifest_hash': MANIFEST,
    'status': 'partial', 'generated': 1, 'failed': 0, 'skipped': 1,
    'pages': [{'document_id': 'doc-1', 'filename': 'guide.txt', 'title': '甲零件与乙组件',
               'content_hash': GUIDE_HASH, 'status': 'completed', 'error_code': None}],
}
WIKI_PAGE = {
    'knowledge_base_id': KB, 'revision_id': REVISION, 'revision_no': 1, 'manifest_hash': MANIFEST,
    'document_id': 'doc-1', 'filename': 'guide.txt', 'title': '甲零件与乙组件',
    'content_hash': GUIDE_HASH, 'status': 'completed', 'error_code': None, 'body': '# 甲零件\n正文',
}
GRAPH_VIEW = {
    'revision_id': REVISION, 'revision_no': 1, 'manifest_hash': MANIFEST, 'status': 'completed',
    'generated': 1, 'failed': 0,
    'sources': [{'document_id': 'doc-1', 'filename': 'guide.txt', 'content_hash': GUIDE_HASH,
                 'status': 'completed', 'error_code': None}],
    'entities': [{'name': '甲零件', 'type': 'part', 'document_id': 'doc-1', 'filename': 'guide.txt'}],
    'relations': [],
}


@contextmanager
def wiki_platform(answers=2):
    """A wiki/graph endpoint that serves, then dies: the honest outage.

    The first ``answers`` content GETs answer from the fixture payloads
    (the auth probe never counts); afterwards the server is gone, so the
    next request fails at the socket — the exact outage the 离线快照
    fallback exists for.
    """
    records = []
    holder: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            records.append(self.path)
            content = self.path.endswith('/wiki') or self.path.endswith('/wiki/navigation') \
                or '/wiki/pages/' in self.path or self.path.endswith('/graph')
            status, data = 200, {}
            if self.path == '/api/v1/auth/me':
                data = {'id': 'A', 'email': 'a@test.invalid', 'system_role': 'user', 'permissions': ['runs:create']}
            elif self.path.endswith('/wiki'):
                data = WIKI_VIEW
            elif self.path.endswith('/wiki/navigation'):
                data = WIKI_VIEW
            elif '/wiki/pages/' in self.path:
                data = WIKI_PAGE
            elif self.path.endswith('/graph'):
                data = GRAPH_VIEW
            else:
                status, data = 404, {}
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            if content and len([p for p in records if p != '/api/v1/auth/me']) >= answers:
                # Enough live answers; then the platform goes away.
                threading.Thread(target=holder['kill'], daemon=True).start()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    holder['kill'] = server.shutdown
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}', records
    finally:
        server.shutdown()
        server.server_close()


def test_offline_wiki_view_falls_back_to_cached_snapshot(tmp_path):
    """A cached page list (and a cached page body) is served read-only with
    the 离线快照 annotation once the platform is unreachable; a navigation
    index without any cache refuses honestly instead of inventing one."""
    with wiki_platform(answers=2) as (origin, _records):
        chat, registry, index_store, snapshots, config, space, binding = prepare(tmp_path, origin)
        assert snapshots is not None
        first = chat.wiki(KB, REVISION, action='view')
        assert not first.get('offline')
        # The successful view was cached; the page read was cached per page.
        page = chat.wiki(KB, REVISION, action='read', document_id='doc-1')
        assert page['body'] == WIKI_PAGE['body']
        # The server died after two answers; both reads now ride the cache.
        offline_view = chat.wiki(KB, REVISION, action='view')
        assert offline_view['offline'] is True
        assert isinstance(offline_view.get('capturedAt'), str) and offline_view['capturedAt']
        assert [p['documentId'] for p in offline_view['pages']] == ['doc-1']
        offline_page = chat.wiki(KB, REVISION, action='read', document_id='doc-1')
        assert offline_page['offline'] is True and offline_page['body'] == WIKI_PAGE['body']
        with pytest.raises(ChatError) as never_generated:
            chat.wiki(KB, REVISION, action='navigate')
        # No cache for the navigation index means the honest refusal, never
        # a fabricated empty view.
        assert never_generated.value.args[0] == 'CHAT_SERVER_UNAVAILABLE'


def test_offline_graph_view_falls_back_and_generate_stays_online(tmp_path):
    """The graph view rides the same cache; a generate is a write and never
    serves from it — an unreachable platform refuses it outright."""
    with wiki_platform(answers=1) as (origin, _records):
        chat, registry, index_store, snapshots, config, space, binding = prepare(tmp_path, origin)
        first = chat.knowledge_graph(KB, REVISION, action='view')
        assert first['entities'][0]['name'] == '甲零件'
        assert not first.get('offline')
        offline = chat.knowledge_graph(KB, REVISION, action='view')
        assert offline['offline'] is True
        assert offline['manifestHash'] == MANIFEST
        with pytest.raises(ChatError) as refused:
            chat.knowledge_graph(KB, REVISION, action='generate')
        assert refused.value.args[0] == 'CHAT_SERVER_UNAVAILABLE'


# --- the stores behind 删除/清理/过期 ---------------------------------------


def test_snapshot_store_roundtrip_binding_scope_and_purge(tmp_path):
    store = KnowledgeSnapshotStore(tmp_path / 'knowledge-snapshots.db')
    assert store.error == ''
    binding = {'server_origin': 'http://x', 'user_id': 'A', 'device_id': 'D1',
               'device_public_key': 'k', 'broker_public_key': 'b'}
    other = dict(binding, user_id='B')
    assert store.save(binding, KB, REVISION, 1, MANIFEST, 'graph', {'kbId': KB, 'status': 'completed'})
    # The newest successful view wins; the capture time refreshes.
    assert store.save(binding, KB, REVISION, 1, MANIFEST, 'graph', {'kbId': KB, 'status': 'partial'})
    cached = store.fetch(binding, KB, REVISION, 'graph')
    assert cached is not None and cached['payload']['status'] == 'partial'
    assert cached['capturedAt']
    # Another identity never inherits a snapshot.
    assert store.fetch(other, KB, REVISION, 'graph') is None
    # Page kinds key by their frozen document id; other kinds stay absent.
    assert store.save(binding, KB, REVISION, 1, MANIFEST, 'wiki-page:doc-1', {'body': 'x'})
    assert store.fetch(binding, KB, REVISION, 'wiki-page:doc-1') is not None
    assert store.fetch(binding, KB, REVISION, 'wiki-page:doc-2') is None
    with pytest.raises(KnowledgeSnapshotError):
        store.save(binding, KB, REVISION, 1, MANIFEST, 'not-a-kind', {})
    with pytest.raises(KnowledgeSnapshotError):
        store.save(binding, KB, REVISION, 1, MANIFEST, 'wiki-page:bad id!', {})
    assert store.purge(binding, KB, REVISION) == 2
    assert store.fetch(binding, KB, REVISION, 'graph') is None
    assert store.fetch(binding, KB, REVISION, 'wiki-page:doc-1') is None


def test_index_carry_over_and_purge(tmp_path):
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    binding = {'server_origin': 'http://x', 'user_id': 'A', 'device_id': 'D1',
               'device_public_key': 'k', 'broker_public_key': 'b'}
    entries = [
        {'filename': 'guide.md', 'sha256': GUIDE_HASH, 'bytes': 10, 'mime': 'text/markdown',
         'parse': {'status': 'parsed'}, '_text': GUIDE},
        {'filename': 'notes.txt', 'sha256': NOTES_HASH, 'bytes': 10, 'mime': 'text/plain',
         'parse': {'status': 'parsed'}, '_text': NOTES},
    ]
    store.index_revision(binding, REVISION, MANIFEST, entries)
    successor_hash = 'd' * 64
    moved = store.carry_over_revision(binding, REVISION, MANIFEST, 'rev-next', successor_hash,
                                      [NOTES_HASH], 1)
    assert moved == 1
    successor = store.revision_view(binding, 'rev-next', successor_hash)
    assert successor['state'] == 'ready' and successor['servableDocuments'] == 1
    search = store.search(binding, 'rev-next', successor_hash, 'plain notes', limit=5)
    assert search['documentCount'] == 1
    assert [document['filename'] for document in search['documents']] == ['notes.txt']
    # The deleted document's text serves nowhere in the successor.
    gone = store.search(binding, 'rev-next', successor_hash, 'marker', limit=5)
    assert gone['documents'] == []
    # Purge physically removes every row of the identity and nothing else.
    assert store.purge_revision(binding, 'rev-next', successor_hash) > 0
    assert store.revision_view(binding, 'rev-next', successor_hash)['state'] == 'missing'
    assert store.revision_view(binding, REVISION, MANIFEST)['state'] == 'ready'


def test_registry_marks_cleanup_and_successor(tmp_path):
    registry = KnowledgeImportRegistry(tmp_path / 'knowledge-imports.db')
    binding = {'server_origin': 'http://x', 'user_id': 'A', 'device_id': 'D1',
               'device_public_key': 'k', 'broker_public_key': 'b'}
    registry.record(binding, dict(kb_id=KB, status='registered', revision_id=REVISION,
                                  revision_no=1, manifest_hash=MANIFEST, document_count=2,
                                  documents=[{'filename': 'guide.md', 'sha256': GUIDE_HASH,
                                              'bytes': 10, 'mime': 'text/markdown'}]))
    row = registry.view(binding)[0]
    assert row['originalsMissing'] is False and row['supersededBy'] == ''
    assert registry.mark_originals_missing(binding, KB, REVISION, True)
    assert registry.view(binding)[0]['originalsMissing'] is True
    assert registry.mark_superseded(binding, row['id'], 'rev-next')
    updated = registry.view(binding)[0]
    assert updated['supersededBy'] == 'rev-next'
    assert updated['originalsMissing'] is True


# --- the wire: desktop.main() with the two new commands ---------------------


class KnowledgeWireHarness:
    """Drive desktop.main() in a thread; replies matched by (type, id)."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        config = tmp_path / 'profile' / 'settings.json'
        key = Ed25519PrivateKey.generate()
        settings = RuntimeSettings(
            server_url='http://127.0.0.1:108', user_id='account-101', device_id='device-101',
            session_token_ref='fixture-session', device_key_ref='fixture-key',
            device_public_key=public_key_text(key), server_public_key=public_key_text(key),
            business_token_ref='fixture-business', business_expires_at='2099-01-01T00:00:00+00:00')
        settings.save(config)
        self.config = config
        self.login_state = {'value': 'authenticated'}
        self.frames: list[dict] = []
        self._reply = threading.Event()
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._exit: dict[str, int] = {}
        self.scope = ''

        class Client:
            connected = True
            active = 0
            file_service = __import__('types').SimpleNamespace()

            def begin_install_drain(self):
                pass

            def abort_install_drain(self):
                pass

            def active_task_count(self):
                return self.active

        class Controller:
            settings = __import__('types').SimpleNamespace(session_token='synthetic')

            def __init__(self):
                self.client = Client()

            def start(self):
                pass

            def status(self):
                return __import__('types').SimpleNamespace(connection='connected')

            def stop(self):
                pass

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

        secure = __import__('types').SimpleNamespace(get=lambda reference: base64.b64encode(
            key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        login = __import__('types').SimpleNamespace(
            secure=secure, restore=lambda: None, server_origin=lambda: 'http://127.0.0.1:108',
            status=lambda: {'state': self.login_state['value']})
        gate = __import__('types').SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        monkeypatch.setattr(desktop, 'own_process_tree', lambda: None)
        monkeypatch.setattr(desktop, 'create_default_secret_store', lambda: secure)
        monkeypatch.setattr(desktop, 'BrowserLogin', lambda *args: login)
        monkeypatch.setattr(desktop, 'CompatibilityGate', lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, 'load_controller', lambda *args, **kwargs: Controller())
        monkeypatch.setattr(desktop.sys, 'argv', ['desktop', '--config', str(config)])
        monkeypatch.setattr(desktop.sys, 'stdin', Input())
        monkeypatch.setattr(desktop.sys, 'stdout', Output())

    def select_workspace(self, path: Path) -> None:
        selection = WorkspaceSelection(self.config)
        selection.select(str(path), confirmed=True)
        self.scope = selection.scope()

    def _write(self, value: str) -> None:
        pending = getattr(self, '_pending', '')
        pending += value
        while '\n' in pending:
            line, pending = pending.split('\n', 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get('v') == 1 and 'id' in frame:
                self._reply.set()
        self._pending = pending

    def start(self) -> None:
        self._pending = ''
        self._thread = threading.Thread(
            target=lambda: self._exit.update(code=desktop.main()), daemon=True)
        self._thread.start()

    def command(self, payload: dict) -> dict | None:
        import time
        marker = self._frame_count()
        self._lines.put(json.dumps(payload) + '\n')
        deadline_time = time.time() + 10
        while time.time() < deadline_time:
            reply = self._find(payload.get('type'), payload.get('id'), after=marker)
            if reply is not None:
                return reply
            time.sleep(0.05)
        raise RuntimeError(f'no reply for {payload.get("id")}; frames={self.frames[-8:]}')

    def _frame_count(self) -> int:
        with self._lock:
            return len(self.frames)

    def _find(self, frame_type, frame_id, after: int = 0) -> dict | None:
        with self._lock:
            frames = self.frames[after:]
        for frame in reversed(frames):
            if frame.get('type') == frame_type and frame.get('id') == frame_id:
                return frame
        return None

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), 'desktop.main did not stop'
        return self._exit.get('code', 1)

    def wait_for_status(self, predicate, timeout: float = 5.0) -> dict:
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                frames = [frame for frame in self.frames
                          if frame.get('v') == 1 and 'knowledgeImports' in frame]
            for frame in reversed(frames):
                if predicate(frame):
                    return frame
            time.sleep(0.05)
        raise AssertionError('no matching status frame arrived')


def test_wire_cleanup_purges_stores_and_marks_originals(tmp_path, monkeypatch) -> None:
    harness = KnowledgeWireHarness(tmp_path, monkeypatch)
    work = tmp_path / 'work'
    work.mkdir()
    harness.select_workspace(work)
    registry = KnowledgeImportRegistry(harness.config.with_name('knowledge-imports.db'))
    index_store = KnowledgeIndexStore(str(harness.config.with_name('knowledge-index.db')))
    snapshot_store = KnowledgeSnapshotStore(harness.config.with_name('knowledge-snapshots.db'))
    binding = profile_binding(load_settings(harness.config))
    registry.record(binding, dict(kb_id=KB, status='registered', revision_id=REVISION,
                                  revision_no=1, manifest_hash=MANIFEST, document_count=1,
                                  documents=[{'filename': 'guide.md', 'sha256': GUIDE_HASH,
                                              'bytes': 10, 'mime': 'text/markdown'}]))
    index_store.index_revision(binding, REVISION, MANIFEST, [
        {'filename': 'guide.md', 'sha256': GUIDE_HASH, 'bytes': 10, 'mime': 'text/markdown',
         'parse': {'status': 'parsed'}, '_text': GUIDE}])
    snapshot_store.save(binding, KB, REVISION, 1, MANIFEST, 'graph', {'kbId': KB})
    harness.start()
    try:
        reply = harness.command({'type': 'knowledge-revision-cleanup', 'id': 'kc-1',
                                 'kbId': KB, 'revisionId': REVISION, 'manifestHash': MANIFEST,
                                 'scope': harness.scope})
        assert reply['error'] == ''
        assert reply['result'] == {'kbId': KB, 'revisionId': REVISION,
                                   'indexPurged': True, 'snapshotsPurged': 1}
        assert index_store.revision_view(binding, REVISION, MANIFEST)['state'] == 'missing'
        assert snapshot_store.fetch(binding, KB, REVISION, 'graph') is None
        assert registry.view(binding)[0]['originalsMissing'] is True
        # The marker rides the status snapshot with the honest annotation.
        status = harness.wait_for_status(lambda frame: any(
            row.get('originalsMissing') for row in frame['knowledgeImports']))
        assert status['knowledgeImports'][0]['originalsMissing'] is True
        # An unknown revision refuses with its fixed category.
        reply = harness.command({'type': 'knowledge-revision-cleanup', 'id': 'kc-2',
                                 'kbId': KB, 'revisionId': '99999999-9999-4999-8999-999999999999',
                                 'manifestHash': MANIFEST, 'scope': harness.scope})
        assert reply['error'] == 'KNOWLEDGE_CLEANUP_REVISION_UNKNOWN'
    finally:
        harness.finish()


def test_wire_gate_drops_malformed_revision_commands(tmp_path, monkeypatch) -> None:
    harness = KnowledgeWireHarness(tmp_path, monkeypatch)
    work = tmp_path / 'work'
    work.mkdir()
    harness.select_workspace(work)
    harness.start()
    try:
        malformed = [
            {'type': 'knowledge-revision-delete-documents', 'id': 'kd-1', 'kbId': KB,
             'revisionId': REVISION, 'scope': harness.scope},
            {'type': 'knowledge-revision-delete-documents', 'id': 'kd-2', 'kbId': KB,
             'revisionId': REVISION, 'contentHashes': ['zz'], 'scope': harness.scope},
            {'type': 'knowledge-revision-delete-documents', 'id': 'kd-3', 'kbId': KB,
             'revisionId': REVISION, 'contentHashes': [], 'scope': harness.scope},
            {'type': 'knowledge-revision-cleanup', 'id': 'kc-3', 'kbId': KB,
             'revisionId': REVISION, 'scope': harness.scope},
            {'type': 'knowledge-revision-cleanup', 'id': 'kc-4', 'kbId': KB,
             'revisionId': REVISION, 'manifestHash': 'short', 'scope': harness.scope},
            {'type': 'knowledge-revision-cleanup', 'id': 'kc-5', 'kbId': KB,
             'revisionId': REVISION, 'manifestHash': MANIFEST, 'extra': True, 'scope': harness.scope},
        ]
        for command in malformed:
            harness._lines.put(json.dumps(command) + '\n')
        import time
        time.sleep(1.0)
        # The wire gate dropped every malformed command: no reply frame of
        # either type exists, and the loop keeps ticking.
        with harness._lock:
            types = [frame.get('type') for frame in harness.frames]
        assert 'knowledge-revision-delete-documents' not in types
        assert 'knowledge-revision-cleanup' not in types
        assert harness._thread.is_alive()
    finally:
        harness.finish()


def test_wire_delete_documents_reaches_the_registration_seam(tmp_path, monkeypatch) -> None:
    """The wire command routes into the chat seam; the harness's platform
    address is a dead port, so the registration honestly fails and records a
    failed row — the display never impersonates a successor revision."""
    harness = KnowledgeWireHarness(tmp_path, monkeypatch)
    work = tmp_path / 'work'
    work.mkdir()
    harness.select_workspace(work)
    registry = KnowledgeImportRegistry(harness.config.with_name('knowledge-imports.db'))
    binding = profile_binding(load_settings(harness.config))
    registry.record(binding, dict(kb_id=KB, status='registered', revision_id=REVISION,
                                  revision_no=1, manifest_hash=MANIFEST, document_count=2,
                                  documents=[{'filename': 'guide.md', 'sha256': GUIDE_HASH,
                                              'bytes': 10, 'mime': 'text/markdown'},
                                             {'filename': 'notes.txt', 'sha256': NOTES_HASH,
                                              'bytes': 10, 'mime': 'text/plain'}]))
    harness.start()
    try:
        reply = harness.command({'type': 'knowledge-revision-delete-documents', 'id': 'kd-9',
                                 'kbId': KB, 'revisionId': REVISION,
                                 'contentHashes': [GUIDE_HASH], 'scope': harness.scope})
        assert reply['error'] == 'CHAT_SERVER_UNAVAILABLE'
        assert reply['result'] is None
        rows = registry.view(binding)
        # The registered row is untouched; the failed attempt keeps its own
        # honest row with the intended remaining documents.
        registered = [row for row in rows if row['status'] == 'registered']
        failed = [row for row in rows if row['status'] == 'failed']
        assert len(registered) == 1 and registered[0]['supersededBy'] == ''
        assert len(failed) == 1 and failed[0]['errorCode'] == 'CHAT_SERVER_UNAVAILABLE'
        assert [d['sha256'] for d in failed[0]['documents']] == [NOTES_HASH]
    finally:
        harness.finish()
