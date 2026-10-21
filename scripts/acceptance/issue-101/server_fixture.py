"""Reuse issue100's real isolated Gateway/model fixture with restart + lost ACK.

Only this fixture intercepts the WebSocket acknowledgment. Product admission,
execution, archive validation, DB commits and signed upload all run unchanged.
The same synthetic users/profiles are used by issue100's credential helper.
"""
from pathlib import Path

source = (Path(__file__).resolve().parents[1] / 'issue-100/server_fixture.py').read_text(encoding='utf-8')


def replace(old, new):
    global source
    assert source.count(old) == 1, 'Issue100 fixture changed; reverify adaptation'
    source = source.replace(old, new)


replace('state.mkdir(parents=True, exist_ok=False)', 'state.mkdir(parents=True, exist_ok=True)')
replace('desktop.mkdir(parents=True, exist_ok=False)', 'desktop.mkdir(parents=True, exist_ok=True)')
replace("AUTH_JWT_SECRET=secrets.token_urlsafe(32)", "AUTH_JWT_SECRET=fixture_jwt")
replace("os.environ.update(PYTHON_DOTENV_DISABLED='1'", """jwt_path = state / 'fixture-jwt.key'
if not jwt_path.exists():
    descriptor = os.open(jwt_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(secrets.token_urlsafe(32))
fixture_jwt = jwt_path.read_text()
os.environ.update(PYTHON_DOTENV_DISABLED='1'""")
replace("listener.bind(('127.0.0.1', 0))", """previous = json.loads((desktop / 'ready.json').read_text()) if (desktop / 'ready.json').exists() else None
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
port = int(previous['origin'].rsplit(':', 1)[1]) if previous else 0
listener.bind(('127.0.0.1', port))""")
replace('worker = threading.Thread', """from app.device_control.broker import get_device_broker
broker = get_device_broker()
original_attach = broker.attach
def record_receipt_event(value):
    with (desktop / 'receipt-events.jsonl').open('a') as output:
        output.write(json.dumps(value) + '\\n')
async def attach_with_network_fault(connection):
    original_send = connection.websocket.send_text
    async def send(text):
        frame = json.loads(text)
        if frame.get('type') == 'receipt_ack' and (desktop / 'drop-acks').exists():
            record_receipt_event({'event': 'ack-dropped', 'task_id': frame.get('task_id'), **frame['payload']})
            # Archive commit already happened; acknowledgment is lost in transit.
            return
        await original_send(text)
        if frame.get('type') == 'receipt_ack':
            record_receipt_event({'event': 'ack-sent', 'task_id': frame.get('task_id'), **frame['payload']})
    connection.websocket.send_text = send
    return await original_attach(connection)
broker.attach = attach_with_network_fault
original_receive = broker.receive
async def receive_with_evidence(connection, envelope):
    if str(envelope.type) == 'receipt_upload' and (desktop / 'hold-uploads').exists():
        record_receipt_event({'event': 'upload-dropped-before-archive', 'task_id': envelope.task_id,
            'owner_id': connection.owner_id})
        return None
    try:
        return await original_receive(connection, envelope)
    except Exception as error:
        if str(envelope.type) == 'receipt_upload':
            record_receipt_event({'event': 'rejected', 'task_id': envelope.task_id,
                'owner_id': connection.owner_id, 'error_code': getattr(error, 'code', type(error).__name__)})
        raise
broker.receive = receive_with_evidence
restart_requested = False
previous_disabled = None
worker = threading.Thread""")
replace('        identities = {}', "        identities = previous['identities'] if previous else {}")
replace("        for label in ('A', 'B'):", "        for label in (() if previous else ('A', 'B')):")
replace("        print('READY', flush=True)", """        generation_path = desktop / 'generation.json'
        generation = json.loads(generation_path.read_text())['generation'] + 1 if generation_path.exists() else 1
        generation_path.write_text(json.dumps({'generation': generation, 'pid': os.getpid()}))
        print('READY', flush=True)""")
replace("        while not (desktop / 'stop').exists():", """        while not (desktop / 'stop').exists():
            disabled = (desktop / 'disable-A').exists()
            if disabled != previous_disabled:
                async def set_fixture_identity():
                    from app.agentplatform.rbac_models import UserModel
                    from deerflow.persistence.engine import get_session_factory
                    async with get_session_factory()() as session:
                        identity = await session.get(UserModel, identities['A']['id'])
                        identity.disabled = disabled
                        await session.commit()
                asyncio.run(set_fixture_identity())
                previous_disabled = disabled
                (desktop / 'identity-state.json').write_text(json.dumps({'disabledA': disabled}))
            if (desktop / 'restart-request').exists():
                (desktop / 'restart-request').unlink()
                restart_requested = True
                break""")
source += """
if restart_requested:
    # A new interpreter recreates the Gateway, broker and database sessions.
    os.execv(sys.executable, [sys.executable, __file__, *sys.argv[1:]])
"""
exec(compile(source, str(Path(__file__).resolve()), 'exec'))
