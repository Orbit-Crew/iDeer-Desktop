"""Receipt recovery through the Runtime's signed transport boundary."""
import asyncio
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.protocol import MessageType, public_key_text, verify_envelope, sign_envelope
from core.receipt_ledger import ReceiptLedger
from core.transport import LocalRuntimeClient
from test_receipt_ledger import BINDING, TASK, RECEIPT


class Socket:
    def __init__(self):
        self.frames = []

    async def send(self, text):
        self.frames.append(json.loads(text))


def test_reconnect_replays_only_metadata_for_original_identity(tmp_path):
    key = Ed25519PrivateKey.generate()
    binding = {**BINDING, "device_public_key": public_key_text(key)}
    ledger = ReceiptLedger(tmp_path / "receipts.db")
    ledger.admit(binding, TASK)
    saved = ledger.complete(binding, RECEIPT)
    client = LocalRuntimeClient(server_url="https://fixture.invalid/api/devices/ws", device_id="device-A",
        session_id="new-session", session_token="secret-not-on-disk", private_key=key,
        server_public_key="fixture-broker-key", receipt_ledger=ledger, user_id="account-B")
    client.connection = Socket()
    client.connected = True
    client.receipt_replay_enabled = True
    asyncio.run(client.replay_receipts())
    assert client.connection.frames == []
    client.user_id = "account-A"
    asyncio.run(client.replay_receipts())
    frame, = client.connection.frames
    assert frame["type"] == MessageType.RECEIPT_UPLOAD
    verified = verify_envelope(frame, server_public_key=public_key_text(key),
        expected_device_id="device-A", expected_session_id="new-session")
    assert verified.payload == saved
    assert "result" not in verified.payload
    assert ledger.history(binding)[0]["delivery_state"] == "pending"


def test_startup_drains_acknowledgments_while_upload_is_backpressured(tmp_path):
    async def scenario():
        key, broker_key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        binding = {**BINDING, 'device_public_key': public_key_text(key), 'broker_public_key': public_key_text(broker_key)}
        ledger = ReceiptLedger(tmp_path / 'receipts.db')
        ledger.admit(binding, TASK)
        ledger.complete(binding, RECEIPT)
        queue = asyncio.Queue()
        drained = asyncio.Event()

        class BackpressuredSocket:
            delivered = False
            async def recv(self):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=MessageType.HELLO,
                    device_id='device-A', session_id='new-session', payload={'receipt_replay': 1}))
            async def send(self, text):
                frame = json.loads(text)
                if frame['type'] == 'receipt_upload':
                    upload = frame['payload']
                    await queue.put(json.dumps(sign_envelope(private_key=broker_key, message_type=MessageType.RECEIPT_ACK,
                        device_id='device-A', session_id='new-session', task_id='task-101',
                        payload={'receipt_id': upload['receipt_id'], 'receipt_hash': upload['receipt_hash'], 'acknowledgment': 'ack-backpressure'})))
                    await drained.wait()
            def __aiter__(self):
                return self
            async def __anext__(self):
                if self.delivered:
                    raise StopAsyncIteration
                frame = await queue.get()
                self.delivered = True
                drained.set()
                return frame
            async def close(self):
                pass

        client = LocalRuntimeClient(server_url='https://fixture.invalid/api/devices/ws', device_id='device-A',
            session_id='new-session', session_token='synthetic', private_key=key,
            server_public_key=public_key_text(broker_key), receipt_ledger=ledger, user_id='account-A')
        client.connection = BackpressuredSocket()
        await asyncio.wait_for(client.run(), 2)
        assert ledger.snapshot(binding)['confirmed'] == 1
    asyncio.run(scenario())
