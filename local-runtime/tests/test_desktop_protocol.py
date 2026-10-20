"""Desktop migration contract, observed only through signed WebSocket frames."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.protocol import MessageType, public_key_text, sign_envelope
from core.transport import LocalRuntimeClient
from core.policy import LocalPolicy
from server_protocol import MessageType as ServerMessageType, sign_envelope as server_sign


async def outcome(socket):
    while True:
        value = json.loads(await asyncio.wait_for(socket.recv(), 5))
        if value["type"] in {"error", "task_result"}:
            return value


@asynccontextmanager
async def connected_client(**options):
    broker_key = Ed25519PrivateKey.generate()
    ready = asyncio.Queue()
    done = asyncio.Event()

    async def broker(socket):
        await ready.put(socket)
        await done.wait()

    async with serve(broker, "127.0.0.1", 0) as server:
        client = LocalRuntimeClient(
            server_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}",
            device_id="desktop-test", session_token="isolated-test-token",
            private_key=Ed25519PrivateKey.generate(), server_public_key=public_key_text(broker_key),
            **options,
        )
        running = asyncio.create_task(client.run())
        socket = await asyncio.wait_for(ready.get(), 5)
        hello = json.loads(await socket.recv())

        def frame(payload, task_id="task-97", **kwargs):
            return server_sign(private_key=broker_key, message_type=ServerMessageType.TASK,
                device_id="desktop-test", session_id=hello["session_id"], task_id=task_id,
                payload=payload, **kwargs).model_dump(mode="json", by_alias=True)

        await socket.send(json.dumps(server_sign(private_key=broker_key,
            message_type=ServerMessageType.HELLO, device_id="desktop-test",
            session_id=hello["session_id"], payload={"server_public_key": public_key_text(broker_key),
            "protocol_version": "1"}).model_dump(mode="json", by_alias=True)))
        try:
            yield socket, frame
        finally:
            done.set()
            await client.shutdown()
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


@pytest.mark.parametrize("failure,code", [("signature", "SIGNATURE_INVALID"), ("expired", "MESSAGE_EXPIRED"), ("deny", "LOCAL_POLICY_DENIED")])
def test_rejected_signed_echo_never_returns_a_tool_result(failure, code):
    async def scenario():
        options = {"policy": LocalPolicy(denied_capabilities=frozenset({"echo"}))} if failure == "deny" else {}
        async with connected_client(**options) as (socket, frame):
            kwargs = {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)} if failure == "expired" else {}
            message = frame({"operation": "echo", "value": "must-not-echo", "run_id": "run-97"}, **kwargs)
            if failure == "signature":
                message["signature"] = "A" * 86 + "=="
            await socket.send(json.dumps(message))
            response = await outcome(socket)
            assert response["type"] == "error"
            assert response["payload"]["error_code"] == code
            assert response["payload"]["receipt"]["status"] == "denied"
            assert "result" not in response["payload"]

    asyncio.run(scenario())


def test_signed_task_replay_is_rejected_without_a_second_result():
    async def scenario():
        broker_key = Ed25519PrivateKey.generate()
        received = []
        done = asyncio.Event()

        async def broker(socket):
            hello = json.loads(await socket.recv())

            def frame(kind, payload, task_id=None):
                return sign_envelope(
                    private_key=broker_key, message_type=kind,
                    device_id="desktop-test", session_id=hello["session_id"],
                    task_id=task_id, payload=payload,
                )

            await socket.send(json.dumps(frame(MessageType.HELLO, {
                "server_public_key": public_key_text(broker_key), "protocol_version": "1",
            })))
            task = frame(MessageType.TASK, {
                "operation": "echo", "value": "T97-02-marker", "run_id": "run-97",
            }, "task-97")
            await socket.send(json.dumps(task))
            while True:
                result = json.loads(await socket.recv())
                if result["type"] == "task_result":
                    received.append(result)
                    break
            await socket.send(json.dumps(task))
            while True:
                result = json.loads(await socket.recv())
                if result["type"] in {"error", "task_result"}:
                    received.append(result)
                    break
            done.set()

        async with serve(broker, "127.0.0.1", 0) as server:
            client = LocalRuntimeClient(
                server_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}",
                device_id="desktop-test", session_token="isolated-test-token",
                private_key=Ed25519PrivateKey.generate(),
                server_public_key=public_key_text(broker_key),
            )
            running = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(done.wait(), 10)
                assert received[0]["payload"]["result"] == "T97-02-marker"
                assert received[0]["payload"]["receipt"]["task_id"] == "task-97"
                assert received[1]["type"] == "error"
                assert received[1]["payload"]["error_code"] == "TASK_REPLAYED"
            finally:
                await client.shutdown()
                await running

    asyncio.run(scenario())


def test_signed_workspace_search_and_stale_directory_return_linked_receipts(tmp_path):
    from core.file_service import WorkspaceFileService, WorkspaceSelection
    from core.settings import RuntimeSettings
    config = tmp_path / 'profile' / 'settings.json'
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'marker.py').write_bytes(b'KNOWN100 = True\n')
    RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1').save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    service = WorkspaceFileService(selection)

    async def scenario():
        async with connected_client(file_service=service, capabilities=service.capabilities) as (socket, frame):
            await socket.send(json.dumps(frame({'operation': 'local.files.search', 'run_id': 'run-100',
                'tool_call_id': 'call-100', 'arguments': {'path': root, 'query': 'KNOWN100'}}, task_id='task-search-100')))
            response = await outcome(socket)
            assert response['payload']['result']['matches'] == [
                {'path': root + '/marker.py', 'line': 1, 'text': 'KNOWN100 = True'}]
            receipt = response['payload']['receipt']
            assert receipt['run_id'] == 'run-100'
            assert receipt['task_id'] == 'task-search-100'
            assert receipt['status'] == 'completed'
            selection.select(str(work), confirmed=True)
            await socket.send(json.dumps(frame({'operation': 'local.files.read', 'run_id': 'run-100',
                'arguments': {'path': root + '/marker.py'}}, task_id='task-stale-100')))
            response = await outcome(socket)
            assert response['payload']['error_code'] == 'OUTSIDE_ALLOWED_ROOTS'
            assert response['payload']['receipt']['task_id'] == 'task-stale-100'
            assert 'KNOWN100' not in json.dumps(response)
            assert str(work) not in json.dumps(response)
    asyncio.run(scenario())
