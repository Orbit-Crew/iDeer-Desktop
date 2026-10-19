"""Real Gateway + deterministic model, isolated accounts and OS-backed sessions.

This proves protocol integration, not real-provider or installed-app acceptance.
Run with the locked Server Python environment and --server-root/--state.
"""
import argparse
import asyncio
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--server-root', required=True, type=Path)
parser.add_argument('--state', required=True, type=Path)
args = parser.parse_args()
server_root = args.server_root.resolve(strict=True)
state = args.state.resolve()
state.mkdir(parents=True, exist_ok=False)
desktop = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(server_root / 'backend'), str(desktop / 'local-runtime'), str(server_root / 'backend/tests')]
config = state / 'config.yaml'
config.write_text(f'''log_level: warning
models:
  - name: fake-test-model
    display_name: Deterministic acceptance model
    use: langchain_openai:ChatOpenAI
    model: fixture
    api_key: isolated-not-a-real-key
sandbox:
  use: deerflow.sandbox.local:LocalSandboxProvider
agents_api:
  enabled: true
title:
  enabled: false
memory:
  enabled: false
database:
  backend: sqlite
  sqlite_dir: {state.as_posix()}/sqlite
run_events:
  backend: memory
''', encoding='utf-8')
extensions = state / 'extensions.json'
extensions.write_text('{}', encoding='utf-8')
for namespace in ['DEER_FLOW_', 'IDEER_']:
    for name, value in {'HOME': state, 'PROJECT_ROOT': state, 'HOST_BASE_DIR': state,
                        'CONFIG_PATH': config, 'EXTENSIONS_CONFIG_PATH': extensions,
                        'SKILLS_PATH': state / 'skills'}.items():
        os.environ[namespace + name] = str(value)
    os.environ[namespace + 'AUTH_DISABLED'] = '0'
os.environ.update(PYTHON_DOTENV_DISABLED='1', AUTH_JWT_SECRET=secrets.token_urlsafe(32), QA_ISOLATED='1')
for name in ['DATABASE_URL', 'REDIS_URL', 'DEER_FLOW_CHECKPOINT_CACHE_REDIS_URL']:
    os.environ.pop(name, None)

import httpx
import uvicorn
from unittest.mock import patch
from langchain_core.messages import AIMessage
from _agent_e2e_helpers import FakeToolCallingModel
from app.gateway.app import create_app
from core.secrets import create_default_secret_store
from core.settings import RuntimeSettings

model = FakeToolCallingModel(responses=[AIMessage(content='T99 Server response'), AIMessage(content='', tool_calls=[
    dict(name='ask_clarification', args=dict(question='T99 choose a target', clarification_type='approach_choice',
                                         options=['Target A', 'Target B']), id='t99-clarify', type='tool_call')
]), AIMessage(content='T99 clarification accepted')], sleep=1)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
origin = f'http://127.0.0.1:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
app = create_app()
gateway = uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False))
secure = create_default_secret_store()
references = []


async def seed_agent(owner_id):
    from app.agentplatform.resources.service import ResourceActor, ResourceService, ResourceAction
    from app.agentplatform.resources.publisher import ResourcePublisher
    from app.agentplatform.resources.storage import ResourceStorage
    from deerflow.config.paths import get_paths
    from deerflow.persistence.engine import get_session_factory
    actor = ResourceActor(user_id=owner_id, department_id=None, role='user',
                          permissions=frozenset({ResourceAction.READ, ResourceAction.WRITE, ResourceAction.USE}), tool_groups=None)
    source = state / 'agent-source'
    source.mkdir()
    (source / 'config.yaml').write_text('model: fake-test-model\n', encoding='utf-8')
    (source / 'SOUL.md').write_text('Answer the user and ask clarification when requested.', encoding='utf-8')
    (source / 'skill').mkdir()
    async with get_session_factory()() as session:
        service = ResourceService(session, actor)
        publisher = ResourcePublisher(service, ResourceStorage(str(get_paths().base_dir)))
        agent = await service.create_resource(resource_type='agent', slug='t99-expert', display_name='T99 private expert', storage_kind='filesystem')
        await publisher.save_filesystem_draft(agent.id, source_dir=source, expected_revision=0)
        await publisher.publish_filesystem(agent.id, expected_draft_revision=1, scan_result={})
        await session.commit()
        return agent.id


worker = threading.Thread(target=lambda: gateway.run(sockets=[listener]), daemon=True)
with patch('deerflow.agents.lead_agent.agent.create_chat_model', new=lambda *a, **k: model):
    try:
        worker.start()
        deadline = time.monotonic() + 60
        while not gateway.started:
            if not worker.is_alive() or time.monotonic() >= deadline:
                raise RuntimeError('Gateway startup failed')
            time.sleep(0.1)
        with httpx.Client(base_url=origin, trust_env=False, timeout=60) as client:
            # Match the Server's existing isolated Gateway integration fixture:
            # register regular users, then publish only the test-owned resource.
            # Admin bootstrap and bundled-resource seeding are outside this probe.
            identities = {}
            for label in ['A', 'B']:
                email = f't99-{label.lower()}@test.com'
                response = client.post('/api/v1/auth/register', json={'email': email, 'password': email})
                response.raise_for_status()
                user_id = response.json()['id']
                reference = 't99-' + uuid.uuid4().hex
                secure.set(reference, client.cookies.get('access_token'))
                references.append(reference)
                profile = state / f'profile-{label}' / 'settings.json'
                RuntimeSettings(server_url=origin, user_id=user_id, user_name=email, device_name='T99 isolated desktop',
                                business_token_ref=reference, business_expires_at='2099-01-01T00:00:00+00:00').save(profile)
                identities[label] = {'id': user_id, 'profile': str(profile)}
            agent_id = asyncio.run(seed_agent(identities['A']['id']))
        manifest = {'origin': origin, 'identities': identities, 'agentId': agent_id,
                    'model': 'deterministic Server-side fixture, no real provider', 'ownerPid': os.getpid()}
        (state / 'ready.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print('READY ' + str(state / 'ready.json'), flush=True)
        while not (state / 'stop').exists():
            time.sleep(0.2)
    finally:
        gateway.should_exit = True
        worker.join(timeout=30)
        for reference in references:
            secure.delete(reference)
        (state / 'cleanup.json').write_text(json.dumps({'credentialEntriesRemoved': len(references), 'gatewayExited': not worker.is_alive()}), encoding='utf-8')
