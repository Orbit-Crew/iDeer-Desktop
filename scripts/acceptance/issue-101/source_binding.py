"""Bind candidate product/test sources without including generated evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--base', required=True)
parser.add_argument('--kind', choices=('desktop', 'server'), required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve(strict=True)

def git(*arguments):
    return subprocess.check_output(['git', '-C', str(root), *arguments], text=True).strip()

files = set(git('ls-files', '-z').split('\0'))
files.update(git('ls-files', '--others', '--exclude-standard', '-z').split('\0'))
prefixes = ('src/', 'local-runtime/', 'test/', 'resources/', 'scripts/') if args.kind == 'desktop' else ('backend/', 'frontend/', 'scripts/')
excluded = ('scripts/acceptance/', 'backend/.venv', 'frontend/node_modules/', 'backend/node_modules/')
records = []
for name in sorted(files):
    path = root / name
    if not path.is_file() or name.startswith(excluded):
        continue
    if not name.startswith(prefixes) and name not in {'package.json', 'package-lock.json', 'electron-builder.yml', 'uv.lock'}:
        continue
    records.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
canonical = json.dumps(records, sort_keys=True, separators=(',', ':')).encode()
data = {'recordedAt': datetime.now(timezone.utc).isoformat(), 'kind': args.kind,
    'base': git('rev-parse', args.base), 'headAtBinding': git('rev-parse', 'HEAD'),
    'branch': git('branch', '--show-current'), 'sourceSHA256': hashlib.sha256(canonical).hexdigest(),
    'algorithm': 'SHA256 of UTF-8 canonical sorted path/hash records; product/test/build inputs; acceptance scripts and generated evidence excluded',
    'files': records}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(data, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in data.items() if key != 'files'}))
