"""Independent bundled Runtime -> real Gateway -> MCP/Python -> signed receipts.

Run with the bundled python.exe -I after the real UI matrix, while its isolated
Gateway is alive. This is a separate paired device using the existing standalone
Runtime mode. It never enables Python or MCP in the Desktop product profile.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from core.audit import LocalAuditLog
from core.protocol import public_key_text
from core.receipt_ledger import ReceiptLedger
from core.secrets import create_default_secret_store
from core.settings import CapabilityRule, RuntimeSettings
from core.task_guard import TaskGuard
from core.tray import load_controller
import core.transport

parser = argparse.ArgumentParser()
parser.add_argument('state', type=Path)
parser.add_argument('--run-id', required=True, help='Owner Run from the real UI write scenario')
args = parser.parse_args()
state = args.state.resolve(strict=True)
manifest = json.loads((state / 'ready.json').read_text())
owner = manifest['identities']['A']
owner_settings = json.loads(Path(owner['profile']).read_text())
secure = create_default_secret_store()
business = secure.get(owner_settings['business_token_ref'])
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
evidence = {'status': 'unexecuted', 'serverCandidate': manifest['serverCandidate'],
    'cases': [], 'deviceId': '', 'runtimePythonSHA256': hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
    'transportSHA256': hashlib.sha256(Path(core.transport.__file__).read_bytes()).hexdigest(),
    'mode': 'standalone independent bundled Runtime, separate paired device'}
output = state / 'independent-runtime-result.json'


def save():
    output.write_text(json.dumps(evidence, indent=2))


def request(route, body=None):
    csrf = uuid.uuid4().hex
    req = urllib.request.Request(manifest['origin'] + route,
        headers={'Cookie': f'access_token={business}; csrf_token={csrf}', 'X-CSRF-Token': csrf,
                 'Origin': manifest['origin'], 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    try:
        with opener.open(req, timeout=30) as response:
            return response.status, json.loads(response.read(2 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read(65536))


def successful_request(route, body=None):
    status, value = request(route, body)
    assert status in {200, 201, 202}, (route, status, value)
    return value


def wait(predicate, description, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('Timeout: ' + description)


def dispatch(operation, payload, expected='completed'):
    created = successful_request(f'/api/devices/{device_id}/tasks/local', {
        'run_id': args.run_id, 'tool_call_id': 't106-' + uuid.uuid4().hex,
        'operation': operation, 'payload': payload})
    task_id = created['task_id']

    def terminal():
        value = successful_request(f'/api/devices/tasks/{task_id}')
        return value if value['status'] in {'completed', 'denied', 'failed', 'cancelled'} else None

    result = wait(terminal, operation + ' terminal Server task')
    assert result['status'] == expected, result
    receipt = result.get('receipt')
    assert isinstance(receipt, dict), result
    assert receipt['task_id'] == task_id and receipt['run_id'] == args.run_id, result
    assert receipt['capability'] == operation and receipt['status'] == expected, result
    evidence['cases'].append({'operation': operation, 'taskId': task_id, 'status': result['status'],
        'receipt': receipt, 'result': result.get('result'), 'errorCode': result.get('error_code')})
    save()
    return result


references, controller, device_id, temporary = [], None, '', None
save()
try:
    # -I and the bundled distribution's _pth must select the independent copy.
    assert Path(core.transport.__file__).resolve().is_relative_to(Path(sys.executable).resolve().parent)
    temporary = tempfile.TemporaryDirectory(prefix='ideer-t106-independent-')
    work = Path(temporary.name)
    key = Ed25519PrivateKey.generate()
    public = public_key_text(key)
    challenge = successful_request('/api/devices/pairing', {})
    registered = successful_request('/api/devices/register', {'pairing_code': challenge['code'],
        'name': 'T106 independent Runtime', 'public_key': public, 'protocol_version': '1',
        'runtime_version': '0.1.0', 'capabilities': ['echo', 'local.python', 'local.mcp.fixture.echo']})
    device_id = registered['device']['id']
    evidence['deviceId'] = device_id
    successful_request(f"/api/devices/pairing/{challenge['pairing_id']}/confirm", {'code': challenge['code']})
    completed = successful_request('/api/devices/register/complete', {'device_id': device_id,
        'public_key': public, 'claim_token': registered['claim_token']})

    def remember(value):
        ref = 't106-' + uuid.uuid4().hex
        references.append(ref)
        secure.set(ref, value)
        return ref

    count = work / 'mcp-effects.txt'
    mcp_fixture = Path(__file__).resolve().parents[3] / 'local-runtime/tests/fixtures/counting_mcp_server.py'
    assert mcp_fixture.is_file()
    mcp_config = work / 'mcp.json'
    mcp_config.write_text(json.dumps({'servers': [{'name': 'fixture', 'transport': 'stdio',
        'command': [sys.executable, '-I', str(mcp_fixture)],
        'env': {'MCP_COUNT': str(count), 'MCP_PID': str(work / 'mcp.pid')}}]}))
    settings = RuntimeSettings(server_url=manifest['origin'], user_id=owner['id'],
        device_id=device_id, session_id=completed['session_id'], device_public_key=public,
        server_public_key=completed['server_public_key'], session_token_ref=remember(completed['session_token']),
        device_key_ref=remember(base64.b64encode(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode()),
        mcp_config_path=str(mcp_config), roots=[{'logical_root': '/fixture', 'physical_root': str(work)}],
        rules={'local.python': 'always_allow', 'local.mcp.fixture.echo': 'always_allow'})
    config = work / 'settings.json'
    settings.save(config)
    controller = load_controller(config, private_key=key, audit=LocalAuditLog(db_path=work / 'audit.db'))
    controller.client.task_guard = TaskGuard(work / 'tasks.db')
    controller.client.receipt_ledger = ReceiptLedger(work / 'receipts.db')
    controller.client.user_id = owner['id']
    controller.start()
    wait(lambda: controller.status().connection == 'connected', 'pinned signed broker HELLO')
    wait(lambda: count.parent.joinpath('mcp.pid').exists(), 'real stdio MCP initialization')
    echo = dispatch('echo', {'value': 'T106-INDEPENDENT-ECHO'})
    assert echo['result'] == 'T106-INDEPENDENT-ECHO'
    mcp = dispatch('local.mcp.fixture.echo', {'arguments': {'value': 'T106-INDEPENDENT-MCP'}})
    assert mcp['result']['content'] == [{'type': 'text', 'text': 'T106-INDEPENDENT-MCP'}]
    assert count.read_text() == 'T106-INDEPENDENT-MCP\n'
    script = "from pathlib import Path; Path('python-result.txt').write_text('T106-INDEPENDENT-PYTHON'); print('T106-INDEPENDENT-PYTHON')"
    python = dispatch('local.python', {'working_root': '/fixture', 'script': script, 'timeout': 30})
    assert python['result']['stdout'].strip() == 'T106-INDEPENDENT-PYTHON'
    assert (work / 'python-result.txt').read_text() == 'T106-INDEPENDENT-PYTHON'
    controller.set_rule('local.mcp.fixture.echo', CapabilityRule.DENY)
    dispatch('local.mcp.fixture.echo', {'arguments': {'value': 'MUST-NOT-EXECUTE'}}, expected='denied')
    assert count.read_text() == 'T106-INDEPENDENT-MCP\n'
    controller.stop()
    controller = None
    evidence['status'] = 'passed'
except BaseException as error:
    evidence['status'], evidence['failure'] = 'failed', str(error)
    save()
    raise
finally:
    cleanup_errors = []
    try:
        if controller is not None:
            controller.stop()
    except Exception as error:
        cleanup_errors.append('Runtime stop: ' + str(error))
    try:
        if device_id:
            evidence['deviceCleanupStatus'] = request(f'/api/devices/{device_id}/revoke', {})[0]
    except Exception as error:
        cleanup_errors.append('Device revoke: ' + str(error))
    for ref in references:
        try:
            secure.delete(ref)
        except Exception as error:
            cleanup_errors.append('Credential cleanup: ' + type(error).__name__)
    try:
        if temporary is not None:
            temporary.cleanup()
    except Exception as error:
        cleanup_errors.append('Temporary directory: ' + str(error))
    evidence['credentialCleanup'] = {'removed': len(references)}
    if cleanup_errors:
        evidence['cleanupErrors'] = cleanup_errors
        evidence['status'] = 'failed'
    save()
if evidence['status'] != 'passed':
    raise SystemExit(1)
print(json.dumps({'status': evidence['status'], 'cases': len(evidence['cases']), 'deviceId': device_id}))
