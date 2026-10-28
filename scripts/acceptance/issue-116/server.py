"""Real isolated Gateway and configured external provider for issue 116.

The observation middleware records the controlled graph surface
(POST/GET .../graph, scoped query/ask) as request-key shapes, byte counts,
and hashes only. A separate observer thread records broker task records for
``local.knowledge.material`` — operation, frozen identity fields, one-document
shape, status — never document text or tokens. Identities A and B are real
registrations; the model configuration follows the issue 120 pattern.
"""
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
        variable = 'IDEER_T116_' + key.upper()
        os.environ[variable] = value
        model[key] = '$' + variable
# max_tokens=3000: a reasoning model can otherwise exhaust a smaller budget
# before emitting the graph JSON, which reads as an empty model answer.
model.update(timeout=90, max_retries=0, max_tokens=3000)
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

host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
listener = socket.socket()
listener.bind((host, 0))
origin = f'http://{host}:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
application = create_app()
observations = []


@application.middleware('http')
async def observe_graph(request, call_next):
    row = {'method': request.method, 'path': request.url.path}
    path = request.url.path
    if request.method == 'POST' and (path.endswith('/graph') or path.endswith('/graph/query') or path.endswith('/graph/ask')):
        raw = await request.body()
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}
        row.update(bodyKeys=sorted(body) if isinstance(body, dict) else [], bytes=len(raw),
            requestSHA256=hashlib.sha256(raw).hexdigest(),
            documentIds=(len(body.get('document_ids')) if isinstance(body, dict) and isinstance(body.get('document_ids'), list) else None))
    response = await call_next(request)
    row['status'] = response.status_code
    observations.append(row)
    (desktop / 'request-summary.json').write_text(json.dumps(observations, indent=2))
    return response


def observe_material_tasks():
    """Record local.knowledge.material broker task shapes; never their text.

    The frozen identity fields (filename, content hash, revision, manifest
    hash) and the per-task document count are the only payload facts kept, so
    the one-document dispatch contract stays observable without materializing
    any document text. Each (task, status) pair is recorded once.
    """
    summary = []
    seen = set()
    while not (desktop / 'stop').exists():
        try:
            from app.device_control.broker import get_device_broker
            for record in list(get_device_broker().tasks.values()):
                payload = record.payload if isinstance(record.payload, dict) else {}
                if str(payload.get('operation') or '') != 'local.knowledge.material':
                    continue
                status_name = str(getattr(record.status, 'value', record.status))
                key = (str(record.task_id), status_name)
                if key in seen:
                    continue
                seen.add(key)
                arguments = payload.get('arguments') if isinstance(payload.get('arguments'), dict) else {}
                documents = arguments.get('documents') if isinstance(arguments.get('documents'), list) else []
                summary.append({'task': 'broker', 'operation': 'local.knowledge.material',
                    'taskSHA256': hashlib.sha256(str(record.task_id).encode()).hexdigest(),
                    'documentCount': len(documents),
                    'documents': [{'filename': item.get('filename'), 'content_hash': item.get('content_hash')}
                                  for item in documents if isinstance(item, dict)],
                    'revisionId': str(arguments.get('revision_id') or ''),
                    'manifestHash': str(arguments.get('manifest_hash') or ''),
                    'status': status_name,
                    'errorCode': str(record.error_code or '')})
                (desktop / 'material-summary.json').write_text(json.dumps(summary, indent=2))
        except Exception:
            pass
        time.sleep(.2)


source_files = sorted(path for path in (root / 'backend').rglob('*.py')
    if not any(part in {'.venv', '__pycache__', 'node_modules'} for part in path.relative_to(root).parts))
source_records = [{'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    for path in source_files]
source_hash = hashlib.sha256(json.dumps(source_records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
(desktop / 'server-source-files.json').write_text(json.dumps(source_records, indent=2))

gateway = uvicorn.Server(uvicorn.Config(application, log_level='critical', access_log=False))
worker = threading.Thread(target=lambda: gateway.run(sockets=[listener]), daemon=True)
try:
    worker.start()
    deadline = time.monotonic() + 120
    while not gateway.started:
        if not worker.is_alive() or time.monotonic() > deadline:
            raise RuntimeError('GATEWAY_START_TIMEOUT')
        time.sleep(.1)
    threading.Thread(target=observe_material_tasks, daemon=True).start()
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
        'realProvider': True, 'model': args.model,
        'sourceConfigSHA256': hashlib.sha256(source_config.read_bytes()).hexdigest()}, indent=2))
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
