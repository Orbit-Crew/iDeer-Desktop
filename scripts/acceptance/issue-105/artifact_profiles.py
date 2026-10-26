"""Real owner/device artifact operations for isolated cross-repository acceptance."""
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from core.protocol import public_key_text
from core.secrets import create_default_secret_store
from core.settings import RuntimeSettings, load_settings

action, directory, label, *args = sys.argv[1:]
state = Path(directory).resolve(strict=True)
manifest_path = state / 'ready.json'
manifest = json.loads(manifest_path.read_text())
secure = create_default_secret_store()
identity = manifest['identities'][label]
settings = load_settings(identity['profile'])
token = secure.get(settings.business_token_ref)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(route, body=None, *, device=False, binary=False):
    csrf = uuid.uuid4().hex
    headers = {'Cookie': f'access_token={token}; csrf_token={csrf}', 'X-CSRF-Token': csrf,
               'Origin': manifest['origin'], 'Content-Type': 'application/json'}
    if device:
        headers['X-Device-Session'] = secure.get(settings.session_token_ref)
    req = urllib.request.Request(manifest['origin'] + route, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with opener.open(req, timeout=30) as response:
            raw = response.read(2 * 1024 * 1024)
            return {'status': response.status, 'body':
                {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                 'echoSHA256': response.headers.get('X-Content-SHA256')} if binary else json.loads(raw)}
    except urllib.error.HTTPError as error:
        with error:
            return {'status': error.code, 'body': json.loads(error.read(65536))}


if action == 'pair-secondary':
    if 'A2' in manifest['identities']:
        raise SystemExit('FRESH_SECONDARY_DEVICE_REQUIRED')
    key = Ed25519PrivateKey.generate()
    public = public_key_text(key)
    challenge = request('/api/devices/pairing', {})
    assert challenge['status'] in {200, 201}, challenge
    challenge = challenge['body']
    registered = request('/api/devices/register', {'pairing_code': challenge['code'],
        'name': 'T105 isolated second device', 'public_key': public, 'protocol_version': '1',
        'runtime_version': '0.1.0', 'capabilities': []})
    assert registered['status'] in {200, 201}, registered
    registered = registered['body']
    device_id = registered['device']['id']
    confirmed = request(f"/api/devices/pairing/{challenge['pairing_id']}/confirm", {'code': challenge['code']})
    assert confirmed['status'] in {200, 201}, confirmed
    completed = request('/api/devices/register/complete', {'device_id': device_id,
        'public_key': public, 'claim_token': registered['claim_token']})
    assert completed['status'] in {200, 201}, completed
    completed = completed['body']
    ledger = state / 'credential-references.json'
    references = json.loads(ledger.read_text())

    def remember(value):
        ref = 't100-' + uuid.uuid4().hex
        references.append(ref)
        ledger.write_text(json.dumps(references))
        secure.set(ref, value)
        return ref

    profile = state / 'profile-A2' / 'settings.json'
    RuntimeSettings(server_url=manifest['origin'], user_id=settings.user_id, user_name=settings.user_name,
        business_token_ref=settings.business_token_ref, business_expires_at=settings.business_expires_at,
        device_id=device_id, device_name='T105 isolated second device', device_public_key=public,
        session_id=completed['session_id'], session_token_ref=remember(completed['session_token']),
        device_key_ref=remember(base64.b64encode(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode()),
        server_public_key=completed['server_public_key']).save(profile)
    secondary = dict(identity, deviceId=device_id, profile=str(profile))
    manifest['identities']['A2'] = secondary
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(json.dumps(secondary))
elif action == 'download':
    thread_id, artifact_id = args
    print(json.dumps(request(f'/api/threads/{thread_id}/artifacts/{artifact_id}/download', binary=True)))
elif action == 'revoke':
    print(json.dumps(request(f'/api/devices/{settings.device_id}/revoke', {})))
elif action == 'grant':
    thread_id, serialized = args
    print(json.dumps(request(f'/api/threads/{thread_id}/artifacts/grant', json.loads(serialized), device=True)))
else:
    raise SystemExit('INVALID_ACTION')
