"""Task-owned fixture launcher; avoids repeated Windows-to-WSL startup under load.

Only the two reviewed acceptance fixtures may run. No shell commands, model
keys or business responses pass through the queue.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[3]
queue = Path(sys.argv[1]).resolve(strict=True)
assert queue.is_relative_to(root / 'artifacts/issue-111')
assert (queue / 'owner').read_text().strip() == 'ideer111-task-owned'
server_root = Path('/home/neowyh/.codex-worktrees/ideer-acceptance111-15aa-20261026')
python = server_root / 'backend/.venv/bin/python'
children = {}
(queue / 'ready.json').write_text(json.dumps({'pid': os.getpid(), 'serverRoot': str(server_root)}))
try:
    while not (queue / 'stop').exists():
        for job_file in sorted(queue.glob('job-*.json')):
            if job_file.name.endswith('.exit.json'):
                continue
            if job_file.stem in children or job_file.with_suffix('.exit.json').exists():
                continue
            job = json.loads(job_file.read_text(encoding='utf-8-sig'))
            mode = job['mode']
            assert mode in {'base', 'provider'}
            desktop = Path(job['desktopState']).resolve()
            assert desktop.is_relative_to(root / 'artifacts/issue-111') and not desktop.exists()
            state = Path('/tmp') / ('ideer111-supervised-' + job_file.stem)
            assert not state.exists()
            entry = root / ('scripts/acceptance/issue-109/server-private.py' if mode == 'base' else 'scripts/acceptance/issue-111/provider-private.py')
            command = [str(python), str(entry), '--server-root', str(server_root), '--state', str(state), '--desktop-state', str(desktop)]
            environment = {**os.environ, 'PYTHONUNBUFFERED': '1', 'SERVER_RELEASE_VERSION': '591f80c-runtime-compat-20261025'}
            environment.pop('TEST_PNPM_BIN', None)
            if mode == 'provider':
                assert job['model'] in {'agnes-3.0-flash', 'deepseek-v4-flash'}
                command += ['--config-root', '/home/neowyh/code/AgentPlatform', '--model', job['model']]
            if job.get('updates'):
                updates = Path(job['updates']).resolve(strict=True)
                assert updates.is_relative_to(root / 'artifacts')
                environment['UPDATES_CONTROLLED_DIR'] = str(updates)
            parent = desktop.parent
            out = (parent / 'server.log').open('wb')
            err = (parent / 'server-error.log').open('wb')
            process = subprocess.Popen(command, env=environment, stdout=out, stderr=err)
            children[job_file.stem] = (process, desktop, out, err, job_file)
        for key, (process, desktop, out, err, job_file) in list(children.items()):
            if process.poll() is not None:
                out.close(); err.close()
                job_file.with_suffix('.exit.json').write_text(json.dumps({'exited': True, 'exitCode': process.returncode, 'pid': process.pid}))
                del children[key]
        time.sleep(0.2)
finally:
    cleanup = []
    for process, desktop, out, err, job_file in children.values():
        if desktop.exists():
            (desktop / 'stop').write_text('task-owned supervisor cleanup')
        try:
            code = process.wait(timeout=40)
        except subprocess.TimeoutExpired:
            process.terminate()
            code = process.wait(timeout=10)
        out.close(); err.close()
        cleanup.append({'pid': process.pid, 'exitCode': code})
    (queue / 'cleanup.json').write_text(json.dumps({'closed': True, 'children': cleanup}))
