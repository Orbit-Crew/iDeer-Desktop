"""Issue 108: the update drain gate refuses new tasks without side effects."""
import asyncio
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.file_service import WorkspaceFileService, WorkspaceSelection
from core.protocol import MessageType, public_key_text, sign_envelope
from core.receipts import content_hash
from core.receipt_ledger import ReceiptLedger
from core.settings import RuntimeSettings
from core.task_guard import TaskGuard
from core.transport import LocalRuntimeClient


def task_frame(key, session_id, task_id, logical_root, content='T108-PAYLOAD'):
    return json.dumps(sign_envelope(private_key=key, message_type=MessageType.TASK,
        device_id='device-108', session_id=session_id, task_id=task_id,
        payload={'operation': 'local.files.write', 'run_id': 'run-' + task_id, 'thread_id': 'thread-108',
                 'tool_call_id': 'call-' + task_id, 'arguments': {'path': logical_root + '/out.txt', 'content': content}}))


@pytest.mark.parametrize('mode', ['drain-rejects-new-task', 'abort-restores-admission'])
def test_drain_gate_controls_task_admission(tmp_path, mode):
    """A drained device refuses dispatch without claiming or writing; abort reopens."""
    async def run():
        broker_key, device_key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        config, work = tmp_path / 'profile' / 'settings.json', tmp_path / 'work'
        work.mkdir()
        settings = RuntimeSettings(server_url='https://test.invalid', user_id='account-108', device_id='device-108',
            device_public_key=public_key_text(device_key), server_public_key=public_key_text(broker_key))
        settings.save(config)
        selection = WorkspaceSelection(config)
        logical_root = selection.select(str(work), confirmed=True)['logicalRoot']
        selection.allow_write()
        first_done, drained, during_done, aborted, finished = (asyncio.Event() for _ in range(5))
        results = {}

        async def broker(socket):
            hello = json.loads(await socket.recv())

            def frame(kind, payload, task_id=None):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind,
                    device_id='device-108', session_id=hello['session_id'], task_id=task_id, payload=payload))
            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key), 'receipt_replay': 1}))

            async def result():
                while True:
                    raw = await socket.recv()
                    print('PROBE-BROKER raw:', raw[:120], flush=True)
                    value = json.loads(raw)
                    if value['type'] in {'task_result', 'error'}:
                        return value
            await socket.send(task_frame(broker_key, hello['session_id'], 'task-108-before', logical_root))
            first = await result()
            first_done.set()
            await drained.wait()
            await socket.send(task_frame(broker_key, hello['session_id'], 'task-108-during', logical_root))
            during = await result()
            during_done.set()
            after = None
            if mode == 'abort-restores-admission':
                await aborted.wait()
                await socket.send(task_frame(broker_key, hello['session_id'], 'task-108-after', logical_root))
                after = await result()
            results.update(first=first, during=during, after=after)
            finished.set()

        async with serve(broker, '127.0.0.1', 0) as server:
            client = LocalRuntimeClient(server_url='ws://127.0.0.1:' + str(server.sockets[0].getsockname()[1]),
                device_id='device-108', user_id='account-108', session_token='synthetic', private_key=device_key,
                server_public_key=public_key_text(broker_key), receipt_ledger=ReceiptLedger(config.with_name('receipts.db')),
                task_guard=TaskGuard(config.with_name('tasks.db')), file_service=WorkspaceFileService(selection))
            serving = asyncio.create_task(client.run())
            try:
                # The first task runs to completion; its result reaches the
                # broker before draining starts, so the queue is empty by fact.
                await asyncio.wait_for(first_done.wait(), 10)
                assert client.active_task_count() == 0, 'completed task must not stay in flight'
                client.begin_install_drain()
                assert client.install_draining is True
                drained.set()
                await asyncio.wait_for(during_done.wait(), 10)
                if mode == 'abort-restores-admission':
                    client.abort_install_drain()
                    assert client.install_draining is False
                    aborted.set()
                await asyncio.wait_for(finished.wait(), 10)
            finally:
                finished.set()
                await client.shutdown()
                await asyncio.gather(serving, return_exceptions=True)
            first, during, after = results['first'], results['during'], results['after']
        assert first['payload']['receipt']['status'] == 'completed'
        assert (work / 'out.txt').read_text(encoding='utf-8') == 'T108-PAYLOAD'
        assert during['payload']['error_code'] == 'UPDATE_DRAINING'
        # The real Server validates every write refusal against its signed
        # request, even when Runtime correctly refuses before admission.
        refused_receipt = during['payload']['receipt']
        refused_payload = json.loads(task_frame(broker_key, 'unused', 'task-108-during', logical_root))['payload']
        assert refused_receipt['run_id'] == 'run-task-108-during'
        assert refused_receipt['capability'] == 'local.files.write'
        assert refused_receipt['request_hash'] == content_hash(refused_payload)
        assert refused_receipt['payload_hash'] == content_hash(refused_payload)
        assert refused_receipt['status'] == 'denied'
        if mode == 'drain-rejects-new-task':
            assert client.task_guard.claim('device-108', 'task-108-during') is True, \
                'a drained refusal must not consume the task identity'
        else:
            assert after['payload']['receipt']['status'] == 'completed'
            assert (work / 'out.txt').read_text(encoding='utf-8') == 'T108-PAYLOAD'
    asyncio.run(asyncio.wait_for(run(), 40))
