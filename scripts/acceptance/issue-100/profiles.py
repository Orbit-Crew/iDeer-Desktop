"""Create paired synthetic Windows profiles, and remove only their own secrets."""
import base64
from datetime import datetime, timezone
import http.cookiejar
import json
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from core.protocol import public_key_text
from core.secrets import create_default_secret_store
from core.settings import RuntimeSettings

action, directory, *extra = sys.argv[1:]
state = Path(directory).resolve(strict=True)
manifest_path = state / 'ready.json'
manifest = json.loads(manifest_path.read_text())
secure = create_default_secret_store()
ledger = state / 'credential-references.json'


def client(label):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    email = manifest['identities'][label]['email']
    assert email == f't100-{label.lower()}@test.com'
    request = urllib.request.Request(manifest['origin'] + '/api/v1/auth/login/local',
        data=urllib.parse.urlencode({'username': email, 'password': email}).encode(),
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with opener.open(request, timeout=30) as response:
        response.read(65536)
    return opener, next(cookie.value for cookie in jar if cookie.name == 'access_token')


def api(opener, token, route, body=None):
    csrf = uuid.uuid4().hex
    request = urllib.request.Request(manifest['origin'] + route,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Cookie': f'access_token={token}; csrf_token={csrf}', 'X-CSRF-Token': csrf,
            'Origin': manifest['origin'], 'Content-Type': 'application/json'})
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read(2 * 1024 * 1024))


if action == 'prepare':
    if ledger.exists():
        raise SystemExit('FRESH_FIXTURE_REQUIRED')
    references = []

    def remember(value):
        reference = 't100-' + uuid.uuid4().hex
        references.append(reference)
        ledger.write_text(json.dumps(references))
        secure.set(reference, value)
        return reference

    try:
        for label, identity in manifest['identities'].items():
            opener, token = client(label)
            private = Ed25519PrivateKey.generate()
            public = public_key_text(private)
            challenge = api(opener, token, '/api/devices/pairing', {})
            registered = api(opener, token, '/api/devices/register', {'pairing_code': challenge['code'],
                'name': 'T100 isolated device ' + label, 'public_key': public, 'protocol_version': '1',
                'runtime_version': '0.1.0', 'capabilities': ['local.files.list', 'local.files.read', 'local.files.search']})
            device = registered['device']['id']
            api(opener, token, f"/api/devices/pairing/{challenge['pairing_id']}/confirm", {'code': challenge['code']})
            completed = api(opener, token, '/api/devices/register/complete', {'device_id': device,
                'public_key': public, 'claim_token': registered['claim_token']})
            encoded = token.split('.')[1]
            expiry = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))['exp']
            pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption())
            profile = state / ('profile-' + label) / 'settings.json'
            RuntimeSettings(server_url=manifest['origin'], user_id=identity['id'], user_name=identity['email'],
                business_token_ref=remember(token), business_expires_at=datetime.fromtimestamp(expiry, timezone.utc).isoformat(),
                device_name='T100 isolated device ' + label, device_id=device, session_id=completed['session_id'],
                session_token_ref=remember(completed['session_token']), device_key_ref=remember(base64.b64encode(pem).decode()),
                server_public_key=completed['server_public_key']).save(profile)
            identity.update(profile=str(profile), deviceId=device)
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({'prepared': len(references)}))
    except BaseException:
        for reference in references:
            secure.delete(reference)
        raise
elif action == 'cleanup':
    references = json.loads(ledger.read_text()) if ledger.exists() else []
    for reference in references:
        assert reference.startswith('t100-') and len(reference) == 37
        secure.delete(reference)
    result = {'removed': len(references), 'failures': []}
    (state / 'credential-cleanup.json').write_text(json.dumps(result))
    print(json.dumps(result))
elif action in {'api', 'evidence'}:
    label = extra.pop(0) if extra else 'A'
    settings = json.loads(Path(manifest['identities'][label]['profile']).read_text())
    token = secure.get(settings['business_token_ref'])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if action == 'api':
        route = extra[0]
        body = json.loads(extra[1]) if len(extra) > 1 else None
        try:
            result = {'status': 200, 'body': api(opener, token, route, body)}
        except urllib.error.HTTPError as error:
            result = {'status': error.code, 'body': json.loads(error.read(65536))}
            error.close()
        print(json.dumps(result))
    else:
        rows = []
        for thread in api(opener, token, '/api/threads/search', {'limit': 100}):
            for run in api(opener, token, f"/api/threads/{thread['thread_id']}/runs"):
                detail = api(opener, token, f"/api/threads/{thread['thread_id']}/runs/{run['run_id']}")
                messages = api(opener, token, f"/api/runs/{run['run_id']}/messages?limit=200")
                rows.append({'threadId': thread['thread_id'], 'runId': run['run_id'], 'status': run['status'],
                    'metadata': detail.get('metadata', {}), 'runEvidence': detail.get('run_evidence'),
                    'toolReceipts': [r['content']['additional_kwargs']['deerflow_tool_receipt']
                        for r in messages['data'] if isinstance(r.get('content'), dict)
                        and r['content'].get('additional_kwargs', {}).get('deerflow_tool_receipt')]})
        (state / ('run-evidence-' + label + '.json')).write_text(json.dumps(rows, indent=2))
        print(json.dumps({'runs': len(rows)}))
else:
    raise SystemExit('INVALID_ACTION')
