"""Collect only selected, synthetic evidence; never copy fixture credentials."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[3]
source = root / 'artifacts/issue-104'
target = root / 'docs/acceptance/issue-104/evidence'
checks = ['typecheck-reviewed', 'desktop-final', 'runtime-final-explicit', 'security-final',
          'provenance-final', 'runtime-static-final', 'runtime-source-final', 'dist-win-final', 'install-final']
destination = target / 'checks'
destination.mkdir(parents=True, exist_ok=True)
for name in checks:
    record = source / 'checks' / (name + '.json')
    assert json.loads(record.read_text(encoding='utf-8-sig'))['exitCode'] == 0, name
    shutil.copy2(record, destination / record.name)
    with gzip.open(destination / (name + '.log.gz'), 'wb') as output:
        output.write(record.with_suffix('.log').read_bytes())
with gzip.open(destination / 'runtime-final.xml.gz', 'wb') as output:
    output.write((source / 'checks/runtime-final.xml').read_bytes())
attempts = target / 'attempts'
attempts.mkdir(exist_ok=True)
for name in ['dist-win', 'desktop-reviewed', 'runtime-reviewed', 'dist-win-reviewed', 'runtime-final']:
    record = source / 'checks' / (name + '.json')
    if record.is_file():
        shutil.copy2(record, attempts / record.name)
        with gzip.open(attempts / (name + '.log.gz'), 'wb') as output:
            output.write(record.with_suffix('.log').read_bytes())
for name in ['environment.json', 'source-binding.json']:
    shutil.copy2(source / name, target / name)
for name in ['profile-restoration.json', 'lifecycle-results.json', 'installed-desktop-startup.png',
             'desktop-startup.png', 'desktop-processes.json', 'data-retention.json']:
    candidate = source / 'installation-final' / name
    if candidate.is_file():
        (target / 'installation').mkdir(exist_ok=True)
        shutil.copy2(candidate, target / 'installation' / name)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


installed = Path('D:/software/iDeer Desktop/ideer-desktop')
runtime = installed / 'resources/runtime'
files = []
for path in sorted((root / 'local-runtime/core').rglob('*.py')):
    relative = path.relative_to(root / 'local-runtime')
    candidates = [root / '.runtime' / relative, root / 'dist/win-unpacked/resources/runtime' / relative, runtime / relative]
    assert all(sha(candidate) == sha(path) for candidate in candidates), str(relative)
    files.append({'path': str(relative).replace('\\', '/'), 'sha256': sha(path)})
asar = root / 'dist/win-unpacked/resources/app.asar'
assert sha(asar) == sha(installed / 'resources/app.asar')
assert sha(root / '.runtime/python.exe') == sha(runtime / 'python.exe')
manifest = {'installerSHA256': sha(root / 'dist/ideer-desktop-0.1.0-windows-x64-setup.exe'),
    'appASARSHA256': sha(asar), 'pythonSHA256': sha(runtime / 'python.exe'),
    'installedPath': str(installed), 'runtimeCore': files,
    'sourceBindingSHA256': sha(source / 'source-binding.json')}
(target / 'package-hashes.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'checks': len(checks), 'runtimeFiles': len(files), 'installerSHA256': manifest['installerSHA256']}))
