"""Device-side document similarity for the Desktop knowledge entry (#99).

Every test drives the real DesktopChat seam against a registered frozen
revision and a real confirmed workspace: similarity is computed on this
device from the documents the current identity registered, each document is
re-validated content-addressed before its tokens are used, and a drifted,
missing, undecodable, or too-short document is reported as its own status
instead of being substituted or silently dropped. The answer always echoes
the frozen revision identity, and no request about it reaches the Server.
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
MANIFEST = 'c' * 64

GUIDE = '甲零件属于乙组件。乙组件由甲零件与螺栓构成，螺栓固定甲零件。\n'
SPEC = '甲零件用于乙组件。乙组件包含甲零件与螺栓，螺栓连接甲零件。\n'
GUIDE_HASH = hashlib.sha256(GUIDE.encode()).hexdigest()
SPEC_HASH = hashlib.sha256(SPEC.encode()).hexdigest()


@contextmanager
def platform():
    """An idle protocol fixture: the similarity answer must never need it."""

    records = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            records.append(('GET', self.path, None, dict(self.headers)))
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'{}')

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            self.rfile.read(length)
            records.append(('POST', self.path, None, dict(self.headers)))
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'{}')

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
        device_public_key='device-key-099', server_public_key='broker-key-099',
        session_token_ref='device-session-099',
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
    binding = profile_binding(load_settings(config))
    return chat, imports, binding, space


def register(imports, binding, documents):
    imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=1,
                                 manifest_hash=MANIFEST, document_count=len(documents),
                                 status='registered', error_code='', documents=documents))


def document(filename: str, content: bytes) -> dict:
    return {'filename': filename, 'sha256': hashlib.sha256(content).hexdigest(),
            'bytes': len(content), 'mime': 'text/plain'}


def test_similarity_binds_to_the_registered_revision_without_the_server(tmp_path):
    with platform() as (origin, records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        (space / 'spec.txt').write_bytes(SPEC.encode('utf-8'))
        register(imports, binding, [document('guide.txt', GUIDE.encode('utf-8')),
                                    document('spec.txt', SPEC.encode('utf-8'))])
        del records[:]

        view = chat.knowledge_graph(KB, REVISION, action='similarity')

        # The answer echoes the frozen revision identity this device registered.
        assert view['kbId'] == KB and view['revisionId'] == REVISION
        assert view['revisionNo'] == 1 and view['manifestHash'] == MANIFEST
        assert view['status'] == 'completed' and view['truncated'] is False
        assert view['threshold'] > 0
        assert [(row['filename'], row['status']) for row in view['documents']] == [
            ('guide.txt', 'matched'), ('spec.txt', 'matched')]
        assert all(row['tokenCount'] > 0 for row in view['documents'])
        # The overlapping vocabulary produces exactly one honest similarity edge.
        assert len(view['edges']) == 1
        edge = view['edges'][0]
        assert {edge['source'], edge['target']} == {'guide.txt', 'spec.txt'}
        assert 0 < edge['weight'] <= 1
        # Device-side compute: the similarity answer never calls the Server.
        assert records == []


def test_similarity_reports_drift_and_missing_documents_alongside_matched_ones(tmp_path):
    with platform() as (origin, _records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        (space / 'spec.txt').write_bytes('本机内容已被替换，与冻结版本不同。\n'.encode('utf-8'))
        register(imports, binding, [document('guide.txt', GUIDE.encode('utf-8')),
                                    document('spec.txt', SPEC.encode('utf-8')),
                                    document('lost.txt', b'gone\n')])

        view = chat.knowledge_graph(KB, REVISION, action='similarity')

        assert view['status'] == 'partial'
        statuses = {row['filename']: row['status'] for row in view['documents']}
        assert statuses == {'guide.txt': 'matched', 'spec.txt': 'content_drift',
                            'lost.txt': 'file_unavailable'}
        # One usable document cannot produce a pair, and nothing is invented.
        assert view['edges'] == []


def test_similarity_reports_short_documents_without_fabricating_edges(tmp_path):
    with platform() as (origin, _records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        (space / 'stub.txt').write_bytes(b'ab\n')
        register(imports, binding, [document('guide.txt', GUIDE.encode('utf-8')),
                                    document('stub.txt', b'ab\n')])

        view = chat.knowledge_graph(KB, REVISION, action='similarity')

        # The frozen bytes verified, but the content is too short to say
        # anything about similarity: its own status, and no invented edge.
        assert view['status'] == 'partial'
        statuses = {row['filename']: row['status'] for row in view['documents']}
        assert statuses == {'guide.txt': 'matched', 'stub.txt': 'not_enough_content'}
        assert view['edges'] == []


def test_similarity_reports_undecodable_frozen_bytes(tmp_path):
    with platform() as (origin, _records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        payload = bytes(range(256))
        (space / 'blob.bin').write_bytes(payload)
        register(imports, binding, [document('guide.txt', GUIDE.encode('utf-8')),
                                    document('blob.bin', payload)])

        view = chat.knowledge_graph(KB, REVISION, action='similarity')

        assert view['status'] == 'partial'
        statuses = {row['filename']: row['status'] for row in view['documents']}
        assert statuses == {'guide.txt': 'matched', 'blob.bin': 'not_searchable'}


def test_similarity_resolves_duplicate_basenames_by_content(tmp_path):
    with platform() as (origin, _records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        (space / 'a.txt').write_bytes(GUIDE.encode('utf-8'))
        nested = space / 'nested'
        nested.mkdir()
        (nested / 'a.txt').write_bytes(SPEC.encode('utf-8'))
        register(imports, binding, [document('a.txt', GUIDE.encode('utf-8')),
                                    document('a.txt', SPEC.encode('utf-8'))])

        view = chat.knowledge_graph(KB, REVISION, action='similarity')

        assert view['status'] == 'completed'
        # A repeated basename is disambiguated symmetrically: every document
        # with that name carries its frozen digest, so the id never depends
        # on manifest order and two different files never merge.
        ids = sorted(row['id'] for row in view['documents'])
        assert all(item.startswith('a.txt#') and len(item) > len('a.txt') for item in ids)
        assert ids[0] != ids[1]
        assert len(view['edges']) == 1


def test_similarity_refuses_revisions_this_identity_never_registered(tmp_path):
    from core.platform_chat import ChatError
    with platform() as (origin, _records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        # No registry row at all.
        with pytest.raises(ChatError) as error:
            chat.knowledge_graph(KB, REVISION, action='similarity')
        assert str(error.value) == 'KNOWLEDGE_GRAPH_REVISION_UNREGISTERED'
        # A failed import attempt is never a similarity source either.
        imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=1,
                                     manifest_hash=MANIFEST, document_count=1,
                                     status='failed', error_code='KNOWLEDGE_IMPORT_FILE_UNAVAILABLE',
                                     documents=[document('guide.txt', GUIDE.encode('utf-8'))]))
        with pytest.raises(ChatError) as error:
            chat.knowledge_graph(KB, REVISION, action='similarity')
        assert str(error.value) == 'KNOWLEDGE_GRAPH_REVISION_UNREGISTERED'


def test_similarity_caps_edges_and_flags_truncation(tmp_path):
    with platform() as (origin, _records):
        chat, imports, binding, space = prepare(tmp_path, origin)
        documents = []
        body = '同一份重复文本，用于验证边数上限被如实标注。\n'.encode('utf-8')
        for index in range(66):
            name = f'd{index:02d}.txt'
            (space / name).write_bytes(body)
            documents.append(document(name, body))
        register(imports, binding, documents)

        view = chat.knowledge_graph(KB, REVISION, action='similarity')

        # C(66, 2) = 2145 candidate pairs; the device keeps a bounded,
        # deterministically ordered edge list and says so.
        assert view['truncated'] is True
        assert len(view['edges']) == 2000
        weights = [edge['weight'] for edge in view['edges']]
        assert weights == sorted(weights, reverse=True)
        assert view['status'] == 'completed'
