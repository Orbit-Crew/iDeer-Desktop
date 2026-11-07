"""Explicit local knowledge imports: identity-only registration (#112).

Every test drives the real DesktopChat seam against a protocol fixture and a
real confirmed workspace, so the frozen cross-repo contract is observed on the
wire: the registration request carries document identity fields only, original
bytes and the device index never leave the device, a refused or failed import
never impersonates a registration, and the frozen revision record survives a
restart while other identities see nothing.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import shutil
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from core.file_service import WorkspaceFileStore, WorkspaceSelection
from core.files import RootConfig
from core.knowledge_import import (
    MAX_IMPORT_FILE_BYTES,
    KnowledgeImportError,
    KnowledgeImportRegistry,
    build_manifest,
    logical_paths_for,
)
from core.platform_chat import ChatError, DesktopChat
from core.receipt_ledger import profile_binding
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings

KB = '33333333-3333-4333-8333-333333333333'
GUIDE = '# marker\nlocal bytes that never upload\n'
NOTES = 'plain text notes\n'
CHANGED = '# marker v2 CHANGED\n'


def revision_payload(path, body, serial):
    documents = body['documents']
    manifest = hashlib.sha256(json.dumps(sorted(d['content_hash'] for d in documents)).encode()).hexdigest()
    return dict(id=f'rev-{serial}', resource_id=path.split('/')[3], revision_no=serial, status='draft',
                manifest_hash=manifest, document_count=len(documents))


@contextmanager
def platform(local_import_status=201, project_id='proj-77', local_import_delay=0):
    records = []
    # A list means a queue: the first POSTs are refused, the last status holds.
    statuses = local_import_status if isinstance(local_import_status, list) else None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))

        def respond(self, body):
            records.append((self.path, body, dict(self.headers)))
            status, data = 200, {}
            if self.path == '/api/v1/auth/me':
                data = {'id': 'A', 'email': 'a@test.invalid', 'system_role': 'user', 'permissions': ['runs:create']}
            elif self.path.endswith('/knowledge-revisions/local-imports'):
                if local_import_delay:
                    time.sleep(local_import_delay)
                status = statuses.pop(0) if statuses and len(statuses) > 1 else \
                    statuses[0] if statuses else local_import_status
                data = revision_payload(self.path, body, len(records)) if status == 201 else {}
                if data and project_id:
                    data['project_id'] = project_id
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


def prepare(tmp_path: Path, origin: str, *, work=True, user_id='A'):
    """A DesktopChat with a confirmed workspace, mirroring desktop.py wiring."""
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    space = tmp_path / 'work'
    space.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id=user_id, device_id='D1',
        device_public_key='device-key-112', server_public_key='broker-key-112',
        session_token_ref='device-session-112',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    if work:
        WorkspaceSelection(config).select(str(space), confirmed=True)
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       knowledge_imports=registry, knowledge_files=knowledge_files)
    return chat, registry, settings, config, space, profile_binding(load_settings(config))


def import_posts(records):
    return [(path, body) for path, body, _ in records if path.endswith('/knowledge-revisions/local-imports')]


def test_explicit_import_registers_private_revision_and_never_uploads_content(tmp_path):
    """T112-01: one explicit import freezes identity only; bytes stay local."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        guide = space / 'guide.md'
        notes = space / 'notes.txt'
        guide.write_bytes(GUIDE.encode('utf-8'))
        notes.write_bytes(NOTES.encode('utf-8'))

        outcome = chat.register_local_import(KB, [str(guide), str(notes)])

        posts = import_posts(records)
        assert len(posts) == 1
        path, body = posts[0]
        assert path == f'/api/resources/{KB}/knowledge-revisions/local-imports'
        # The whole request is identity metadata: no content field anywhere and
        # far smaller than the originals it describes.
        assert set(body) == {'documents', 'device_id'}
        assert body['device_id'] == 'D1'
        assert [d['filename'] for d in body['documents']] == ['guide.md', 'notes.txt']
        serialized = json.dumps(body).encode()
        assert b'# marker' not in serialized and b'plain text notes' not in serialized
        assert len(serialized) < 2048
        assert body['documents'][0]['content_hash'] == hashlib.sha256(GUIDE.encode()).hexdigest()
        assert body['documents'][0]['size_bytes'] == len(GUIDE.encode())
        assert body['documents'][0]['mime_type'].startswith('text/')
        assert body['documents'][1]['content_hash'] == hashlib.sha256(NOTES.encode()).hexdigest()
        assert outcome == dict(kbId=KB, revisionId='rev-1', revisionNo=1,
                               manifestHash=hashlib.sha256(json.dumps(
                                   sorted(d['content_hash'] for d in body['documents'])).encode()).hexdigest(),
                               documentCount=2)
        rows = registry.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'registered'
        assert rows[0]['revisionId'] == 'rev-1' and rows[0]['revisionNo'] == 1
        assert rows[0]['manifestHash'] == outcome['manifestHash']
        assert {d['filename'] for d in rows[0]['documents']} == {'guide.md', 'notes.txt'}
        # Only plain file names reach the display: the logical path mapping
        # stays an internal device fact.
        assert all('/' not in d['filename'] and '\\' not in d['filename'] for d in rows[0]['documents'])


def test_import_refuses_without_confirmed_workspace_and_never_takes_over(tmp_path):
    """T112-02: no silent import from an unconfirmed workspace."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, _ = prepare(tmp_path, origin, work=False)
        target = space / 'guide.md'
        target.write_bytes(GUIDE.encode('utf-8'))
        with pytest.raises(KnowledgeImportError) as refused:
            chat.register_local_import(KB, [str(target)])
        assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'
        # No workspace grant existed, so nothing was read and nothing was sent.
        assert import_posts(records) == []
        assert registry.view(profile_binding(load_settings(config))) == []


def test_import_does_not_inherit_workspace_across_accounts(tmp_path):
    """T112-02: a switched account never inherits the old workspace or its rows."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        target = space / 'guide.md'
        target.write_bytes(GUIDE.encode('utf-8'))
        chat.register_local_import(KB, [str(target)])
        assert len(import_posts(records)) == 1

        switched = load_settings(config)
        switched.user_id = 'B'
        switched.save(config)
        with pytest.raises(KnowledgeImportError) as refused:
            chat.register_local_import(KB, [str(target)])
        assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'
        assert len(import_posts(records)) == 1
        # The switched identity sees neither the old rows nor its own.
        assert registry.view(profile_binding(load_settings(config))) == []
        assert registry.view(binding)[0]['status'] == 'registered'


@pytest.mark.parametrize('kind,expected', [
    ('protected', 'KNOWLEDGE_IMPORT_PROTECTED_PATH'),
    ('env', 'KNOWLEDGE_IMPORT_UNSUPPORTED_TYPE'),
    ('outside', 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'),
    ('link', 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'),
    ('exe', 'KNOWLEDGE_IMPORT_UNSUPPORTED_TYPE'),
])
def test_import_refuses_restricted_and_out_of_bounds_paths(tmp_path, kind, expected):
    """T112-02: identity and directory constraints hold before any byte moves."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        inside = space / 'guide.md'
        inside.write_bytes(GUIDE.encode('utf-8'))
        outside = tmp_path / 'outside.md'
        outside.write_text('outside bytes\n', encoding='utf-8')
        if kind == 'protected':
            restricted = space / 'node_modules'
            restricted.mkdir()
            picked = [str(restricted / 'notes.md')]
            (restricted / 'notes.md').write_bytes(GUIDE.encode('utf-8'))
        elif kind == 'env':
            (space / '.env').write_text('SECRET=1\n', encoding='utf-8')
            picked = [str(space / '.env')]
        elif kind == 'outside':
            picked = [str(outside), str(inside)]
        elif kind == 'link':
            link = space / 'escape.md'
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                pytest.skip('symlinks are unavailable on this platform')
            picked = [str(link)]
        else:
            binary = space / 'payload.exe'
            binary.write_bytes(b'MZ')
            picked = [str(binary)]

        with pytest.raises(KnowledgeImportError) as refused:
            chat.register_local_import(KB, picked)
        assert refused.value.args[0] == expected
        # A refused import sent nothing at all and is recorded as a real failure.
        assert import_posts(records) == []
        rows = registry.view(binding)
        assert [row['status'] for row in rows] == ['failed']
        assert rows[0]['errorCode'] == expected
        assert rows[0]['revisionId'] == '' and rows[0]['manifestHash'] == ''


def test_reimport_creates_new_revision_and_freezes_the_old_one(tmp_path):
    """T112-03: changed content imports as R2; R1's frozen identity is untouched."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        marked = space / 'marked.md'
        marked.write_bytes(GUIDE.encode('utf-8'))
        first = chat.register_local_import(KB, [str(marked)])
        marked.write_bytes(CHANGED.encode('utf-8'))
        second = chat.register_local_import(KB, [str(marked)])

        assert second['revisionNo'] == 2 and second['revisionId'] != first['revisionId']
        assert second['manifestHash'] != first['manifestHash']
        rows = registry.view(binding)
        assert [row['revisionNo'] for row in rows] == [2, 1]
        assert rows[1]['manifestHash'] == first['manifestHash']
        # R1's stored manifest still matches its own frozen content hash.
        assert rows[1]['documents'][0]['sha256'] == hashlib.sha256(GUIDE.encode()).hexdigest()
        assert rows[0]['documents'][0]['sha256'] == hashlib.sha256(CHANGED.encode()).hexdigest()


@pytest.mark.parametrize('status,expected', [(403, 'CHAT_FORBIDDEN'), (404, 'CHAT_NOT_FOUND'), (500, 'CHAT_SERVER_ERROR')])
def test_platform_rejections_are_recorded_as_real_failures(tmp_path, status, expected):
    """T112-02/T112-04: a refused registration never impersonates a revision."""
    with platform(local_import_status=status) as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        target = space / 'guide.md'
        target.write_bytes(GUIDE.encode('utf-8'))
        with pytest.raises(KnowledgeImportError) as failed:
            chat.register_local_import(KB, [str(target)])
        assert failed.value.args[0] == expected
        rows = registry.view(binding)
        assert [row['status'] for row in rows] == ['failed']
        assert rows[0]['errorCode'] == expected
        assert rows[0]['revisionId'] == '' and rows[0]['revisionNo'] == 0 and rows[0]['manifestHash'] == ''


def test_import_requires_authenticated_session_before_any_read(tmp_path):
    """T112-02: the unauthenticated boundary rejects the import with zero reads."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, _ = prepare(tmp_path, origin)

        def must_not_read():
            raise AssertionError('workspace must not be read while unauthenticated')

        unauthenticated = DesktopChat(config, InMemorySecretStore(), lambda: {'state': 'unauthenticated'},
                                      knowledge_imports=registry, knowledge_files=must_not_read)
        target = space / 'guide.md'
        target.write_bytes(GUIDE.encode('utf-8'))
        with pytest.raises(ChatError) as refused:
            unauthenticated.register_local_import(KB, [str(target)])
        assert refused.value.args[0] == 'CHAT_UNAUTHENTICATED'
        assert import_posts(records) == []
        assert registry.view(profile_binding(load_settings(config))) == []


def test_import_records_survive_restart_and_stay_identity_bound(tmp_path):
    """T112-04: the frozen record persists for its owner and hides from others."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        target = space / 'guide.md'
        target.write_bytes(GUIDE.encode('utf-8'))
        outcome = chat.register_local_import(KB, [str(target)])

        restarted = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
        rows = restarted.view(binding)
        assert len(rows) == 1 and rows[0]['manifestHash'] == outcome['manifestHash']
        assert rows[0]['revisionId'] == 'rev-1' and rows[0]['status'] == 'registered'

        other = RuntimeSettings(server_url=origin, user_id='B', device_id='D2',
            device_public_key='other-device-key', server_public_key='broker-key-112',
            session_token_ref='device-session-112',
            business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
        assert KnowledgeImportRegistry(config.with_name('knowledge-imports.db')).view(profile_binding(other)) == []


def test_build_manifest_rejects_duplicate_content_and_oversized_files():
    """T112-02: the device applies the platform's fixed validation categories."""
    class FakeFiles:
        def read_bytes(self, path, *, max_bytes=-1):
            if path.endswith('/big.md'):
                return b'x' * (MAX_IMPORT_FILE_BYTES + 1)
            return b'same bytes'

    entries = build_manifest(FakeFiles(), ['/workspace/guide.md'])
    # Since #81 every manifest entry also carries the device-side parse record.
    assert entries == [dict(filename='guide.md', sha256=hashlib.sha256(b'same bytes').hexdigest(),
                            bytes=10, mime=mimetypes.guess_type('guide.md')[0] or 'application/octet-stream',
                            parse={'status': 'parsed', 'parser': 'text-utf8', 'parserVersion': '1',
                                   'pages': 0, 'tables': 0, 'truncated': False, 'errorCode': '',
                                   'layout': []})]
    with pytest.raises(KnowledgeImportError) as duplicate:
        build_manifest(FakeFiles(), ['/workspace/guide.md', '/workspace/copy.md'])
    assert duplicate.value.args[0] == 'KNOWLEDGE_IMPORT_DUPLICATE_CONTENT'
    with pytest.raises(KnowledgeImportError) as large:
        build_manifest(FakeFiles(), ['/workspace/big.md'])
    assert large.value.args[0] == 'KNOWLEDGE_IMPORT_FILE_TOO_LARGE'
    with pytest.raises(KnowledgeImportError) as many:
        build_manifest(FakeFiles(), [f'/workspace/file{n}.md' for n in range(201)])
    assert many.value.args[0] == 'KNOWLEDGE_IMPORT_TOO_MANY_DOCUMENTS'


def test_logical_paths_verify_workspace_generation_before_mapping(tmp_path):
    """T112-04: a replaced workspace root is detected through its recorded identity."""
    space = tmp_path / 'work'
    space.mkdir()
    target = space / 'guide.md'
    target.write_bytes(GUIDE.encode('utf-8'))
    stale = dict(logical_root='/workspace/abc', physical_root=str(space), identity=[12345, 67890])
    # The directory generation no longer matches the confirmed grant.
    with pytest.raises(KnowledgeImportError) as drifted:
        logical_paths_for(stale, [str(target)])
    assert drifted.value.args[0] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'

    current = dict(logical_root='/workspace/abc', physical_root=str(space),
                   identity=[space.stat().st_dev, space.stat().st_ino])
    assert logical_paths_for(current, [str(target)]) == [f'/workspace/abc/{target.name}']
    with pytest.raises(KnowledgeImportError) as duplicated:
        logical_paths_for(current, [str(target), str(target)])
    assert duplicated.value.args[0] == 'KNOWLEDGE_IMPORT_DUPLICATE_PATH'
    with pytest.raises(KnowledgeImportError) as missing:
        logical_paths_for(current, [str(space / 'gone.md')])
    assert missing.value.args[0] == 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'


# --- Issue 81: the device really parses what it registers -------------------

from fixtures.document_fixtures import build_docx, docx_paragraph, docx_table


def test_import_records_real_device_parse_facts_per_document(tmp_path):
    """T81-01: the wire stays identity-only while each document gains an honest
    device-side parse record (status, parser, version, layout anchors)."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        table = space / 'parts.csv'
        table.write_bytes('name,qty\nbearing,4\n'.encode('utf-8'))
        report = space / 'report.docx'
        report.write_bytes(build_docx(docx_paragraph('intro')
                                      + docx_table([['part', 'qty']])))
        legacy = space / 'old.doc'
        legacy.write_bytes(b'\xd0\xcf\x11\xe0legacy')

        outcome = chat.register_local_import(KB, [str(table), str(report), str(legacy)])
        assert outcome['documentCount'] == 3

        # The frozen cross-repo contract holds: identity fields only, no
        # content or parse output anywhere on the wire.
        path, body = import_posts(records)[0]
        assert all(set(document) == {'filename', 'content_hash', 'size_bytes', 'mime_type'}
                   for document in body['documents'])

        parse_by_name = {document['filename']: document.get('parse')
                         for document in registry.view(binding)[0]['documents']}
        assert parse_by_name['parts.csv'] == {
            'status': 'parsed', 'parser': 'csv-stdlib', 'parserVersion': '1',
            'pages': 0, 'tables': 1, 'truncated': False, 'errorCode': '',
            'layout': [{'kind': 'table', 'page': None, 'table': 1, 'title': None,
                        'line': 1, 'lines': 2}]}
        assert parse_by_name['report.docx'] == {
            'status': 'parsed', 'parser': 'docx-ooxml', 'parserVersion': '1',
            'pages': 0, 'tables': 1, 'truncated': False, 'errorCode': '',
            'layout': [{'kind': 'table', 'page': None, 'table': 1, 'title': None,
                        'line': 2, 'lines': 1}]}
        # A legacy binary format the device cannot honestly parse is recorded
        # as skipped instead of riding the suffix whitelist as a fake success.
        assert parse_by_name['old.doc'] == {
            'status': 'skipped', 'parser': '', 'parserVersion': '',
            'pages': 0, 'tables': 0, 'truncated': False,
            'errorCode': 'PARSE_FORMAT_UNSUPPORTED', 'layout': []}


def test_import_survives_a_failed_parse_and_records_the_reason(tmp_path):
    """T81-02: one corrupt PDF never fails the import; its record says why."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        broken = space / 'broken.pdf'
        broken.write_bytes(b'%PDF-1.7\nnot really a pdf')
        guide = space / 'guide.md'
        guide.write_bytes(GUIDE.encode('utf-8'))

        outcome = chat.register_local_import(KB, [str(broken), str(guide)])
        assert outcome['documentCount'] == 2

        row = registry.view(binding)[0]
        assert row['status'] == 'registered'
        parse_by_name = {document['filename']: document.get('parse') for document in row['documents']}
        assert parse_by_name['broken.pdf']['status'] == 'failed'
        assert parse_by_name['broken.pdf']['errorCode'] == 'PARSE_PDF_CORRUPT'
        assert parse_by_name['broken.pdf']['parser'] == 'pypdf'
        assert parse_by_name['broken.pdf']['layout'] == []
        assert parse_by_name['guide.md']['status'] == 'parsed'
        assert parse_by_name['guide.md']['errorCode'] == ''
        assert parse_by_name['guide.md']['layout'] == []


# --- Issue 96: the document library's recursive folder import ----------------

import os

from core.knowledge_import import (
    MAX_FOLDER_IMPORT_FILES,
    build_folder_entries,
    physical_paths_for,
    walk_import_folder,
)
from core.file_service import WorkspaceFileStore


def folder_grant(space: Path) -> dict:
    return dict(logical_root='/workspace/lib', physical_root=str(space),
                identity=[space.stat().st_dev, space.stat().st_ino])


def folder_store(space: Path, *protected):
    grant = folder_grant(space)
    files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
        identity=tuple(grant['identity']), resolve_root=False)], protected_roots=tuple(protected))
    return grant, files


def test_folder_walk_recurses_and_filters(tmp_path):
    """T96-01: one confirmed folder walks recursively; the extension whitelist
    and protected directory names keep non-documents out of the candidates."""
    space = tmp_path / 'work'
    deep = space / 'reports' / '2024'
    deep.mkdir(parents=True)
    (deep / 'guide.md').write_bytes(GUIDE.encode('utf-8'))
    (deep / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    (space / 'data.csv').write_bytes(b'a,b\n1,2\n')
    (space / 'top.md').write_bytes(GUIDE.encode('utf-8'))
    (deep / 'skip.exe').write_bytes(b'MZ')
    (deep / 'README').write_bytes(GUIDE.encode('utf-8'))
    node_modules = space / 'node_modules'
    node_modules.mkdir()
    (node_modules / 'inside.md').write_bytes(GUIDE.encode('utf-8'))

    walked = walk_import_folder(folder_grant(space), str(space))

    assert walked['folder'] == '/workspace/lib'
    assert walked['logical_paths'] == [
        '/workspace/lib/data.csv', '/workspace/lib/top.md',
        '/workspace/lib/reports/2024/guide.md', '/workspace/lib/reports/2024/notes.txt']
    assert walked['truncated'] is False
    assert walked['skippedUnsupported'] == 2
    assert walked['skippedLinks'] == 0


def test_folder_walk_prunes_symlinks(tmp_path):
    """T96-01: a linked file is never a candidate; the real files still are."""
    space = tmp_path / 'work'
    space.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.md').write_bytes(GUIDE.encode('utf-8'))
    (space / 'real.md').write_bytes(GUIDE.encode('utf-8'))
    link = space / 'link.md'
    try:
        link.symlink_to(outside / 'secret.md')
    except (OSError, NotImplementedError):
        pytest.skip('symlinks are unavailable on this platform')

    walked = walk_import_folder(folder_grant(space), str(space))

    assert walked['logical_paths'] == ['/workspace/lib/real.md']
    assert walked['skippedLinks'] == 1


@pytest.mark.skipif(os.name != 'nt', reason='requires Windows junctions')
def test_folder_walk_never_descends_a_junction(tmp_path):
    """T96-01: a junctioned subtree is pruned, exactly like the store's own reads."""
    space = tmp_path / 'work'
    space.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.md').write_bytes(GUIDE.encode('utf-8'))
    (space / 'real.md').write_bytes(GUIDE.encode('utf-8'))
    junction = space / 'linked'
    if os.system(f'cmd /c mklink /J "{junction}" "{outside}" >NUL') != 0:
        pytest.skip('junction creation is unavailable')

    walked = walk_import_folder(folder_grant(space), str(space))

    assert walked['logical_paths'] == ['/workspace/lib/real.md']
    assert walked['skippedLinks'] == 1


def test_folder_walk_refuses_outside_and_drifted_roots(tmp_path):
    """T96-01: the walk inherits the confirmed-workspace boundary, unconditionally."""
    space = tmp_path / 'work'
    space.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    grant = folder_grant(space)
    with pytest.raises(KnowledgeImportError) as refused:
        walk_import_folder(grant, str(outside))
    assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'
    with pytest.raises(KnowledgeImportError) as missing:
        walk_import_folder(grant, str(space / 'gone'))
    assert missing.value.args[0] == 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'
    drifted = dict(grant, identity=[12345, 67890])
    with pytest.raises(KnowledgeImportError) as stale:
        walk_import_folder(drifted, str(space))
    assert stale.value.args[0] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'


def test_folder_walk_caps_candidates_and_says_so(tmp_path):
    """T96-01: the walk stops at the job cap instead of never finishing."""
    space = tmp_path / 'work'
    space.mkdir()
    for index in range(MAX_FOLDER_IMPORT_FILES + 1):
        (space / f'file{index:05}.md').write_bytes(GUIDE.encode('utf-8'))

    walked = walk_import_folder(folder_grant(space), str(space))

    assert len(walked['logical_paths']) == MAX_FOLDER_IMPORT_FILES
    assert walked['truncated'] is True


def test_folder_entries_fail_alone_and_dedup_by_fingerprint(tmp_path):
    """T96-02: one bad file fails alone; fingerprints dedup within the folder
    and against the already-registered rows of the same KB."""
    space = tmp_path / 'work'
    (space / 'sub').mkdir(parents=True)
    (space / 'vault').mkdir()
    (space / 'a.md').write_bytes(GUIDE.encode('utf-8'))
    (space / 'sub' / 'copy.md').write_bytes(GUIDE.encode('utf-8'))
    (space / 'known.md').write_bytes(NOTES.encode('utf-8'))
    (space / 'vault' / 'locked.md').write_bytes(GUIDE.encode('utf-8'))
    grant, files = folder_store(space, space / 'vault')

    result = build_folder_entries(files, [
        '/workspace/lib/a.md', '/workspace/lib/sub/copy.md', '/workspace/lib/known.md',
        '/workspace/lib/vault/locked.md', '/workspace/lib/gone.md',
    ], known_hashes={hashlib.sha256(NOTES.encode()).hexdigest()})

    # copy.md repeats a.md's bytes inside the folder; known.md repeats an
    # already-registered fingerprint. Both are skipped, never fatal.
    assert [entry['filename'] for entry in result['entries']] == ['a.md']
    assert result['paths'] == ['/workspace/lib/a.md']
    assert result['duplicates'] == 2
    assert {tuple(failure.items()) for failure in result['failures']} == {
        (('filename', 'locked.md'), ('errorCode', 'KNOWLEDGE_IMPORT_PROTECTED_PATH')),
        (('filename', 'gone.md'), ('errorCode', 'KNOWLEDGE_IMPORT_FILE_UNAVAILABLE')),
    }
    assert result['canceled'] is False
    assert result['entries'][0]['sha256'] == hashlib.sha256(GUIDE.encode()).hexdigest()


class _FakeFolderFiles:
    def __init__(self, payloads):
        self.payloads = payloads

    def read_bytes(self, path, *, max_bytes=-1):
        payload = self.payloads[path]
        if isinstance(payload, Exception):
            raise payload
        return payload


def test_folder_entries_record_oversize_as_a_per_file_failure():
    """T96-02: an oversized file is an honest per-file failure, not a batch abort."""
    files = _FakeFolderFiles({
        '/workspace/lib/big.md': b'x' * (MAX_IMPORT_FILE_BYTES + 1),
        '/workspace/lib/a.md': GUIDE.encode('utf-8'),
    })

    result = build_folder_entries(files, ['/workspace/lib/big.md', '/workspace/lib/a.md'], set())

    assert [entry['filename'] for entry in result['entries']] == ['a.md']
    assert result['failures'] == [{'filename': 'big.md', 'errorCode': 'KNOWLEDGE_IMPORT_FILE_TOO_LARGE'}]


def test_folder_entries_honor_a_canceled_job():
    """T96-02: a canceled job reads nothing further and says so."""
    files = _FakeFolderFiles({'/workspace/lib/a.md': GUIDE.encode('utf-8')})

    result = build_folder_entries(files, ['/workspace/lib/a.md', '/workspace/lib/b.md'], set(),
                                  canceled=lambda: True)

    assert result['entries'] == [] and result['canceled'] is True


def test_retry_maps_stored_logical_paths_back_to_physical(tmp_path):
    """T96-05: a failed record's stored display paths map back onto the
    confirmed workspace for the ordinary re-import seam; anything else refuses."""
    space = tmp_path / 'work'
    (space / 'sub').mkdir(parents=True)
    grant = folder_grant(space)
    expected = str(Path(space) / 'sub' / 'a.md')
    assert physical_paths_for(grant, ['/workspace/lib/sub/a.md']) == [expected]
    for bad in ([], ['C:/abs/a.md'], ['/workspace/other/a.md'], ['/workspace/lib'],
                ['/workspace/lib/sub/../..//a.md'], ['/workspace/lib/sub/./a.md'],
                ['/workspace/lib/sub\\a.md'], [7]):
        with pytest.raises(KnowledgeImportError) as refused:
            physical_paths_for(grant, bad)
        assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_NO_SOURCE'


def folder_entry(name, body):
    return dict(filename=name, sha256=hashlib.sha256(body).hexdigest(), bytes=len(body),
                mime='text/plain', parse={'status': 'parsed', 'parser': 'text-utf8',
                                          'parserVersion': '1', 'pages': 0, 'tables': 0,
                                          'truncated': False, 'errorCode': '', 'layout': []})


FOLDER_SOURCE = dict(kind='folder', folder='/workspace/lib', paths=['/workspace/lib/guide.md'])


def test_folder_batch_registration_keeps_platform_and_library_identity(tmp_path):
    """T96-03: a folder batch rides the same frozen registration seam; the row
    keeps the KB identity, the platform project when the platform sends one,
    and the source folder display. The wire stays identity-only."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        entries = [folder_entry('guide.md', GUIDE.encode('utf-8'))]

        outcome = chat.register_import_entries(KB, entries, source=FOLDER_SOURCE)

        posts = import_posts(records)
        assert len(posts) == 1
        path, body = posts[0]
        assert path == f'/api/resources/{KB}/knowledge-revisions/local-imports'
        assert set(body) == {'documents', 'device_id'} and body['device_id'] == 'D1'
        assert outcome == dict(kbId=KB, revisionId='rev-1', revisionNo=1,
                               manifestHash=hashlib.sha256(
                                   json.dumps([entries[0]['sha256']]).encode()).hexdigest(),
                               documentCount=1)
        row = registry.view(binding)[0]
        assert row['status'] == 'registered' and row['kbId'] == KB
        assert row['revisionId'] == 'rev-1' and row['revisionNo'] == 1
        # Criterion 5: the platform project rides the registration response and
        # stays queryable on the record next to the library identity.
        assert row['projectId'] == 'proj-77'
        assert row['source'] == dict(kind='folder', folder='/workspace/lib', pathCount=1)
        # Display facts only: the wire view never carries the stored paths.
        assert 'paths' not in row['source']
        # An identical second attempt registers a fresh platform revision (the
        # platform's own contract) but stays the same display fact: one row.
        chat.register_import_entries(KB, entries, source=FOLDER_SOURCE)
        assert len(registry.view(binding)) == 1


def test_folder_batch_row_carries_no_project_when_platform_sends_none(tmp_path):
    """T96-03: an absent platform project identity stays honestly empty."""
    with platform(project_id=None) as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        chat.register_import_entries(KB, [folder_entry('guide.md', GUIDE.encode('utf-8'))],
                                     source=FOLDER_SOURCE)
        assert registry.view(binding)[0]['projectId'] == ''


def test_failed_folder_batch_keeps_intended_documents_for_retry(tmp_path):
    """T96-05: a refused batch records the intended manifest and source paths,
    so 重试 can re-run exactly those files; nothing impersonates a revision."""
    with platform(local_import_status=500) as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        entries = [folder_entry('guide.md', GUIDE.encode('utf-8'))]
        with pytest.raises(KnowledgeImportError) as failed:
            chat.register_import_entries(KB, entries, source=FOLDER_SOURCE)
        assert failed.value.args[0] == 'CHAT_SERVER_ERROR'
        row = registry.view(binding)[0]
        assert row['status'] == 'failed' and row['errorCode'] == 'CHAT_SERVER_ERROR'
        assert row['revisionId'] == '' and row['manifestHash'] == ''
        assert [document['filename'] for document in row['documents']] == ['guide.md']
        assert row['source'] == dict(kind='folder', folder='/workspace/lib', pathCount=1)
        # The retry seam reads the full stored paths device-side only.
        stored = registry.fetch(binding, [row['id']])
        assert stored[0]['source']['paths'] == ['/workspace/lib/guide.md']


def test_registered_hashes_scope_to_one_binding_and_kb(tmp_path):
    """T96-02: folder dedup compares against registered fingerprints of the
    same account and the same KB; nothing else inherits them."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        (space / 'guide.md').write_bytes(GUIDE.encode('utf-8'))
        chat.register_local_import(KB, [str(space / 'guide.md')])
        other_kb = '44444444-4444-4444-8444-444444444444'
        chat.register_local_import(other_kb, [str(space / 'guide.md')])

        assert registry.registered_hashes(binding, KB) == {hashlib.sha256(GUIDE.encode()).hexdigest()}
        assert registry.registered_hashes(binding, '55555555-5555-5555-8555-555555555555') == set()
        switched = load_settings(config)
        switched.user_id = 'B'
        switched.save(config)
        assert registry.registered_hashes(profile_binding(load_settings(config)), KB) == set()


def test_delete_and_fetch_manage_records_for_one_binding_only(tmp_path):
    """T96-04: batch delete removes selected display rows of this identity
    only, never platform revisions; fetch finds rows for the retry seam."""
    with platform() as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        (space / 'guide.md').write_bytes(GUIDE.encode('utf-8'))
        chat.register_local_import(KB, [str(space / 'guide.md')])
        (space / 'guide.md').write_bytes(CHANGED.encode('utf-8'))
        chat.register_local_import(KB, [str(space / 'guide.md')])
        rows = registry.view(binding)
        assert len(rows) == 2
        posts_before = len(import_posts(records))

        assert registry.fetch(binding, [rows[0]['id']])[0]['kbId'] == KB
        assert registry.fetch(binding, ['unknown']) == []
        switched = load_settings(config)
        switched.user_id = 'B'
        switched.save(config)
        other = profile_binding(load_settings(config))
        assert registry.fetch(other, [rows[0]['id']]) == []
        assert registry.delete(other, [rows[0]['id']]) == 0
        assert registry.delete(binding, [rows[0]['id']]) == 1
        assert [row['id'] for row in registry.view(binding)] == [rows[1]['id']]
        # A delete is a local display-fact change: zero platform calls.
        assert len(import_posts(records)) == posts_before
        assert registry.delete(binding, [rows[0]['id']]) == 0


# --- Issue 96: the background folder import job ------------------------------

import time

from core.knowledge_import import KnowledgeFolderImport


def job_chat(tmp_path, origin, *, work=True):
    """The coordinator wired exactly like desktop.py: one chat seam, one
    registry, one confirmed-workspace factory."""
    chat, registry, settings, config, space, binding = prepare(tmp_path, origin, work=work)

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    return KnowledgeFolderImport(chat.register_import_entries, knowledge_files, registry), \
        chat, registry, settings, config, space, binding


def wait_terminal(job, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = job.status()
        if status and status['state'] != 'running':
            return status
        time.sleep(0.02)
    raise AssertionError('folder import job did not settle')


def wait_batches(job, count, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = job.status()
        if status and status.get('registeredBatches', 0) >= count:
            return status
        time.sleep(0.02)
    raise AssertionError(f'folder import job never registered {count} batches')


def test_folder_job_imports_a_folder_in_background_batches(tmp_path):
    """T96-01/T96-03: one folder import runs in the background, registers
    batched revisions, and reports honest progress and counts."""
    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        folder = space / 'library'
        folder.mkdir()
        for index in range(250):
            (folder / f'doc{index:04}.md').write_bytes(f'document {index}\n'.encode('utf-8'))
        (folder / 'debug.log').write_bytes(NOTES.encode('utf-8'))

        started = job.start(KB, str(folder))
        assert started['state'] == 'running' and started['kbId'] == KB

        status = wait_terminal(job)
        assert status['state'] == 'completed'
        assert status['folder'] == f"{settings_workspace_logical(config)}/library"
        assert status['totalFiles'] == 250 and status['processedFiles'] == 250
        assert status['registeredBatches'] == 2 and status['registeredDocuments'] == 250
        assert status['skippedDuplicates'] == 0 and status['skippedUnsupported'] == 1
        assert status['failures'] == [] and status['error'] == ''
        # The frozen per-import cap holds on every batch POST.
        posts = import_posts(records)
        assert len(posts) == 2
        assert [len(body['documents']) for _, body in posts] == [200, 50]
        rows = registry.view(binding)
        assert len(rows) == 2
        assert all(row['status'] == 'registered' and row['source']['kind'] == 'folder' for row in rows)
        # The finished job stays visible for the doc library page until the
        # next import replaces it.
        assert job.status()['state'] == 'completed'


def settings_workspace_logical(config):
    grant = WorkspaceSelection(config).current()[1]
    return str(grant['logical_root']).rstrip('/')


def test_folder_job_dedups_against_registered_fingerprints(tmp_path):
    """T96-02: files whose fingerprints are already registered for this KB are
    skipped and counted, never uploaded twice."""
    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        (space / 'guide.md').write_bytes(GUIDE.encode('utf-8'))
        chat.register_local_import(KB, [str(space / 'guide.md')])
        assert len(import_posts(records)) == 1
        folder = space / 'library'
        folder.mkdir()
        (folder / 'guide.md').write_bytes(GUIDE.encode('utf-8'))
        (folder / 'fresh.md').write_bytes(b'fresh bytes\n')

        job.start(KB, str(folder))
        status = wait_terminal(job)

        assert status['state'] == 'completed'
        assert status['totalFiles'] == 2 and status['registeredDocuments'] == 1
        assert status['skippedDuplicates'] == 1
        # Only the genuinely new document reached the platform.
        posts = import_posts(records)
        assert len(posts) == 2 and [document['filename'] for document in posts[1][1]['documents']] == ['fresh.md']


def test_folder_job_cancel_stops_before_the_next_batch(tmp_path):
    """T96-03: cancel lands between batches; the finished batches stay
    registered and the job reports honestly that it was canceled."""
    with platform(local_import_delay=0.3) as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        folder = space / 'library'
        folder.mkdir()
        for index in range(401):
            (folder / f'doc{index:04}.md').write_bytes(f'document {index}\n'.encode('utf-8'))

        job.start(KB, str(folder))
        # Cancel while the second batch POST is in flight: the event must land
        # before the next batch boundary.
        wait_batches(job, 1)
        deadline = time.time() + 10.0
        while time.time() < deadline and len(import_posts(records)) < 2:
            time.sleep(0.02)
        assert job.cancel() is True
        status = wait_terminal(job)

        assert status['state'] == 'canceled'
        assert status['registeredBatches'] == 2 and status['registeredDocuments'] == 400
        # The third batch never reached the platform.
        assert len(import_posts(records)) == 2
        rows = registry.view(binding)
        assert len(rows) == 2 and all(row['status'] == 'registered' for row in rows)
        # Cancel is idempotent-safe: no running job, no effect.
        assert job.cancel() is False


def test_folder_job_start_refuses_busy_and_unready_boundaries(tmp_path):
    """T96-03: one job at a time; no confirmed workspace, no job; a malformed
    KB identity refuses before anything runs."""
    with platform(local_import_delay=0.3) as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        folder = space / 'library'
        folder.mkdir()
        for index in range(250):
            (folder / f'doc{index:04}.md').write_bytes(f'document {index}\n'.encode('utf-8'))

        job.start(KB, str(folder))
        with pytest.raises(KnowledgeImportError) as busy:
            job.start(KB, str(folder))
        assert busy.value.args[0] == 'KNOWLEDGE_IMPORT_BUSY'
        assert job.cancel() is True
        wait_terminal(job)

    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin, work=False)
        with pytest.raises(KnowledgeImportError) as refused:
            job.start(KB, str(tmp_path))
        assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'
        assert job.status() is None
    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        with pytest.raises(KnowledgeImportError) as invalid:
            job.start('not-a-uuid', str(space))
        assert invalid.value.args[0] == 'KNOWLEDGE_IMPORT_KB_INVALID'
        assert job.status() is None
        assert import_posts(records) == []


def test_folder_job_reports_refused_batches_and_job_failure(tmp_path):
    """T96-03: a platform refusal fails the job with its fixed category; the
    failed batch row keeps its intended documents for 重试."""
    with platform(local_import_status=500) as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        folder = space / 'library'
        folder.mkdir()
        (folder / 'guide.md').write_bytes(GUIDE.encode('utf-8'))

        job.start(KB, str(folder))
        status = wait_terminal(job)

        assert status['state'] == 'failed' and status['error'] == 'CHAT_SERVER_ERROR'
        assert status['failedBatches'] == 1 and status['registeredDocuments'] == 0
        row = registry.view(binding)[0]
        assert row['status'] == 'failed' and row['errorCode'] == 'CHAT_SERVER_ERROR'
        assert row['source']['folder'].endswith('/library')
        assert [document['filename'] for document in row['documents']] == ['guide.md']


def test_folder_job_reports_a_walk_refusal_as_a_failed_job(tmp_path):
    """T96-01: a folder outside the confirmed workspace never starts reading."""
    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        outside = tmp_path / 'outside'
        outside.mkdir()
        job.start(KB, str(outside))
        status = wait_terminal(job)
        assert status['state'] == 'failed'
        assert status['error'] == 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'
        assert import_posts(records) == []
        assert registry.view(binding) == []


def test_walk_refuses_a_vanished_workspace_root_by_category(tmp_path):
    """T96-01: a workspace root that vanished (unmount, external wipe) is
    refused by its own category, never by an escaping FileNotFoundError —
    the worker must be able to turn it into an honest failed state."""
    grant = dict(logical_root='/workspace/lib', physical_root=str(tmp_path / 'gone'),
                 identity=[12345, 67890])
    with pytest.raises(KnowledgeImportError) as refused:
        walk_import_folder(grant, str(tmp_path))
    assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'


def test_folder_job_survives_a_workspace_root_that_vanishes_midflight(tmp_path, monkeypatch):
    """T96-03: the workspace root disappearing while the worker runs fails
    the job by category instead of killing the worker into a running phantom
    that BUSY-refuses every later start."""
    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        folder = space / 'library'
        folder.mkdir()
        (folder / 'guide.md').write_bytes(GUIDE.encode('utf-8'))

        serve = job._knowledge_files

        def vanish_then_serve():
            shutil.rmtree(space, ignore_errors=True)
            return serve()

        monkeypatch.setattr(job, '_knowledge_files', vanish_then_serve)
        job.start(KB, str(folder))
        status = wait_terminal(job)
        assert status['state'] == 'failed'
        assert status['error'] == 'KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE'
        # No phantom happened: the slot is free, so the very next start is
        # accepted and settles honestly instead of refusing with BUSY.
        job.start(KB, str(folder))
        assert wait_terminal(job)['state'] == 'failed'


def test_folder_job_start_failure_never_leaves_a_phantom_job(tmp_path, monkeypatch):
    """T96-03: a worker thread that cannot start leaves no running phantom —
    the slot frees, nothing shows as an uncancelable import, and the very next
    start is accepted instead of refused with BUSY."""
    with platform() as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        (space / 'guide.md').write_bytes(GUIDE.encode('utf-8'))

        def refuse_thread_start(self):
            raise RuntimeError('cannot start a new thread')

        monkeypatch.setattr(threading.Thread, 'start', refuse_thread_start)
        with pytest.raises(RuntimeError):
            job.start(KB, str(space))
        monkeypatch.undo()
        assert job.status() is None
        # The same coordinator accepts a fresh start immediately.
        job.start(KB, str(space))
        assert wait_terminal(job)['state'] == 'completed'


def test_retry_reimports_a_failed_record_through_the_ordinary_seam(tmp_path):
    """T96-05: one failed folder record re-imports exactly its stored files;
    the failed record stays and the retry becomes its own honest row."""
    with platform(local_import_status=[500, 201]) as (origin, records):
        job, chat, registry, settings, config, space, binding = job_chat(tmp_path, origin)
        folder = space / 'library'
        folder.mkdir()
        (folder / 'guide.md').write_bytes(GUIDE.encode('utf-8'))
        (folder / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
        job.start(KB, str(folder))
        assert wait_terminal(job)['state'] == 'failed'
        row = registry.view(binding)[0]

        # The platform accepts again after the transient refusal: the retry
        # re-imports exactly the stored files through the ordinary seam.
        outcome = chat.retry_import_record(row['id'])
        assert outcome['documentCount'] == 2
        rows = registry.view(binding)
        assert [r['status'] for r in rows] == ['registered', 'failed']
        assert rows[0]['source']['folder'] == rows[1]['source']['folder']
        assert len(import_posts(records)) == 2

        # Only failed records retry; unknown identities refuse honestly.
        with pytest.raises(KnowledgeImportError) as not_failed:
            chat.retry_import_record(rows[0]['id'])
        assert not_failed.value.args[0] == 'KNOWLEDGE_IMPORT_RETRY_NOT_FAILED'
        with pytest.raises(KnowledgeImportError) as missing:
            chat.retry_import_record('a' * 64)
        assert missing.value.args[0] == 'KNOWLEDGE_IMPORT_RECORD_NOT_FOUND'


def test_retry_refuses_records_without_stored_sources(tmp_path):
    """T96-05: a failed explicit import carries no source paths; retry says so
    instead of guessing."""
    with platform(local_import_status=500) as (origin, records):
        chat, registry, settings, config, space, binding = prepare(tmp_path, origin)
        target = space / 'guide.md'
        target.write_bytes(GUIDE.encode('utf-8'))
        with pytest.raises(KnowledgeImportError):
            chat.register_local_import(KB, [str(target)])
        row = registry.view(binding)[0]
        assert row['status'] == 'failed' and row['source'] is None
        with pytest.raises(KnowledgeImportError) as refused:
            chat.retry_import_record(row['id'])
        assert refused.value.args[0] == 'KNOWLEDGE_IMPORT_NO_SOURCE'
