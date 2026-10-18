"""Real HTTP rejection checks against the isolated T98 loopback deployment."""
import concurrent.futures
import http.cookiejar
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from core.protocol import public_key_text

ORIGIN = 'http://127.0.0.1:21980'


def client(account):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    form = urllib.parse.urlencode({'username': account, 'password': account}).encode()
    with opener.open(urllib.request.Request(ORIGIN + '/api/v1/auth/login/local', data=form), timeout=20) as response:
        assert response.status == 200
    return opener, next(cookie.value for cookie in jar if cookie.name == 'csrf_token')


def request(path, body=None, authenticated=None):
    opener = authenticated[0] if authenticated else urllib.request.build_opener(urllib.request.ProxyHandler({}))
    headers = {'Content-Type': 'application/json', 'Origin': ORIGIN}
    if authenticated:
        headers['X-CSRF-Token'] = authenticated[1]
    data = json.dumps(body).encode() if body is not None else None
    try:
        response = opener.open(urllib.request.Request(ORIGIN + path, data=data, headers=headers), timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read())


def start():
    payload = {'initiator_secret': secrets.token_urlsafe(32), 'public_key': public_key_text(Ed25519PrivateKey.generate())}
    status, value = request('/api/devices/login/start', {**payload, 'name': 'T98-rejections-' + secrets.token_hex(6)})
    assert status == 200
    return '/api/devices/login/' + value['login_id'], payload


def denied(response, status, code):
    actual_status, body = response
    assert actual_status == status, (actual_status, status)
    assert isinstance(body.get('detail'), dict), body
    assert body['detail']['code'] == code
    return {'status': status, 'code': code}


started = time.monotonic()
expiry_path, expiry_payload = start()
expires_after = time.monotonic() + 301
owner, other = client('user98a@test.com'), client('user98b@test.com')
status, before = request('/api/devices', authenticated=owner)
assert status == 200
path, payload = start()
checks = {}
checks['wrong_initiator'] = denied(request(path + '/complete', {**payload, 'initiator_secret': secrets.token_urlsafe(32)}), 401, 'LOGIN_BINDING_INVALID')
checks['wrong_device_key'] = denied(request(path + '/complete', {**payload, 'public_key': public_key_text(Ed25519PrivateKey.generate())}), 401, 'LOGIN_BINDING_INVALID')
status, body = request(path + '/complete', payload)
assert status == 202 and 'token' not in json.dumps(body)
assert request(path + '/confirm', {'confirm_own_device': False}, owner)[0] == 400
status, body = request(path + '/confirm', {'confirm_own_device': True}, owner)
assert status == 200 and 'token' not in json.dumps(body)
checks['wrong_confirmed_owner'] = denied(request(path, authenticated=other), 403, 'LOGIN_OWNER_MISMATCH')
checks['wrong_owner_confirmation'] = denied(request(path + '/confirm', {'confirm_own_device': True}, other), 403, 'LOGIN_OWNER_MISMATCH')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    responses = list(pool.map(lambda _: request(path + '/complete', payload), range(2)))
assert sorted(status for status, _ in responses) == [200, 409]
winner = next(body for status, body in responses if status == 200)
assert winner['business_token'] != winner['session_token']
status, after = request('/api/devices', authenticated=owner)
assert status == 200 and len(after) == len(before) + 1
assert winner['device']['owner_id'] == winner['account']['id']
checks['concurrent_completion'] = {'statuses': [200, 409], 'new_devices': 1}
checks['replay'] = denied(request(path + '/complete', payload), 409, 'LOGIN_ALREADY_USED')
# This is wall-clock expiry on the real deployment; no Server clock is replaced.
print(json.dumps({'stage': 'negative-and-concurrent-checks-passed', 'waitingForRealTTLSeconds': max(0, round(expires_after - time.monotonic()))}), flush=True)
while time.monotonic() < expires_after:
    time.sleep(min(1, expires_after - time.monotonic()))
checks['expired_confirmation'] = denied(request(expiry_path + '/confirm', {'confirm_own_device': True}, owner), 410, 'LOGIN_EXPIRED')
checks['expired_completion'] = denied(request(expiry_path + '/complete', expiry_payload), 410, 'LOGIN_EXPIRED')
print(json.dumps({'scenario': 'T98-02', 'result': 'passed', 'elapsedSeconds': round(time.monotonic() - started, 2), 'checks': checks}))
