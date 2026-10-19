"""Desktop business commands against a protocol fixture, never a local model."""
import json
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings

AGENT = '11111111-1111-4111-8111-111111111111'
SKILL = '22222222-2222-4222-8222-222222222222'


@contextmanager
def platform(human_request=None, disconnect=False, can_run=True, agent_binding=AGENT, plain_answer=False, optional_skill=False):
    records = []
    resource = dict(id=AGENT, type='agent', display_name='Published expert', visibility='private',
                    lifecycle_status='active', latest_version=3)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))

        def respond(self, body):
            records.append((self.path, body, dict(self.headers)))
            cookie = self.headers.get('Cookie', '')
            user = 'B' if 'business-B' in cookie else 'A'
            status = 200
            if self.path == '/api/v1/auth/me':
                data = {'id': user, 'email': user + '@test.invalid', 'system_role': 'user' if can_run else 'viewer',
                        'permissions': ['runs:create'] if can_run else []}
            elif self.path.startswith('/api/resources?'):
                data = {'items': [resource] if user == 'A' and 'type=agent' in self.path else [], 'total': 1}
            elif self.path == f'/api/resources/{AGENT}/published':
                data = {'resource': resource, 'version': {'version': 3}, 'dependencies': []}
                if optional_skill:
                    data['dependencies'] = [{'resource_id': SKILL, 'required': False}]
            elif self.path == f'/api/resources/{SKILL}/published':
                data = {'resource': dict(resource, id=SKILL, type='skill'), 'version': {'version': 1}, 'dependencies': []}
            elif self.path == '/api/threads/search':
                data = [{'thread_id': 'thread-A', 'status': 'idle', 'metadata': {'agent_name': AGENT}}] if user == 'A' else []
            elif self.path == '/api/threads':
                data = {'thread_id': 'thread-A', 'status': 'idle', 'metadata': body['metadata']}
            elif self.path == '/api/threads/thread-A':
                if user == 'B':
                    status, data = 404, {}
                else:
                    data = {'thread_id': 'thread-A', 'status': 'idle', 'metadata': {'agent_name': agent_binding}}
            elif self.path == '/api/resources/aliases/agent/expert-slug':
                data = resource
            elif self.path == '/api/threads/thread-A/state':
                data = {'values': {'messages': [{'id': 'h1', 'type': 'human', 'content': 'Unique T99 message'},
                                               {'id': 'a1', 'type': 'ai', 'content': 'Restored answer'}]}}
                if human_request:
                    data['values']['messages'].append({'id': 'clarify-tool', 'type': 'tool', 'content': 'Please clarify',
                                                       'artifact': {'human_input': human_request}})
                    if plain_answer:
                        data['values']['messages'].append({'id': 'legacy-answer', 'type': 'human', 'content': 'Target one'})
            elif self.path.startswith('/api/threads/thread-A/messages/page'):
                data = {'data': [], 'has_more': False}
            elif self.path == '/api/threads/thread-A/runs':
                if body is None:
                    data = []
                else:
                    data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'running', 'metadata': {}}
                    if body.get('stream_mode') != ['messages-tuple', 'values', 'custom']:
                        status, data = 422, {'detail': 'Unsupported public stream mode'}
            elif self.path == '/api/threads/thread-A/runs/run-1':
                data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'success', 'metadata': {}}
            elif self.path == '/api/threads/thread-A/runs/run-1/stream':
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'id: 1\nevent: messages\ndata: [{"id":"a1","type":"AIMessageChunk","content":"Streamed"},{}]\n\n')
                self.wfile.flush()
                time.sleep(0.1)
                if not disconnect:
                    self.wfile.write(b'id: 2\nevent: end\ndata: null\n\n')
                return
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
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    secure.set('business-B', 'business-B')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}), settings, config


def test_catalog_uses_business_identity_and_retains_canonical_identity(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.handle({'action': 'refresh'})
        assert result['error'] == ''
        assert result['resources'] == [dict(id=AGENT, type='agent', name='Published expert', visibility='private',
                                            version=3, available=True, reason='')]
        assert result['threads'][0]['id'] == 'thread-A'
        assert 'business-A' not in json.dumps(result)
        assert all('access_token=business-A' in headers['Cookie'] for _, _, headers in records)
        assert all('device-session' not in headers['Cookie'] for _, _, headers in records)


def test_identity_switch_drops_history_and_rejects_old_view_commands(tmp_path):
    with platform() as (origin, _):
        chat, settings, config = make_chat(tmp_path, origin)
        original = chat.handle({'action': 'refresh'})
        settings.user_id, settings.business_token_ref = 'B', 'business-B'
        settings.save(config)
        stale = chat.handle({'action': 'open', 'scope': original['scope'], 'threadId': 'thread-A'})
        assert stale['error'] == 'CHAT_IDENTITY_CHANGED'
        assert stale['threads'] == [] and stale['messages'] == []
        current = chat.handle({'action': 'refresh'})
        assert current['scope'] != original['scope'] and current['threads'] == []
        assert current['resources'] == []


def test_turn_submission_is_fenced_and_reopening_restores_server_messages(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        created = chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        assert created['thread']['id'] == 'thread-A'
        turn = {'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Unique T99 message'}
        sent = chat.handle(turn)
        assert sent['run']['id'] == 'run-1'
        duplicate = chat.handle(turn)
        assert duplicate['error'] == 'CHAT_TURN_ALREADY_SUBMITTED'
        until = time.monotonic() + 3
        observed = []
        while time.monotonic() < until:
            state = chat.handle({'action': 'state'})
            observed.extend(m['text'] for m in state['messages'])
            if state['stream'] == 'idle':
                break
            time.sleep(0.01)
        assert 'Streamed' in observed
        reopened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert [m['text'] for m in reopened['messages']] == ['Unique T99 message', 'Restored answer']
        posts = [(path, body, headers) for path, body, headers in records if path.endswith('/runs') and body]
        assert len(posts) == 1
        assert posts[0][1]['assistant_id'] == AGENT
        assert posts[0][1]['multitask_strategy'] == 'reject'
        assert posts[0][2]['Idempotency-Key'] == turn['turnId']


def test_restored_human_input_response_uses_the_existing_message_contract(tmp_path):
    request = dict(version=1, kind='human_input_request', source='ask_clarification',
                   request_id='clarify-99', question='Which target?', input_mode='single_choice',
                   options=[dict(id='one', label='Target one', value='target-1')])
    with platform(human_request=request) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert opened['messages'][-1]['request']['request_id'] == 'clarify-99'
        result = chat.handle({'action': 'answer', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '44444444-4444-4444-8444-444444444444', 'requestId': 'clarify-99',
                              'optionId': 'one'})
        assert result['error'] == ''
        submitted = next(body for path, body, _ in records if path.endswith('/runs') and body)
        kwargs = submitted['input']['messages'][0]['additional_kwargs']
        assert kwargs == {'hide_from_ui': True, 'human_input_response': dict(version=1,
            kind='human_input_response', source='ask_clarification', request_id='clarify-99',
            response_kind='option', option_id='one', value='target-1')}


def test_disconnect_is_visible_without_resubmitting_the_turn(tmp_path):
    with platform(disconnect=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '55555555-5555-4555-8555-555555555555', 'text': 'Do not replay'})
        until = time.monotonic() + 3
        while time.monotonic() < until:
            state = chat.handle({'action': 'state'})
            if state['stream'] == 'disconnected':
                break
            time.sleep(0.01)
        assert state['error'] == 'CHAT_STREAM_DISCONNECTED'
        recovered = chat.handle({'action': 'reconnect', 'scope': scope, 'threadId': 'thread-A'})
        assert recovered['messages'][-1]['text'] == 'Restored answer'
        assert len([body for path, body, _ in records if path.endswith('/runs') and body]) == 1


def test_read_only_identity_cannot_select_or_force_activate_visible_agent(tmp_path):
    with platform(can_run=False) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        state = chat.handle({'action': 'refresh'})
        assert state['resources'][0]['available'] is False
        forced = chat.handle({'action': 'create', 'scope': state['scope'], 'agentId': AGENT})
        assert forced['error'] == 'CHAT_FORBIDDEN'
        assert not any(path == '/api/threads' for path, _, _ in records)


def test_reopened_web_thread_resolves_its_agent_alias_to_canonical_identity(tmp_path):
    with platform(agent_binding='expert-slug') as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert opened['thread']['agentId'] == AGENT
        sent = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                            'turnId': '66666666-6666-4666-8666-666666666666', 'text': 'Continue web chat'})
        assert sent['run']['id'] == 'run-1'


def test_plain_human_reply_resolves_only_latest_pending_human_input(tmp_path):
    request = dict(version=2, kind='human_input_request', source='ask_clarification',
                   request_id='legacy-question', question='Which target?', input_mode='free_text')
    with platform(human_request=request, plain_answer=True) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert opened['messages'][-1]['response']['request_id'] == 'legacy-question'
        stale = chat.handle({'action': 'answer', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '77777777-7777-4777-8777-777777777777',
                             'requestId': 'legacy-question', 'text': 'Duplicate answer'})
        assert stale['error'] == 'CHAT_HUMAN_INPUT_STALE'


def test_available_optional_skill_in_agent_closure_can_be_selected(tmp_path):
    with platform(optional_skill=True) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        created = chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT, 'skillId': SKILL})
        assert created['error'] == ''


def test_unreachable_server_is_an_explicit_error_and_never_creates_a_local_run(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        state = chat.handle({'action': 'refresh'})
    unavailable = chat.handle({'action': 'create', 'scope': state['scope'], 'agentId': AGENT})
    assert unavailable['error'] == 'CHAT_SERVER_UNAVAILABLE'
    assert unavailable['run'] is None
