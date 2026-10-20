"""Collect only the explicitly allowed, synthetic issue-100 evidence."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--installed', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
state = args.state.resolve(strict=True)
installed = args.installed.resolve(strict=True)
target = root / 'docs/acceptance/issue-100/evidence'
target.mkdir(parents=True, exist_ok=True)
artifacts = root / 'artifacts/issue-100'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    (target / name).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def copy_json(source, name=None):
    value = json.loads(source.read_text(encoding='utf-8-sig'))
    save(name or source.name, value)
    return value


result = copy_json(state / 'result.json', 'file-scenarios.json')
assert result['status'] == 'passed'
for name in ('run-evidence-A.json', 'run-evidence-B.json', 'model-tool-names.json',
             'request-summary.json', 'credential-cleanup.json', 'gateway-cleanup.json',
             'profile-restoration.json'):
    copy_json(state / name)
cleanup = json.loads((state / 'credential-cleanup.json').read_text())
assert cleanup == {'removed': 6, 'failures': []}, 'Credential cleanup failed'
assert json.loads((state / 'gateway-cleanup.json').read_text())['exited'] is True
restoration = json.loads((state / 'profile-restoration.json').read_text(encoding='utf-8-sig'))
assert restoration['restored'] is True and restoration['acceptanceExitCode'] == 0
requests = json.loads((state / 'request-summary.json').read_text())
assert requests and any(row['path'] == '/api/resources' for row in requests)
uploads = [row for row in requests if re.search(r'/uploads?(?:/|$)', row['path'])]
assert not uploads, 'Unexpected upload endpoint call'
models = json.loads((state / 'model-tool-names.json').read_text())
assert any('hasWindowsAbsolutePath' in row for row in models), 'No model messages checked'
assert all(not row.get('hasWindowsAbsolutePath') for row in models)
save('data-boundary.json', {'uploadEndpointCalls': uploads, 'httpRequests': len(requests),
    'modelMessageChecks': sum('hasWindowsAbsolutePath' in row for row in models),
    'windowsPhysicalPathsInModelMessages': False})
shutil.copyfile(state / 'workspace-chat.png', target / 'workspace-chat.png')
for name in ('lifecycle-results.json', 'runtime-lifecycle.json', 'desktop-command.json'):
    copy_json(artifacts / 'installed-signoff' / name)
retention = json.loads((artifacts / 'installed-signoff/data-retention.json').read_text(encoding='utf-8-sig'))
save('data-retention.json', [{
    'stage': row['stage'], 'timestamp': row['timestamp'], 'coverage': row.get('coverage'),
    'fixtureHashes': sorted(item['Hash'] for item in row['files']),
    'legacyFileHashes': sorted(item['Hash'] for item in row.get('legacyFiles', [])),
} for row in retention])
copy_json(artifacts / 'candidate-hashes.json')
copy_json(artifacts / 'os.json')
copy_json(artifacts / 'gitnexus-detect-full.json')
for name in ('typecheck-timing.json', 'dist-win-timing.json', 'installed-signoff-timing.json', 'runtime-test-env.json',
             'server-real-final-cleanup.json', 'server-real-selection.json',
             'server-gate-summary.json', 'server-aux-final-summary.json',
             'server-delivery.json', 'server-source-tree-proof.json'):
    if (artifacts / name).exists():
        copy_json(artifacts / name)
if (artifacts / (state.name + '-timing.json')).exists():
    copy_json(artifacts / (state.name + '-timing.json'), 'functional-timing.json')
history = []
for directory in ('installed-final', 'installed-evidence', 'installed-receipts',
                  'installed-complete', 'installed-verified', 'installed-package-final'):
    path = artifacts / directory / 'result.json'
    if path.exists():
        value = json.loads(path.read_text(encoding='utf-8'))
        history.append({'fixture': directory, 'startedAt': value['startedAt'],
            'finishedAt': value.get('finishedAt'), 'status': value.get('status'),
            'error': value.get('error')})
save('execution-history.json', history)

# Bind the tested payload to checked-in sources and the installed extraResources.
runtime = {}
for path in sorted((root / '.runtime').rglob('*')):
    if not path.is_file() or '__pycache__' in path.parts or path.suffix == '.pyc':
        continue
    relative = path.relative_to(root / '.runtime').as_posix()
    installed_path = installed / 'resources/runtime' / relative
    assert installed_path.is_file() and digest(installed_path) == digest(path), relative
    runtime[relative] = digest(path)
for path in (root / 'local-runtime/core').glob('*.py'):
    assert runtime['core/' + path.name] == digest(path), path.name
save('installed-payload.json', {'runtimeFiles': runtime,
    'runtimeFilesMatchPreparedCandidate': True, 'coreMatchesSource': True,
    'appAsar': digest(installed / 'resources/app.asar'),
    'unpackedAsar': digest(root / 'dist/win-unpacked/resources/app.asar')})
assert digest(installed / 'resources/app.asar') == digest(root / 'dist/win-unpacked/resources/app.asar')

source_paths = []
for directory in ('src', 'local-runtime/core'):
    source_paths.extend(path for path in (root / directory).rglob('*')
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc')
for name in ('package.json', 'package-lock.json', 'electron-builder.yml', 'electron.vite.config.ts',
             'local-runtime/distribution.lock.json', 'resources/provenance/runtime-source.json'):
    source_paths.append(root / name)
sources = {path.relative_to(root).as_posix(): digest(path) for path in sorted(source_paths)}
fingerprint = hashlib.sha256(''.join(f'{path}\0{sha}\n' for path, sha in sorted(sources.items())).encode()).hexdigest()
server_files = json.loads((artifacts / 'server-sync-hashes.json').read_text())
for name, sha in server_files.items():
    assert digest(artifacts / 'server' / name) == sha, name
save('source-binding.json', {'createdAt': datetime.now(timezone.utc).isoformat(),
    'desktopBase': subprocess.check_output(['git', 'rev-parse', 'b7e1e0a'], cwd=root, text=True).strip(),
    'desktopPayloadFingerprint': fingerprint, 'desktopPayloadFiles': sources,
    'serverBase': 'aec07a3b9af3ab451b1f1a377a93f6f11135bf88', 'serverChangedFiles': server_files})

# Compressed logs retain original output without checking in personal profiles.
for name in ('runtime-signoff.log', 'runtime-signoff.xml', 'desktop-final.log', 'typecheck-final.log',
             'dist-win-final.log', 'server-doc-gates.log', 'server-pr-standard.log', 'server-pr-final.log'):
    path = artifacts / name
    if path.exists():
        (target / (name + '.gz')).write_bytes(gzip.compress(path.read_bytes(), mtime=0))
for name in ('server-real-final.log', 'server-ruff-final.log', 'server-focused-final.log',
             'server-inventory-final.log', 'server-documents-final.log', 'server-upstream-patches-final.log'):
    path = artifacts / name
    if path.exists():
        (target / (name + '.gz')).write_bytes(gzip.compress(path.read_bytes(), mtime=0))
for lane in ('pr-standard', 'local-runtime', 'backend-standard', 'frontend-standard', 'frontend-smoke'):
    for name in ('run.meta', 'lane-evidence.json'):
        path = artifacts / 'server-pr-final-evidence' / lane / name
        if path.exists():
            shutil.copyfile(path, target / ('server-' + lane + '-' + name))
save('manifest.json', {path.name: digest(path) for path in sorted(target.iterdir())
    if path.is_file() and path.name != 'manifest.json'})
print(json.dumps({'status': 'passed', 'files': len(list(target.iterdir())),
    'desktopPayloadFingerprint': fingerprint, 'runtimeFiles': len(runtime)}))
