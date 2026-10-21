"""Copy an explicit evidence allowlist. Never copy fixture credentials or databases."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--server', type=Path)
args = parser.parse_args()
root = args.root.resolve(strict=True)
artifacts = root / 'artifacts/issue-101'
destination = root / 'docs/acceptance/issue-101/evidence'
destination.mkdir(parents=True, exist_ok=True)
# Evidence hashes bind original bytes across Windows and Linux checkouts.
(destination / '.gitattributes').write_text('* binary\n', encoding='utf-8', newline='\n')
copied = []

def copy(source, relative):
    if not source.is_file():
        return
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix in {'.log', '.xml', '.patch'} or source.name.endswith('source-binding.json'):
        target = target.with_name(target.name + '.gz')
        with source.open('rb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=target.open('wb'), mtime=0) as output:
            shutil.copyfileobj(stream, output)
    else:
        shutil.copyfile(source, target)
    copied.append(str(target.relative_to(destination)))

for name in ('environment.json', 'lock-hashes.json', 'builder-helper-hashes.json',
             'desktop-source-binding.json', 'package-hashes.json'):
    copy(artifacts / name, Path('desktop') / name)
for stem in ('typecheck-release', 'desktop-tests-release', 'security-release',
             'provenance-verified', 'runtime-static-verified', 'runtime-tests-verified',
             'dist-win-release', 'install-lifecycle-release', 'functional-final-command', 'functional-visual-command'):
    for suffix in ('.json', '.log', '.xml'):
        copy(artifacts / (stem + suffix), Path('desktop') / (stem + suffix))
for name in ('lifecycle-results.json', 'profile-restoration.json', 'desktop-command.json',
             'installed-desktop-smoke.log', 'installed-desktop-startup.png'):
    copy(artifacts / 'lifecycle-release' / name, Path('lifecycle') / name)
for name in ('result.json', 'receipt-events.jsonl', 'receipt-history.png', 'receipt-history-older.png',
             'profile-restoration.json', 'gateway-cleanup.json', 'credential-cleanup.json'):
    copy(artifacts / 'functional-visual' / name, Path('functional') / name)
for stem in ('desktop-tests-first', 'dist-win-first', 'install-lifecycle-first', 'functional-command'):
    for suffix in ('.json', '.log'):
        copy(artifacts / (stem + suffix), Path('attempts') / (stem + suffix))
for name in ('result.json', 'profile-restoration.json', 'gateway-cleanup.json', 'run-reconciliation.json'):
    copy(artifacts / 'functional-signoff' / name, Path('attempts/functional-first') / name)
if args.server:
    server = args.server.resolve(strict=True)
    for stem in ('server-pr-signoff', 'server-real-signoff', 'server-real-verified',
                 'server-focused-verified', 'deadline-isolated', 'deadline-verified', 'inventory-signoff',
                 'documents-signoff', 'upstream-signoff', 'server-static-verified', 'gitnexus-final', 'detect-changes-final'):
        for suffix in ('.json', '.log'):
            copy(server / 'dev-log' / (stem + suffix), Path('server') / (stem + suffix))
    for name in ('server-source-binding.json', 'detect-changes-result.json', 'deadline-baseline-blobs.txt',
                 'real-first-cleanup.json', 'real-final-cleanup.json', 'server-delivery.patch',
                 'impact-__init__.json', 'impact-attach.json', 'impact-device-websocket.json',
                 'impact-get_device_broker.json', 'impact-message-type-1.6.10.json',
                 'impact-receive.json', 'impact-safe-logical-target-review.txt', 'impact-send-task.json',
                 'functional-fixture-cleanup.json', 'server-environment.json'):
        copy(server / 'dev-log' / name, Path('server') / name)
manifest = [{'path': path.relative_to(destination).as_posix(),
             'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
            for path in sorted(destination.rglob('*')) if path.is_file() and path.name != 'manifest.json']
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'copied': copied, 'manifestFiles': len(manifest)}))
