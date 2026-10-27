"""Controlled wiki entry from the Desktop (#118, #119).

Every test drives the real DesktopChat seam against a protocol fixture: the
view action reads exactly what the Server states (page list, progress, and
frozen source bindings, bounded for display, never bodies), generate posts
to the Server's wiki endpoint and re-reads the list, read fetches one
page whose document id must be well-formed and frozen on the Server — a
malformed answer is a protocol error instead of an invented page, and a
skipped page projects as exactly that: its fixed category, never text.
The #119 navigate action projects the index with links, backlinks, and the
association graph, derived only from this revision's own frozen artifacts.
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
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '77777777-7777-4777-8777-777777777777'
GUIDE = '甲零件属于乙组件。乙组件由甲零件与螺栓构成。\n'
MANIFEST = 'c' * 64
GUIDE_HASH = hashlib.sha256(GUIDE.encode()).hexdigest()
GUIDE_BODY = '# 甲零件与乙组件\n\n甲零件属于乙组件，乙组件由甲零件与螺栓构成。'

PAGE_COMPLETED = {'document_id': 'doc-1', 'filename': 'guide.txt', 'title': '甲零件与乙组件',
                  'content_hash': GUIDE_HASH, 'status': 'completed', 'error_code': None}
PAGE_SKIPPED = {'document_id': 'doc-2', 'filename': 'policy.txt', 'title': '',
                'content_hash': 'e' * 64, 'status': 'skipped', 'error_code': 'GRAPH_CONTENT_DRIFTED'}

VIEW = {
    'knowledge_base_id': KB,
    'revision_id': REVISION,
    'revision_no': 1,
    'manifest_hash': MANIFEST,
    'status': 'partial',
    'generated': 1,
    'failed': 0,
    'skipped': 1,
    'pages': [PAGE_COMPLETED, PAGE_SKIPPED],
}

PAGE = {
    'knowledge_base_id': KB,
    'revision_id': REVISION,
    'revision_no': 1,
    'manifest_hash': MANIFEST,
    'document_id': 'doc-1',
    'filename': 'guide.txt',
    'title': '甲零件与乙组件',
    'content_hash': GUIDE_HASH,
    'status': 'completed',
    'error_code': None,
    'body': GUIDE_BODY,
}

NAVIGATION = {
    'knowledge_base_id': KB,
    'revision_id': REVISION,
    'revision_no': 1,
    'manifest_hash': MANIFEST,
    'status': 'partial',
    'generated': 1,
    'failed': 0,
    'skipped': 1,
    'pages': [
        {'document_id': 'doc-1', 'filename': 'guide.txt', 'title': '甲零件与乙组件',
         'content_hash': GUIDE_HASH, 'status': 'completed', 'error_code': None,
         'links': [{'document_id': 'doc-2', 'title': '', 'status': 'skipped'}],
         'missing_links': ['未登记的文档'],
         'backlinks': []},
        {'document_id': 'doc-2', 'filename': 'policy.txt', 'title': '',
         'content_hash': 'e' * 64, 'status': 'skipped', 'error_code': 'GRAPH_CONTENT_DRIFTED',
         'links': [],
         'missing_links': [],
         'backlinks': [{'document_id': 'doc-1', 'title': '甲零件与乙组件', 'status': 'completed'}]},
    ],
    'associations': {
        'status': 'partial',
        'generated': 1,
        'failed': 0,
        'sources': [
            {'document_id': 'doc-1', 'filename': 'guide.txt', 'content_hash': GUIDE_HASH,
             'status': 'completed', 'error_code': None},
            {'document_id': 'doc-2', 'filename': 'policy.txt', 'content_hash': 'e' * 64,
             'status': 'skipped', 'error_code': 'GRAPH_CONTENT_DRIFTED'},
        ],
        'entities': [{'name': '乙组件', 'type': 'component', 'document_id': 'doc-1',
                      'filename': 'guide.txt', 'content_hash': GUIDE_HASH}],
        'relations': [{'source': '甲零件', 'target': '乙组件', 'relation': '构成',
                       'document_id': 'doc-1', 'filename': 'guide.txt', 'content_hash': GUIDE_HASH}],
    },
}


@contextmanager
def platform(view_payload=None, page_payload=None, navigation_payload=None):
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
            elif self.path.endswith('/wiki') and self.command == 'GET':
                if view_payload is None:
                    data = VIEW
                else:
                    data = view_payload
            elif self.path.endswith('/wiki') and self.command == 'POST':
                data = {'status': 'completed', 'generated': 2, 'failed': 0, 'skipped': 0}
            elif self.path.endswith('/wiki/navigation') and self.command == 'GET':
                if navigation_payload is None:
                    data = NAVIGATION
                else:
                    data = navigation_payload
            elif '/wiki/pages/' in self.path and self.command == 'GET':
                if page_payload is None:
                    data = PAGE
                else:
                    data = page_payload
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


def prepare(tmp_path: Path, origin: str):
    """A DesktopChat with a confirmed workspace, mirroring desktop.py wiring."""
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    space = tmp_path / 'work'
    space.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-118', server_public_key='broker-key-118',
        session_token_ref='device-session-118',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
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


def test_view_projects_bounded_page_list_with_progress_and_sources(tmp_path):
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin)
        del records[:]

        view = chat.wiki(KB, REVISION, action='view')

        assert view['kbId'] == KB and view['revisionId'] == REVISION
        assert view['status'] == 'partial' and view['manifestHash'] == MANIFEST
        assert view['generated'] == 1 and view['failed'] == 0 and view['skipped'] == 1
        assert view['pages'] == [
            {'documentId': 'doc-1', 'filename': 'guide.txt', 'title': '甲零件与乙组件',
             'contentHash': GUIDE_HASH, 'status': 'completed', 'errorCode': ''},
            {'documentId': 'doc-2', 'filename': 'policy.txt', 'title': '',
             'contentHash': 'e' * 64, 'status': 'skipped', 'errorCode': 'GRAPH_CONTENT_DRIFTED'},
        ]
        # Read-only: the entry never triggers generation by viewing.
        assert not any(method == 'POST' for method, _path, _body, _headers in records)


def test_generate_posts_then_reads_the_list(tmp_path):
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin)
        del records[:]

        view = chat.wiki(KB, REVISION, action='generate')

        assert view['status'] == 'partial'
        posts = [path for method, path, _body, _headers in records if method == 'POST']
        assert posts == [f'/api/resources/{KB}/knowledge-revisions/{REVISION}/wiki']


def test_read_fetches_one_page_body_with_its_source(tmp_path):
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin)
        del records[:]

        page = chat.wiki(KB, REVISION, action='read', document_id='doc-1')

        assert page['kbId'] == KB and page['revisionId'] == REVISION
        assert page['documentId'] == 'doc-1'
        assert page['title'] == '甲零件与乙组件'
        assert page['body'] == GUIDE_BODY
        assert page['contentHash'] == GUIDE_HASH and page['status'] == 'completed'
        reads = [path for method, path, _body, _headers in records if method == 'GET' and '/wiki/pages/' in path]
        assert reads == [f'/api/resources/{KB}/knowledge-revisions/{REVISION}/wiki/pages/doc-1']


def test_skipped_page_projects_its_category_never_text(tmp_path):
    skipped = {**PAGE, 'document_id': 'doc-2', 'status': 'skipped', 'error_code': 'GRAPH_CONTENT_DRIFTED',
               'title': '', 'body': ''}
    with platform(page_payload=skipped) as (origin, _records):
        chat, _config, _space = prepare(tmp_path, origin)

        page = chat.wiki(KB, REVISION, action='read', document_id='doc-2')

        assert page['status'] == 'skipped'
        assert page['errorCode'] == 'GRAPH_CONTENT_DRIFTED'
        assert page['body'] == ''


def test_malformed_wiki_answers_are_protocol_errors(tmp_path):
    from core.platform_chat import ChatError
    for payload in ({'unexpected': True}, {**VIEW, 'manifest_hash': 'short'}, {**VIEW, 'status': 'mystery'},
                    {**VIEW, 'pages': [{'document_id': 'doc-1', 'status': 'invented'}]}):
        with platform(view_payload=payload) as (origin, _records):
            chat, _config, _space = prepare(tmp_path, origin)
            with pytest.raises(ChatError) as error:
                chat.wiki(KB, REVISION, action='view')
            assert str(error.value) == 'CHAT_PROTOCOL_ERROR'
    for payload in ({'unexpected': True}, {**PAGE, 'status': 'invented'}, {**PAGE, 'document_id': ''}):
        with platform(page_payload=payload) as (origin, _records):
            chat, _config, _space = prepare(tmp_path, origin)
            with pytest.raises(ChatError) as error:
                chat.wiki(KB, REVISION, action='read', document_id='doc-1')
            assert str(error.value) == 'CHAT_PROTOCOL_ERROR'


def test_read_requires_a_bounded_document_id(tmp_path):
    from core.platform_chat import ChatError
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin)
        del records[:]
        for document_id in (None, '', 'doc/../escape', 'x' * 65, 7):
            with pytest.raises(ChatError) as error:
                chat.wiki(KB, REVISION, action='read', document_id=document_id)
            assert str(error.value) == 'CHAT_COMMAND_INVALID'
        with pytest.raises(ChatError) as error:
            chat.wiki(KB, REVISION, action='teleport')
        assert str(error.value) == 'CHAT_COMMAND_INVALID'
        # Refused commands never reach the Server.
        assert not records


def test_navigate_projects_index_with_links_backlinks_and_associations(tmp_path):
    with platform() as (origin, records):
        chat, _config, _space = prepare(tmp_path, origin)
        del records[:]

        index = chat.wiki(KB, REVISION, action='navigate')

        assert index['kbId'] == KB and index['revisionId'] == REVISION
        assert index['status'] == 'partial' and index['manifestHash'] == MANIFEST
        assert index['generated'] == 1 and index['failed'] == 0 and index['skipped'] == 1
        # Every page row keeps its honest status; a link to a skipped page
        # names that status instead of pretending the target is readable, a
        # target that names nothing frozen here stays an explicit missing
        # entry, and backlinks invert exactly the resolved links.
        assert index['pages'] == [
            {'documentId': 'doc-1', 'filename': 'guide.txt', 'title': '甲零件与乙组件',
             'contentHash': GUIDE_HASH, 'status': 'completed', 'errorCode': '',
             'links': [{'documentId': 'doc-2', 'title': '', 'status': 'skipped'}],
             'missingLinks': ['未登记的文档'],
             'backlinks': []},
            {'documentId': 'doc-2', 'filename': 'policy.txt', 'title': '',
             'contentHash': 'e' * 64, 'status': 'skipped', 'errorCode': 'GRAPH_CONTENT_DRIFTED',
             'links': [],
             'missingLinks': [],
             'backlinks': [{'documentId': 'doc-1', 'title': '甲零件与乙组件', 'status': 'completed'}]},
        ]
        # The association graph reuses the stored rows with their frozen
        # document binding and digest; ungenerated documents stay coverage rows.
        assert index['associations'] == {
            'status': 'partial', 'generated': 1, 'failed': 0,
            'sources': [
                {'documentId': 'doc-1', 'filename': 'guide.txt', 'contentHash': GUIDE_HASH,
                 'status': 'completed', 'errorCode': ''},
                {'documentId': 'doc-2', 'filename': 'policy.txt', 'contentHash': 'e' * 64,
                 'status': 'skipped', 'errorCode': 'GRAPH_CONTENT_DRIFTED'},
            ],
            'entities': [{'name': '乙组件', 'type': 'component', 'documentId': 'doc-1',
                          'filename': 'guide.txt', 'contentHash': GUIDE_HASH}],
            'relations': [{'source': '甲零件', 'target': '乙组件', 'relation': '构成',
                           'documentId': 'doc-1', 'filename': 'guide.txt', 'contentHash': GUIDE_HASH}],
        }
        # Read-only derivation: navigation never triggers generation, and it
        # reads exactly the Server's navigation endpoint.
        assert not any(method == 'POST' for method, _path, _body, _headers in records)
        reads = [path for method, path, _body, _headers in records if method == 'GET']
        assert reads == [f'/api/resources/{KB}/knowledge-revisions/{REVISION}/wiki/navigation']


def test_navigation_projection_is_bounded(tmp_path):
    flood = [{'document_id': f'doc-{n}', 'filename': f'd{n}.txt', 'title': '', 'content_hash': 'a' * 64,
              'status': 'not_generated', 'error_code': None, 'links': [], 'missing_links': [], 'backlinks': []}
             for n in range(230)]
    missing_flood = {**NAVIGATION, 'pages': [{**NAVIGATION['pages'][0], 'missing_links': [f'目标-{n}' for n in range(120)]}]}
    with platform(navigation_payload={**NAVIGATION, 'pages': flood}) as (origin, _records):
        chat, _config, _space = prepare(tmp_path, origin)
        assert len(chat.wiki(KB, REVISION, action='navigate')['pages']) == 200
    with platform(navigation_payload=missing_flood) as (origin, _records):
        chat, _config, _space = prepare(tmp_path, origin)
        assert len(chat.wiki(KB, REVISION, action='navigate')['pages'][0]['missingLinks']) == 100


def test_malformed_navigation_answers_are_protocol_errors(tmp_path):
    from core.platform_chat import ChatError
    bad_associations = {**NAVIGATION, 'associations': {**NAVIGATION['associations'], 'status': 'invented'}}
    bad_link_row = {**NAVIGATION, 'pages': [{**NAVIGATION['pages'][0], 'links': [{'document_id': 'doc-2', 'status': 'invented'}]}]}
    for payload in ({'unexpected': True}, {**NAVIGATION, 'manifest_hash': 'short'},
                    {**NAVIGATION, 'revision_no': '1'}, {**NAVIGATION, 'status': 'mystery'},
                    {**NAVIGATION, 'pages': [{'document_id': 'doc-1', 'status': 'invented'}]},
                    {**NAVIGATION, 'associations': 'not-a-dict'}, bad_associations, bad_link_row):
        with platform(navigation_payload=payload) as (origin, _records):
            chat, _config, _space = prepare(tmp_path, origin)
            with pytest.raises(ChatError) as error:
                chat.wiki(KB, REVISION, action='navigate')
            assert str(error.value) == 'CHAT_PROTOCOL_ERROR'
