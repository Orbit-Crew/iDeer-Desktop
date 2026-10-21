"""Remove one stopped, manifest-identified acceptance fixture with readonly versions."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import stat

parser = argparse.ArgumentParser()
parser.add_argument('state', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--expected-run')
args = parser.parse_args()
state = args.state.resolve(strict=True)
assert state.parent == Path('/tmp')
assert state.name.startswith('ideer-real-e2e-real-e2e-')
manifest_path = state / 'manifest.json'
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text())
    assert Path(manifest['state_dir']).resolve() == state
else:
    # rm removed the manifest before encountering protected synthetic versions.
    assert args.expected_run and state.name.startswith(f'ideer-real-e2e-{args.expected_run}-')
    assert all(re.fullmatch(r'resources/(agents|skills)/[0-9a-f-]{36}/versions/1/.+',
        path.relative_to(state).as_posix()) for path in state.rglob('*') if path.is_file())
    manifest = {'run_id': args.expected_run}
for command_path in Path('/proc').glob('[0-9]*/cmdline'):
    try:
        command = command_path.read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if b'uvicorn' in command or b'app.gateway' in command:
        assert str(state).encode() not in command, 'Fixture backend is still running'
directories = [state, *(path for path in state.rglob('*') if path.is_dir() and not path.is_symlink())]
assert all(path.stat().st_uid == os.getuid() for path in directories)
for path in directories:
    path.chmod(stat.S_IMODE(path.stat().st_mode) | stat.S_IWUSR | stat.S_IXUSR)
shutil.rmtree(state)
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps({'timestamp': datetime.now(timezone.utc).isoformat(),
    'runId': manifest['run_id'], 'backendStopped': True,
    'taskOwnedReadonlyDirectoriesMadeWritable': len(directories),
    'stateRemoved': not state.exists()}, indent=2))
