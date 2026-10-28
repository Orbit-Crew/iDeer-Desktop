"""Explicit Desktop skill package import from the device (#120).

Every test drives the real DesktopChat seam against a protocol fixture and
real local packages: the device-side preview states the full upload scope
(body, scripts, references, hashes) and uploads nothing, the confirmed
attempt binds the exact bytes through the Server's preview identity before
creating anything, illegal package content is refused before any byte leaves
the device, publication records the platform's version copy, and the
registry keeps binding-scoped display facts that never impersonate a draft
or a version.
"""
from __future__ import annotations

import hashlib
import io
import json
import threading
import zipfile
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from core.platform_chat import DesktopChat
from core.receipt_ledger import profile_binding
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings
from core.skill_import import SkillImportError, SkillImportRegistry

RESOURCE = '77777777-7777-4777-8777-777777777777'
VERSION_HASH = 'b' * 64

SKILL_MD = '---\nname: report-skill\ndescription: Build a weekly report\n---\n\n# Report skill\n'
SCRIPT = "print('analyze')\n"
REFERENCE = '# Frozen reference notes\n'


def canonical_hash(members: list[tuple[str, bytes]]) -> str:
    """The platform's own package hash: sorted relative POSIX paths, length-prefixed."""
    digest = hashlib.sha256()
    for relative, data in sorted(members, key=lambda item: item[0]):
        encoded = relative.encode()
        digest.update(len(encoded).to_bytes(4, 'big'))
        digest.update(encoded)
        digest.update(data)
    return digest.hexdigest()


def multipart_fields(content_type, body):
    """Split one multipart body into its form fields and the single file part."""
    boundary = content_type.split('boundary=', 1)[1].split(';', 1)[0].encode()
    fields, payload, payload_name = {}, b'', ''
    for part in body.split(b'--' + boundary):
        if b'Content-Disposition' not in part:
            continue
        head, _, data = part.partition(b'\r\n\r\n')
        if data.endswith(b'\r\n'):
            data = data[:-2]
        name = head.split(b'name="', 1)[1].split(b'"', 1)[0].decode()
        if b'filename' in head:
            payload = data
            payload_name = name
        else:
            fields[name] = data.decode()
    return fields, payload, payload_name


@contextmanager
def platform(confirm_status=200, preview_hash=None):
    records = []
    state = {'confirmed_slugs': [], 'part_names': []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond({})

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            if 'multipart/form-data' in (self.headers.get('Content-Type') or ''):
                fields, payload, payload_name = multipart_fields(self.headers['Content-Type'], body)
                state['part_names'].append(payload_name)
                records.append((self.command, self.path, fields, payload))
                self.respond(self.package_response(fields, payload))
            else:
                records.append((self.command, self.path, json.loads(body) if body else {}, b''))
                self.respond(self.publish_response(json.loads(body) if body else {}))

        def package_response(self, fields, payload):
            members = []
            if fields.get('origin') == 'markdown':
                members = [('SKILL.md', payload)]
            else:
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    members = [(name, archive.read(name)) for name in archive.namelist()]
            computed = canonical_hash(members) if preview_hash is None else preview_hash
            if self.path.endswith('/preview'):
                return dict(origin=fields.get('origin'), name='report-skill',
                            description='Build a weekly report', body='…', body_truncated=False,
                            files=[], file_count=len(members),
                            total_bytes=sum(len(data) for _name, data in members), package_hash=computed)
            return dict(id=RESOURCE, type='skill', slug='report-skill', display_name='report-skill',
                        owner_id='A', visibility='private', latest_version=0, draft_revision=1,
                        storage_kind='filesystem', provenance='user', system_owned=False,
                        authz_revision=1, can_modify=True,
                        draft=dict(revision=1, content_hash=computed))

        def publish_response(self, body):
            return dict(version=body.get('expected_draft_revision', 0) + 1, content_hash=VERSION_HASH,
                        published_at=None, scan_result={})

        def respond(self, data):
            # The platform refuses a second confirm for a slug the owner
            # already has (uq_resources_type_owner_slug); model that honestly.
            status = 200
            if self.path.endswith('/confirm'):
                if confirm_status != 200:
                    status = confirm_status
                elif state['confirmed_slugs']:
                    status = 409
                    data = dict(detail="Current owner already has skill slug 'report-skill'")
                else:
                    state['confirmed_slugs'].append('report-skill')
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


def prepare(tmp_path: Path, origin: str, *, authenticated=True):
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-120', server_public_key='broker-key-120',
        session_token_ref='device-session-120',
        business_token_ref='business-A' if authenticated else None,
        business_expires_at='2099-01-01T00:00:00+00:00' if authenticated else None)
    settings.save(config)
    imports = SkillImportRegistry(config.with_name('skill-imports.db'))

    def login_status():
        return {'state': 'authenticated' if authenticated else 'unauthenticated'}

    chat = DesktopChat(config, secure, login_status, skill_imports=imports)
    return chat, imports, config, profile_binding(load_settings(config))


def make_fixtures(tmp_path: Path):
    """A fixed Markdown package, the same content as ZIP, and as a directory."""
    (tmp_path / 'report-skill.md').write_text(SKILL_MD, encoding='utf-8')
    members = [('SKILL.md', SKILL_MD.encode()), ('scripts/analyze.py', SCRIPT.encode()),
               ('references/notes.md', REFERENCE.encode())]
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as bundle:
        for name, data in members:
            bundle.writestr(name, data)
    (tmp_path / 'report-skill.zip').write_bytes(archive.getvalue())
    directory = tmp_path / 'report-skill'
    for name, data in members:
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return members, canonical_hash(members)


def posts(records, suffix):
    return [(fields, payload) for method, path, fields, payload in records
            if method == 'POST' and path.endswith(suffix)]


@pytest.mark.parametrize('kind', ['markdown', 'zip', 'directory'])
def test_preview_states_upload_scope_and_uploads_nothing(tmp_path, kind):
    """T120-01: the device-side preview covers body/scripts/references; nothing is sent."""
    with platform() as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        members, package_hash = make_fixtures(tmp_path)
        del records[:]
        paths = {'markdown': str(tmp_path / 'report-skill.md'),
                 'zip': str(tmp_path / 'report-skill.zip'),
                 'directory': str(tmp_path / 'report-skill')}[kind]

        preview = chat.import_skill_package(kind, [paths], confirmed=False)

        assert preview['confirmed'] is False
        assert preview['origin'] == kind
        assert preview['name'] == 'report-skill'
        assert '# Report skill' in preview['body']
        # Markdown wraps as a single SKILL.md member; ZIP and directory carry
        # all three members — each hash names exactly its own canonical bytes.
        expected_hash = canonical_hash([('SKILL.md', SKILL_MD.encode())]) if kind == 'markdown' else package_hash
        assert preview['packageHash'] == expected_hash
        assert preview['fileCount'] == (1 if kind == 'markdown' else 3)
        if kind != 'markdown':
            assert [(row['path'], row['role']) for row in preview['files']] == [
                ('SKILL.md', 'body'), ('references/notes.md', 'reference'), ('scripts/analyze.py', 'script')]
        else:
            assert [(row['path'], row['role']) for row in preview['files']] == [('SKILL.md', 'body')]
        assert preview['destination'] == {'resourceType': 'skill', 'visibility': 'private'}
        assert records == []
        # An unconfirmed package leaves no import display fact behind.
        assert imports.view(binding) == []


def test_confirmed_import_binds_hash_and_lands_private_draft(tmp_path):
    """T120-01/T120-02: the confirmed upload is bound to the preview hash and lands a private draft."""
    with platform() as (origin, records, state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        members, package_hash = make_fixtures(tmp_path)
        path = str(tmp_path / 'report-skill.zip')

        outcome = chat.import_skill_package('zip', [path], confirmed=True)

        assert outcome['confirmed'] is True
        assert outcome['resourceId'] == RESOURCE
        assert outcome['slug'] == 'report-skill'
        assert outcome['revision'] == 1
        assert outcome['contentHash'] == package_hash
        preview_posts, confirm_posts = posts(records, '/preview'), posts(records, '/confirm')
        assert len(preview_posts) == 1 and len(confirm_posts) == 1
        assert confirm_posts[0][0]['origin'] == 'zip'
        assert confirm_posts[0][0]['expected_package_hash'] == package_hash
        # The upload speaks the Server's exact multipart contract: the file
        # part is the endpoint's ``archive`` field on both calls.
        assert state['part_names'] == ['archive', 'archive']
        # The device hash and the platform's independently computed hash of the
        # received bytes coincide: one hash names the same bytes on both sides.
        assert confirm_posts[0][1] == (tmp_path / 'report-skill.zip').read_bytes()
        rows = imports.view(binding)
        assert len(rows) == 1 and rows[0]['status'] == 'imported'
        assert rows[0]['resourceId'] == RESOURCE and rows[0]['revision'] == 1
        assert rows[0]['contentHash'] == package_hash


def test_illegal_package_content_is_refused_before_any_upload(tmp_path):
    """T120-03: traversal, absolute, symlink, and executable members fail closed device-side."""
    with platform() as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        make_fixtures(tmp_path)

        def bundled(member):
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('SKILL.md', SKILL_MD)
                info = zipfile.ZipInfo(member[0])
                info.external_attr = member[1]
                bundle.writestr(info, member[2])
            archive.seek(0)
            return archive

        illegal = [
            (bundled(('../escape.txt', 0o600 << 16, b'evil')), 'SKILL_IMPORT_ILLEGAL_CONTENT'),
            (bundled(('/absolute.txt', 0o600 << 16, b'absolute')), 'SKILL_IMPORT_ILLEGAL_CONTENT'),
            (bundled(('scripts/link.py', 0o120777 << 16, b'target')), 'SKILL_IMPORT_ILLEGAL_CONTENT'),
            (bundled(('scripts/run.sh', 0o600 << 16, b'echo hi')), 'SKILL_IMPORT_ILLEGAL_CONTENT'),
        ]
        for archive, category in illegal:
            path = tmp_path / 'illegal.zip'
            path.write_bytes(archive.getvalue())
            with pytest.raises(SkillImportError) as caught:
                chat.import_skill_package('zip', [str(path)], confirmed=False)
            assert str(caught.value) == category
        # A package without SKILL.md and markdown without front-matter refuse too.
        empty = io.BytesIO()
        with zipfile.ZipFile(empty, 'w') as bundle:
            bundle.writestr('README.md', 'no skill here')
        path = tmp_path / 'empty.zip'
        path.write_bytes(empty.getvalue())
        with pytest.raises(SkillImportError) as caught:
            chat.import_skill_package('zip', [str(path)], confirmed=False)
        assert str(caught.value) == 'SKILL_IMPORT_MISSING_SKILL_MD'
        plain = tmp_path / 'plain.md'
        plain.write_text('# no frontmatter\n', encoding='utf-8')
        with pytest.raises(SkillImportError) as caught:
            chat.import_skill_package('markdown', [str(plain)], confirmed=False)
        assert str(caught.value) == 'SKILL_IMPORT_INVALID_FRONTMATTER'
        # A vanished selection fails with the fixed invalid-path category.
        with pytest.raises(SkillImportError) as caught:
            chat.import_skill_package('zip', [str(tmp_path / 'gone.zip')], confirmed=False)
        assert str(caught.value) == 'SKILL_IMPORT_PATH_INVALID'
        # Nothing was uploaded and every attempt is recorded with its real
        # category; identical categories collapse to the first fact by design.
        assert records == []
        failed = imports.view(binding)
        assert {row['errorCode'] for row in failed} == {
            'SKILL_IMPORT_ILLEGAL_CONTENT', 'SKILL_IMPORT_MISSING_SKILL_MD', 'SKILL_IMPORT_INVALID_FRONTMATTER',
            'SKILL_IMPORT_PATH_INVALID'}
        assert all(row['status'] == 'failed' for row in failed)


def test_server_hash_drift_refuses_confirm(tmp_path):
    """T120-03: a platform preview that disagrees with the device hash refuses before confirming."""
    with platform(preview_hash='a' * 64) as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        make_fixtures(tmp_path)
        with pytest.raises(SkillImportError) as caught:
            chat.import_skill_package('zip', [str(tmp_path / 'report-skill.zip')], confirmed=True)
        assert str(caught.value) == 'SKILL_IMPORT_HASH_MISMATCH'
        assert posts(records, '/confirm') == []
        rows = imports.view(binding)
        assert rows[0]['status'] == 'failed' and rows[0]['errorCode'] == 'SKILL_IMPORT_HASH_MISMATCH'


def test_local_edit_cannot_impersonate_the_platform_version(tmp_path):
    """T120-02: editing the local cache changes the hash; the platform copy keeps its own identity."""
    with platform() as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        make_fixtures(tmp_path)
        path = tmp_path / 'report-skill.md'
        chat.import_skill_package('markdown', [str(path)], confirmed=True)
        path.write_text(SKILL_MD.replace('weekly', 'monthly'), encoding='utf-8')
        drifted = chat.import_skill_package('markdown', [str(path)], confirmed=False)
        assert drifted['packageHash'] != imports.view(binding)[0]['contentHash']
        # A drifted local edit never lands as the same platform version: the
        # drifted hash names different bytes, and the platform refuses a
        # second draft for a slug the owner already has.
        with pytest.raises(SkillImportError) as caught:
            chat.import_skill_package('markdown', [str(path)], confirmed=True)
        assert str(caught.value) == 'CHAT_CONFLICT'
        assert imports.view(binding)[0]['status'] == 'failed'


def test_publish_records_the_platform_version_copy(tmp_path):
    """T120-04 (device leg): publication yields the immutable version copy; the draft handle is the source."""
    with platform() as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        make_fixtures(tmp_path)
        chat.import_skill_package('zip', [str(tmp_path / 'report-skill.zip')], confirmed=True)
        del records[:]

        published = chat.publish_skill(RESOURCE, 1)

        assert published['resourceId'] == RESOURCE
        assert published['version'] == 2
        assert published['contentHash'] == VERSION_HASH
        publish_posts = [(path, body) for method, path, body, _payload in records if method == 'POST']
        assert publish_posts and publish_posts[0][0].endswith('/publish')
        assert publish_posts[0][1]['expected_draft_revision'] == 1
        rows = [row for row in imports.view(binding) if row['status'] == 'published']
        assert rows and rows[0]['version'] == 2 and rows[0]['revision'] == 1


def test_unauthenticated_confirm_is_refused_and_recorded(tmp_path):
    with platform() as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin, authenticated=False)
        make_fixtures(tmp_path)
        with pytest.raises(SkillImportError) as caught:
            chat.import_skill_package('zip', [str(tmp_path / 'report-skill.zip')], confirmed=True)
        assert str(caught.value) == 'CHAT_UNAUTHENTICATED'
        assert records == []
        rows = imports.view(binding)
        assert rows[0]['status'] == 'failed' and rows[0]['errorCode'] == 'CHAT_UNAUTHENTICATED'


def test_registry_rows_never_cross_identities(tmp_path):
    with platform() as (origin, records, _state):
        chat, imports, config, binding = prepare(tmp_path, origin)
        make_fixtures(tmp_path)
        chat.import_skill_package('zip', [str(tmp_path / 'report-skill.zip')], confirmed=True)
        other = hashlib.sha256(b'another-profile-binding').hexdigest()
        assert imports.view(other) == []
        assert imports.view(binding)
