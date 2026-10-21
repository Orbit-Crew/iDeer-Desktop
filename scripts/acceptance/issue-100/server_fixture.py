"""Real isolated Gateway; only the model is deterministic, tools execute normally."""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from unittest.mock import patch

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
sys.path[:0] = [str(root / 'backend'), str(root / 'backend/tests'),
    str(root / 'backend/packages/harness'), str(root / 'backend/packages/agentplatform-extension'),
    str(root / 'backend/packages/extension-api')]
logging.disable(logging.CRITICAL)
config = state / 'config.yaml'
config.write_text('''log_level: critical
models:
  - name: t100-fixture
    use: langchain_openai:ChatOpenAI
    model: fixture
    api_key: synthetic-not-a-provider-key
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
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from _agent_e2e_helpers import FakeToolCallingModel
from app.gateway.app import create_app

model_requests = []


class FileModel(FakeToolCallingModel):
    def bind_tools(self, tools, **kwargs):
        # Keep a redacted record of what the actual Agent assembly exposed.
        model_requests.append({'toolNames': [getattr(t, 'name', '') for t in tools]})
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        serialized = json.dumps([str(message.content) for message in messages])
        absolute_windows_path = bool(re.search(r'(?<![A-Za-z0-9_])[A-Za-z]:(?:/|\\\\)', serialized))
        model_requests.append({'messageCount': len(messages), 'bytes': len(serialized.encode()),
            'hasWindowsAbsolutePath': absolute_windows_path})
        assert not absolute_windows_path, 'Model received a Windows physical path'
        human_index = max(i for i, message in enumerate(messages) if isinstance(message, HumanMessage))
        recent = messages[human_index:]
        tool = next((m for m in reversed(recent) if isinstance(m, ToolMessage)), None)
        if tool:
            message = AIMessage(content='T100_RESULT ' + str(tool.content))
        else:
            match = re.search(r'T100_REQUEST (\{[^\n]+\})', str(messages[human_index].content))
            if not match:
                message = AIMessage(content='T100 ready')
            else:
                request = json.loads(match.group(1))
                if request.get('hold'):
                    (desktop / 'held').write_text('model has not dispatched the file tool')
                    deadline = time.monotonic() + 45
                    while (desktop / 'hold').exists():
                        if time.monotonic() > deadline:
                            raise TimeoutError('FIXTURE_HOLD_TIMEOUT')
                        time.sleep(.05)
                message = AIMessage(content='', tool_calls=[{'name': 'local.files.' + request['operation'],
                    'args': request['arguments'], 'id': 't100-' + secrets.token_hex(6), 'type': 'tool_call'}])
        return ChatResult(generations=[ChatGeneration(message=message)])


async def seed(owner, label):
    from app.agentplatform.resources.service import ResourceActor, ResourceService, ResourceAction
    from app.agentplatform.resources.publisher import ResourcePublisher
    from app.agentplatform.resources.storage import ResourceStorage
    from deerflow.config.paths import get_paths
    from deerflow.persistence.engine import get_session_factory
    actor = ResourceActor(user_id=owner, department_id=None, role='user',
        permissions=frozenset({ResourceAction.READ, ResourceAction.WRITE, ResourceAction.USE}), tool_groups=None)
    source = state / ('agent-' + label)
    source.mkdir()
    (source / 'config.yaml').write_text('model: t100-fixture\ntool_groups: [local.files]\n')
    (source / 'SOUL.md').write_text('Use the authorized local file tools when the user requests them.')
    async with get_session_factory()() as session:
        service = ResourceService(session, actor)
        publisher = ResourcePublisher(service, ResourceStorage(str(get_paths().base_dir)))
        agent = await service.create_resource(resource_type='agent', slug='t100-' + label.lower(),
            display_name='T100 file expert ' + label, storage_kind='filesystem')
        await publisher.save_filesystem_draft(agent.id, source_dir=source, expected_revision=0)
        await publisher.publish_filesystem(agent.id, expected_draft_revision=1, scan_result={})
        await session.commit()
        return agent.id


listener = socket.socket()
listener.bind(('127.0.0.1', 0))
origin = f'http://127.0.0.1:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
request_summary = []
application = create_app()


@application.middleware('http')
async def record_request_summary(request, call_next):
    # No headers or bodies are retained; uploads remain visible by endpoint.
    response = await call_next(request)
    request_summary.append({'method': request.method, 'path': request.url.path,
        'status': response.status_code})
    return response


gateway = uvicorn.Server(uvicorn.Config(application, log_level='critical', access_log=False))
worker = threading.Thread(target=lambda: gateway.run(sockets=[listener]), daemon=True)
with patch('deerflow.agents.lead_agent.agent.create_chat_model', new=lambda *a, **k: FileModel(responses=[AIMessage(content='')])):
    try:
        worker.start()
        deadline = time.monotonic() + 90
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
                user_id = response.json()['id']
            identities[label] = {'id': user_id, 'email': email, 'agentId': asyncio.run(seed(user_id, label))}
        (desktop / 'ready.json').write_text(json.dumps({'origin': origin, 'identities': identities,
            'model': 'deterministic Server model; real Gateway and Windows Runtime tools',
            'serverCandidate': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()}, indent=2))
        print('READY', flush=True)
        while not (desktop / 'stop').exists():
            denied = (desktop / 'platform-deny').exists()
            if denied:
                os.environ['IDEER_LOCAL_READ_CAPABILITIES'] = ''
            else:
                os.environ.pop('IDEER_LOCAL_READ_CAPABILITIES', None)
            (desktop / 'platform-state.json').write_text(json.dumps({'denied': denied}))
            time.sleep(.2)
    finally:
        gateway.should_exit = True
        worker.join(timeout=30)
        (desktop / 'model-tool-names.json').write_text(json.dumps(model_requests, indent=2))
        (desktop / 'request-summary.json').write_text(json.dumps(request_summary, indent=2))
        (desktop / 'gateway-cleanup.json').write_text(json.dumps({'exited': not worker.is_alive()}))
