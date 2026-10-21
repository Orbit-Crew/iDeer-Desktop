"""Protocol serialization kept independent from the server package."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .compat import UTC, StrEnum


class MessageType(StrEnum):
    HELLO = "hello"
    HEARTBEAT = "heartbeat"
    CAPABILITY_UPDATE = "capability_update"
    TASK = "task"
    TASK_ACK = "task_ack"
    TASK_PROGRESS = "task_progress"
    TASK_RESULT = "task_result"
    RECEIPT_UPLOAD = "receipt_upload"
    RECEIPT_ACK = "receipt_ack"
    TASK_CANCEL = "task_cancel"
    CONSENT_REQUIRED = "consent_required"
    CONSENT_DECISION = "consent_decision"
    ERROR = "error"


class ProtocolError(ValueError):
    """A broker message failed local verification."""


@dataclass(frozen=True)
class VerifiedEnvelope:
    type: MessageType
    device_id: str
    session_id: str
    task_id: str | None
    payload: dict[str, Any]
    signature: str = ""


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def public_key_text(private_key: Ed25519PrivateKey) -> str:
    return base64.urlsafe_b64encode(
        private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")


def new_session_id() -> str:
    return secrets.token_urlsafe(18)


def sign_envelope(
    *,
    private_key: Ed25519PrivateKey,
    message_type: MessageType,
    device_id: str,
    session_id: str,
    payload: dict[str, Any],
    task_id: str | None = None,
) -> dict[str, Any]:
    issued_at = datetime.now(UTC)
    issued_at_text = issued_at.isoformat().replace("+00:00", "Z")
    expires_at_text = (
        (issued_at + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    )
    unsigned = {
        "protocol": "1",
        "type": message_type.value,
        "message_id": str(uuid4()),
        "device_id": device_id,
        "session_id": session_id,
        "task_id": task_id,
        "issued_at": issued_at_text,
        "expires_at": expires_at_text,
        "payload": payload,
        "payload_hash": hashlib.sha256(_canonical(payload)).hexdigest(),
    }
    signed = dict(unsigned)
    signed["signature"] = base64.urlsafe_b64encode(
        private_key.sign(_canonical(unsigned))
    ).decode("ascii")
    return signed


def verify_envelope(
    message: dict[str, Any],
    *,
    server_public_key: str,
    expected_device_id: str,
    expected_session_id: str,
) -> VerifiedEnvelope:
    if (
        message.get("device_id") != expected_device_id
        or message.get("session_id") != expected_session_id
    ):
        raise ProtocolError("SESSION_MISMATCH")
    try:
        expires_at_text = str(message["expires_at"])
        if expires_at_text.endswith(("Z", "z")):
            # The wire format signs timestamps with a trailing Z, which
            # datetime.fromisoformat only accepts from Python 3.11 on.
            expires_at_text = expires_at_text[:-1] + "+00:00"
        expires_at = datetime.fromisoformat(expires_at_text)
        expires_at = (
            expires_at.replace(tzinfo=UTC) if expires_at.tzinfo is None else expires_at
        )
        if expires_at <= datetime.now(UTC):
            raise ProtocolError("MESSAGE_EXPIRED")
        payload = dict(message["payload"])
        if message["payload_hash"] != hashlib.sha256(_canonical(payload)).hexdigest():
            raise ProtocolError("PAYLOAD_HASH_MISMATCH")
        signature = base64.urlsafe_b64decode(str(message["signature"]).encode("ascii"))
        public_key = base64.urlsafe_b64decode(server_public_key.encode("ascii"))
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        unsigned = dict(message)
        unsigned.pop("signature", None)
        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(
                signature, _canonical(unsigned)
            )
        except InvalidSignature as exc:
            # The frame is well formed but not signed by the key this device
            # trusts. Callers key their failure handling off ProtocolError, so
            # a replaced broker key must surface as one, not as a raw
            # cryptography exception.
            raise ProtocolError("SIGNATURE_INVALID") from exc
        return VerifiedEnvelope(
            MessageType(message["type"]),
            expected_device_id,
            expected_session_id,
            message.get("task_id"),
            payload,
            str(message["signature"]),
        )
    except ProtocolError:
        raise
    except (KeyError, TypeError, ValueError, UnicodeError) as exc:
        raise ProtocolError("MESSAGE_INVALID") from exc
