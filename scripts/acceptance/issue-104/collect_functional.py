"""Export only completed synthetic runs, leaving credentials in ignored state."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--label', choices=('development', 'installed'), required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
run = args.run.resolve(strict=True)
assert run.is_relative_to(root / 'artifacts/issue-104')
result = json.loads((run / 'result.json').read_text(encoding='utf-8-sig'))
assert result['status'] == 'passed'
assert set(result['scenarios']) == {'T104-01', 'T104-02', 'T104-03', 'T104-04'}
assert all(row['status'] == 'passed' and row['cases'] for row in result['scenarios'].values())
assert result['credentialCleanup']['failures'] == []
assert json.loads((run / 'gateway-cleanup.json').read_text())['exited']
binding = json.loads((run / 'server-source-binding.json').read_text())
assert result['candidate']['serverSourceSHA256'] == binding['sourceSHA256']
target = root / 'docs/acceptance/issue-104/evidence' / args.label
target.mkdir(parents=True, exist_ok=True)
for name in ['result.json', 'wire-events.jsonl', 'request-summary.json', 'model-tool-names.json']:
    with gzip.open(target / (name + '.gz'), 'wb') as output:
        output.write((run / name).read_bytes())
for name in ['credential-cleanup.json', 'gateway-cleanup.json', 'server-restarts.json',
             'server-source-binding.json', 'profile-restoration.json']:
    source = run / name
    if source.is_file():
        shutil.copy2(source, target / name)
images = []
for source in sorted(run.glob('*.png')):
    shutil.copy2(source, target / source.name)
    images.append({'path': source.name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
(target / 'images.json').write_text(json.dumps(images, indent=2), encoding='utf-8')
print(json.dumps({'label': args.label, 'operations': len(result['operations']), 'images': len(images),
                  'serverSourceSHA256': binding['sourceSHA256']}))
