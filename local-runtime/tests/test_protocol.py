from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def test_local_runtime_verifies_server_signature_and_session_binding() -> None:
    server_key = Ed25519PrivateKey.generate()
    message = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id="task-1",
        payload={"operation": "echo", "value": "safe"},
    )

    verified = verify_envelope(
        message,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    assert verified.type == MessageType.TASK
    assert verified.task_id == "task-1"
