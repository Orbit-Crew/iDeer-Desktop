"""Issue 111: the Agent's controlled terminal, carried by the Runtime.

The platform Agent runs exactly one shell command per task through the same
gates as the inline code channel (#105): the local policy vetoes first, the
session tier (#74) answers a ``full``-tier ask whose folder anchor is inside
the confirmed workspace, and every other command is an explicit local ask.
One rule sits ahead of any consent flow, at the service itself: a command
whose working folder cannot be proven ``inside`` the confirmed workspace -
or that lands on a protected name - is refused in every tier without ever
asking, so neither a tier nor a misread ask can widen the terminal past the
bound folder. There is no working directory outside it, no environment
injection and no custom interpreter: the pinned system shell starts anchored
in the authorized folder, so a command's products land inside it by default.

Every executed command becomes one row in the device's terminal history
(``agent-terminal.db``, the same binding-scoped identity discipline as the
other registries): the command text, the anchored folder, bounded output
tails with their content hashes, and the honest end state tied to the
platform Run/Tool Call ids. A stop request fences the Run durably
(:mod:`core.task_guard`), kills the process tree, and records the row as
cancelled with ``effects_uncertain`` - a half-run command's file effects can
never be proven, so the history marks it 效果待核实 and nothing ever re-runs
it. The same uncertainty applies to a timed-out command, and rows still
``running`` when the runtime process starts are swept to ``interrupted``:
their process is gone and only the process state is claimed honestly.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .compat import StrEnum, UTC
from .consent import ConsentStore, request_hash
from .files import LocalFileStore
from .policy import LocalPolicy, PolicyDecision
from .python import MAX_TASK_TIMEOUT_SECONDS, _StreamingRedactor, _WindowsJob, _resume_initial_thread
from .receipts import LocalExecutionReceipt, content_hash
from .secrets import SecretRedactor

TERMINAL_CAPABILITY = "local.terminal"

# One agent ask is one bounded command line. Four thousand characters covers
# every reasonable build/test invocation while keeping the consent summary,
# the audit row and the history entry displayable.
MAX_COMMAND_LENGTH = 4000
DEFAULT_TIMEOUT_SECONDS = 60.0

# The history keeps the most recent commands of this device identity; older
# rows are pruned after each completion. Tails are display facts (what the
# platform already saw streamed); the content hashes stay the verifiable
# full-output facts, exactly like the Python receipts.
MAX_HISTORY_ROWS = 200
MAX_TAIL_CHARS = 16_000
# Live tails reach the status snapshot while a command runs; rewriting the
# row on every rate-limited chunk would churn SQLite, so they land at most
# twice a second (the final tails always land with the completion).
TAIL_UPDATE_INTERVAL_SECONDS = 0.5


class TerminalTaskStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"
    INTERRUPTED = "interrupted"
    REFUSED = "refused"


# A command whose process was killed (stop, timeout, restart) may have left
# file effects behind that nobody observed to the end: the history says so
# instead of pretending the outcome is known.
UNCERTAIN_STATUSES = frozenset(
    {
        TerminalTaskStatus.CANCELLED,
        TerminalTaskStatus.TIMED_OUT,
        TerminalTaskStatus.INTERRUPTED,
    }
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


class TerminalHistoryError(RuntimeError):
    """A fixed-category history failure; safe to surface as an error code."""


@dataclass(frozen=True)
class TerminalResult:
    status: TerminalTaskStatus
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_hash: str | None = None
    stderr_hash: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    working_root: str = ""
    effects_uncertain: bool = False
    receipt: LocalExecutionReceipt | None = None


class AgentTerminalHistory:
    """One immutable terminal row per (identity, task), plus live tails.

    The store never carries more than the display facts: command text,
    bounded tails, hashes, statuses. Nothing here re-runs a command, and a
    row's first end state is final - only a ``running`` row may be completed
    or swept, so a replayed or finished task can never rewrite its history.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS agent_terminal (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
                    tool_call_id TEXT NOT NULL DEFAULT '', command TEXT NOT NULL,
                    working_root TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
                    exit_code INTEGER, stdout_tail TEXT NOT NULL DEFAULT '',
                    stderr_tail TEXT NOT NULL DEFAULT '', stdout_hash TEXT,
                    stderr_hash TEXT, effects_uncertain INTEGER NOT NULL DEFAULT 0,
                    authorization_basis TEXT NOT NULL DEFAULT '',
                    started_at TEXT NOT NULL, finished_at TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "TERMINAL_STORAGE_UNAVAILABLE"

    @property
    def error(self) -> str:
        return self._error

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, uri=self.path.startswith("file:"))
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def _execute(self, operation):
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                self._error = ""
                return result
            except (sqlite3.Error, OSError) as exc:
                self._error = "TERMINAL_STORAGE_UNAVAILABLE"
                raise TerminalHistoryError(self._error) from exc

    @staticmethod
    def _binding(binding) -> dict[str, str]:
        fields = ("server_origin", "user_id", "device_id", "device_public_key", "broker_public_key")
        return {key: str((binding or {}).get(key, "")) for key in fields}

    @classmethod
    def _identity(cls, binding, task_id) -> str:
        return content_hash({**cls._binding(binding), "task_id": str(task_id)})

    def admit(self, binding, row: dict[str, Any]) -> bool:
        """Open one ``running`` row before anything executes; first wins."""
        fields = {key: str(row.get(key, "")) for key in
                  ("thread_id", "run_id", "task_id", "tool_call_id", "command", "working_root",
                   "authorization_basis", "started_at")}

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO agent_terminal (identity, binding, thread_id, run_id, task_id,"
                " tool_call_id, command, working_root, status, started_at, authorization_basis)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (self._identity(binding, fields["task_id"]), json.dumps(self._binding(binding), sort_keys=True),
                 fields["thread_id"], fields["run_id"], fields["task_id"], fields["tool_call_id"],
                 fields["command"], fields["working_root"], TerminalTaskStatus.RUNNING.value,
                 fields["started_at"], fields["authorization_basis"]))
            return cursor.rowcount == 1

        return self._execute(write)

    def record_refused(self, binding, row: dict[str, Any]) -> bool:
        """Record a command refused before it could run; display-only.

        A refused command never started, so both timestamps name the refusal
        moment - the row exists so the history shows what was asked of the
        device and that the device said no.
        """
        fields = {key: str(row.get(key, "")) for key in
                  ("thread_id", "run_id", "task_id", "tool_call_id", "command", "working_root",
                   "authorization_basis")}
        refused_at = str(row.get("finished_at") or _now())

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO agent_terminal (identity, binding, thread_id, run_id, task_id,"
                " tool_call_id, command, working_root, status, started_at, finished_at,"
                " authorization_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (self._identity(binding, fields["task_id"]), json.dumps(self._binding(binding), sort_keys=True),
                 fields["thread_id"], fields["run_id"], fields["task_id"], fields["tool_call_id"],
                 fields["command"], fields["working_root"], TerminalTaskStatus.REFUSED.value,
                 refused_at, refused_at, fields["authorization_basis"]))
            return cursor.rowcount == 1

        return self._execute(write)

    def update_output(self, binding, task_id, *, stdout_tail: str, stderr_tail: str) -> None:
        """Refresh the live tails of one running row (display facts only)."""

        def write(db):
            db.execute(
                "UPDATE agent_terminal SET stdout_tail=?, stderr_tail=?"
                " WHERE identity=? AND status=?",
                (stdout_tail[-MAX_TAIL_CHARS:], stderr_tail[-MAX_TAIL_CHARS:],
                 self._identity(binding, task_id), TerminalTaskStatus.RUNNING.value))

        self._execute(write)

    def complete(self, binding, task_id, *, status: TerminalTaskStatus, exit_code: int | None,
                 stdout_tail: str, stderr_tail: str, stdout_hash: str | None,
                 stderr_hash: str | None, finished_at: str) -> bool:
        """Close one running row with its final honest state; first close wins."""

        def write(db):
            cursor = db.execute(
                "UPDATE agent_terminal SET status=?, exit_code=?, stdout_tail=?, stderr_tail=?,"
                " stdout_hash=?, stderr_hash=?, effects_uncertain=?, finished_at=?"
                " WHERE identity=? AND status=?",
                (status.value, exit_code, stdout_tail[-MAX_TAIL_CHARS:], stderr_tail[-MAX_TAIL_CHARS:],
                 stdout_hash, stderr_hash, 1 if status in UNCERTAIN_STATUSES else 0, finished_at,
                 self._identity(binding, task_id), TerminalTaskStatus.RUNNING.value))
            if cursor.rowcount != 1:
                return False
            db.execute(
                "DELETE FROM agent_terminal WHERE rowid NOT IN"
                " (SELECT rowid FROM agent_terminal ORDER BY rowid DESC LIMIT ?)",
                (MAX_HISTORY_ROWS,))
            return True

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {
            "threadId": row["thread_id"], "runId": row["run_id"], "taskId": row["task_id"],
            "toolCallId": row["tool_call_id"], "command": row["command"],
            "workingRoot": row["working_root"], "status": row["status"],
            "exitCode": row["exit_code"], "stdoutTail": row["stdout_tail"],
            "stderrTail": row["stderr_tail"], "stdoutHash": row["stdout_hash"],
            "stderrHash": row["stderr_hash"],
            "effectsUncertain": bool(row["effects_uncertain"]),
            "authorizationBasis": row["authorization_basis"],
            "startedAt": row["started_at"], "finishedAt": row["finished_at"],
        }

    def view(self, binding, thread_id=None, run_ids=(), limit: int = MAX_HISTORY_ROWS) -> list[dict[str, Any]]:
        """Bounded rows for one identity; one thread's history or named runs."""
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        wanted_runs = {str(run_id) for run_id in run_ids}
        bounded = max(1, min(int(limit), MAX_HISTORY_ROWS))

        def read(db):
            rows = []
            for row in db.execute(
                    "SELECT * FROM agent_terminal WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                    (encoded, MAX_HISTORY_ROWS)):
                if thread_id is not None and row["thread_id"] != str(thread_id) \
                        and row["run_id"] not in wanted_runs:
                    continue
                rows.append(self._view(row))
                if len(rows) >= bounded:
                    break
            return rows

        return self._execute(read)

    def running(self) -> list[dict[str, Any]]:
        """The in-flight rows of this process (stale ones were swept at start)."""

        def read(db):
            return [self._view(row) for row in db.execute(
                "SELECT * FROM agent_terminal WHERE status=? ORDER BY rowid",
                (TerminalTaskStatus.RUNNING.value,))]

        return self._execute(read)

    def sweep_interrupted(self) -> int:
        """Mark every ``running`` row interrupted; called at process start.

        A runtime restart kills its child processes with the process tree, so
        any row still running belongs to a dead process: the honest end state
        is ``interrupted`` with unproven effects, never a silent completion.
        """
        finished_at = _now()

        def write(db):
            cursor = db.execute(
                "UPDATE agent_terminal SET status=?, effects_uncertain=1, finished_at=?"
                " WHERE status=?",
                (TerminalTaskStatus.INTERRUPTED.value, finished_at, TerminalTaskStatus.RUNNING.value))
            return cursor.rowcount

        return self._execute(write)


def _shell_argv(command: str) -> list[str]:
    """The pinned system shell carrying one command; nothing else is offered."""
    if os.name == "nt":
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        # /d ignores AutoRun (no user startup scripts), /s /c carry the whole
        # command as one argument with predictable quote stripping.
        return [comspec, "/d", "/s", "/c", command]
    return ["/bin/sh", "-c", command]


class ShellExecutor:
    """Bounded, cancel-safe execution of one shell command; no PTY.

    The child never shares the human terminal's PTY (issue 110 lives in the
    Electron main): stdout/stderr are redirected files, output streams back
    rate-limited and secret-redacted, and the process tree dies reliably with
    the task - suspended start under a Job Object on Windows, a new session
    with process-group kill elsewhere.
    """

    def __init__(self, *, max_output_rate_bytes: int = 64 * 1024) -> None:
        self.max_output_rate_bytes = max_output_rate_bytes

    async def run(
        self,
        command: str,
        *,
        working_root: Path,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        secret_values: tuple[str, ...] = (),
        on_output: Callable[[str, str], Any] | None = None,
    ) -> TerminalResult:
        if not working_root.is_dir():
            raise ValueError("working_root must be a directory")
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"}
        }
        process_options = {
            "cwd": working_root,
            "env": env,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
        }
        if os.name == "nt":
            # Keep the child suspended until the Job Object owns it; this
            # closes the window in which a command could spawn an unmanaged
            # descendant (the same discipline as the Python executor).
            process_options["creationflags"] = 0x200 | 0x4  # NEW_PROCESS_GROUP | SUSPENDED
        else:
            process_options["start_new_session"] = True
        secret_redactor = SecretRedactor(secret_values)
        started_at = datetime.now(UTC)
        with ExitStack() as stack:
            log_temp_names: list[str] = []

            def _remove_log_temp_files() -> None:
                for name in log_temp_names:
                    Path(name).unlink(missing_ok=True)

            stack.callback(_remove_log_temp_files)
            stdout_file = stack.enter_context(
                tempfile.NamedTemporaryFile(
                    mode="w+b", prefix="agent-terminal-stdout-", delete=False
                )
            )
            log_temp_names.append(stdout_file.name)
            stderr_file = stack.enter_context(
                tempfile.NamedTemporaryFile(
                    mode="w+b", prefix="agent-terminal-stderr-", delete=False
                )
            )
            log_temp_names.append(stderr_file.name)
            process_options["stdout"] = stdout_file
            process_options["stderr"] = stderr_file
            process = subprocess.Popen(  # noqa: ASYNC220
                _shell_argv(command),
                **process_options,
            )
            job = None
            if os.name == "nt":
                try:
                    job = _WindowsJob(process.pid, process_handle=process._handle)
                    _resume_initial_thread(process.pid)
                except Exception:  # noqa: BLE001 - any setup failure must clean up
                    _terminate_tree(process)
                    await _wait_until_exited(process)
                    raise RuntimeError("reliable Windows process cleanup unavailable")
            tails = {"stdout": "", "stderr": ""}
            offsets = {"stdout": 0, "stderr": 0}
            redactors = {
                "stdout": _StreamingRedactor(secret_redactor),
                "stderr": _StreamingRedactor(secret_redactor),
            }
            try:
                status = await self._stream_until_exit(
                    process, on_output, tails, offsets, redactors,
                    {"stdout": stdout_file.name, "stderr": stderr_file.name},
                    timeout,
                )
            finally:
                if job is not None:
                    job.close()
            stdout, stdout_hash = _summarize_log(stdout_file.name, secret_redactor)
            stderr, stderr_hash = _summarize_log(stderr_file.name, secret_redactor)
        finished_at = datetime.now(UTC)
        if status is TerminalTaskStatus.TIMED_OUT:
            stderr = "execution timed out"
        elif status is TerminalTaskStatus.CANCELLED:
            stderr = "execution cancelled"
        exit_code = process.returncode if process.returncode is not None and status in (
            TerminalTaskStatus.COMPLETED, TerminalTaskStatus.FAILED) else None
        return TerminalResult(
            status=status,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            stdout_hash=stdout_hash,
            stderr_hash=stderr_hash,
            started_at=started_at,
            finished_at=finished_at,
            working_root=str(working_root),
            effects_uncertain=status in UNCERTAIN_STATUSES,
        )

    async def _stream_until_exit(
        self,
        process: subprocess.Popen[bytes],
        on_output: Callable[[str, str], Any] | None,
        tails: dict[str, str],
        offsets: dict[str, int],
        redactors: dict[str, _StreamingRedactor],
        log_paths: dict[str, str],
        timeout: float,
    ) -> TerminalTaskStatus:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        window_started = loop.time()
        window_bytes = {"stdout": 0, "stderr": 0}
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    _terminate_tree(process)
                    await _wait_until_exited(process)
                    return TerminalTaskStatus.TIMED_OUT
                if on_output is not None:
                    for stream in ("stdout", "stderr"):
                        chunk, offsets[stream] = _read_output_delta(
                            log_paths[stream], offsets[stream])
                        if not chunk:
                            continue
                        now = loop.time()
                        if now - window_started >= 1:
                            window_started = now
                            window_bytes[stream] = 0
                        visible = redactors[stream].feed(
                            chunk.decode("utf-8", errors="replace"))
                        available = max(
                            0, self.max_output_rate_bytes - window_bytes[stream])
                        if available and visible:
                            visible = visible[:available]
                            tails[stream] = (tails[stream] + visible)[-MAX_TAIL_CHARS:]
                            await on_output(stream, visible)
                            window_bytes[stream] += len(visible.encode("utf-8"))
                if process.poll() is not None:
                    break
                await asyncio.sleep(min(0.05, max(remaining, 0.0)))
        except asyncio.CancelledError:
            _terminate_tree(process)
            await _wait_until_exited(process)
            return TerminalTaskStatus.CANCELLED
        for stream, redactor in redactors.items():
            tail = redactor.feed("", final=True)
            available = max(0, self.max_output_rate_bytes - window_bytes[stream])
            if tail and available:
                visible = tail[:available]
                tails[stream] = (tails[stream] + visible)[-MAX_TAIL_CHARS:]
                await on_output(stream, visible)
        return (
            TerminalTaskStatus.COMPLETED
            if process.returncode == 0
            else TerminalTaskStatus.FAILED
        )


def _terminate_tree(process: subprocess.Popen[bytes]) -> None:
    if os.name == "nt":
        if process.pid is not None:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                capture_output=True,
                check=False,
            )
        return
    if process.pid is not None:
        import signal

        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError):
            process.kill()


async def _wait_until_exited(process: subprocess.Popen[bytes]) -> None:
    while process.poll() is None:
        await asyncio.sleep(0.01)


def _read_output_delta(path: str, offset: int) -> tuple[bytes, int]:
    if not path:
        return b"", offset
    with open(path, "rb") as output_file:
        output_file.seek(offset)
        chunk = output_file.read()
    return chunk, offset + len(chunk)


def _redact(output: str) -> str:
    return re.sub(
        r"(?i)(api[_-]?key|secret|token|password)(\s*[=:]\s*)[^\s,;]+",
        r"\1\2[REDACTED]",
        output,
    )


def _summarize_log(path: str, secrets: Any) -> tuple[str, str]:
    """Bounded canonical preview plus the full-output content hash."""
    import hashlib

    digest = hashlib.sha256()
    preview = bytearray()
    pending_cr = b""
    with open(path, "rb") as output_file:
        while chunk := output_file.read(64 * 1024):
            # Windows children translate \n to \r\n for redirected streams;
            # canonicalize before hashing so the receipt hash is platform-
            # independent, carrying a split \r across the read boundary.
            chunk = pending_cr + chunk
            pending_cr = b""
            if chunk.endswith(b"\r"):
                pending_cr = b"\r"
                chunk = chunk[:-1]
            canonical = chunk.replace(b"\r\n", b"\n")
            digest.update(canonical)
            if len(preview) < MAX_TAIL_CHARS:
                preview.extend(canonical[: MAX_TAIL_CHARS - len(preview)])
    if pending_cr:
        digest.update(pending_cr)
        if len(preview) < MAX_TAIL_CHARS:
            preview.extend(pending_cr[: MAX_TAIL_CHARS - len(preview)])
    return secrets.redact(
        _redact(bytes(preview).decode("utf-8", errors="replace"))
    ), digest.hexdigest()


class AgentTerminalService:
    """Policy-, tier- and folder-anchored facade around :class:`ShellExecutor`.

    ``classify`` is the workspace classifier (:meth:`WorkspaceFileService.
    classify`); the service refuses any anchor that is not provably
    ``inside`` before it ever reaches consent, in every tier. A runtime wired
    without a classifier has no terminal channel at all - fail closed.
    """

    def __init__(
        self,
        files: LocalFileStore,
        *,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
        executor: ShellExecutor | None = None,
        history: AgentTerminalHistory | None = None,
        classify: Callable[[str], str] | None = None,
    ) -> None:
        self.files = files
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()
        self.executor = executor or ShellExecutor()
        self.history = history
        self.classify = classify

    async def execute(
        self,
        payload: dict[str, object],
        *,
        consent: bool = False,
        on_output: Callable[[str, str], Any] | None = None,
        ledger_binding: dict[str, str] | None = None,
    ) -> TerminalResult | PolicyDecision:
        self._validate_payload(payload)
        command = str(payload["command"])
        anchor = self._anchor_of(payload)
        # The all-tier anchor rule, ahead of any ask: outside the confirmed
        # workspace and protected names are refused without ever asking, so
        # no tier state and no misread prompt can widen the terminal.
        scope = self._classify_anchor(anchor)
        if scope != "inside":
            self._record_refused(ledger_binding, payload, anchor, basis="policy")
            return PolicyDecision.DENY
        digest = request_hash(payload)
        consent_granted = consent or self.consent.consume(TERMINAL_CAPABILITY, digest)
        decision = self.policy.authorize(
            TERMINAL_CAPABILITY, payload, consent=consent_granted
        )
        if decision is not PolicyDecision.ALLOW:
            if decision is PolicyDecision.DENY:
                self._record_refused(ledger_binding, payload, anchor,
                                     basis="policy_denied")
            return decision
        working_root = self.files.resolve(anchor)
        if not working_root.is_dir():
            raise ValueError("working_root must be a directory")
        timeout = float(payload.get("timeout", DEFAULT_TIMEOUT_SECONDS))
        basis = self._basis_of(consent, consent_granted)
        self._admit(ledger_binding, payload, command, anchor, basis)
        # No secrets slot exists on the terminal payload: commands receive no
        # injected environment, so there is nothing to resolve - the always-on
        # output pattern redaction still applies inside the executor.
        secret_values: tuple[str, ...] = ()
        tails = {"stdout": "", "stderr": ""}
        last_tail_write = 0.0

        async def relay(stream: str, text: str) -> None:
            nonlocal last_tail_write
            tails[stream] = (tails[stream] + text)[-MAX_TAIL_CHARS:]
            if on_output is not None:
                await on_output(stream, text)
            now = time.monotonic()
            if self.history is not None and ledger_binding is not None \
                    and now - last_tail_write >= TAIL_UPDATE_INTERVAL_SECONDS:
                last_tail_write = now
                try:
                    self.history.update_output(
                        ledger_binding, str(payload.get("task_id", "")),
                        stdout_tail=tails["stdout"], stderr_tail=tails["stderr"])
                except TerminalHistoryError:
                    pass

        result = await self.executor.run(
            command,
            working_root=working_root,
            timeout=timeout,
            secret_values=secret_values,
            on_output=relay,
        )
        self._complete(ledger_binding, payload, result, basis)
        receipt = LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id=str(payload.get("task_id", "")),
            capability=TERMINAL_CAPABILITY,
            policy_decision=PolicyDecision.ALLOW.value,
            status=result.status.value,
            payload_hash=digest,
            result_hash=content_hash(
                {
                    "status": result.status.value,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                }
            ),
            consent_decision="approved" if consent_granted else None,
            stdout_hash=result.stdout_hash,
            stderr_hash=result.stderr_hash,
            exit_code=result.exit_code,
            started_at=result.started_at,
            finished_at=result.finished_at,
            error_code="RESULT_UNCERTAIN" if result.effects_uncertain else None,
        )
        return TerminalResult(
            status=result.status,
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            stdout_hash=result.stdout_hash,
            stderr_hash=result.stderr_hash,
            started_at=result.started_at,
            finished_at=result.finished_at,
            working_root=anchor,
            effects_uncertain=result.effects_uncertain,
            receipt=receipt,
        )

    def normalize(self, payload: dict[str, object]) -> dict[str, object]:
        """Fill the default anchor so every gate sees the same payload.

        从项目绑定文件夹起步: a payload without ``working_root`` means the
        bound folder's root. The dispatch layer normalizes once, so the
        policy digest, the consent ask, the tier gate's anchor and the
        history row all name the same folder.
        """
        normalized = dict(payload)
        declared = normalized.get("working_root")
        if not isinstance(declared, str) or not declared:
            normalized["working_root"] = self._anchor_of(normalized)
        return normalized

    def _anchor_of(self, payload: dict[str, object]) -> str:
        """The declared working folder, defaulting to the bound folder root.

        从项目绑定文件夹起步: without an explicit anchor the command starts in
        the confirmed workspace's root; a store that cannot prove exactly one
        bound root requires an explicit anchor instead of guessing.
        """
        declared = payload.get("working_root")
        if isinstance(declared, str) and declared:
            return declared
        roots = getattr(self.files, "roots", ())
        if len(roots) == 1:
            return str(roots[0].logical_root)
        raise ValueError("working_root is required")

    def _classify_anchor(self, anchor: str) -> str:
        classify = self.classify
        if classify is None:
            return "outside"
        try:
            scope = classify(anchor)
        except Exception:  # noqa: BLE001 - a classifier failure refuses, never widens
            return "outside"
        return scope if scope in {"inside", "protected", "outside"} else "outside"

    @staticmethod
    def _basis_of(consent: bool, consent_granted: bool) -> str:
        if consent:
            return "consent:allow_once"
        if consent_granted:
            return "consent:stored"
        return "policy"

    def _record_refused(self, binding, payload, anchor, *, basis: str) -> None:
        if self.history is None or binding is None:
            return
        try:
            self.history.record_refused(binding, {
                "thread_id": str(payload.get("thread_id", "")),
                "run_id": str(payload.get("run_id", "")),
                "task_id": str(payload.get("task_id", "")),
                "tool_call_id": str(payload.get("tool_call_id", "")),
                "command": str(payload.get("command", "")),
                "working_root": anchor,
                "authorization_basis": basis,
            })
        except TerminalHistoryError:
            pass

    def _admit(self, binding, payload, command: str, anchor: str, basis: str) -> None:
        if self.history is None or binding is None:
            return
        try:
            self.history.admit(binding, {
                "thread_id": str(payload.get("thread_id", "")),
                "run_id": str(payload.get("run_id", "")),
                "task_id": str(payload.get("task_id", "")),
                "tool_call_id": str(payload.get("tool_call_id", "")),
                "command": command,
                "working_root": anchor,
                "authorization_basis": basis,
                "started_at": _now(),
            })
        except TerminalHistoryError:
            pass

    def _complete(self, binding, payload, result: TerminalResult, basis: str) -> None:
        del basis  # The row's basis is fixed at admit time.
        if self.history is None or binding is None:
            return
        try:
            self.history.complete(
                binding, str(payload.get("task_id", "")),
                status=result.status,
                exit_code=result.exit_code,
                stdout_tail=result.stdout[-MAX_TAIL_CHARS:],
                stderr_tail=result.stderr[-MAX_TAIL_CHARS:],
                stdout_hash=result.stdout_hash,
                stderr_hash=result.stderr_hash,
                finished_at=_now(),
            )
        except TerminalHistoryError:
            pass

    @staticmethod
    def _validate_payload(payload: dict[str, object]) -> None:
        if not isinstance(payload.get("command"), str):
            raise TypeError("command is required")
        if not 0 < len(str(payload["command"])) <= MAX_COMMAND_LENGTH:
            raise ValueError(f"command must be within (0, {MAX_COMMAND_LENGTH}] characters")
        if "\x00" in str(payload["command"]):
            raise ValueError("command must not contain NUL characters")
        working_root = payload.get("working_root")
        if working_root is not None and (not isinstance(working_root, str) or not working_root):
            raise ValueError("working_root must be a non-empty string when present")
        timeout = payload.get("timeout", DEFAULT_TIMEOUT_SECONDS)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise TypeError("timeout must be a number")
        if not 0 < float(timeout) <= MAX_TASK_TIMEOUT_SECONDS:
            raise ValueError(
                f"timeout must be within (0, {MAX_TASK_TIMEOUT_SECONDS:.0f}] seconds"
            )
