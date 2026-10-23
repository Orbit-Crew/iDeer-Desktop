"""Restartable real Gateway using isolated databases and deterministic model.

Only transport faults and model responses belong to this fixture. Production
Run cancellation, task persistence, signed receipts and execution stay intact.
"""
import json
from pathlib import Path
import subprocess
import sys


def replace(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Base acceptance fixture changed: ' + old[:80])
    return source.replace(old, new)


def worker():
    base = Path(__file__).resolve().parents[1] / 'issue-100' / 'server_fixture.py'
    source = base.read_text(encoding='utf-8')
    source = replace(source, 'state.mkdir(parents=True, exist_ok=False)', 'state.mkdir(parents=True, exist_ok=True)')
    source = replace(source, 'desktop.mkdir(parents=True, exist_ok=False)', 'desktop.mkdir(parents=True, exist_ok=True)')
    source = replace(source, "os.environ.update(PYTHON_DOTENV_DISABLED='1', AUTH_JWT_SECRET=secrets.token_urlsafe(32),", """jwt_path = state / 'fixture-jwt-secret'
if not jwt_path.exists():
    jwt_path.write_text(secrets.token_urlsafe(32))
os.environ.update(PYTHON_DOTENV_DISABLED='1', AUTH_JWT_SECRET=jwt_path.read_text(),""")
    source = replace(source, "listener.bind(('127.0.0.1', 0))", """port_file = state / 'fixture-port'
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', int(port_file.read_text()) if port_file.exists() else 0))
port_file.write_text(str(listener.getsockname()[1]))""")
    source = replace(source, 'worker = threading.Thread', """from fixture_hooks import install, process_control
from app.device_control.broker import get_device_broker
broker = get_device_broker()
install(broker, desktop)
worker = threading.Thread""")
    start = source.index('        identities = {}\n')
    end = source.index("        print('READY', flush=True)", start)
    block = source[start:end]
    block = "        if not (desktop / 'ready.json').exists():\n" + ''.join('    ' + line if line.strip() else line for line in block.splitlines(keepends=True))
    block += """        binding_script = Path(__file__).resolve().parents[1] / 'issue-101' / 'source_binding.py'
        subprocess.run([sys.executable, str(binding_script), '--root', str(root), '--base', 'HEAD',
            '--kind', 'server', '--output', str(state / 'server-source-binding.json')], check=True, stdout=subprocess.DEVNULL)
        server_binding = json.loads((state / 'server-source-binding.json').read_text())
        manifest = json.loads((desktop / 'ready.json').read_text())
        manifest['serverSourceSHA256'] = server_binding['sourceSHA256']
        (desktop / 'ready.json').write_text(json.dumps(manifest, indent=2))
        (desktop / 'server-generation.json').write_text(json.dumps({'pid': os.getpid(), 'started': time.time()}))
"""
    source = source[:start] + block + source[end:]
    source = replace(source, "while not (desktop / 'stop').exists():", "while not (desktop / 'stop').exists() and not (desktop / 'restart-server').exists():")
    source = replace(source, "            denied = (desktop / 'platform-deny').exists()", "            process_control(broker, desktop)\n            denied = (desktop / 'platform-deny').exists()")
    # A two-operation request lets the first committed write be observed while
    # the next awaits local approval. Cancellation must prevent that next write.
    source = replace(source, "        if tool:\n            message = AIMessage(content='T100_RESULT ' + str(tool.content))", """        request_match = re.search(r'T100_REQUEST (\\{[^\\n]+\\})', str(messages[human_index].content))
        fixture_request = json.loads(request_match.group(1)) if request_match else {}
        observed_tools = [item for item in recent if isinstance(item, ToolMessage)]
        if tool and fixture_request.get('next') and len(observed_tools) == 1:
            next_request = fixture_request['next']
            message = AIMessage(content='', tool_calls=[{'name': 'local.files.' + next_request['operation'],
                'args': next_request['arguments'], 'id': 't104-' + secrets.token_hex(6), 'type': 'tool_call'}])
        elif tool:
            message = AIMessage(content='T100_RESULT ' + str(tool.content))""")
    exec(compile(source, str(base), 'exec'), {'__name__': '__main__', '__file__': str(base)})


def main():
    if '--worker' in sys.argv:
        sys.argv.remove('--worker')
        worker()
        return
    desktop = Path(sys.argv[sys.argv.index('--desktop-state') + 1]).resolve()
    count = 0
    while True:
        result = subprocess.run([sys.executable, __file__, '--worker', *sys.argv[1:]])
        if result.returncode:
            raise SystemExit(result.returncode)
        restart = desktop / 'restart-server'
        if not restart.exists() or (desktop / 'stop').exists():
            return
        restart.unlink()
        count += 1
        (desktop / 'server-restarts.json').write_text(json.dumps({'count': count}))


if __name__ == '__main__':
    main()
