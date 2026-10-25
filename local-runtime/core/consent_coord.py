"""The consent state machine, split out of the wire session.

``LocalConsentCoordinator`` owns every on-device and relayed consent request —
the pending tables, the prompt wait, the answers and the audit rows that prove
what happened to each. The session (``LocalRuntimeClient``) keeps the wire: it
sends frames, tracks running tasks and owns teardown. The two talk through a
small protocol rather than a hard import, so the coordinator stays testable
without a socket.
"""

from __future__ import annotations

import asyncio
import copy
import json
import time
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Optional

if TYPE_CHECKING:
    from .audit import LocalAuditLog
    from .file_service import LocalFileService
    from .mcp import LocalMCPService
    from .python import LocalPythonService

from .audit import AuditKind
from .consent import ConsentExchange, ConsentRequest, ConsentStore, PendingConsent, render_consent_summary
from .mcp import MCPExecution
from .policy import LocalPolicy, PolicyDecision, RiskLevel
from .protocol import MessageType, sign_envelope
from .receipts import content_hash
from .consent import request_hash
from .files import FileAccessError


class ConsentDecisionError(RuntimeError):
    """The request is unknown, already answered, or not answerable here."""


class ConsentUnavailableError(RuntimeError):
    """A decision was asked for while the local runtime is not running."""


#: Seconds an unanswered on-device prompt waits before it auto-denies itself.
CONSENT_TIMEOUT_SECONDS = 300.0

#: Asks the local user about one pending request and resolves to their answer
#: (``{"approved": bool, "actor_id": str, "always": bool}``) or ``None`` when
#: nobody can answer it. Implemented by the tray; the transport never renders.
# A runtime type alias: ``dict[...]``/``X | None`` spellings evaluate here on
# every import, so it keeps the typing-module forms the 3.8 line supports.
ConsentPrompt = Callable[[PendingConsent], Awaitable[Optional[Dict[str, Any]]]]


@dataclass
class _LocalConsent:
    """A consent request this device will answer itself, on the tray."""

    request: ConsentRequest
    future: asyncio.Future[Any]
    loop: asyncio.AbstractEventLoop
    requested_at: float
    task_id: str
    deadline: float = float('inf')
    #: The prompt coroutine; cancelled when the request stops being answerable.
    prompt: asyncio.Future[Any] | None = None
    #: Why nobody answered (disconnect, timeout); recorded in the audit as-is.
    abandoned_reason: str | None = None


@dataclass
class _RelayedConsent:
    """A consent request forwarded to the server, pending a browser decision."""

    request: ConsentRequest
    requested_at: float


class _ConsentWire:
    """What the consent state machine needs from the session.

    A plain marker documenting the duck-typed surface: ``LocalRuntimeClient``
    satisfies it structurally — no inheritance, no registration. Kept as a
    class so the parameter annotation reads honestly without importing the
    session module at runtime.
    """

    connection: Any
    private_key: Any
    device_id: str
    session_id: str | None
    audit: LocalAuditLog
    policy: LocalPolicy
    file_service: LocalFileService | None
    python_service: LocalPythonService | None
    mcp_service: LocalMCPService | None
    consent_prompt: ConsentPrompt | None
    _running_tasks: dict[str, asyncio.Task[None]]
    _task_runs: dict[str, str]
    _cancelled_tasks: set[str]
    _task_finished: Callable[[str, asyncio.Task[None]], None]

    def _consent_service_store(self, capability: str) -> ConsentStore: ...

    def _record_policy_denial(
        self, capability: str, task_id: str, payload: dict[str, Any]
    ) -> None: ...

    def _file_receipt(
        self,
        envelope: Any,
        capability: str,
        result: Any,
        *,
        consent_decision: str | None = None,
        payload: dict[str, Any] | None = None,
        task_id: str | None = None,
    ) -> Any: ...

    def _python_result_value(self, result: Any) -> dict[str, Any]: ...

    def _record_execution(self, receipt: Any) -> None: ...

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
    ) -> None: ...

    async def _send_python_output(self, task_id: str, stream: str, output: str) -> None: ...


class LocalConsentCoordinator:
    """Owns the consent round trip: request, prompt, answer, audit.

    Constructed by the session, which passes itself in as the wire; every
    method that needs a socket, the audit log or the running-task registry
    reaches for it there. Nothing here knows how to connect.
    """

    def __init__(self, wire: _ConsentWire, consent_prompt: ConsentPrompt | None) -> None:
        self._wire = wire
        self.consent_prompt = consent_prompt
        self._local_consents: dict[str, _LocalConsent] = {}
        self._relayed_consents: dict[str, _RelayedConsent] = {}
        self._answered_consents: set[str] = set()

    # --- state -------------------------------------------------------------

    def _pending_view(self, task_id: str, request: ConsentRequest) -> PendingConsent:
        """The renderable form of a request, shared by the tray and the server."""
        level = self._wire.policy.risk_level(request.capability, request.payload)

        return PendingConsent(
            task_id=task_id,
            capability=request.capability,
            payload=copy.deepcopy(request.payload),
            request_hash=request.request_hash,
            risk_level=level.value,
            # Level 2 is displayed but never silenceable (§9: dangerous work
            # has no "always allow" escape hatch).
            silenceable=level is not RiskLevel.LEVEL_2 and not self._desktop_write(request.capability),
            summary=self._summary(request),
            requested_at=time.monotonic(),
        )

    def _desktop_write(self, capability):
        from .file_service import WorkspaceFileService
        return capability == 'local.files.write' and isinstance(self._wire.file_service, WorkspaceFileService)

    def _summary(self, request: ConsentRequest) -> dict[str, str]:
        summary = render_consent_summary(
            request.capability, request.payload, request_hash=request.request_hash
        )
        if self._desktop_write(request.capability):
            try:
                _, workspace = self._wire.file_service.selection.current()
                summary['directory'] = workspace['physical_root']
            except (FileAccessError, OSError):
                pass
        return summary

    def _audit(
        self,
        kind: Any,
        action: str,
        *,
        capability: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        digest: str | None = None,
        actor_id: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> Any:
        return self._wire.audit.record(
            kind,
            action,
            capability=capability,
            task_id=task_id,
            run_id=run_id,
            digest=digest,
            actor_id=actor_id,
            detail=detail,
        )

    def pending_consents(self) -> tuple[PendingConsent, ...]:
        """Every request awaiting a decision, newest first."""
        entries = [
            self._pending_view(task_id, consent.request)
            for task_id, consent in self._local_consents.items()
        ]
        entries.extend(
            self._pending_view(task_id, consent.request)
            for task_id, consent in self._relayed_consents.items()
        )
        entries.sort(key=lambda item: item.requested_at, reverse=True)
        return tuple(entries)

    async def _request_consent(
        self,
        envelope: Any,
        payload: dict[str, Any],
        store: ConsentStore,
    ) -> None:
        """Ask about one task: locally when a tray is attached, else upstream.

        Both routes bind the same ``request_hash`` and settle through
        :meth:`_settle_consent`, so a tray decision and a browser decision
        authorize exactly the same bytes.
        """

        task_id = envelope.task_id or ""
        request = ConsentExchange(store).create_request(
            str(payload.get("operation", "")), payload
        )
        self._audit(
            AuditKind.CONSENT,
            "required",
            capability=request.capability,
            task_id=task_id,
            run_id=str(payload.get("run_id", "")),
            digest=request.request_hash,
            detail={
                "origin": "tray" if self.consent_prompt is not None else "server",
                "summary": render_consent_summary(request.capability, payload),
            },
        )
        if self._desktop_write(request.capability) and self.consent_prompt is None:
            await self._deny_unanswered(envelope, request)
            return
        if self.consent_prompt is None:
            self._relayed_consents[task_id] = _RelayedConsent(
                request, time.monotonic()
            )
            await self._send_consent_required(envelope, request)
            return
        loop = asyncio.get_running_loop()
        deadline = time.monotonic() + CONSENT_TIMEOUT_SECONDS
        if getattr(envelope, 'expires_at', None) is not None:
            from datetime import datetime
            deadline = min(deadline, time.monotonic() + (envelope.expires_at - datetime.now(envelope.expires_at.tzinfo)).total_seconds())
        consent = _LocalConsent(
            request=request,
            future=loop.create_future(),
            loop=loop,
            requested_at=time.monotonic(),
            task_id=task_id,
            deadline=deadline,
        )
        self._local_consents[task_id] = consent
        if self._desktop_write(request.capability):
            await self._send_consent_required(envelope, request)
        try:
            answer = await self._await_local_consent(consent)
        finally:
            consent.prompt = None
            self._local_consents.pop(task_id, None)
        if answer is None or time.monotonic() >= consent.deadline:
            await self._deny_unanswered(
                envelope, request, reason=consent.abandoned_reason
            )
            return
        await self._settle_consent(
            envelope,
            request,
            store,
            approved=bool(answer.get("approved")),
            actor_id=str(answer.get("actor_id", "local-user")),
            always=bool(answer.get("always")),
            directory=answer.get("directory") is True,
            origin="tray",
        )

    async def _await_local_consent(
        self, consent: _LocalConsent
    ) -> dict[str, Any] | None:
        """Wait for the user, whichever way the answer arrives.

        Two channels can end the wait: the prompt surface returns an answer (a
        CLI, or a tray that decides for itself), or the UI thread calls
        :meth:`resolve_local_consent` and settles ``consent.future``. If the
        request stops being answerable — the task is cancelled, the session
        closes, the timeout expires — the caller abandons it, which cancels the
        prompt so no surface is left showing a dead request.
        """
        assert self.consent_prompt is not None
        pending = self._pending_view(consent.task_id, consent.request)
        prompt = asyncio.ensure_future(self.consent_prompt(pending))
        consent.prompt = prompt
        try:
            done, _ = await asyncio.wait(
                {prompt, consent.future},
                timeout=max(0, consent.deadline - time.monotonic()),
                return_when=asyncio.FIRST_COMPLETED,
            )
        except asyncio.CancelledError:
            prompt.cancel()
            raise
        if not done:
            self._abandon_local_consent(
                consent.task_id, reason="the consent request timed out"
            )
            await self._close_prompt(prompt)
            return None
        if consent.future.done() and not consent.future.cancelled():
            # The user answered, or nobody can anymore; either way the prompt
            # coroutine is no longer wanted.
            await self._close_prompt(prompt)
            return consent.future.result()
        try:
            answer = prompt.result()
        except asyncio.CancelledError:
            answer = None
        except Exception:
            # A broken prompt surface must never imply consent.
            answer = None
        return answer

    @staticmethod
    async def _close_prompt(prompt: asyncio.Future[Any]) -> None:
        """Cancel a prompt nobody is waiting on anymore, and reap its result."""
        prompt.cancel()
        try:
            await prompt
        except (asyncio.CancelledError, Exception):
            pass

    def resolve_local_consent(
        self,
        task_id: str,
        *,
        approved: bool,
        actor_id: str = "local-user",
        always: bool = False,
        expected_hash: str | None = None,
        directory: bool = False,
    ) -> None:
        """Answer a pending on-device request from the UI thread."""
        consent = self._local_consents.get(task_id)
        if consent is None:
            raise ConsentDecisionError("no local consent is pending for this task")
        if (expected_hash is not None and expected_hash != consent.request.request_hash) or request_hash(consent.request.payload) != consent.request.request_hash:
            raise ConsentDecisionError('consent request does not match')
        if time.monotonic() >= consent.deadline:
            raise ConsentDecisionError('consent request expired')
        if consent.future.done():
            raise ConsentDecisionError("this request was already answered")
        answer = {
            "approved": approved,
            "actor_id": actor_id,
            "always": always,
            "directory": directory,
        }

        def settle() -> None:
            if not consent.future.done():
                consent.future.set_result(answer)

        try:
            consent.loop.call_soon_threadsafe(settle)
        except RuntimeError as exc:
            raise ConsentUnavailableError(
                "the local runtime is not running"
            ) from exc

    def _abandon_local_consent(self, task_id: str, *, reason: str) -> None:
        """Answer a prompt with "nobody can answer", never with implied consent."""
        consent = self._local_consents.pop(task_id, None)
        if consent is None:
            return
        consent.abandoned_reason = reason
        if not consent.future.done():
            consent.future.set_result(None)
        if consent.prompt is not None and not consent.prompt.done():
            consent.prompt.cancel()

    def _abandon_pending_consents(self, *, reason: str) -> None:
        """Fail open on-device prompts closed; nothing waits on a dead session."""
        for task_id in tuple(self._local_consents):
            self._abandon_local_consent(task_id, reason=reason)
        self._relayed_consents.clear()

    async def _deny_unanswered(
        self,
        envelope: Any,
        request: ConsentRequest,
        *,
        reason: str | None = None,
    ) -> None:
        """Nobody answered: fail closed and record why nobody did."""

        task_id = envelope.task_id or ""
        self._answered_consents.add(task_id)
        self._audit(
            AuditKind.CONSENT,
            "unanswered",
            capability=request.capability,
            task_id=task_id,
            run_id=str(request.payload.get("run_id", "")),
            digest=request.request_hash,
            detail={
                "origin": "tray",
                "outcome": "denied",
                "reason": reason or "no local answer",
            },
        )
        wire = self._wire
        if wire.connection is None:
            # The session went away with the request: the local audit still
            # records the outcome, and the server learns from the disconnect.
            return
        await wire._send_error(
            task_id,
            "no local consent was given",
            "DENIED",
            request.payload,
            request.capability,
            policy_decision=PolicyDecision.DENY.value,
            status="denied",
            consent_decision="denied",
        )

    async def _settle_consent(
        self,
        envelope: Any,
        request: ConsentRequest,
        store: ConsentStore,
        *,
        approved: bool,
        actor_id: str,
        always: bool = False,
        directory: bool = False,
        origin: str,
    ) -> None:
        """Record the decision, then run or refuse exactly what was shown."""

        wire = self._wire
        task_id = envelope.task_id or ""
        self._answered_consents.add(task_id)
        if request_hash(request.payload) != request.request_hash:
            approved = False
        if self._desktop_write(request.capability):
            always = False
        basis = 'approved'
        if approved and directory and self._desktop_write(request.capability) and origin == 'tray':
            try:
                if wire.receipt_ledger is None or wire.receipt_ledger.error:
                    raise FileAccessError('RECEIPT_STORAGE_UNAVAILABLE')
                grant = wire.file_service.remember_consent(request.payload)
                basis = 'directory:' + grant['id']
            except (FileAccessError, OSError):
                approved = False
        exchange = ConsentExchange(store)
        exchange.decide(request, approved=approved, actor_id=actor_id)
        if approved and always:
            store.set_always_allow(request.capability)
        self._audit(
            AuditKind.CONSENT,
            "always_allowed" if approved and always else "approved" if approved else "denied",
            capability=request.capability,
            task_id=task_id,
            run_id=str(request.payload.get("run_id", "")),
            digest=request.request_hash,
            actor_id=actor_id,
            detail={"origin": origin, "binds_to_payload": True, "basis": basis},
        )
        if not approved or not exchange.authorize(request, request.payload):
            await wire._send_error(
                task_id,
                "local consent denied",
                "DENIED",
                request.payload,
                request.capability,
                policy_decision=PolicyDecision.DENY.value,
                status="denied",
                consent_decision="denied",
            )
            return
        await self._execute_consented(envelope, request, consent_decision=basis)

    async def expire_consents(self, *, now: float | None = None) -> tuple[str, ...]:
        """Auto-deny prompts nobody answered, so nothing hangs indefinitely.

        Covers both routes: local tray prompts (abandoned via their future)
        and relayed browser decisions, whose entries used to sit in
        ``_relayed_consents`` forever when the server went silent on a
        request (05-M9). Each expired relayed request is denied to the
        server, so the task does not just wait out its remote timeout.
        """
        cutoff = (now if now is not None else time.monotonic()) - CONSENT_TIMEOUT_SECONDS
        expired = [
            task_id
            for task_id, consent in self._local_consents.items()
            if consent.requested_at <= cutoff
        ]
        for task_id in expired:
            self._abandon_local_consent(
                task_id, reason="the consent request timed out"
            )
        relayed_expired = [
            task_id
            for task_id, consent in self._relayed_consents.items()
            if consent.requested_at <= cutoff
        ]
        for task_id in relayed_expired:
            relayed = self._relayed_consents.pop(task_id, None)
            if relayed is None:
                continue
            self._audit(
                AuditKind.CONSENT,
                "expired",
                capability=relayed.request.capability,
                task_id=task_id,
                run_id=str(relayed.request.payload.get("run_id", "")),
                digest=relayed.request.request_hash,
                detail={"origin": "server"},
            )
            wire = self._wire
            if wire.connection is not None:
                await wire._send_error(
                    task_id,
                    "the consent request timed out",
                    "DENIED",
                    relayed.request.payload,
                    relayed.request.capability,
                    policy_decision=PolicyDecision.DENY.value,
                    status="denied",
                    consent_decision="denied",
                )
        return tuple(expired + relayed_expired)

    async def _send_consent_required(
        self, envelope: Any, request: ConsentRequest
    ) -> None:

        wire = self._wire
        assert wire.connection is not None
        await wire.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=wire.private_key,
                    message_type=MessageType.CONSENT_REQUIRED,
                    device_id=wire.device_id,
                    session_id=wire.session_id or "",
                    task_id=envelope.task_id,
                    payload={
                        "capability": request.capability,
                        "payload": request.payload,
                        "request_hash": request.request_hash,
                    },
                ),
                separators=(",", ":"),
            )
        )

    async def _handle_consent_decision(
        self, envelope: Any, *, background: bool = False
    ) -> None:

        wire = self._wire
        task_id = envelope.task_id or ""
        if self._desktop_write('local.files.write'):
            self._audit(AuditKind.CONSENT, 'ignored_remote_decision', task_id=task_id, detail={'origin': 'server'})
            return
        if task_id in wire._cancelled_tasks:
            # Consume the marker: the cancel has now been observed, and an
            # entry only ever added to would grow without bound (05-M9).
            wire._cancelled_tasks.discard(task_id)
            return
        relayed = self._relayed_consents.pop(task_id, None)
        request = relayed.request if relayed is not None else None
        if request is None and task_id in self._answered_consents:
            # The tray already decided this one; its outcome is on its way to
            # the server. A late browser decision must not act twice.
            self._audit(
                AuditKind.CONSENT,
                "ignored_duplicate",
                task_id=task_id,
                detail={"origin": "server"},
            )
            return
        if request is None or envelope.payload.get("request_hash") != request.request_hash:
            await wire._send_error(
                task_id,
                "consent request does not match",
                "CONSENT_MISMATCH",
                envelope.payload,
                request.capability if request else "local.files.write",
                policy_decision=PolicyDecision.DENY.value,
                status="denied",
            )
            return
        store = wire._consent_service_store(request.capability)
        approved = bool(envelope.payload.get("approved", False))
        actor_id = str(envelope.payload.get("actor_id", "local-user"))
        if background:
            task = asyncio.create_task(
                self._settle_consent(
                    envelope,
                    request,
                    store,
                    approved=approved,
                    actor_id=actor_id,
                    origin="server",
                )
            )
            wire._running_tasks[task_id] = task
            wire._task_runs[task_id] = str(request.payload.get('run_id', ''))
            task.add_done_callback(
                lambda finished, current_task_id=task_id: wire._task_finished(
                    current_task_id, finished
                )
            )
            await asyncio.sleep(0)
            return
        await self._settle_consent(
            envelope,
            request,
            store,
            approved=approved,
            actor_id=actor_id,
            origin="server",
        )

    async def _execute_consented(self, envelope: Any, request: ConsentRequest, *, consent_decision='approved') -> None:

        wire = self._wire
        try:
            try:
                await self._execute_consented_inner(envelope, request, consent_decision=consent_decision)
            except FileAccessError as exc:
                if exc.code == 'RESULT_UNCERTAIN':
                    if not hasattr(self, '_write_effects'):
                        self._write_effects = set()
                    self._write_effects.add(envelope.task_id)
                await wire._send_error(envelope.task_id or '', str(exc), exc.code,
                    request.payload, request.capability, consent_decision=consent_decision,
                    status='result_not_verified' if exc.code == 'RESULT_UNCERTAIN' else 'failed')
        except asyncio.CancelledError:
            if envelope.task_id in getattr(self, '_write_effects', set()):
                return
            await wire._send_error(
                envelope.task_id or "",
                "local task cancelled",
                "CANCELLED",
                request.payload,
                request.capability,
                policy_decision=PolicyDecision.ALLOW.value,
                status="cancelled",
                consent_decision=consent_decision,
            )
        finally:
            getattr(self, '_write_effects', set()).discard(envelope.task_id)

    async def _execute_consented_inner(
        self, envelope: Any, request: ConsentRequest, *, consent_decision='approved'
    ) -> None:
        from .python import PythonResult

        wire = self._wire
        task_id = envelope.task_id or ""
        if wire.compatibility_gate is not None:
            code = await asyncio.to_thread(wire.compatibility_gate.authorize, request.capability)
            if code:
                await wire._send_error(task_id, 'local combination is incompatible', code,
                    request.payload, request.capability, policy_decision=PolicyDecision.DENY.value,
                    status='denied', consent_decision=consent_decision)
                return
        if self._desktop_write(request.capability) and (wire.receipt_ledger is None or wire.receipt_ledger.error):
            await wire._storage_error(task_id, 'RECEIPT_STORAGE_UNAVAILABLE')
            return
        if request.capability.startswith("local.mcp."):
            assert wire.mcp_service is not None
            execution = await wire.mcp_service.execute(
                request.capability, request.payload, consent=True
            )
            if not isinstance(execution, MCPExecution):
                decision = execution
                value = None
                receipt = None
            else:
                decision = PolicyDecision.ALLOW
                value = execution.value
                receipt = replace(execution.receipt, task_id=task_id)
        elif request.capability == "local.python":
            assert wire.python_service is not None
            python_result = await wire.python_service.execute(
                request.payload,
                consent=True,
                on_output=lambda stream, output: self._send_python_output(
                    task_id, stream, output
                ),
            )
            if not isinstance(python_result, PythonResult):
                decision = python_result
                value = None
            else:
                decision = PolicyDecision.ALLOW
                value = wire._python_result_value(python_result)
                receipt = python_result.receipt
                if receipt is not None:
                    receipt = replace(receipt, task_id=task_id)
        else:
            assert wire.file_service is not None
            file_task = wire.file_service.execute(
                request.capability, request.payload, consent=True
            )
            if self._desktop_write(request.capability) and file_task.decision is PolicyDecision.ALLOW:
                if not hasattr(self, '_write_effects'):
                    self._write_effects = set()
                self._write_effects.add(task_id)
            decision = file_task.decision
            value = file_task.value
            receipt = wire._file_receipt(
                envelope,
                request.capability,
                value,
                consent_decision=consent_decision,
                payload=request.payload,
                task_id=task_id,
            )
        if decision is not PolicyDecision.ALLOW:
            await wire._send_error(
                task_id,
                decision.value,
                "LOCAL_POLICY_DENIED",
                request.payload,
                request.capability,
                policy_decision=decision.value,
                status="denied",
                consent_decision=consent_decision,
            )
            return
        if receipt is None:
            raise RuntimeError("local execution did not produce a receipt")
        from .receipt_ledger import ReceiptStorageError
        try:
            wire.persist_receipt(receipt, payload=request.payload, result=value)
        except ReceiptStorageError:
            await wire._storage_error(task_id, "RESULT_UNCERTAIN")
            return

        assert wire.connection is not None
        await wire.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=wire.private_key,
                    message_type=MessageType.TASK_RESULT,
                    device_id=wire.device_id,
                    session_id=wire.session_id or "",
                    task_id=task_id,
                    payload={
                        "result": value,
                        "receipt": receipt.as_dict(),
                    },
                ),
                separators=(",", ":"),
            )
        )
        await wire.replay_receipts()

    async def _send_python_output(self, task_id: str, stream: str, output: str) -> None:

        wire = self._wire
        assert wire.connection is not None
        await wire.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=wire.private_key,
                    message_type=MessageType.TASK_PROGRESS,
                    device_id=wire.device_id,
                    session_id=wire.session_id or "",
                    task_id=task_id,
                    payload={"fraction": 0.0, "stream": stream, "output": output},
                ),
                separators=(",", ":"),
            )
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
        wire = self._wire
        from .receipts import LocalExecutionReceipt

        receipt = LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id=task_id,
            capability=capability,
            policy_decision=policy_decision,
            status=status,
            payload_hash=content_hash(payload),
            consent_decision=consent_decision,
            error_code=code,
        )
        if wire.receipt_ledger is not None:
            from .receipt_ledger import ReceiptStorageError
            try:
                wire.persist_receipt(receipt)
            except (ReceiptStorageError, ValueError):
                # Invalid/unadmitted protocol frames are never execution facts.
                # An already completed receipt is immutable on cancellation.
                pass
        if wire.connection is None:
            return
        await wire.connection.send(
            json.dumps(
                sign_envelope(
                    private_key=wire.private_key,
                    message_type=MessageType.ERROR,
                    device_id=wire.device_id,
                    session_id=wire.session_id or "",
                    task_id=task_id,
                    payload={
                        "error_code": code,
                        "message": message,
                        "receipt": receipt.as_dict(),
                    },
                ),
                separators=(",", ":"),
            )
        )
        await wire.replay_receipts()
