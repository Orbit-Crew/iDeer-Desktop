"""Issue 105 local results: registered facts stay local until an explicit upload."""
import asyncio
import hashlib
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.local_results import LocalResultError, LocalResultRegistry
from core.file_service import WorkspaceFileService, WorkspaceSelection
from core.protocol import MessageType, public_key_text, sign_envelope
from core.receipt_ledger import ReceiptLedger
from core.settings import RuntimeSettings
from core.task_guard import TaskGuard
from core.transport import LocalRuntimeClient

BINDING = {"server_origin": "http://fixture.invalid", "user_id": "account-105",
           "device_id": "device-105", "device_public_key": "fixture-device-key", "broker_public_key": "fixture-broker-key"}
LOGICAL_ROOT = "/workspace/00000000-0000-0000-0000-000000000105"


def record_row(task_id="task-105", **overrides):
    row = {"thread_id": "thread-105", "run_id": "run-105", "task_id": task_id,
           "capability": "local.files.write", "logical_root": LOGICAL_ROOT,
           "logical_path": f"{LOGICAL_ROOT}/result.txt", "name": "result.txt",
           "sha256": "a" * 64, "bytes": 6}
    row.update(overrides)
    return row


def test_registry_records_one_immutable_fact_per_task_and_identity(tmp_path):
    registry = LocalResultRegistry(tmp_path / "results.db")
    assert registry.record(BINDING, record_row()) is True
    # A replayed or re-derived completion never rewrites the first registered fact.
    assert registry.record(BINDING, record_row(sha256="b" * 64)) is False
    assert registry.get(BINDING, "task-105")["sha256"] == "a" * 64
    other = {**BINDING, "user_id": "account-B"}
    assert registry.get(other, "task-105") is None
    assert registry.view(other, "thread-105") == []
    assert registry.view(BINDING, "thread-105")[0]["task_id"] == "task-105"
    # The thread view keeps the run association used by the merged task history.
    assert registry.view(BINDING, "other-thread", {"run-105"})[0]["task_id"] == "task-105"
    assert registry.view(BINDING, "other-thread", set()) == []
    assert json.dumps(registry.view(BINDING, "thread-105"))


def test_registry_upload_marking_is_idempotent_and_conflicts_only_on_other_refs(tmp_path):
    registry = LocalResultRegistry(tmp_path / "results.db")
    registry.record(BINDING, record_row())
    assert registry.mark_uploaded(BINDING, "task-105", "art-1") is True
    assert registry.mark_uploaded(BINDING, "task-105", "art-1") is False
    with pytest.raises(LocalResultError, match="RESULT_UPLOAD_CONFLICT"):
        registry.mark_uploaded(BINDING, "task-105", "art-2")
    row = registry.get(BINDING, "task-105")
    assert row["artifact_ref"] == "art-1" and row["uploaded_at"]
    with pytest.raises(LocalResultError, match="RESULT_NOT_ADMITTED"):
        registry.mark_uploaded(BINDING, "missing-task", "art-1")


def test_registry_storage_failures_use_one_fixed_category(tmp_path):
    broken = LocalResultRegistry(tmp_path / "missing" / "results.db")
    with pytest.raises(LocalResultError, match="RESULT_STORAGE_UNAVAILABLE"):
        broken.record(BINDING, record_row())
    registry = LocalResultRegistry(tmp_path / "results.db")
    registry.record(BINDING, record_row())
    registry.path = (tmp_path / "results.db").as_uri() + "?mode=ro"
    with pytest.raises(LocalResultError, match="RESULT_STORAGE_UNAVAILABLE"):
        registry.record(BINDING, record_row(task_id="second"))
    # Reads keep working; the registry never reports a write it could not durably do.
    assert registry.get(BINDING, "task-105")["task_id"] == "task-105"
    with pytest.raises(LocalResultError, match="RESULT_STORAGE_UNAVAILABLE"):
        registry.mark_uploaded(BINDING, "task-105", "art-1")
    assert registry.get(BINDING, "task-105")["artifact_ref"] == ""


@pytest.mark.parametrize('mode', ['directory', 'consent', 'outside'])
def test_signed_workspace_writes_register_local_results_once(tmp_path, mode):
    """Only completed writes register a local result; replays and denials do not."""
    async def run():
        broker_key, device_key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        config, work = tmp_path / 'profile' / 'settings.json', tmp_path / 'work'
        work.mkdir()
        settings = RuntimeSettings(server_url='https://test.invalid', user_id='account-105', device_id='device-105',
            device_public_key=public_key_text(device_key), server_public_key=public_key_text(broker_key))
        settings.save(config)
        selection = WorkspaceSelection(config)
        root = selection.select(str(work), confirmed=True)['logicalRoot']
        if mode == 'directory':
            selection.allow_write()
        registry = LocalResultRegistry(config.with_name('local-results.db'))
        content = 'T105-UNIQUE'
        path = '/outside/result.txt' if mode == 'outside' else root + '/result-105.txt'
        outcomes, finished = [], asyncio.Event()

        async def prompt(pending):
            return {'approved': True, 'actor_id': 'local-user'}

        async def broker(socket):
            hello = json.loads(await socket.recv())
            def frame(kind, payload, task_id=None):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind,
                    device_id='device-105', session_id=hello['session_id'], task_id=task_id, payload=payload))
            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key), 'receipt_replay': 1}))
            task = frame(MessageType.TASK, {'operation': 'local.files.write', 'run_id': 'run-105',
                'thread_id': 'thread-105', 'tool_call_id': 'call-105',
                'arguments': {'path': path, 'content': content}}, 'task-105')
            await socket.send(task)
            async for raw in socket:
                value = json.loads(raw)
                if value['type'] in {'task_result', 'error'}:
                    outcomes.append(value)
                    if mode != 'outside' and len(outcomes) == 1:
                        await socket.send(task)  # duplicate delivery must not re-register
                        continue
                    finished.set()
                    return

        async with serve(broker, '127.0.0.1', 0) as server:
            client = LocalRuntimeClient(server_url=f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}',
                device_id='device-105', user_id='account-105', session_token='synthetic', private_key=device_key,
                server_public_key=public_key_text(broker_key), receipt_ledger=ReceiptLedger(config.with_name('receipts.db')),
                local_results=registry, task_guard=TaskGuard(config.with_name('tasks.db')),
                file_service=WorkspaceFileService(selection), consent_prompt=None if mode == 'directory' else prompt)
            running = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(finished.wait(), 5)
            finally:
                await client.shutdown()
                await asyncio.gather(running, return_exceptions=True)
        if mode == 'outside':
            assert outcomes[0]['payload']['error_code'] == 'OUTSIDE_ALLOWED_ROOTS'
            assert registry.view(client.receipt_binding(), 'thread-105') == []
            return
        assert outcomes[0]['payload']['receipt']['status'] == 'completed'
        assert outcomes[1]['payload']['error_code'] == 'TASK_REPLAYED'
        assert (work / 'result-105.txt').read_bytes() == content.encode()
        row, = registry.view(client.receipt_binding(), 'thread-105')
        assert row['task_id'] == 'task-105' and row['thread_id'] == 'thread-105' and row['run_id'] == 'run-105'
        assert row['capability'] == 'local.files.write'
        assert row['sha256'] == hashlib.sha256(content.encode()).hexdigest()
        assert row['bytes'] == len(content.encode())
        assert row['logical_path'] == path and row['name'] == 'result-105.txt' and row['logical_root'] == root
        assert row['artifact_ref'] == ''
    asyncio.run(run())
