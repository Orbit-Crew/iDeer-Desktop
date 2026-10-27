"""Delete only this fresh human-test profile's generated OS credential refs."""
import json
from pathlib import Path
import sys
from core.browser_login import BrowserLogin
from core.secrets import create_default_secret_store

action, directory = sys.argv[1:]
assert action == 'cleanup'
state = Path(directory).resolve(strict=True)
assert state.parts[-3] == 'issue-111' and state.parts[-1] == 'desktop' and state.parts[-2] in {'human-login', 'human-login-2'}
config = state / 'provider-user-data/Runtime/settings.json'
references = []
if config.exists():
    settings = json.loads(config.read_text())
    for key in ['business_token_ref', 'session_token_ref', 'device_key_ref']:
        reference = settings.get(key)
        if reference:
            assert reference.startswith('desktop-')
            references.append(reference)
    login = BrowserLogin(config, create_default_secret_store())
    login.logout(forget_device=True)
    assert not login.status().get('error'), login.status()
result = {'removed': len(references), 'failures': [], 'method': 'BrowserLogin.logout(forget_device=True) on task-owned fresh profile'}
(state / 'credential-cleanup.json').write_text(json.dumps(result))
print(json.dumps(result))
