"""Desktop business commands against a protocol fixture, never a local model."""
import json
import threading
import time
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings

AGENT = '11111111-1111-4111-8111-111111111111'
SKILL = '22222222-2222-4222-8222-222222222222'


@contextmanager
def platform(human_request=None, disconnect=False, can_run=True, agent_binding=AGENT, plain_answer=False,
             optional_skill=False, lifecycle='active', version=3, missing_dependency=False, rewritten_human=False,
             cancel_status=202, local_tasks=None, history_gate=None, history_started=None,
             artifact_status=None, artifact_responder=None, grant_status=200, on_grant=None):
    records = []
    artifacts = {}
    grants = set()
    resource = dict(id=AGENT, type='agent', display_name='Published expert', visibility='private',
                    lifecycle_status=lifecycle, latest_version=version)

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
                if missing_dependency:
                    data['dependencies'] = [{'resource_id': '99999999-9999-4999-8999-999999999999', 'required': True}]
                if lifecycle != 'active':
                    status, data = 404, {}
                elif version == 0:
                    status, data = 409, {}
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
                if rewritten_human:
                    data['values']['messages'][0]['id'] = 'h1__user'
                    data['values']['messages'].append({'id': 'h2', 'type': 'human', 'content': 'Unique T99 message'})
                if human_request:
                    data['values']['messages'].append({'id': 'clarify-tool', 'type': 'tool', 'content': 'Please clarify',
                                                       'artifact': {'human_input': human_request}})
                    if plain_answer:
                        data['values']['messages'].append({'id': 'legacy-answer', 'type': 'human', 'content': 'Target one'})
            elif self.path.startswith('/api/threads/thread-A/messages/page'):
                data = {'data': [], 'has_more': False}
                if rewritten_human:
                    data['data'] = [{'content': {'id': 'h1', 'type': 'human', 'content': 'Unique T99 message'}}]
            elif self.path == '/api/threads/thread-A/runs':
                if body is None:
                    data = []
                else:
                    data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'running', 'metadata': {}}
                    if body.get('stream_mode') != ['messages-tuple', 'values', 'custom']:
                        status, data = 422, {'detail': 'Unsupported public stream mode'}
            elif self.path == '/api/threads/thread-A/runs/run-1':
                data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'success', 'metadata': {}}
            elif self.path == '/api/threads/thread-A/runs/run-1/cancel?wait=false&action=interrupt':
                status, data = cancel_status, None
            elif self.path.startswith('/api/threads/thread-A/local-tasks?'):
                if history_started:
                    history_started.set()
                if history_gate:
                    history_gate.wait(5)
                data = {'tasks': local_tasks or [], 'has_more': False, 'next_offset': None}
            elif self.path == '/api/threads/thread-A/artifacts/grant':
                status = grant_status
                if user != 'A' or self.headers.get('X-Device-Session') != 'device-session-105':
                    status = 403
                token = f'server-issued-grant-{len(records)}'
                grants.add(token)
                data = dict(token=token, run_id=body['run_id'], task_id=body['task_id'],
                            thread_id='thread-A', name=body['name'], device_id=body['device_id'],
                            expires_at='2099-01-01T00:00:00+00:00') if status == 200 else {}
                if on_grant:
                    on_grant(data)
            elif self.path.startswith('/api/threads/thread-A/artifacts?'):
                status = 404 if user != 'A' else 200
                data = {'artifacts': list(artifacts.values()), 'has_more': False, 'next_offset': None}
            elif self.path.startswith('/api/threads/thread-A/artifacts/') and self.path.endswith('/download'):
                import base64
                artifact_id = self.path.split('/')[-2]
                artifact = next((row for row in artifacts.values() if row['artifact_id'] == artifact_id), None)
                if user != 'A' or artifact is None:
                    status, data = 404, {}
                else:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('X-Content-SHA256', artifact['sha256'])
                    self.end_headers()
                    self.wfile.write(base64.b64decode(artifact['content']))
                    return
            elif self.path == '/api/threads/thread-A/artifacts':
                # The Server-side artifact boundary contract for issue 105:
                # upload is content-hash idempotent, thread-bound, and the
                # response echoes what was stored so the device can verify it.
                if self.headers.get('X-Device-Session') != 'device-session-105' or body['grant']['token'] not in grants:
                    status, data = 403, {}
                elif artifact_status is not None:
                    status, data = artifact_status, {}
                elif artifact_responder is not None:
                    status, data = artifact_responder(body)
                else:
                    existing = artifacts.get(body['handle'])
                    if existing is not None and existing['sha256'] == body['sha256']:
                        data = dict(existing, duplicate=True)
                    else:
                        data = dict(artifact_id=f"art-{len(artifacts) + 1}", thread_id='thread-A',
                                    name=body['name'], sha256=body['sha256'], bytes=body['bytes'],
                                    task_id=body['task_id'], run_id=body['run_id'], content=body['content'],
                                    handle=body['handle'], duplicate=False)
                        artifacts[body['handle']] = data
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


def make_chat(tmp_path, origin, **options):
    from core.platform_chat import DesktopChat
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    secure.set('business-B', 'business-B')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}, **options), settings, config


@pytest.mark.parametrize('cancel_status,expected', [(202, 'requested'), (503, 'uncertain')])
def test_stop_records_request_separately_from_final_run_and_never_submits_another_turn(tmp_path, cancel_status, expected):
    with platform(disconnect=True, cancel_status=cancel_status) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Write AFTER'})
        stopped = chat.handle({'action': 'stop', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1'})
        assert stopped['stop'] == {'runId': 'run-1', 'state': expected}
        assert stopped['run']['status'] == 'running'
        # A user can retry uncertain cancellation; accepted requests stay fenced.
        chat.handle({'action': 'stop', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1'})
        assert len([r for r in records if '/cancel?' in r[0]]) == (1 if expected == 'requested' else 2)
        assert len([r for r in records if r[0] == '/api/threads/thread-A/runs' and r[1] is not None]) == 1


def test_slow_history_poll_does_not_block_installing_the_local_stop_fence(tmp_path):
    gate, started = threading.Event(), threading.Event()
    gate.set()
    with platform(disconnect=True, history_gate=gate, history_started=started) as (origin, _):
        local_stops = []
        chat, _, _ = make_chat(tmp_path, origin, stop_local=local_stops.append)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Write AFTER'})
        gate.clear()
        started.clear()
        time.sleep(2.05)
        try:
            before = time.monotonic()
            chat.handle({'action': 'state'})
            assert time.monotonic() - before < 1, 'history observation must not hold the command queue'
            assert started.wait(1)
            chat.handle({'action': 'stop', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1'})
            assert local_stops == ['run-1']
        finally:
            gate.set()


def test_reopen_restores_original_task_fact_and_local_outbox_without_starting_a_run(tmp_path):
    task = dict(task_id='task-104', run_id='old-run', tool_call_id='call-104', capability='local.files.write',
                status='result_not_verified', logical_target='/workspace/test/target.txt', stop_requested=True)
    row = dict(task_id='task-104', run_id='old-run', status='completed', delivery_state='pending')
    with platform(local_tasks=[task]) as (origin, records):
        calls = []
        def local(thread_id, runs):
            calls.append((thread_id, runs))
            return [row]
        chat, _, _ = make_chat(tmp_path, origin, local_receipts=local)
        scope = chat.handle({'action': 'refresh'})['scope']
        reopened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert reopened['taskError'] == ''
        assert reopened['localTasks'] == [{**task, 'local': row}]
        assert calls == [('thread-A', {'old-run'})]
        assert all('/runs' not in route or body is None for route, body, _ in records)


@pytest.mark.parametrize('change,expected', [({}, ''), ({'requestHash': '0' * 64}, 'CONSENT_MISMATCH'),
    ({'taskId': 'another-task'}, 'CONSENT_MISMATCH'), ({'runId': 'another-run'}, 'CONSENT_MISMATCH'),
    ({'threadId': 'another-thread'}, 'CONSENT_MISMATCH'), ({'content': 'CHANGED'}, 'CHAT_COMMAND_INVALID'),
    ({'decision': 'always'}, 'CHAT_COMMAND_INVALID'), ({'scope': 'stale-owner'}, 'CHAT_IDENTITY_CHANGED')])
def test_chat_write_decision_binds_original_run_task_hash_and_stays_on_device(tmp_path, change, expected):
    from core.consent import PendingConsent
    pending = PendingConsent('task-102', 'local.files.write', {'run_id': 'run-1', 'thread_id': 'thread-A',
        'arguments': {'path': '/workspace/102/target.txt', 'content': 'AFTER\n'}}, 'a' * 64,
        'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [pending],
            decide_consent=lambda *args: decisions.append(args))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Write exact content'})
        assert state['localConsents'][0]['content'] == 'AFTER\n'
        command = dict(action='consent', scope=scope, threadId='thread-A', runId='run-1', taskId='task-102',
                       requestHash='a' * 64, decision='allow')
        # Only the existing stream can still produce HTTP GETs. A local
        # decision must never become an HTTP consent request or a chat Turn.
        before = len([row for row in records if row[1] is not None])
        result = chat.handle({**command, **change})
        assert result['error'] == expected
        assert decisions == ([] if expected else [('task-102', 'a' * 64, True)])
        assert len([row for row in records if row[1] is not None]) == before


def test_chat_survives_unavailable_local_approval_snapshot_and_recovers_next_poll(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Write exact content'})
        def unavailable():
            raise RuntimeError('fixture snapshot unavailable')
        chat.local_consents = unavailable
        failed = chat.handle({'action': 'state'})
        assert failed['error'] == 'CONSENT_UNAVAILABLE'
        assert failed['localConsents'] == []
        assert failed['scope'] == scope
        chat.local_consents = lambda: ()
        recovered = chat.handle({'action': 'state'})
        assert recovered['localConsents'] == []
        assert recovered['error'] == ''


def test_chat_never_approves_write_content_hidden_by_credential_redaction(tmp_path):
    from core.consent import PendingConsent
    pending = PendingConsent('task-102', 'local.files.write', {'run_id': 'run-1', 'thread_id': 'thread-A',
        'arguments': {'path': '/workspace/102/target.txt', 'content': 'PREFIX business-A SUFFIX'}}, 'a' * 64,
        'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [pending],
            decide_consent=lambda *args: decisions.append(args))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Write exact content'})
        assert state['localConsents'] == []
        assert state['error'] == 'CONSENT_CONTENT_REDACTED'
        assert 'business-A' not in json.dumps(state)
        forced = chat.handle(dict(action='consent', scope=scope, threadId='thread-A', runId='run-1',
            taskId='task-102', requestHash='a' * 64, decision='allow'))
        assert forced['error'] == 'CONSENT_CONTENT_REDACTED'
        assert forced['localConsents'] == []
        assert decisions == []
        assert 'business-A' not in json.dumps(forced)


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


def test_reopened_thread_merges_injected_user_identity_and_keeps_distinct_turns(tmp_path):
    # Server DynamicContextMiddleware changes HumanMessage X to X__user.
    # Its journal and checkpoint are two projections of the same submitted Turn.
    with platform(rewritten_human=True) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert opened['error'] == ''
        assert [(m['id'], m['text']) for m in opened['messages'] if m['role'] == 'human'] == [
            ('h1__user', 'Unique T99 message'), ('h2', 'Unique T99 message')]


def test_unreachable_server_is_an_explicit_error_and_never_creates_a_local_run(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        state = chat.handle({'action': 'refresh'})
    unavailable = chat.handle({'action': 'create', 'scope': state['scope'], 'agentId': AGENT})
    assert unavailable['error'] == 'CHAT_SERVER_UNAVAILABLE'
    assert unavailable['run'] is None


@pytest.mark.parametrize('options,expected', [({'version': 0}, 'CHAT_CONFLICT'),
    ({'lifecycle': 'suspended'}, 'CHAT_NOT_FOUND'), ({'missing_dependency': True}, 'CHAT_NOT_FOUND')])
def test_unavailable_resources_are_disabled_and_forced_activation_fails(tmp_path, options, expected):
    with platform(**options) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        state = chat.handle({'action': 'refresh'})
        assert state['resources'][0]['available'] is False
        forced = chat.handle({'action': 'create', 'scope': state['scope'], 'agentId': AGENT})
        assert forced['error'] == expected
        assert not any(path == '/api/threads' for path, _, _ in records)


CONTENT = 'T105-UNIQUE-RESULT'
UPLOAD_COMMAND = {'action': 'upload', 'threadId': 'thread-A', 'runId': 'run-105',
                  'taskId': 'task-105', 'decision': 'allow'}


def prepare_result(tmp_path, origin, *, mode='local', task_id='task-105'):
    """A Desktop chat with one registered workspace result, mirroring desktop.py wiring."""
    import hashlib as _hashlib
    from core.local_results import LocalResultRegistry
    from core.platform_chat import DesktopChat
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    secure.set('device-session-105', 'device-session-105')
    config = tmp_path / 'profile' / 'settings.json'
    work = tmp_path / 'work'
    work.mkdir(exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-105', server_public_key='broker-key-105',
        session_token_ref='device-session-105',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    if mode == 'policy-deny':
        settings.rules['local.artifacts.upload'] = 'deny'
    settings.save(config)
    registry = LocalResultRegistry(config.with_name('local-results.db'))
    from core.receipt_ledger import profile_binding
    from core.file_service import WorkspaceSelection
    root = WorkspaceSelection(config).select(str(work), confirmed=True)['logicalRoot']
    target = work / 'result-105.txt'
    if mode != 'missing-file':
        target.write_text(CONTENT, encoding='utf-8')
    if mode != 'no-record':
        registry.record(profile_binding(settings), dict(task_id=task_id, run_id='run-105',
            thread_id='other-thread' if mode == 'wrong-thread' else 'thread-A',
            capability='local.files.write', logical_root=root, logical_path=f'{root}/result-105.txt',
            name='result-105.txt', sha256=_hashlib.sha256(CONTENT.encode()).hexdigest(),
            bytes=len(CONTENT.encode())))
    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'}, local_results=registry)
    return chat, registry, settings, config, work, target, root


def upload_posts(records):
    return [(path, body, headers) for path, body, headers in records
            if path == '/api/threads/thread-A/artifacts' and body is not None]


def test_upload_stays_explicit_idempotent_and_never_triggered_by_viewing(tmp_path):
    import base64
    import hashlib
    with platform() as (origin, records):
        chat, registry, _, _, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        # Reading and displaying the thread never uploads anything.
        assert upload_posts(records) == []
        row = next(task for task in opened['localTasks'] if task['task_id'] == 'task-105')
        assert row['localResult']['name'] == 'result-105.txt'
        assert row['localResult']['artifact_ref'] == ''
        uploaded = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert uploaded['error'] == ''
        digest = hashlib.sha256(CONTENT.encode()).hexdigest()
        path, body, headers = upload_posts(records)[0]
        assert headers['Idempotency-Key'] == f'local://{digest}/result-105.txt'
        assert body['version'] == 1 and body['kind'] == 'local_result'
        assert body['task_id'] == 'task-105' and body['run_id'] == 'run-105'
        assert body['sha256'] == digest and body['bytes'] == len(CONTENT.encode())
        assert base64.b64decode(body['content']) == CONTENT.encode()
        assert body['grant']['task_id'] == 'task-105' and body['grant']['thread_id'] == 'thread-A'
        assert body['grant']['name'] == 'result-105.txt' and body['grant']['token']
        row = next(task for task in uploaded['localTasks'] if task['task_id'] == 'task-105')
        assert row['localResult']['artifact_ref'] == 'art-1'
        assert row['localResult']['uploaded_at']
        # A repeated explicit upload replays the same platform artifact: one
        # POST total, no duplicate records, and no bytes read or staged again
        # once the registered fact already carries the platform reference.
        repeat = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert repeat['error'] == ''
        assert len(upload_posts(records)) == 1
        row = next(task for task in repeat['localTasks'] if task['task_id'] == 'task-105')
        assert row['localResult']['artifact_ref'] == 'art-1'


def test_upload_retry_after_server_failure_uses_a_new_grant_and_records_once(tmp_path):
    attempts = []
    def responder(body):
        attempts.append(body)
        if len(attempts) == 1:
            return 503, {}
        return 200, dict(artifact_id='art-1', thread_id='thread-A', name=body['name'],
                         sha256=body['sha256'], bytes=body['bytes'], handle=body['handle'])
    with platform(artifact_responder=responder) as (origin, records):
        chat, registry, _, config, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        failed = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert failed['error'] == 'CHAT_SERVER_ERROR'
        from core.receipt_ledger import profile_binding
        from core.settings import load_settings
        assert registry.get(profile_binding(load_settings(config)), 'task-105')['artifact_ref'] == ''
        recovered = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert recovered['error'] == ''
        posts = upload_posts(records)
        assert len(posts) == 2
        # Each explicit attempt carries its own single-use grant token.
        assert posts[0][1]['grant']['token'] != posts[1][1]['grant']['token']
        row = next(task for task in recovered['localTasks'] if task['task_id'] == 'task-105')
        assert row['localResult']['artifact_ref'] == 'art-1'


@pytest.mark.parametrize('mode,options,expected,command_patch', [
    ('no-record', {}, 'UPLOAD_RESULT_NOT_FOUND', {}),
    ('policy-deny', {}, 'UPLOAD_POLICY_DENIED', {}),
    ('missing-file', {}, 'UPLOAD_LOCAL_FILE_UNAVAILABLE', {}),
    ('content-changed', {}, 'UPLOAD_CONTENT_CHANGED', {}),
    ('workspace-changed', {}, 'UPLOAD_LOCAL_FILE_UNAVAILABLE', {}),
    ('wrong-thread', {}, 'CHAT_THREAD_CHANGED', {'threadId': 'other-thread'}),
    ('server-denied', {'artifact_status': 403}, 'CHAT_FORBIDDEN', {}),
    ('server-error', {'artifact_status': 503}, 'CHAT_SERVER_ERROR', {}),
    ('echo-mismatch', {'artifact_responder': 'mismatch'}, 'CHAT_PROTOCOL_ERROR', {}),
])
def test_upload_rejections_are_explicit_and_never_fake_success(tmp_path, mode, options, expected, command_patch):
    if options.get('artifact_responder') == 'mismatch':
        options = dict(options, artifact_responder=lambda body: (200, dict(artifact_id='art-9',
            thread_id='thread-A', name=body['name'], sha256='0' * 64, bytes=body['bytes'], handle=body['handle'])))
    with platform(**options) as (origin, records):
        chat, registry, settings, config, work, target, root = prepare_result(tmp_path, origin, mode=mode)
        if mode == 'content-changed':
            target.write_text('TAMPERED', encoding='utf-8')
        if mode == 'workspace-changed':
            from core.file_service import WorkspaceSelection
            WorkspaceSelection(config).select(str(work), confirmed=True)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        result = chat.handle({**UPLOAD_COMMAND, 'scope': scope, **command_patch})
        assert result['error'] == expected, (mode, result['error'])
        # A rejection only ever reached the Server as a complete, verified
        # upload attempt; local policy, content and availability failures
        # sent nothing at all.
        posts = upload_posts(records)
        if mode in {'no-record', 'policy-deny', 'missing-file', 'content-changed', 'workspace-changed', 'wrong-thread'}:
            assert posts == [], mode
        from core.receipt_ledger import profile_binding
        from core.settings import load_settings
        if mode != 'no-record':
            binding = profile_binding(load_settings(config))
            if mode == 'wrong-thread':
                assert registry.get(binding, 'task-105')['artifact_ref'] == ''
            else:
                assert registry.get(binding, 'task-105')['artifact_ref'] == '', mode


def test_upload_requires_authentication_and_the_current_identity(tmp_path):
    with platform() as (origin, records):
        chat, registry, settings, config, work, target, root = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        uploaded = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert uploaded['error'] == ''
        assert len(upload_posts(records)) == 1
        # A switched account cannot upload under the old identity: the stale
        # scope is rejected first, and its own scope finds no registered result.
        chat.secure.set('business-B', 'business-B')
        settings.user_id, settings.business_token_ref = 'B', 'business-B'
        settings.save(config)
        stale = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert stale['error'] == 'CHAT_IDENTITY_CHANGED'
        current = chat.handle({'action': 'refresh'})
        # The new identity starts from a reset state: no owned thread is open
        # and the A-owned registry row is not reachable from B's binding.
        switch = chat.handle({**UPLOAD_COMMAND, 'scope': current['scope']})
        assert switch['error'] == 'CHAT_THREAD_CHANGED'
        assert len(upload_posts(records)) == 1


def test_thread_history_separates_local_results_from_platform_attachments(tmp_path):
    task = dict(task_id='task-106', run_id='run-105', tool_call_id='call-106', capability='local.files.write',
                status='completed', logical_target='/workspace/other/notes.md',
                artifacts=[dict(artifact_id='art-7', name='notes.md', sha256='f' * 64, bytes=9)])
    with platform(local_tasks=[task]) as (origin, records):
        chat, _, _, _, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        rows = {row['task_id']: row for row in opened['localTasks']}
        # A platform attachment travels with the Server row; this device holds
        # no local copy of it and no local-only marker is invented.
        assert rows['task-106']['artifacts'] == task['artifacts']
        assert rows['task-106']['localResult'] is None
        # The locally registered result appears even without a Server task row,
        # stays marked device-local, and never grows a fake download address.
        local = rows['task-105']
        assert local['status'] == 'unknown'
        assert local['localResult']['sha256'] and not local['localResult']['artifact_ref']
        assert 'artifacts' not in local
        assert upload_posts(records) == []
