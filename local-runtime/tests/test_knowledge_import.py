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
def platform(local_import_status=201):
    records = []

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
                data = revision_payload(self.path, body, len(records)) if local_import_status == 201 else {}
                status = local_import_status
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
        guide.write_text(GUIDE, encoding='utf-8')
        notes.write_text(NOTES, encoding='utf-8')

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
        target.write_text(GUIDE, encoding='utf-8')
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
        target.write_text(GUIDE, encoding='utf-8')
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
        inside.write_text(GUIDE, encoding='utf-8')
        outside = tmp_path / 'outside.md'
        outside.write_text('outside bytes\n', encoding='utf-8')
        if kind == 'protected':
            restricted = space / 'node_modules'
            restricted.mkdir()
            picked = [str(restricted / 'notes.md')]
            (restricted / 'notes.md').write_text(GUIDE, encoding='utf-8')
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
        marked.write_text(GUIDE, encoding='utf-8')
        first = chat.register_local_import(KB, [str(marked)])
        marked.write_text(CHANGED, encoding='utf-8')
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
        target.write_text(GUIDE, encoding='utf-8')
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
        target.write_text(GUIDE, encoding='utf-8')
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
        target.write_text(GUIDE, encoding='utf-8')
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
    assert entries == [dict(filename='guide.md', sha256=hashlib.sha256(b'same bytes').hexdigest(),
                            bytes=10, mime=mimetypes.guess_type('guide.md')[0] or 'application/octet-stream')]
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
    target.write_text(GUIDE, encoding='utf-8')
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
