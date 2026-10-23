"""Real isolated Server. The model and transport failures are fixture-owned."""
from pathlib import Path

fixture = Path(__file__).resolve().parents[1] / 'issue-100' / 'server_fixture.py'
source = fixture.read_text(encoding='utf-8')


def replace(old, new):
    global source
    assert source.count(old) == 1, 'Issue100 fixture changed; verify adaptation'
    source = source.replace(old, new)


replace('worker = threading.Thread', '''from fixture_hooks import install, process_control
from app.device_control.broker import get_device_broker
broker = get_device_broker()
install(broker, desktop)
worker = threading.Thread''')
replace("    response = await call_next(request)", """    try:
        response = await call_next(request)
    except Exception as error:
        from fixture_hooks import record_http_exception
        record_http_exception(desktop, request.method, request.url.path, error)
        raise""")
replace("application = create_app()", """application = create_app()
from fixture_hooks import record_http_exception
from starlette.responses import PlainTextResponse
previous_exception_handler = application.exception_handlers.get(Exception)
async def observe_unhandled_exception(request, error):
    record_http_exception(desktop, request.method, request.url.path, error)
    if previous_exception_handler is not None:
        return await previous_exception_handler(request, error)
    return PlainTextResponse('Internal Server Error', status_code=500)
application.add_exception_handler(Exception, observe_unhandled_exception)""")
replace("            denied = (desktop / 'platform-deny').exists()", """            process_control(broker, desktop)
            denied = (desktop / 'platform-deny').exists()""")
replace("        (desktop / 'ready.json').write_text", """        binding_script = Path(__file__).resolve().parents[1] / 'issue-101' / 'source_binding.py'
        subprocess.run([sys.executable, str(binding_script), '--root', str(root), '--base', 'HEAD',
            '--kind', 'server', '--output', str(state / 'server-source-binding.json')], check=True, stdout=subprocess.DEVNULL)
        server_binding = json.loads((state / 'server-source-binding.json').read_text())
        (desktop / 'ready.json').write_text""")
replace("'serverCandidate': subprocess.check_output", "'serverSourceSHA256': server_binding['sourceSHA256'],\n            'serverCandidate': subprocess.check_output")
exec(compile(source, str(fixture), 'exec'))
