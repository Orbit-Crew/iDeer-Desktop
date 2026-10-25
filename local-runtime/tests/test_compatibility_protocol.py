"""Signed real WebSocket tasks across a controlled HTTP compatibility document."""
import asyncio
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from core.compatibility import CompatibilityGate
from core.file_service import LocalFileService
from core.files import LocalFileStore, RootConfig
from core.policy import LocalPolicy
from core.protocol import MessageType, public_key_text, sign_envelope
from core.receipt_ledger import ReceiptLedger
from core.task_guard import TaskGuard
from core.settings import RuntimeSettings
from core.transport import LocalRuntimeClient


@pytest.mark.parametrize('level,disabled,min_protocol,error,operation,deny', [
    ('compatible', [], 1, '', 'local.files.write', False),
    ('capability', ['local.files.write'], 1, 'COMPAT_CAPABILITY_DISABLED', 'local.files.write', False),
    ('core', [], 1, 'COMPAT_CORE_INCOMPATIBLE', 'local.files.write', False),
    ('compatible', [], 2, 'COMPAT_PROTOCOL_INCOMPATIBLE', 'local.files.write', False),
    ('capability', ['local.files.write'], 1, '', 'echo', False),
    ('compatible', [], 1, 'LOCAL_POLICY_DENIED', 'local.files.write', True),
    ('unpublished', [], 1, '', 'local.files.write', False),
])
def test_effective_gate_checks_the_signed_operation_before_any_file_effect(tmp_path, level, disabled, min_protocol, error, operation, deny):
    async def run():
        broker_key, device_key, release_key = [Ed25519PrivateKey.generate() for _ in range(3)]
        public = tmp_path / 'release.pem'
        public.write_bytes(release_key.public_key().public_bytes(serialization.Encoding.PEM,
                                                               serialization.PublicFormat.SubjectPublicKeyInfo))
        declaration = json.dumps(dict(version=1, level=level, disabledCapabilities=disabled,
            minProtocol=min_protocol, notes='Controlled contract fixture',
            candidateCombo=dict(desktop='0.2.0', runtime='3.12.14', server='fixture-server'))).encode()
        signature = release_key.sign(declaration).hex().encode()
        finished = asyncio.Event()
        results = []

        async def http(connection, request):
            if request.path.startswith('/updates/compatibility.'):
                if level == 'unpublished':
                    return Response(404, 'Not Found', Headers(), b'')
                body = signature if request.path.endswith('.sig') else declaration
                return Response(200, 'OK', Headers({'Content-Type': 'application/json',
                    'Content-Length': str(len(body))}), body)

        async def broker(socket):
            hello = json.loads(await socket.recv())

            def frame(kind, payload, task_id=None):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind,
                    device_id='device-110', session_id=hello['session_id'], task_id=task_id, payload=payload))

            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key),
                                                      'server_version': 'fixture-server'}))
            await socket.send(frame(MessageType.TASK, {'operation': operation, 'value': 'T110-ECHO',
                'run_id': 'run-110', 'path': '/fixture/result.txt', 'content': 'T110-APPROVED'}, 'write-110'))
            async for raw in socket:
                value = json.loads(raw)
                if value['type'] in {'task_result', 'error'}:
                    results.append(value)
                    finished.set()
                    return

        async with serve(broker, '127.0.0.1', 0, process_request=http) as server:
            port = server.sockets[0].getsockname()[1]
            config = tmp_path / 'settings.json'
            RuntimeSettings(server_url=f'http://127.0.0.1:{port}', user_id='user-110', device_id='device-110',
                device_public_key=public_key_text(device_key), server_public_key=public_key_text(broker_key)).save(config)
            gate = CompatibilityGate(config, desktop_version='0.2.0', runtime_python='3.12.14', public_key_path=public)
            policy = LocalPolicy(always_allow_capabilities=frozenset({'local.files.write'}),
                                 denied_capabilities=frozenset({'local.files.write'} if deny else ()))
            client = LocalRuntimeClient(server_url=f'ws://127.0.0.1:{port}', device_id='device-110',
                private_key=device_key, session_token='synthetic', server_public_key=public_key_text(broker_key),
                user_id='user-110',
                file_service=LocalFileService(LocalFileStore([RootConfig('/fixture', tmp_path)]), policy=policy),
                policy=policy, compatibility_gate=gate)
            running = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(finished.wait(), 10)
            finally:
                await client.shutdown()
                await asyncio.gather(running, return_exceptions=True)
        if error:
            assert results[0]['type'] == 'error'
            assert results[0]['payload']['error_code'] == error
            assert not (tmp_path / 'result.txt').exists()
        else:
            assert results[0]['type'] == 'task_result'
            if operation == 'echo':
                assert results[0]['payload']['result'] == 'T110-ECHO'
                assert not (tmp_path / 'result.txt').exists()
            else:
                assert (tmp_path / 'result.txt').read_text() == 'T110-APPROVED'

    asyncio.run(run())


def test_a_seen_core_declaration_cannot_disappear_across_a_new_runtime_instance(tmp_path):
    async def run():
        broker_key, device_key, release_key = [Ed25519PrivateKey.generate() for _ in range(3)]
        public = tmp_path / 'release.pem'
        public.write_bytes(release_key.public_key().public_bytes(serialization.Encoding.PEM,
                                                               serialization.PublicFormat.SubjectPublicKeyInfo))
        document = json.dumps(dict(version=1, level='core', disabledCapabilities=[], minProtocol=1,
            notes='Published core stop', candidateCombo=dict(desktop='0.2.0', runtime='3.12.14', server='fixture-server'))).encode()
        signature = release_key.sign(document).hex().encode()
        state = {'published': True}
        outcomes = asyncio.Queue()

        async def http(connection, request):
            if request.path.startswith('/updates/compatibility.'):
                body = signature if request.path.endswith('.sig') else document
                return Response(200, 'OK', Headers({'Content-Length': str(len(body))}), body) if state['published'] else Response(404, 'Not Found', Headers(), b'')

        async def broker(socket):
            hello = json.loads(await socket.recv())
            await socket.send(json.dumps(sign_envelope(private_key=broker_key, message_type=MessageType.HELLO,
                device_id='device-110', session_id=hello['session_id'], payload={
                    'server_public_key': public_key_text(broker_key), 'server_version': 'fixture-server'})))
            await socket.send(json.dumps(sign_envelope(private_key=broker_key, message_type=MessageType.TASK,
                device_id='device-110', session_id=hello['session_id'], task_id='new-task',
                payload={'operation': 'echo', 'value': 'MUST-NOT-EXECUTE', 'run_id': 'run-110'})))
            async for raw in socket:
                value = json.loads(raw)
                if value['type'] in {'task_result', 'error'}:
                    await outcomes.put(value)
                    return

        async with serve(broker, '127.0.0.1', 0, process_request=http) as server:
            port = server.sockets[0].getsockname()[1]
            config = tmp_path / 'settings.json'
            RuntimeSettings(server_url=f'http://127.0.0.1:{port}', user_id='user-110', device_id='device-110',
                device_public_key=public_key_text(device_key), server_public_key=public_key_text(broker_key)).save(config)
            for published, expected in [(True, 'COMPAT_CORE_INCOMPATIBLE'), (False, 'COMPAT_DECLARATION_MISSING')]:
                state['published'] = published
                gate = CompatibilityGate(config, desktop_version='0.2.0', runtime_python='3.12.14', public_key_path=public)
                client = LocalRuntimeClient(server_url=f'ws://127.0.0.1:{port}', device_id='device-110',
                    user_id='user-110', private_key=device_key, session_token='synthetic',
                    server_public_key=public_key_text(broker_key), compatibility_gate=gate)
                running = asyncio.create_task(client.run())
                try:
                    value = await asyncio.wait_for(outcomes.get(), 10)
                    assert value['type'] == 'error'
                    assert value['payload']['error_code'] == expected
                finally:
                    await client.shutdown()
                    await asyncio.gather(running, return_exceptions=True)

    asyncio.run(run())


def test_core_gate_preserves_and_replays_the_original_unconfirmed_write_receipt(tmp_path):
    async def run():
        broker_key, device_key, release_key = [Ed25519PrivateKey.generate() for _ in range(3)]
        public = tmp_path / 'release.pem'
        public.write_bytes(release_key.public_key().public_bytes(serialization.Encoding.PEM,
                                                               serialization.PublicFormat.SubjectPublicKeyInfo))
        state = {'level': 'compatible', 'task': 'original-write'}
        outcomes, replays = asyncio.Queue(), asyncio.Queue()

        async def http(connection, request):
            if request.path.startswith('/updates/compatibility.'):
                text = json.dumps(dict(version=1, level=state['level'], disabledCapabilities=[], minProtocol=1,
                    notes='Receipt preservation contract', candidateCombo=dict(
                        desktop='0.2.0', runtime='3.12.14', server='fixture-server'))).encode()
                body = release_key.sign(text).hex().encode() if request.path.endswith('.sig') else text
                return Response(200, 'OK', Headers({'Content-Length': str(len(body))}), body)

        async def broker(socket):
            hello = json.loads(await socket.recv())

            def frame(kind, payload, task_id=None):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind, device_id='device-110',
                    session_id=hello['session_id'], task_id=task_id, payload=payload))

            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key),
                'server_version': 'fixture-server', 'receipt_replay': 1}))
            await socket.send(frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-110',
                'path': '/fixture/result.txt', 'content': 'T110-ORIGINAL'}, state['task']))
            got_result, got_replay = False, False
            async for raw in socket:
                value = json.loads(raw)
                if value['type'] in {'task_result', 'error'}:
                    await outcomes.put(value)
                    got_result = True
                if value['type'] == 'receipt_upload' and value['payload']['task']['task_id'] == 'original-write':
                    await replays.put(value['payload'])
                    got_replay = True
                if got_result and got_replay:
                    return

        async with serve(broker, '127.0.0.1', 0, process_request=http) as server:
            port = server.sockets[0].getsockname()[1]
            config = tmp_path / 'settings.json'
            RuntimeSettings(server_url=f'http://127.0.0.1:{port}', user_id='user-110', device_id='device-110',
                device_public_key=public_key_text(device_key), server_public_key=public_key_text(broker_key)).save(config)
            original = None
            for level, task_id in [('compatible', 'original-write'), ('core', 'new-write')]:
                state.update(level=level, task=task_id)
                policy = LocalPolicy(always_allow_capabilities=frozenset({'local.files.write'}))
                client = LocalRuntimeClient(server_url=f'ws://127.0.0.1:{port}', device_id='device-110',
                    user_id='user-110', private_key=device_key, session_token='synthetic',
                    server_public_key=public_key_text(broker_key), policy=policy,
                    file_service=LocalFileService(LocalFileStore([RootConfig('/fixture', tmp_path)]), policy=policy),
                    receipt_ledger=ReceiptLedger(tmp_path / 'receipts.db'), task_guard=TaskGuard(tmp_path / 'tasks.db'),
                    compatibility_gate=CompatibilityGate(config, desktop_version='0.2.0', runtime_python='3.12.14', public_key_path=public))
                running = asyncio.create_task(client.run())
                try:
                    result = await asyncio.wait_for(outcomes.get(), 10)
                    replay = await asyncio.wait_for(replays.get(), 10)
                    if level == 'compatible':
                        assert result['type'] == 'task_result'
                        original = replay
                    else:
                        assert result['payload']['error_code'] == 'COMPAT_CORE_INCOMPATIBLE'
                        assert replay == original
                    assert (tmp_path / 'result.txt').read_text() == 'T110-ORIGINAL'
                finally:
                    await client.shutdown()
                    await asyncio.gather(running, return_exceptions=True)

    asyncio.run(run())
