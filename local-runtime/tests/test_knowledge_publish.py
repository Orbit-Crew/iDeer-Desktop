"""Explicit server-side publication from the device (#115).

Every test drives the real DesktopChat seam against a protocol fixture and a
real confirmed workspace: the preview states the destination and uploads
nothing, the confirmed attempt sends the exact registered bytes through the
platform's own document upload endpoint, drifted or unknown content is
refused before any byte leaves the device, and every attempt outcome is
recorded as a real display fact that never impersonates a published copy.
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
from core.knowledge_publish import KnowledgePublicationRegistry, KnowledgePublishError, verify_against_registration
from core.platform_chat import DesktopChat
from core.receipt_ledger import profile_binding
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '44444444-4444-4444-8444-444444444444'
COPY = '55555555-5555-4555-8555-555555555555'
COPY_REVISION = '66666666-6666-4666-8666-666666666666'
GUIDE = '# marker\nlocal bytes that now publish explicitly\n'
DRIFTED = '# marker v2 CHANGED\n'


def multipart_payload(content_type, body):
    """Extract the single file part from the client's multipart request."""
    boundary = content_type.split('boundary=', 1)[1].split(';', 1)[0].encode()
    for part in body.split(b'--' + boundary):
        if b'Content-Disposition' not in part:
            continue
        _, _, payload = part.partition(b'\r\n\r\n')
        if payload.endswith(b'\r\n'):
            payload = payload[:-2]
        return payload
    return b''


@contextmanager
def platform(confirm_status=200, complete_status=200, final_status='published', preview_display_name='Team · 服务端副本 R1'):
    records = []
    state = {'uploads': [], 'confirmed': False, 'completed': False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            if 'multipart/form-data' in (self.headers.get('Content-Type') or ''):
                self.respond(multipart_payload(self.headers.get('Content-Type'), body))
            else:
                self.respond(json.loads(body) if body else {})

        def respond(self, body):
            records.append((self.command, self.path, body, dict(self.headers)))
            status, data = 200, {}
            if self.path == '/api/v1/auth/me':
                data = {'id': 'A', 'email': 'a@test.invalid', 'system_role': 'user', 'permissions': ['runs:create']}
            elif self.path.endswith('/knowledge-revisions/local-imports'):
                data = dict(id=REVISION, resource_id=self.path.split('/')[3], revision_no=1, status='draft',
                            manifest_hash=hashlib.sha256(json.dumps(
                                sorted(d['content_hash'] for d in body['documents'])).encode()).hexdigest(),
                            document_count=len(body['documents']))
            elif self.path.endswith('/local-publication/preview') and self.command == 'GET':
                destination = dict(kind='server_copy', slug='team-pub-r1',
                                   visibility='private', governance='visibility_application_required')
                if preview_display_name is not None:
                    destination['display_name'] = preview_display_name
                data = dict(
                    source=dict(resource_id=KB, revision_id=REVISION, revision_no=1,
                                manifest_hash='a' * 64, document_count=1),
                    documents=[dict(document_id='doc-1', filename='guide.md', size_bytes=len(GUIDE),
                                    mime_type='text/markdown', content_hash=hashlib.sha256(GUIDE.encode()).hexdigest())],
                    destination=destination,
                    upload_policy=dict(requires_explicit_confirmation=True, device_kb_unchanged=True, two_way_sync=False))
            elif self.path.endswith('/local-publication') and self.command == 'POST':
                state['confirmed'] = True
                if confirm_status != 200:
                    status = confirm_status
                    data = dict(detail='LOCAL_PUBLISH_CONFIRMATION_REQUIRED')
                else:
                    data = dict(status='awaiting_content', missing_documents=['guide.md'],
                                copy=dict(resource_id=COPY, slug='team-pub-r1', display_name='Team · 服务端副本 R1',
                                          visibility='private', document_count=0, documents=[]),
                                revision=None)
            elif '/documents' in self.path and self.command == 'POST':
                state['uploads'].append(body)
                data = dict(id=f'doc-{len(state["uploads"])}', content_hash=hashlib.sha256(body).hexdigest())
            elif self.path.endswith('/local-publication/complete'):
                state['completed'] = True
                if complete_status != 200:
                    status = complete_status
                    data = dict(detail='LOCAL_PUBLISH_CONTENT_INCOMPLETE: guide.md')
                else:
                    data = dict(status='publishing', missing_documents=[],
                                copy=dict(resource_id=COPY, slug='team-pub-r1', visibility='private'),
                                revision=dict(resource_id=COPY, id=COPY_REVISION, revision_no=1, status='indexing',
                                              manifest_hash='b' * 64, failure_code=None, failure_message=None,
                                              published_at=None, provider_dataset_id=None))
            elif self.path.endswith('/local-publication') and self.command == 'GET':
                data = dict(status=final_status, missing_documents=[],
                            copy=dict(resource_id=COPY, slug='team-pub-r1', visibility='private'),
                            revision=dict(resource_id=COPY, id=COPY_REVISION, revision_no=1, status=final_status,
                                          manifest_hash='b' * 64,
                                          failure_code=None if final_status == 'published' else 'parse_failed',
                                          failure_message=None, published_at=None, provider_dataset_id='ds-1'))
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
        yield f'http://127.0.0.1:{server.server_address[1]}', records, state
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
        device_public_key='device-key-115', server_public_key='broker-key-115',
        session_token_ref='device-session-115',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    if work:
        WorkspaceSelection(config).select(str(space), confirmed=True)
    imports = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    publications = KnowledgePublicationRegistry(config.with_name('knowledge-publications.db'))

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       knowledge_imports=imports, knowledge_files=knowledge_files,
                       knowledge_publications=publications)
    return chat, imports, publications, config, space, profile_binding(load_settings(config))


def register_import(chat, space):
    guide = space / 'guide.md'
    guide.write_bytes(GUIDE.encode('utf-8'))
    return chat.register_local_import(KB, [str(guide)]), guide


def publish_posts(records, suffix):
    return [(path, body) for method, path, body, _ in records
            if method == 'POST' and path.endswith(suffix)]


def test_preview_states_destination_and_uploads_nothing(tmp_path):
    """T115-01: the read-only preview explains the destination; nothing uploads."""
    with platform() as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        outcome, guide = register_import(chat, space)
        del outcome, guide
        del records[:]

        preview = chat.publish_local_revision(KB, REVISION, [str(space / 'guide.md')], confirmed=False)

        assert preview['confirmed'] is False
        assert preview['destination']['kind'] == 'server_copy'
        assert preview['destination']['visibility'] == 'private'
        assert preview['destination']['governance'] == 'visibility_application_required'
        # Issue 42: the Server's `display_name` crosses this seam as the
        # camelCase name the Desktop confirmation dialog renders.
        assert preview['destination']['displayName'] == 'Team · 服务端副本 R1'
        assert 'display_name' not in preview['destination']
        assert preview['source']['revision_id'] == REVISION
        assert preview['documents'][0]['sha256'] == hashlib.sha256(GUIDE.encode()).hexdigest()
        # Read-only: no confirm, no upload, no completion, and no recorded row.
        assert not any(path.endswith('/local-publication') and method == 'POST'
                       for method, path, _, _ in records)
        assert state['uploads'] == [] and not state['confirmed'] and not state['completed']
        assert publications.view(binding) == []


def test_preview_without_destination_name_fails_closed(tmp_path):
    """Issue 42: a preview the dialog cannot render never becomes a silent pass."""
    with platform(preview_display_name=None) as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        register_import(chat, space)
        del records[:]

        with pytest.raises(KnowledgePublishError) as refused:
            chat.publish_local_revision(KB, REVISION, [str(space / 'guide.md')], confirmed=False)
        assert refused.value.args[0] == 'CHAT_PROTOCOL_ERROR'
        # The refused preview uploaded nothing; the attempt is recorded as a
        # real failed display fact, never as a published copy.
        assert state['uploads'] == [] and not state['confirmed']
        rows = publications.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'failed'
        assert rows[0]['errorCode'] == 'CHAT_PROTOCOL_ERROR'


def test_unconfirmed_server_refusal_is_mapped_and_recorded(tmp_path):
    """T115-01: a server-side confirmation refusal keeps its fixed category."""
    with platform(confirm_status=409) as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        register_import(chat, space)
        del records[:]

        with pytest.raises(KnowledgePublishError) as refused:
            chat.publish_local_revision(KB, REVISION, [str(space / 'guide.md')], confirmed=True)
        assert refused.value.args[0] == 'LOCAL_PUBLISH_CONFIRMATION_REQUIRED'
        # The refused attempt is recorded as a real failure, never a success.
        rows = publications.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'failed'
        assert rows[0]['errorCode'] == 'LOCAL_PUBLISH_CONFIRMATION_REQUIRED'


def test_confirmed_publication_uploads_exact_registered_content(tmp_path):
    """T115-02: confirmation uploads the exact registered bytes to the copy."""
    with platform() as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        register_import(chat, space)
        del records[:]

        outcome = chat.publish_local_revision(KB, REVISION, [str(space / 'guide.md')], confirmed=True,
                                              publish_polls=1)

        assert outcome['confirmed'] is True
        assert outcome['status'] == 'published'
        assert outcome['copyResourceId'] == COPY
        assert outcome['copySlug'] == 'team-pub-r1'
        assert outcome['copyRevisionId'] == COPY_REVISION
        assert outcome['documentCount'] == 1
        # Exactly one document upload carrying the exact registered bytes.
        assert len(state['uploads']) == 1
        assert state['uploads'][0] == GUIDE.encode()
        assert state['confirmed'] and state['completed']
        # The confirm request is the explicit gate: confirmed=true only.
        confirms = publish_posts(records, '/local-publication')
        assert len(confirms) == 1 and confirms[0][1] == {'confirmed': True}
        rows = publications.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'published'
        assert rows[0]['copyResourceId'] == COPY and rows[0]['errorCode'] == ''


def test_drifted_content_is_refused_before_any_byte_moves(tmp_path):
    """T115-03/T115-04: drifted content never uploads; the refusal is recorded."""
    with platform() as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        register_import(chat, space)
        drifted = space / 'guide.md'
        drifted.write_bytes(DRIFTED.encode('utf-8'))
        del records[:]

        with pytest.raises(KnowledgePublishError) as refused:
            chat.publish_local_revision(KB, REVISION, [str(drifted)], confirmed=True)
        assert refused.value.args[0] == 'LOCAL_PUBLISH_CONTENT_DRIFTED'
        # Nothing reached the platform: no confirm, no copy, no upload.
        assert publish_posts(records, '/local-publication') == []
        assert state['uploads'] == [] and not state['confirmed']
        rows = publications.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'failed'
        assert rows[0]['errorCode'] == 'LOCAL_PUBLISH_CONTENT_DRIFTED'


def test_unknown_revision_cannot_publish_from_this_device(tmp_path):
    """T115-03: only a revision this identity registered can be published."""
    with platform() as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        guide = space / 'guide.md'
        guide.write_bytes(GUIDE.encode('utf-8'))

        with pytest.raises(KnowledgePublishError) as refused:
            chat.publish_local_revision(KB, REVISION, [str(guide)], confirmed=False)
        assert refused.value.args[0] == 'KNOWLEDGE_PUBLISH_REVISION_UNKNOWN'
        # Nothing reached the platform, and the refusal is a recorded failure.
        assert records == []
        rows = publications.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'failed'
        assert rows[0]['errorCode'] == 'KNOWLEDGE_PUBLISH_REVISION_UNKNOWN'


def test_failed_build_is_recorded_as_failed_not_published(tmp_path):
    """T115-04: a failed platform build surfaces its real failure code."""
    with platform(final_status='failed') as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        register_import(chat, space)
        del records[:]

        outcome = chat.publish_local_revision(KB, REVISION, [str(space / 'guide.md')], confirmed=True,
                                              publish_polls=1)

        assert outcome['status'] == 'failed'
        assert outcome['failureCode'] == 'parse_failed'
        rows = publications.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'failed'
        assert rows[0]['errorCode'] == 'parse_failed'
        assert rows[0]['copyResourceId'] == COPY


def test_publication_records_stay_identity_bound(tmp_path):
    """T115-03: a switched account never inherits publication display facts."""
    with platform() as (origin, records, state):
        chat, imports, publications, config, space, binding = prepare(tmp_path, origin)
        register_import(chat, space)
        chat.publish_local_revision(KB, REVISION, [str(space / 'guide.md')], confirmed=True, publish_polls=1)
        assert len(publications.view(binding)) == 1

        switched = load_settings(config)
        switched.user_id = 'B'
        switched.save(config)
        assert publications.view(profile_binding(load_settings(config))) == []
        assert publications.view(binding)[0]['status'] == 'published'


def test_verify_against_registration_rejects_drift_missing_and_extra():
    """The device-side verifier fails closed before any network activity."""
    registered = dict(documents=[dict(filename='guide.md', sha256='a' * 64, bytes=10)])
    exact = [dict(filename='guide.md', sha256='a' * 64, bytes=10, mime='text/markdown')]
    verify_against_registration(exact, registered)
    with pytest.raises(KnowledgePublishError):
        verify_against_registration([dict(filename='guide.md', sha256='b' * 64, bytes=10)], registered)
    with pytest.raises(KnowledgePublishError):
        verify_against_registration([], registered)
    with pytest.raises(KnowledgePublishError):
        verify_against_registration([exact[0], dict(filename='extra.md', sha256='a' * 64, bytes=10)], registered)
    with pytest.raises(KnowledgePublishError):
        verify_against_registration(exact, dict(documents=[]))
