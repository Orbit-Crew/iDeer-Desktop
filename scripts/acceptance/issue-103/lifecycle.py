"""Real Server lifecycle operations restricted to fixture-created identities."""
import http.cookiejar
import json
from pathlib import Path
import sys
import urllib.request
import urllib.parse
import urllib.error
import uuid

from core.browser_login import BrowserLogin
from core.secrets import create_default_secret_store, SecretNotFound
from core.settings import load_settings

action, state_text, config_text, *arguments = sys.argv[1:]
state, config = Path(state_text).resolve(strict=True), Path(config_text).resolve(strict=True)
manifest = json.loads((state / 'ready.json').read_text())
if not (config.parent / '.issue102-owner').is_file():
    raise SystemExit('ISOLATED_PROFILE_REQUIRED')
label = arguments.pop(0)
email = manifest['identities'][label]['email']
assert email == f't100-{label.lower()}@test.com'
if action == 'cleanup':
    secure = create_default_secret_store()
    references = json.loads((state / 'credential-references.json').read_text())
    removed, retired = 0, 0
    for reference in references:
        assert reference.startswith(('t100-', 'desktop-'))
        try:
            secure.delete(reference)
            removed += 1
        except SecretNotFound:
            retired += 1
    print(json.dumps({'removed': removed, 'alreadyRetiredByLogoutOrRotation': retired}))
    raise SystemExit(0)
if action == 'observe':
    settings = load_settings(config)
    print(json.dumps({'signedOut': settings.signed_out, 'userId': settings.user_id,
        'deviceId': settings.device_id, 'grants': settings.directory_grants}))
    raise SystemExit(0)
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
request = urllib.request.Request(manifest['origin'] + '/api/v1/auth/login/local',
    data=urllib.parse.urlencode({'username': email, 'password': email}).encode(),
    headers={'Content-Type': 'application/x-www-form-urlencoded'})
with opener.open(request, timeout=30) as response:
    response.read(65536)
token = next(cookie.value for cookie in jar if cookie.name == 'access_token')


def api(route, body=None, *, post=False):
    csrf = uuid.uuid4().hex
    request = urllib.request.Request(manifest['origin'] + route,
        data=json.dumps(body).encode() if body is not None else None,
        method='POST' if post else None,
        headers={'Cookie': f'access_token={token}; csrf_token={csrf}', 'X-CSRF-Token': csrf,
            'Origin': manifest['origin'], 'Content-Type': 'application/json'})
    try:
        with opener.open(request, timeout=30) as response:
            raw = response.read(2 * 1024 * 1024)
            return {'status': response.status, 'body': json.loads(raw) if raw else None}
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'body': json.loads(error.read(65536))}


settings = load_settings(config)
if action == 'login':
    before = [settings.user_id, settings.device_id, settings.device_public_key]
    old_session = settings.session_id
    login = BrowserLogin(config, create_default_secret_store())
    url = login.begin(manifest['origin'], 'T103 rebound ' + label)
    login_id = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['login_id'][0]
    confirmed = api('/api/devices/login/' + login_id + '/confirm', {'confirm_own_device': True}, post=True)
    assert confirmed['status'] == 200, confirmed
    assert login.poll()
    settings = load_settings(config)
    ledger_path = state / 'credential-references.json'
    references = json.loads(ledger_path.read_text())
    references.extend([settings.device_key_ref, settings.business_token_ref, settings.session_token_ref])
    ledger_path.write_text(json.dumps(list(dict.fromkeys(references))))
    print(json.dumps({'authenticated': login.status()['state'] == 'authenticated',
        'bindingUnchanged': before == [settings.user_id, settings.device_id, settings.device_public_key],
        'sessionChanged': old_session != settings.session_id, 'userId': settings.user_id,
        'deviceId': settings.device_id, 'grantIds': [r['id'] for r in settings.directory_grants]}))
elif action in {'api', 'api-post'}:
    route = arguments[0]
    body = json.loads(arguments[1]) if len(arguments) > 1 else None
    print(json.dumps(api(route, body, post=action == 'api-post')))
else:
    raise SystemExit('INVALID_ACTION')
