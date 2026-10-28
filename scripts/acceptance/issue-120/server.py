"""Real isolated Gateway and configured external provider for issue 120."""
import argparse
import asyncio
import copy
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
parser.add_argument('--config-root', type=Path, required=True)
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--desktop-state', type=Path, required=True)
parser.add_argument('--model', default='agnes-3.0-flash')
args = parser.parse_args()
root = args.server_root.resolve(strict=True)
state = args.state.resolve()
desktop = args.desktop_state.resolve()
state.mkdir(parents=True, exist_ok=False)
desktop.mkdir(parents=True, exist_ok=False)
sys.path[:0] = [str(root / 'backend'), str(root / 'backend/packages/harness'),
    str(root / 'backend/packages/agentplatform-extension'), str(root / 'backend/packages/extension-api')]
logging.disable(logging.CRITICAL)

from dotenv import load_dotenv
import yaml

load_dotenv(args.config_root / '.env', override=False)
source_config = args.config_root / 'config.yaml'
source = yaml.safe_load(source_config.read_text())
model = copy.deepcopy(next(item for item in source['models'] if item['name'] == args.model))
for key in ('api_key', 'base_url', 'api_base', 'openai_api_base'):
    if key in model:
        value = str(model[key])
        if value.startswith('${') and value.endswith('}'):
            value = os.environ.get(value[2:-1], '')
        elif value.startswith('$'):
            value = os.environ.get(value[1:], '')
        variable = 'IDEER_T120_' + key.upper()
        os.environ[variable] = value
        model[key] = '$' + variable
model.update(timeout=120, max_retries=0, max_tokens=3000)
config = state / 'config.yaml'
config.write_text(yaml.safe_dump({'log_level': 'critical', 'models': [model],
    'sandbox': {'use': 'deerflow.sandbox.local:LocalSandboxProvider'},
    'agents_api': {'enabled': True}, 'title': {'enabled': False}, 'memory': {'enabled': False},
    'plugins': [{'name': 'agentplatform', 'package': 'agentplatform-extension',
                 'use': 'agentplatform_extension:install', 'required': True, 'config': {'dynamic_context': True}}],
    'database': {'backend': 'sqlite', 'sqlite_dir': str(state / 'sqlite')},
    'run_events': {'backend': 'db'}, 'scheduler': {'enabled': False}}), encoding='utf-8')
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


async def builtin(owner_id):
    from app.agentplatform.resources.bundled import seed_bundled_resources
    from app.agentplatform.resources.storage import ResourceStorage
    from deerflow.config.paths import get_paths
    from deerflow.persistence.engine import get_session_factory

    fixture = state / 'builtin-source'
    folder = fixture / 'builtin'
    folder.mkdir(parents=True)
    (folder / 'SKILL.md').write_bytes(b'---\nname: t120-builtin\ndescription: Synthetic read only built in\n---\nT120_BUILTIN_FROZEN\n')
    identity = '12000000-0000-4000-8000-000000000001'
    manifest = fixture / 'manifest.json'
    manifest.write_text(json.dumps({'schema_version': 1, 'resources': [{'id': identity,
        'type': 'skill', 'slug': 't120-builtin', 'display_name': 'T120 builtin readonly',
        'visibility': 'public', 'source': 'builtin', 'system_owned': True}]}))
    result = await seed_bundled_resources(get_session_factory(), ResourceStorage(get_paths().base_dir),
        manifest_path=manifest, source_root=fixture, owner_id=owner_id)
    assert result.created == 1
    return identity


host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
listener = socket.socket()
listener.bind((host, 0))
origin = f'http://{host}:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
application = create_app()
observations = []


@application.middleware('http')
async def observe(request, call_next):
    row = {'method': request.method, 'path': request.url.path}
    if request.url.path.startswith('/api/resources/import/skill'):
        raw = await request.body()
        row.update(bytes=len(raw), requestSHA256=hashlib.sha256(raw).hexdigest(),
            contentType=request.headers.get('content-type', ''),
            containsSyntheticMarker=b'T120_CONTENT_V1' in raw)
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
    builtin_id = asyncio.run(builtin(identities['A']['id']))
    records = [{'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in sorted((root / 'backend').rglob('*.py'))
        if not any(part in {'.venv', '__pycache__', 'node_modules'} for part in path.relative_to(root).parts)]
    (desktop / 'server-source-files.json').write_text(json.dumps(records, indent=2))
    source_hash = hashlib.sha256(json.dumps(records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    (desktop / 'ready.json').write_text(json.dumps({'origin': origin, 'identities': identities,
        'builtinId': builtin_id, 'serverCandidate': commit, 'serverSourceSHA256': source_hash,
        'serverCandidateMeaning': 'HEAD plus actual Python source tree hash', 'realProvider': True,
        'model': args.model, 'sourceConfigSHA256': hashlib.sha256(source_config.read_bytes()).hexdigest()}, indent=2))
    print('READY', flush=True)
    while not (desktop / 'stop').exists():
        time.sleep(.2)
except Exception as error:
    print(json.dumps({'status': 'failed', 'errorClass': type(error).__name__}), flush=True)
    raise SystemExit(1) from None
finally:
    gateway.should_exit = True
    worker.join(timeout=30)
    (desktop / 'gateway-cleanup.json').write_text(json.dumps({'exited': not worker.is_alive()}))
