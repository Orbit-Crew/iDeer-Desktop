"""Issue101 faults through signed Runtime execution, using isolated SQLite."""
import asyncio
import json
import sqlite3

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.file_service import LocalFileService
from core.files import LocalFileStore, RootConfig
from core.protocol import MessageType, public_key_text, sign_envelope
from core.receipt_ledger import ReceiptLedger
from core.task_guard import TaskGuard
from core.transport import LocalRuntimeClient


@pytest.mark.parametrize("fault,expected", [
    ("admission", "RECEIPT_STORAGE_UNAVAILABLE"),
    ("completion", "RESULT_UNCERTAIN"), ("network", "completed"), ("legacy-claim", "TASK_REPLAYED")])
def test_execution_faults_and_preupgrade_claims(tmp_path, fault, expected):
    async def scenario():
        broker_key = Ed25519PrivateKey.generate()
        ledger_path = tmp_path / "receipts.db"
        ledger = ReceiptLedger(ledger_path)
        if fault == "admission":
            ledger.path = ledger_path.as_uri() + "?mode=ro"
        elif fault == "completion":
            with sqlite3.connect(ledger_path) as db:
                db.execute("CREATE TRIGGER no_completion BEFORE UPDATE ON local_receipts BEGIN SELECT RAISE(FAIL, 'fixture disk full'); END")
        guard = TaskGuard(tmp_path / "tasks.db")
        if fault == "legacy-claim":
            assert guard.claim("device-101", "task-101")
        calls = []
        finished = asyncio.Event()
        outcomes = []

        class Files(LocalFileService):
            def execute(self, capability, payload, **kwargs):
                value = super().execute(capability, payload, **kwargs)
                calls.append(capability)
                return value

        (tmp_path / "marker.txt").write_text("T101 fixed marker", encoding="utf-8")

        async def broker(socket):
            hello = json.loads(await socket.recv())
            await socket.send(json.dumps(sign_envelope(private_key=broker_key, message_type=MessageType.HELLO,
                device_id="device-101", session_id=hello["session_id"],
                payload={"server_public_key": public_key_text(broker_key), "receipt_replay": 1})))
            await socket.send(json.dumps(sign_envelope(private_key=broker_key, message_type=MessageType.TASK,
                device_id="device-101", session_id=hello["session_id"], task_id="task-101",
                payload={"operation": "local.files.read", "path": "/projects/marker.txt", "run_id": "run-101", "tool_call_id": "call-101"})))
            async for raw in socket:
                frame = json.loads(raw)
                if frame["type"] in {"task_result", "error"}:
                    outcomes.append(frame)
                    if fault == "network":
                        # No receipt acknowledgment; close before upload.
                        await socket.close()
                    finished.set()
                    return

        async with serve(broker, "127.0.0.1", 0) as server:
            client = LocalRuntimeClient(server_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}",
                device_id="device-101", user_id="account-A", session_token="synthetic", private_key=Ed25519PrivateKey.generate(),
                server_public_key=public_key_text(broker_key), receipt_ledger=ledger, task_guard=guard,
                file_service=Files(LocalFileStore([RootConfig("/projects", tmp_path)])))
            running = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(finished.wait(), 10)
            finally:
                await client.shutdown()
                await asyncio.gather(running, return_exceptions=True)
            outcome, = outcomes
            assert outcome["payload"].get("error_code", outcome["payload"].get("receipt", {}).get("status")) == expected
            assert len(calls) == (0 if fault in {"admission", "legacy-claim"} else 1)
            if fault == "completion":
                assert ledger.history(client.receipt_binding())[0]["delivery_state"] == "uncertain"
                assert ledger.snapshot(client.receipt_binding())["storageError"] == "RECEIPT_STORAGE_UNAVAILABLE"
            if fault == "network":
                assert ledger.history(client.receipt_binding())[0]["delivery_state"] == "pending"
                assert ledger.error == ""
                assert len(ReceiptLedger(ledger_path).pending(client.receipt_binding())) == 1
    asyncio.run(scenario())
