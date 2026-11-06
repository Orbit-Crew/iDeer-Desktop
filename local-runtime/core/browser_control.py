"""Issue 108: the agent's controlled channel into the local browser pane.

The platform agent drives the user's own browser pane (观察/输入/提交/下载)
through exactly one seam: a signed task naming ``local.browser.control``
lands here after the local policy and the session tier have had their say,
and this service forwards one normalized command to the Desktop shell over
the runtime's stdout wire. The Desktop answers on stdin; nothing else in
the runtime can reach a web page, and there is no arbitrary-code channel -
every action is a fixed shape validated on both ends, and page facts come
back bounded or not at all.

The wire is one request in flight per task: the service emits
``{'v':1,'type':'browser-control','id','command'}`` and waits for
``{'v':1,'type':'browser-control-result','id','result','error'}`` from the
Desktop's stdin reader thread. A timeout, a structured Desktop refusal, or
an out-of-bounds result raises :class:`BrowserControlError` so the fixed
category crosses the task boundary verbatim - never recast as a generic
failure.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

from .consent import ConsentStore
from .policy import LocalPolicy, PolicyDecision
from .receipts import LocalExecutionReceipt, content_hash

BROWSER_CONTROL_CAPABILITY = "local.browser.control"

# The task-facing intents (审批语义) and the concrete actions behind them.
# 观察 reads the pane's own state; everything else mutates the page or
# produces a download, so the upgraded tiers only auto-run reads.
BROWSER_INTENTS = frozenset({"observe", "input", "submit", "download"})
_INTENT_ACTIONS: dict[str, frozenset[str]] = {
    "observe": frozenset({"observe", "observe-text"}),
    "input": frozenset({"navigate", "back", "forward", "reload", "key", "text", "click"}),
    "submit": frozenset({"submit"}),
    "download": frozenset({"download"}),
}
_ACTION_INTENTS = {
    action: intent for intent, actions in _INTENT_ACTIONS.items() for action in actions
}

MAX_URL_LENGTH = 2048
MAX_TEXT_LENGTH = 1024
MAX_KEY_LENGTH = 16
MAX_COORDINATE = 100000
MAX_TAB_ID = 10000000
# 观察's text read is the one channel page content may take; it stays a
# fraction of the chat result cap so a huge page can never flood the wire.
MAX_OBSERVE_TEXT = 20000
MAX_TABS = 20
MAX_TITLE_LENGTH = 300
AGENT_BROWSER_MAX_RESULT_CHARS = 4096

DEFAULT_CONTROL_TIMEOUT_SECONDS = 10.0


class BrowserControlError(Exception):
    """One fixed browser-control category; the code crosses the boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def browser_intent_of(payload: dict[str, Any]) -> str:
    """The declared intent of one browser-control payload ('' when unknown).

    The action names the intent; a declared ``intent`` field must agree.
    Reading the intent straight off the action is what lets the tier rule
    classify a request even where the caller omitted the field.
    """
    action = payload.get("action")
    derived = _ACTION_INTENTS.get(action, "") if isinstance(action, str) else ""
    if not derived:
        return ""
    declared = payload.get("intent")
    if declared is None or declared == derived:
        return derived
    return ""


def _bounded_int(payload: dict[str, Any], key: str, high: int) -> int:
    value = payload.get(key)
    if type(value) is not int or not 0 <= value <= high:
        raise ValueError(f"{key} out of range")
    return value


def _optional_tab_id(payload: dict[str, Any]) -> int | None:
    if "tab_id" not in payload or payload.get("tab_id") is None:
        return None
    return _bounded_int(payload, "tab_id", MAX_TAB_ID)


def _web_url(payload: dict[str, Any]) -> str:
    url = payload.get("url")
    if not isinstance(url, str) or not 0 < len(url) <= MAX_URL_LENGTH:
        raise ValueError("url missing or too long")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("url is not an http(s) address")
    return url


def _typed_text(payload: dict[str, Any]) -> str:
    text = payload.get("text")
    if not isinstance(text, str) or not 0 < len(text) <= MAX_TEXT_LENGTH:
        raise ValueError("text missing or too long")
    return text


def _key_name(payload: dict[str, Any]) -> str:
    key = payload.get("key")
    if not isinstance(key, str) or not 0 < len(key) <= MAX_KEY_LENGTH:
        raise ValueError("key missing or too long")
    if any(ord(character) < 32 for character in key):
        raise ValueError("key carries control characters")
    return key


def normalize_browser_command(payload: dict[str, Any]) -> dict[str, Any]:
    """The one strict shape the Desktop accepts for a browser action.

    Only whitelisted fields are copied into the command; everything else in
    the payload stays behind, so a smuggled key can never reach the pane.
    Raises ``ValueError`` for any malformed or out-of-bounds field.
    """
    intent = browser_intent_of(payload)
    if not intent:
        raise ValueError("intent and action do not name a browser control")
    action = payload.get("action")
    command: dict[str, Any] = {"action": action}
    if intent == "observe":
        if action == "observe-text":
            # A content read always names its tab; the pane list read is the
            # only untargeted action.
            command["tabId"] = _bounded_int(payload, "tab_id", MAX_TAB_ID)
        return command
    tab_id = _optional_tab_id(payload)
    if action == "navigate":
        command["url"] = _web_url(payload)
    elif action in ("key", "text"):
        command["key" if action == "key" else "text"] = (
            _key_name(payload) if action == "key" else _typed_text(payload)
        )
    elif action == "click":
        command["x"] = _bounded_int(payload, "x", MAX_COORDINATE)
        command["y"] = _bounded_int(payload, "y", MAX_COORDINATE)
    elif action == "download":
        command["url"] = _web_url(payload)
    if tab_id is not None:
        command["tabId"] = tab_id
    return command


@dataclass(frozen=True)
class BrowserControlResult:
    """One executed action: the bounded facts plus the execution receipt."""

    value: dict[str, Any]
    receipt: LocalExecutionReceipt


class BrowserControlService:
    """The runtime's single channel into the Desktop's local browser pane.

    ``emit`` is the runtime's thread-safe stdout writer; ``resolve`` is
    called from the Desktop's stdin reader thread with the matching reply.
    Requests carry no standing grants: page content changes under any
    remembered approval, so every consented ask is fresh.
    """

    capability = BROWSER_CONTROL_CAPABILITY

    def __init__(
        self,
        emit: Callable[[dict[str, Any]], None],
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
        timeout: float = DEFAULT_CONTROL_TIMEOUT_SECONDS,
    ) -> None:
        self._emit = emit
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()
        self._timeout = timeout
        self._pending: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Future]] = {}

    async def execute(
        self, payload: dict[str, Any], *, consent: bool = False
    ) -> BrowserControlResult | PolicyDecision:
        command = normalize_browser_command(payload)
        decision = self.policy.authorize(
            BROWSER_CONTROL_CAPABILITY, dict(payload), consent=consent
        )
        if decision is not PolicyDecision.ALLOW:
            return decision
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[request_id] = (loop, future)
        try:
            self._emit(
                {"v": 1, "type": "browser-control", "id": request_id, "command": command}
            )
            result, error = await asyncio.wait_for(future, self._timeout)
        except asyncio.TimeoutError:
            raise BrowserControlError("AGENT_BROWSER_TIMEOUT") from None
        finally:
            self._pending.pop(request_id, None)
        if error:
            raise BrowserControlError(
                error if str(error).startswith("AGENT_BROWSER_") else "AGENT_BROWSER_FAILED"
            )
        value = self._validate_result(result)
        return BrowserControlResult(
            value=value,
            receipt=self._receipt(payload, value),
        )

    def resolve(self, request_id: str, result: Any, error: Any) -> None:
        """Route one Desktop reply to its waiting task (reader thread)."""
        pending = self._pending.get(str(request_id))
        if pending is None:
            return
        loop, future = pending
        if future.done():
            return
        loop.call_soon_threadsafe(self._settle, future, result, error)

    @staticmethod
    def _settle(future: asyncio.Future, result: Any, error: Any) -> None:
        if not future.done():
            future.set_result((result, str(error) if error else ""))

    def _validate_result(self, result: Any) -> dict[str, Any]:
        """Page facts stay bounded or the action fails; nothing is widened."""
        if not isinstance(result, dict):
            raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
        tabs = result.get("tabs")
        if tabs is not None:
            if not isinstance(tabs, list) or len(tabs) > MAX_TABS:
                raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
            for tab in tabs:
                if (
                    not isinstance(tab, dict)
                    or type(tab.get("id")) is not int
                    or not isinstance(tab.get("url"), str)
                    or len(tab["url"]) > MAX_URL_LENGTH
                    or not isinstance(tab.get("title"), str)
                    or len(tab["title"]) > MAX_TITLE_LENGTH
                ):
                    raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
            return {"tabs": tabs}
        text = result.get("text")
        if text is not None:
            if (
                not isinstance(text, str)
                or len(text) > MAX_OBSERVE_TEXT
                or not isinstance(result.get("url"), str)
                or len(result["url"]) > MAX_URL_LENGTH
                or not isinstance(result.get("title"), str)
                or len(result["title"]) > MAX_TITLE_LENGTH
            ):
                raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
            return {"url": result["url"], "title": result["title"], "text": text}
        simple: dict[str, Any] = {}
        for key in ("url", "title", "submitted", "queued"):
            if key not in result:
                continue
            value = result[key]
            if key in ("url", "title"):
                if not isinstance(value, str) or len(value) > (
                    MAX_URL_LENGTH if key == "url" else MAX_TITLE_LENGTH
                ):
                    raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
            elif not isinstance(value, bool):
                raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
            simple[key] = value
        if len(json.dumps(simple, ensure_ascii=False)) > AGENT_BROWSER_MAX_RESULT_CHARS:
            raise BrowserControlError("AGENT_BROWSER_RESULT_INVALID")
        return simple

    def _receipt(self, payload: dict[str, Any], value: dict[str, Any]) -> LocalExecutionReceipt:
        return LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id="",
            capability=BROWSER_CONTROL_CAPABILITY,
            policy_decision=PolicyDecision.ALLOW.value,
            status="completed",
            payload_hash=content_hash(dict(payload)),
            result_hash=content_hash(value),
        )
