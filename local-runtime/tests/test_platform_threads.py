"""Session sidebar management commands against the platform protocol fixture (#72).

Every operation rides the Server's own Thread API: the search listing, the
state write that renames a thread, and the destructive delete. Nothing here
builds a local roster, and deleting a Thread never touches the local receipt
ledger — unconfirmed receipts stay queryable on this device.
"""
import json
import threading
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

THREAD_A = 'thread-A'
THREAD_B = 'thread-B'


@contextmanager
def platform(permissions=('threads:read', 'threads:write', 'threads:delete'), delete_status=200,
             rename_status=200, delete_success=True):
    """A minimal Thread-API fixture: search rows, one rename state write, one delete."""
    lock = threading.Lock()
    threads = {
        THREAD_A: dict(thread_id=THREAD_A, status='idle', display_name='Alpha 会话',
                       created_at='2026-10-30T08:00:00+00:00', updated_at='2026-10-31T07:00:00+00:00'),
        THREAD_B: dict(thread_id=THREAD_B, status='busy', display_name='Beta 会话',
                       created_at='2026-10-30T09:00:00+00:00', updated_at='2026-10-30T09:30:00+00:00'),
    }
    records = []

    def row_payload(row):
        return {'thread_id': row['thread_id'], 'status': row['status'],
                'created_at': row['created_at'], 'updated_at': row['updated_at'],
                'metadata': {}, 'values': {'title': row['display_name']}, 'interrupts': {}}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_DELETE(self):
            self.respond('DELETE', None)

        def do_GET(self):
            self.respond('GET', None)

        def do_POST(self):
            self.respond('POST', json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))))

        def respond(self, method, body):
            records.append((method, self.path, body, dict(self.headers)))
            with lock:
                if self.path == '/api/v1/auth/me':
                    status = 200
                    data = {'id': 'A', 'email': 'A@test.invalid', 'system_role': 'user',
                            'permissions': list(permissions)}
                elif self.path == '/api/threads/search':
                    status = 200
                    data = [row_payload(row) for row in threads.values()]
                elif method == 'POST' and self.path.endswith('/state') and self.path.startswith('/api/threads/'):
                    thread_id = self.path.split('/')[3]
                    if thread_id not in threads:
                        status, data = 404, {}
                    elif rename_status != 200:
                        status, data = rename_status, {}
                    else:
                        status = 200
                        row = threads[thread_id]
                        row['display_name'] = body['values']['title']
                        row['updated_at'] = '2026-10-31T08:00:00+00:00'
                        data = row_payload(row)
                elif method == 'DELETE' and self.path.startswith('/api/threads/'):
                    thread_id = self.path.rsplit('/', 1)[-1]
                    if thread_id not in threads:
                        status, data = 404, {}
                    elif delete_status != 200:
                        status, data = delete_status, {}
                    elif delete_success is not True:
                        status = 200
                        data = {'success': delete_success, 'message': f'Not deleted {thread_id}'}
                    else:
                        status = 200
                        threads.pop(thread_id)
                        data = {'success': True, 'message': f'Deleted {thread_id}'}
                else:
                    status, data = 404, {'detail': 'Not visible'}
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
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
    return {'type': 'threads', 'id': 'req-1', 'action': action, 'scope': scope, **fields}


def test_list_returns_platform_rows_sorted_and_permissions(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.threads_manage(wire('list', chat.handle({'action': 'state'})['scope']))
        assert result['permissions'] == {'canRename': True, 'canDelete': True}
        # Most recently updated first, per the platform's own recency contract.
        assert [row['id'] for row in result['threads']] == [THREAD_A, THREAD_B]
        assert result['threads'][0] == {'id': THREAD_A, 'title': 'Alpha 会话', 'status': 'idle',
                                        'updatedAt': '2026-10-31T07:00:00+00:00'}


def test_search_hits_platform_titles_case_insensitively(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        result = chat.threads_manage(wire('search', scope, query='  alpha  '))
        assert [row['id'] for row in result['threads']] == [THREAD_A]
        result = chat.threads_manage(wire('search', scope, query='THREAD-B'))
        assert [row['id'] for row in result['threads']] == [THREAD_B]
        result = chat.threads_manage(wire('search', scope, query='不存在的会话'))
        assert result['threads'] == []


def test_rename_writes_platform_state_and_rereads(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        result = chat.threads_manage(wire('rename', scope, threadId=THREAD_A, title='  重命名后的会话  '))
        assert result['renamed'] is True
        assert [row['title'] for row in result['threads']] == ['重命名后的会话', 'Beta 会话']
        renames = [(method, path, body) for method, path, body, _ in records
                   if path == f'/api/threads/{THREAD_A}/state']
        assert renames and renames[0][2] == {'values': {'title': '重命名后的会话'}}


def test_rename_refused_before_any_write_without_permission(tmp_path):
    with platform(permissions=('threads:read',)) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.threads_manage(wire('rename', scope, threadId=THREAD_A, title='新名字'))
        assert 'CHAT_FORBIDDEN' in str(excinfo.value)
        assert not [row for row in records if row[1].endswith('/state')]


def test_rename_conflict_maps_to_chat_conflict(tmp_path):
    with platform(rename_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.threads_manage(wire('rename', scope, threadId=THREAD_A, title='新名字'))
        assert 'CHAT_CONFLICT' in str(excinfo.value)


def test_delete_removes_platform_thread_and_rereads(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        result = chat.threads_manage(wire('delete', scope, threadId=THREAD_B))
        assert result['deleted'] is True
        assert [row['id'] for row in result['threads']] == [THREAD_A]
        deletes = [method for method, path, _, _ in records if path == f'/api/threads/{THREAD_B}']
        assert deletes == ['DELETE']


def test_delete_refused_without_permission(tmp_path):
    with platform(permissions=('threads:read', 'threads:write')) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.threads_manage(wire('delete', scope, threadId=THREAD_B))
        assert 'CHAT_FORBIDDEN' in str(excinfo.value)
        assert not [row for row in records if row[0] == 'DELETE']


def test_delete_conflict_maps_to_chat_conflict(tmp_path):
    with platform(delete_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.threads_manage(wire('delete', scope, threadId=THREAD_B))
        assert 'CHAT_CONFLICT' in str(excinfo.value)


def test_delete_failure_response_never_passes_as_success(tmp_path):
    with platform(delete_success=False) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(Exception) as excinfo:
            chat.threads_manage(wire('delete', scope, threadId=THREAD_B))
        assert 'CHAT_PROTOCOL_ERROR' in str(excinfo.value)


def test_delete_keeps_local_unconfirmed_receipts_queryable(tmp_path):
    from core.receipt_ledger import ReceiptLedger, profile_binding
    from core.settings import load_settings
    with platform() as (origin, records):
        chat, _, config = make_chat(tmp_path, origin)
        binding = profile_binding(load_settings(config))
        ledger = ReceiptLedger(config.with_name('receipts.db'))
        task = dict(task_id='task-1', run_id='run-1', capability='local.files.write',
                    logical_target='draft/answer.md')
        assert ledger.admit(binding, task, thread_id=THREAD_A) is True
        scope = chat.handle({'action': 'state'})['scope']
        chat.threads_manage(wire('delete', scope, threadId=THREAD_A))
        history = ledger.history(binding)
        assert len(history) == 1 and history[0]['task_id'] == 'task-1'
        assert history[0]['delivery_state'] == 'uncertain'
        assert ledger.thread_history(binding, THREAD_A)


def test_scope_mismatch_is_refused(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.handle({'action': 'state'})
        with pytest.raises(Exception) as excinfo:
            chat.threads_manage(wire('list', 'not-the-session-scope'))
        assert 'CHAT_IDENTITY_CHANGED' in str(excinfo.value)


def test_unknown_action_and_bad_fields_are_refused(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        for command in (wire('archive', scope), wire('search', scope, query='x' * 129),
                        wire('rename', scope, threadId=THREAD_A),
                        wire('rename', scope, threadId=THREAD_A, title='   '),
                        wire('rename', scope, threadId=THREAD_A, title='x' * 201),
                        {'type': 'threads', 'id': 'req-1', 'action': 'list', 'scope': scope, 'query': 'extra'}):
            with pytest.raises(Exception) as excinfo:
                chat.threads_manage(command)
            assert 'CHAT_COMMAND_INVALID' in str(excinfo.value)
        assert [row for row in records if row[0] == 'DELETE'] == []
        assert [row for row in records if row[1].endswith('/state')] == []
