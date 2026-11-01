"""Message-level branching against the platform Thread API fixture (#78).

The branch is a platform Thread: the Runtime only names the target turn, the
Server creates the branch from its own checkpoint, and the transcript is
re-read from the platform's new Thread — no local copy of history exists at
any point. The project folder binding inheritance resolves in exactly one
place (``inherited_binding``): a source with a binding hands it to the
branch, a source without one stays unbound until the binding producer
ticket (二期 #92) lands.
"""
import json
import threading
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT = '11111111-1111-4111-8111-111111111111'
SOURCE = 'thread-A'
BRANCH = 'branch-1'

BRANCH_REPLY = dict(thread_id=BRANCH, parent_thread_id=SOURCE, parent_checkpoint_id='ckpt-1',
                    branched_from_message_id='a1', workspace_clone_mode='seeded',
                    history_seed_mode='seeded')

# Each thread serves its own transcript: the branch's inherited history is
# seeded by the Server onto the new Thread's own feed, so the fixture keeps
# them distinct and a branch that copied local state could not pass.
TRANSCRIPTS = {
    SOURCE: [{'id': 'h1', 'type': 'human', 'content': '原会话的问题'},
             {'id': 'a1', 'type': 'ai', 'content': '原会话的回答'}],
    BRANCH: [{'id': 'h1', 'type': 'human', 'content': '原会话的问题'},
             {'id': 'a1', 'type': 'ai', 'content': '原会话的回答'},
             {'id': 'seed-1', 'type': 'ai', 'content': '平台种子历史'}],
}


@contextmanager
def platform(branch_status=200):
    records = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond('GET', None)

        def do_POST(self):
            self.respond('POST', json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))))

        def respond(self, method, body):
            records.append((method, self.path, body, dict(self.headers)))
            status = 200
            if self.path == '/api/v1/auth/me':
                data = {'id': 'A', 'email': 'A@test.invalid', 'system_role': 'user',
                        'permissions': ['runs:create', 'threads:write']}
            elif self.path.endswith('/branches') and method == 'POST':
                if branch_status != 200:
                    status, data = branch_status, {}
                else:
                    data = BRANCH_REPLY
            elif self.path == '/api/threads/search':
                data = [{'thread_id': SOURCE, 'status': 'idle', 'metadata': {'agent_name': AGENT}}]
            else:
                thread_id = self.path.split('/')[3] if self.path.startswith('/api/threads/') else ''
                prefix = f'/api/threads/{thread_id}' if thread_id else ''
                if not thread_id or thread_id not in TRANSCRIPTS:
                    status, data = 404, {'detail': 'Not visible'}
                elif self.path == prefix:
                    data = {'thread_id': thread_id, 'status': 'idle', 'metadata': {'agent_name': AGENT}}
                elif self.path == f'{prefix}/runs':
                    data = []
                elif self.path.startswith(f'{prefix}/messages/page'):
                    data = {'data': [{'content': row} for row in TRANSCRIPTS[thread_id]], 'has_more': False}
                elif self.path == f'{prefix}/state':
                    data = {'values': {'messages': []}}
                elif self.path.startswith(f'{prefix}/local-tasks?'):
                    data = {'tasks': [], 'has_more': False, 'next_offset': None}
                elif self.path.startswith(f'{prefix}/artifacts?'):
                    data = {'artifacts': [], 'has_more': False, 'next_offset': None}
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


def open_source(chat, scope):
    opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': SOURCE})
    assert opened['thread']['id'] == SOURCE
    return opened


def test_branch_rides_the_platform_thread_and_reopens_it(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE,
                              'messageId': 'a1', 'messageIds': ['a1']})
        # The Server owns the whole operation: one branch POST, then the new
        # Thread's own history — the transcript is the branch's platform
        # feed, including what the Server seeded, with no local copy merged.
        posts = [(path, body) for method, path, body, _ in records if method == 'POST' and path.endswith('/branches')]
        assert posts == [(f'/api/threads/{SOURCE}/branches', {'message_id': 'a1', 'message_ids': ['a1']})]
        assert result['thread']['id'] == BRANCH
        assert [row['id'] for row in result['messages']] == ['h1', 'a1', 'seed-1']
        assert result['error'] == ''
        # Nothing but the platform read surface and the one branch POST was
        # touched — no write to any Thread state endpoint, no local history.
        assert [row for row in records if row[1].endswith('/state') and row[0] != 'GET'] == []


def test_branch_defaults_the_turn_ids_to_the_named_message(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        assert result['thread']['id'] == BRANCH
        posts = [body for method, path, body, _ in records if method == 'POST' and path.endswith('/branches')]
        assert posts == [{'message_id': 'a1', 'message_ids': ['a1']}]


def test_branch_conflict_keeps_the_source_session_open(tmp_path):
    with platform(branch_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        # The platform's own refusal surfaces as the shared conflict category
        # and the source session stays exactly where it was.
        assert result['error'] == 'CHAT_CONFLICT'
        assert result['thread']['id'] == SOURCE
        assert [row['id'] for row in result['messages']] == ['h1', 'a1']


def test_branch_without_the_write_permission_is_refused_before_the_call(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        # Simulate an account whose permissions lack threads:write.
        chat._thread_permissions = lambda session: {'canRename': False, 'canDelete': False}
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        assert result['error'] == 'CHAT_FORBIDDEN'
        assert not [row for row in records if row[0] == 'POST' and row[1].endswith('/branches')]
        assert result['thread']['id'] == SOURCE


def test_branch_fences_the_open_session(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': 'thread-elsewhere', 'messageId': 'a1'})
        assert result['error'] == 'CHAT_THREAD_CHANGED'
        result = chat.handle({'action': 'branch', 'scope': 'not-the-scope', 'threadId': SOURCE, 'messageId': 'a1'})
        # The scope fence runs before the action dispatch, so the category is
        # the identity one, not a malformed-command one.
        assert result['error'] == 'CHAT_IDENTITY_CHANGED'
        assert not [row for row in records if row[0] == 'POST' and row[1].endswith('/branches')]


def test_branch_rejects_malformed_targets(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        for command in (
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': ''},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'bad id!'},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1', 'messageIds': []},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1', 'messageIds': 'a1'},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1', 'messageIds': ['a1', 'a1']},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1', 'messageIds': ['bad id!']},
            {'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1', 'extra': 'x'},
        ):
            result = chat.handle(command)
            assert result['error'] == 'CHAT_COMMAND_INVALID', command
        assert not [row for row in records if row[0] == 'POST' and row[1].endswith('/branches')]


def test_branch_inherits_the_source_binding(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        binding = {'project_id': 'p-1', 'device_folder': 'C:/work/p1'}
        chat._thread_bindings[SOURCE] = binding
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        assert result['error'] == ''
        assert chat._thread_bindings[BRANCH] == binding
        # The branch owns its binding: later edits to the source's entry
        # cannot leak into the branch's record.
        binding['project_id'] = 'p-2'
        assert chat._thread_bindings[BRANCH]['project_id'] == 'p-1'


def test_branch_without_a_binding_stays_unbound(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        result = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        assert result['error'] == ''
        assert chat._thread_bindings == {}


def test_inherited_binding_copies_only_real_bindings():
    from core.platform_chat import inherited_binding
    assert inherited_binding(None) is None
    assert inherited_binding({}) is None
    assert inherited_binding('p-1') is None
    assert inherited_binding(['p-1']) is None
    source = {'project_id': 'p-1'}
    inherited = inherited_binding(source)
    assert inherited == source and inherited is not source
    source['project_id'] = 'p-2'
    assert inherited['project_id'] == 'p-1'


def test_identity_reset_drops_the_binding_registry(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat._thread_bindings[SOURCE] = {'project_id': 'p-1'}
        chat._reset('another-scope')
        assert chat._thread_bindings == {}
