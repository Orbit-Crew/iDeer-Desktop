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
SKILL2 = '44444444-4444-4444-8444-444444444444'


@contextmanager
def platform(human_request=None, disconnect=False, can_run=True, agent_binding=AGENT, plain_answer=False,
             optional_skill=False, second_skill=False, lifecycle='active', version=3, missing_dependency=False, rewritten_human=False,
             cancel_status=202, local_tasks=None, history_gate=None, history_started=None,
             artifact_status=None, artifact_responder=None, grant_status=200, on_grant=None,
             drop_once=False, silent_phase=False, resume_flake=False, stream_events=None,
             hold_stream=None, list_run=False):
    records = []
    artifacts = {}
    grants = set()
    resumes = []
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
            elif self.path == f'/api/resources/{SKILL2}/published':
                if not second_skill:
                    status, data = 404, {}
                else:
                    data = {'resource': dict(resource, id=SKILL2, type='skill'), 'version': {'version': 2},
                            'dependencies': []}
            elif self.path == '/api/threads/search':
                data = [{'thread_id': 'thread-A', 'status': 'idle', 'metadata': {'agent_name': AGENT}}] if user == 'A' else []
            elif self.path == '/api/threads':
                data = {'thread_id': 'thread-A', 'status': 'idle', 'metadata': body['metadata']}
            elif self.path == '/api/threads/thread-A':
                if user == 'B':
                    status, data = 404, {}
                else:
                    data = {'thread_id': 'thread-A', 'status': 'idle', 'metadata': {'agent_name': agent_binding}}
            elif self.path == '/api/threads/thread-B':
                if user == 'B':
                    status, data = 404, {}
                else:
                    data = {'thread_id': 'thread-B', 'status': 'idle', 'metadata': {'agent_name': agent_binding}}
            elif self.path == '/api/threads/thread-B/state':
                data = {'values': {'messages': []}}
            elif self.path.startswith('/api/threads/thread-B/messages/page'):
                data = {'data': [], 'has_more': False}
            elif self.path == '/api/threads/thread-B/runs':
                data = []
            elif self.path.startswith('/api/threads/thread-B/local-tasks?'):
                data = {'tasks': [], 'has_more': False, 'next_offset': None}
            elif self.path.startswith('/api/threads/thread-B/artifacts?'):
                data = {'artifacts': [], 'has_more': False, 'next_offset': None}
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
                    # Issue 77: list_run lets the reopen path see the run the
                    # fixture started; the default stays an empty history so
                    # older reopen tests keep proving no Run is restarted.
                    data = [{'run_id': 'run-1', 'thread_id': 'thread-A',
                             'status': 'running' if hold_stream is not None and not hold_stream.is_set() else 'success',
                             'created_at': '2026-01-01T00:00:00Z', 'metadata': {}}] if list_run else []
                else:
                    data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'running', 'metadata': {}}
                    if body.get('stream_mode') != ['messages-tuple', 'values', 'custom']:
                        status, data = 422, {'detail': 'Unsupported public stream mode'}
            elif self.path == '/api/threads/thread-A/runs/run-1':
                run_status = 'running' if hold_stream is not None and not hold_stream.is_set() else 'success'
                data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': run_status, 'metadata': {}}
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
                if self.headers.get('Last-Event-ID') == '1' and not disconnect:
                    if resume_flake and not resumes:
                        # The first resume dies at connect time with no HTTP
                        # response at all; the retry must still complete.
                        resumes.append(self.path)
                        self.close_connection = True
                        return
                    resumes.append(self.path)
                    # A resumed stream replays only what follows the cursor.
                    self.wfile.write(b'id: 2\nevent: messages\ndata: [{"id":"a1","type":"AIMessageChunk","content":" resumed"},{}]\n\n')
                    self.wfile.write(b'id: 3\nevent: end\ndata: null\n\n')
                    return
                self.wfile.write(b'id: 1\nevent: messages\ndata: [{"id":"a1","type":"AIMessageChunk","content":"Streamed"},{}]\n\n')
                self.wfile.flush()
                if hold_stream is not None:
                    # Issue 77: the run keeps streaming (Server side) until the
                    # test releases it; a switched-away session must not end it.
                    hold_stream.wait(10)
                    try:
                        self.wfile.write(b'id: 2\nevent: end\ndata: null\n\n')
                    except OSError:
                        pass  # the switched-away consumer already hung up
                    return
                time.sleep(0.1)
                if stream_events and not (disconnect or drop_once or silent_phase):
                    # Extra root frames (custom task_* events, values
                    # snapshots) replayed ahead of the end event, with their
                    # own event ids so a resume cursor stays well-formed.
                    for offset, (name, payload) in enumerate(stream_events, start=2):
                        frame = f'id: {offset}\nevent: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n'
                        self.wfile.write(frame.encode())
                        self.wfile.flush()
                        time.sleep(0.02)
                    self.wfile.write(f'id: {2 + len(stream_events)}\nevent: end\ndata: null\n\n'.encode())
                    return
                if silent_phase:
                    # The run stays silent past the client's read window; a
                    # fixed client times out, resumes from event 1, completes.
                    time.sleep(0.6)
                if not (disconnect or drop_once or silent_phase):
                    self.wfile.write(b'id: 2\nevent: end\ndata: null\n\n')
                elif silent_phase:
                    try:
                        self.wfile.write(b'id: 2\nevent: end\ndata: null\n\n')
                    except OSError:
                        pass  # the timed-out client already closed the socket
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


@pytest.fixture(autouse=True)
def instant_stream_resume(monkeypatch):
    """#37: bounded stream resume attempts must not add real sleep seconds."""
    import core.platform_chat as platform_chat
    # raising=False keeps the fixture a pure speed knob: modules without the
    # knob cannot sleep on it anyway, and the stream tests below still fail
    # on their behavior against such a module.
    monkeypatch.setattr(platform_chat, 'STREAM_RECONNECT_DELAY', 0.0, raising=False)


def request_header(row, name):
    """Header lookup over the recorded request; urllib rewrites the case."""
    return next((value for key, value in row[2].items() if key.lower() == name.lower()), None)


def await_stream_state(chat, state_name, seconds=10):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        state = chat.handle({'action': 'state'})
        if state['stream'] == state_name:
            break
        time.sleep(0.01)
    return state


def test_stream_read_timeout_resumes_from_the_last_event_and_completes(tmp_path, monkeypatch):
    """#37: a run silent past the stream read window (one long model phase)
    must not strand the turn as disconnected — the stream reconnects from the
    Last-Event-ID cursor and finishes idle, without resubmitting the turn."""
    import core.platform_chat as platform_chat
    # raising=False: a module without the knob hardcodes its own read timeout
    # and must fail the behavioral assertions below, not the setup.
    monkeypatch.setattr(platform_chat, 'STREAM_READ_TIMEOUT', 0.2, raising=False)
    with platform(silent_phase=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Answer after a long silence'})
        state = await_stream_state(chat, 'idle')
        assert state['stream'] == 'idle' and state['error'] == '', state['error']
        assert 'Streamed resumed' in [m['text'] for m in state['messages']]
        streams = [row for row in records if row[0].endswith('/stream')]
        assert len(streams) == 2
        assert request_header(streams[0], 'Last-Event-ID') is None
        assert request_header(streams[1], 'Last-Event-ID') == '1'
        assert len([body for path, body, _ in records if path.endswith('/runs') and body]) == 1


def test_dropped_stream_reconnects_with_the_last_event_id_and_completes(tmp_path):
    """#37: a stream connection that ends without the server's end event is
    resumed from the last delivered event, not surfaced as a broken turn."""
    with platform(drop_once=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888889', 'text': 'Survive the drop'})
        state = await_stream_state(chat, 'idle')
        assert state['stream'] == 'idle' and state['error'] == '', state['error']
        streams = [row for row in records if row[0].endswith('/stream')]
        assert len(streams) == 2
        assert request_header(streams[1], 'Last-Event-ID') == '1'
        assert len([body for path, body, _ in records if path.endswith('/runs') and body]) == 1


def test_failed_resume_attempt_is_retried_and_still_completes(tmp_path):
    """#37: a resume that dies at connect time (server refused with no HTTP
    response) is retried from the same cursor instead of ending the turn."""
    with platform(drop_once=True, resume_flake=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888891', 'text': 'Retry the resume'})
        state = await_stream_state(chat, 'idle')
        assert state['stream'] == 'idle' and state['error'] == '', state['error']
        streams = [row for row in records if row[0].endswith('/stream')]
        assert len(streams) == 3
        assert all(request_header(row, 'Last-Event-ID') == '1' for row in streams[1:])
        assert len([body for path, body, _ in records if path.endswith('/runs') and body]) == 1


def test_visible_disconnect_survives_only_bounded_resume_attempts(tmp_path):
    """#37: resume attempts are bounded; after the last one the disconnect is
    still visible to the user and no extra turn was ever submitted."""
    import core.platform_chat as platform_chat
    with platform(disconnect=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888890', 'text': 'Never finishes'})
        state = await_stream_state(chat, 'disconnected')
        assert state['stream'] == 'disconnected'
        assert state['error'] == 'CHAT_STREAM_DISCONNECTED'
        streams = [row for row in records if row[0].endswith('/stream')]
        assert len(streams) == 1 + platform_chat.STREAM_RECONNECTS
        assert request_header(streams[0], 'Last-Event-ID') is None
        assert all(request_header(row, 'Last-Event-ID') == '1' for row in streams[1:])
        assert len([body for path, body, _ in records if path.endswith('/runs') and body]) == 1


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


def test_due_reconnect_scheduled_by_the_state_poll_does_not_hold_the_command_queue(tmp_path, monkeypatch):
    """#80: the state poll schedules the guarded reconnect instead of doing
    the reconnect's network on the command queue — the same bound the tasks
    poll already keeps ("network observations cannot hold up a user's local
    Stop command"). A Server that cannot answer right now (here: the blocked
    history observation holding the single-handler fake) must never delay a
    state command past that bound. The recovery itself still lands: once the
    Server answers again, the record is backfilled from the platform and the
    stream returns to idle."""
    import core.platform_chat as platform_chat
    # The cooldown holds the reconnect back while the stream settles
    # disconnected; it then falls due exactly at the timed state command.
    monkeypatch.setattr(platform_chat, 'RECONNECT_COOLDOWN_SECONDS', 60.0, raising=False)
    gate, started = threading.Event(), threading.Event()
    gate.set()
    with platform(disconnect=True, history_gate=gate, history_started=started, list_run=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '34343434-3434-4343-8434-343434343434', 'text': 'Recover me'})
        assert await_stream_state(chat, 'disconnected')['platform']['reachable'] is True
        # The Server keeps answering slowly for a while: the gated local-tasks
        # endpoint — which the record reload itself fetches — holds the fake's
        # only handler for its bounded 5s wait. A reconnect that ran its
        # network on the command queue would stall the state command past the
        # bound the tasks poll already keeps.
        gate.clear()
        started.clear()
        monkeypatch.setattr(platform_chat, 'RECONNECT_COOLDOWN_SECONDS', 0.0, raising=False)
        before = time.monotonic()
        chat.handle({'action': 'state'})
        assert time.monotonic() - before < 1, 'reconnect scheduling must not hold the command queue'
        assert started.wait(1)  # the reload's local-tasks fetch went out
        state = await_stream_state(chat, 'idle', seconds=10)
        assert state['run'] and state['run']['status'] == 'success'
        assert state['messages'][-1]['text'] == 'Restored answer'
        assert len([row for row in records if row[0].endswith('/runs') and row[1]]) == 1




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
            decide_consent=lambda *args, **kwargs: decisions.append(args))
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


def test_chat_projects_script_and_material_asks_and_settles_them(tmp_path):
    """#39: Skill script and knowledge-material asks are device authority the
    Desktop chat can settle — the projection names identity facts only, and a
    remembered script grant rides exactly one allow decision."""
    from core.consent import PendingConsent
    script_pending = PendingConsent('task-122', 'local.skill.script', {'run_id': 'run-1', 'thread_id': 'thread-A',
        'skill_id': 'report-skill', 'script_path': 'scripts/analyze.py', 'script_sha256': 'b' * 64,
        'skill_version': 3, 'skill_content_hash': 'c' * 64, 'script': 'print(1)\n',
        'declaration': {'target': 'user_device'}}, 'b' * 64, 'level_1', False, {}, time.monotonic())
    material_pending = PendingConsent('task-116', 'local.knowledge.material', {'run_id': 'run-1', 'thread_id': 'thread-A',
        'operation': 'local.knowledge.material',
        'arguments': {'revision_id': 'rev-1', 'manifest_hash': 'd' * 64,
                      'documents': [{'document_id': 'doc-1', 'filename': 'guide.md', 'content_hash': 'e' * 64}]}},
        'c' * 64, 'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [script_pending, material_pending],
            decide_consent=lambda *args, **kwargs: decisions.append((args, kwargs)))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Run the skill'})
        assert sorted(row['kind'] for row in state['localConsents']) == ['knowledge-material', 'skill-script']
        script_row = next(row for row in state['localConsents'] if row['kind'] == 'skill-script')
        assert script_row['skill'] == 'report-skill' and script_row['scriptPath'] == 'scripts/analyze.py'
        assert script_row['version'] == '3' and script_row['scriptSha256'] == 'b' * 64
        assert script_row['requirementsSha256']
        assert 'script' not in script_row and 'declaration' not in script_row  # bytes never reach the display
        material_row = next(row for row in state['localConsents'] if row['kind'] == 'knowledge-material')
        assert material_row['revisionId'] == 'rev-1'
        assert material_row['documents'] == [{'filename': 'guide.md', 'contentHash': 'e' * 64}]
        # A remembered script grant rides exactly one allow decision; the
        # material ask accepts plain allow/deny and nothing else.
        chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-122', 'requestHash': 'b' * 64, 'decision': 'allow', 'rememberScript': True})
        chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-116', 'requestHash': 'c' * 64, 'decision': 'allow'})
        assert [call for call in decisions] == [
            (('task-122', 'b' * 64, True), {'always': True}),
            (('task-116', 'c' * 64, True), {'always': False}),
        ]


def test_chat_projects_inline_code_asks_and_settles_them(tmp_path):
    """#105: an inline-code ask is device authority the Desktop chat can
    settle. The card shows the code and its target root in full — the bytes
    the user approves are the bytes on display — and plain allow/deny
    settles it; rememberScript stays a script-grant concept."""
    from core.consent import PendingConsent
    node_pending = PendingConsent('task-105', 'local.python',
        {'run_id': 'run-1', 'thread_id': 'thread-A', 'operation': 'local.python',
         'runtime': 'node', 'working_root': '/workspace/102/data',
         'script': "console.log('inline');\n"},
        'a' * 64, 'level_1', False, {}, time.monotonic())
    python_pending = PendingConsent('task-106', 'local.python',
        {'run_id': 'run-1', 'thread_id': 'thread-A', 'operation': 'local.python',
         'working_root': '/workspace/102', 'script': 'print(1)\n'},
        'd' * 64, 'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin,
            local_consents=lambda: [node_pending, python_pending],
            decide_consent=lambda *args, **kwargs: decisions.append((args, kwargs)))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Run the inline code'})
        assert sorted(row['kind'] for row in state['localConsents']) == ['inline-code', 'inline-code']
        node_row = next(row for row in state['localConsents'] if row['language'] == 'node')
        assert node_row['taskId'] == 'task-105' and node_row['requestHash'] == 'a' * 64
        assert node_row['workingRoot'] == '/workspace/102/data'
        assert node_row['script'] == "console.log('inline');\n"
        python_row = next(row for row in state['localConsents'] if row['language'] == 'python')
        assert python_row['taskId'] == 'task-106' and python_row['script'] == 'print(1)\n'
        # rememberScript is the skill-script content grant; inline code
        # refuses it in every shape.
        refused = chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-105', 'requestHash': 'a' * 64, 'decision': 'allow', 'rememberScript': True})
        assert refused['error'] == 'CHAT_COMMAND_INVALID'
        chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-105', 'requestHash': 'a' * 64, 'decision': 'allow'})
        chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-106', 'requestHash': 'd' * 64, 'decision': 'deny'})
        assert decisions == [
            (('task-105', 'a' * 64, True), {'always': False}),
            (('task-106', 'd' * 64, False), {'always': False}),
        ]


def test_chat_never_approves_inline_code_hidden_by_credential_redaction(tmp_path):
    from core.consent import PendingConsent
    pending = PendingConsent('task-107', 'local.python',
        {'run_id': 'run-1', 'thread_id': 'thread-A', 'operation': 'local.python',
         'working_root': '/workspace/102', 'script': "print('business-A')\n"},
        'e' * 64, 'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [pending],
            decide_consent=lambda *args: decisions.append(args))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Run the inline code'})
        assert state['localConsents'] == []
        assert state['error'] == 'CONSENT_CONTENT_REDACTED'
        assert 'business-A' not in json.dumps(state)
        forced = chat.handle(dict(action='consent', scope=scope, threadId='thread-A', runId='run-1',
            taskId='task-107', requestHash='e' * 64, decision='allow'))
        assert forced['error'] == 'CONSENT_CONTENT_REDACTED'
        assert decisions == []


class _RecordingScripts:
    """The scratch-store seam the chat layer sweeps sessions through."""

    def __init__(self) -> None:
        self.threads: list[str] = []
        self.wiped = 0

    def cleanup_thread(self, thread_id: str) -> None:
        self.threads.append(thread_id)

    def cleanup_all(self) -> None:
        self.wiped += 1


def test_chat_sweeps_session_scripts_when_the_session_ends(tmp_path):
    """#105 临时脚本按会话清理: switching away from a session sweeps its
    scratch; an identity reset sweeps everything."""
    scripts = _RecordingScripts()
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, inline_scripts=scripts)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'First'})
        assert scripts.threads == []
        # Opening another session sweeps the one being left behind...
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-B'})
        assert scripts.threads == ['thread-A']
        # ...and reopening the same session does not (the session continues).
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-B'})
        assert scripts.threads == ['thread-A']
        wipes_before = scripts.wiped
        chat._reset()
        assert scripts.wiped == wipes_before + 1


def test_chat_remember_script_flag_is_bound_to_script_allows_only(tmp_path):
    """#39: rememberScript on another kind or with deny is a malformed command."""
    from core.consent import PendingConsent
    material_pending = PendingConsent('task-116', 'local.knowledge.material', {'run_id': 'run-1', 'thread_id': 'thread-A',
        'operation': 'local.knowledge.material',
        'arguments': {'revision_id': 'rev-1', 'manifest_hash': 'd' * 64,
                      'documents': [{'document_id': 'doc-1', 'filename': 'guide.md', 'content_hash': 'e' * 64}]}},
        'c' * 64, 'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [material_pending],
            decide_consent=lambda *args, **kwargs: decisions.append(args))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Generate the graph'})
        result = chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-116', 'requestHash': 'c' * 64, 'decision': 'allow', 'rememberScript': True})
        assert result['error'] == 'CHAT_COMMAND_INVALID'
        assert decisions == []


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


def test_unreachable_platform_refuses_new_turns_with_a_visible_reason(tmp_path):
    """#80: once the platform is observed unreachable, new Turns are refused
    by name before the turn is consumed — not a silent failure and not the
    misleading in-progress category — and no local fallback path runs."""
    class _LocalTouch:
        def __init__(self):
            self.calls = 0

        def view(self, *_args):
            self.calls += 1
            return {}

    local = _LocalTouch()
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, local_results=local)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        baseline = local.calls
    def runs_seen():
        return [row for row in records if row[0].endswith('/runs') and row[1]]
    first = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                         'turnId': '80808080-8080-4808-8808-808080808080', 'text': 'One honest try'})
    assert first['error'] == 'CHAT_SERVER_UNAVAILABLE'
    refused = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                           'turnId': '80808080-8080-4808-8808-808080808080', 'text': 'One honest try'})
    assert refused['error'] == 'CHAT_PLATFORM_UNREACHABLE'
    assert refused['platform'] == {'reachable': False, 'detail': 'CHAT_SERVER_UNAVAILABLE'}
    assert refused['run'] is None
    # A branch onto a new platform Thread is new orchestration output too.
    branched = chat.handle({'action': 'branch', 'scope': scope, 'threadId': 'thread-A',
                            'messageId': 'a1'})
    assert branched['error'] == 'CHAT_PLATFORM_UNREACHABLE'
    assert runs_seen() == []
    # The security seam: the pause runs no local model, orchestration or
    # receipt fabrication — the refused turns touch nothing on the device.
    assert local.calls == baseline


def test_unreachable_submission_is_marked_uncertain_and_never_resubmitted_locally(tmp_path, monkeypatch):
    """#80: a submission whose run POST dies mid-flight stays honestly
    unknown ('uncertain'), the pause holds while the platform is away, and
    recovery reconnects on its own to backfill the Server's record — the
    unknown turn's idempotency fence holds and a fresh user retry is the
    only resubmission that ever happens."""
    import core.platform_chat as platform_chat
    monkeypatch.setattr(platform_chat, 'RECONNECT_COOLDOWN_SECONDS', 0.0, raising=False)
    # The refusal happens at the socket layer of the one runs POST, so the
    # transport seam itself records the outcome exactly as in production.
    import urllib.request as urllib_request
    real_build_opener = urllib_request.build_opener
    down = {'flag': False}

    def picky_build_opener(*args, **kwargs):
        real = real_build_opener(*args, **kwargs)

        class PickyOpener:
            def open(self, request, timeout=15):
                if down['flag'] and request.full_url.endswith('/runs') and request.data is not None:
                    raise OSError('connection refused')
                return real.open(request, timeout=timeout)

        return PickyOpener()

    monkeypatch.setattr(urllib_request, 'build_opener', picky_build_opener)
    with platform(list_run=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '51501550-5150-4515-8150-515015505150', 'text': 'Settled turn'})
        settled = await_stream_state(chat, 'idle')
        assert settled['platform']['reachable'] is True
        down['flag'] = True
        unknown = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                               'turnId': '52502550-5250-4525-8250-525025505250', 'text': 'Lost in flight'})
        assert unknown['error'] == 'CHAT_SERVER_UNAVAILABLE'
        assert unknown['stream'] == 'uncertain'
        assert unknown['platform']['reachable'] is False
        paused = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '54504550-5450-4545-8450-545045505450', 'text': 'Paused retry'})
        assert paused['error'] == 'CHAT_PLATFORM_UNREACHABLE'
        down['flag'] = False
        # The status loop calls the same shared entry point with no panel
        # polling; one direct reconcile schedules the reload off the command
        # queue, and the Server's own record lands from it.
        chat.reconcile()
        recovered = await_stream_state(chat, 'idle')
        assert recovered['platform']['reachable'] is True
        assert recovered['run']['status'] == 'success'
        assert recovered['messages'][-1]['text'] == 'Restored answer'
        # The uncertain turn's idempotency fence holds — the Server may have
        # accepted what this device could not observe — while the user's own
        # fresh retry works and is the only resubmission that ever happens.
        fenced = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '52502550-5250-4525-8250-525025505250', 'text': 'Lost in flight'})
        assert fenced['error'] == 'CHAT_TURN_ALREADY_SUBMITTED'
        retried = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                               'turnId': '55505550-5550-4555-8550-555055505550', 'text': 'Fresh retry'})
        assert retried['run']['id'] == 'run-1'
        assert len([row for row in records if row[0].endswith('/runs') and row[1]]) == 2


def test_disconnected_stream_reconciles_automatically_and_backfills_the_record(tmp_path, monkeypatch):
    """#80: a run stream that drops past its bounded resumes becomes the
    explicit disconnected state, and once the platform answers again the
    state poll reconnects by itself after the cooldown — the run record and
    messages are backfilled from the Server, without resubmitting the turn."""
    import core.platform_chat as platform_chat
    monkeypatch.setattr(platform_chat, 'RECONNECT_COOLDOWN_SECONDS', 60.0, raising=False)
    with platform(disconnect=True, list_run=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '53503550-5350-4535-8350-535035505350', 'text': 'Do not replay'})
        state = await_stream_state(chat, 'disconnected')
        assert state['error'] == 'CHAT_STREAM_DISCONNECTED'
        assert state['platform']['reachable'] is True
        # While the cooldown holds, the disconnect stays visible instead of
        # silently healing; a new turn is still refused as in progress.
        held = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                            'turnId': '54504550-5450-4545-8450-545045505450', 'text': 'Not yet'})
        assert held['error'] == 'CHAT_TURN_IN_PROGRESS'
        monkeypatch.setattr(platform_chat, 'RECONNECT_COOLDOWN_SECONDS', 0.0, raising=False)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            state = chat.handle({'action': 'state'})
            if state['stream'] == 'idle':
                break
            time.sleep(0.01)
        assert state['stream'] == 'idle'
        assert state['run']['status'] == 'success'
        assert state['messages'][-1]['text'] == 'Restored answer'
        assert len([row for row in records if row[0].endswith('/runs') and row[1]]) == 1


def test_server_error_marks_the_platform_unreachable_and_pauses_new_turns(tmp_path, monkeypatch):
    """#80: a 5xx answer is the server side failing — the same outage a dead
    socket is. A 4xx refusal stays reachable; the pause names itself either
    way."""
    import io
    import urllib.error
    import urllib.request
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        real_build_opener = urllib.request.build_opener

        def failing_build_opener(*args, **kwargs):
            real = real_build_opener(*args, **kwargs)

            class RefusingOpener:
                def open(self, request, timeout=15):
                    if request.full_url.endswith('/runs') and request.data is not None:
                        raise urllib.error.HTTPError(request.full_url, 503, 'Service Unavailable',
                                                     {}, io.BytesIO(b'{}'))
                    return real.open(request, timeout=timeout)

            return RefusingOpener()

        monkeypatch.setattr(urllib.request, 'build_opener', failing_build_opener)
        sent = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                            'turnId': '87878787-8787-4878-8878-878787878787', 'text': 'Into a 503'})
        assert sent['error'] == 'CHAT_SERVER_ERROR'
        assert sent['stream'] == 'uncertain'
        assert sent['platform'] == {'reachable': False, 'detail': 'CHAT_SERVER_ERROR'}
        paused = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Paused'})
        assert paused['error'] == 'CHAT_PLATFORM_UNREACHABLE'


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


def test_chat_tier_switch_is_validated_recorded_and_reset_by_thread_load(tmp_path):
    """#74: the three session tiers ride one explicit command; a session
    always starts at the lowest tier, switching needs the matching confirm
    for the full tier, and reopening a thread forgets any tier choice —
    with the fall-back itself recorded in the audit log."""
    from core.session_tier import SessionTier, SessionTierRegistry

    class _AuditSpy:
        def __init__(self):
            self.entries = []

        def record(self, kind, action, **kwargs):
            self.entries.append((action, kwargs.get('detail')))
            return kwargs

    audit = _AuditSpy()
    registry = SessionTierRegistry(audit=audit)
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, session_tiers=registry)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '34343434-3434-4343-8343-343434343434', 'text': 'Hello'})
        # A loaded session is always at the lowest tier.
        assert state['localTier'] == 'ask_first'

        upgraded = chat.handle({'action': 'tier', 'scope': scope, 'threadId': 'thread-A',
                                'tier': 'autonomous'})
        assert upgraded['localTier'] == 'autonomous'
        assert upgraded['error'] == ''
        assert registry.tier_for('thread-A') is SessionTier.AUTONOMOUS

        full = chat.handle({'action': 'tier', 'scope': scope, 'threadId': 'thread-A',
                            'tier': 'full', 'confirm': True})
        assert full['localTier'] == 'full'
        assert registry.tier_for('thread-A') is SessionTier.FULL

        downgraded = chat.handle({'action': 'tier', 'scope': scope, 'threadId': 'thread-A',
                                  'tier': 'ask_first'})
        assert downgraded['localTier'] == 'ask_first'
        assert registry.tier_for('thread-A') is SessionTier.ASK_FIRST
        assert [action for action, _ in audit.entries] == ['session_tier_changed'] * 3

        # Reopening the thread forgets whatever the session chose before, and
        # the expiry is recorded just like a switch (#74 review).
        chat.handle({'action': 'tier', 'scope': scope, 'threadId': 'thread-A', 'tier': 'full',
                     'confirm': True})
        reopened = chat.handle({'action': 'reconnect', 'scope': scope, 'threadId': 'thread-A'})
        assert reopened['localTier'] == 'ask_first'
        assert registry.tier_for('thread-A') is SessionTier.ASK_FIRST
        assert audit.entries[-1] == ('session_tier_expired',
                                {'thread_id': 'thread-A', 'from': 'full', 'to': 'ask_first'})


def test_chat_tier_command_rejects_malformed_and_mismatched_requests(tmp_path):
    from core.session_tier import SessionTier, SessionTierRegistry

    registry = SessionTierRegistry()
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, session_tiers=registry)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '35353535-3535-4353-8353-353535353535', 'text': 'Hello'})
        for command, expected in (
            ({'action': 'tier', 'scope': scope, 'threadId': 'thread-A', 'tier': 'full'},
             'CHAT_COMMAND_INVALID'),  # the full tier needs the explicit confirm
            ({'action': 'tier', 'scope': scope, 'threadId': 'thread-A', 'tier': 'unlimited'},
             'CHAT_COMMAND_INVALID'),
            ({'action': 'tier', 'scope': scope, 'threadId': 'thread-A', 'tier': 'autonomous',
              'confirm': True}, 'CHAT_COMMAND_INVALID'),  # confirm belongs to full only
            ({'action': 'tier', 'scope': scope, 'threadId': 'thread-A', 'tier': 'autonomous',
              'extra': 'x'}, 'CHAT_COMMAND_INVALID'),
            ({'action': 'tier', 'scope': scope, 'threadId': 'thread-B', 'tier': 'autonomous'},
             'CHAT_THREAD_CHANGED'),
        ):
            state = chat.handle(command)
            assert state['error'] == expected
            assert state['localTier'] == 'ask_first'
        assert registry.tier_for('thread-A') is SessionTier.ASK_FIRST
        # The thread mismatch never reloaded anything, so the tier command
        # against the open thread still works afterwards.
        state = chat.handle({'action': 'tier', 'scope': scope, 'threadId': 'thread-A',
                             'tier': 'autonomous'})
        assert state['localTier'] == 'autonomous'


def test_chat_tier_command_needs_a_runtime_registry(tmp_path):
    """A DesktopChat built without the device registry refuses to fake one."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '36363636-3636-4363-8363-363636363636', 'text': 'Hello'})
        state = chat.handle({'action': 'tier', 'scope': scope, 'threadId': 'thread-A',
                             'tier': 'autonomous'})
        assert state['error'] == 'CHAT_COMMAND_INVALID'
        assert state['localTier'] == 'ask_first'


# --- Input commands on send (issue 75) --------------------------------------


def run_posts(records):
    """The recorded /runs submissions with a JSON body."""
    return [body for path, body, _ in records
            if path == '/api/threads/thread-A/runs' and isinstance(body, dict) and 'assistant_id' in body]


def test_send_delegate_agent_stays_in_the_session_and_records_the_choice(tmp_path):
    """#75: @ delegation keeps the main Agent and Thread — the platform's lead
    Agent delegates through its own sub-agents; the picked id rides the run
    metadata and the context carries no per-send skill unless one is mounted."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '75757575-7575-4757-8757-757575757575',
                             'text': '@Published expert 帮我看看', 'delegateAgentId': AGENT})
        assert state['error'] == ''
        body = run_posts(records)[-1]
        assert body['assistant_id'] == AGENT
        assert body['metadata']['desktop_delegate_agent_id'] == AGENT
        assert body['metadata']['desktop_turn_id'] == '75757575-7575-4757-8757-757575757575'
        assert 'skill_resource_id' not in body['context']


def test_send_mounted_skill_maps_first_onto_the_explicit_seam(tmp_path):
    """#75: the first mounted chip is the run's explicit Skill — never a
    trigger guess — mapped onto the same context seam a create-time Skill
    uses, and validated by the same agent-closure rule."""
    with platform(optional_skill=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '75757575-7575-4757-8757-757575757575',
                             'text': '跑一次', 'skillIds': [SKILL]})
        assert state['error'] == ''
        body = run_posts(records)[-1]
        assert body['context']['skill_resource_id'] == SKILL
        assert body['metadata']['desktop_skill_ids'] == [SKILL]
        assert 'desktop_delegate_agent_id' not in body['metadata']


def test_send_records_the_whole_mount_on_the_run(tmp_path):
    """#75: every mounted chip rides the run in the user's pick order — the
    first onto the explicit seam, the whole list into the run metadata — so a
    mount is never UI-only dead weight."""
    with platform(optional_skill=True, second_skill=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '75757575-7575-4757-8757-757575757575',
                             'text': '跑一次', 'skillIds': [SKILL, SKILL2]})
        assert state['error'] == ''
        body = run_posts(records)[-1]
        assert body['context']['skill_resource_id'] == SKILL
        assert body['metadata']['desktop_skill_ids'] == [SKILL, SKILL2]


def test_send_explicit_skill_outside_agent_closure_is_rejected(tmp_path):
    """#75: a published Skill outside the agent's closure fails exactly like a
    create-time selection, before any run is submitted."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '75757575-7575-4757-8757-757575757575',
                             'text': '跑一次', 'skillIds': [SKILL]})
        assert state['error'] == 'CHAT_SKILL_OUTSIDE_AGENT'
        assert run_posts(records) == []
        # The turn was never consumed, so the same id can still send plainly.
        recovered = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                                 'turnId': '75757575-7575-4757-8757-757575757575', 'text': '跑一次'})
        assert recovered['error'] == ''


def test_send_rejects_malformed_input_commands(tmp_path):
    """#75: shape violations fail without consuming the turn; the fields ride
    the send action only, and an unknown delegate is a protocol failure."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        for patch in ({'skillIds': []}, {'skillIds': 'skill'}, {'skillIds': ['x', 'x']},
                      {'skillIds': ['x' * 129]}, {'delegateAgentId': ''},
                      {'delegateAgentId': 'not-a-uuid'}, {'delegateAgentId': 'y' * 129}):
            state = chat.handle(dict(action='send', scope=scope, threadId='thread-A',
                                     turnId='75757575-7575-4757-8757-757575757575',
                                     text='跑一次', **patch))
            assert state['error'] == 'CHAT_COMMAND_INVALID', patch
        # An answer never carries the input commands, whatever its state.
        stale = chat.handle({'action': 'answer', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '75757575-7575-4757-8757-757575757575', 'requestId': 'req',
                             'text': 'ok', 'skillIds': [SKILL]})
        assert stale['error'] == 'CHAT_COMMAND_INVALID'
        assert run_posts(records) == []
        unknown = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                               'turnId': '75757575-7575-4757-8757-757575757575', 'text': '跑一次',
                               'delegateAgentId': '99999999-9999-4999-8999-999999999999'})
        assert unknown['error'] == 'CHAT_NOT_FOUND'
        # Nothing consumed the turn; the plain send still goes through.
        final = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '75757575-7575-4757-8757-757575757575', 'text': '跑一次'})
        assert final['error'] == ''
        assert len(run_posts(records)) == 1


# --- Collab mode: platform sub-agent progress (issue 76) ---------------------


def subagent_row(state, task_id):
    return next(row for row in state['subagents'] if row['taskId'] == task_id)


def test_send_collab_explicitly_sets_the_delegation_seam(tmp_path):
    """#76: the collab toggle maps onto the platform's own delegation seam
    with an explicit boolean, like the Web client's own mode switch — the
    platform's silent default is delegation OFF, so "on" must say so. The
    flag rides send commands only; which sub-agents exist stays the lead
    Agent's own configuration."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        single = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '76767676-7676-4676-8767-767676767671',
                              'text': '单独跑', 'collab': False})
        assert single['error'] == ''
        assert run_posts(records)[-1]['context']['subagent_enabled'] is False
        await_stream_state(chat, 'idle')
        collab = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '76767676-7676-4676-8767-767676767672',
                              'text': '一起跑', 'collab': True})
        assert collab['error'] == ''
        assert run_posts(records)[-1]['context']['subagent_enabled'] is True
        await_stream_state(chat, 'idle')
        # The composer always sends the flag; a send without it (no composer
        # involved) keeps the platform default instead of inventing a mode.
        plain = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '76767676-7676-4676-8767-767676767673', 'text': '默认跑'})
        assert plain['error'] == ''
        assert 'subagent_enabled' not in run_posts(records)[-1]['context']


def test_send_rejects_malformed_collab(tmp_path):
    """#76: the collab flag rides the send action only and must be a boolean;
    a violation fails without consuming the turn."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        for patch in ({'collab': 'yes'}, {'collab': 1}, {'collab': ['true']}):
            state = chat.handle(dict(action='send', scope=scope, threadId='thread-A',
                                     turnId='76767676-7676-4676-8767-767676767674',
                                     text='跑一次', **patch))
            assert state['error'] == 'CHAT_COMMAND_INVALID', patch
        stale = chat.handle({'action': 'answer', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '76767676-7676-4676-8767-767676767674', 'requestId': 'req',
                             'text': 'ok', 'collab': False})
        assert stale['error'] == 'CHAT_COMMAND_INVALID'
        assert run_posts(records) == []
        # Nothing consumed the turn; the plain send still goes through.
        final = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '76767676-7676-4676-8767-767676767674', 'text': '跑一次'})
        assert final['error'] == ''
        assert len(run_posts(records)) == 1


def test_subagent_events_map_into_structured_progress(tmp_path):
    """#76: per-sub-agent progress is a bound projection of the platform's own
    task_* custom events — status names mirror the pushed event exactly, no
    state the platform never sent appears, and the raw event ledger keeps
    every frame beside the structured one."""
    stream_events = [
        ('custom', {'type': 'task_started', 'task_id': 'call-1', 'description': '检索公开资料',
                    'model_name': 'glm-4.7'}),
        ('custom', {'type': 'task_running', 'task_id': 'call-1', 'message': {'content': '查资料中'},
                    'message_index': 1, 'total_messages': 3,
                    'usage': {'input_tokens': 120, 'output_tokens': 40, 'total_tokens': 160},
                    'model_name': 'glm-4.7'}),
        ('custom', {'type': 'custom_note', 'task_id': 'call-x'}),
        ('custom', {'type': 'task_completed', 'task_id': 'call-1', 'result': '完成报告',
                    'usage': {'input_tokens': 300, 'output_tokens': 90, 'total_tokens': 390},
                    'model_name': 'glm-4.7'}),
        ('custom', {'type': 'task_failed', 'task_id': 'call-2', 'error': '子代理崩溃'}),
        ('custom', {'type': 'task_timed_out', 'task_id': 'call-3', 'error': '', 'usage': None}),
        ('custom', {'type': 'task_running', 'task_id': {'oops': 1}}),
        ('custom', {'type': 'task_started', 'task_id': 'call-4', 'description': 'x' * 3000}),
    ]
    with platform(stream_events=stream_events) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '76767676-7676-4676-8767-767676767675', 'text': '协同跑'})
        assert state['error'] == ''
        state = await_stream_state(chat, 'idle')
        rows = {row['taskId']: row for row in state['subagents']}
        # Only the tasks the platform really pushed appear, and nothing else.
        assert set(rows) == {'call-1', 'call-2', 'call-3', 'call-4'}
        assert rows['call-1']['status'] == 'completed'
        assert rows['call-1']['description'] == '检索公开资料'
        assert rows['call-1']['result'] == '完成报告'
        assert rows['call-1']['resultTruncated'] is False
        assert rows['call-1']['usage'] == {'inputTokens': 300, 'outputTokens': 90, 'totalTokens': 390}
        assert rows['call-1']['model'] == 'glm-4.7'
        assert rows['call-1']['step'] == 1 and rows['call-1']['totalSteps'] == 3
        assert rows['call-2']['status'] == 'failed'
        assert rows['call-2']['error'] == '子代理崩溃'
        assert rows['call-3']['status'] == 'timed_out'
        assert rows['call-3']['usage'] is None
        assert rows['call-4']['description'] == 'x' * 2000
        # A task the platform started but never reported finished stays
        # exactly as reported — the desktop invents no terminal state after
        # the fact.
        assert rows['call-4']['status'] == 'running'
        # The raw ledger keeps every custom frame beside the structured one.
        assert sum(1 for event in state['events'] if event['event'] == 'custom') == 8


def test_subagent_agent_type_follows_the_parent_tool_call(tmp_path):
    """#76: the sub-agent's own type is not on the wire — the desktop derives
    the display fact from the parent AI message's task tool_calls when the
    platform itself publishes them, in either arrival order."""
    tool_call_values = ('values', {'messages': [
        {'id': 'a1', 'type': 'ai', 'content': '',
         'tool_calls': [{'id': 'call-1', 'name': 'task',
                         'args': {'subagent_type': 'researcher', 'description': '检索'}}]}]})
    started = ('custom', {'type': 'task_started', 'task_id': 'call-1', 'description': '检索公开资料'})
    for order, stream_events in (('values first', [tool_call_values, started]),
                                 ('event first', [started, tool_call_values])):
        with platform(stream_events=stream_events) as (origin, records):
            chat, _, _ = make_chat(tmp_path, origin)
            scope = chat.handle({'action': 'refresh'})['scope']
            chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
            chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                         'turnId': '76767676-7676-4676-8767-767676767676', 'text': '协同跑'})
            state = await_stream_state(chat, 'idle')
            row = subagent_row(state, 'call-1')
            assert row['agent'] == 'researcher', order
            assert row['status'] == 'running', order


def test_new_turn_resets_the_subagent_ledger(tmp_path):
    """#76: the structured progress belongs to the run that dispatched it — a
    new turn starts from an empty ledger, while the finished results stay in
    the conversation's own tool messages."""
    with platform(stream_events=[('custom', {'type': 'task_started', 'task_id': 'call-1',
                                             'description': '旧任务'})]) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '76767676-7676-4676-8767-767676767677', 'text': '第一轮'})
        state = await_stream_state(chat, 'idle')
        assert state['subagents']
        second = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': '76767676-7676-4676-8767-767676767678', 'text': '第二轮'})
        assert second['error'] == ''
        assert second['subagents'] == []


def test_background_run_keeps_running_and_reports_finish_once(tmp_path):
    """#77: switching away never aborts a Run — the Server keeps it and the
    Desktop observes it until it ends, reports exactly one finish notification,
    and reopening the session reattaches the truthful end state."""
    hold = threading.Event()
    with platform(hold_stream=hold, list_run=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '76767676-7676-4776-8776-767676767676', 'text': '跑后台任务'})
        assert state['stream'] == 'streaming'
        # 切到另一个会话：thread-A 的 Run 被登记为后台观察对象，而不是被中止。
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-B'})
        assert opened['thread']['id'] == 'thread-B'
        assert chat.background_runs() == [{'threadId': 'thread-A', 'runId': 'run-1'}]
        assert not any('/cancel' in route for route, _, _ in records)
        # 还在跑：不产生完成通知；重复观察也不产生。
        assert chat.background_tick(force=True) == []
        assert chat.background_tick(force=True) == []
        hold.set()
        finished = chat.background_tick(force=True)
        assert len(finished) == 1
        assert finished[0]['kind'] == 'run-finished'
        assert finished[0]['threadId'] == 'thread-A' and finished[0]['runId'] == 'run-1'
        assert finished[0]['status'] == 'success'
        assert chat.background_runs() == []
        # 完成通知只发一次。
        assert chat.background_tick(force=True) == []
        # 重开会话：状态如实显示结束态，不再重挂流。
        reopened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert reopened['run']['status'] == 'success'
        assert reopened['stream'] == 'idle'


def test_background_consent_ask_notifies_once_and_skips_foreground(tmp_path):
    """#77: a device approval ask on a backgrounded session reaches the user
    as a notification exactly once — identity facts only, never the payload
    bytes — and asks on the visible session stay on the chat cards."""
    from core.consent import PendingConsent
    hold = threading.Event()
    background_ask = PendingConsent('task-bg', 'local.files.write',
        {'run_id': 'run-1', 'thread_id': 'thread-A',
         'arguments': {'path': '/workspace/bg/target.txt', 'content': 'SECRET BODY\n'}},
        'e' * 64, 'level_1', False, {}, time.monotonic())
    foreground_ask = PendingConsent('task-fg', 'local.files.write',
        {'run_id': 'run-B', 'thread_id': 'thread-B',
         'arguments': {'path': '/workspace/fg/target.txt', 'content': 'VISIBLE\n'}},
        'f' * 64, 'level_1', False, {}, time.monotonic())
    with platform(hold_stream=hold) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [background_ask, foreground_ask])
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '78787878-7878-4788-8888-787878787878', 'text': '写文件'})
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-B'})
        events = chat.background_tick(force=True)
        assert len(events) == 1
        event = events[0]
        assert event['kind'] == 'approval-required'
        assert event['threadId'] == 'thread-A' and event['runId'] == 'run-1'
        assert event['taskId'] == 'task-bg' and event['approval'] == 'file-write'
        assert event['summary'] == '/workspace/bg/target.txt'
        assert 'SECRET' not in json.dumps(events) and 'VISIBLE' not in json.dumps(events)
        # 只通知一次；前台会话的请求不进通知。
        assert chat.background_tick(force=True) == []
        # 请求先消失（已被解决）再出现：视为新的一问，重新通知。
        chat.local_consents = lambda: []
        assert chat.background_tick(force=True) == []
        chat.local_consents = lambda: [PendingConsent('task-bg', 'local.files.write',
            {'run_id': 'run-1', 'thread_id': 'thread-A',
             'arguments': {'path': '/workspace/bg/target.txt', 'content': 'SECRET BODY\n'}},
            'e' * 64, 'level_1', False, {}, time.monotonic())]
        replayed = chat.background_tick(force=True)
        assert [row['taskId'] for row in replayed] == ['task-bg']
        # 审批快照不可用时，完成观察照常进行，下一轮恢复。
        def unavailable():
            raise RuntimeError('fixture snapshot unavailable')
        chat.local_consents = unavailable
        assert chat.background_tick(force=True) == []


def test_background_registry_resets_when_identity_changes(tmp_path):
    """#77: the background ledger is a live-observation seam of the current
    pairing — an identity change fences it off instead of ever reporting a
    retired account's runs."""
    hold = threading.Event()
    with platform(hold_stream=hold) as (origin, _):
        chat, settings, config = make_chat(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '79797979-7979-4799-8999-797979797979', 'text': '跑后台任务'})
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-B'})
        assert chat.background_runs() == [{'threadId': 'thread-A', 'runId': 'run-1'}]
        settings.business_token_ref = 'business-B'
        settings.save(config)
        assert chat.background_tick(force=True) == []
        assert chat.background_runs() == []


def test_background_consent_facts_outside_the_wire_charset_are_skipped(tmp_path):
    """#77: an ask whose run/task identity cannot survive the notify wire is
    skipped entirely — the Desktop must never emit an event the strict main
    process would treat as a malformed status line and kill the Runtime for."""
    from core.consent import PendingConsent
    hold = threading.Event()
    malformed = PendingConsent('task/evil', 'local.files.write',
        {'run_id': 'run 1', 'thread_id': 'thread-A',
         'arguments': {'path': '/workspace/x/target.txt', 'content': 'BODY\n'}},
        'e' * 64, 'level_1', False, {}, time.monotonic())
    with platform(hold_stream=hold) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [malformed])
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '80808080-8080-4800-9000-808080808080', 'text': '写文件'})
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-B'})
        assert chat.background_tick(force=True) == []
        assert chat.background_tick(force=True) == []


def test_dependency_install_ask_projects_entries_and_source_only(tmp_path) -> None:
    """#104: the install ask rides the same pending queue; the card names the
    skill, the locked entries and the source, never the script bytes, and
    ``rememberScript`` stays a script-only affordance."""
    from core.consent import PendingConsent
    install_pending = PendingConsent('task-104', 'local.skill.dependencies',
        {'run_id': 'run-1', 'thread_id': 'thread-A', 'skill_id': 'report-skill',
         'skill_version': 3, 'requirements_sha256': 'd' * 64,
         'entries': [{'entry': 'requests==2.31.0', 'name': 'requests', 'version': '2.31.0'}],
         'source': {'kind': 'intranet', 'location': 'http://intranet.example/wheels'},
         'script': 'print(secret bytes that must not leak)\n'},
        'd' * 64, 'level_1', False, {}, time.monotonic())
    decisions = []
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [install_pending],
            decide_consent=lambda *args, **kwargs: decisions.append((args, kwargs)))
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
            'turnId': '33333333-3333-4333-8333-333333333333', 'text': 'Run the skill'})
        rows = [row for row in state['localConsents'] if row['kind'] == 'skill-dependencies']
        assert len(rows) == 1
        row = rows[0]
        assert row['skill'] == 'report-skill' and row['version'] == '3'
        assert row['entries'] == [{'entry': 'requests==2.31.0', 'name': 'requests', 'version': '2.31.0'}]
        assert row['source'] == {'kind': 'intranet', 'location': 'http://intranet.example/wheels'}
        assert row['requirementsSha256'] == 'd' * 64
        assert 'script' not in row and 'declaration' not in row  # bytes never reach the display
        # A plain allow settles the install; "remember" is refused for it.
        chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-104', 'requestHash': 'd' * 64, 'decision': 'allow'})
        assert decisions and decisions[0][0][:3] == ('task-104', 'd' * 64, True)
        rejected = chat.handle({'action': 'consent', 'scope': scope, 'threadId': 'thread-A', 'runId': 'run-1',
            'taskId': 'task-104', 'requestHash': 'd' * 64, 'decision': 'allow', 'rememberScript': True})
        assert rejected['error'] == 'CHAT_COMMAND_INVALID'


def test_background_notification_names_dependency_installs(tmp_path) -> None:
    """#104: an install ask on an invisible session notifies like the other
    device authorities, with a bounded identity summary."""
    from core.consent import PendingConsent
    install_pending = PendingConsent('task-bg-104', 'local.skill.dependencies',
        {'run_id': 'run-9', 'thread_id': 'thread-BG', 'skill_id': 'report-skill',
         'skill_version': 3, 'requirements_sha256': 'd' * 64,
         'entries': [{'entry': 'requests==2.31.0', 'name': 'requests', 'version': '2.31.0'}],
         'source': {'kind': 'offline', 'location': 'D:/wheels'}},
        'd' * 64, 'level_1', False, {}, time.monotonic())
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin, local_consents=lambda: [install_pending])
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
        events = chat.background_tick()
        approvals = [event for event in events if event.get('kind') == 'approval-required'
                     and event.get('approval') == 'skill-dependencies']
        assert approvals and approvals[0]['taskId'] == 'task-bg-104'
        assert approvals[0]['summary'] == 'report-skill'
