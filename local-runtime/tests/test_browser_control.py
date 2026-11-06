"""Issue 108: the agent's controlled channel into the local browser pane.

Covers the seams the acceptance criteria name: the runtime policy grades
``local.browser.control``, the session tier resolves the per-intent ask,
the service rides one controlled request to the Desktop, and the bridge
contract keeps page facts bounded.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.browser_control import (
    BROWSER_INTENTS,
    BrowserControlError,
    BrowserControlResult,
    BrowserControlService,
    browser_intent_of,
    normalize_browser_command,
)
from core.consent import render_consent_summary
from core.policy import LocalPolicy, PolicyDecision, RiskLevel
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.transport import LocalRuntimeClient


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


def _service(**overrides) -> tuple[BrowserControlService, list[dict]]:
    sent: list[dict] = []
    service = BrowserControlService(
        emit=sent.append, policy=LocalPolicy(), **overrides
    )
    return service, sent


# --- policy seam -----------------------------------------------------------


def test_browser_control_is_level_one_and_never_runs_unconsented() -> None:
    policy = LocalPolicy()
    assert policy.risk_level("local.browser.control", {}) is RiskLevel.LEVEL_1
    assert policy.authorize("local.browser.control", {}) is PolicyDecision.CONSENT_REQUIRED
    assert policy.authorize("local.browser.control", {}, consent=True) is PolicyDecision.ALLOW


# --- tier seam -------------------------------------------------------------


def _tier_decision(tier, payload):
    from core.session_tier import SessionTier, tier_gate_decision

    return tier_gate_decision(SessionTier(tier), "local.browser.control", payload, lambda _path: "inside")


def test_ask_first_tier_asks_for_every_browser_intent() -> None:
    actions = {"observe": "observe", "input": "click", "submit": "submit", "download": "download"}
    for intent in BROWSER_INTENTS:
        payload = {"intent": intent, "action": actions[intent]}
        assert _tier_decision("ask_first", payload) == "ask"


def test_autonomous_tier_auto_runs_observe_only() -> None:
    from core.session_tier import SessionTier

    assert _tier_decision(SessionTier.AUTONOMOUS, {"action": "observe"}) == "allow"
    assert _tier_decision(SessionTier.AUTONOMOUS, {"action": "observe-text", "tab_id": 1}) == "allow"
    for action in ("click", "text", "navigate", "submit", "download"):
        payload = {"action": action, "tab_id": 1, "url": "https://example.com", "text": "x"}
        assert _tier_decision(SessionTier.AUTONOMOUS, payload) == "ask"


def test_full_tier_auto_runs_every_browser_intent() -> None:
    from core.session_tier import SessionTier

    actions = {"observe": "observe", "input": "click", "submit": "submit", "download": "download"}
    for intent in BROWSER_INTENTS:
        payload = {"intent": intent, "action": actions[intent]}
        assert _tier_decision(SessionTier.FULL, payload) == "allow"


def test_browser_tier_with_unknown_intent_falls_back_to_asking() -> None:
    from core.session_tier import SessionTier

    assert _tier_decision(SessionTier.FULL, {"intent": "observe", "action": "mystery"}) == "ask"
    assert _tier_decision(SessionTier.FULL, {"action": "observe", "intent": "pilot"}) == "ask"


# --- payload seam ----------------------------------------------------------


def test_intent_maps_from_action() -> None:
    assert browser_intent_of({"action": "observe"}) == "observe"
    assert browser_intent_of({"action": "observe-text"}) == "observe"
    assert browser_intent_of({"action": "navigate"}) == "input"
    assert browser_intent_of({"action": "click"}) == "input"
    assert browser_intent_of({"action": "submit"}) == "submit"
    assert browser_intent_of({"action": "download"}) == "download"
    assert browser_intent_of({"action": "mystery"}) == ""


def test_normalize_builds_bounded_commands() -> None:
    assert normalize_browser_command({"intent": "observe", "action": "observe"}) == {"action": "observe"}
    assert normalize_browser_command(
        {"intent": "observe", "action": "observe-text", "tab_id": 7}
    ) == {"action": "observe-text", "tabId": 7}
    assert normalize_browser_command(
        {"intent": "input", "action": "navigate", "url": "https://example.com"}
    ) == {"action": "navigate", "url": "https://example.com"}
    assert normalize_browser_command(
        {"intent": "input", "action": "text", "text": "hello", "tab_id": 3}
    ) == {"action": "text", "text": "hello", "tabId": 3}
    assert normalize_browser_command(
        {"intent": "input", "action": "click", "x": 1, "y": 2, "tab_id": 3}
    ) == {"action": "click", "x": 1, "y": 2, "tabId": 3}
    assert normalize_browser_command(
        {"intent": "submit", "action": "submit", "tab_id": 3}
    ) == {"action": "submit", "tabId": 3}
    assert normalize_browser_command(
        {"intent": "download", "action": "download", "url": "https://example.com/a.zip"}
    ) == {"action": "download", "url": "https://example.com/a.zip"}


def test_normalize_refuses_unsafe_or_mismatched_payloads() -> None:
    bad = [
        {"intent": "observe", "action": "observe-text"},             # content read needs its tab
        {"intent": "input", "action": "observe"},                    # intent/action mismatch
        {"action": "observe", "intent": "download"},                 # declared intent disagrees
        {"intent": "input", "action": "navigate", "url": "file:///C:/Windows"},  # not http(s)
        {"intent": "input", "action": "navigate", "url": "javascript:alert(1)"},
        {"intent": "input", "action": "navigate"},                   # url missing
        {"intent": "input", "action": "text", "text": "x" * 2000, "tab_id": 1},  # over bound
        {"intent": "input", "action": "key", "key": "a\nb", "tab_id": 1},        # control char
        {"intent": "input", "action": "click", "x": -1, "y": 2, "tab_id": 1},    # out of range
        {"intent": "input", "action": "back", "tab_id": True},       # bool is not a tab id
        {"intent": "download", "action": "download", "url": "ftp://example.com/a"},
    ]
    for payload in bad:
        try:
            normalize_browser_command(payload)
        except ValueError:
            continue
        raise AssertionError(f"payload should have been refused: {payload!r}")


# --- service round trip (the cross-thread bridge seam) ---------------------


def _observe_payload() -> dict:
    return {"operation": "local.browser.control", "intent": "observe", "action": "observe",
            "thread_id": "thread-1", "run_id": "run-1"}


def test_execute_consented_round_trip_resolves_bounded_result() -> None:
    service, sent = _service()
    payload = _observe_payload()

    async def scenario():
        task = asyncio.create_task(service.execute(payload, consent=True))
        while not sent:
            await asyncio.sleep(0.01)
        request = sent[0]
        assert request["type"] == "browser-control"
        assert request["command"] == {"action": "observe"}
        service.resolve(request["id"], {"tabs": [{"id": 1, "url": "https://example.com", "title": "Example"}]}, "")
        return await asyncio.wait_for(task, 2)

    outcome = asyncio.run(scenario())
    assert isinstance(outcome, BrowserControlResult)
    assert outcome.value == {"tabs": [{"id": 1, "url": "https://example.com", "title": "Example"}]}
    receipt = outcome.receipt.as_dict()
    assert receipt["capability"] == "local.browser.control"
    assert receipt["policy_decision"] == "allow"
    assert receipt["status"] == "completed"


def test_execute_without_consent_returns_consent_required() -> None:
    service, sent = _service()
    outcome = asyncio.run(service.execute(_observe_payload()))
    assert outcome is PolicyDecision.CONSENT_REQUIRED
    assert sent == []


def test_execute_times_out_without_a_desktop_reply() -> None:
    service, sent = _service(timeout=0.05)

    async def scenario():
        task = asyncio.create_task(service.execute(_observe_payload(), consent=True))
        while not sent:
            await asyncio.sleep(0.01)
        try:
            await asyncio.wait_for(task, 2)
        except BrowserControlError as exc:
            return exc.code
        raise AssertionError("expected a timeout refusal")

    assert asyncio.run(scenario()) == "AGENT_BROWSER_TIMEOUT"


def test_desktop_error_codes_cross_verbatim_others_are_recast() -> None:
    async def scenario(error):
        service, sent = _service()
        task = asyncio.create_task(service.execute(_observe_payload(), consent=True))
        while not sent:
            await asyncio.sleep(0.01)
        service.resolve(sent[0]["id"], None, error)
        try:
            await asyncio.wait_for(task, 2)
        except BrowserControlError as exc:
            return exc.code
        raise AssertionError("expected a structured refusal")

    assert asyncio.run(scenario("AGENT_BROWSER_NO_TAB")) == "AGENT_BROWSER_NO_TAB"
    assert asyncio.run(scenario("something unexpected")) == "AGENT_BROWSER_FAILED"


def test_oversized_results_are_refused_not_truncated() -> None:
    async def scenario(result):
        service, sent = _service()
        task = asyncio.create_task(service.execute(_observe_payload(), consent=True))
        while not sent:
            await asyncio.sleep(0.01)
        service.resolve(sent[0]["id"], result, "")
        try:
            await asyncio.wait_for(task, 2)
        except BrowserControlError as exc:
            return exc.code
        raise AssertionError("expected a bounded-result refusal")

    assert asyncio.run(scenario({"tabs": [{"id": i, "url": "https://e.com", "title": "t"}
                                          for i in range(21)]})) == "AGENT_BROWSER_RESULT_INVALID"
    assert asyncio.run(scenario("not a dict")) == "AGENT_BROWSER_RESULT_INVALID"


def test_timeout_receipt_says_result_not_verified(tmp_path) -> None:
    """A lost Desktop reply is not a proven failure: the receipt carries the
    效果待核实 status instead of failed (the action may have executed)."""
    import json

    server_key = Ed25519PrivateKey.generate()
    service, _sent = _service(timeout=0.05)
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        browser_control=service,
    )
    client.connection = FakeConnection()
    verified = _browser_task(server_key, "task-browser", _observe_payload())

    async def scenario():
        await client._handle_task(verified)
        consent_message = json.loads(client.connection.sent[-1])
        assert consent_message["type"] == MessageType.CONSENT_REQUIRED
        decision = sign_envelope(
            private_key=server_key,
            message_type=MessageType.CONSENT_DECISION,
            device_id="device-1",
            session_id="session-1",
            task_id="task-browser",
            payload={
                "approved": True,
                "actor_id": "alice",
                "request_hash": consent_message["payload"]["request_hash"],
            },
        )
        await client._handle_consent_decision(
            verify_envelope(
                decision,
                server_public_key=public_key_text(server_key),
                expected_device_id="device-1",
                expected_session_id="session-1",
            )
        )

    asyncio.run(scenario())
    result = json.loads(client.connection.sent[-1])
    assert result["payload"]["receipt"]["status"] == "result_not_verified"
    assert result["payload"]["error_code"] == "AGENT_BROWSER_TIMEOUT"


def test_resolve_for_unknown_request_is_ignored() -> None:
    service, sent = _service()
    service.resolve("no-such-request", None, "")
    assert sent == []


def test_concurrent_requests_keep_their_own_ids() -> None:
    service, sent = _service()

    async def scenario():
        first = asyncio.create_task(service.execute(_observe_payload(), consent=True))
        second = asyncio.create_task(
            service.execute({**_observe_payload(), "run_id": "run-2"}, consent=True)
        )
        while len(sent) < 2:
            await asyncio.sleep(0.01)
        assert sent[0]["id"] != sent[1]["id"]
        service.resolve(sent[1]["id"], {"tabs": []}, "")
        service.resolve(sent[0]["id"], {"tabs": []}, "")
        return await asyncio.wait_for(asyncio.gather(first, second), 2)

    outcomes = asyncio.run(scenario())
    assert all(isinstance(row, BrowserControlResult) for row in outcomes)


# --- consent summary and card projection -----------------------------------


def test_consent_summary_names_intent_and_target() -> None:
    summary = render_consent_summary("local.browser.control", {
        "intent": "input", "action": "navigate", "url": "https://example.com",
    })
    assert summary["intent"] == "input"
    assert summary["target"] == "https://example.com"
    assert "browser" in summary["action"]


# --- transport dispatch (the signed-task seam) -----------------------------


def _browser_task(server_key, task_id, payload):
    from core.protocol import MessageType, sign_envelope, verify_envelope, public_key_text

    task = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id=task_id,
        payload=payload,
    )
    return verify_envelope(
        task,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )


def _resolve_once(service, sent, result, error=""):
    """Resolve the pending request from a reader-thread-like context."""

    def resolver():
        deadline = time.monotonic() + 2
        while not sent and time.monotonic() < deadline:
            time.sleep(0.005)
        if sent:
            service.resolve(sent[0]["id"], result, error)

    thread = threading.Thread(target=resolver)
    thread.start()
    return thread


def test_browser_task_round_trip_rides_consent_and_receipt(tmp_path) -> None:
    import json

    server_key = Ed25519PrivateKey.generate()
    service, sent = _service()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        browser_control=service,
    )
    client.connection = FakeConnection()
    payload = {**_observe_payload(), "tool_call_id": "call-1"}
    verified = _browser_task(server_key, "task-browser", payload)

    async def scenario():
        await client._handle_task(verified)
        consent_message = json.loads(client.connection.sent[-1])
        assert consent_message["type"] == MessageType.CONSENT_REQUIRED
        decision = sign_envelope(
            private_key=server_key,
            message_type=MessageType.CONSENT_DECISION,
            device_id="device-1",
            session_id="session-1",
            task_id="task-browser",
            payload={
                "approved": True,
                "actor_id": "alice",
                "request_hash": consent_message["payload"]["request_hash"],
            },
        )
        await client._handle_consent_decision(
            verify_envelope(
                decision,
                server_public_key=public_key_text(server_key),
                expected_device_id="device-1",
                expected_session_id="session-1",
            )
        )

    thread = _resolve_once(service, sent, {"tabs": [{"id": 1, "url": "https://example.com", "title": "Example"}]})
    try:
        asyncio.run(scenario())
    finally:
        thread.join()

    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["result"] == {
        "tabs": [{"id": 1, "url": "https://example.com", "title": "Example"}]
    }
    assert result["payload"]["receipt"]["capability"] == "local.browser.control"
    assert result["payload"]["receipt"]["consent_decision"] == "approved"


def test_full_tier_answers_the_browser_ask_without_a_card(tmp_path) -> None:
    import json

    from core.session_tier import SessionTier, SessionTierRegistry

    server_key = Ed25519PrivateKey.generate()
    service, sent = _service()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        browser_control=service,
    )
    client.connection = FakeConnection()
    client.session_tiers = SessionTierRegistry()
    client.session_tiers.set("thread-1", SessionTier.FULL)
    payload = {**_observe_payload(), "tool_call_id": "call-1"}
    verified = _browser_task(server_key, "task-browser", payload)

    thread = _resolve_once(service, sent, {"tabs": []})
    try:
        asyncio.run(client._handle_task(verified))
    finally:
        thread.join()

    kinds = [json.loads(message)["type"] for message in client.connection.sent]
    assert MessageType.CONSENT_REQUIRED not in kinds
    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["receipt"]["consent_decision"] == "tier:full"


def test_browser_task_without_the_service_is_denied(tmp_path) -> None:
    import json

    server_key = Ed25519PrivateKey.generate()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
    )
    client.connection = FakeConnection()
    verified = _browser_task(server_key, "task-browser", _observe_payload())
    asyncio.run(client._handle_task(verified))
    result = json.loads(client.connection.sent[-1])
    assert result["payload"]["receipt"]["status"] == "denied"
    assert result["payload"]["error_code"] == "LOCAL_POLICY_DENIED"


def test_browser_ask_never_persists_an_always_allow_row(tmp_path) -> None:
    """#108: even a tray answer with 始终允许 must not record a standing
    grant - the page under any remembered approval changes between asks."""
    import sqlite3

    from core.consent import ConsentStore, ConsentExchange

    store = ConsentStore(db_path=tmp_path / "consent.db")
    coordinator_store = store
    server_key = Ed25519PrivateKey.generate()
    service, sent = _service(consent=coordinator_store)
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        browser_control=service,
    )
    client.connection = FakeConnection()
    verified = _browser_task(server_key, "task-browser", _observe_payload())

    thread = _resolve_once(service, sent, {"tabs": []})
    try:
        asyncio.run(client._handle_task(verified))
        consent_message = json.loads(client.connection.sent[-1])
        assert consent_message["type"] == MessageType.CONSENT_REQUIRED
        decision = sign_envelope(
            private_key=server_key,
            message_type=MessageType.CONSENT_DECISION,
            device_id="device-1",
            session_id="session-1",
            task_id="task-browser",
            payload={
                "approved": True,
                "actor_id": "alice",
                "request_hash": consent_message["payload"]["request_hash"],
                "always": True,
            },
        )
        asyncio.run(client._handle_consent_decision(
            verify_envelope(
                decision,
                server_public_key=public_key_text(server_key),
                expected_device_id="device-1",
                expected_session_id="session-1",
            )
        ))
    finally:
        thread.join()

    with sqlite3.connect(coordinator_store.db_path) as db:
        rows = db.execute("SELECT capability FROM always_allowed").fetchall()
    assert ("local.browser.control",) not in rows
