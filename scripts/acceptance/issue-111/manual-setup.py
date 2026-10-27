"""Initialize only the fresh fixture via official API, preserving regular A/B."""
import json
from pathlib import Path
import sys
import urllib.request

state = Path(sys.argv[1]).resolve(strict=True)
assert state.parts[-3] == 'issue-111' and state.parts[-1] == 'desktop' and state.parts[-2] in {'human-login', 'human-login-2'}
manifest = json.loads((state / 'ready.json').read_text())
origin = manifest['origin']
assert manifest['realProvider'] is True
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with client.open(origin + '/api/v1/auth/setup-status', timeout=30) as response:
    before = json.loads(response.read())
assert before['needs_setup'] is True, 'Fresh uninitialized fixture required'
request = urllib.request.Request(origin + '/api/v1/auth/initialize', data=json.dumps({
    'email': 't111-bootstrap-admin@test.com', 'password': 'T111Bootstrap15aa!', 'remember_me': False
}).encode(), headers={'Content-Type': 'application/json', 'Origin': origin})
with client.open(request, timeout=60) as response:
    account = json.loads(response.read())
    status = response.status
assert status == 201 and account['system_role'] == 'super_admin'
with client.open(origin + '/api/v1/auth/setup-status', timeout=30) as response:
    after = json.loads(response.read())
assert after['needs_setup'] is False
(state / 'system-initialization.json').write_text(json.dumps({
    'before': before, 'after': after, 'status': status,
    'fixtureOnly': True, 'sessionCookiesDiscarded': True,
    'note': 'Official initialize API creates separate bootstrap admin; A/B remain regular users; no human login session prepared.'
}, indent=2))
print(json.dumps({'initialized': True, 'sessionCookiesDiscarded': True}))
