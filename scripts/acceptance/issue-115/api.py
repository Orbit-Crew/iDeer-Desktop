"""Call the real Gateway with this fixture's OS-stored business session.

JSON verbs cover the local-publication surface (preview/confirm/complete/
status); MULTIPART uploads one exact fixture document through the platform's
own document endpoint. The uploaded file must live inside the task-owned
state directory; nothing here fabricates a business response.
"""
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

from core.secrets import create_default_secret_store

directory, who, method, route, *extra = sys.argv[1:]
state = Path(directory).resolve(strict=True)
manifest = json.loads((state / 'ready.json').read_text())
settings = json.loads(Path(manifest['identities'][who]['profile']).read_text())
token = create_default_secret_store().get(settings['business_token_ref'])
csrf = uuid.uuid4().hex
headers = {'Cookie': f'access_token={token}; csrf_token={csrf}', 'X-CSRF-Token': csrf,
    'Origin': manifest['origin'], 'Content-Type': 'application/json'}
data = None
if method == 'MULTIPART':
    payload = json.loads(extra[0])
    source = Path(payload['file']).resolve(strict=True)
    if not source.is_relative_to(state):
        raise SystemExit('TASK_FIXTURE_REQUIRED')
    boundary = 'T115' + uuid_hex
    chunks = [f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{source.name}"\r\n'
              f'Content-Type: text/markdown\r\n\r\n'.encode(),
              source.read_bytes(), f'\r\n--{boundary}--\r\n'.encode()]
    data = b''.join(chunks)
    headers['Content-Type'] = f'multipart/form-data; boundary={boundary}'
    method = 'POST'
elif extra:
    data = json.dumps(json.loads(extra[0])).encode()
request = urllib.request.Request(manifest['origin'] + route, method=method, data=data, headers=headers)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(request, timeout=60) as response:
        raw = response.read(4 * 1024 * 1024)
        result = {'status': response.status, 'body': json.loads(raw) if raw else None}
except urllib.error.HTTPError as error:
    raw = error.read(65536)
    result = {'status': error.code, 'body': json.loads(raw) if raw else None,
        'detail': raw.decode('utf-8', 'replace')}
    error.close()
print(json.dumps(result))
