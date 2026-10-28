"""Server-side Skill trigger preference configuration from the device (#121).

Every test drives the real DesktopChat seam against a protocol fixture: the
Desktop relays the account's own preference documents to the Server endpoints
and projects the Server's bounded reply. Matching never happens here — no
keyword evaluation, no model driving — and every wire field is validated and
bounded before it leaves the process.
"""
from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from core.platform_chat import DesktopChat
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings

RESOURCE = '77777777-7777-4777-8777-777777777777'
AGENT = '11111111-1111-4111-8111-111111111111'

LISTING = {
    'items': [
        {
            'skill_resource_id': RESOURCE,
            'enabled': True,
            'keywords': ['weekly report'],
            'always_inject': False,
            'applicable_agent_ids': [AGENT],
            'priority': 3,
            'skill': {'slug': 'report-skill', 'display_name': 'Report skill', 'latest_version': 2, 'available': True},
        }
    ],
    'total': 1,
}


@contextmanager
def platform(preference_status=204, preference_body=b''):
    records = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            records.append((self.command, self.path, None))
            self.respond(LISTING)

        def do_PUT(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            records.append((self.command, self.path, json.loads(body) if body else None))
            self.send_response(preference_status)
            self.send_header('Content-Length', str(len(preference_body)))
            self.end_headers()
            if preference_body:
                self.wfile.write(preference_body)

        def do_DELETE(self):
            records.append((self.command, self.path, None))
            self.send_response(preference_status)
            self.send_header('Content-Length', str(len(preference_body)))
            self.end_headers()
            if preference_body:
                self.wfile.write(preference_body)

        def respond(self, data):
            payload = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}', records
    finally:
        server.shutdown()
        server.server_close()


def prepare(tmp_path: Path, origin: str, *, authenticated=True):
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-121', server_public_key='broker-key-121',
        session_token_ref='device-session-121',
        business_token_ref='business-A' if authenticated else None,
        business_expires_at='2099-01-01T00:00:00+00:00' if authenticated else None)
    settings.save(config)

    def login_status():
        return {'state': 'authenticated' if authenticated else 'unauthenticated'}

    return DesktopChat(config, secure, login_status)


def test_list_projects_the_server_rows_into_the_desktop_shape(tmp_path):
    with platform() as (origin, records):
        chat = prepare(tmp_path, origin)
        view = chat.skill_preferences({'action': 'list'})
        assert [row['skillId'] for row in view['skills']] == [RESOURCE]
        row = view['skills'][0]
        assert row == {'skillId': RESOURCE, 'slug': 'report-skill', 'displayName': 'Report skill',
                       'latestVersion': 2, 'available': True, 'enabled': True,
                       'keywords': ['weekly report'], 'alwaysInject': False,
                       'applicableAgentIds': [AGENT], 'priority': 3}
        assert [(method, path) for method, path, _body in records] == [('GET', '/api/resources/skill-trigger-preferences')]


def test_set_relays_documented_fields_and_returns_the_refreshed_projection(tmp_path):
    with platform() as (origin, records):
        chat = prepare(tmp_path, origin)
        command = {'action': 'set', 'skillId': RESOURCE, 'enabled': True, 'keywords': ['  Report '],
                   'alwaysInject': True, 'applicableAgentIds': [AGENT], 'priority': -2}
        view = chat.skill_preferences(command)
        assert [row['priority'] for row in view['skills']] == [3]
        put = [(path, body) for method, path, body in records if method == 'PUT']
        assert len(put) == 1 and put[0][0] == f'/api/resources/{RESOURCE}/trigger-preference'
        assert put[0][1] == {'enabled': True, 'keywords': ['Report'], 'always_inject': True,
                             'applicable_agent_ids': [AGENT], 'priority': -2}


def test_clear_issues_delete_and_refreshes(tmp_path):
    with platform() as (origin, records):
        chat = prepare(tmp_path, origin)
        chat.skill_preferences({'action': 'clear', 'skillId': RESOURCE})
        assert [(method, path) for method, path, _body in records] == [
            ('DELETE', f'/api/resources/{RESOURCE}/trigger-preference'),
            ('GET', '/api/resources/skill-trigger-preferences')]


def test_invalid_commands_are_refused_before_any_wire_traffic(tmp_path):
    with platform() as (origin, _records):
        chat = prepare(tmp_path, origin)
        for command in [
            {'action': 'inject'},
            {'action': 'set', 'skillId': 'nope', 'enabled': True, 'keywords': [], 'alwaysInject': False,
             'applicableAgentIds': [], 'priority': 0},
            {'action': 'set', 'skillId': RESOURCE, 'enabled': True, 'keywords': [], 'alwaysInject': False,
             'applicableAgentIds': ['bad'], 'priority': 0},
            {'action': 'set', 'skillId': RESOURCE, 'enabled': True, 'keywords': [], 'alwaysInject': False,
             'applicableAgentIds': [], 'priority': 1001},
            {'action': 'set', 'skillId': RESOURCE, 'enabled': True, 'keywords': [], 'alwaysInject': False,
             'applicableAgentIds': [], 'priority': True},
            {'action': 'clear', 'skillId': 'not-even-try'},
        ]:
            from core.platform_chat import ChatError
            with pytest.raises(ChatError) as caught:
                chat.skill_preferences(command)
            assert str(caught.value) == 'CHAT_COMMAND_INVALID'


def test_server_rejections_map_to_fixed_categories(tmp_path):
    from core.platform_chat import ChatError
    with platform(preference_status=404, preference_body=b'{"detail":"Resource not found"}') as (origin, _records):
        chat = prepare(tmp_path, origin)
        with pytest.raises(ChatError) as caught:
            chat.skill_preferences({'action': 'set', 'skillId': RESOURCE, 'enabled': True, 'keywords': ['k'],
                                    'alwaysInject': False, 'applicableAgentIds': [], 'priority': 0})
        assert str(caught.value) == 'CHAT_NOT_FOUND'
    # A non-204 success on the write path is a protocol error, never silently
    # accepted (http.client never surfaces a body on real 204s, so the honest
    # drift to model here is a wrong status).
    with platform(preference_status=200, preference_body=b'{}') as (origin, _records):
        chat = prepare(tmp_path, origin)
        with pytest.raises(ChatError) as caught:
            chat.skill_preferences({'action': 'clear', 'skillId': RESOURCE})
        assert str(caught.value) == 'CHAT_PROTOCOL_ERROR'


def test_unauthenticated_configuration_is_refused(tmp_path):
    from core.platform_chat import ChatError
    with platform() as (origin, records):
        chat = prepare(tmp_path, origin, authenticated=False)
        with pytest.raises(ChatError) as caught:
            chat.skill_preferences({'action': 'list'})
        assert str(caught.value) == 'CHAT_UNAUTHENTICATED'
        assert records == []
