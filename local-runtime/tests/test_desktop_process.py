"""Installed interpreter, OS credentials, Server protocol, and managed MCP."""
from __future__ import annotations

import asyncio
import base64
import json
import hashlib
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

from core.secrets import WindowsCredentialStore
from core.settings import RuntimeSettings
from server_protocol import MessageType, TaskEnvelope, public_key_text, sign_envelope

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows distribution and Credential Manager")


@pytest.mark.parametrize('desktop_mode', [False, True], ids=['legacy-controller', 'desktop-mcp-denied'])
def test_packaged_signed_echo_mcp_rejections_restart_and_crash(tmp_path, desktop_mode):
    async def scenario():
        interpreter = Path(os.environ.get("IDEER_TEST_PYTHON", Path(__file__).resolve().parents[2] / ".runtime/python.exe"))
        assert interpreter.is_file(), "Run prepare-runtime.py first"
        profile = tmp_path / "test profile with spaces"
        profile.mkdir()
        device_key, broker_key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        identity = "test-97-" + uuid.uuid4().hex
        store = WindowsCredentialStore()
        refs = [identity + "-session", identity + "-key", identity + "-business"]
        store.set(refs[0], "isolated-" + identity)
        store.set(refs[1], base64.b64encode(device_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        store.set(refs[2], "business-" + identity)
        queue = asyncio.Queue()
        release = asyncio.Event()
        process = None
        states = []
        outcomes = []
        monitor = None

        async def broker(socket):
            await queue.put(socket)
            await socket.wait_closed()

        async def authenticated_account(connection, request):
            if request.path in {'/updates/compatibility.json', '/updates/compatibility.sig'}:
                # This fixture is an older protocol-1 deployment with no
                # published compatibility document. A normal HTTP 404 must
                # not fall through into the WebSocket upgrade handler.
                return Response(404, 'Not Found', Headers({'Content-Type': 'application/json',
                    'Content-Length': '2'}), b'{}')
            if request.path in {"/api/v1/auth/me", '/api/devices/' + identity}:
                assert request.headers.get("Cookie") == "access_token=business-" + identity
                body = json.dumps({"id": identity, "email": "fixture@example.com"} if request.path == '/api/v1/auth/me'
                    else {'id': identity, 'owner_id': identity, 'status': 'offline'}).encode()
                return Response(200, "OK", Headers({"Content-Type": "application/json", "Content-Length": str(len(body))}), body)

        async def snapshot_reader(child):
            async for line in child.stdout:
                states.append(json.loads(line))

        async def await_state(predicate):
            async def wait():
                while not any(predicate(item) for item in states):
                    await asyncio.sleep(0.05)
            await asyncio.wait_for(wait(), 15)

        async def receive(socket):
            while True:
                response = TaskEnvelope.model_validate_json(await asyncio.wait_for(socket.recv(), 10))
                response.verify(public_key=device_key.public_key(), expected_device_id=identity,
                                expected_session_id=settings.session_id)
                if response.type in {MessageType.TASK_RESULT, MessageType.ERROR}:
                    outcomes.append({"task_id": response.task_id, "type": response.type.value,
                        "signature": "verified with isolated device public key", "payload_hash": response.payload_hash,
                        "payload": response.payload})
                    return response

        try:
            async with serve(broker, "127.0.0.1", 0, process_request=authenticated_account) as server:
                count = profile / "count.txt"
                mcp_pid = profile / "mcp.pid"
                mcp = profile / "mcp.json"
                mcp.write_text(json.dumps({"servers": [{"name": "fixture", "transport": "stdio",
                    "command": [str(interpreter), str(Path(__file__).parent / "fixtures/counting_mcp_server.py")],
                    "env": {"MCP_COUNT": str(count), "MCP_PID": str(mcp_pid)}}]}))
                capability = "local.mcp.fixture.echo"
                settings = RuntimeSettings(server_url=f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}",
                    user_id=identity, user_name="fixture@example.com", business_token_ref=refs[2], business_expires_at="2099-01-01T00:00:00+00:00",
                    device_id=identity, session_id="session-97", server_public_key=public_key_text(broker_key.public_key()),
                    session_token_ref=refs[0], device_key_ref=refs[1], mcp_config_path=str(mcp),
                    rules={capability: "always_allow"})
                config = profile / "settings.json"
                settings.save(config)

                async def start():
                    nonlocal process, monitor
                    entry = ['-m', 'core.desktop'] if desktop_mode else [str(Path(__file__).parent / 'fixtures' / 'legacy_runtime_process.py')]
                    process = await asyncio.create_subprocess_exec(str(interpreter), "-I", "-u", *entry, "--config", str(config),
                        cwd=interpreter.parent, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    monitor = asyncio.create_task(snapshot_reader(process))
                    socket = await asyncio.wait_for(queue.get(), 15)
                    hello = TaskEnvelope.model_validate_json(await socket.recv())
                    hello.verify(public_key=device_key.public_key(), expected_device_id=identity, expected_session_id=settings.session_id)
                    await socket.send(sign_envelope(private_key=broker_key, message_type=MessageType.HELLO,
                        device_id=identity, session_id=settings.session_id, payload={"server_public_key": settings.server_public_key, "protocol_version": "1"}).model_dump_json(by_alias=True))
                    return socket

                def task(task_id, payload, **kwargs):
                    return sign_envelope(private_key=broker_key, message_type=MessageType.TASK, device_id=identity,
                        session_id=settings.session_id, task_id=task_id, payload={"run_id": "run-97", **payload}, **kwargs)

                socket = await start()
                if desktop_mode:
                    await socket.send(task('desktop-mcp-denied-100', {'operation': capability,
                        'arguments': {'value': 'MUST-NOT-EXECUTE'}}).model_dump_json(by_alias=True))
                    response = await receive(socket)
                    assert response.type == MessageType.ERROR
                    assert response.payload['error_code'] == 'CAPABILITY_UNAVAILABLE'
                    assert response.payload['receipt']['status'] == 'denied'
                    assert not count.exists()
                    assert not mcp_pid.exists()
                    process.stdin.write(b'{"type":"shutdown"}\n')
                    await process.stdin.drain()
                    assert await asyncio.wait_for(process.wait(), 15) == 0
                    await monitor
                    return
                await socket.send(task("echo-97", {"operation": "echo", "value": "T97-echo-marker"}).model_dump_json(by_alias=True))
                response = await receive(socket)
                assert response.payload["result"] == "T97-echo-marker"
                assert response.payload["receipt"]["task_id"] == "echo-97"
                payload = {"operation": capability, "arguments": {"value": "T97-mcp-marker"}}
                valid = task("mcp-97", payload)
                await socket.send(valid.model_dump_json(by_alias=True))
                response = await receive(socket)
                assert response.type == MessageType.TASK_RESULT
                assert response.payload["result"]["content"] == [{"type": "text", "text": "T97-mcp-marker"}]
                assert response.payload["receipt"]["run_id"] == "run-97"
                assert count.read_text() == "T97-mcp-marker\n"
                await await_state(lambda item: any(entry["taskId"] == "mcp-97" and entry["state"] == "completed" for entry in item["tasks"]))

                invalid = task("bad-97", payload).model_copy(update={"signature": "A" * 86 + "=="})
                expired = task("expired-97", payload, expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
                for envelope, code in [(invalid, "SIGNATURE_INVALID"), (expired, "MESSAGE_EXPIRED"), (valid, "TASK_REPLAYED")]:
                    await socket.send(envelope.model_dump_json(by_alias=True))
                    response = await receive(socket)
                    assert response.type == MessageType.ERROR
                    assert response.payload["error_code"] == code
                    assert count.read_text() == "T97-mcp-marker\n"
                # A local policy update survives a fresh owned process. Persisted
                # task admission also survives, including an uncertain crash.
                process.stdin.write(b'{"type":"shutdown"}\n')
                await process.stdin.drain()
                assert await asyncio.wait_for(process.wait(), 15) == 0
                await monitor
                settings.rules[capability] = "deny"
                settings.save(config)
                states.clear()
                socket = await start()
                await socket.send(task("deny-97", payload).model_dump_json(by_alias=True))
                response = await receive(socket)
                assert response.payload["error_code"] == "LOCAL_POLICY_DENIED"
                assert response.payload["receipt"]["status"] == "denied"
                await socket.send(task("mcp-97", payload).model_dump_json(by_alias=True))
                assert (await receive(socket)).payload["error_code"] == "TASK_REPLAYED"
                assert count.read_text() == "T97-mcp-marker\n"
                child_pid = int(mcp_pid.read_text())
                process.kill()
                await asyncio.wait_for(process.wait(), 10)
                await monitor
                # Windows job closes with the Runtime even on TerminateProcess.
                import ctypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.restype = ctypes.c_void_p
                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                deadline = asyncio.get_running_loop().time() + 5
                while True:
                    handle = kernel.OpenProcess(0x1000, False, child_pid)
                    if not handle:
                        break
                    kernel.CloseHandle(handle)
                    assert asyncio.get_running_loop().time() < deadline, "orphan MCP process"
                    await asyncio.sleep(0.05)
                settings.rules[capability] = "always_allow"
                settings.save(config)
                states.clear()
                socket = await start()
                await socket.send(task("mcp-97", payload).model_dump_json(by_alias=True))
                assert (await receive(socket)).payload["error_code"] == "TASK_REPLAYED"
                assert count.read_text() == "T97-mcp-marker\n"
                uncertain_payload = {"operation": capability, "arguments": {"value": "T97-unconfirmed-marker"}}
                await socket.send(task("uncertain-97", uncertain_payload).model_dump_json(by_alias=True))
                expected_ledger = "T97-mcp-marker\nT97-unconfirmed-marker\n"

                async def await_side_effect():
                    while count.read_text() != expected_ledger:
                        await asyncio.sleep(0.02)

                await asyncio.wait_for(await_side_effect(), 10)
                assert not any(entry["taskId"] == "uncertain-97" and entry["state"] == "completed"
                               for snapshot in states for entry in snapshot["tasks"])
                process.kill()
                await asyncio.wait_for(process.wait(), 10)
                await monitor
                states.clear()
                socket = await start()
                await socket.send(task("uncertain-97", uncertain_payload).model_dump_json(by_alias=True))
                uncertain_result = await receive(socket)
                assert uncertain_result.type == MessageType.ERROR
                assert uncertain_result.payload["error_code"] == "TASK_REPLAYED"
                assert count.read_text() == expected_ledger
                process.stdin.write(b'{"type":"shutdown"}\n')
                await process.stdin.drain()
                assert await asyncio.wait_for(process.wait(), 15) == 0
                await monitor
                if os.environ.get("IDEER_TEST_EVIDENCE"):
                    evidence = Path(os.environ["IDEER_TEST_EVIDENCE"])
                    evidence.mkdir(parents=True, exist_ok=True)
                    (evidence / "signed-process.json").write_text(json.dumps({
                        "interpreter": str(interpreter), "interpreter_sha256": hashlib.sha256(interpreter.read_bytes()).hexdigest(),
                        "outcomes": outcomes, "states": states, "mcp_ledger": count.read_text(),
                        "crash_descendants": "none", "recovery_exit_code": 0,
                        "unconfirmed_side_effect": "one admission, one side effect, replay rejected after crash",
                    }, indent=2), encoding="utf-8")
        finally:
            release.set()
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            if monitor is not None:
                await asyncio.gather(monitor, return_exceptions=True)
            for ref in refs:
                store.delete(ref)

    asyncio.run(scenario())
