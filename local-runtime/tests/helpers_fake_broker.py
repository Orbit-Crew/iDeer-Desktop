"""A thread-owned fake Broker that speaks the real signed envelope protocol.

The tray tests drive consent end to end through this: the runtime loop thread
receives a task, parks on the consent prompt, and the test's own thread answers
it — exactly the shape a desktop tray has. Signatures are the real ones, so the
device verifies frames rather than trusting them.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.protocol import MessageType, public_key_text, sign_envelope


class FakeBroker:
    """A minimal device-facing Broker: hello handshake plus signed frames."""

    def __init__(self, *, device_id: str = "device-1") -> None:
        self.device_id = device_id
        self.server_key = Ed25519PrivateKey.generate()
        self.public_key = public_key_text(self.server_key)
        self.received: list[dict[str, Any]] = []
        self.url = ""
        self.session_id: str | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._connection: Any = None
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._done: asyncio.Event | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=10):
            raise RuntimeError("the fake broker did not start")

    # --- lifecycle -------------------------------------------------------

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._main())
        except RuntimeError:
            pass  # stop() ends the thread by stopping the loop, not by returning

    async def _main(self) -> None:
        done = self._done = asyncio.Event()

        async def handler(connection) -> None:
            hello = json.loads(await connection.recv())
            with self._lock:
                self.session_id = str(hello["session_id"])
                self._connection = connection
                self.received.append(hello)
            await connection.send(
                json.dumps(
                    self._envelope(
                        MessageType.HELLO,
                        None,
                        {"server_public_key": self.public_key, "protocol_version": "1"},
                    )
                )
            )
            async for raw in connection:
                with self._lock:
                    self.received.append(json.loads(raw))

        async with serve(handler, "127.0.0.1", 0) as server:
            self.url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            self._ready.set()
            await done.wait()

    def stop(self) -> None:
        """Let the server context shut down, so no half-closed socket lingers."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(self._done.set)
        self._thread.join(timeout=5)

    # --- messaging -------------------------------------------------------

    def _envelope(self, message_type: MessageType, task_id: str | None, payload: dict):
        assert self.session_id is not None, "no device session yet"
        return sign_envelope(
            private_key=self.server_key,
            message_type=message_type,
            device_id=self.device_id,
            session_id=self.session_id,
            task_id=task_id,
            payload=payload,
        )

    def send(
        self, message_type: MessageType, payload: dict, *, task_id: str | None = None
    ) -> None:
        """Push one signed frame to the connected device."""
        loop, connection = self._loop, self._connection
        if loop is None or connection is None:
            raise RuntimeError("no device is connected to the fake broker")
        frame = json.dumps(self._envelope(message_type, task_id, payload))
        asyncio.run_coroutine_threadsafe(connection.send(frame), loop).result(timeout=5)

    def drop_device(self) -> None:
        """Kill the socket with no close frame, like a network going away.

        A polite `close()` would end the device read loop with no exception at
        all; aborting the transport is what makes the client raise
        ConnectionClosedError, the non-OSError a supervisor has to survive.
        """
        loop, connection = self._loop, self._connection
        if loop is None or connection is None:
            raise RuntimeError("no device is connected to the fake broker")
        loop.call_soon_threadsafe(connection.transport.abort)
        time.sleep(0.05)

    def await_device(self, timeout: float = 10.0) -> None:
        """Wait until a device session exists to address."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self.session_id is not None:
                    return
            time.sleep(0.01)
        raise AssertionError("the device never said hello")

    def expect(
        self, message_type: MessageType, *, timeout: float = 10.0
    ) -> dict[str, Any]:
        """The next frame of this type; ACK and progress frames are skipped."""
        deadline = time.monotonic() + timeout
        index = 0
        while True:
            with self._lock:
                snapshot = list(self.received)
            for position in range(index, len(snapshot)):
                if snapshot[position]["type"] == message_type.value:
                    with self._lock:
                        return self.received.pop(position)
            index = len(snapshot)
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"no {message_type.value} frame within {timeout}s; "
                    f"received {[m['type'] for m in snapshot]}"
                )
            time.sleep(0.01)
