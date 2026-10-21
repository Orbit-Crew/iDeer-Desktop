"""The user-facing control surface: connection state, consent, and local audit.

The controller is deliberately headless. Everything a Tray needs — status, the
pending-consent queue, decisions, settings edits, audit queries — is an ordinary
method call on this object, so the whole control surface is testable without a
display server, and a thin UI (tkinter today, anything else later) only has to
render :class:`TrayStatus` and call back into it. Packaging the app is M12
(Local 方案 §22, §23).

The runtime loop runs on its own thread, which is what a desktop tray needs
anyway: the UI thread answers consent with :meth:`TrayController.decide` while
the loop thread is blocked waiting for that answer. Consent therefore completes
on this machine without a browser round trip (baseline §24), and every decision
is written to the local audit log either way.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    load_pem_private_key,
)

from .audit import AuditEntry, AuditIntegrity, AuditKind, LocalAuditLog
from .consent import ConsentStore, PendingConsent
from .file_service import LocalFileService
from .files import LocalFileStore
from .mcp import LocalMCPService, MCPSupervisor, load_mcp_specs
from .policy import RiskLevel
from .protocol import public_key_text
from .python import LocalPythonService
from .secrets import (
    InMemorySecretStore,
    SecretBackendUnavailable,
    SecretNotFound,
    SecretResolver,
    SecretStoreError,
    create_default_secret_store,
)
from .settings import CapabilityRule, RuntimeSettings, _SAVE_LOCK, load_settings
from .transport import ConsentDecisionError, LocalRuntimeClient, RePairRequired

#: Reconnect delay after a dropped session, doubling up to a cap: a tray that
#: hammers a downed intranet makes the outage worse than the outage does.
RECONNECT_BACKOFF_SECONDS = 1.0
MAX_RECONNECT_BACKOFF_SECONDS = 30.0
READY_TIMEOUT_SECONDS = 5.0
# status() is polled every second by the tray UI; walking the full audit
# hash chain per poll is O(history) on a display field (05-M7), so the
# integrity verdict is refreshed at most once per interval.
AUDIT_VERIFY_INTERVAL_SECONDS = 30.0


class TrayError(RuntimeError):
    """A control-surface call could not be honoured."""


class TrayApplication:
    """Small native settings/status window backed by :class:`TrayController`.

    Tkinter is imported lazily so headless commands and tests do not require a
    display server.  The controller remains the source of truth; the window
    only renders status and invokes its public actions.
    """

    def __init__(self, controller: TrayController) -> None:
        self.controller = controller

    def run(self) -> None:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.title("iDeer Local Runtime")
        root.geometry("520x360")
        status = tk.StringVar()
        status_label = tk.Label(root, textvariable=status, anchor="w")
        status_label.pack(fill="x", padx=12, pady=(12, 0))
        details = tk.Text(root, height=14, width=68, state="disabled")
        details.pack(fill="both", expand=True, padx=12, pady=12)
        refresh_job: str | None = None

        def refresh() -> None:
            nonlocal refresh_job
            snapshot = self.controller.status().as_dict()
            status.set(f"{snapshot['connection']}  ·  {snapshot['server_url']}")
            details.configure(state="normal")
            details.delete("1.0", "end")
            details.insert("end", json.dumps(snapshot, ensure_ascii=False, indent=2))
            details.configure(state="disabled")
            refresh_job = root.after(1000, refresh)

        def toggle() -> None:
            try:
                if self.controller.status().paused:
                    self.controller.resume()
                else:
                    self.controller.pause()
                refresh()
            except Exception as exc:  # noqa: BLE001 - show UI-safe error
                messagebox.showerror("Local Runtime", str(exc))

        def show_settings() -> None:
            window = tk.Toplevel(root)
            window.title("Local Runtime settings")
            window.geometry("560x420")
            settings = self.controller.open_settings()
            form = tk.Frame(window)
            form.pack(fill="both", expand=True, padx=12, pady=12)
            fields: dict[str, tk.Entry] = {}
            for row, (label, key) in enumerate(
                (
                    ("Server URL", "server_url"),
                    ("Device name", "device_name"),
                    ("MCP config path", "mcp_config_path"),
                )
            ):
                tk.Label(form, text=label).grid(row=row, column=0, sticky="w", pady=4)
                entry = tk.Entry(form, width=58)
                entry.insert(0, str(getattr(settings, key)))
                entry.grid(row=row, column=1, sticky="ew", pady=4)
                fields[key] = entry
            tk.Label(form, text="Roots JSON").grid(row=3, column=0, sticky="nw", pady=4)
            roots = tk.Text(form, height=5, width=58)
            roots.insert("1.0", json.dumps(settings.roots, ensure_ascii=False))
            roots.grid(row=3, column=1, sticky="nsew", pady=4)
            tk.Label(form, text="Rules JSON").grid(row=4, column=0, sticky="nw", pady=4)
            rules = tk.Text(form, height=5, width=58)
            rules.insert("1.0", json.dumps(settings.rules, ensure_ascii=False))
            rules.grid(row=4, column=1, sticky="nsew", pady=4)
            tk.Label(form, text="Risk levels JSON").grid(
                row=5, column=0, sticky="nw", pady=4
            )
            risk_levels = tk.Text(form, height=5, width=58)
            risk_levels.insert(
                "1.0", json.dumps(settings.risk_levels, ensure_ascii=False)
            )
            risk_levels.grid(row=5, column=1, sticky="nsew", pady=4)
            form.columnconfigure(1, weight=1)
            form.rowconfigure(3, weight=1)
            form.rowconfigure(4, weight=1)
            form.rowconfigure(5, weight=1)

            def save() -> None:
                try:
                    parsed_roots = json.loads(roots.get("1.0", "end"))
                    parsed_rules = json.loads(rules.get("1.0", "end"))
                    parsed_risk_levels = json.loads(risk_levels.get("1.0", "end"))
                    if not isinstance(parsed_roots, list) or not all(
                        isinstance(item, dict) for item in parsed_roots
                    ):
                        raise ValueError("roots must be a JSON list of objects")
                    if not isinstance(parsed_rules, dict) or not isinstance(
                        parsed_risk_levels, dict
                    ):
                        raise TypeError("rules and risk levels must be JSON objects")
                    settings.server_url = fields["server_url"].get().strip()
                    settings.device_name = fields["device_name"].get().strip()
                    settings.mcp_config_path = fields["mcp_config_path"].get().strip()
                    settings.roots = [
                        {
                            "logical_root": str(item.get("logical_root", "")),
                            "physical_root": str(item.get("physical_root", "")),
                        }
                        for item in parsed_roots
                    ]
                    settings.rules = {
                        str(key): str(value) for key, value in parsed_rules.items()
                    }
                    settings.risk_levels = {
                        str(key): str(value)
                        for key, value in parsed_risk_levels.items()
                    }
                    self.controller.save_settings()
                    window.destroy()
                    refresh()
                except Exception as exc:  # noqa: BLE001 - show validation failure in UI
                    messagebox.showerror("Local Runtime", str(exc), parent=window)

            tk.Button(window, text="Save settings", command=save).pack(pady=(0, 10))

        def show_pairing() -> None:
            window = tk.Toplevel(root)
            window.title("Pair Local Runtime")
            window.geometry("520x260")
            form = tk.Frame(window)
            form.pack(fill="both", expand=True, padx=12, pady=12)
            values = {
                "server_url": tk.StringVar(value=self.controller.settings.server_url),
                "pairing_code": tk.StringVar(),
                "device_name": tk.StringVar(value=self.controller.settings.device_name),
                "claim_token": tk.StringVar(),
            }
            for row, (label, key) in enumerate(
                (
                    ("Server URL", "server_url"),
                    ("Pairing code", "pairing_code"),
                    ("Device name", "device_name"),
                    ("Claim token", "claim_token"),
                )
            ):
                tk.Label(form, text=label).grid(row=row, column=0, sticky="w", pady=4)
                tk.Entry(
                    form,
                    textvariable=values[key],
                    width=52,
                    show="*" if key == "claim_token" else "",
                ).grid(row=row, column=1, sticky="ew", pady=4)
            form.columnconfigure(1, weight=1)
            status = tk.StringVar(
                value="Create/register first, then confirm the code in the owner web UI."
            )
            tk.Label(window, textvariable=status, wraplength=480, justify="left").pack(
                padx=12, anchor="w"
            )

            def start_pairing() -> None:
                try:
                    result = self.controller.pair_start(
                        server_url=values["server_url"].get(),
                        pairing_code=values["pairing_code"].get(),
                        device_name=values["device_name"].get(),
                    )
                    status.set(
                        f"Registered {result['device_id']}. Confirm the pairing code, then complete pairing."
                    )
                except Exception as exc:  # noqa: BLE001 - show UI-safe error
                    messagebox.showerror("Local Runtime", str(exc), parent=window)

            def complete_pairing() -> None:
                try:
                    self.controller.pair_complete(
                        claim_token=values["claim_token"].get() or None
                    )
                    status.set(
                        "Pairing complete. Use Reconnect to start the device session."
                    )
                except Exception as exc:  # noqa: BLE001 - show UI-safe error
                    messagebox.showerror("Local Runtime", str(exc), parent=window)

            buttons = tk.Frame(window)
            buttons.pack(pady=(8, 10))
            tk.Button(buttons, text="Register", command=start_pairing).pack(
                side="left", padx=4
            )
            tk.Button(buttons, text="Complete", command=complete_pairing).pack(
                side="left", padx=4
            )

        def show_audit() -> None:
            window = tk.Toplevel(root)
            window.title("Local Runtime audit")
            window.geometry("720x420")
            text = tk.Text(window, height=22, width=90)
            text.pack(fill="both", expand=True, padx=12, pady=12)
            entries = self.controller.audit_page(limit=100)
            text.insert(
                "end",
                "\n".join(
                    json.dumps(
                        {
                            "seq": entry.seq,
                            "kind": entry.kind.value,
                            "action": entry.action,
                            "capability": entry.capability,
                            "task_id": entry.task_id,
                        },
                        ensure_ascii=False,
                    )
                    for entry in entries
                )
                or "No audit entries",
            )
            text.configure(state="disabled")

        controls = tk.Frame(root)
        controls.pack(pady=(0, 10))
        tk.Button(controls, text="Pause / Resume", command=toggle).pack(
            side="left", padx=4
        )
        tk.Button(controls, text="Reconnect", command=self.controller.reconnect).pack(
            side="left", padx=4
        )
        tk.Button(controls, text="Disconnect", command=self.controller.disconnect).pack(
            side="left", padx=4
        )
        tk.Button(controls, text="Pairing", command=show_pairing).pack(
            side="left", padx=4
        )
        tk.Button(controls, text="Settings", command=show_settings).pack(
            side="left", padx=4
        )
        tk.Button(controls, text="Audit", command=show_audit).pack(side="left", padx=4)

        def hide() -> None:
            root.withdraw()

        def exit_app() -> None:
            if refresh_job is not None:
                root.after_cancel(refresh_job)
            self.controller.stop()
            root.destroy()

        root.protocol("WM_DELETE_WINDOW", hide)
        tk.Button(controls, text="Exit", command=exit_app).pack(side="left", padx=4)
        refresh()
        root.mainloop()


@dataclass(frozen=True)
class TrayStatus:
    """What the icon, its tooltip, and the status panel show (Local 方案 §23)."""

    connection: str
    server_url: str
    user_name: str
    device_name: str
    device_id: str
    runtime_version: str
    paused: bool
    allowed_roots: tuple[str, ...]
    capabilities: tuple[str, ...]
    mcp_servers: tuple[tuple[str, str], ...]
    pending_consents: int
    recent_execution: str
    audit_entries: int
    audit_integrity: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "connection": self.connection,
            "server_url": self.server_url,
            "user_name": self.user_name,
            "device_name": self.device_name,
            "device_id": self.device_id,
            "runtime_version": self.runtime_version,
            "paused": self.paused,
            "allowed_roots": list(self.allowed_roots),
            "capabilities": list(self.capabilities),
            "mcp_servers": [
                {"name": name, "state": state} for name, state in self.mcp_servers
            ],
            "pending_consents": self.pending_consents,
            "recent_execution": self.recent_execution,
            "audit_entries": self.audit_entries,
            "audit_integrity": self.audit_integrity,
        }


@dataclass
class TrayController:
    """Owns the runtime client, the consent queue, and the local audit log."""

    settings: RuntimeSettings
    private_key: Ed25519PrivateKey
    audit: LocalAuditLog | None = None
    consent_store_path: str | Path | None = None
    #: Broker key bound by the pairing flow (``pair_start`` / ``pair_complete``).
    #: Every connection verifies the broker against it; an unset key means no
    #: pairing has completed and the client refuses to connect unless the
    #: settings enable the explicit first-connection fallback.
    server_public_key: str | None = None
    desktop_mode: bool = False

    def __post_init__(self) -> None:
        if self.server_public_key is None and self.settings.server_public_key:
            self.server_public_key = self.settings.server_public_key
        if self.audit is None:
            self.audit = LocalAuditLog(db_path=self.settings.audit_db_path or None)
        # One approval store for every service: an "always allow" or a denial
        # is per capability, so a shared store cannot leak a decision from one
        # capability to another, and it survives a restart as a unit.
        self.consent = ConsentStore(
            db_path=self.consent_store_path or self._default_consent_path()
        )
        self.secrets = _build_secret_resolver(self.settings, self._note_secret_use)
        self.mcp_service = None if self.desktop_mode else _build_mcp_service(self.settings, self.secrets, self.consent)
        self._mcp_config_path = self.settings.mcp_config_path
        self.client = LocalRuntimeClient(
            server_url=(
                self.settings.websocket_url()
                if self.settings.server_url.strip()
                else "ws://127.0.0.1:8000/api/devices/ws"
            ),
            device_id=self.settings.device_id,
            session_id=self.settings.session_id or None,
            session_token=self.settings.session_token,
            private_key=self.private_key,
            server_public_key=self.server_public_key,
            allow_unpinned_broker_key=self.settings.allow_unpinned_broker_key,
            capabilities=self._desktop_capabilities() if self.desktop_mode else None,
            restrict_capabilities=self.desktop_mode,
            runtime_version=self.settings.runtime_version,
            policy=self.settings.policy(),
            policy_hash=self.settings.policy_hash(),
            file_service=self._desktop_files() if self.desktop_mode else _build_file_service(self.settings, self.consent),
            python_service=None if self.desktop_mode else _build_python_service(
                self.settings, self.secrets, self.consent
            ),
            mcp_service=self.mcp_service,
            audit=self.audit,
            consent_prompt=self._prompt,
            on_session_id=self._remember_session_id,
            on_server_public_key=self._remember_server_public_key,
        )
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._serve_task: asyncio.Task[None] | None = None
        self._stopping = False
        # start/stop/disconnect are called from UI callbacks, which are not
        # ordered against each other; the lock makes "is a session owned?" a
        # single question with one answer per call.
        self._lifecycle = threading.Lock()
        self._last_audit_seq = 0
        self._integrity_cache: tuple[float, AuditIntegrity] | None = None

    def _desktop_files(self):
        from .file_service import WorkspaceFileService, WorkspaceSelection
        return WorkspaceFileService(WorkspaceSelection(self.settings.config_path))

    def _desktop_capabilities(self):
        from .file_service import READ_CAPABILITIES, WorkspaceSelection
        return READ_CAPABILITIES if WorkspaceSelection(self.settings.config_path).status()['state'] == 'ready' else ()

    def _save_connection_setting(self, name: str, value: str) -> None:
        # Selection and connection callbacks share this transaction. Loading
        # outside the lock could overwrite a newer directory grant on reconnect.
        with _SAVE_LOCK:
            if self.desktop_mode:
                current_path = self.settings.config_path
                self.settings = load_settings(current_path)
                self.settings.config_path = current_path
            setattr(self.settings, name, value)
            if self.settings.config_path:
                self.settings.save(self.settings.config_path)

    def _remember_session_id(self, session_id: str) -> None:
        self._save_connection_setting("session_id", session_id)

    def _remember_server_public_key(self, public_key: str) -> None:
        self._save_connection_setting("server_public_key", public_key)
        self.server_public_key = public_key

    def _default_consent_path(self) -> str | None:
        if not self.settings.audit_db_path:
            return None
        return str(Path(self.settings.audit_db_path).with_name("consent.db"))

    # --- runtime loop ----------------------------------------------------

    def start(self) -> None:
        """Run the client on its own thread; returns once the loop is live.

        The thread exists because consent does: the UI thread must be able to
        answer a request while the runtime thread is parked waiting for it.
        """

        def runner() -> None:
            loop = asyncio.new_event_loop()
            self._loop = loop
            asyncio.set_event_loop(loop)
            loop.call_soon(ready.set)
            try:
                self._serve_task = loop.create_task(self._supervise())
                loop.run_until_complete(self._serve_task)
            except asyncio.CancelledError:
                pass  # stop()/disconnect() ended the session deliberately
            finally:
                _drain_pending(loop)
                loop.close()
                # Only clear the published loop if it is still ours: a runner
                # reaped after a ready timeout must not clobber the loop a
                # restarted session published in the meantime (05-M1).
                with self._lifecycle:
                    if self._loop is loop:
                        self._loop = None

        # One critical section for the whole handoff: _stopping is cleared and
        # both the thread and its loop are published before the lock is
        # released, so a teardown either sees a live session or sees none, and
        # a stop landing mid-start can never be undone by this call.
        with self._lifecycle:
            if self._thread is not None:
                raise TrayError("the tray controller is already started")
            self._stopping = False
            ready = threading.Event()
            self._thread = threading.Thread(
                target=runner, name="ideer-local-runtime", daemon=True
            )
            self._thread.start()
            timed_out = not ready.wait(timeout=READY_TIMEOUT_SECONDS)
            if timed_out:
                # The thread exists but its loop never came up. The old
                # comment here claimed "stopping is already set" — nothing
                # had set it, so a runner that woke late dialed anyway while
                # start() had already raised, and the stuck _thread made
                # every later start()/reconnect() fail with "already
                # started" (05-M1). Fail closed: flip _stopping while the
                # lock is still held, so the late _supervise exits without
                # connecting.
                self._stopping = True
        if timed_out:
            # Lock released before joining: the late runner's cleanup takes
            # _lifecycle to unpublish its loop, so joining under the lock
            # would deadlock. Reap so the controller is restartable; a thread
            # that cannot be reaped keeps _thread set — "already started" is
            # the honest answer while a zombie may still wake.
            self._thread.join(timeout=10)
            if not self._thread.is_alive():
                with self._lifecycle:
                    self._thread = None
                    self._serve_task = None
            raise TrayError("the runtime loop did not start")

    async def _supervise(self) -> None:
        """Keep the session up until :meth:`stop`, backing off between attempts."""
        backoff = RECONNECT_BACKOFF_SECONDS
        # A runner reaped after a ready timeout wakes with _stopping set: it
        # must not start MCP servers (or dial) for a session that was given
        # up on (05-M1).
        if not self._stopping and self.mcp_service is not None:
            await self.mcp_service.supervisor.start_all()
        try:
            while not self._stopping:
                try:
                    await self.client.run()
                    if (
                        self.client.session_id
                        and self.client.session_id != self.settings.session_id
                    ):
                        self.settings.session_id = self.client.session_id
                        if self.settings.config_path:
                            self.settings.save(self.settings.config_path)
                except asyncio.CancelledError:
                    raise
                except RePairRequired as exc:
                    self.audit.record(
                        AuditKind.CONNECTION,
                        "pairing_required",
                        detail={
                            "error": str(exc),
                            "device_id": self.settings.device_id,
                        },
                    )
                    self._stopping = True
                    break
                except Exception as exc:  # noqa: BLE001 - any failure means retry
                    # Not just OSError: a dropped websocket surfaces as
                    # ConnectionClosed, which is not an OSError, so a
                    # supervisor that caught only OSError would let the loop
                    # thread die under an icon that still reads "connected".
                    # SystemExit and KeyboardInterrupt are not Exception
                    # subclasses, so a real shutdown still stops the retry.
                    self.audit.record(
                        AuditKind.CONNECTION,
                        "connection_failed",
                        detail={"error": f"{type(exc).__name__}: {exc}"},
                    )
                if self._stopping:
                    break
                self.audit.record(
                    AuditKind.CONNECTION,
                    "reconnecting",
                    detail={"in_seconds": backoff},
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, MAX_RECONNECT_BACKOFF_SECONDS)
        finally:
            if self.mcp_service is not None:
                await self.mcp_service.supervisor.stop_all()

    def stop(self) -> None:
        """Stop the loop thread; open prompts are failed closed, not dropped."""
        self._teardown(actor_id="local-runtime")

    def _teardown(self, *, actor_id: str) -> bool:
        """End the session and join the loop thread; False if none was running.

        Cancel is issued from the loop itself, never from this thread: the
        runtime may be mid-dial, where closing a connection that does not exist
        yet would leave the thread waiting on a socket forever.
        """
        with self._lifecycle:
            thread, loop = self._thread, self._loop
            if thread is None or loop is None:
                return False
            self._stopping = True
        try:
            asyncio.run_coroutine_threadsafe(self._end_session(actor_id=actor_id), loop)
        except RuntimeError:
            # The loop closed on its own rather than being asked to stop, so
            # there is nothing to cancel on it; joining is all that is left.
            pass
        thread.join(timeout=10)
        with self._lifecycle:
            # Cleared either way: leaving a session on record would strand the
            # user on an icon they can neither reconnect nor explain.
            self._thread = None
            self._serve_task = None
        return True

    async def _end_session(self, *, actor_id: str) -> None:
        """Close the session, then end the supervise loop.

        Shutdown runs first so in-flight work is cancelled and open prompts
        fail closed, each outcome audited before the loop stops. The serve task
        is cancelled rather than awaited: awaiting it from inside itself would
        run the cancellation cleanup under a loop that is already ending, and
        the socket would close half-finished.
        """
        task = self._serve_task
        await self.client.shutdown(actor_id=actor_id)
        if task is not None:
            task.cancel()

    # --- display ---------------------------------------------------------

    def status(self) -> TrayStatus:
        client = self.client
        if self._thread is None:
            connection = "offline"
        elif not client.connected:
            connection = "connecting"
        elif client.paused:
            connection = "paused"
        else:
            connection = "connected"
        servers: tuple[tuple[str, str], ...] = ()
        if client.mcp_service is not None:
            supervisor = client.mcp_service.supervisor
            servers = tuple(
                (name, supervisor.state_of(name)) for name in supervisor.server_names()
            )
        recent = self.audit.recent(limit=1, kind=AuditKind.EXECUTION)
        integrity = self._verified_integrity()
        return TrayStatus(
            connection=connection,
            server_url=self.settings.server_url,
            user_name=self.settings.user_name,
            device_name=self.settings.device_name,
            device_id=self.settings.device_id,
            runtime_version=self.settings.runtime_version,
            paused=client.paused,
            allowed_roots=tuple(
                root.logical_root for root in self.settings.file_roots()
            ),
            capabilities=client.current_capabilities(),
            mcp_servers=servers,
            pending_consents=len(client.pending_consents()),
            recent_execution=(
                f"{recent[0].capability} → {recent[0].action}" if recent else ""
            ),
            audit_entries=integrity.entries,
            audit_integrity="ok" if integrity.ok else integrity.problem or "broken",
        )

    def _verified_integrity(self) -> AuditIntegrity:
        """The audit-chain verdict, refreshed at most once per interval (05-M7).

        A rewritten or spliced row surfaces within the interval instead of
        instantly; record()/clear() semantics are unchanged.
        """
        now = time.monotonic()
        cached = self._integrity_cache
        if cached is None or now - cached[0] >= AUDIT_VERIFY_INTERVAL_SECONDS:
            cached = (now, self.audit.verify())
            self._integrity_cache = cached
        return cached[1]

    # --- controls --------------------------------------------------------

    def pause(self, *, actor_id: str = "local-user") -> None:
        """Stop taking new work; in-flight tasks and open prompts complete.

        Pause never loses a task: the runtime answers each one with a
        structured ``DEVICE_PAUSED`` denial and a receipt, which the broker
        records — the same semantics the server's own pause path gives.
        """
        self.client.pause(actor_id=actor_id)

    def resume(self, *, actor_id: str = "local-user") -> None:
        self.client.resume(actor_id=actor_id)

    def disconnect(self, *, actor_id: str = "local-user") -> None:
        """Close the outbound session and stop reconnecting.

        Open prompts fail closed on the way out, and the server marks the
        device offline when the socket drops.
        """
        # Same teardown as a full stop; the tray itself keeps running, so what
        # the user sees afterwards is an offline icon, not a dead process.
        if not self._teardown(actor_id=actor_id):
            self.audit.record(
                AuditKind.CONTROL,
                "disconnect_requested",
                actor_id=actor_id,
                detail={"device_id": self.settings.device_id, "running": False},
            )

    def reconnect(self) -> None:
        """Re-open the session after a disconnect; pairing credentials are reused.

        Refused while anything is still attached: the pair credentials and the
        session token are good for a second socket, so a second ``start()``
        would be a duplicate device session rather than a resume.
        """
        with self._lifecycle:
            if self._thread is not None:
                raise TrayError("the tray controller is already running")
        self.start()

    # --- pairing --------------------------------------------------------

    def pair_start(
        self, *, server_url: str, pairing_code: str, device_name: str
    ) -> dict[str, Any]:
        """Register this device against an owner-created pairing challenge."""
        if (
            not server_url.strip()
            or not pairing_code.strip()
            or not device_name.strip()
        ):
            raise TrayError("server URL, pairing code, and device name are required")
        base = server_url.rstrip("/")
        endpoint = (
            f"{base}/devices/register"
            if base.endswith("/api")
            else f"{base}/api/devices/register"
        )
        result = self._pairing_post(
            endpoint,
            {
                "pairing_code": pairing_code,
                "name": device_name,
                "public_key": public_key_text(self.private_key),
                "protocol_version": "1",
                "runtime_version": self.settings.runtime_version,
                "capabilities": list(self.client.current_capabilities()),
            },
        )
        try:
            secure = create_default_secret_store()
            device_id = str(result["device"]["id"])
            claim_ref = f"ideer-device-claim-{device_id}"
            secure.set(claim_ref, str(result["claim_token"]))
        except (KeyError, SecretStoreError) as exc:
            raise TrayError("the pairing claim could not be stored securely") from exc
        self.settings.server_url = server_url
        self.settings.device_id = device_id
        self.settings.device_name = device_name
        self.settings.claim_token_ref = claim_ref
        self.settings.session_id = ""
        self.settings.session_token = ""
        # The register response distributes the broker public key over the
        # pairing channel; bind it now so no ws:// connection ever has to.
        broker_key = str(result.get("server_public_key", ""))
        if broker_key:
            self.settings.server_public_key = broker_key
            self.server_public_key = broker_key
            self.client.server_public_key = broker_key
        self.settings.save(self.settings.config_path)
        self.audit.record(
            AuditKind.CONFIG,
            "pairing_started",
            detail={"device_id": device_id, "claim_ref": claim_ref},
        )
        return {
            "pairing_id": result["pairing_id"],
            "device_id": device_id,
            "claim_expires_at": result["claim_expires_at"],
        }

    def pair_complete(self, *, claim_token: str | None = None) -> RuntimeSettings:
        """Complete owner confirmation and bind the issued session locally."""
        if not self.settings.device_id or not self.settings.server_url:
            raise TrayError("start pairing before completing it")
        try:
            secure = create_default_secret_store()
            token = claim_token or secure.get(self.settings.claim_token_ref)
        except SecretStoreError as exc:
            raise TrayError(f"pairing claim unavailable: {exc.code}") from exc
        base = self.settings.server_url.rstrip("/")
        endpoint = (
            f"{base}/devices/register/complete"
            if base.endswith("/api")
            else f"{base}/api/devices/register/complete"
        )
        result = self._pairing_post(
            endpoint,
            {
                "device_id": self.settings.device_id,
                "public_key": public_key_text(self.private_key),
                "claim_token": token,
            },
        )
        try:
            session_token = str(result["session_token"])
            token_ref = f"ideer-device-session-{self.settings.device_id}"
            secure.set(token_ref, session_token)
        except (KeyError, SecretStoreError) as exc:
            raise TrayError("the device session could not be stored securely") from exc
        device = result.get("device", {})
        self.settings.session_id = str(result.get("session_id", ""))
        self.settings.session_token = session_token
        self.settings.session_token_ref = token_ref
        self.settings.claim_token_ref = ""
        self.settings.device_name = str(device.get("name", self.settings.device_name))
        # Re-bind the broker key the complete response distributes (or keep
        # the one already captured at pair_start); the pinned key is what the
        # client verifies every subsequent connection against.
        broker_key = str(result.get("server_public_key", "")) or (
            self.settings.server_public_key
        )
        if broker_key:
            self.settings.server_public_key = broker_key
            self.server_public_key = broker_key
        self.settings.save(self.settings.config_path)
        self.client.server_url = self.settings.websocket_url()
        self.client.device_id = self.settings.device_id
        self.client.session_id = self.settings.session_id
        self.client.session_token = session_token
        self.client.server_public_key = self.settings.server_public_key or None
        self.audit.record(
            AuditKind.CONFIG,
            "pairing_completed",
            detail={"device_id": self.settings.device_id},
        )
        return self.settings

    @staticmethod
    def _pairing_post(endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.load(response)
        except Exception as exc:
            raise TrayError(f"pairing request failed: {type(exc).__name__}") from exc
        if not isinstance(result, dict):
            raise TrayError("pairing response was not a JSON object")
        return result

    # --- consent ---------------------------------------------------------

    def pending_consents(self) -> tuple[PendingConsent, ...]:
        return self.client.pending_consents()

    def decide(
        self,
        request: PendingConsent,
        *,
        approved: bool,
        actor_id: str = "local-user",
        always: bool = False,
    ) -> None:
        """Answer one request from the UI thread.

        ``always`` records an always-allow rule for that capability, and is
        refused for Level 2 work: a dangerous operation can never be moved out
        of the ask-first path (Local 方案 §9). Both outcomes are audited by the
        transport, which also binds the decision to the exact request hash shown.
        """
        if always and not request.silenceable:
            raise TrayError("a level 2 request cannot be always-allowed")
        try:
            self.client.resolve_local_consent(
                request.task_id, approved=approved, actor_id=actor_id, always=always
            )
        except ConsentDecisionError as exc:
            raise TrayError(str(exc)) from exc

    async def _prompt(self, request: PendingConsent) -> dict[str, Any] | None:
        """Keep an on-device request visible until it stops being answerable.

        The tray never answers through this coroutine: the UI thread calls
        :meth:`decide`, which settles the transport's own future, and the
        transport then cancels this task. Parking is therefore the honest
        behaviour — returning early would either imply a decision or hang the
        task past the point where the user could still answer it.
        """
        await asyncio.Event().wait()

    def risk_level(self, capability: str, payload: dict[str, Any]) -> RiskLevel:
        return self.client.policy.risk_level(capability, payload)

    # --- audit queries ---------------------------------------------------

    def audit_recent(
        self, *, limit: int = 50, kind: AuditKind | None = None
    ) -> list[AuditEntry]:
        return self.audit.recent(limit=limit, kind=kind)

    def audit_new_since(self) -> list[AuditEntry]:
        """Entries appended since the last call: what a live view must append."""
        entries = self.audit.since(self._last_audit_seq)
        if entries:
            self._last_audit_seq = entries[-1].seq
        return entries

    def audit_page(
        self,
        *,
        limit: int = 50,
        kinds: tuple[AuditKind, ...] = (),
        capability: str | None = None,
    ) -> list[AuditEntry]:
        return self.audit.filter(kinds=kinds, capability=capability, limit=limit)

    def clear_audit(self, *, actor_id: str = "local-user") -> dict[str, Any]:
        """Clear the visible history; the clear itself stays on record."""
        self._last_audit_seq = 0
        return self.audit.clear(actor_id=actor_id)

    def audit_integrity(self) -> str:
        result = self.audit.verify()
        return "ok" if result.ok else result.problem or "broken"

    # --- settings --------------------------------------------------------

    def open_settings(self) -> RuntimeSettings:
        """The live settings object the UI edits in place.

        Open Settings in the tray menu hands this back to the settings panel;
        every edit goes through ``set_rule`` / ``set_risk_level`` / ``add_root``
        / ``remove_root`` / ``save_settings`` below, and the panel simply reads
        the same object. No copy is made: the panel must see what the runtime
        sees, not a stale snapshot.
        """
        return self.settings

    def view_local_audit(self) -> LocalAuditView:
        """A read-only view of the local audit history, for the tray menu.

        The UI renders ``entries`` newest-first, calls ``clear`` to wipe the
        visible history (the clear itself stays on record), and shows
        ``integrity`` when the chain does not verify.
        """
        return LocalAuditView(self)

    def save_settings(self) -> Path:
        """Write the current configuration and re-point the running client at it.

        A policy change takes effect on the next task without a restart, and the
        new hash is republished with the next capability update so the server
        can tell the device's policy moved.
        """
        if not self.settings.config_path:
            raise TrayError("no settings file is configured")
        self._rebuild_file_services()
        if self.settings.mcp_config_path != self._mcp_config_path:
            self._replace_mcp_service()
        self.apply_policy()
        self.audit.record(
            AuditKind.CONFIG,
            "saved",
            detail={"policy_hash": self.settings.policy_hash()},
        )
        return self.settings.save(self.settings.config_path)

    def apply_policy(self) -> None:
        """Push the current grading into every layer that enforces it.

        The client gates dispatch and each service re-checks before acting; if
        only one of them were updated, a rule change would half-apply.
        """
        policy = self.settings.policy()
        self.client.policy = policy
        self.client.policy_hash = self.settings.policy_hash()
        for service in (
            self.client.file_service,
            self.client.python_service,
            self.client.mcp_service,
        ):
            if service is not None:
                service.policy = policy

    def set_rule(self, capability: str, rule: CapabilityRule) -> None:
        """Grade one capability; the §9 tiers are the user's to choose."""
        self.settings.set_rule(capability, rule)
        self.apply_policy()
        self.audit.record(
            AuditKind.CONFIG,
            "rule_changed",
            capability=capability,
            detail={"rule": rule.value},
        )
        self._commit_configuration()

    def set_risk_level(self, capability: str, level: RiskLevel) -> None:
        self.settings.set_risk_level(capability, level)
        self.apply_policy()
        self.audit.record(
            AuditKind.CONFIG,
            "risk_level_changed",
            capability=capability,
            detail={"risk_level": level.value},
        )
        self._commit_configuration()

    def add_root(self, logical_root: str, physical_root: str | Path) -> None:
        """Widen or replace one allowed root and rebuild the store it feeds."""
        self.settings.add_root(logical_root, physical_root)
        self._rebuild_file_services()
        self.audit.record(
            AuditKind.CONFIG,
            "root_added",
            detail={"logical_root": logical_root},
        )
        self._commit_configuration()

    def remove_root(self, logical_root: str) -> None:
        self.settings.remove_root(logical_root)
        self._rebuild_file_services()
        self.audit.record(
            AuditKind.CONFIG,
            "root_removed",
            detail={"logical_root": logical_root},
        )
        self._commit_configuration()

    def _commit_configuration(self) -> None:
        """Persist a live edit and publish its policy to an active session."""
        if self.settings.config_path:
            self.settings.save(self.settings.config_path)
        if self._loop is not None and self.client.connection is not None:
            future = asyncio.run_coroutine_threadsafe(
                self.client.send_capability_update(), self._loop
            )
            try:
                future.result(timeout=5)
            except Exception as exc:  # noqa: BLE001 - UI must remain responsive
                self.audit.record(
                    AuditKind.CONFIG,
                    "publish_failed",
                    detail={"error": type(exc).__name__},
                )

    def _rebuild_file_services(self) -> None:
        store = LocalFileStore(self.settings.file_roots())
        roots = self.settings.file_roots()
        if roots:
            if self.client.file_service is None:
                self.client.file_service = LocalFileService(
                    store, policy=self.client.policy, consent=self.consent
                )
            else:
                self.client.file_service.files = store
            if self.client.python_service is None:
                self.client.python_service = LocalPythonService(
                    store,
                    policy=self.client.policy,
                    consent=self.consent,
                    secrets=self.secrets,
                )
            else:
                self.client.python_service.files = store
        else:
            self.client.file_service = None
            self.client.python_service = None

    def set_mcp_config_path(self, path: str | Path) -> None:
        """Apply an MCP config edit and restart only the local MCP services."""
        self.settings.mcp_config_path = str(path)
        self._replace_mcp_service()
        self._commit_configuration()

    def _replace_mcp_service(self) -> None:
        old = self.mcp_service
        new = _build_mcp_service(self.settings, self.secrets, self.consent)
        self.mcp_service = new
        self.client.mcp_service = new
        self._mcp_config_path = self.settings.mcp_config_path
        if new is not None:
            new.on_capabilities_changed = self.client._on_mcp_capabilities_changed
        if self._loop is None:
            return

        async def swap() -> None:
            if old is not None:
                await old.supervisor.stop_all()
            if new is not None:
                await new.supervisor.start_all()
            await self.client._on_mcp_capabilities_changed()

        future = asyncio.run_coroutine_threadsafe(swap(), self._loop)
        try:
            future.result(timeout=10)
        except Exception as exc:  # noqa: BLE001 - UI must remain responsive
            self.audit.record(
                AuditKind.CONFIG,
                "mcp_restart_failed",
                detail={"error": type(exc).__name__},
            )

    # --- secrets (names and references only) -----------------------------

    def secret_names(self) -> tuple[str, ...]:
        """Configured secret names; the values never reach this process's view."""
        if self.secrets is None:
            return ()
        try:
            return self.secrets.store.names()
        except SecretStoreError:
            return ()

    def store_secret(self, name: str, value: str) -> None:
        """Put one credential in the OS store; nothing here keeps a copy.

        The tray only ever handles the name; a task references the value as
        ``local:<name>``, so plaintext stays out of settings, audit and wire.
        """
        if self.secrets is None:
            raise TrayError("no secure secret store is available on this device")
        self.secrets.store.set(name, value)
        self.audit.record(AuditKind.SECRET, "stored", detail={"ref": f"local:{name}"})

    def delete_secret(self, name: str) -> None:
        if self.secrets is None:
            raise TrayError("no secure secret store is available on this device")
        self.secrets.store.delete(name)
        self.audit.record(AuditKind.SECRET, "deleted", detail={"ref": f"local:{name}"})

    def secret_usage(self) -> list[AuditEntry]:
        return self.audit.filter(kinds=(AuditKind.SECRET,), limit=0)

    def _note_secret_use(self, names: tuple[str, ...]) -> None:
        for name in names:
            self.audit.record(
                AuditKind.SECRET,
                "resolved",
                detail={"ref": f"local:{name}"},
            )


def load_controller(
    path: str | Path,
    *,
    private_key: Ed25519PrivateKey | None = None,
    audit: LocalAuditLog | None = None,
    desktop_mode: bool = False,
) -> TrayController:
    """Build a controller from a settings file; a missing file is a fresh device."""
    settings = load_settings(path)
    settings.config_path = str(path)
    # Migrate legacy plaintext session credentials into the secure backend;
    # the settings file is rewritten only after the secure write succeeds.
    if settings.session_token_ref:
        try:
            secure = create_default_secret_store()
            settings.session_token = secure.get(settings.session_token_ref)
        except (SecretBackendUnavailable, SecretStoreError):
            settings.session_token = ""
    elif settings.session_token:
        try:
            secure = create_default_secret_store()
            ref = f"ideer-device-session-{settings.device_id or 'default'}"
            secure.set(ref, settings.session_token)
            settings.session_token_ref = ref
            settings.save(path)
        except (SecretBackendUnavailable, SecretStoreError):
            # Keep the in-memory legacy value for this process, but do not
            # claim migration succeeded or create a plaintext backup.
            pass
    key_path = Path(path).with_name("runtime-key")
    secure = None
    try:
        secure = create_default_secret_store()
    except SecretBackendUnavailable:
        pass
    key_ref = (
        settings.device_key_ref or f"ideer-device-key-{settings.device_id or 'default'}"
    )
    private_key = private_key or _load_or_create_key(
        key_path, secure_store=secure, key_ref=key_ref
    )
    if secure is not None and settings.device_key_ref != key_ref:
        settings.device_key_ref = key_ref
        settings.save(path)
    return TrayController(
        settings=settings,
        desktop_mode=desktop_mode,
        private_key=private_key,
        audit=audit,
        consent_store_path=Path(path).with_name("consent.db"),
    )


def _load_or_create_key(
    path: Path,
    *,
    secure_store: Any | None = None,
    key_ref: str | None = None,
) -> Ed25519PrivateKey:
    """Read the device signing key, creating one on first run.

    The server pins the public key captured at pairing, so this file must
    outlive restarts: losing it means re-pairing, not a silent new identity.
    It is written unreadable to anyone but the user because it signs every
    frame this device sends.
    """
    if secure_store is not None and key_ref:
        try:
            encoded = secure_store.get(key_ref)
            key = load_pem_private_key(base64.b64decode(encoded), password=None)
            if isinstance(key, Ed25519PrivateKey):
                return key
            raise TrayError("the stored device key is not an Ed25519 key")
        except SecretNotFound:
            pass
        except (ValueError, TypeError, OSError) as exc:
            raise TrayError("the stored device key could not be read") from exc
    if path.exists():
        try:
            pem = path.read_bytes()
            key = load_pem_private_key(pem, password=None)
        except (ValueError, TypeError, OSError) as exc:
            raise TrayError(f"the device key at {path} could not be read") from exc
        if not isinstance(key, Ed25519PrivateKey):
            raise TrayError(f"{path} is not an Ed25519 key")
        if secure_store is not None and key_ref:
            try:
                secure_store.set(key_ref, base64.b64encode(pem).decode("ascii"))
                path.unlink()
            except (SecretStoreError, OSError) as exc:
                raise TrayError(
                    "the device key could not be migrated to secure storage"
                ) from exc
        return key
    path.parent.mkdir(parents=True, exist_ok=True)
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    )
    if secure_store is not None and key_ref:
        try:
            secure_store.set(key_ref, base64.b64encode(pem).decode("ascii"))
        except SecretStoreError as exc:
            raise TrayError("the device key could not be stored securely") from exc
    else:
        _write_private_key(path, key)
    return key


def _write_private_key(path: Path, key: Ed25519PrivateKey) -> None:
    # Create the file directly at 0600: write_bytes-then-chmod left a short
    # umask-dependent window where the PEM private key was world-readable
    # and the write was not atomic (05-L3).
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(
                key.private_bytes(
                    encoding=Encoding.PEM,
                    format=PrivateFormat.PKCS8,
                    encryption_algorithm=NoEncryption(),
                )
            )
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _drain_pending(loop: asyncio.AbstractEventLoop) -> None:
    pending = asyncio.all_tasks(loop)
    for task in pending:
        task.cancel()
    if pending:
        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))


def _build_secret_resolver(
    settings: RuntimeSettings, on_use: Any
) -> SecretResolver | None:
    """Resolve references locally; a missing OS backend degrades to no secrets."""
    if settings.secret_backend == "memory":
        return SecretResolver(InMemorySecretStore(), on_use=on_use)
    try:
        return SecretResolver(create_default_secret_store(), on_use=on_use)
    except SecretBackendUnavailable:
        return None


def _build_file_service(
    settings: RuntimeSettings, consent: ConsentStore
) -> LocalFileService | None:
    roots = settings.file_roots()
    if not roots:
        return None
    return LocalFileService(
        LocalFileStore(roots), policy=settings.policy(), consent=consent
    )


def _build_python_service(
    settings: RuntimeSettings, secrets: SecretResolver | None, consent: ConsentStore
) -> LocalPythonService | None:
    roots = settings.file_roots()
    if not roots:
        return None
    return LocalPythonService(
        LocalFileStore(roots),
        policy=settings.policy(),
        consent=consent,
        secrets=secrets,
    )


def _build_mcp_service(
    settings: RuntimeSettings,
    secrets: SecretResolver | None,
    consent: ConsentStore,
) -> LocalMCPService | None:
    if not settings.mcp_config_path:
        return None
    lookup = secrets.name_lookup() if secrets is not None else None
    supervisor = MCPSupervisor(
        load_mcp_specs(settings.mcp_config_path), secret_resolver=lookup
    )
    return LocalMCPService(supervisor, policy=settings.policy(), consent=consent)


class LocalAuditView:
    """A read-only window into the local audit history, for the tray menu.

    The UI renders ``entries`` (newest first), calls ``clear`` to wipe the
    visible history, and shows ``integrity`` when the hash chain does not
    verify. The one destructive operation, ``clear``, seals what it drops so
    a wiped log can never be mistaken for an empty one (Local 方案 §35).
    """

    def __init__(self, controller: TrayController) -> None:
        self._controller = controller

    @property
    def entries(self) -> list[AuditEntry]:
        """The visible history, newest first: what the user sees on open."""
        return self._controller.audit.recent(limit=200)

    def clear(self, *, actor_id: str = "local-user") -> dict[str, Any]:
        """Drop the visible history; the clear itself stays on record."""
        return self._controller.clear_audit(actor_id=actor_id)

    @property
    def integrity(self) -> AuditIntegrity:
        """Walks the hash chain; a rewritten row makes ``ok`` false."""
        return self._controller.audit.verify()

    def clearances(self) -> list[dict[str, Any]]:
        """Every past clear, so the user sees what was wiped and when."""
        return self._controller.audit.clearances()
