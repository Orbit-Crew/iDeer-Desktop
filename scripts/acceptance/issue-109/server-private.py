"""Task-only bind adapter; execute the existing fixture against the real app."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
entry = root / 'scripts/acceptance/issue-102/server_fixture.py'
sys.path.insert(0, str(entry.parent))
source = entry.read_text()
old = "source = fixture.read_text(encoding='utf-8')"
assert source.count(old) == 1
host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
source = source.replace(old, old + "\nsource = source.replace(\"listener.bind(('127.0.0.1', 0))\", \"listener.bind(('" + host + "', 0))\")\nsource = source.replace(\"origin = f'http://127.0.0.1:\", \"origin = f'http://" + host + ":\")")
exec(compile(source, str(entry), 'exec'), {'__name__': '__main__', '__file__': str(entry)})
