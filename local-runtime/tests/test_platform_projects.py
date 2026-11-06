"""Platform project management commands against the platform protocol fixture (#91).

Every operation rides the Server's own Project API: the listing, the create,
the rename patch, the archive/restore status flip and the destructive delete.
The project list is the Server's own answer — the desktop never keeps a second
roster, so the same account on another device reads the same projects, and
deleting or archiving a project here never touches local files or directory
grants (the platform clears Thread membership itself; nothing local is bound).
"""
import json
import threading
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROJECT_A = 'proj-active-1'
PROJECT_B = 'proj-archived-1'


@contextmanager
def platform(permissions=('projects:read', 'projects:write', 'projects:delete'),
             delete_status=204, rename_status=200, archive_status=200):
    """A minimal Project-API fixture: one active and one archived project."""
    lock = threading.Lock()
    projects = {
        PROJECT_A: dict(id=PROJECT_A, name='工程项目', status='active',
                        created_at='2026-10-30T08:00:00+00:00', updated_at='2026-10-31T07:00:00+00:00'),
        PROJECT_B: dict(id=PROJECT_B, name='归档项目', status='archived',
                        created_at='2026-10-29T08:00:00+00:00', updated_at='2026-10-30T09:00:00+00:00'),
    }
    records = []

    def row_payload(row):
        return {'id': row['id'], 'name': row['name'], 'instructions': '',
                'presentation': {}, 'status': row['status'],
                'created_at': row['created_at'], 'updated_at': row['updated_at']}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_DELETE(self):
            self.respond('DELETE', None)

        def do_GET(self):
            self.respond('GET', None)

        def do_PATCH(self):
            self.respond('PATCH', json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))))

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
            self.respond('POST', json.loads(raw) if raw else None)

        def respond(self, method, body):
            records.append((method, self.path, body, dict(self.headers)))
            with lock:
                if self.path == '/api/v1/auth/me':
                    status = 200
                    data = {'id': 'A', 'email': 'A@test.invalid', 'system_role': 'user',
                            'permissions': list(permissions)}
                elif method == 'POST' and self.path == '/api/projects':
                    status = 201
                    row = dict(id='proj-new-1', name=body['name'], status='active',
                               created_at='2026-11-01T08:00:00+00:00', updated_at='2026-11-01T08:00:00+00:00')
                    projects[row['id']] = row
                    data = row_payload(row)
                elif self.path == '/api/projects':
                    status = 200
                    data = {'projects': [row_payload(row) for row in projects.values()]}
                elif method == 'PATCH' and self.path.startswith('/api/projects/'):
                    project_id = self.path.split('/')[3]
                    if project_id not in projects:
                        status, data = 404, {}
                    elif rename_status != 200:
                        status, data = rename_status, {}
                    else:
                        status = 200
                        row = projects[project_id]
                        row['name'] = body['name']
                        row['updated_at'] = '2026-10-31T08:00:00+00:00'
                        data = row_payload(row)
                elif method == 'POST' and self.path.endswith(('/archive', '/restore')):
                    project_id = self.path.split('/')[3]
                    if project_id not in projects:
                        status, data = 404, {}
                    elif archive_status != 200:
                        status, data = archive_status, {}
                    else:
                        status = 200
                        row = projects[project_id]
                        row['status'] = 'archived' if self.path.endswith('/archive') else 'active'
                        row['updated_at'] = '2026-10-31T08:00:00+00:00'
                        data = row_payload(row)
                elif method == 'DELETE' and self.path.startswith('/api/projects/'):
                    project_id = self.path.rsplit('/', 1)[-1]
                    if project_id not in projects:
                        status, data = 404, {}
                    elif delete_status != 204:
                        status, data = delete_status, {}
                    else:
                        status = 204
                        projects.pop(project_id)
                        data = None
                else:
                    status, data = 404, {'detail': 'Not visible'}
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            if data is not None:
                self.wfile.write(json.dumps(data).encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', records
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def make_chat(tmp_path, origin):
    from core.platform_chat import DesktopChat
    from core.secrets import InMemorySecretStore
    from core.settings import RuntimeSettings
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00',
                               device_id='device-1', device_public_key='dev-key',
                               server_public_key='broker-key')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}), settings, config


def wire(action, scope, **fields):
    return {'type': 'projects', 'id': 'req-1', 'action': action, 'scope': scope, **fields}


def test_list_returns_platform_projects_and_permissions(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.projects_manage(wire('list', chat.handle({'action': 'state'})['scope']))
        assert result['permissions'] == {'canWrite': True, 'canDelete': True}
        # The Server's own rows, identity facts only — instructions and
        # presentation stay platform-side; archived projects ride along so the
        # manage surface can offer restore.
        assert result['projects'] == [
            {'id': PROJECT_A, 'name': '工程项目', 'status': 'active',
             'createdAt': '2026-10-30T08:00:00+00:00', 'updatedAt': '2026-10-31T07:00:00+00:00'},
            {'id': PROJECT_B, 'name': '归档项目', 'status': 'archived',
             'createdAt': '2026-10-29T08:00:00+00:00', 'updatedAt': '2026-10-30T09:00:00+00:00'},
        ]
        listings = [(method, body) for method, path, body, _ in records if path == '/api/projects']
        assert listings == [('GET', None)]


def test_create_posts_name_and_rereads(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        result = chat.projects_manage(wire('create', scope, name='  新项目  '))
        assert result['created'] is True
        creates = [body for method, path, body, _ in records
                   if method == 'POST' and path == '/api/projects']
        assert creates == [{'name': '新项目'}]
        assert [row['name'] for row in result['projects']] == ['工程项目', '归档项目', '新项目']


def test_rename_patches_platform_name_and_rereads(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        result = chat.projects_manage(wire('rename', scope, projectId=PROJECT_A, name='  改名项目  '))
        assert result['renamed'] is True
        patches = [(path, body) for method, path, body, _ in records
                   if method == 'PATCH' and path == f'/api/projects/{PROJECT_A}']
        assert patches == [(f'/api/projects/{PROJECT_A}', {'name': '改名项目'})]
        assert [row['name'] for row in result['projects'] if row['id'] == PROJECT_A] == ['改名项目']


def test_archive_and_restore_flip_platform_status(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        archived = chat.projects_manage(wire('archive', scope, projectId=PROJECT_A))
        assert archived['archived'] is True
        assert [row['status'] for row in archived['projects'] if row['id'] == PROJECT_A] == ['archived']
        restored = chat.projects_manage(wire('restore', scope, projectId=PROJECT_A))
        assert restored['restored'] is True
        assert [row['status'] for row in restored['projects'] if row['id'] == PROJECT_A] == ['active']
        flips = [path for method, path, _, _ in records
                 if method == 'POST' and path in (f'/api/projects/{PROJECT_A}/archive',
                                                  f'/api/projects/{PROJECT_A}/restore')]
        assert flips == [f'/api/projects/{PROJECT_A}/archive', f'/api/projects/{PROJECT_A}/restore']


def test_delete_removes_platform_project_only(tmp_path):
    with platform() as (origin, records):
        chat, _, config = make_chat(tmp_path, origin)
        before = sorted(path.name for path in config.parent.iterdir())
        scope = chat.handle({'action': 'state'})['scope']
        result = chat.projects_manage(wire('delete', scope, projectId=PROJECT_B))
        assert result['deleted'] is True
        assert [row['id'] for row in result['projects']] == [PROJECT_A]
        deletes = [method for method, path, _, _ in records if path == f'/api/projects/{PROJECT_B}']
        assert deletes == ['DELETE']
        # 删除/归档项目不动本机文件与目录授权：the command performs no local
        # writes — the only local artifacts are the settings the chat session
        # itself already owns, byte-identical before and after.
        assert sorted(path.name for path in config.parent.iterdir()) == before


def test_delete_and_archive_leave_workspace_files_and_grants_untouched(tmp_path):
    """#95 negative path: the platform deleting or archiving a project never
    reaches this device — workspace files keep their exact bytes, the active
    directory grant survives untouched, and the chat session stays usable on
    the same identity afterwards."""
    from core.file_service import WorkspaceSelection
    with platform() as (origin, records):
        chat, _, config = make_chat(tmp_path, origin)
        work = tmp_path / 'workspace'
        work.mkdir()
        (work / 'result.txt').write_text('本地结果\n', encoding='utf-8')
        (work / 'sub').mkdir()
        (work / 'sub' / 'nested.bin').write_bytes(b'\x00\x01binary-bytes')
        selection = WorkspaceSelection(config)
        selection.select(str(work), confirmed=True)
        grant = selection.allow_write()
        grants_before = selection.grants()
        assert [row['id'] for row in grants_before] == [grant['id']]
        files_before = sorted((str(path.relative_to(work)), path.read_bytes())
                              for path in work.rglob('*') if path.is_file())
        scope = chat.handle({'action': 'state'})['scope']
        assert chat.projects_manage(wire('delete', scope, projectId=PROJECT_B))['deleted'] is True
        assert chat.projects_manage(wire('archive', scope, projectId=PROJECT_A))['archived'] is True
        # Files byte-identical, grant row identical (binding, directory, no revoke stamp).
        assert sorted((str(path.relative_to(work)), path.read_bytes())
                      for path in work.rglob('*') if path.is_file()) == files_before
        assert (work / 'result.txt').read_text(encoding='utf-8') == '本地结果\n'
        assert selection.grants() == grants_before
        # The session keeps its identity and stays fully usable.
        assert chat.handle({'action': 'state'})['scope'] == scope
        # Exactly the two platform round-trips happened; no local cleanup exists.
        assert [(method, path) for method, path, _, _ in records
                if method in ('DELETE', 'POST') and path.startswith('/api/projects/')] == [
            ('DELETE', f'/api/projects/{PROJECT_B}'), ('POST', f'/api/projects/{PROJECT_A}/archive')]


def test_archive_conflict_maps_to_chat_conflict(tmp_path):
    """#95: the busy-session guard stays intact for project archive too — the
    platform's own 409 surfaces as the shared CHAT_CONFLICT category."""
    with platform(archive_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('archive', scope, projectId=PROJECT_A))
        assert 'CHAT_CONFLICT' in str(excinfo.value)
        assert [(method, path) for method, path, _, _ in records
                if path == f'/api/projects/{PROJECT_A}/archive'] == [('POST', f'/api/projects/{PROJECT_A}/archive')]


def test_writes_refused_before_any_call_without_permission(tmp_path):
    with platform(permissions=('projects:read',)) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        for command in (wire('create', scope, name='新项目'),
                        wire('rename', scope, projectId=PROJECT_A, name='改名'),
                        wire('archive', scope, projectId=PROJECT_A),
                        wire('restore', scope, projectId=PROJECT_B)):
            with pytest.raises(Exception) as excinfo:
                chat.projects_manage(command)
            assert 'CHAT_FORBIDDEN' in str(excinfo.value)
        assert [row for row in records if row[0] in ('POST', 'PATCH')] == []


def test_delete_refused_without_permission(tmp_path):
    with platform(permissions=('projects:read', 'projects:write')) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('delete', scope, projectId=PROJECT_B))
        assert 'CHAT_FORBIDDEN' in str(excinfo.value)
        assert not [row for row in records if row[0] == 'DELETE']


def test_rename_conflict_maps_to_chat_conflict(tmp_path):
    with platform(rename_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('rename', scope, projectId=PROJECT_A, name='新名字'))
        assert 'CHAT_CONFLICT' in str(excinfo.value)


def test_delete_conflict_maps_to_chat_conflict(tmp_path):
    with platform(delete_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('delete', scope, projectId=PROJECT_B))
        assert 'CHAT_CONFLICT' in str(excinfo.value)


def test_missing_project_maps_to_chat_not_found(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('rename', scope, projectId='proj-gone-1', name='新名字'))
        assert 'CHAT_NOT_FOUND' in str(excinfo.value)


def test_scope_mismatch_is_refused(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.handle({'action': 'state'})
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('list', 'not-the-session-scope'))
        assert 'CHAT_IDENTITY_CHANGED' in str(excinfo.value)


def test_unknown_action_and_bad_fields_are_refused(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        long_name = 'x' * 129
        for command in (wire('destroy', scope),
                        wire('create', scope, name='   '),
                        wire('create', scope, name=long_name),
                        wire('create', scope, name='新项目', instructions='额外字段'),
                        wire('rename', scope, projectId=PROJECT_A),
                        wire('rename', scope, projectId=PROJECT_A, name=''),
                        wire('archive', scope),
                        wire('delete', scope, projectId=PROJECT_B, name='多余字段')):
            with pytest.raises(Exception) as excinfo:
                chat.projects_manage(command)
            assert 'CHAT_COMMAND_INVALID' in str(excinfo.value)
        assert [row for row in records if row[0] in ('POST', 'PATCH', 'DELETE')] == []
