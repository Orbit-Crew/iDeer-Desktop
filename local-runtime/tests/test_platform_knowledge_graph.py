"""Controlled knowledge-graph entry from the Desktop (#116).

Every test drives the real DesktopChat seam against a protocol fixture and a
real confirmed workspace: the view and generate actions read exactly what
the Server states (entity/relation/source facts bound to the frozen
revision, bounded for display), a malformed graph answer is a protocol
error instead of an invented view, and locate resolves the source document
against this device's workspace by (filename, frozen digest) with the
logical path staying a local display fact.
"""
from __future__ import annotations

import hashlib
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from core.file_service import WorkspaceFileStore, WorkspaceSelection
from core.files import RootConfig
from core.knowledge_import import KnowledgeImportRegistry
from core.platform_chat import DesktopChat
from core.receipt_ledger import profile_binding
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '77777777-7777-4777-8777-777777777777'
GUIDE = '甲零件属于乙组件。乙组件由甲零件与螺栓构成。\n'
MANIFEST = 'c' * 64

VIEW = {
    'knowledge_base_id': KB,
    'revision_id': REVISION,
    'revision_no': 1,
    'manifest_hash': MANIFEST,
    'status': 'completed',
    'generated': 1,
    'failed': 0,
    'documents': [{'document_id': 'doc-1', 'filename': 'guide.txt', 'status': 'completed'}],
    'sources': [{'document_id': 'doc-1', 'filename': 'guide.txt',
                 'content_hash': hashlib.sha256(GUIDE.encode()).hexdigest(), 'status': 'completed', 'error_code': None}],
    'entities': [{'name': '甲零件', 'type': '零件', 'document_id': 'doc-1', 'filename': 'guide.txt'},
                 {'name': '乙组件', 'type': '组件', 'document_id': 'doc-1', 'filename': 'guide.txt'}],
    'relations': [{'source': '甲零件', 'target': '乙组件', 'relation': '属于',
                   'document_id': 'doc-1', 'filename': 'guide.txt'}],
}


@contextmanager
def platform(view_payload=None):
    records = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            self.respond(json.loads(body) if body else {})

        def respond(self, body):
            records.append((self.command, self.path, body, dict(self.headers)))
            status, data = 200, {}
            if self.path == '/api/v1/auth/me':
                data = {'id': 'A', 'email': 'a@test.invalid', 'system_role': 'user', 'permissions': ['runs:create']}
            elif self.path.endswith('/graph') and self.command == 'GET':
                if view_payload is None:
                    data = VIEW
                else:
                    data = view_payload
            elif self.path.endswith('/graph') and self.command == 'POST':
                data = {'status': 'completed', 'generated': 1, 'failed': 0}
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


def prepare(tmp_path: Path, origin: str, *, work=True):
    """A DesktopChat with a confirmed workspace, mirroring desktop.py wiring."""
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    space = tmp_path / 'work'
    space.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-116', server_public_key='broker-key-116',
        session_token_ref='device-session-116',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    if work:
        WorkspaceSelection(config).select(str(space), confirmed=True)
    imports = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       knowledge_imports=imports, knowledge_files=knowledge_files)
    return chat, config, space


def test_view_projects_bounded_server_facts_without_generation(tmp_path):
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin, work=False)
        del records[:]

        view = chat.knowledge_graph(KB, REVISION, action='view')

        assert view['kbId'] == KB and view['revisionId'] == REVISION
        assert view['status'] == 'completed' and view['manifestHash'] == MANIFEST
        assert [entity['name'] for entity in view['entities']] == ['甲零件', '乙组件']
        assert view['relations'] == [
            {'source': '甲零件', 'target': '乙组件', 'relation': '属于',
             'documentId': 'doc-1', 'filename': 'guide.txt'}]
        assert view['sources'] == [
            {'documentId': 'doc-1', 'filename': 'guide.txt', 'contentHash': hashlib.sha256(GUIDE.encode()).hexdigest(),
             'status': 'completed', 'errorCode': ''}]
        # Read-only: the entry never triggers generation by viewing.
        assert not any(method == 'POST' for method, _path, _body, _headers in records)


def test_generate_posts_then_reads_the_view(tmp_path):
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin, work=False)
        del records[:]

        view = chat.knowledge_graph(KB, REVISION, action='generate')

        assert view['status'] == 'completed'
        assert any(method == 'POST' and path.endswith(f'/knowledge-revisions/{REVISION}/graph')
                   for method, path, _body, _headers in records)


def test_malformed_view_is_a_protocol_error(tmp_path):
    with platform(view_payload={'unexpected': True}) as (origin, _records):
        from core.platform_chat import ChatError
        chat, _config, _space = prepare(tmp_path, origin, work=False)
        with pytest.raises(ChatError) as error:
            chat.knowledge_graph(KB, REVISION, action='view')
        assert str(error.value) == 'CHAT_PROTOCOL_ERROR'


def test_locate_resolves_the_source_in_the_workspace(tmp_path):
    with platform() as (origin, records):
        chat, _config, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_text(GUIDE, encoding='utf-8')
        del records[:]

        located = chat.knowledge_graph(KB, REVISION, action='locate', document_id='doc-1')

        assert located['documentId'] == 'doc-1'
        assert located['logicalPath'].endswith('/guide.txt')
        # The path stays local: nothing about the workspace reached the Server.
        assert str(space) not in json.dumps(records)


def test_locate_reports_drift_instead_of_a_stale_path(tmp_path):
    with platform() as (origin, _records):
        chat, _config, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_text('已被修改的内容\n', encoding='utf-8')

        located = chat.knowledge_graph(KB, REVISION, action='locate', document_id='doc-1')

        assert located == {'kbId': KB, 'revisionId': REVISION, 'documentId': 'doc-1',
                           'missing': True, 'reason': 'content_drift'}


def test_locate_refuses_unknown_source_documents(tmp_path):
    from core.platform_chat import ChatError
    with platform() as (origin, _records):
        chat, _config, _space = prepare(tmp_path, origin, work=False)
        with pytest.raises(ChatError) as error:
            chat.knowledge_graph(KB, REVISION, action='locate', document_id='doc-other')
        assert str(error.value) == 'KNOWLEDGE_GRAPH_SOURCE_UNKNOWN'
