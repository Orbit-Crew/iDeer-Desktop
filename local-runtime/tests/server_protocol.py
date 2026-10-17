"""Signed device protocol envelopes and replay protection."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from pydantic import BaseModel, ConfigDict, Field

PROTOCOL_VERSION = "1"
TASK_TTL = timedelta(minutes=5)


class MessageType(StrEnum):
    HELLO = "hello"
    HEARTBEAT = "heartbeat"
    CAPABILITY_UPDATE = "capability_update"
    TASK = "task"
    TASK_ACK = "task_ack"
    TASK_PROGRESS = "task_progress"
    TASK_RESULT = "task_result"
    TASK_CANCEL = "task_cancel"
    CONSENT_REQUIRED = "consent_required"
    CONSENT_DECISION = "consent_decision"
    ERROR = "error"


class ProtocolCompatibility(StrEnum):
    COMPATIBLE = "compatible"
    OUTDATED = "outdated"
    BLOCKED = "blocked"


def negotiate_protocol(client_version: str, server_version: str = PROTOCOL_VERSION) -> ProtocolCompatibility:
    """Classify a runtime version before it can receive a task."""
    try:
        client_major = int(client_version.split(".", 1)[0])
        server_major = int(server_version.split(".", 1)[0])
    except (AttributeError, ValueError):
        return ProtocolCompatibility.BLOCKED
    if client_major == server_major:
        return ProtocolCompatibility.COMPATIBLE
    if client_major < server_major:
        return ProtocolCompatibility.OUTDATED
    return ProtocolCompatibility.BLOCKED


class ProtocolError(ValueError):
    """A protocol message must not be accepted."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def payload_digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload)).hexdigest()


def schema_digest(schema: dict[str, Any]) -> str:
    """Stable hash for a model-visible local tool input schema."""
    return hashlib.sha256(canonical_json(schema)).hexdigest()


def public_key_text(key: Ed25519PublicKey) -> str:
    return base64.urlsafe_b64encode(key.public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")


def load_public_key(value: str) -> Ed25519PublicKey:
    try:
        raw = base64.urlsafe_b64decode(value.encode("ascii"))
        return Ed25519PublicKey.from_public_bytes(raw)
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ProtocolError("INVALID_PUBLIC_KEY", "device public key is invalid") from exc


class TaskEnvelope(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    protocol_version: str = Field(default=PROTOCOL_VERSION, alias="protocol")
    type: MessageType
    message_id: str
    device_id: str
    session_id: str
    task_id: str | None = None
    issued_at: datetime
    expires_at: datetime
    payload: dict[str, Any] = Field(default_factory=dict)
    payload_hash: str
    signature: str

    def signing_dict(self) -> dict[str, Any]:
        value = self.model_dump(mode="json", by_alias=True)
        value.pop("signature", None)
        return value

    def signing_bytes(self) -> bytes:
        return canonical_json(self.signing_dict())

    def verify(
        self,
        *,
        public_key: Ed25519PublicKey,
        expected_device_id: str,
        expected_session_id: str,
        seen_task_ids: set[str] | None = None,
        seen_message_ids: set[str] | None = None,
        now: datetime | None = None,
    ) -> None:
        current = now or datetime.now(UTC)
        issued_at = self.issued_at.replace(tzinfo=UTC) if self.issued_at.tzinfo is None else self.issued_at
        expires_at = self.expires_at.replace(tzinfo=UTC) if self.expires_at.tzinfo is None else self.expires_at
        if self.device_id != expected_device_id or self.session_id != expected_session_id:
            raise ProtocolError("SESSION_MISMATCH", "envelope is bound to a different device session")
        if expires_at <= current:
            raise ProtocolError("MESSAGE_EXPIRED", "message envelope has expired")
        if issued_at > current + timedelta(seconds=30):
            raise ProtocolError("MESSAGE_NOT_YET_VALID", "message envelope is from the future")
        if self.payload_hash != payload_digest(self.payload):
            raise ProtocolError("PAYLOAD_HASH_MISMATCH", "payload hash does not match the envelope")
        try:
            public_key.verify(
                base64.urlsafe_b64decode(self.signature.encode("ascii")),
                self.signing_bytes(),
            )
        except (InvalidSignature, ValueError, TypeError) as exc:
            raise ProtocolError("SIGNATURE_INVALID", "message signature is invalid") from exc
        # Only a signature-verified frame registers its message id: registering
        # before verification let an unsigned frame burn the id, so the
        # device's legitimate retry was rejected as a replay without its
        # signature ever being checked.
        if seen_message_ids is not None:
            if self.message_id in seen_message_ids:
                raise ProtocolError("MESSAGE_REPLAYED", "message id has already been received")
            seen_message_ids.add(self.message_id)
        if seen_task_ids is not None and self.type == MessageType.TASK and self.task_id:
            if self.task_id in seen_task_ids:
                raise ProtocolError("TASK_REPLAYED", "task id has already been received")
            seen_task_ids.add(self.task_id)


def sign_envelope(
    *,
    private_key: Ed25519PrivateKey,
    message_type: MessageType,
    device_id: str,
    session_id: str,
    payload: dict[str, Any] | None = None,
    task_id: str | None = None,
    expires_at: datetime | None = None,
    protocol_version: str = PROTOCOL_VERSION,
) -> TaskEnvelope:
    issued_at = datetime.now(UTC)
    unsigned = TaskEnvelope(
        protocol=protocol_version,
        type=message_type,
        message_id=str(uuid4()),
        device_id=device_id,
        session_id=session_id,
        task_id=task_id,
        issued_at=issued_at,
        expires_at=expires_at or issued_at + TASK_TTL,
        payload=payload or {},
        payload_hash=payload_digest(payload or {}),
        signature="",
    )
    signature = base64.urlsafe_b64encode(private_key.sign(unsigned.signing_bytes())).decode("ascii")
    return unsigned.model_copy(update={"signature": signature})


def new_session_id() -> str:
    return secrets.token_urlsafe(18)
