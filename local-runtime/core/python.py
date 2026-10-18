"""Constrained local Python execution with bounded output and cancellation."""

from __future__ import annotations

import asyncio
import ctypes
import hashlib
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Awaitable, Callable, Mapping
from contextlib import ExitStack
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

from .artifacts import ArtifactUploadError, ArtifactUploader
from .compat import UTC, StrEnum
from .consent import ConsentStore, request_hash
from .files import LocalFileStore
from .policy import LocalPolicy, PolicyDecision
from .receipts import LocalExecutionReceipt, content_hash
from .secrets import (
    SECRET_REF_PREFIX,
    ResolvedSecrets,
    SecretBackendUnavailable,
    SecretRedactor,
    SecretResolver,
    is_secret_ref,
)


# Windows creationflags for the constrained child: start in a new process
# group (0x200) and suspended (0x4). subprocess exports the former only on
# Windows and has never exported the latter, so both are pinned here like the
# other raw Windows constants in this package.
_CREATE_NEW_PROCESS_GROUP = 0x200
_CREATE_SUSPENDED = 0x4

# Upper bound for the broker-supplied task timeout (05-M3): without it a
# single payload could hold an execution slot for as long as the payload
# asks. Direct PythonExecutor callers keep full control of their own value.
MAX_TASK_TIMEOUT_SECONDS = 600.0


class _WindowsBasicLimit(ctypes.Structure):
    _fields_ = [
        ("per_process_user_time", ctypes.c_ulonglong),
        ("per_job_user_time", ctypes.c_ulonglong),
        ("limit_flags", ctypes.c_uint32),
        ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t),
        ("active_process_limit", ctypes.c_uint32),
        ("affinity", ctypes.c_size_t),
        ("priority", ctypes.c_uint32),
        ("scheduling_class", ctypes.c_uint32),
    ]


class _WindowsIoCounters(ctypes.Structure):
    _fields_ = [("values", ctypes.c_ulonglong * 6)]


class _WindowsExtendedLimit(ctypes.Structure):
    """ABI-compatible JOBOBJECT_EXTENDED_LIMIT_INFORMATION."""

    _fields_ = [
        ("basic", _WindowsBasicLimit),
        ("io", _WindowsIoCounters),
        ("process_memory", ctypes.c_size_t),
        ("job_memory", ctypes.c_size_t),
        ("peak_process_memory_used", ctypes.c_size_t),
        ("peak_job_memory_used", ctypes.c_size_t),
    ]


class _WindowsJob:
    """Job Object that makes descendant cleanup a kernel-enforced property."""

    def __init__(self, pid: int, *, process_handle: int | None = None) -> None:
        if os.name != "nt":
            raise RuntimeError("Windows Job Objects are unavailable")
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel32 = kernel32
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        self._handle = kernel32.CreateJobObjectW(None, None)
        if not self._handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        try:
            limits = _WindowsExtendedLimit()
            # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000),
            # JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9.
            limits.basic.limit_flags = 0x2000
            if not kernel32.SetInformationJobObject(
                self._handle,
                9,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
            owned_process_handle = process_handle is None
            process_handle = process_handle or kernel32.OpenProcess(
                0x0001 | 0x0040 | 0x1000,  # terminate, set quota, query limited info
                0,
                pid,
            )
            if not process_handle:
                raise OSError(ctypes.get_last_error(), "OpenProcess failed")
            if not kernel32.AssignProcessToJobObject(self._handle, process_handle):
                raise OSError(
                    ctypes.get_last_error(), "AssignProcessToJobObject failed"
                )
            if owned_process_handle:
                kernel32.CloseHandle(process_handle)
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        if getattr(self, "_handle", None):
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


class _WindowsThreadEntry(ctypes.Structure):
    """ABI-compatible THREADENTRY32."""

    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ThreadID", ctypes.c_uint32),
        ("th32OwnerProcessID", ctypes.c_uint32),
        ("tpBasePri", ctypes.c_long),
        ("tpDeltaPri", ctypes.c_long),
        ("dwFlags", ctypes.c_uint32),
    ]


def _resume_initial_thread(pid: int) -> None:
    """Resume the main thread that Popen left suspended on Windows.

    ResumeThread needs a thread handle, which :class:`subprocess.Popen` does
    not expose, so the initial thread is found through the tool-help snapshot:
    a process created with CREATE_SUSPENDED still has exactly one thread, and
    a suspended main thread cannot have spawned any more.
    """
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.Thread32First.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WindowsThreadEntry),
    ]
    kernel32.Thread32First.restype = ctypes.c_int
    kernel32.Thread32Next.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WindowsThreadEntry),
    ]
    kernel32.Thread32Next.restype = ctypes.c_int
    kernel32.OpenThread.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenThread.restype = ctypes.c_void_p
    kernel32.ResumeThread.argtypes = [ctypes.c_void_p]
    kernel32.ResumeThread.restype = ctypes.c_uint32
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    # TH32CS_SNAPTHREAD = 0x4; THREAD_SUSPEND_RESUME = 0x0002.
    snapshot = kernel32.CreateToolhelp32Snapshot(0x4, 0)
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
    try:
        entry = _WindowsThreadEntry()
        entry.dwSize = ctypes.sizeof(_WindowsThreadEntry)
        found = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == pid:
                thread = kernel32.OpenThread(0x0002, 0, entry.th32ThreadID)
                if not thread:
                    raise OSError(ctypes.get_last_error(), "OpenThread failed")
                try:
                    if kernel32.ResumeThread(thread) == 0xFFFFFFFF:
                        raise OSError(ctypes.get_last_error(), "ResumeThread failed")
                finally:
                    kernel32.CloseHandle(thread)
                return
            found = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    raise OSError("suspended main thread not found")


class PythonTaskStatus(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"
    UPLOAD_DENIED = "upload_denied"


@dataclass(frozen=True)
class PythonResult:
    status: PythonTaskStatus
    exit_code: int | None
    stdout: str
    stderr: str
    artifact_refs: tuple[str, ...] = ()
    stdout_hash: str | None = None
    stderr_hash: str | None = None
    stdout_log_path: str | None = None
    stderr_log_path: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    runtime_version: str | None = None
    receipt: LocalExecutionReceipt | None = None
    artifact_error: str | None = None


class _StreamingRedactor:
    """Redact credentials without exposing values split across output chunks."""

    _pattern = re.compile(
        r"(?i)(api[_-]?key|secret|token|password)(\s*[=:]\s*)[^\s,;]+"
    )

    def __init__(self, secrets: SecretRedactor) -> None:
        self._secrets = secrets
        self._holdback = max(128, secrets.longest)
        self._pending = ""

    def feed(self, text: str, *, final: bool = False) -> str:
        self._pending += text
        # Windows children translate \n to \r\n for redirected streams; the
        # held-back tail means a \r\n split across two chunks still joins.
        self._pending = self._pending.replace("\r\n", "\n")
        redacted = self._secrets.redact(
            self._pattern.sub(r"\1\2[REDACTED]", self._pending)
        )
        if final:
            self._pending = ""
            return redacted
        keep = min(self._holdback, len(redacted))
        emitted, self._pending = redacted[:-keep], redacted[-keep:]
        return emitted


class LocalPythonService:
    """Policy and root-gated facade around :class:`PythonExecutor`."""

    def __init__(
        self,
        files: LocalFileStore,
        *,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
        uploader: ArtifactUploader | None = None,
        executor: PythonExecutor | None = None,
        environment: Mapping[str, str] | None = None,
        secrets: SecretResolver | None = None,
    ) -> None:
        self.files = files
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()
        self.uploader = uploader
        self.executor = executor or PythonExecutor()
        self.environment = dict(environment or {})
        self.secrets = secrets

    async def execute(
        self,
        payload: dict[str, object],
        *,
        consent: bool = False,
        on_output: Callable[[str, str], Awaitable[None]] | None = None,
    ) -> PythonResult | PolicyDecision:
        self._validate_payload(payload)
        digest = request_hash(payload)
        consent_granted = consent or self.consent.consume("local.python", digest)
        decision = self.policy.authorize(
            "local.python",
            payload,
            consent=consent_granted,
        )
        if decision is not PolicyDecision.ALLOW:
            return decision
        resolved_secrets = self._resolve_payload_secrets(payload)
        environment_names = [str(name) for name in payload.get("environment", [])]
        safe_environment_names = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}
        unavailable = {
            name
            for name in environment_names
            if name not in self.environment and name not in safe_environment_names
        }
        if unavailable:
            raise ValueError("environment reference is unavailable")
        working_root = self.files.resolve(str(payload["working_root"]))
        environment = {
            name: self.environment[name]
            for name in payload.get("environment", [])
            if name in self.environment
        }
        if resolved_secrets is not None:
            environment = {**environment, **resolved_secrets.environment}
        result = await self.executor.run(
            str(payload["script"]),
            working_root=working_root,
            args=[str(arg) for arg in payload.get("args", [])],
            timeout=float(payload.get("timeout", 30)),
            environment=environment,
            secret_values=(
                tuple(resolved_secrets.environment.values())
                if resolved_secrets is not None
                else ()
            ),
            on_output=on_output,
        )
        artifact_error: str | None = None
        if result.status is PythonTaskStatus.COMPLETED and payload.get(
            "expected_outputs"
        ):
            upload_decision = self.policy.authorize(
                "local.artifacts.upload", payload, consent=consent_granted
            )
            if upload_decision is not PolicyDecision.ALLOW:
                artifact_error = "artifact upload denied by local policy"
                result = replace(result, status=PythonTaskStatus.UPLOAD_DENIED)
            elif self.uploader is None:
                artifact_error = "artifact uploader is unavailable"
                result = replace(result, status=PythonTaskStatus.UPLOAD_DENIED)
        if (
            result.status is PythonTaskStatus.COMPLETED
            and self.uploader is not None
            and payload.get("expected_outputs")
        ):
            refs = []
            for logical_path in payload.get("expected_outputs", []):
                path = self.files.resolve(str(logical_path))
                # 05-M4: check the size before reading the whole file into
                # memory; the uploader's own limit only fires after the read.
                max_bytes = getattr(self.uploader, "max_bytes", None)
                if max_bytes is not None and path.stat().st_size > max_bytes:
                    raise ArtifactUploadError("artifact exceeds configured size limit")
                refs.append(
                    self.uploader.upload(
                        path.name, self.files.read_bytes(str(logical_path))
                    )
                )
            result = replace(result, artifact_refs=tuple(refs))
        receipt = LocalExecutionReceipt(
            run_id=str(payload.get("run_id", "")),
            task_id=str(payload.get("task_id", "")),
            capability="local.python",
            policy_decision=PolicyDecision.ALLOW.value,
            status=(artifact_error and "upload_denied") or result.status.value,
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
            stdout_log_path=result.stdout_log_path,
            stderr_log_path=result.stderr_log_path,
            artifact_refs=result.artifact_refs,
            runtime_version=result.runtime_version,
            exit_code=result.exit_code,
            started_at=result.started_at,
            finished_at=result.finished_at,
        )
        return replace(result, receipt=receipt, artifact_error=artifact_error)

    def _resolve_payload_secrets(
        self, payload: dict[str, object]
    ) -> ResolvedSecrets | None:
        """Resolve the payload's `local:` references or fail the task loudly.

        Literal values in the secrets slot are rejected so plaintext can never
        enter the process environment or any protocol field by that route.
        """
        secrets_field = payload.get("secrets", {})
        if not secrets_field:
            return None
        if self.secrets is None:
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE",
                "no local secret store is configured on this runtime",
            )
        return self.secrets.resolve_environment(dict(secrets_field))

    @staticmethod
    def _validate_payload(payload: dict[str, object]) -> None:
        if not isinstance(payload.get("working_root"), str):
            raise TypeError("working_root is required")
        if not isinstance(payload.get("script"), str):
            raise TypeError("script is required")
        # The payload's "runtime" field is a compatibility filter, not a
        # selector: execution is always pinned to this runtime's own
        # interpreter (sys.executable), so an unknown value is rejected
        # early, and any accepted value runs the same binary (05-L7).
        if payload.get("runtime", "python") not in {"python", "python3"}:
            raise ValueError("unsupported Python runtime")
        # 05-M3: the broker-chosen timeout is bounded and must be a positive
        # number; a stale or hostile payload cannot pin an execution slot.
        timeout = payload.get("timeout", 30)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise TypeError("timeout must be a number")
        if not 0 < float(timeout) <= MAX_TASK_TIMEOUT_SECONDS:
            raise ValueError(
                f"timeout must be within (0, {MAX_TASK_TIMEOUT_SECONDS:.0f}] seconds"
            )
        for field in ("args", "expected_outputs"):
            value = payload.get(field, [])
            if not isinstance(value, list) or any(
                not isinstance(item, str) for item in value
            ):
                raise ValueError(f"{field} must be a list of strings")
        environment = payload.get("environment", [])
        if not isinstance(environment, list) or any(
            not isinstance(name, str) for name in environment
        ):
            raise ValueError("environment references must be a list of names")
        secrets_field = payload.get("secrets", {})
        if not isinstance(secrets_field, dict) or any(
            not isinstance(name, str) or not isinstance(ref, str)
            for name, ref in secrets_field.items()
        ):
            raise ValueError(
                f"secrets must map environment names to {SECRET_REF_PREFIX} references"
            )
        for name, ref in secrets_field.items():
            if not name or "=" in name or "\x00" in name:
                raise ValueError("secret environment names must be valid names")
            if not is_secret_ref(ref):
                raise ValueError(
                    f"secret values must use {SECRET_REF_PREFIX} references"
                )


class PythonExecutor:
    def __init__(
        self,
        *,
        max_output_bytes: int = 64 * 1024,
        max_output_rate_bytes: int = 64 * 1024,
    ) -> None:
        self.max_output_bytes = max_output_bytes
        self.max_output_rate_bytes = max_output_rate_bytes

    async def run(
        self,
        script: str,
        *,
        working_root: Path,
        args: list[str] | None = None,
        timeout: float = 30,
        environment: Mapping[str, str] | None = None,
        secret_values: tuple[str, ...] = (),
        on_output: Callable[[str, str], Awaitable[None]] | None = None,
    ) -> PythonResult:
        if not working_root.is_dir():
            raise ValueError("working_root must be a directory")
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}
        }
        for name, value in (environment or {}).items():
            if not name or "=" in name or "\x00" in name or "\x00" in value:
                raise ValueError("environment references must be valid names")
            env[name] = value
        process_options = {
            "cwd": working_root,
            "env": env,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
        }
        if os.name == "nt":
            # Keep the child suspended until the Job Object owns it; this closes
            # the window in which a script could create an unmanaged descendant.
            process_options["creationflags"] = (
                _CREATE_NEW_PROCESS_GROUP | _CREATE_SUSPENDED
            )
        else:
            process_options["start_new_session"] = True
        secret_redactor = SecretRedactor(secret_values)
        started_at = datetime.now(UTC)
        with ExitStack() as stack:
            # The temp logs must outlive only this task. Registered before the
            # file contexts so LIFO unwinding runs the unlink after the handles
            # close (Windows cannot delete an open file); missing_ok covers a
            # setup failure before either file existed. Without this, every
            # task leaks two files of unredacted subprocess output: the
            # streaming reads and _summarize_log below are their last readers,
            # and receipt.as_dict() never exposes the paths.
            log_temp_names: list[str] = []

            def _remove_log_temp_files() -> None:
                for name in log_temp_names:
                    Path(name).unlink(missing_ok=True)

            stack.callback(_remove_log_temp_files)
            stdout_file = stack.enter_context(
                tempfile.NamedTemporaryFile(
                    mode="w+b", prefix="local-python-stdout-", delete=False
                )
            )
            log_temp_names.append(stdout_file.name)
            stderr_file = stack.enter_context(
                tempfile.NamedTemporaryFile(
                    mode="w+b", prefix="local-python-stderr-", delete=False
                )
            )
            log_temp_names.append(stderr_file.name)
            process_options["stdout"] = stdout_file
            process_options["stderr"] = stderr_file
            process = subprocess.Popen(  # noqa: ASYNC220
                [sys.executable, "-I", "-c", script, *(args or [])],
                **process_options,
            )
            job = None
            if os.name == "nt":
                try:
                    job = _WindowsJob(process.pid, process_handle=process._handle)
                    _resume_initial_thread(process.pid)
                except Exception:  # noqa: BLE001 - any setup failure must clean up
                    self._terminate(process)
                    await self._wait_until_exited(process)
                    raise RuntimeError("reliable Windows process cleanup unavailable")
            try:
                deadline = asyncio.get_running_loop().time() + timeout
                output_offsets = {"stdout": 0, "stderr": 0}
                redactors = {
                    "stdout": _StreamingRedactor(secret_redactor),
                    "stderr": _StreamingRedactor(secret_redactor),
                }
                output_window_started = asyncio.get_running_loop().time()
                output_window_bytes = {"stdout": 0, "stderr": 0}
                while True:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise TimeoutError
                    if on_output is not None:
                        for stream, output_file in (
                            ("stdout", stdout_file),
                            ("stderr", stderr_file),
                        ):
                            chunk, output_offsets[stream] = self._read_output_delta(
                                output_file.name, output_offsets[stream]
                            )
                            if not chunk:
                                continue
                            now = asyncio.get_running_loop().time()
                            if now - output_window_started >= 1:
                                output_window_started = now
                                output_window_bytes = {"stdout": 0, "stderr": 0}
                            available = max(
                                0,
                                self.max_output_rate_bytes
                                - output_window_bytes[stream],
                            )
                            visible = redactors[stream].feed(
                                chunk.decode("utf-8", errors="replace")
                            )
                            if available and visible:
                                visible = visible[:available]
                                await on_output(stream, visible)
                                output_window_bytes[stream] += len(
                                    visible.encode("utf-8")
                                )
                    if process.poll() is not None:
                        break
                    await asyncio.sleep(min(0.05, remaining))
                status = (
                    PythonTaskStatus.COMPLETED
                    if process.returncode == 0
                    else PythonTaskStatus.FAILED
                )
            except TimeoutError:
                if job is not None:
                    job.close()
                else:
                    self._terminate(process)
                await self._wait_until_exited(process)
                status = PythonTaskStatus.TIMED_OUT
            except asyncio.CancelledError:
                if job is not None:
                    job.close()
                else:
                    self._terminate(process)
                await self._wait_until_exited(process)
                status = PythonTaskStatus.CANCELLED
            if on_output is not None:
                for stream, redactor in redactors.items():
                    tail = redactor.feed("", final=True)
                    available = max(
                        0, self.max_output_rate_bytes - output_window_bytes[stream]
                    )
                    if tail and available:
                        visible = tail[:available]
                        await on_output(stream, visible)
                        output_window_bytes[stream] += len(visible.encode("utf-8"))
            stdout, stdout_hash = self._summarize_log(stdout_file.name, secret_redactor)
            stderr, stderr_hash = self._summarize_log(stderr_file.name, secret_redactor)
            if job is not None:
                job.close()
        finished_at = datetime.now(UTC)
        if status is PythonTaskStatus.TIMED_OUT:
            stderr = "execution timed out"
        elif status is PythonTaskStatus.CANCELLED:
            stderr = "execution cancelled"
        return PythonResult(
            status,
            process.returncode
            if status not in {PythonTaskStatus.TIMED_OUT, PythonTaskStatus.CANCELLED}
            else None,
            stdout,
            stderr,
            stdout_hash=stdout_hash,
            stderr_hash=stderr_hash,
            stdout_log_path=stdout_file.name,
            stderr_log_path=stderr_file.name,
            started_at=started_at,
            finished_at=finished_at,
            runtime_version=sys.version.split()[0],
        )

    @staticmethod
    def _terminate(process: subprocess.Popen[bytes]) -> None:
        if os.name != "nt" and process.pid is not None:
            try:
                os.killpg(process.pid, 9)
                return
            except ProcessLookupError:
                return
        if os.name == "nt" and process.pid is not None:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                capture_output=True,
                check=False,
            )
            return
        process.kill()

    @staticmethod
    async def _wait_until_exited(process: subprocess.Popen[bytes]) -> None:
        while process.poll() is None:
            await asyncio.sleep(0.01)

    @staticmethod
    def _read_output_delta(path: str, offset: int) -> tuple[bytes, int]:
        with open(path, "rb") as output_file:
            output_file.seek(offset)
            chunk = output_file.read()
        return chunk, offset + len(chunk)

    @staticmethod
    def _redact(output: str) -> str:
        return re.sub(
            r"(?i)(api[_-]?key|secret|token|password)(\s*[=:]\s*)[^\s,;]+",
            r"\1\2[REDACTED]",
            output,
        )

    def _summarize_log(self, path: str, secrets: SecretRedactor) -> tuple[str, str]:
        digest = hashlib.sha256()
        preview = bytearray()
        pending_cr = b""
        with open(path, "rb") as output_file:
            while chunk := output_file.read(64 * 1024):
                # Windows children translate \n to \r\n for redirected
                # stdout/stderr; canonicalize before hashing so the receipt
                # hash is platform-independent. A \r is carried across the
                # read boundary when the \r\n pair straddles it, and a lone
                # \r (e.g. a progress bar) is left untouched.
                chunk = pending_cr + chunk
                pending_cr = b""
                if chunk.endswith(b"\r"):
                    pending_cr = b"\r"
                    chunk = chunk[:-1]
                canonical = chunk.replace(b"\r\n", b"\n")
                digest.update(canonical)
                if len(preview) < self.max_output_bytes:
                    preview.extend(canonical[: self.max_output_bytes - len(preview)])
        if pending_cr:
            digest.update(pending_cr)
            if len(preview) < self.max_output_bytes:
                preview.extend(pending_cr[: self.max_output_bytes - len(preview)])
        return secrets.redact(
            self._redact(bytes(preview).decode("utf-8", errors="replace"))
        ), digest.hexdigest()
