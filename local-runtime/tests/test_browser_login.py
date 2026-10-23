"""Runtime login uses public HTTP boundaries and OS secure storage."""
import json
import threading
import subprocess
import sys
from datetime import datetime, timezone
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core.browser_login import BrowserLogin
from core import browser_login
from core.secrets import InMemorySecretStore, SecretBackendUnavailable
from core.settings import RuntimeSettings, load_settings


@contextmanager
def platform(*, device_status='offline'):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            result = {'id': 'user-A', 'email': 'Test A'} if self.path == '/api/v1/auth/me' else {
                'id': 'D1', 'owner_id': 'user-A', 'status': device_status}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append((self.path, body))
            if self.path == '/api/devices/login/start':
                result = {'login_id': 'login-98', 'expires_in': 300}
            else:
                result = {
                    'account': {'id': 'user-A', 'name': 'Test A'},
                    'device': {'id': 'D1', 'name': 'Desktop D1', 'owner_id': 'user-A'},
                    'business_token': 'isolated-business-secret',
                    'session_token': 'isolated-device-secret', 'session_id': 'session-D1',
                    'server_public_key': 'isolated-broker-key',
                    'business_expires_at': '2099-01-01T00:00:00+00:00',
                }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', received
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def test_runtime_exchanges_then_stores_separate_credentials_without_renderer_secrets(tmp_path):
    secure = InMemorySecretStore()
    config = tmp_path / 'settings.json'
    with platform() as (origin, received):
        login = BrowserLogin(config, secure)
        browser = login.begin(origin, 'Desktop D1')
        assert browser == origin + '/desktop-login?login_id=login-98'
        assert not config.exists()
        assert login.status()['state'] == 'awaiting-confirmation'
        assert login.poll() is True
        status = login.status()
        assert status['state'] == 'authenticated'
        assert status['account'] == 'Test A'
        assert status['device'] == 'Desktop D1'
        settings = load_settings(config)
        assert settings.device_id == 'D1'
        assert secure.get(settings.session_token_ref) == 'isolated-device-secret'
        assert secure.get(settings.business_token_ref) == 'isolated-business-secret'
        assert settings.websocket_url() == origin.replace('http:', 'ws:') + '/api/devices/ws'
        visible = json.dumps(status) + config.read_text() + browser
        assert 'isolated-business-secret' not in visible
        assert 'isolated-device-secret' not in visible
        assert received[0][1]['initiator_secret'] == received[1][1]['initiator_secret']
        assert login.begin(origin, 'Desktop D1') == browser
        assert received[-1][1]['existing_device_id'] == 'D1'
        assert login.poll() is True
        assert received[-1][1]['device_proof']


@pytest.mark.parametrize('origin', ['http://official.example', 'https://user:password@example.com',
                                   'https://example.com/api', 'https://example.com?token=x', 'file:///tmp'])
def test_login_rejects_noncanonical_or_insecure_entry(origin, tmp_path):
    with pytest.raises(ValueError, match='LOGIN_ORIGIN_INVALID'):
        BrowserLogin(tmp_path / 'settings.json', InMemorySecretStore()).begin(origin, 'D1')


def test_secure_store_failure_is_visible_and_never_saves_plaintext(tmp_path):
    class Unavailable(InMemorySecretStore):
        def set(self, name, value):
            raise SecretBackendUnavailable('SECRET_BACKEND_UNAVAILABLE')

    config = tmp_path / 'settings.json'
    with platform() as (origin, _):
        login = BrowserLogin(config, Unavailable())
        login.begin(origin, 'D1')
        with pytest.raises(SecretBackendUnavailable):
            login.poll()
        assert login.status()['error'] == 'SECURE_STORAGE_FAILED'
        assert not config.exists()
        assert list(tmp_path.iterdir()) == []


def test_business_session_expiry_is_visible_without_claiming_device_online(tmp_path, monkeypatch):
    with platform() as (origin, _):
        login = BrowserLogin(tmp_path / 'settings.json', InMemorySecretStore())
        login.begin(origin, 'D1')
        login.poll()

        class FutureClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2099, 1, 1, tzinfo=timezone.utc)

        monkeypatch.setattr(browser_login, 'datetime', FutureClock)
        assert login.status()['state'] == 'expired'
        assert login.status()['error'] == 'LOGIN_EXPIRED'


def test_logout_persists_until_explicit_relogin_and_switch_uses_new_device(tmp_path):
    secure = InMemorySecretStore()
    config = tmp_path / 'settings.json'
    with platform() as (origin, received):
        login = BrowserLogin(config, secure)
        login.begin(origin, 'D1')
        login.poll()
        device_key = load_settings(config).device_public_key
        login.logout()
        assert login.status()['state'] == 'unauthenticated'
        assert load_settings(config).signed_out is True
        reopened = BrowserLogin(config, secure)
        reopened.restore()
        assert reopened.status()['state'] == 'unauthenticated'
        reopened.begin(origin, 'D1')
        assert received[-1][1]['existing_device_id'] == 'D1'
        assert received[-1][1]['public_key'] == device_key
        assert reopened.poll()
        assert not load_settings(config).signed_out
        reopened.logout(forget_device=True)
        reopened.begin(origin, 'D2')
        assert received[-1][1]['existing_device_id'] is None
        assert received[-1][1]['public_key'] != device_key


@pytest.mark.parametrize('device_status', ['pending', 'offline', 'revoked', 'blocked'])
def test_restore_requires_an_active_server_device_binding(tmp_path, device_status):
    with platform(device_status=device_status) as (origin, _):
        config, secure = tmp_path / 'settings.json', InMemorySecretStore()
        login = BrowserLogin(config, secure)
        login.begin(origin, 'D1')
        login.poll()
        reopened = BrowserLogin(config, secure)
        if device_status in {'pending', 'offline'}:
            reopened.restore()
            assert reopened.status()['state'] == 'authenticated'
        else:
            with pytest.raises(ValueError, match='DEVICE_BINDING_INVALID'):
                reopened.restore()
            assert reopened.status()['state'] != 'authenticated'


@pytest.mark.parametrize('business_ref,state', [('missing-business', 'expired'), ('', 'unauthenticated')])
@pytest.mark.skipif(sys.platform != 'win32', reason='Uses the real Windows Credential Manager')
def test_unauthenticated_profile_never_starts_executable_device_connection(tmp_path, business_ref, state):
    config = tmp_path / 'settings.json'
    RuntimeSettings(server_url='https://official.example', device_id='D1', device_name='D1',
                    business_token_ref=business_ref, business_expires_at='2000-01-01T00:00:00+00:00',
                    device_key_ref='missing-key', session_token_ref='missing-device', server_public_key='pinned').save(config)
    # Give a live process time to publish status before sending shutdown.
    child = subprocess.Popen([sys.executable, '-u', '-m', 'core.desktop', '--config', str(config)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        value = json.loads(child.stdout.readline())
        assert value['connection'] == 'offline'
        assert value['login']['state'] == state
    finally:
        if child.poll() is None:
            child.communicate('{"type":"shutdown"}\n', timeout=15)
        assert child.returncode == 0
