"""Issue 102 writes through signed Runtime frames and actual local files."""
import asyncio
import hashlib
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.consent_coord import ConsentDecisionError
from core.file_service import WorkspaceFileService, WorkspaceSelection
from core.protocol import MessageType, public_key_text, sign_envelope
from core.receipt_ledger import ReceiptLedger
from core.settings import RuntimeSettings
from core.task_guard import TaskGuard
from core.transport import LocalRuntimeClient
from core.tray import TrayController
from server_protocol import MessageType as ServerMessageType, sign_envelope as server_sign


@pytest.mark.parametrize('scenario,expected', [
    ('allow', 'completed'), ('reject', 'DENIED'), ('timeout', 'DENIED'),
    ('wrong-hash', 'DENIED'), ('remote', 'DENIED'), ('deny', 'LOCAL_POLICY_DENIED'),
    ('outside', 'OUTSIDE_ALLOWED_ROOTS'), ('protected', 'PROTECTED_PATH'),
    ('admission', 'RECEIPT_STORAGE_UNAVAILABLE'), ('completion', 'RESULT_UNCERTAIN'),
    ('expiry', 'DENIED'), ('cancel-before', 'CANCELLED'),
    ('directory-changed', 'OUTSIDE_ALLOWED_ROOTS'), ('identity-changed', 'WORKSPACE_UNAVAILABLE'),
    ('cancel-after', 'completed'), ('disconnect-after', 'completed'),
    ('deny-after', 'LOCAL_POLICY_DENIED'), ('missing-ledger', 'RECEIPT_STORAGE_UNAVAILABLE'),
    ('readback', 'RESULT_UNCERTAIN'),
    ('completion-followup', 'RESULT_UNCERTAIN'), ('pending-storage', 'RECEIPT_STORAGE_UNAVAILABLE'),
    ('restart-recovery', 'completed'),
    ('readback-cancel', 'result_not_verified'),
    ('duplicate-after', 'TASK_REPLAYED'),
    ('local-stop', 'CANCELLED'),
])
def test_signed_write_requires_exact_local_approval_and_durable_admission(tmp_path, monkeypatch, scenario, expected):
    async def run():
        broker_key, device_key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        config, work = tmp_path / 'profile' / 'settings.json', tmp_path / 'work'
        work.mkdir()
        target = work / 'target.txt'
        target.write_bytes(b'BEFORE')
        settings = RuntimeSettings(server_url='https://test.invalid', user_id='account-102', device_id='device-102',
            device_public_key=public_key_text(device_key), server_public_key=public_key_text(broker_key))
        if scenario == 'deny':
            settings.rules['local.files.write'] = 'deny'
        settings.save(config)
        selection = WorkspaceSelection(config)
        root = selection.select(str(work), confirmed=True)['logicalRoot']
        if scenario in {'readback', 'readback-cancel'}:
            from core.file_service import WorkspaceFileStore
            from core.files import FileAccessError
            def unavailable_readback(*args, **kwargs):
                raise FileAccessError('PERMISSION_DENIED')
            monkeypatch.setattr(WorkspaceFileStore, 'read_bytes', unavailable_readback)
        ledger = ReceiptLedger(config.with_name('receipts.db'))
        if scenario == 'restart-recovery':
            ledger.admit({}, {'task_id': 'prior-uncertain', 'run_id': 'prior-run'})
            ledger = ReceiptLedger(config.with_name('receipts.db'))
        if scenario == 'admission':
            ledger.path = Path(ledger.path).as_uri() + '?mode=ro'
        elif scenario in {'completion', 'completion-followup', 'pending-storage'}:
            with sqlite3.connect(ledger.path) as db:
                db.execute("CREATE TRIGGER no_completion BEFORE UPDATE ON local_receipts BEGIN SELECT RAISE(FAIL, 'fixture disk full'); END")
        if scenario in {'timeout', 'remote'}:
            monkeypatch.setattr('core.consent_coord.CONSENT_TIMEOUT_SECONDS', 0.05)
        prompts, outcomes = [], []
        finished = asyncio.Event()
        release_approval = asyncio.Event()
        result_delivery_started = asyncio.Event()
        if scenario in {'cancel-after', 'disconnect-after', 'readback-cancel'}:
            from websockets.asyncio.client import ClientConnection
            original_send = ClientConnection.send
            async def interrupt_result_delivery(connection, message, *args, **kwargs):
                frame = json.loads(message) if isinstance(message, str) else {}
                if frame.get('type') == 'task_result' or (scenario == 'readback-cancel' and frame.get('type') == 'error' and frame.get('payload', {}).get('error_code') == 'RESULT_UNCERTAIN'):
                    # Fault at the public socket boundary after the actual
                    # write and its durable receipt, before result delivery.
                    result_delivery_started.set()
                    await asyncio.Event().wait()
                return await original_send(connection, message, *args, **kwargs)
            monkeypatch.setattr(ClientConnection, 'send', interrupt_result_delivery)

        async def prompt(pending):
            prompts.append(pending)
            assert pending.silenceable is False
            if scenario == 'pending-storage':
                await release_approval.wait()
            if scenario in {'timeout', 'remote'}:
                await asyncio.Event().wait()
            if scenario == 'expiry':
                await asyncio.sleep(0.2)
            if scenario in {'cancel-before', 'local-stop'}:
                await asyncio.Event().wait()
            if scenario == 'directory-changed':
                selection.select(str(work), confirmed=True)
            if scenario == 'identity-changed':
                settings.user_id = 'different-owner'
                settings.save(config)
            if scenario == 'deny-after':
                from core.settings import load_settings
                current = load_settings(config)
                current.rules['local.files.write'] = 'deny'
                current.save(config)
            if scenario == 'wrong-hash':
                with pytest.raises(ConsentDecisionError):
                    client.resolve_local_consent(pending.task_id, approved=True, expected_hash='0' * 64)
            # Changing a renderable view cannot alter the approved task bytes.
            pending.payload['arguments']['content'] = 'TAMPERED'
            return {'approved': scenario not in {'reject', 'wrong-hash'}, 'always': True}

        async def broker(socket):
            hello = json.loads(await socket.recv())
            def frame(kind, payload, task_id=None):
                if scenario == 'expiry' and kind is MessageType.TASK:
                    return json.dumps(server_sign(private_key=broker_key, message_type=ServerMessageType.TASK,
                        device_id='device-102', session_id=hello['session_id'], task_id=task_id, payload=payload,
                        expires_at=datetime.now(timezone.utc) + timedelta(seconds=0.1)).model_dump(mode='json', by_alias=True))
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind,
                    device_id='device-102', session_id=hello['session_id'], task_id=task_id, payload=payload))
            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key), 'receipt_replay': 1}))
            if scenario == 'restart-recovery':
                # A metadata-only ACK must not clear the restart safety latch.
                await socket.send(frame(MessageType.RECEIPT_ACK, {'receipt_id': 'unknown', 'receipt_hash': 'unknown', 'acknowledgment': 'fixture'}))
            path = '/outside/target.txt' if scenario == 'outside' else root + ('/.env' if scenario == 'protected' else '/target.txt')
            original_task = frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-102',
                'thread_id': 'thread-102', 'tool_call_id': 'call-102', 'arguments': {'path': path, 'content': 'AFTER\n'}}, 'task-102')
            await socket.send(original_task)
            async def interrupt_after_effect():
                await result_delivery_started.wait()
                if scenario in {'cancel-after', 'readback-cancel'}:
                    await socket.send(frame(MessageType.TASK_CANCEL, {}, 'task-102'))
                    await asyncio.sleep(0.05)
                await socket.close()
                finished.set()
            interruption = asyncio.create_task(interrupt_after_effect()) if scenario in {'cancel-after', 'disconnect-after', 'readback-cancel'} else None
            async for raw in socket:
                value = json.loads(raw)
                if value['type'] == 'consent_required' and scenario == 'pending-storage':
                    await socket.send(frame(MessageType.TASK, {'operation': 'local.files.read', 'run_id': 'run-102',
                        'tool_call_id': 'read-102', 'arguments': {'path': path}}, 'read-102'))
                if value['type'] == 'error' and value['task_id'] == 'read-102' and scenario == 'pending-storage':
                    release_approval.set()
                    continue
                if value['type'] == 'consent_required' and scenario == 'cancel-before':
                    await socket.send(frame(MessageType.TASK_CANCEL, {}, 'task-102'))
                if value['type'] == 'consent_required' and scenario == 'local-stop':
                    await client.stop_run('run-102')
                if value['type'] == 'consent_required' and scenario == 'remote':
                    await socket.send(frame(MessageType.CONSENT_DECISION, {'approved': True,
                        'request_hash': value['payload']['request_hash']}, 'task-102'))
                if value['type'] in {'task_result', 'error'}:
                    outcomes.append(value)
                    if scenario == 'duplicate-after' and len(outcomes) == 1:
                        await socket.send(original_task)
                        continue
                    if scenario == 'local-stop' and len(outcomes) == 1:
                        await socket.send(frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-102',
                            'thread_id': 'thread-102', 'tool_call_id': 'next-call',
                            'arguments': {'path': path, 'content': 'SECOND'}}, 'next-task'))
                        continue
                    if scenario == 'restart-recovery' and len(outcomes) == 1:
                        assert value['payload']['error_code'] == 'RECEIPT_STORAGE_UNAVAILABLE'
                        await socket.send(frame(MessageType.TASK, {'operation': 'local.files.read', 'run_id': 'run-102',
                            'tool_call_id': 'read-102', 'arguments': {'path': path}}, 'read-102'))
                        continue
                    if scenario == 'restart-recovery' and len(outcomes) == 2:
                        assert value['type'] == 'task_result'
                        assert value['payload']['result']['content'] == 'BEFORE'
                        await socket.send(frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-102',
                            'thread_id': 'thread-102', 'tool_call_id': 'second-102', 'arguments': {'path': path, 'content': 'AFTER\n'}}, 'second-102'))
                        continue
                    if scenario == 'completion-followup' and len(outcomes) == 1:
                        await socket.send(frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-102',
                            'thread_id': 'thread-102', 'tool_call_id': 'second-102', 'arguments': {'path': path, 'content': 'SECOND'}}, 'second-102'))
                        continue
                    finished.set()
                    return
            if interruption:
                await interruption

        async with serve(broker, '127.0.0.1', 0) as server:
            client = LocalRuntimeClient(server_url=f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}',
                device_id='device-102', user_id='account-102', session_token='synthetic', private_key=device_key,
                server_public_key=public_key_text(broker_key), receipt_ledger=None if scenario == 'missing-ledger' else ledger,
                task_guard=TaskGuard(config.with_name('tasks.db')), file_service=WorkspaceFileService(selection), consent_prompt=prompt)
            running = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(finished.wait(), 5)
            finally:
                await client.shutdown()
                await asyncio.gather(running, return_exceptions=True)
        if scenario in {'cancel-after', 'disconnect-after'}:
            assert target.read_bytes() == b'AFTER\n'
            assert outcomes == []
            receipt, = ledger.pending(client.receipt_binding())
            assert receipt['receipt']['status'] == 'completed'
            assert receipt['receipt']['consent_decision'] == 'approved'
            return
        if scenario == 'readback-cancel':
            assert target.read_bytes() == b'AFTER\n'
            assert outcomes == []
            receipt, = ledger.pending(client.receipt_binding())
            assert receipt['receipt']['status'] == 'result_not_verified'
            assert receipt['receipt']['error_code'] == 'RESULT_UNCERTAIN'
            assert receipt['receipt']['consent_decision'] == 'approved'
            assert receipt['receipt']['run_id'] == 'run-102'
            assert receipt['receipt']['task_id'] == 'task-102'
            assert receipt['receipt']['request_hash'] == receipt['task']['request_hash']
            assert receipt['receipt']['payload_hash'] == receipt['task']['request_hash']
            return
        if scenario == 'completion-followup':
            first, second = outcomes
            assert first['payload']['error_code'] == 'RESULT_UNCERTAIN'
            assert second['payload']['error_code'] == 'RECEIPT_STORAGE_UNAVAILABLE'
            assert target.read_bytes() == b'AFTER\n'
            assert len(prompts) == 1
            return
        if scenario == 'restart-recovery':
            assert len(outcomes) == 3
            assert outcomes[-1]['payload']['receipt']['status'] == 'completed'
            assert target.read_bytes() == b'AFTER\n'
            assert len(prompts) == 1
            assert ledger.error == ''
            return
        if scenario == 'duplicate-after':
            assert outcomes[0]['payload']['receipt']['status'] == 'completed'
            assert outcomes[1]['payload']['error_code'] == 'TASK_REPLAYED'
            assert 'receipt' not in outcomes[1]['payload']
            assert target.read_bytes() == b'AFTER\n'
            assert len(prompts) == 1
            saved, = ledger.pending(client.receipt_binding())
            assert saved['receipt']['status'] == 'completed'
            return
        if scenario == 'local-stop':
            assert [row['payload']['error_code'] for row in outcomes] == ['CANCELLED', 'CANCELLED']
            assert target.read_bytes() == b'BEFORE'
            assert len(prompts) == 1
            assert TaskGuard(config.with_name('tasks.db')).run_stopped('device-102', 'run-102')
            assert not TaskGuard(config.with_name('tasks.db')).run_stopped('another-device', 'run-102')
            return
        outcome, = outcomes
        assert outcome['payload'].get('error_code', outcome['payload'].get('receipt', {}).get('status')) == expected
        assert target.read_bytes() == (b'AFTER\n' if scenario in {'allow', 'completion', 'readback'} else b'BEFORE')
        if scenario == 'allow':
            assert outcome['payload']['result']['sha256'] == hashlib.sha256(b'AFTER\n').hexdigest()
            assert outcome['payload']['receipt']['run_id'] == 'run-102'
            assert outcome['payload']['receipt']['consent_decision'] == 'approved'
        if scenario == 'completion':
            assert ledger.history(client.receipt_binding())[0]['delivery_state'] == 'uncertain'
        if scenario == 'readback':
            receipt, = ledger.pending(client.receipt_binding())
            assert receipt['receipt']['status'] == 'result_not_verified'
            assert receipt['receipt']['error_code'] == 'RESULT_UNCERTAIN'
            assert receipt['receipt']['consent_decision'] == 'approved'
            assert receipt['receipt']['run_id'] == 'run-102'
            assert receipt['receipt']['task_id'] == 'task-102'
            assert receipt['receipt']['request_hash'] == receipt['task']['request_hash']
            assert receipt['receipt']['payload_hash'] == receipt['task']['request_hash']
    asyncio.run(run())


def test_desktop_ui_snapshots_remain_usable_during_signed_consent_churn(tmp_path):
    """Stress the public controller while its owned loop adds/removes requests.

    This is concurrency coverage, not a claimed deterministic reproduction of
    the former cross-thread dictionary iteration race.
    """
    async def run():
        broker_key, device_key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        config, work = tmp_path / 'profile' / 'settings.json', tmp_path / 'work'
        work.mkdir()
        finished = asyncio.Event()
        outcomes = []
        root = ''

        async def broker(socket):
            hello = json.loads(await socket.recv())
            def frame(kind, payload, task_id=None):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind,
                    device_id='device-102', session_id=hello['session_id'], task_id=task_id, payload=payload))
            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key), 'receipt_replay': 1}))
            for index in range(30):
                task_id = f'churn-{index}'
                await socket.send(frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-102',
                    'thread_id': 'thread-102', 'tool_call_id': task_id,
                    'arguments': {'path': root + '/target.txt', 'content': 'MUST-NOT-WRITE'}}, task_id))
                async for raw in socket:
                    value = json.loads(raw)
                    if value['type'] == 'consent_required' and value['task_id'] == task_id:
                        await asyncio.sleep(0.002)
                        await socket.send(frame(MessageType.TASK_CANCEL, {}, task_id))
                    if value['type'] == 'error' and value['task_id'] == task_id:
                        outcomes.append(value['payload']['error_code'])
                        break
            finished.set()
            await socket.wait_closed()

        async with serve(broker, '127.0.0.1', 0) as server:
            settings = RuntimeSettings(server_url=f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}',
                user_id='account-102', device_id='device-102', session_token='synthetic',
                server_public_key=public_key_text(broker_key), device_public_key=public_key_text(device_key),
                secret_backend='memory', config_path=str(config))
            settings.save(config)
            root = WorkspaceSelection(config).select(str(work), confirmed=True)['logicalRoot']
            controller = TrayController(settings=settings, private_key=device_key, desktop_mode=True)
            controller.client.receipt_ledger = ReceiptLedger(config.with_name('receipts.db'))
            snapshots = []
            try:
                assert controller.pending_consents() == ()
                await asyncio.to_thread(controller.start)
                async def poll():
                    while not finished.is_set():
                        rows = await asyncio.to_thread(controller.pending_consents)
                        assert isinstance(rows, tuple)
                        snapshots.append(rows)
                        await asyncio.to_thread(controller.status)
                await asyncio.wait_for(poll(), 10)
            finally:
                await asyncio.to_thread(controller.stop)
            assert controller.pending_consents() == ()
            assert len(snapshots) >= 10
            assert any(snapshots)
            assert outcomes == ['CANCELLED'] * 30
            assert not (work / 'target.txt').exists()
    asyncio.run(run())
