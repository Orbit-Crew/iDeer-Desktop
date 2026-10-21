"""Outbound-only WebSocket transport for the harmless M7 echo task.

The wire session (``LocalRuntimeClient``) owns the connection, the pause /
resume / close / shutdown controls and the running-task registry. The consent
state machine lives in ``LocalConsentCoordinator`` (``consent_coord``), so a
session can be tested without a consent prompt and a consent prompt can be
tested without a socket.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import replace
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from .audit import AuditEntry, AuditKind, LocalAuditLog
from .consent import (
    ConsentRequest,
    ConsentStore,
    PendingConsent,
)
from .consent_coord import (
    ConsentPrompt,
    LocalConsentCoordinator,
)
from .file_service import FileTaskResult, LocalFileService
from .files import FileAccessError
from .mcp import LocalMCPService, MCPExecution
from .policy import LocalPolicy, PolicyDecision
from .protocol import (
    MessageType,
    ProtocolError,
    new_session_id,
    public_key_text,
    sign_envelope,
    verify_envelope,
)
from .python import LocalPythonService, PythonResult
from .receipts import LocalExecutionReceipt, content_hash
from .secrets import SecretStoreError
from .task_guard import TaskGuard


class RePairRequired(RuntimeError):
    """The server rejected this session and automatic reconnect is unsafe."""


class LocalRuntimeClient:
    """Connect to the Broker and execute only the protocol's echo task."""

    def __init__(
        self,
        *,
        server_url: str,
        device_id: str,
        session_token: str,
        private_key: Ed25519PrivateKey,
        session_id: str | None = None,
        protocol_version: str = "1",
        runtime_version: str = "0.1.0",
        capabilities: tuple[str, ...] | None = None,
        policy_hash: str | None = None,
        server_public_key: str | None = None,
        allow_unpinned_broker_key: bool = False,
        policy: LocalPolicy | None = None,
        file_service: LocalFileService | None = None,
        python_service: LocalPythonService | None = None,
        mcp_service: LocalMCPService | None = None,
        audit: LocalAuditLog | None = None,
        consent_prompt: ConsentPrompt | None = None,
        on_session_id: Any | None = None,
        on_server_public_key: Any | None = None,
        task_guard: TaskGuard | None = None,
        restrict_capabilities: bool = False,
    ) -> None:
        self.server_url = server_url
        self.device_id = device_id
        self.session_id = session_id
        self.on_session_id = on_session_id
        self.on_server_public_key = on_server_public_key
        self.session_token = session_token
        self.private_key = private_key
        self.protocol_version = protocol_version
        self.runtime_version = runtime_version
        self.task_guard = task_guard or TaskGuard()
        self.restrict_capabilities = restrict_capabilities
        if capabilities is None:
            default_capabilities = ["echo"]
            if file_service is not None:
                default_capabilities.extend(
                    ("local.files.list", "local.files.read", "local.files.write")
                )
            if python_service is not None:
                default_capabilities.append("local.python")
            capabilities = tuple(default_capabilities)
        self.capabilities = capabilities
        self.policy_hash = policy_hash
        self.server_public_key = server_public_key
        # First-connection trust (TOFU) is a deliberate configuration choice,
        # never a default: pairing distributes the broker key, and a client
        # without a bound key refuses to connect unless this fallback is on.
        self.allow_unpinned_broker_key = allow_unpinned_broker_key
        self.policy = policy or LocalPolicy()
        self.file_service = file_service
        self.python_service = python_service
        self.mcp_service = mcp_service
        if self.mcp_service is not None:
            self.mcp_service.on_capabilities_changed = self._on_mcp_capabilities_changed
        self.connection: ClientConnection | None = None
        self.audit = audit or LocalAuditLog()
        self.consent_prompt = consent_prompt
        self.paused = False
        self.connected = False
        self._last_sent_capabilities: tuple[str, ...] | None = None
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._cancelled_tasks: set[str] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        # The consent state machine is its own object; the session hands itself
        # in as the wire and the coordinator owns the pending tables, the
        # prompt wait, the answers and the audit rows that prove what happened
        # to each request.
        self.consent_coord = LocalConsentCoordinator(self, consent_prompt)

    # --- user controls ---------------------------------------------------

    def pause(self, *, actor_id: str = "local-user") -> None:
        """Stop accepting new tasks; in-flight work and prompts complete."""
        if self.paused:
            return
        self.paused = True
        self._record(
            AuditKind.CONTROL,
            "paused",
            actor_id=actor_id,
            detail={"accepting_tasks": False},
        )

    def resume(self, *, actor_id: str = "local-user") -> None:
        if not self.paused:
            return
        self.paused = False
        self._record(
            AuditKind.CONTROL,
            "resumed",
            actor_id=actor_id,
            detail={"accepting_tasks": True},
        )

    async def close(self, *, actor_id: str = "local-user") -> None:
        """Drop the outbound session, failing open prompts closed."""
        self._record(
            AuditKind.CONNECTION,
            "disconnecting",
            actor_id=actor_id,
            detail={"device_id": self.device_id},
        )
        await self._end_connection(
            actor_id=actor_id, reason="the local runtime disconnected"
        )

    async def _end_connection(self, *, actor_id: str, reason: str) -> None:
        """Drop the socket and cancel anything still running on the old session.

        A session that has ended cannot answer a consent prompt or deliver a
        task result, so an in-flight task is stopped here rather than left to
        finish its local side effect with nowhere to report it. This is the
        teardown both an explicit :meth:`close` and a dropped connection use —
        a retry has to start from no connection at all, or it would write its
        next hello into a dead socket.
        """
        self._abandon_pending_consents(reason=reason)
        tasks = tuple(self._running_tasks.values())
        for task in tasks:
            task.cancel()
        # Nothing is awaited between reading the socket and clearing it, so a
        # session that has ended can never leave a connection object behind for
        # a retry to mistake as live.
        connection = self.connection
        self.connected = False
        self.connection = None
        try:
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            if connection is not None:
                await connection.close()

    async def shutdown(self, *, actor_id: str = "local-user") -> None:
        """Stop the runtime: cancel in-flight tasks, then close the session."""
        for task in tuple(self._running_tasks.values()):
            task.cancel()
        await self.close(actor_id=actor_id)

    def _abandon_pending_consents(self, *, reason: str) -> None:
        """Fail open on-device prompts closed; nothing waits on a dead session."""
        self.consent_coord._abandon_pending_consents(reason=reason)

    def _record(
        self,
        kind: AuditKind,
        action: str,
        *,
        capability: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        digest: str | None = None,
        actor_id: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> AuditEntry:
        return self.audit.record(
            kind,
            action,
            capability=capability,
            task_id=task_id,
            run_id=run_id,
            digest=digest,
            actor_id=actor_id,
            detail=detail,
        )

    async def connect(self) -> ClientConnection:
        """Open the device-initiated connection; the server is never dialed back."""
        connection = await connect(self.server_url)
        self.connection = connection
        return connection

    def current_capabilities(self) -> tuple[str, ...]:
        """The capability set this device would announce right now."""
        return self._current_capabilities()

    def current_tool_descriptors(self) -> dict[str, dict[str, Any]]:
        """Return MCP schemas alongside the legacy capability name list."""
        if self.mcp_service is None:
            return {}
        descriptors: dict[str, dict[str, Any]] = {}
        supervisor = self.mcp_service.supervisor
        for server in supervisor.server_names():
            for tool in supervisor.tools(server):
                name = f"local.mcp.{server}.{tool.name}"
                schema = tool.input_schema or {"type": "object"}
                descriptors[name] = {
                    "description": tool.description,
                    "input_schema": schema,
                    "schema_hash": hashlib.sha256(
                        json.dumps(
                            schema,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ).encode("utf-8")
                    ).hexdigest(),
                }
        return descriptors

    def busy(self) -> bool:
        """Whether a task or consent round trip is still in flight."""
        return bool(self._running_tasks) or bool(self.consent_coord._local_consents)

    # --- backward-compat aliases for tests that reach into the consent tables ---
    #
    # The consent tables live on the coordinator now; these properties keep
    # the old attribute names reachable so existing tests and one-off callers
    # (tray.py, the fake broker helpers) don't have to be updated in one shot.

    @property
    def _relayed_consents(self):
        return self.consent_coord._relayed_consents

    @property
    def _local_consents(self):
        return self.consent_coord._local_consents

    @property
    def _answered_consents(self):
        return self.consent_coord._answered_consents

    def _current_capabilities(self) -> tuple[str, ...]:
        """Static capabilities plus the live ``local.mcp.*`` projection."""
        if self.mcp_service is None:
            return tuple(self.capabilities)
        merged = list(self.capabilities)
        merged.extend(
            name
            for name in self.mcp_service.supervisor.capabilities()
            if name not in merged
        )
        return tuple(merged)

    async def send_hello(self) -> None:
        if self.connection is None:
            raise RuntimeError("connect() must be called before send_hello()")
        self.session_id = self.session_id or new_session_id()
        if self.on_session_id is not None:
            self.on_session_id(self.session_id)
        self._last_sent_capabilities = self._current_capabilities()
        hello = sign_envelope(
            private_key=self.private_key,
            message_type=MessageType.HELLO,
            device_id=self.device_id,
            session_id=self.session_id,
            payload={
                "session_token": self.session_token,
                "public_key": public_key_text(self.private_key),
                "protocol_version": self.protocol_version,
                "runtime_version": self.runtime_version,
                "capabilities": list(self._current_capabilities()),
                "policy_hash": self.policy_hash,
                "tool_descriptors": self.current_tool_descriptors(),
            },
        )
        # Record the outbound session before the broker can observe HELLO.
        # The tray may inspect its audit log as soon as the broker acknowledges
        # the frame; recording here closes that otherwise visible scheduling
        # race. Verification failures are still recorded separately by the
        # supervisor and the connection is never exposed as usable until the
        # receive loop starts.
        self._record(
            AuditKind.CONNECTION,
            "connected",
            detail={"server_url": self.server_url, "device_id": self.device_id},
        )
        await self.connection.send(
            json.dumps(hello, ensure_ascii=False, separators=(",", ":"))
        )

    async def send_capability_update(self) -> None:
        """Publish the current device capability set to the server registry."""
        if self.connection is None or self.session_id is None:
            raise RuntimeError("connect and send_hello must be called first")
        self._last_sent_capabilities = self._current_capabilities()
        message = sign_envelope(
            private_key=self.private_key,
            message_type=MessageType.CAPABILITY_UPDATE,
            device_id=self.device_id,
            session_id=self.session_id,
            payload={
                "capabilities": list(self._current_capabilities()),
                "policy_hash": self.policy_hash,
                "tool_descriptors": self.current_tool_descriptors(),
            },
        )
        await self.connection.send(
            json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        )

    async def _on_mcp_capabilities_changed(self) -> None:
        """Republish capabilities when a server reports a tool-set change."""
        if self.connection is None or self.session_id is None:
            return
        current = self._current_capabilities()
        if current != self._last_sent_capabilities:
            await self.send_capability_update()

    async def refresh_mcp_capabilities(self) -> None:
        """Re-enumerate tools from enabled servers; republish when the set changed."""
        if self.mcp_service is None:
            return
        await self.mcp_service.supervisor.refresh_all()
        await self._on_mcp_capabilities_changed()

    async def run(self) -> None:
        """Receive signed tasks and return ACK/progress/result envelopes."""
        self._loop = asyncio.get_running_loop()
        if self.connection is None:
            await self.connect()
        await self.send_hello()
        await self.send_capability_update()
        assert self.connection is not None
        expiry_task = asyncio.create_task(self._expire_consents_periodically())
        try:
            server_hello = json.loads(await self.connection.recv())
            pinned_before_hello = bool(self.server_public_key)
            offered_key = str(
                server_hello.get("payload", {}).get("server_public_key", "")
            )
            if pinned_before_hello:
                # The key captured at pairing (or pinned by an earlier
                # explicitly-configured first connection) is the only trusted
                # broker identity; the HELLO copy is advisory and never
                # replaces it, so a swapped-in key fails verification below.
                configured_key = self.server_public_key or ""
            elif self.allow_unpinned_broker_key:
                # Explicit opt-in fallback: trust and pin the first observed
                # key, exactly the behaviour the default now refuses.
                configured_key = offered_key
            else:
                # Same bare-code style as the protocol verification failures:
                # the supervisor audits it and retries until pairing binds a
                # key to the live client.
                raise ProtocolError("BROKER_KEY_UNPINNED")
            verify_envelope(
                server_hello,
                server_public_key=configured_key,
                expected_device_id=self.device_id,
                expected_session_id=self.session_id or "",
            )
            self.server_public_key = configured_key
            self.connected = True
            if not pinned_before_hello and self.on_server_public_key is not None:
                # Only a first bind is announced: a pinned key is persisted by
                # pairing itself and would only rewrite the same value.
                self.on_server_public_key(configured_key)
            await self._receive_loop()
        except ConnectionClosed as exc:
            if exc.code in {4001, 4003}:
                raise RePairRequired(
                    f"the server rejected this device session (close code {exc.code})"
                ) from exc
            raise
        finally:
            expiry_task.cancel()
            await asyncio.gather(expiry_task, return_exceptions=True)
            # Reached on every exit: a clean close, an aborted socket and a
            # verification failure all end here. Without this the next run()
            # finds self.connection still set and "sends" hello to a socket
            # that is already gone, so the device never redials.
            if self.connection is not None:
                await self._end_connection(
                    actor_id="local-runtime",
                    reason="the session with the server ended",
                )

    async def _receive_loop(self) -> None:
        """Verify and dispatch frames until the session ends."""
        assert self.connection is not None
        async for raw in self.connection:
            message = {}
            try:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ProtocolError("MESSAGE_INVALID")
                envelope = verify_envelope(
                    message,
                    server_public_key=self.server_public_key,
                    expected_device_id=self.device_id,
                    expected_session_id=self.session_id or "",
                )
            except (ProtocolError, json.JSONDecodeError) as exc:
                code = str(exc) if isinstance(exc, ProtocolError) else "MESSAGE_INVALID"
                task_id = str(message.get("task_id", ""))[:256] if isinstance(message, dict) else ""
                self._record(AuditKind.TASK, "rejected", task_id=task_id, detail={"error_code": code})
                await self._send_error(task_id, code, code, {}, "", policy_decision="deny", status="denied")
                continue
            if envelope.type == MessageType.TASK:
                task_id = envelope.task_id or ""
                if not task_id or len(task_id) > 256:
                    await self._send_error(task_id[:256], "invalid task identity", "INVALID_TASK", {}, "")
                    continue
                if not self.task_guard.claim(self.device_id, task_id):
                    self._record(AuditKind.TASK, "rejected", task_id=task_id,
                                 run_id=str(envelope.payload.get("run_id", "")), detail={"error_code": "TASK_REPLAYED"})
                    await self._send_error(task_id, "task already admitted", "TASK_REPLAYED", envelope.payload, str(envelope.payload.get("operation", "")), status="denied")
                    continue
                task = asyncio.create_task(self._handle_task(envelope))
                self._running_tasks[task_id] = task
                task.add_done_callback(
                    lambda finished, current_task_id=task_id: self._task_finished(
                        current_task_id, finished
                    )
                )
            elif envelope.type == MessageType.CONSENT_DECISION:
                await self._handle_consent_decision(envelope, background=True)
            elif envelope.type == MessageType.TASK_CANCEL:
                await self._handle_task_cancel(envelope.task_id or "")

    def _task_finished(self, task_id: str, task: asyncio.Task[None]) -> None:
        self._running_tasks.pop(task_id, None)
        # The cancel marker is only meaningful while the task can still run;
        # a finished task must not leave an entry behind (05-M9).
        self._cancelled_tasks.discard(task_id)
        if not task.cancelled():
            task.exception()

    async def _handle_task_cancel(self, task_id: str) -> None:
        relayed = self.consent_coord._relayed_consents.pop(task_id, None)
        request = relayed.request if relayed is not None else None
        if request is not None:
            self._cancelled_tasks.add(task_id)
            await self._send_error(
                task_id,
                "local task cancelled while waiting for consent",
                "CANCELLED",
                request.payload,
                request.capability,
                policy_decision=PolicyDecision.DENY.value,
                status="cancelled",
            )
        task = self._running_tasks.get(task_id)
        if task is not None:
            task.cancel()

    async def _handle_task(self, envelope) -> None:
        assert self.connection is not None
        task_id = envelope.task_id or ""
        operation = str(envelope.payload.get("operation", ""))
        if self.restrict_capabilities and operation not in self._current_capabilities():
            await self._send_error(task_id, "capability unavailable", "CAPABILITY_UNAVAILABLE",
                                   dict(envelope.payload), operation,
                                   policy_decision=PolicyDecision.DENY.value, status="denied")
            return
        if self.paused:
            # Pause never drops a task silently: the caller gets a structured
            # denial carrying a receipt, which the broker records as DENIED.
            await self._send_error(
                task_id,
                "local runtime is paused; no new tasks are accepted",
                "DEVICE_PAUSED",
                dict(envelope.payload),
                operation,
                policy_decision=PolicyDecision.DENY.value,
                status="denied",
            )
            return
        await self.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=self.private_key,
                    message_type=MessageType.TASK_ACK,
                    device_id=self.device_id,
                    session_id=self.session_id or "",
                    task_id=task_id,
                    payload={"accepted": True},
                ),
                separators=(",", ":"),
            )
        )
        self._record(
            AuditKind.TASK,
            "accepted",
            capability=operation,
            task_id=task_id,
            run_id=str(envelope.payload.get("run_id", "")),
        )
        try:
            if operation == "echo":
                # Echo is its own contract: whatever the broker signed is
                # reflected back verbatim as the result, with the same
                # policy authorization every other operation goes through;
                # there is no extra capability semantics to apply (05-L13).
                result = envelope.payload.get("value")
                receipt = await self.handle_echo_task(envelope)
                if receipt.policy_decision != PolicyDecision.ALLOW.value:
                    await self._denial_response(operation, task_id, envelope.payload, PolicyDecision(receipt.policy_decision))
                    return
            elif operation in {"local.files.list", "local.files.read", "local.files.search"}:
                if not self.server_public_key:
                    # No broker key is bound: pairing never completed and no
                    # explicitly-configured fallback pinned one. LEVEL_0 file
                    # capabilities hand local file contents to whoever holds
                    # the session, so they stay shut rather than trust the
                    # connection that asked.
                    await self._denial_response(
                        operation, task_id, envelope.payload, PolicyDecision.DENY
                    )
                    return
                file_task = self.handle_file_task(operation, dict(envelope.payload))
                if file_task.decision is not PolicyDecision.ALLOW:
                    await self._send_error(
                        task_id,
                        file_task.decision.value,
                        "POLICY_DENIED",
                        envelope.payload,
                        operation,
                    )
                    return
                result = file_task.value
                receipt = self._file_receipt(envelope, operation, result)
            elif operation == "local.files.write":
                file_task = self.handle_file_task(operation, dict(envelope.payload))
                if file_task.decision is PolicyDecision.CONSENT_REQUIRED:
                    assert self.file_service is not None
                    await self.consent_coord._request_consent(
                        envelope,
                        dict(envelope.payload),
                        self.file_service.consent,
                    )
                    return
                if file_task.decision is not PolicyDecision.ALLOW:
                    await self._denial_response(
                        operation, task_id, envelope.payload, file_task.decision
                    )
                    return
                result = file_task.value
                receipt = self._file_receipt(
                    envelope, operation, result, consent_decision="always_allow"
                )
            elif operation == "local.python":
                if self.python_service is None:
                    raise RuntimeError(
                        "python_service is required for local Python tasks"
                    )
                python_result = await self.python_service.execute(
                    dict(envelope.payload),
                    on_output=lambda stream, output: self._send_python_output(
                        task_id, stream, output
                    ),
                )
                if python_result is PolicyDecision.CONSENT_REQUIRED:
                    await self.consent_coord._request_consent(
                        envelope,
                        dict(envelope.payload),
                        self.python_service.consent,
                    )
                    return
                if python_result is not PolicyDecision.ALLOW and not isinstance(
                    python_result, PythonResult
                ):
                    await self._denial_response(
                        operation, task_id, envelope.payload, python_result
                    )
                    return
                assert isinstance(python_result, PythonResult)
                result = self._python_result_value(python_result)
                receipt = python_result.receipt
                if receipt is None:
                    raise RuntimeError(
                        "local Python execution did not produce a receipt"
                    )
                receipt = replace(receipt, task_id=task_id)
            elif operation.startswith("local.mcp."):
                if self.mcp_service is None:
                    raise RuntimeError("mcp_service is required for local MCP tasks")
                execution = await self.mcp_service.execute(
                    operation, dict(envelope.payload)
                )
                if execution is PolicyDecision.CONSENT_REQUIRED:
                    await self.consent_coord._request_consent(
                        envelope,
                        dict(envelope.payload),
                        self.mcp_service.consent,
                    )
                    return
                if not isinstance(execution, MCPExecution):
                    await self._denial_response(
                        operation, task_id, envelope.payload, execution
                    )
                    return
                result = execution.value
                receipt = replace(execution.receipt, task_id=task_id)
            else:
                raise ValueError("unsupported operation")
        except asyncio.CancelledError:
            self._record(
                AuditKind.TASK,
                "cancelled",
                capability=operation,
                task_id=task_id,
                run_id=str(envelope.payload.get("run_id", "")),
            )
            await self._send_error(
                task_id,
                "local task cancelled",
                "CANCELLED",
                envelope.payload,
                operation,
                policy_decision=PolicyDecision.ALLOW.value,
                status="cancelled",
            )
            raise
        except FileAccessError as exc:
            await self._send_error(
                task_id, str(exc), exc.code, envelope.payload, operation
            )
            return
        except SecretStoreError as exc:
            # A secret reference or its backend failed: the task fails with a
            # stable code; there is no plaintext fallback path.
            await self._send_error(
                task_id, str(exc), exc.code, envelope.payload, operation
            )
            return
        except (RuntimeError, ValueError, TypeError, KeyError) as exc:
            await self._send_error(
                task_id, str(exc), "INVALID_TASK", envelope.payload, operation
            )
            return
        await self.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=self.private_key,
                    message_type=MessageType.TASK_PROGRESS,
                    device_id=self.device_id,
                    session_id=self.session_id or "",
                    task_id=task_id,
                    payload={"fraction": 1.0},
                ),
                separators=(",", ":"),
            )
        )
        self._record_execution(receipt)
        await self.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=self.private_key,
                    message_type=MessageType.TASK_RESULT,
                    device_id=self.device_id,
                    session_id=self.session_id or "",
                    task_id=task_id,
                    payload={"result": result, "receipt": receipt.as_dict()},
                ),
                separators=(",", ":"),
            )
        )

    def _record_policy_denial(
        self, capability: str, task_id: str, payload: dict[str, Any]
    ) -> None:
        """Record a device-side veto, which no receipt would otherwise show."""
        self._record(
            AuditKind.POLICY,
            "denied",
            capability=capability,
            task_id=task_id,
            run_id=str(payload.get("run_id", "")),
            detail={
                "risk_level": self.policy.risk_level(capability, dict(payload)).value
            },
        )

    async def _denial_response(
        self,
        capability: str,
        task_id: str,
        payload: dict[str, Any],
        decision: PolicyDecision,
    ) -> None:
        """Record the local audit row and emit the wire error frame in one call.

        A policy denial is a single event with two observable halves: the
        structured error frame the server learns from, and the audit row the
        user sees. Owning both here means no caller can record without
        sending or vice versa.
        """
        self._record_policy_denial(capability, task_id, payload)
        await self._send_error(
            task_id,
            decision.value,
            "LOCAL_POLICY_DENIED",
            payload,
            capability,
            policy_decision=decision.value,
            status="denied",
        )

    def _record_execution(self, receipt: LocalExecutionReceipt) -> None:
        """One audit row per finished local execution, keyed by its receipt.

        Callers record before sending the result: the local log must never lag
        a frame the network already delivered, or a user opening their history
        right after an outcome appears sees nothing.
        """
        kind = (
            AuditKind.MCP
            if receipt.capability.startswith("local.mcp.")
            else AuditKind.EXECUTION
        )
        self._record(
            kind,
            receipt.status,
            capability=receipt.capability,
            task_id=receipt.task_id,
            run_id=receipt.run_id,
            digest=receipt.payload_hash,
            detail={
                "result_hash": receipt.result_hash,
                "consent_decision": receipt.consent_decision,
                "policy_decision": receipt.policy_decision,
            },
        )

    def _file_receipt(
        self,
        envelope: Any,
        capability: str,
        result: Any,
        *,
        consent_decision: str | None = None,
        payload: dict[str, Any] | None = None,
        task_id: str | None = None,
    ) -> LocalExecutionReceipt:
        payload = dict(envelope.payload if payload is None else payload)
        return LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id=task_id or envelope.task_id or "",
            capability=capability,
            policy_decision=PolicyDecision.ALLOW.value,
            status="completed",
            payload_hash=content_hash(payload),
            result_hash=content_hash(result),
            consent_decision=consent_decision,
        )

    @staticmethod
    def _python_result_value(result: PythonResult) -> dict[str, Any]:
        return {
            "status": result.status.value,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "artifact_refs": list(result.artifact_refs),
            "artifact_error": result.artifact_error,
        }

    def _consent_service_store(self, capability: str) -> ConsentStore:
        """The ConsentStore that grades one capability; the coordinator needs it to settle."""
        if capability.startswith("local.mcp."):
            service: Any = self.mcp_service
        elif capability == "local.python":
            service = self.python_service
        else:
            service = self.file_service
        if service is None:
            raise RuntimeError("required local service is unavailable")
        return service.consent

    # --- consent: delegated to LocalConsentCoordinator --------------------

    def pending_consents(self) -> tuple[PendingConsent, ...]:
        """Every request awaiting a decision, newest first."""
        return self.consent_coord.pending_consents()

    def resolve_local_consent(
        self,
        task_id: str,
        *,
        approved: bool,
        actor_id: str = "local-user",
        always: bool = False,
    ) -> None:
        """Answer a pending on-device request from the UI thread."""
        self.consent_coord.resolve_local_consent(
            task_id, approved=approved, actor_id=actor_id, always=always
        )

    async def expire_consents(self, *, now: float | None = None) -> tuple[str, ...]:
        """Auto-deny prompts nobody answered, so nothing hangs indefinitely."""
        return await self.consent_coord.expire_consents(now=now)

    async def _expire_consents_periodically(self) -> None:
        """Drive consent expiry while the session is live (05-M9).

        Without a production caller, prompts the server never answered stayed
        in ``_relayed_consents`` (and in pending_consents()) forever.
        """
        while True:
            await asyncio.sleep(max(CONSENT_TIMEOUT_SECONDS / 4, 1.0))
            await self.consent_coord.expire_consents()

    async def _request_consent(
        self, envelope: Any, payload: dict[str, Any], store: ConsentStore
    ) -> None:
        """Ask about one task: locally when a tray is attached, else upstream."""
        await self.consent_coord._request_consent(envelope, payload, store)

    async def _handle_consent_decision(
        self, envelope: Any, *, background: bool = False
    ) -> None:
        """Route a server decision into the consent state machine."""
        await self.consent_coord._handle_consent_decision(
            envelope, background=background
        )

    async def _deny_unanswered(
        self, envelope: Any, request: ConsentRequest, *, reason: str | None = None
    ) -> None:
        await self.consent_coord._deny_unanswered(envelope, request, reason=reason)

    async def _settle_consent(
        self,
        envelope: Any,
        request: ConsentRequest,
        store: ConsentStore,
        *,
        approved: bool,
        actor_id: str,
        always: bool = False,
        origin: str,
    ) -> None:
        await self.consent_coord._settle_consent(
            envelope,
            request,
            store,
            approved=approved,
            actor_id=actor_id,
            always=always,
            origin=origin,
        )

    async def _send_error(
        self,
        task_id: str,
        message: str,
        code: str,
        payload: dict[str, Any],
        capability: str,
        *,
        policy_decision: str = "allow",
        status: str = "failed",
        consent_decision: str | None = None,
    ) -> None:
        await self.consent_coord._send_error(
            task_id,
            message,
            code,
            payload,
            capability,
            policy_decision=policy_decision,
            status=status,
            consent_decision=consent_decision,
        )

    async def _send_python_output(self, task_id: str, stream: str, output: str) -> None:
        await self.consent_coord._send_python_output(task_id, stream, output)

    async def _execute_consented(self, envelope: Any, request: ConsentRequest) -> None:
        await self.consent_coord._execute_consented(envelope, request)

    async def handle_echo_task(self, envelope: Any) -> LocalExecutionReceipt:
        """Apply Local Policy and return a receipt without executing system commands."""
        task_id = envelope.task_id or ""
        payload = dict(envelope.payload)
        decision = self.policy.authorize("echo", payload)
        status = "completed" if decision == PolicyDecision.ALLOW else decision.value
        result_hash = (
            content_hash(payload) if decision == PolicyDecision.ALLOW else None
        )
        return LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id=task_id,
            capability="echo",
            policy_decision=decision.value,
            status=status,
            payload_hash=content_hash(payload),
            result_hash=result_hash,
        )

    def handle_file_task(
        self, capability: str, payload: dict[str, Any], *, consent: bool = False
    ) -> FileTaskResult:
        """Execute a list/read task through the configured logical-root store."""
        if capability not in {
            "local.files.list",
            "local.files.read",
            "local.files.search",
            "local.files.write",
        }:
            raise ValueError("unsupported local file capability")
        if self.file_service is None:
            raise RuntimeError("file_service is required for local file tasks")
        return self.file_service.execute(capability, payload, consent=consent)


# --- backward-compat re-exports -----------------------------------------
#
# These used to be defined in transport.py; they now live in consent_coord.py.
# Re-export them so existing imports like `from core.transport import
# ConsentDecisionError` keep working (tray.py, tests, and the CLI all use
# the transport module as the public entry point).

from .consent_coord import (  # noqa: E402, F401
    CONSENT_TIMEOUT_SECONDS,
    ConsentDecisionError,
    ConsentUnavailableError,
)

