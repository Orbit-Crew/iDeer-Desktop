"""Restart only this owned frontend with its existing allowed-origin setting."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

state = Path(sys.argv[1]).resolve(strict=True)
assert state.parts[-3:] == ('issue-111', 'human-login', 'desktop')
target = json.loads((state / 'frontend-target.json').read_text())
binding = json.loads((state / 'frontend-copy-binding.json').read_text())
frontend = Path(binding['copy']).resolve(strict=True)
assert frontend == Path('/tmp/ideer111-human-login-15aa/frontend')
pid = target['pid']
assert Path(f'/proc/{pid}/cwd').resolve() == frontend
assert b'node_modules/next/dist/bin/next' in Path(f'/proc/{pid}/cmdline').read_bytes()
os.kill(pid, signal.SIGTERM)
deadline = time.monotonic() + 20
while Path(f'/proc/{pid}').exists() and time.monotonic() < deadline:
    time.sleep(0.1)
assert not Path(f'/proc/{pid}').exists()
public = target['publicOrigin']
origin = json.loads((state / 'ready.json').read_text())['origin']
environment = {**os.environ, 'DEER_FLOW_INTERNAL_GATEWAY_BASE_URL': origin, 'IDEER_INTERNAL_GATEWAY_BASE_URL': origin,
    'DEER_FLOW_TRUSTED_ORIGINS': public, 'IDEER_TRUSTED_ORIGINS': public, 'DEER_FLOW_DEV_ALLOWED_ORIGINS': public,
    'DEER_FLOW_AUTH_DISABLED': '0', 'IDEER_AUTH_DISABLED': '0', 'SKIP_ENV_VALIDATION': '1', 'NEXT_TELEMETRY_DISABLED': '1'}
for key in ['NEXT_PUBLIC_BACKEND_BASE_URL', 'NEXT_PUBLIC_LANGGRAPH_BASE_URL', 'NEXT_PUBLIC_STATIC_WEBSITE_ONLY']:
    environment.pop(key, None)
with (state.parent / 'frontend-restarted.log').open('wb') as log:
    child = subprocess.Popen(['node', 'node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '0.0.0.0', '--port', '13112'],
        cwd=frontend, env=environment, stdout=log, stderr=log)
    (state / 'frontend-restart.json').write_text(json.dumps({'previousPID': pid, 'pid': child.pid,
        'allowedDevOrigin': public, 'sourceUnchanged': True, 'authBypass': False}))
    try:
        while not (state / 'stop').exists() and child.poll() is None:
            time.sleep(0.2)
    finally:
        child.terminate()
        code = child.wait(timeout=30)
        (state / 'frontend-restart-cleanup.json').write_text(json.dumps({'exited': True, 'exitCode': code, 'terminatedByOwner': True}))
