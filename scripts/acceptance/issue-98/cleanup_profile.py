"""Remove only the three OS credential references of an explicit T98 fixture."""
import argparse
import json
from pathlib import Path
import re

from core.secrets import SecretNotFound, create_default_secret_store

parser = argparse.ArgumentParser()
parser.add_argument('--profile', required=True, type=Path)
args = parser.parse_args()
profile = args.profile.resolve(strict=True)
assert profile.name.startswith('runtime-profile-'), 'Only the generated T98 Runtime fixture is accepted'
config = profile / 'settings.json'
if not config.exists():
    print(json.dumps({'profile': profile.name, 'referencesDeleted': 0, 'settingsAbsent': True}))
    raise SystemExit(0)
settings = json.loads(config.read_text(encoding='utf-8'))
assert settings['server_url'] == 'http://127.0.0.1:21980'
assert settings['device_name'].startswith('T98-D1-')
assert settings['session_token'] == ''
references = [settings['device_key_ref'], settings['session_token_ref'], settings['business_token_ref']]
assert len(set(references)) == 3
assert all(re.fullmatch(r'desktop-[a-f0-9]{32}-(device-key|device-session|business-session)', ref) for ref in references)
store = create_default_secret_store()
for reference in references:
    try:
        store.delete(reference)
    except SecretNotFound:
        pass
for reference in references:
    try:
        store.get(reference)
    except SecretNotFound:
        continue
    raise AssertionError('Fixture credential cleanup failed')
print(json.dumps({'profile': profile.name, 'referencesDeleted': 3, 'settingsContainReferencesOnly': True}))
