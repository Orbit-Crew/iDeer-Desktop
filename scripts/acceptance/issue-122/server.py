"""Isolated real Gateway for installed issue 122 acceptance; no fake business responses.

Besides the real HTTP surface this fixture relays two task-owned requests the
HTTP API cannot express, both driven through the candidate's own production
objects only:

- ``script-dispatch-*.json``: one contract-shaped ``local.skill.script`` task
  over the real broker session (real persistent broker key, real device
  websocket, real receipt-archive admission, real ``TaskRecord`` inside
  ``broker.tasks`` so the real ``GET /api/devices/tasks/{id}`` projection
  works). The admin route ``POST /api/devices/{id}/tasks/local`` is
  separately proven to be refused by the device's fixed wire gate (it always
  carries an extra ``path`` key), so the contract-shaped half is built here
  exactly like the device-side signed-wire contract. Only key shapes, byte
  counts and hashes are recorded - never the script body.
- ``content-corrupt-*.json``: appends drifted bytes to one frozen version's
  script inside the task-owned state tree, for the T122-05 corruption leg.
"""
import argparse
import asyncio
import hashlib
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
from uuid import uuid4

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
from app.gateway.app import create_app

host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
listener = socket.socket()
listener.bind((host, 0))
origin = f'http://{host}:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
application = create_app()
observations = []
observe_lock = threading.Lock()
app_loop = None
source_files = sorted(path for path in (root / 'backend').rglob('*.py')
    if not any(part in {'.venv', '__pycache__', 'node_modules'} for part in path.relative_to(root).parts))
source_records = [{'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    for path in source_files]
source_hash = hashlib.sha256(json.dumps(source_records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
(desktop / 'server-source-files.json').write_text(json.dumps(source_records, indent=2))

SCRIPT_CAPABILITY = 'local.skill.script'


def record(row):
    with observe_lock:
        observations.append(row)
        (desktop / 'request-summary.json').write_text(json.dumps(observations, indent=2))


@application.middleware('http')
async def observe_script_boundary(request, call_next):
    global app_loop
    if app_loop is None:
        app_loop = asyncio.get_running_loop()
    row = {'method': request.method, 'path': request.url.path}
    path = request.url.path
    if request.method == 'POST' and (
            path.endswith('/scripts/authorize') or path.endswith('/scripts/execute')):
        raw = await request.body()
        body = json.loads(raw)
        row.update(bytes=len(raw), requestSHA256=hashlib.sha256(raw).hexdigest(),
            bodyKeys=sorted(body), containsScriptBody=any(isinstance(value, str) and len(value) > 512
                for value in body.values()))
    elif request.method == 'POST' and '/tasks/local' in path:
        raw = await request.body()
        body = json.loads(raw)
        row.update(bytes=len(raw), requestSHA256=hashlib.sha256(raw).hexdigest(),
            operation=body.get('operation'), payloadKeys=sorted(body.get('payload', {})),
            runId=body.get('run_id'))
    elif '/scripts/authorizations' in path:
        row['resourceId'] = path.split('/api/resources/')[1].split('/')[0] if '/api/resources/' in path else ''
    response = await call_next(request)
    row['status'] = response.status_code
    record(row)
    return response


def broker_dispatch(request):
    """One contract-shaped local.skill.script task over the real broker session."""
    from app.device_control.broker import TaskRecord, TaskStatus, get_device_broker
    from app.device_control.protocol import MessageType, sign_envelope
    from app.device_control.receipt_archive import safe_logical_target

    broker = get_device_broker()
    connection = broker.connections.get(request['deviceId'])
    if connection is None:
        return {'error': 'DEVICE_OFFLINE'}
    if not connection.tasks_allowed:
        return {'error': 'PROTOCOL_OUTDATED'}
    now = datetime.now(UTC)
    task_id = str(uuid4())
    expires_at = now + timedelta(minutes=5)
    payload = dict(request['payload'])
    payload.update({'operation': SCRIPT_CAPABILITY, 'run_id': request['runId'], 'tool_call_id': request['toolCallId']})
    envelope = sign_envelope(private_key=broker.server_private_key, message_type=MessageType.TASK,
        device_id=request['deviceId'], session_id=connection.session_id, task_id=task_id,
        payload=payload, expires_at=expires_at)
    broker.tasks[task_id] = TaskRecord(task_id, request['deviceId'], connection.session_id,
        request['runId'], request['toolCallId'], payload, expires_at, owner_id=connection.owner_id)
    if broker.receipt_archive is not None:
        admission = {
            'task_id': task_id, 'run_id': request['runId'], 'tool_call_id': request['toolCallId'],
            'capability': SCRIPT_CAPABILITY, 'request_hash': envelope.payload_hash,
            'original_session_id': connection.session_id, 'task_signature': envelope.signature,
            'logical_target': safe_logical_target(payload)}

        async def admit_and_send():
            await broker.receipt_archive.admit(broker.receipt_binding(connection), admission, thread_id='')
            await connection.websocket.send_text(envelope.model_dump_json(by_alias=True))

        asyncio.run_coroutine_threadsafe(admit_and_send(), app_loop).result(timeout=30)
    record({'method': 'BROKER', 'path': '/app/device_control/broker.py send_task(contract)',
        'taskKeyShape': sorted(payload), 'scriptBytes': len(payload.get('script', '')),
        'scriptSHA256': payload.get('script_sha256'), 'taskId': task_id, 'status': 'sent'})
    broker.tasks[task_id].status = TaskStatus.SENT
    broker.tasks[task_id].dispatch_started = True
    return {'taskId': task_id, 'payloadKeys': sorted(payload)}


def corrupt_version(request):
    """Append drifted bytes to one frozen version's script (T122-05 corruption leg)."""
    from app.agentplatform.resources.storage import ResourceStorage
    from deerflow.config.paths import get_paths

    storage = ResourceStorage(get_paths().base_dir)
    version_dir = storage.resources_root / 'skills' / request['resourceId'] / 'versions' / str(request['version'])
    target = version_dir / request['scriptPath']
    if not target.is_file() or version_dir not in target.parents:
        return {'error': 'VERSION_SCRIPT_NOT_FOUND'}
    before = target.read_bytes()
    target.write_bytes(before + b'\nT122_DRIFTED_BYTES\n')
    return {'relative': target.relative_to(storage.resources_root).as_posix(),
        'beforeSHA256': hashlib.sha256(before).hexdigest(), 'afterSHA256': hashlib.sha256(target.read_bytes()).hexdigest()}


def handle_requests():
    while not (desktop / 'stop').exists():
        for request_file in sorted(desktop.glob('script-dispatch-*.json')):
            if '.result.' in request_file.name:
                continue
            result_name = request_file.name.replace('.json', '.result.json')
            if (desktop / result_name).exists():
                continue
            try:
                request = json.loads(request_file.read_text(encoding='utf-8'))
                outcome = broker_dispatch(request)
            except Exception as error:
                outcome = {'error': type(error).__name__}
            (desktop / result_name).write_text(json.dumps(outcome, indent=2))
        for request_file in sorted(desktop.glob('content-corrupt-*.json')):
            if '.result.' in request_file.name:
                continue
            result_name = request_file.name.replace('.json', '.result.json')
            if (desktop / result_name).exists():
                continue
            try:
                request = json.loads(request_file.read_text(encoding='utf-8'))
                outcome = corrupt_version(request)
            except Exception as error:
                outcome = {'error': type(error).__name__}
            (desktop / result_name).write_text(json.dumps(outcome, indent=2))
        time.sleep(.2)


gateway = uvicorn.Server(uvicorn.Config(application, log_level='critical', access_log=False))
worker = threading.Thread(target=lambda: gateway.run(sockets=[listener]), daemon=True)
relayer = threading.Thread(target=handle_requests, daemon=True)
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
    relayer.start()
    while not (desktop / 'stop').exists():
        time.sleep(.2)
finally:
    gateway.should_exit = True
    worker.join(timeout=30)
    (desktop / 'gateway-cleanup.json').write_text(json.dumps({'exited': not worker.is_alive()}))
