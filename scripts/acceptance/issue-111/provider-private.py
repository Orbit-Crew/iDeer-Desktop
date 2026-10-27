"""Run the existing real-provider fixture with task-only private WSL binding."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
entry = root / 'scripts/acceptance/issue-99/provider_server.py'
source = entry.read_text(encoding='utf-8')
host = subprocess.check_output(['/bin/hostname', '-I'], text=True).split()[0]
for before, after in [
    ("listener.bind(('127.0.0.1', 0))", f"listener.bind(('{host}', 0))"),
    ("origin = f'http://127.0.0.1:", f"origin = f'http://{host}:")
]:
    assert source.count(before) == 1
    source = source.replace(before, after)
point = "    (desktop_state / 'ready.json').write_text"
assert source.count(point) == 1
binding = '''    import subprocess
    binding_script = Path(__file__).resolve().parents[1] / 'issue-101/source_binding.py'
    subprocess.run([sys.executable, str(binding_script), '--root', str(root), '--base', 'HEAD',
                    '--kind', 'server', '--output', str(state / 'server-source-binding.json')], check=True, stdout=subprocess.DEVNULL)
    server_binding = json.loads((state / 'server-source-binding.json').read_text())
    (desktop_state / 'server-source-binding.json').write_text(json.dumps(server_binding, indent=2))
    manifest.update(serverCandidate=server_binding['headAtBinding'], serverSourceSHA256=server_binding['sourceSHA256'])
'''
source = source.replace(point, binding + point)
exec(compile(source, str(entry), 'exec'), {'__name__': '__main__', '__file__': str(entry)})
