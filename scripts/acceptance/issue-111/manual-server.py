"""Real Gateway plus byte-verified frontend copy for human login acceptance."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

entry = Path(__file__).with_name('provider-private.py')
source = entry.read_text(encoding='utf-8')
public = os.environ['IDEER_T111_PUBLIC_ORIGIN']
assert public.startswith('http://127.0.0.1:') and public.rsplit(':', 1)[1].isdigit()
point = "exec(compile(source, str(entry), 'exec'), {'__name__': '__main__', '__file__': str(entry)})"
assert source.count(point) == 1
replacement = '''
source = source.replace("os.environ['GATEWAY_CORS_ORIGINS'] = origin", "os.environ['GATEWAY_CORS_ORIGINS'] = " + repr(public))
source = source.replace("    print('READY', flush=True)", "    start_frontend(root, state, desktop_state, origin)\\n    print('READY', flush=True)")
exec(compile(source, str(entry), 'exec'), {'__name__': '__main__', '__file__': str(entry), 'start_frontend': start_frontend})
'''
source = source.replace(point, replacement)
child = None
log = None


def start_frontend(root, state, desktop_state, origin):
    global child, log
    frontend = state / 'frontend'
    original = root / 'frontend'
    shutil.copytree(original, frontend, ignore=shutil.ignore_patterns('node_modules', '.next', 'test-results', 'playwright-report', 'coverage'))
    records = []
    for path in sorted(frontend.rglob('*')):
        if path.is_file():
            relative = path.relative_to(frontend)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            assert hashlib.sha256((original / relative).read_bytes()).hexdigest() == digest
            records.append({'path': str(relative), 'sha256': digest})
    subprocess.run(['cp', '-a', '--reflink=auto', str(original / 'node_modules'), str(frontend / 'node_modules')], check=True)
    (desktop_state / 'frontend-copy-binding.json').write_text(json.dumps({'source': str(original), 'copy': str(frontend), 'files': records}, indent=2))
    env = {**os.environ, 'DEER_FLOW_INTERNAL_GATEWAY_BASE_URL': origin, 'IDEER_INTERNAL_GATEWAY_BASE_URL': origin,
           'IDEER_TRUSTED_ORIGINS': public, 'DEER_FLOW_TRUSTED_ORIGINS': public, 'DEER_FLOW_DEV_ALLOWED_ORIGINS': public,
           'DEER_FLOW_AUTH_DISABLED': '0', 'IDEER_AUTH_DISABLED': '0', 'SKIP_ENV_VALIDATION': '1', 'NEXT_TELEMETRY_DISABLED': '1'}
    for key in ['NEXT_PUBLIC_BACKEND_BASE_URL', 'NEXT_PUBLIC_LANGGRAPH_BASE_URL', 'NEXT_PUBLIC_STATIC_WEBSITE_ONLY']:
        env.pop(key, None)
    log = (desktop_state.parent / 'frontend.log').open('wb')
    child = subprocess.Popen(['node', 'node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '0.0.0.0', '--port', '13112'], cwd=frontend, env=env, stdout=log, stderr=log)
    host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
    (desktop_state / 'frontend-target.json').write_text(json.dumps({'host': host, 'port': 13112, 'publicOrigin': public, 'pid': child.pid}))


try:
    exec(compile(source, str(entry), 'exec'), {'__name__': '__main__', '__file__': str(entry), 'public': public, 'start_frontend': start_frontend})
finally:
    if child:
        child.terminate()
        try:
            code = child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait(timeout=10)
        log.close()
        desktop = Path(sys.argv[sys.argv.index('--desktop-state') + 1])
        (desktop / 'frontend-cleanup.json').write_text(json.dumps({'exited': True, 'exitCode': code, 'terminatedByOwner': True}))
