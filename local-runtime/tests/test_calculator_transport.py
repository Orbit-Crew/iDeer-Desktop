"""Transport admission, receipts and the no-approval contract for #83.

The fixed calculators ride the same task admission as every capability
(announced set, restricted mode, compatibility gate, receipts) but never the
approval path: policy classifies them LEVEL_0 like echo, so no consent card
is raised and the session tier is never consulted.
"""

from __future__ import annotations

import asyncio
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.calculator import evaluate_aero_arguments, evaluate_expression
from core.policy import LocalPolicy, PolicyDecision, RiskLevel
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.session_tier import (
    TIER_AUTONOMOUS_CAPABILITIES,
    TIER_FULL_CAPABILITIES,
    GateDecision,
    SessionTier,
    tier_gate_decision,
)
from core.transport import LocalRuntimeClient

CALCULATOR_CAPABILITIES = ("local.calculator", "local.aero_calculator")


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


def _client(**options) -> tuple[LocalRuntimeClient, Ed25519PrivateKey]:
    server_key = Ed25519PrivateKey.generate()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        **options,
    )
    client.connection = FakeConnection()
    return client, server_key


def _run_task(client: LocalRuntimeClient, server_key: Ed25519PrivateKey, payload: dict, task_id: str = "task-83") -> dict:
    task = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id=task_id,
        payload=payload,
    )
    verified = verify_envelope(
        task,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    asyncio.run(client._handle_task(verified))
    return json.loads(client.connection.sent[-1])


def test_calculator_capabilities_are_announced_by_default() -> None:
    client, _key = _client()
    for capability in CALCULATOR_CAPABILITIES:
        assert capability in client.capabilities


def test_plain_calculator_task_completes_without_consent() -> None:
    client, key = _client()
    result = _run_task(
        client,
        key,
        {
            "operation": "local.calculator",
            "arguments": {"expression": "1 + 2 * 3"},
            "run_id": "run-83",
            "thread_id": "thread-83",
        },
    )
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["result"] == "7"
    receipt = result["payload"]["receipt"]
    assert receipt["capability"] == "local.calculator"
    assert receipt["status"] == "completed"
    assert receipt["policy_decision"] == "allow"
    assert receipt["run_id"] == "run-83"
    # No approval was ever asked: the whole exchange is ack -> result.
    kinds = [json.loads(message)["type"] for message in client.connection.sent]
    assert MessageType.CONSENT_REQUIRED not in kinds


def test_aero_calculator_task_completes_without_consent() -> None:
    client, key = _client()
    result = _run_task(
        client,
        key,
        {
            "operation": "local.aero_calculator",
            "arguments": {"formula": "mach", "params": {"V": 85}},
            "run_id": "run-83",
        },
    )
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["result"] == "马赫数 M = 85 / 340.3 = 0.249780"
    assert result["payload"]["receipt"]["capability"] == "local.aero_calculator"
    kinds = [json.loads(message)["type"] for message in client.connection.sent]
    assert MessageType.CONSENT_REQUIRED not in kinds


def test_calculator_errors_are_results_not_failures() -> None:
    # The original tool answered bad expressions with result strings.
    client, key = _client()
    result = _run_task(
        client,
        key,
        {
            "operation": "local.calculator",
            "arguments": {"expression": "10 / 0"},
            "run_id": "run-83",
        },
    )
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["result"] == "计算错误: 除以零"
    assert result["payload"]["receipt"]["status"] == "completed"


def test_malformed_calculator_payload_is_invalid_task() -> None:
    client, key = _client()
    result = _run_task(
        client,
        key,
        {"operation": "local.calculator", "arguments": {"expression": 42}},
    )
    assert result["type"] == "error"
    assert result["payload"]["error_code"] == "INVALID_TASK"


def test_oversized_expression_is_refused() -> None:
    client, key = _client()
    result = _run_task(
        client,
        key,
        {
            "operation": "local.calculator",
            "arguments": {"expression": "1+" * 4096},
        },
    )
    assert result["type"] == "error"
    assert result["payload"]["error_code"] == "INVALID_TASK"


def test_unannounced_calculator_capability_is_refused() -> None:
    # Admission rides the existing capability set: a runtime restricted to
    # other capabilities refuses the calculators like any other operation.
    client, key = _client(capabilities=("echo",), restrict_capabilities=True)
    result = _run_task(
        client,
        key,
        {
            "operation": "local.calculator",
            "arguments": {"expression": "1 + 1"},
        },
    )
    assert result["type"] == "error"
    assert result["payload"]["error_code"] == "CAPABILITY_UNAVAILABLE"


def test_policy_treats_calculators_as_level_zero() -> None:
    policy = LocalPolicy()
    for capability in CALCULATOR_CAPABILITIES:
        assert policy.risk_level(capability, {}) is RiskLevel.LEVEL_0
        assert policy.authorize(capability, {}) is PolicyDecision.ALLOW


def test_session_tier_never_gates_the_calculators() -> None:
    # Outside the tier's folder-anchored sets in every tier, so a tier can
    # neither auto-run them nor widen them; they simply never need consent.
    payload = {"arguments": {"expression": "1 + 1"}}
    for tier in SessionTier:
        assert (
            tier_gate_decision(tier, "local.calculator", payload, lambda _anchor: "outside")
            is GateDecision.ASK
        )
    for capability in CALCULATOR_CAPABILITIES:
        assert capability not in TIER_AUTONOMOUS_CAPABILITIES
        assert capability not in TIER_FULL_CAPABILITIES


def test_pure_functions_match_the_wire_results() -> None:
    assert evaluate_expression("1 + 2 * 3") == "7"
    assert (
        evaluate_aero_arguments({"formula": "mach", "params": {"V": 85}})
        == "马赫数 M = 85 / 340.3 = 0.249780"
    )
