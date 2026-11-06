"""Platform live-browser stream proxy (issue 109).

The Desktop's remote browser pane drives the platform's own browser service
(``backend/app/gateway/routers/browser.py``): one WebSocket per Thread whose
``access_token`` cookie is the session credential. The credential and the
paired origin never leave this process — this proxy is the only client. It
requests binary screencast frames, relays them base64-encoded through the
bounded JSON control pipe (the platform itself treats the screencast as lossy
and drops stale frames, so a bounded drop-oldest queue matches the contract),
projects the server's JSON payloads into bounded display events, forwards the
user's input events, and maps the server's close codes to honest categories.
A locally commanded close is silent: the command reply is the only fact the
Desktop needs, so nothing is announced twice.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import queue
import threading

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidURI

# browser.py's close codes, each surfaced as the reason it actually is.
CLOSE_CATEGORIES = {
    4401: "UNAUTHENTICATED",
    4403: "ORIGIN_REJECTED",
    4404: "THREAD_UNAVAILABLE",
    4409: "SCREENCAST_FAILED",
    4429: "SESSION_CAPACITY",
    4501: "SERVICE_UNAVAILABLE",
}

INPUT_TYPES = {"move", "down", "up", "click", "wheel", "key", "text", "navigate", "back", "forward", "activate_tab"}
BUTTONS = {"left", "right", "middle"}

_PUMP_STOP = object()


def close_category(code: int | None) -> str:
    if code in CLOSE_CATEGORIES:
        return CLOSE_CATEGORIES[code]
    if code in (1000, 1005):
        return "CLOSED"
    return "CONNECTION_LOST"


def _bounded_number(value, limit: float = 100000.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not -limit <= value <= limit:
        raise ValueError("BROWSER_INPUT_INVALID")
    return float(value)


def _bounded_text(value, limit: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= limit:
        raise ValueError("BROWSER_INPUT_INVALID")
    return value


def normalize_input_event(event) -> dict:
    """One bounded input event in the server's own vocabulary. Anything else
    is refused before it can leave the device."""
    if not isinstance(event, dict):
        raise ValueError("BROWSER_INPUT_INVALID")
    kind = event.get("type")
    if kind not in INPUT_TYPES:
        raise ValueError("BROWSER_INPUT_INVALID")
    keys = set(event)
    if kind == "move" and keys == {"type", "x", "y"}:
        return {"type": "move", "x": _bounded_number(event["x"]), "y": _bounded_number(event["y"])}
    if kind in {"down", "up", "click"} and keys in ({"type", "x", "y"}, {"type", "x", "y", "button"}):
        result: dict = {"type": kind, "x": _bounded_number(event["x"]), "y": _bounded_number(event["y"])}
        if "button" in event:
            if event["button"] not in BUTTONS:
                raise ValueError("BROWSER_INPUT_INVALID")
            result["button"] = event["button"]
        return result
    if kind == "wheel" and keys == {"type", "dx", "dy"}:
        return {"type": "wheel", "dx": _bounded_number(event["dx"]), "dy": _bounded_number(event["dy"])}
    if kind == "key" and keys == {"type", "key"}:
        return {"type": "key", "key": _bounded_text(event["key"], 64)}
    if kind == "text" and keys == {"type", "text"}:
        return {"type": "text", "text": _bounded_text(event["text"], 1024)}
    if kind == "navigate" and keys == {"type", "url"}:
        return {"type": "navigate", "url": _bounded_text(event["url"], 2048)}
    if kind in {"back", "forward"} and keys == {"type"}:
        return {"type": kind}
    if kind == "activate_tab" and keys == {"type", "index"}:
        index = event["index"]
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= 10000:
            raise ValueError("BROWSER_INPUT_INVALID")
        return {"type": "activate_tab", "index": index}
    raise ValueError("BROWSER_INPUT_INVALID")


class BrowserStreamProxy:
    """One platform live-browser stream. ``emit`` receives bounded event
    dicts; the caller wraps them with the stream id and pushes them through
    the JSON control pipe. Frames ride a bounded inbound queue (drop-oldest,
    matching the platform's own lossy screencast), input events a bounded
    outbound queue; neither the control pipe nor the socket can back up."""

    def __init__(self, origin: str, token: str, thread_id: str, emit,
                 frame_limit: int = 3_000_000, queue_depth: int = 64):
        self._origin = origin.rstrip("/")
        self._token = token
        self._thread_id = thread_id
        self._sink = emit
        self._frame_limit = frame_limit
        self._inbound: queue.Queue = queue.Queue(maxsize=queue_depth)
        self._outbound: queue.Queue = queue.Queue(maxsize=queue_depth)
        self._closing = threading.Event()
        self._dead = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._socket = None

    def start(self) -> None:
        """Production entry: one dedicated thread with its own event loop
        (client-only; the Runtime's other loops never host local servers)."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=lambda: asyncio.run(self.run()),
                                        name="browser-stream-proxy", daemon=True)
        self._thread.start()

    async def run(self) -> None:
        """The stream's coroutine: connect, relay, and die quietly. Tests
        drive it directly on their own loop; the emitting pump keeps the
        receive path free of any sink backpressure."""
        self._emit({"kind": "state", "state": "connecting"})
        pump = threading.Thread(target=self._drain_inbound, name="browser-stream-pump", daemon=True)
        pump.start()
        try:
            await self._main()
        finally:
            self._dead.set()
            self._offer(self._inbound, _PUMP_STOP)

    def send_input(self, event: dict) -> bool:
        """Validates and forwards one input event; False once the stream is
        going away — the caller turns that into an honest refusal. A bad
        shape raises ValueError before anything leaves the device."""
        normalized = normalize_input_event(event)
        if self._closing.is_set() or self._dead.is_set():
            return False
        return self._offer(self._outbound, normalized)

    def close(self) -> None:
        """Silent local close: the command reply is the only fact."""
        self._closing.set()
        loop, socket = self._loop, self._socket
        if loop is not None and socket is not None:
            def _close():
                with contextlib.suppress(RuntimeError):
                    asyncio.ensure_future(socket.close(code=1000))
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(_close)

    # -- internal plumbing -------------------------------------------------

    @staticmethod
    def _offer(target: queue.Queue, event: dict) -> bool:
        """Bounded drop-oldest enqueue; overflow sheds the oldest fact, which
        for frames is the platform's own semantics."""
        try:
            if target.full():
                with contextlib.suppress(queue.Empty):
                    target.get_nowait()
            target.put_nowait(event)
            return True
        except queue.Full:
            return False

    def _emit(self, event: dict) -> None:
        try:
            self._sink(event)
        except Exception:
            pass

    def _drain_inbound(self) -> None:
        while True:
            event = self._inbound.get()
            if event is _PUMP_STOP:
                return
            self._emit(event)

    async def _main(self) -> None:
        url = f"{self._origin.replace('http', 'ws', 1)}/api/threads/{self._thread_id}/browser/stream?frame_format=binary"
        try:
            async with connect(url, additional_headers={"Cookie": f"access_token={self._token}"},
                               max_size=None, open_timeout=10) as socket:
                self._socket = socket
                self._loop = asyncio.get_running_loop()
                self._emit({"kind": "state", "state": "open"})
                sender = asyncio.create_task(self._pump_inputs(socket))
                try:
                    async for message in socket:
                        self._relay(message)
                finally:
                    sender.cancel()
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd is not None else 1006
            # A local close stays silent; only the stream's own death talks.
            if not self._closing.is_set():
                self._offer(self._inbound, {"kind": "state", "state": "closed",
                                            "code": code, "category": close_category(code)})
        except (OSError, InvalidHandshake, InvalidURI, asyncio.TimeoutError):
            if not self._closing.is_set():
                self._offer(self._inbound, {"kind": "stream-error", "category": "CONNECTION_FAILED", "message": ""})
                self._offer(self._inbound, {"kind": "state", "state": "closed",
                                            "code": 1006, "category": "CONNECTION_FAILED"})

    def _relay(self, message) -> None:
        if isinstance(message, bytes):
            if not message or len(message) > self._frame_limit:
                return  # the screencast is lossy by contract; drop the stale frame
            self._offer(self._inbound, {"kind": "frame", "data": base64.b64encode(message).decode("ascii")})
            return
        if not isinstance(message, str):
            return
        try:
            payload = json.loads(message)
        except ValueError:
            return
        if not isinstance(payload, dict):
            return
        kind = payload.get("type")
        if kind == "url" and isinstance(payload.get("url"), str) and payload["url"]:
            self._offer(self._inbound, {"kind": "url", "url": payload["url"][:2048]})
        elif kind == "tabs" and isinstance(payload.get("tabs"), list):
            rows = []
            for row in payload["tabs"][:20]:
                if isinstance(row, dict):
                    rows.append({"index": row["index"] if isinstance(row.get("index"), int) and not isinstance(row.get("index"), bool) else 0,
                                 "title": str(row.get("title", ""))[:256],
                                 "url": str(row.get("url", ""))[:2048],
                                 "active": row.get("active") is True})
            self._offer(self._inbound, {"kind": "tabs", "tabs": rows})
        elif kind == "nav_rejected":
            self._offer(self._inbound, {"kind": "nav-rejected", "url": str(payload.get("url", ""))[:2048],
                                        "message": str(payload.get("message", ""))[:512]})
        elif kind == "error":
            self._offer(self._inbound, {"kind": "stream-error", "category": "STREAM_ERROR",
                                        "message": str(payload.get("message", ""))[:512]})

    async def _pump_inputs(self, socket) -> None:
        loop = asyncio.get_running_loop()
        while True:
            event = await loop.run_in_executor(None, self._next_outbound)
            if event is None:
                continue
            if event is _PUMP_STOP:
                return
            try:
                await socket.send(json.dumps(event))
            except (ConnectionClosed, RuntimeError):
                return

    def _next_outbound(self):
        try:
            return self._outbound.get(timeout=0.2)
        except queue.Empty:
            return None
