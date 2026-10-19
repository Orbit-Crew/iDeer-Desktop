"""Isolated real-provider Gateway. Configuration secrets stay inside WSL."""
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
import sys
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--server-root', required=True, type=Path)
parser.add_argument('--config-root', required=True, type=Path)
parser.add_argument('--state', required=True, type=Path)
parser.add_argument('--desktop-state', required=True, type=Path)
parser.add_argument('--model', required=True)
args = parser.parse_args()
root = args.server_root.resolve(strict=True)
state = args.state.resolve()
desktop_state = args.desktop_state.resolve()
state.mkdir(parents=True, exist_ok=False)
desktop_state.mkdir(parents=True, exist_ok=False)
sys.path[:0] = [str(root / 'backend'), str(root / 'backend/packages/harness'),
               str(root / 'backend/packages/agentplatform-extension'), str(root / 'backend/packages/extension-api')]
logging.disable(logging.CRITICAL)
from dotenv import load_dotenv
import yaml

load_dotenv(args.config_root / '.env', override=False)
source_path = args.config_root / 'config.yaml'
source = yaml.safe_load(source_path.read_text())
profile = copy.deepcopy(next(m for m in source['models'] if m['name'] == args.model))
# Do not copy the user's literal credential or endpoint to the fixture YAML.
for key in ['api_key', 'base_url', 'api_base', 'openai_api_base']:
    if key in profile:
        value = str(profile[key])
        if value.startswith('${') and value.endswith('}'):
            value = os.environ.get(value[2:-1], '')
        elif value.startswith('$'):
            value = os.environ.get(value[1:], '')
        variable = 'IDEER_T99_' + key.upper()
        os.environ[variable] = value
        profile[key] = '$' + variable
profile.update(timeout=45, max_retries=0, max_tokens=1024)
config = {'log_level': 'critical', 'models': [profile],
          'sandbox': {'use': 'deerflow.sandbox.local:LocalSandboxProvider'},
          'agents_api': {'enabled': True}, 'title': {'enabled': False}, 'memory': {'enabled': False},
          'database': {'backend': 'sqlite', 'sqlite_dir': str(state / 'sqlite')},
          'run_events': {'backend': 'db'}, 'scheduler': {'enabled': False}}
config_path = state / 'config.yaml'
config_path.write_text(yaml.safe_dump(config), encoding='utf-8')
extensions = state / 'extensions.json'
extensions.write_text('{}', encoding='utf-8')
for namespace in ['DEER_FLOW_', 'IDEER_']:
    for name, value in {'HOME': state, 'PROJECT_ROOT': state, 'HOST_BASE_DIR': state,
                        'CONFIG_PATH': config_path, 'EXTENSIONS_CONFIG_PATH': extensions,
                        'SKILLS_PATH': state / 'skills'}.items():
        os.environ[namespace + name] = str(value)
    os.environ[namespace + 'AUTH_DISABLED'] = '0'
os.environ.update(PYTHON_DOTENV_DISABLED='1', AUTH_JWT_SECRET=secrets.token_urlsafe(32), QA_ISOLATED='1',
                  LANGSMITH_TRACING='false', LANGCHAIN_TRACING_V2='false', OTEL_SDK_DISABLED='true')
for name in ['DATABASE_URL', 'REDIS_URL', 'DEER_FLOW_CHECKPOINT_CACHE_REDIS_URL']:
    os.environ.pop(name, None)

import httpx
import uvicorn
from app.gateway.app import create_app


async def seed_resources(owner_id):
    from app.agentplatform.resources.service import ResourceActor, ResourceService, ResourceAction
    from app.agentplatform.resources.publisher import ResourcePublisher
    from app.agentplatform.resources.storage import ResourceStorage
    from deerflow.config.paths import get_paths
    from deerflow.persistence.engine import get_session_factory

    actor = ResourceActor(user_id=owner_id, department_id=None, role='user',
                          permissions=frozenset({ResourceAction.READ, ResourceAction.WRITE, ResourceAction.USE}), tool_groups=None)
    async with get_session_factory()() as session:
        service = ResourceService(session, actor)
        publisher = ResourcePublisher(service, ResourceStorage(str(get_paths().base_dir)))

        async def resource(kind, slug, *, publish=True, dependency=None, soul=None):
            item = await service.create_resource(resource_type=kind, slug=slug, display_name=slug, storage_kind='filesystem')
            directory = state / 'staging' / slug
            directory.mkdir(parents=True)
            if kind == 'skill':
                (directory / 'SKILL.md').write_text(f'---\nname: {slug}\ndescription: Synthetic Desktop acceptance instructions\n---\n'
                    'When selected, include IDEER_T99_SKILL_V1 in your answer. Do not access user files or execute commands.\n', encoding='utf-8')
            else:
                definition = {'name': slug, 'model': args.model, 'thinking_enabled': False,
                              'memory_enabled': False, 'model_settings': {'max_tokens': 1024}}
                (directory / 'config.yaml').write_text(yaml.safe_dump(definition), encoding='utf-8')
                (directory / 'SOUL.md').write_text(soul or 'Answer synthetic acceptance requests concisely. Do not access files or execute commands.', encoding='utf-8')
                (directory / 'skill').mkdir()
            await publisher.save_filesystem_draft(item.id, source_dir=directory, expected_revision=0)
            if dependency:
                await service.replace_dependencies(item.id, [{'resource_id': dependency, 'required': True}])
            if publish:
                await publisher.publish_filesystem(item.id, expected_draft_revision=1, scan_result={'status': 'passed'})
            await session.commit()
            return item.id

        skill_id = await resource('skill', 't99-real-skill')
        agent_id = await resource('agent', 't99-real-expert', dependency=skill_id, soul='''You are an isolated Desktop acceptance Agent.
Follow the user's synthetic test instructions precisely. Never access user files or execute commands.
For ordinary chat, include the exact marker requested by the user and IDEER_T99_SKILL_V1.
When the user asks for a clarification test, call ask_clarification exactly once with question "T99 choose a target", clarification_type "approach_choice", and options ["Target A", "Target B"]. Wait for the user's answer.
After the user answers that clarification, reply with IDEER_T99_CLARIFIED and IDEER_T99_SKILL_V1.
When the user explicitly asks for delegation, delegate the synthetic marker request to the general-purpose subagent using the task tool, then report its marker.
Do not create plans for simple marker requests.''')
        draft_id = await resource('agent', 't99-unpublished-expert', publish=False)
        dependency_id = await resource('skill', 't99-archived-dependency')
        broken_id = await resource('agent', 't99-unavailable-expert', dependency=dependency_id)
        await service.archive(dependency_id)
        await session.commit()
        return {'agentId': agent_id, 'skillId': skill_id, 'unpublishedId': draft_id,
                'unavailableId': broken_id, 'archivedDependencyId': dependency_id}


listener = socket.socket()
listener.bind(('127.0.0.1', 0))
origin = f'http://127.0.0.1:{listener.getsockname()[1]}'
os.environ['GATEWAY_CORS_ORIGINS'] = origin
gateway = uvicorn.Server(uvicorn.Config(create_app(), log_level='critical', access_log=False, timeout_graceful_shutdown=20))
worker = threading.Thread(target=lambda: gateway.run(sockets=[listener]), daemon=True)
try:
    worker.start()
    deadline = time.monotonic() + 60
    while not gateway.started:
        if not worker.is_alive() or time.monotonic() >= deadline:
            raise RuntimeError('GATEWAY_START_FAILED')
        time.sleep(0.1)
    identities = {}
    with httpx.Client(base_url=origin, trust_env=False, timeout=45) as client:
        for label in ['A', 'B']:
            email = f't99-provider-{label.lower()}@test.com'
            response = client.post('/api/v1/auth/register', json={'email': email, 'password': email})
            response.raise_for_status()
            identities[label] = {'id': response.json()['id'], 'email': email}
    resources = asyncio.run(seed_resources(identities['A']['id']))
    manifest = {'origin': origin, 'identities': identities, **resources, 'model': args.model,
                'realProvider': True, 'ownerPid': os.getpid(),
                'sourceConfigSha256': hashlib.sha256(source_path.read_bytes()).hexdigest()}
    (desktop_state / 'ready.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('READY', flush=True)
    while not (desktop_state / 'stop').exists():
        time.sleep(0.2)
except Exception as error:
    print(json.dumps({'result': 'failed', 'errorClass': type(error).__name__}), flush=True)
    raise SystemExit(1) from None
finally:
    gateway.should_exit = True
    worker.join(timeout=30)
    (desktop_state / 'server-cleanup.json').write_text(json.dumps({'gatewayExited': not worker.is_alive()}), encoding='utf-8')
