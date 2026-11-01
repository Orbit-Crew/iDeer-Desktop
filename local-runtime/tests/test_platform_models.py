"""Issue 73: the model settings surface — platform list, account default,
device-local fallback, per-session switching, and honest unavailability.

Every test drives the same protocol fixture discipline as test_platform_chat:
a local HTTP fixture stands in for the Server, and the Desktop's replies are
checked for the exact bounded shapes the bridge projection will demand.
"""
import json
import threading
import time
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings

AGENT = '11111111-1111-4111-8111-111111111111'
MODEL_A = 'model-alpha'
MODEL_B = 'model-beta'


@contextmanager
def platform(*, models=(MODEL_A, MODEL_B), can_read_models=True, patch_status=204,
             preferences_model=None, runs_model_denied=False, runs_denied=False):
    """Fixture Server with the model endpoints and the chat minimums."""
    records = []
    preferences = {'model_name': preferences_model}
    resource = dict(id=AGENT, type='agent', display_name='Published expert', visibility='private',
                    lifecycle_status='active', latest_version=3)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))

        def do_PATCH(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            self.respond(body)

        def respond(self, body):
            records.append((self.path, body, dict(self.headers), self.command))
            cookie = self.headers.get('Cookie', '')
            user = 'B' if 'business-B' in cookie else 'A'
            status = 200
            if self.path == '/api/v1/auth/me':
                permissions = ['runs:create']
                if can_read_models:
                    permissions.append('models:read')
                data = {'id': user, 'email': user + '@test.invalid', 'system_role': 'user',
                        'permissions': permissions}
            elif self.path == '/api/v1/auth/preferences':
                if self.command == 'PATCH':
                    if patch_status != 204:
                        status, data = patch_status, {'detail': 'The signed-in account changed; reload this page'}
                    else:
                        if isinstance(body, dict) and 'model_name' in body:
                            preferences['model_name'] = body['model_name']
                        status, data = 204, None
                else:
                    data = {'notification_enabled': True, 'model_name': preferences['model_name'],
                            'mode': None, 'reasoning_effort': None}
            elif self.path == '/api/models':
                if not can_read_models:
                    status, data = 403, {'detail': 'Missing permission for models:read'}
                else:
                    data = {'models': [dict(name=name, model=name, display_name=name.title(),
                                            description=f'{name} description', supports_thinking=False,
                                            supports_reasoning_effort=False) for name in models],
                            'token_usage': {'enabled': False}}
            elif self.path.startswith('/api/resources?'):
                data = {'items': [resource] if user == 'A' and 'type=agent' in self.path else [], 'total': 1}
            elif self.path == f'/api/resources/{AGENT}/published':
                data = {'resource': resource, 'version': {'version': 3}, 'dependencies': []}
            elif self.path == '/api/threads/search':
                data = [{'thread_id': 'thread-A', 'status': 'idle', 'metadata': {'agent_name': AGENT}}]
            elif self.path == '/api/threads':
                data = {'thread_id': 'thread-A', 'status': 'idle', 'metadata': body['metadata']}
            elif self.path == '/api/threads/thread-A':
                data = {'thread_id': 'thread-A', 'status': 'idle', 'metadata': {'agent_name': AGENT}}
            elif self.path == '/api/threads/thread-A/state':
                data = {'values': {'messages': []}}
            elif self.path.startswith('/api/threads/thread-A/messages/page'):
                data = {'data': [], 'has_more': False}
            elif self.path.startswith('/api/threads/thread-A/local-tasks?'):
                data = {'tasks': [], 'has_more': False, 'next_offset': None}
            elif self.path == '/api/threads/thread-A/runs':
                if body is None:
                    data = []
                else:
                    context = (body or {}).get('context') or {}
                    name = context.get('model_name')
                    if runs_denied:
                        status, data = 403, {'detail': 'Not allowed here'}
                    elif runs_model_denied and name == MODEL_A:
                        status, data = 403, {'detail': 'Model access denied'}
                    else:
                        data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'running', 'metadata': {}}
            elif self.path == '/api/threads/thread-A/runs/run-1/stream':
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'id: 1\nevent: end\ndata: null\n\n')
                return
            elif self.path == '/api/threads/thread-A/runs/run-1':
                data = {'run_id': 'run-1', 'thread_id': 'thread-A', 'status': 'success', 'metadata': {}}
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


def make_chat(tmp_path, origin, **options):
    from core.platform_chat import DesktopChat
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}, **options), settings, config


def request_header(row, name):
    return next((value for key, value in row[2].items() if key.lower() == name.lower()), None)


def runs_bodies(records):
    return [row[1] for row in records if row[0] == '/api/threads/thread-A/runs' and row[3] == 'POST']


def await_idle(chat, seconds=10):
    until = time.monotonic() + seconds
    state = chat.handle({'action': 'state'})
    while time.monotonic() < until and state['stream'] != 'idle':
        time.sleep(0.01)
        state = chat.handle({'action': 'state'})
    return state


# --- the settings view ------------------------------------------------------

def test_list_projects_the_authorized_rows_without_any_key_field(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        view = chat.models_manage({'action': 'list'})
        assert [row['name'] for row in view['models']] == [MODEL_A, MODEL_B]
        assert set(view['models'][0]) == {'name', 'displayName', 'description', 'supportsThinking'}
        assert view['accountDefault'] == ''
        assert view['fallback'] == ''
        assert view['canRead'] is True
        assert view['reason'] == ''
        assert not any('key' in json.dumps(row).lower() or 'token' in json.dumps(row).lower()
                       for row in view['models'])


def test_list_without_models_read_reports_the_absence_instead_of_rows(tmp_path):
    with platform(can_read_models=False) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        view = chat.models_manage({'action': 'list'})
        assert view['models'] == []
        assert view['canRead'] is False
        assert view['reason']


def test_set_default_writes_the_account_preference_with_the_owner_fence(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        view = chat.models_manage({'action': 'set-default', 'modelName': MODEL_A})
        patches = [row for row in records if row[0] == '/api/v1/auth/preferences' and row[3] == 'PATCH']
        assert len(patches) == 1
        assert patches[0][1] == {'model_name': MODEL_A}
        assert request_header(patches[0], 'X-Expected-User-Id') == 'A'
        assert view['accountDefault'] == MODEL_A
        # The reply is the post-write authoritative view, re-read from the Server.
        assert [row['name'] for row in view['models']] == [MODEL_A, MODEL_B]


def test_set_default_clears_to_the_platform_default(tmp_path):
    with platform(preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        view = chat.models_manage({'action': 'set-default', 'modelName': ''})
        patches = [row for row in records if row[0] == '/api/v1/auth/preferences' and row[3] == 'PATCH']
        assert patches[0][1] == {'model_name': None}
        assert view['accountDefault'] == ''


def test_set_default_refuses_names_outside_the_authorized_list(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.models_manage({'action': 'set-default', 'modelName': 'not-in-list'})
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_set_fallback_is_a_device_local_setting(tmp_path):
    with platform() as (origin, _):
        chat, settings, config = make_chat(tmp_path, origin)
        view = chat.models_manage({'action': 'set-fallback', 'modelName': MODEL_B})
        assert view['fallback'] == MODEL_B
        assert load_settings(config).model_fallback_name == MODEL_B
        view = chat.models_manage({'action': 'set-fallback', 'modelName': ''})
        assert view['fallback'] == ''
        assert load_settings(config).model_fallback_name == ''
        assert load_settings(config).user_id == settings.user_id


def test_set_fallback_refuses_names_outside_the_authorized_list(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.models_manage({'action': 'set-fallback', 'modelName': 'not-in-list'})
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_unknown_action_is_refused(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.models_manage({'action': 'delete-provider'})
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_preference_identity_conflict_surfaces_as_identity_changed(tmp_path):
    with platform(patch_status=409) as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.models_manage({'action': 'set-default', 'modelName': MODEL_A})
        assert 'CHAT_IDENTITY_CHANGED' in str(exc.value)


# --- per-session temporary switching ----------------------------------------

def open_thread(chat):
    scope = chat.handle({'action': 'refresh'})['scope']
    chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
    return scope


def test_set_model_overrides_the_session_and_rides_the_next_send(tmp_path):
    with platform(preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = open_thread(chat)
        state = chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-A',
                             'modelName': MODEL_B})
        assert state['model']['name'] == MODEL_B
        assert state['model']['source'] == 'session-override'
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        sent = runs_bodies(records)[0]
        assert sent['context']['model_name'] == MODEL_B


def test_account_default_applies_to_a_new_session_without_an_override(tmp_path):
    with platform(preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = open_thread(chat)
        state = chat.handle({'action': 'state'})
        assert state['model']['name'] == MODEL_A
        assert state['model']['source'] == 'account-default'
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        assert runs_bodies(records)[0]['context']['model_name'] == MODEL_A


def test_no_selection_omits_model_name_so_the_platform_default_applies(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = open_thread(chat)
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        assert 'model_name' not in runs_bodies(records)[0]['context']


def test_clearing_the_session_override_returns_to_the_account_default(tmp_path):
    with platform(preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = open_thread(chat)
        chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-A', 'modelName': MODEL_B})
        state = chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-A', 'modelName': ''})
        assert state['model']['name'] == MODEL_A
        assert state['model']['source'] == 'account-default'
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        assert runs_bodies(records)[0]['context']['model_name'] == MODEL_A


def test_set_model_for_another_thread_is_refused(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = open_thread(chat)
        state = chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-other',
                             'modelName': MODEL_B})
        assert state['error'] == 'CHAT_THREAD_CHANGED'
        assert chat._session_models == {}


# --- unavailability, fallback switching, and honest display ------------------

def test_delisted_session_model_pauses_sending_with_an_explicit_reason(tmp_path):
    with platform(models=(MODEL_B,), preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = open_thread(chat)
        chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-A', 'modelName': MODEL_A})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        assert state['error'] == 'CHAT_MODEL_UNAVAILABLE'
        assert state['model']['available'] is False
        assert state['model']['reason']
        assert state['model']['notice']
        assert runs_bodies(records) == []


def test_delisted_primary_switches_to_the_authorized_fallback_and_displays_it(tmp_path):
    with platform(models=(MODEL_B,), preferences_model=MODEL_A) as (origin, records):
        chat, _, config = make_chat(tmp_path, origin)
        chat.models_manage({'action': 'set-fallback', 'modelName': MODEL_B})
        scope = open_thread(chat)
        chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-A', 'modelName': MODEL_A})
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        bodies = runs_bodies(records)
        assert len(bodies) == 1
        assert bodies[0]['context']['model_name'] == MODEL_B
        state = await_idle(chat)
        assert state['model']['name'] == MODEL_B
        assert state['model']['switchedFrom'] == MODEL_A
        assert state['model']['notice']
        # The switch is the session's new effective model, never a silent one.
        again = '99999999-9999-4999-8999-999999999999'
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A', 'turnId': again, 'text': 'Again'})
        assert runs_bodies(records)[1]['context']['model_name'] == MODEL_B


def test_fallback_equal_to_the_denied_primary_does_not_switch(tmp_path):
    with platform(runs_model_denied=True, preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.models_manage({'action': 'set-fallback', 'modelName': MODEL_A})
        scope = open_thread(chat)
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        assert state['error'] == 'CHAT_MODEL_UNAVAILABLE'
        assert len(runs_bodies(records)) == 1
        assert state['model']['available'] is False
        assert state['model']['notice']


def test_submission_denial_for_the_model_retries_once_with_the_fallback(tmp_path):
    with platform(runs_model_denied=True, preferences_model=MODEL_A) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.models_manage({'action': 'set-fallback', 'modelName': MODEL_B})
        scope = open_thread(chat)
        chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                     'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        bodies = runs_bodies(records)
        assert [body['context'].get('model_name') for body in bodies] == [MODEL_A, MODEL_B]
        state = await_idle(chat)
        assert state['model']['name'] == MODEL_B
        assert state['model']['switchedFrom'] == MODEL_A
        assert state['model']['notice']


def test_non_model_submission_denial_never_switches(tmp_path):
    with platform(runs_denied=True) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.models_manage({'action': 'set-fallback', 'modelName': MODEL_B})
        scope = open_thread(chat)
        chat.handle({'action': 'set-model', 'scope': scope, 'threadId': 'thread-A', 'modelName': MODEL_A})
        state = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                             'turnId': '88888888-8888-4888-8888-888888888888', 'text': 'Hello'})
        assert state['error'] == 'CHAT_FORBIDDEN'
        assert len(runs_bodies(records)) == 1


def test_model_catalog_refresh_rides_the_chat_refresh(tmp_path):
    with platform() as (origin, _):
        chat, _, _ = make_chat(tmp_path, origin)
        state = chat.handle({'action': 'refresh'})
        assert [row['name'] for row in state['modelOptions']] == [MODEL_A, MODEL_B]
        assert state['model']['available'] is True
