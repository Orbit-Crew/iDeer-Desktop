"""T98-03: real CredWrite failure at the OS boundary, no plaintext fallback."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import urllib.parse
import urllib.request
import uuid

from core.browser_login import BrowserLogin, platform_origin
from core.secrets import SecretBackendUnavailable, SecretNotFound, WindowsCredentialStore

parser = argparse.ArgumentParser()
parser.add_argument('--origin', default='http://127.0.0.1:21980')
parser.add_argument('--profile', required=True, type=Path)
args = parser.parse_args()
origin = platform_origin(args.origin)
if urllib.parse.urlsplit(origin).hostname not in {'127.0.0.1', 'localhost', '::1'}:
    raise SystemExit('This fixture is restricted to the isolated loopback deployment')
args.profile.mkdir(parents=True, exist_ok=False)
config = args.profile / 'settings.json'


class RejectedWriteStore(WindowsCredentialStore):
    attempted = ''

    def set(self, name, value):
        self.attempted = name
        # Force the real Windows API to reject its blob-size limit. No OS
        # configuration, credentials or global security policy is modified.
        super().set(name, 'T98-OS-WRITE-FAILURE-' * 1024)


secure = RejectedWriteStore()
login = BrowserLogin(config, secure)
browser = login.begin(origin, 'T98-storage-failure-' + uuid.uuid4().hex[:12])
login_id = urllib.parse.parse_qs(urllib.parse.urlsplit(browser).query)['login_id'][0]
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
form = urllib.parse.urlencode({'username': 'user98a@test.com', 'password': 'user98a@test.com'}).encode()
with opener.open(urllib.request.Request(origin + '/api/v1/auth/login/local', data=form), timeout=20) as response:
    assert response.status == 200
csrf = next(cookie.value for cookie in jar if cookie.name == 'csrf_token')
request = urllib.request.Request(origin + f'/api/devices/login/{login_id}/confirm',
    data=b'{"confirm_own_device":true}', headers={'Content-Type': 'application/json', 'Origin': origin, 'X-CSRF-Token': csrf})
with opener.open(request, timeout=20) as response:
    assert response.status == 200
try:
    login.poll()
except SecretBackendUnavailable as error:
    assert error.code == 'SECRET_BACKEND_UNAVAILABLE'
else:
    raise AssertionError('The real Windows credential write must fail')
assert login.status()['error'] == 'SECURE_STORAGE_FAILED'
assert not config.exists()
assert list(args.profile.iterdir()) == []
try:
    secure.get(secure.attempted)
except SecretNotFound:
    pass
else:
    raise AssertionError('The rejected credential must not exist in the OS store')
print(json.dumps({'scenario': 'T98-03', 'result': 'passed', 'fault': 'real CredWrite blob-size rejection',
                  'error': login.status()['error'], 'plaintextFallbackFiles': 0, 'storedCredentials': 0}))
