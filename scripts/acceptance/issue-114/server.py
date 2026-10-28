"""Isolated real Gateway for installed issue 114 acceptance; no fake business responses.

Contract and device-surface ticket: no model credentials are required, so the
config mirrors the issue 112 isolated skeleton (real ``create_app`` over
sqlite, identities A/B really register). The observation middleware records
request key shapes, byte counts and hashes for this ticket's endpoints —
never tokens or body content.
"""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--server-root', type=Path, required=True)
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--desktop-state', type=Path, required=True)
args = parser.parse_args()
root = args.server_root.resolve(strict=True)
state = args.state.resolve()
desktop = args.desktop_state.resolve()
state.mkdir(parents=True, exist_ok=False)
desktop.mkdir(parents=True, exist_ok=False)
sys.path[:0] = [str(root / 'backend'), str(root / 'backend/packages/harness'),
    str(root / 'backend/packages/agentplatform-extension'), str(root / 'backend/packages/extension-api')]
logging.disable(logging.CRITICAL)
config = state / 'config.yaml'
config.write_text('''log_level: critical
models:
  - name: acceptance-unused
    use: langchain_openai:ChatOpenAI
    model: unused
    api_key: synthetic-unused
    timeout: 5
    max_retries: 0
    max_tokens: 64
sandbox:
  use: deerflow.sandbox.local:LocalSandboxProvider
agents_api:
  enabled: true
plugins:
  - name: agentplatform
    package: agentplatform-extension
    use: agentplatform_extension:install
    required: true
    config:
      dynamic_context: true
title:
  enabled: false
memory:
  enabled: false
database:
  backend: sqlite
  sqlite_dir: ''' + str(state / 'sqlite') + '''
run_events:
  backend: db
scheduler:
  enabled: false
tools:
  - name: knowledge_search
    group: knowledge
    use: deerflow.community.ragflow.tools:knowledge_search_tool
    base_url: http://127.0.0.1:9
    api_key: synthetic-unused
    timeout: 5
''')
extensions = state / 'extensions.json'
extensions.write_text('{}')
for prefix in ('DEER_FLOW_', 'IDEER_'):
    for key, value in {'HOME': state, 'PROJECT_ROOT': state, 'HOST_BASE_DIR': state,
        'CONFIG_PATH': config, 'EXTENSIONS_CONFIG_PATH': extensions, 'SKILLS_PATH': state / 'skills'}.items():
        os.environ[prefix + key] = str(value)
    os.environ[prefix + 'AUTH_DISABLED'] = '0'
os.environ.update(PYTHON_DOTENV_DISABLED='1', AUTH_JWT_SECRET=secrets.token_urlsafe(32),
    QA_ISOLATED='1', LANGSMITH_TRACING='false', LANGCHAIN_TRACING_V2='false', OTEL_SDK_DISABLED='true')
for key in ('DATABASE_URL', 'REDIS_URL', 'DEER_FLOW_CHECKPOINT_CACHE_REDIS_URL'):
    os.environ.pop(key, None)

import httpx
import uvicorn
from app.gateway.app import create_app

host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
listener = socket.socket()
listener.bind((host, 0))
origin = f'http://{host}:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
application = create_app()
observations = []
source_files = sorted(path for path in (root / 'backend').rglob('*.py')
    if not any(part in {'.venv', '__pycache__', 'node_modules'} for part in path.relative_to(root).parts))
source_records = [{'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    for path in source_files]
source_hash = hashlib.sha256(json.dumps(source_records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
(desktop / 'server-source-files.json').write_text(json.dumps(source_records, indent=2))

CONTENT_MARKERS = (b'T114_LOCAL_R1',)


@application.middleware('http')
async def observe_hybrid_boundary(request, call_next):
    row = {'method': request.method, 'path': request.url.path}
    raw = b''
    if request.method == 'POST' and (request.url.path.endswith('/knowledge-revisions/local-imports')
            or request.url.path.endswith('/activate-local') or '/tasks/local' in request.url.path
            or request.url.path.endswith('/runs') or '/tasks/' in request.url.path and request.url.path.endswith('/consent')):
        raw = await request.body()
        row.update(bytes=len(raw), requestSHA256=hashlib.sha256(raw).hexdigest())
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if isinstance(body, dict):
            row['bodyKeys'] = sorted(body)
            if isinstance(body.get('context'), dict):
                row['contextKeys'] = sorted(body['context'])
            if isinstance(body.get('context'), dict) and isinstance(body['context'].get('runtime_knowledge_scope'), list):
                row['runtimeScopeEntries'] = len(body['context']['runtime_knowledge_scope'])
        if request.url.path.endswith('/knowledge-revisions/local-imports'):
            row['containsContentMarker'] = any(marker in raw for marker in CONTENT_MARKERS)
            row['deviceId'] = body.get('device_id') if isinstance(body, dict) else None
    if request.method == 'GET' and request.url.path.endswith('/knowledge-scope'):
        row['scopeView'] = True
    if request.method == 'GET' and '/tasks/' in request.url.path:
        row['taskRead'] = True
    if request.method == 'GET' and '/receipts/' in request.url.path:
        row['receiptRead'] = True
    response = await call_next(request)
    row['status'] = response.status_code
    observations.append(row)
    (desktop / 'request-summary.json').write_text(json.dumps(observations, indent=2))
    return response


gateway = uvicorn.Server(uvicorn.Config(application, log_level='critical', access_log=False))
worker = threading.Thread(target=lambda: gateway.run(sockets=[listener]), daemon=True)
try:
    worker.start()
    deadline = time.monotonic() + 120
    while not gateway.started:
        if not worker.is_alive() or time.monotonic() > deadline:
            raise RuntimeError('GATEWAY_START_TIMEOUT')
        time.sleep(.1)
    identities = {}
    for label in ('A', 'B'):
        email = f't100-{label.lower()}@test.com'
        with httpx.Client(base_url=origin, trust_env=False, timeout=30) as client:
            response = client.post('/api/v1/auth/register', json={'email': email, 'password': email})
            response.raise_for_status()
            identities[label] = {'id': response.json()['id'], 'email': email}
    (desktop / 'ready.json').write_text(json.dumps({'origin': origin, 'identities': identities,
        'serverCandidate': 'f77261ce86a8efb87b49b1c5687230b36a85e876',
        'serverSourceSHA256': source_hash,
        'serverCandidateMeaning': 'base commit; actual tested Python tree bound by serverSourceSHA256',
        'serverRoot': str(root), 'authentication': 'real registration/login/pairing APIs',
        'modelsCalled': False}, indent=2))
    print('READY', flush=True)
    while not (desktop / 'stop').exists():
        time.sleep(.2)
finally:
    gateway.should_exit = True
    worker.join(timeout=30)
    (desktop / 'gateway-cleanup.json').write_text(json.dumps({'exited': not worker.is_alive()}))
