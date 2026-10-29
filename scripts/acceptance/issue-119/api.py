"""Call the real Gateway with this fixture's OS-stored business session."""
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
if method != 'GET' and extra:
    data = json.dumps(json.loads(extra[0])).encode()
request = urllib.request.Request(manifest['origin'] + route, method=method, data=data, headers=headers)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(request, timeout=90) as response:
        raw = response.read(4 * 1024 * 1024)
        result = {'status': response.status, 'body': json.loads(raw) if raw else None}
except urllib.error.HTTPError as error:
    raw = error.read(65536)
    result = {'status': error.code, 'body': json.loads(raw) if raw else None}
    error.close()
print(json.dumps(result))
