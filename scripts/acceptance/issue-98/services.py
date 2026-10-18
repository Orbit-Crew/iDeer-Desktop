"""Isolated local deployment of the real Gateway, Next and nginx for T98."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--server-root', required=True, type=Path)
parser.add_argument('--evidence-directory', type=Path)
args = parser.parse_args()
ROOT = args.server_root.resolve(strict=True)
DESKTOP = Path(__file__).resolve().parents[3]
STATE = (args.evidence_directory or ROOT / 'dev-log/live-98').resolve()
STATE.mkdir(parents=True, exist_ok=True)
STOP = STATE / 'stop-services'
STOP.unlink(missing_ok=True)
GATEWAY, FRONTEND, PUBLIC = 21981, 21982, 21980
# A health response from an older deployment is not evidence that our child
# started. Reject occupied fixture ports before launching any service.
for port in [GATEWAY, FRONTEND, PUBLIC]:
    for family, host in [(socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')]:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind((host, port))
            except OSError as error:
                raise SystemExit(f'Fixture address {host}:{port} is unavailable; stop its owner before retrying') from error
NODE = DESKTOP / '.cache/node22/node-v22.23.3-win-x64/node.exe'
NGINX = DESKTOP / '.cache/nginx-1.31.7/nginx.exe'
config = STATE / 'config.yaml'
config.write_text('log_level: info\nmodels: []\ntool_groups: []\ntools: []\n'
    'sandbox:\n  use: deerflow.sandbox.local:LocalSandboxProvider\n'
    'scheduler:\n  enabled: false\n'
    f'database:\n  backend: sqlite\n  sqlite_dir: {STATE.as_posix()}/sqlite\n', encoding='utf-8')
extensions = STATE / 'extensions.json'
extensions.write_text('{}\n', encoding='utf-8')
skills = STATE / 'skills'
skills.mkdir(exist_ok=True)
env = os.environ.copy()
for key in ['AUTH_JWT_SECRET', 'OPENAI_API_KEY', 'DATABASE_URL', 'REDIS_URL',
            'DEER_FLOW_CHECKPOINT_CACHE_REDIS_URL']:
    env.pop(key, None)
# Modern path variables take precedence over compatibility aliases. Override
# both so inherited operator settings cannot select another database or state.
for setting, value in {'HOME': STATE, 'CONFIG_PATH': config,
                       'PROJECT_ROOT': STATE, 'HOST_BASE_DIR': STATE,
                       'EXTENSIONS_CONFIG_PATH': extensions, 'SKILLS_PATH': skills}.items():
    for namespace in ['DEER_FLOW_', 'IDEER_']:
        env[namespace + setting] = str(value)
env.update(DEER_FLOW_AUTH_DISABLED='0', IDEER_AUTH_DISABLED='0',
    PYTHON_DOTENV_DISABLED='1', AUTH_JWT_SECRET=secrets.token_urlsafe(32),
    PYTHONUTF8='1', PYTHONIOENCODING='utf-8', QA_ISOLATED='1',
    GATEWAY_CORS_ORIGINS=f'http://127.0.0.1:{PUBLIC}',
    DEER_FLOW_INTERNAL_GATEWAY_BASE_URL=f'http://127.0.0.1:{GATEWAY}',
    IDEER_INTERNAL_GATEWAY_BASE_URL=f'http://127.0.0.1:{GATEWAY}',
    DEER_FLOW_TRUSTED_ORIGINS=f'http://127.0.0.1:{PUBLIC}',
    IDEER_TRUSTED_ORIGINS=f'http://127.0.0.1:{PUBLIC}',
    # Explicit empty values also stop Next's .env loader from restoring an
    # external API URL. Browser requests must use the fixture's public origin.
    NEXT_PUBLIC_BACKEND_BASE_URL='', NEXT_PUBLIC_LANGGRAPH_BASE_URL='',
    NEXT_PUBLIC_STATIC_WEBSITE_ONLY='false', SKIP_ENV_VALIDATION='1',
    NEXT_TELEMETRY_DISABLED='1')
env['PATH'] = str(NODE.parent) + os.pathsep + env['PATH']
processes = []
logs = []

def start(label, command, cwd):
    log = open(STATE / f'{label}.log', 'w', encoding='utf-8')
    logs.append(log)
    child = subprocess.Popen([str(arg) for arg in command], cwd=cwd, env=env,
        stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    processes.append(child)
    return child

def wait_http(url, timeout=180):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError('a deployment process exited, inspect local logs')
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise TimeoutError(url)

try:
    start('gateway', [ROOT / 'backend/.venv/Scripts/python.exe', '-m', 'uvicorn',
        'app.gateway.app:app', '--host', '127.0.0.1', '--port', GATEWAY, '--no-access-log'], ROOT / 'backend')
    wait_http(f'http://127.0.0.1:{GATEWAY}/health')
    print('Gateway ready', flush=True)
    start('frontend', [NODE, ROOT / 'frontend/node_modules/next/dist/bin/next', 'dev',
        '--hostname', '127.0.0.1', '--port', FRONTEND], ROOT / 'frontend')
    wait_http(f'http://127.0.0.1:{FRONTEND}/api/v1/auth/setup-status')
    print('Next ready', flush=True)
    # Preserve the actual deployment locations. Only substitute environment
    # ports, loopback bind and Windows-compatible file paths in this fixture.
    nginx = (ROOT / 'docker/nginx/nginx.local.conf').read_text(encoding='utf-8')
    nginx = nginx.replace('listen 2026', f'listen 127.0.0.1:{PUBLIC}')
    nginx = nginx.replace('listen [::]:2026', f'listen [::1]:{PUBLIC}')
    nginx = nginx.replace('127.0.0.1:8001', f'127.0.0.1:{GATEWAY}').replace('localhost:8001', f'127.0.0.1:{GATEWAY}')
    nginx = nginx.replace('127.0.0.1:3000', f'127.0.0.1:{FRONTEND}').replace('localhost:3000', f'127.0.0.1:{FRONTEND}')
    nginx = nginx.replace('pid /tmp/nginx.pid;', f'pid {STATE.as_posix()}/nginx.pid;')
    nginx = nginx.replace('/dev/stdout', f'{STATE.as_posix()}/nginx-access.log').replace('/dev/stderr', f'{STATE.as_posix()}/nginx-error.log')
    nginx = nginx.replace('"$NGINX_EXPOSE_API_DOCS"', '"false"')
    nginx_config = STATE / 'nginx.conf'
    nginx_config.write_text(nginx, encoding='utf-8')
    prefix = str(NGINX.parent).replace('\\', '/') + '/'
    subprocess.run([str(NGINX), '-p', prefix, '-c', nginx_config.as_posix(), '-t'], check=True, env=env)
    start('nginx', [NGINX, '-p', prefix, '-c', nginx_config.as_posix(), '-g', 'daemon off;'], NGINX.parent)
    wait_http(f'http://127.0.0.1:{PUBLIC}/api/v1/auth/setup-status')
    manifest = {'gateway': f'http://127.0.0.1:{GATEWAY}', 'frontend': f'http://127.0.0.1:{FRONTEND}', 'owner_pid': os.getpid(),
        'public': f'http://127.0.0.1:{PUBLIC}', 'pids': [p.pid for p in processes],
        'state': str(STATE), 'config': str(config)}
    (STATE / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Unified entry ready ' + manifest['public'], flush=True)
    while not STOP.exists():
        time.sleep(0.2)
finally:
    for child in reversed(processes):
        if child.poll() is None:
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
    for log in logs:
        log.close()
