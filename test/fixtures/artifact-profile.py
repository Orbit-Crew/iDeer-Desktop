"""Disposable OS credentials for the real bundled Runtime download boundary."""
import base64
import json
import sys
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from core.protocol import public_key_text
from core.secrets import SecretNotFound, WindowsCredentialStore
from core.settings import RuntimeSettings

action, profile = sys.argv[1], Path(sys.argv[2])
refs_file = profile / 'test-secret-refs.json'
store = WindowsCredentialStore()
if action == 'prepare':
    fixture = json.loads(sys.stdin.read())
    key = Ed25519PrivateKey.generate()
    prefix = 'artifact-test-' + uuid.uuid4().hex
    refs = [prefix + '-' + name for name in ('business', 'device', 'key')]
    refs_file.write_text(json.dumps(refs))
    store.set(refs[0], 'artifact-business-test')
    store.set(refs[1], 'artifact-device-test')
    store.set(refs[2], base64.b64encode(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
    RuntimeSettings(server_url=fixture['origin'], user_id='artifact-user', user_name='artifact@example.invalid',
        device_id='artifact-D2', device_name='Artifact test D2', device_public_key=public_key_text(key),
        server_public_key=public_key_text(Ed25519PrivateKey.generate()), session_id='artifact-session',
        business_token_ref=refs[0], business_expires_at='2099-01-01T00:00:00+00:00',
        session_token_ref=refs[1], device_key_ref=refs[2]).save(profile / 'settings.json')
elif action == 'cleanup':
    for ref in json.loads(refs_file.read_text()) if refs_file.exists() else []:
        try:
            store.delete(ref)
        except SecretNotFound:
            pass  # A real switch-account already retires these fixture credentials.
else:
    raise SystemExit('unknown action')
