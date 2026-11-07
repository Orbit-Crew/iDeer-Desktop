"""The Synapse session map's branch edges against the platform fixture (#113).

The only edge source is the Server's own answer at the one moment a branch
succeeds: ``parent_thread_id`` and ``branched_from_message_id``. The Runtime
records those facts device-side, keyed by the chat scope, so the map can
rebuild the relations after a restart. A reply without parent facts records
nothing, another identity sees nothing, and a failed record never fails the
branch or the list that carries the projection — the map renders an unknown
relation as unconnected, never as a guessed edge.
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

# Both rows are visible on the account's own search page, so a recorded edge
# has both endpoints in the map's node set.
SEARCH_ROWS = [
    {'thread_id': BRANCH, 'status': 'idle', 'updated_at': '2026-11-07T01:00:00Z', 'metadata': {}},
    {'thread_id': SOURCE, 'status': 'idle', 'updated_at': '2026-11-06T00:00:00Z', 'metadata': {}},
]

TRANSCRIPTS = {
    SOURCE: [{'id': 'h1', 'type': 'human', 'content': '原会话的问题'},
             {'id': 'a1', 'type': 'ai', 'content': '原会话的回答'}],
    BRANCH: [{'id': 'h1', 'type': 'human', 'content': '原会话的问题'},
             {'id': 'a1', 'type': 'ai', 'content': '原会话的回答'},
             {'id': 'seed-1', 'type': 'ai', 'content': '平台种子历史'}],
}


@contextmanager
def platform(branch_reply=None):
    reply = dict(BRANCH_REPLY) if branch_reply is None else branch_reply
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
                data = reply
            elif self.path == '/api/threads/search':
                data = [dict(row) for row in SEARCH_ROWS]
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


def make_chat(tmp_path, origin, user='A', token_ref='business-A', name='settings.json'):
    from core.platform_chat import DesktopChat
    from core.secrets import InMemorySecretStore
    from core.settings import RuntimeSettings
    secure = InMemorySecretStore()
    secure.set(token_ref, token_ref)
    config = tmp_path / name
    settings = RuntimeSettings(server_url=origin, user_id=user, business_token_ref=token_ref,
                               business_expires_at='2099-01-01T00:00:00+00:00',
                               device_id='device-1', device_public_key='dev-key',
                               server_public_key='broker-key')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}), config, secure


def open_source(chat, scope):
    opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': SOURCE})
    assert opened['thread']['id'] == SOURCE
    return opened


def test_branch_records_the_server_parent_fact_on_the_rows(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        branched = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        assert branched['thread']['id'] == BRANCH
        listing = chat.threads_manage({'type': 'threads', 'id': 'req-1', 'action': 'list', 'scope': scope})
        rows = {row['id']: row for row in listing['threads']}
        # The edge is the Server's own parent fact, projected onto the child
        # row in the map's node vocabulary.
        assert rows[BRANCH]['branchedFrom'] == {'threadId': SOURCE, 'messageId': 'a1'}
        assert 'branchedFrom' not in rows[SOURCE]
        # The projection stays bounded and recency-sorted exactly as before.
        assert [row['id'] for row in listing['threads']] == [BRANCH, SOURCE]


def test_branch_reply_without_parent_facts_records_nothing(tmp_path):
    with platform(branch_reply=dict(thread_id=BRANCH, parent_checkpoint_id='ckpt-1',
                                    workspace_clone_mode='seeded', history_seed_mode='seeded')) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        branched = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        # The branch itself still rides the platform: the new Thread opens.
        assert branched['thread']['id'] == BRANCH
        listing = chat.threads_manage({'type': 'threads', 'id': 'req-1', 'action': 'list', 'scope': scope})
        # No parent fact means no edge — the map never guesses one from ids
        # or recency, so both rows render unconnected.
        for row in listing['threads']:
            assert 'branchedFrom' not in row


def test_branch_edges_stay_bound_to_their_scope(tmp_path):
    with platform() as (origin, records):
        chat_a, _, _ = make_chat(tmp_path, origin, name='settings-a.json')
        scope_a = chat_a.handle({'action': 'state'})['scope']
        open_source(chat_a, scope_a)
        chat_a.handle({'action': 'branch', 'scope': scope_a, 'threadId': SOURCE, 'messageId': 'a1'})
        # A re-login on the same device shares the ledger file but not the
        # scope (origin, user, token ref and binding all key it): its rows
        # carry no edge it never observed.
        chat_b, _, _ = make_chat(tmp_path, origin, token_ref='business-B', name='settings-b.json')
        scope_b = chat_b.handle({'action': 'state'})['scope']
        assert scope_b != scope_a
        listing = chat_b.threads_manage({'type': 'threads', 'id': 'req-1', 'action': 'list', 'scope': scope_b})
        for row in listing['threads']:
            assert 'branchedFrom' not in row


def test_branch_edges_survive_a_restart(tmp_path):
    with platform() as (origin, records):
        chat, config, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        # A fresh DesktopChat over the same profile rebuilds the map from the
        # platform list plus the ledger — 历史会话可重建进图.
        from core.platform_chat import DesktopChat
        from core.secrets import InMemorySecretStore
        secure = InMemorySecretStore()
        secure.set('business-A', 'business-A')
        reopened = DesktopChat(config, secure, lambda: {'state': 'authenticated'})
        reopened.handle({'action': 'refresh'})
        listing = reopened.threads_manage({'type': 'threads', 'id': 'req-1', 'action': 'list', 'scope': scope})
        rows = {row['id']: row for row in listing['threads']}
        assert rows[BRANCH]['branchedFrom'] == {'threadId': SOURCE, 'messageId': 'a1'}


def test_a_failed_edge_record_never_fails_the_branch_or_the_list(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        # A ledger bound to an impossible path cannot store the fact.
        chat.branch_edges = type(chat.branch_edges)(tmp_path / 'settings.json' / 'branch_edges.db')
        scope = chat.handle({'action': 'state'})['scope']
        open_source(chat, scope)
        branched = chat.handle({'action': 'branch', 'scope': scope, 'threadId': SOURCE, 'messageId': 'a1'})
        assert branched['thread']['id'] == BRANCH
        listing = chat.threads_manage({'type': 'threads', 'id': 'req-1', 'action': 'list', 'scope': scope})
        for row in listing['threads']:
            assert 'branchedFrom' not in row
