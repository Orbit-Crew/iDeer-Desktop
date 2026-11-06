"""Issue 109: the platform live-browser stream proxy contract.

The proxy is the Desktop's Runtime-side seam to the platform's browser
WebSocket (backend browser.py @ a7037c3f): it authenticates with the session's
own access-token cookie, requests binary screencast frames, projects server
JSON payloads into bounded display events, forwards client input events, and
maps the server's close codes to honest categories. A locally commanded close
is silent (the command reply is the only fact); only the stream's own death is
announced. The access token never appears in any emitted event. The proxy's
``run`` coroutine is driven on the fake platform's own loop — the same
single-loop shape the transport tests use; production runs it on a dedicated
client-only thread instead.
"""
from __future__ import annotations

import asyncio
import base64
import json
import queue
from contextlib import asynccontextmanager

import pytest
from websockets.asyncio.server import serve

from core.browser_remote import BrowserStreamProxy, close_category, normalize_input_event


@asynccontextmanager
async def fake_platform(handler):
    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        yield f"http://127.0.0.1:{port}"


async def expect(events: queue.Queue, kind: str, timeout: float = 5.0) -> dict:
    """One event of the wanted kind, tolerating any interleaving. The wait
    rides a worker thread so the loop hosting the proxy keeps running."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"no {kind!r} event within {timeout}s")
        try:
            event = await asyncio.to_thread(events.get, timeout=min(remaining, 0.25))
        except queue.Empty:
            continue
        if event.get("kind") == kind:
            return event


async def nothing_within(events: queue.Queue, timeout: float = 0.4) -> bool:
    try:
        await asyncio.to_thread(events.get, timeout=timeout)
    except queue.Empty:
        return True
    return False


def test_close_codes_map_to_honest_categories():
    assert close_category(4401) == "UNAUTHENTICATED"
    assert close_category(4403) == "ORIGIN_REJECTED"
    assert close_category(4404) == "THREAD_UNAVAILABLE"
    assert close_category(4409) == "SCREENCAST_FAILED"
    assert close_category(4429) == "SESSION_CAPACITY"
    assert close_category(4501) == "SERVICE_UNAVAILABLE"
    assert close_category(1000) == "CLOSED"
    assert close_category(1011) == "CONNECTION_LOST"


def test_input_events_are_bounded_to_the_server_vocabulary():
    assert normalize_input_event({"type": "click", "x": 1.0, "y": 2.0, "button": "right"}) == {
        "type": "click", "x": 1.0, "y": 2.0, "button": "right"
    }
    assert normalize_input_event({"type": "back"}) == {"type": "back"}
    assert normalize_input_event({"type": "activate_tab", "index": 2}) == {"type": "activate_tab", "index": 2}
    for bad in [
        {"type": "drag", "x": 1, "y": 1},
        {"type": "click", "x": "a", "y": 1},
        {"type": "click", "x": 1e9, "y": 1},
        {"type": "click", "x": 1, "y": 1, "button": "double"},
        {"type": "text", "text": ""},
        {"type": "text", "text": "x" * 1025},
        {"type": "navigate", "url": ""},
        {"type": "wheel", "dx": 1},
        {"type": "activate_tab", "index": -1},
        {"type": "key", "key": "k" * 65},
        "click",
        None,
    ]:
        with pytest.raises(ValueError):
            normalize_input_event(bad)


def test_connects_with_the_session_cookie_and_binary_frames():
    seen = {}

    async def handler(connection):
        seen["path"] = connection.request.path
        seen["cookie"] = connection.request.headers.get("Cookie")
        seen["origin"] = connection.request.headers.get("Origin")
        await asyncio.sleep(30)

    async def scenario():
        async with fake_platform(handler) as origin:
            events: queue.Queue = queue.Queue()
            proxy = BrowserStreamProxy(origin, "tok-1", "th-1", events.put)
            task = asyncio.create_task(proxy.run())
            try:
                assert (await expect(events, "state"))["state"] == "connecting"
                assert (await expect(events, "state"))["state"] == "open"
                assert seen["path"] == "/api/threads/th-1/browser/stream?frame_format=binary"
                assert "access_token=tok-1" in (seen["cookie"] or "")
                # A non-browser client sends no Origin header; the server's
                # own WS-CSRF check allows exactly that shape.
                assert seen["origin"] is None
            finally:
                proxy.close()
            await asyncio.wait_for(task, 10)
            assert await nothing_within(events)

    asyncio.run(scenario())


def test_binary_frames_are_relayed_as_base64_and_control_payloads_projected():
    async def handler(connection):
        async with connection:
            await connection.send(b"\xff\xd8frame-bytes")
            await connection.send(json.dumps({"type": "url", "url": "https://example.test/a"}))
            await connection.send(json.dumps({"type": "nav_rejected", "url": "https://intranet.test/x", "message": "denied"}))
            await connection.send(json.dumps({"type": "tabs", "tabs": [{"index": 0, "title": "t", "url": "https://example.test", "active": True}]}))
            await asyncio.sleep(30)

    async def scenario():
        async with fake_platform(handler) as origin:
            events: queue.Queue = queue.Queue()
            proxy = BrowserStreamProxy(origin, "tok-1", "th-1", events.put)
            task = asyncio.create_task(proxy.run())
            try:
                await expect(events, "state")  # connecting
                await expect(events, "state")  # open
                frame = await expect(events, "frame")
                assert base64.b64decode(frame["data"]) == b"\xff\xd8frame-bytes"
                assert await expect(events, "url") == {"kind": "url", "url": "https://example.test/a"}
                assert await expect(events, "nav-rejected") == {
                    "kind": "nav-rejected", "url": "https://intranet.test/x", "message": "denied"}
                tabs = await expect(events, "tabs")
                assert tabs["tabs"] == [{"index": 0, "title": "t", "url": "https://example.test", "active": True}]
            finally:
                proxy.close()
            await asyncio.wait_for(task, 10)

    asyncio.run(scenario())


def test_oversized_frames_are_dropped_but_the_stream_continues():
    async def handler(connection):
        async with connection:
            await connection.send(b"x" * 64)
            await connection.send(b"\xff\xd8small")
            await asyncio.sleep(30)

    async def scenario():
        async with fake_platform(handler) as origin:
            events: queue.Queue = queue.Queue()
            proxy = BrowserStreamProxy(origin, "tok-1", "th-1", events.put, frame_limit=16)
            task = asyncio.create_task(proxy.run())
            try:
                await expect(events, "state")
                await expect(events, "state")
                frame = await expect(events, "frame")
                assert base64.b64decode(frame["data"]) == b"\xff\xd8small"
                assert len([e for e in list(events.queue) if e.get("kind") == "frame"]) == 0
            finally:
                proxy.close()
            await asyncio.wait_for(task, 10)

    asyncio.run(scenario())


def test_input_events_reach_the_server_and_bad_shapes_never_leave():
    received: queue.Queue = queue.Queue()

    async def handler(connection):
        async def reader():
            async for raw in connection:
                received.put(json.loads(raw))

        task = asyncio.create_task(reader())
        try:
            await asyncio.sleep(30)
        finally:
            task.cancel()

    async def scenario():
        async with fake_platform(handler) as origin:
            events: queue.Queue = queue.Queue()
            proxy = BrowserStreamProxy(origin, "tok-1", "th-1", events.put)
            task = asyncio.create_task(proxy.run())
            try:
                await expect(events, "state")
                await expect(events, "state")
                assert proxy.send_input({"type": "navigate", "url": "https://example.test/b"}) is True
                assert await asyncio.to_thread(received.get, 5) == {"type": "navigate", "url": "https://example.test/b"}
                with pytest.raises(ValueError):
                    proxy.send_input({"type": "drag", "x": 1, "y": 1})
                assert await nothing_within(received)
            finally:
                proxy.close()
            await asyncio.wait_for(task, 10)

    asyncio.run(scenario())


def test_server_close_code_becomes_an_honest_closed_event():
    async def handler(connection):
        await connection.close(code=4404)

    async def scenario():
        async with fake_platform(handler) as origin:
            events: queue.Queue = queue.Queue()
            proxy = BrowserStreamProxy(origin, "tok-1", "th-1", events.put)
            task = asyncio.create_task(proxy.run())
            closed = await expect(events, "state")
            while closed["state"] != "closed":
                closed = await expect(events, "state")
            assert closed == {"kind": "state", "state": "closed", "code": 4404, "category": "THREAD_UNAVAILABLE"}
            await asyncio.wait_for(task, 10)

    asyncio.run(scenario())


def test_unreachable_platform_reports_connection_failed():
    async def scenario():
        events: queue.Queue = queue.Queue()
        proxy = BrowserStreamProxy("http://127.0.0.1:9", "tok-1", "th-1", events.put)
        task = asyncio.create_task(proxy.run())
        error = await expect(events, "stream-error", timeout=10)
        assert error["category"] == "CONNECTION_FAILED"
        closed = await expect(events, "state", timeout=10)
        while closed["state"] != "closed":
            closed = await expect(events, "state", timeout=10)
        assert closed["category"] == "CONNECTION_FAILED"
        await asyncio.wait_for(task, 10)

    asyncio.run(scenario())


def test_input_after_a_dead_stream_is_refused_without_emitting():
    async def handler(connection):
        await connection.close(code=4404)

    async def scenario():
        async with fake_platform(handler) as origin:
            events: queue.Queue = queue.Queue()
            proxy = BrowserStreamProxy(origin, "tok-1", "th-1", events.put)
            task = asyncio.create_task(proxy.run())
            closed = await expect(events, "state")
            while closed["state"] != "closed":
                closed = await expect(events, "state")
            assert proxy.send_input({"type": "back"}) is False
            assert await nothing_within(events)
            await asyncio.wait_for(task, 10)

    asyncio.run(scenario())
