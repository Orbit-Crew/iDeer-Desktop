"""Isolated real Gateway for installed issue 123 acceptance; no fake business responses.

The observation middleware records the /api/connectors* boundary only: method,
path, byte count, body key SHAPE (never values), and whether a managed
binding or entry source leaked into a registration body. A task-owned
``connector-blackout`` marker makes the connector endpoint family refuse at
the boundary (503 + connection close), the closest task-owned equivalent of
stopping the Gateway for these endpoints: the device's fixed mapping (any
non-conflict registration failure -> CONNECTOR_REGISTRATION_UNAVAILABLE,
connector_install.py) is identical for a dead socket.
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
from fastapi.responses import JSONResponse
from app.gateway.app import create_app

host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
listener = socket.socket()
listener.bind((host, 0))
origin = f'http://{host}:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
application = create_app()
observations = []
observe_lock = threading.Lock()
source_files = sorted(path for path in (root / 'backend').rglob('*.py')
    if not any(part in {'.venv', '__pycache__', 'node_modules'} for part in path.relative_to(root).parts))
source_records = [{'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    for path in source_files]
source_hash = hashlib.sha256(json.dumps(source_records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
(desktop / 'server-source-files.json').write_text(json.dumps(source_records, indent=2))


def record(row):
    with observe_lock:
        observations.append(row)
        (desktop / 'request-summary.json').write_text(json.dumps(observations, indent=2))


@application.middleware('http')
async def observe_connectors_boundary(request, call_next):
    row = {'method': request.method, 'path': request.url.path}
    connectors_boundary = request.url.path == '/api/connectors' or request.url.path.startswith('/api/connectors/')
    if connectors_boundary:
        raw = await request.body()
        row.update(bytes=len(raw), requestSHA256=hashlib.sha256(raw).hexdigest(),
            containsManagedBinding=b'MCP_ROOT' in raw or b'command' in raw or b'env' in raw,
            containsEntrySource=b'def call_tool' in raw or b'"jsonrpc"' in raw,
            containsOutsideMarker=b'T123_OUTSIDE_WRITE_ATTEMPT' in raw)
        if request.method == 'POST':
            try:
                row['bodyKeys'] = sorted(json.loads(raw)) if raw else []
            except ValueError:
                row['bodyKeys'] = ['<unparseable>']
    if connectors_boundary and (desktop / 'connector-blackout').exists():
        row['blackout'] = True
        record(row)
        return JSONResponse(status_code=503, content={'detail': {'code': 'PLATFORM_BLACKOUT',
            'message': 'task-owned connector blackout; endpoint family refused at the boundary'}})
    response = await call_next(request)
    row['status'] = response.status_code
    record(row)
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
