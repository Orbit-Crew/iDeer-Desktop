"""Use the existing synthetic identities with the candidate write capability."""
from pathlib import Path

fixture = Path(__file__).resolve().parents[1] / 'issue-100' / 'profiles.py'
source = fixture.read_text(encoding='utf-8')
old = "'local.files.list', 'local.files.read', 'local.files.search']"
assert source.count(old) == 1, 'Issue100 pairing fixture changed; verify its contract'
source = source.replace(old, "'local.files.list', 'local.files.read', 'local.files.search', 'local.files.write']")
source = source.replace("elif action in {'api', 'evidence'}:", "elif action in {'api', 'api-post', 'evidence'}:")
source = source.replace("    if action == 'api':", "    if action in {'api', 'api-post'}:")
old = "request = urllib.request.Request(manifest['origin'] + route,"
assert source.count(old) == 1
source = source.replace(old, old + "\n        method='POST' if action == 'api-post' else None,")
old = 'return json.loads(response.read(2 * 1024 * 1024))'
assert source.count(old) == 1
source = source.replace(old, '''global last_response_status
        last_response_status = response.status
        raw = response.read(2 * 1024 * 1024)
        return json.loads(raw) if raw else None''')
old = "result = {'status': 200, 'body': api(opener, token, route, body)}"
assert source.count(old) == 1
source = source.replace(old, "value = api(opener, token, route, body)\n            result = {'status': last_response_status, 'body': value}")
exec(compile(source, str(fixture), 'exec'))
