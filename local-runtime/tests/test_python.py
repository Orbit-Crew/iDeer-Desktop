from __future__ import annotations

import asyncio
import glob
import hashlib
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

import core.python as core_python
from core.artifacts import (
    ArtifactUploadError,
    FileArtifactUploader,
    MemoryArtifactUploader,
    SingleUseUploadGrant,
)
from core.consent import ConsentStore, request_hash
from core.files import LocalFileStore, RootConfig
from core.policy import LocalPolicy, PolicyDecision
from core.python import (
    LocalPythonService,
    PythonExecutor,
    PythonTaskStatus,
    _StreamingRedactor,
)
from core.secrets import SecretRedactor


def test_python_executor_success_and_bounded_output(tmp_path: Path) -> None:
    result = asyncio.run(
        PythonExecutor(max_output_bytes=16).run(
            "print('hello')", working_root=tmp_path, timeout=30
        )
    )
    assert result.status is PythonTaskStatus.COMPLETED
    assert result.exit_code == 0
    assert result.stdout == "hello\n"


def test_windows_process_options_suspend_the_child_for_job_assignment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Windows branch builds creationflags from attributes subprocess
    actually exports, and keeps the suspended bit so the Job Object owns the
    child before any script runs (regression: CPython never exports
    subprocess.CREATE_SUSPENDED, which used to raise AttributeError there)."""
    captured: dict[str, object] = {}

    class FakeProcess:
        pid = 4242
        _handle = 9999
        returncode = 0

        def poll(self) -> int:
            return 0

    class FakeJob:
        def close(self) -> None:
            pass

    def fake_popen(args: list[str], **kwargs: object) -> FakeProcess:
        captured.update(kwargs)
        return FakeProcess()

    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        core_python, "_WindowsJob", lambda pid, process_handle=None: FakeJob()
    )
    monkeypatch.setattr(core_python, "_resume_initial_thread", lambda pid: None)

    result = asyncio.run(
        PythonExecutor().run("pass", working_root=tmp_path, timeout=30)
    )

    flags = captured["creationflags"]
    assert flags & 0x4  # CREATE_SUSPENDED
    assert flags & 0x200  # CREATE_NEW_PROCESS_GROUP
    assert result.status is PythonTaskStatus.COMPLETED


def test_windows_line_endings_are_canonicalized_in_reported_output(
    tmp_path: Path,
) -> None:
    """Windows children translate \\n to \\r\\n for redirected streams; the
    reported text, streamed chunks, and the receipt hash stay platform-
    canonical while a lone \\r (e.g. a progress bar) survives."""
    log = tmp_path / "out.log"
    log.write_bytes(b"progress\r100%\r\ndone\r\n")
    text, digest = PythonExecutor()._summarize_log(str(log), SecretRedactor(()))
    assert text == "progress\r100%\ndone\n"
    assert digest == hashlib.sha256(b"progress\r100%\ndone\n").hexdigest()


def test_streaming_redactor_joins_line_endings_split_across_chunks() -> None:
    redactor = _StreamingRedactor(SecretRedactor(()))
    assert redactor.feed("hello\r") + redactor.feed("\n", final=True) == "hello\n"
    assert redactor.feed("abc\r\n", final=True) == "abc\n"
    assert redactor.feed("abc\r", final=True) == "abc\r"


def test_python_executor_timeout(tmp_path: Path) -> None:
    result = asyncio.run(
        PythonExecutor().run(
            "import time; time.sleep(10)", working_root=tmp_path, timeout=0.05
        )
    )
    assert result.status is PythonTaskStatus.TIMED_OUT


def test_python_executor_removes_output_log_temp_files_after_the_task(
    tmp_path: Path,
) -> None:
    """05-H2: subprocess stdout/stderr temp logs must not outlive the task."""
    observed_during_run: list[str] = []

    def _snapshot_temp_logs() -> None:
        observed_during_run.extend(
            path
            for path in glob.glob(os.path.join(tempfile.gettempdir(), "local-python-*"))
            if path not in observed_during_run
        )

    async def on_output(_stream: str, _chunk: str) -> None:
        _snapshot_temp_logs()

    result = asyncio.run(
        PythonExecutor().run(
            "print('hello')", working_root=tmp_path, on_output=on_output
        )
    )

    assert result.stdout_log_path is not None
    assert result.stderr_log_path is not None
    # The logs lived on disk while the subprocess ran (streaming and hashing
    # read them back by name), so the recorded path is the executor's temp file.
    assert result.stdout_log_path in observed_during_run
    assert not Path(result.stdout_log_path).exists()
    assert not Path(result.stderr_log_path).exists()


def test_python_executor_timeout_removes_output_log_temp_files(
    tmp_path: Path,
) -> None:
    result = asyncio.run(
        PythonExecutor().run(
            "import time; time.sleep(10)", working_root=tmp_path, timeout=0.05
        )
    )

    assert result.status is PythonTaskStatus.TIMED_OUT
    assert result.stdout_log_path is not None
    assert not Path(result.stdout_log_path).exists()
    assert result.stderr_log_path is not None
    assert not Path(result.stderr_log_path).exists()


def test_python_executor_nonzero_exit_is_failed_with_exit_code(tmp_path: Path) -> None:
    result = asyncio.run(
        PythonExecutor().run(
            "import sys; print('bad', file=sys.stderr); sys.exit(3)",
            working_root=tmp_path,
            timeout=30,
        )
    )

    assert result.status is PythonTaskStatus.FAILED
    assert result.exit_code == 3
    assert result.stderr == "bad\n"


def test_python_executor_bounds_output_without_retaining_the_full_stream(
    tmp_path: Path,
) -> None:
    result = asyncio.run(
        PythonExecutor(max_output_bytes=32).run(
            "print('x' * 1000000)", working_root=tmp_path, timeout=30
        )
    )

    assert len(result.stdout.encode()) <= 32
    assert (
        result.stdout_hash
        == hashlib.sha256(("x" * 1000000 + "\n").encode()).hexdigest()
    )


def test_local_python_requires_hash_bound_consent_and_returns_receipt(
    tmp_path: Path,
) -> None:
    payload = {
        "working_root": "/projects",
        "runtime": "python",
        "script": "print('hello')",
        "args": [],
        "expected_outputs": [],
        "environment": [],
    }
    consent = ConsentStore()
    service = LocalPythonService(
        LocalFileStore([RootConfig("/projects", tmp_path)]), consent=consent
    )

    async def run_with_consent():
        assert await service.execute(payload) is PolicyDecision.CONSENT_REQUIRED
        consent.approve("local.python", request_hash(payload), actor_id="alice")
        return await service.execute(payload)

    result = asyncio.run(run_with_consent())

    assert result.status is PythonTaskStatus.COMPLETED
    assert result.receipt is not None
    assert result.receipt.request_hash == request_hash(payload)
    assert result.receipt.consent_decision == "approved"
    assert result.receipt.stdout_hash == result.stdout_hash
    assert result.receipt.exit_code == 0
    assert result.receipt.started_at is not None
    assert result.receipt.finished_at is not None
    assert result.receipt.stdout_log_path is not None
    assert result.receipt.stderr_log_path is not None
    # The executor removes its temp logs when the task ends (05-H2); the
    # receipt keeps the paths only as a record, and cleanup stays a safe
    # no-op afterwards.
    assert not Path(result.receipt.stdout_log_path).exists()
    assert not Path(result.receipt.stderr_log_path).exists()
    result.receipt.cleanup_local_logs()
    assert not Path(result.receipt.stdout_log_path).exists()
    assert not Path(result.receipt.stderr_log_path).exists()


def test_local_python_uploads_only_explicit_expected_outputs(tmp_path: Path) -> None:
    payload = {
        "working_root": "/projects",
        "script": "open('result.txt', 'w').write('artifact')",
        "expected_outputs": ["/projects/result.txt"],
        "environment": [],
        "timeout": 60,
    }
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    uploader = MemoryArtifactUploader()
    service = LocalPythonService(
        LocalFileStore([RootConfig("/projects", tmp_path)]),
        consent=consent,
        uploader=uploader,
    )

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.COMPLETED
    assert result.artifact_refs == (
        "local://" + hashlib.sha256(b"artifact").hexdigest() + "/result.txt",
    )
    assert list(uploader.items.values()) == [b"artifact"]


def test_file_artifact_uploader_is_durable_idempotent_and_bounded(
    tmp_path: Path,
) -> None:
    uploader = FileArtifactUploader(tmp_path / "artifacts", max_bytes=4)
    assert uploader.upload("result.txt", b"data").startswith("local://")
    assert uploader.upload("result.txt", b"data") == uploader.upload(
        "result.txt", b"data"
    )
    with pytest.raises(ArtifactUploadError):
        uploader.upload("result.txt", b"too large")
    with pytest.raises(ArtifactUploadError):
        uploader.upload("../escape.txt", b"x")


def test_upload_grant_is_bound_to_run_task_thread_and_single_use() -> None:
    grant = SingleUseUploadGrant("run", "task", "thread", "result.txt")
    assert grant.consume(
        run_id="run", task_id="task", thread_id="thread", name="result.txt"
    )
    with pytest.raises(ArtifactUploadError):
        grant.consume(
            run_id="run", task_id="task", thread_id="thread", name="result.txt"
        )


def test_local_python_accepts_environment_references_but_not_plaintext(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOCAL_RUNTIME_TEST_VALUE", "visible")
    files = LocalFileStore([RootConfig("/projects", tmp_path)])
    service = LocalPythonService(
        files, environment={"LOCAL_RUNTIME_TEST_VALUE": "visible"}
    )
    payload = {
        "working_root": "/projects",
        "script": "import os; print(os.environ['LOCAL_RUNTIME_TEST_VALUE'])",
        "environment": ["LOCAL_RUNTIME_TEST_VALUE"],
    }
    service.consent.approve("local.python", request_hash(payload))

    result = asyncio.run(service.execute(payload))

    assert result.stdout == "visible\n"
    with pytest.raises(ValueError, match="environment references"):
        asyncio.run(
            service.execute(
                {**payload, "environment": {"TOKEN": "plaintext"}}, consent=True
            )
        )


def test_local_python_reports_upload_policy_rejection(tmp_path: Path) -> None:
    payload = {
        "working_root": "/projects",
        "script": "open('result.txt', 'w').write('artifact')",
        "expected_outputs": ["/projects/result.txt"],
        "environment": [],
    }
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    service = LocalPythonService(
        LocalFileStore([RootConfig("/projects", tmp_path)]),
        policy=LocalPolicy(denied_capabilities=frozenset({"local.artifacts.upload"})),
        consent=consent,
        uploader=MemoryArtifactUploader(),
    )

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.UPLOAD_DENIED
    assert result.artifact_error == "artifact upload denied by local policy"
    assert result.receipt is not None
    assert result.receipt.status == "upload_denied"


def test_python_executor_cancellation_returns_cancelled(tmp_path: Path) -> None:
    async def run_and_cancel() -> None:
        task = asyncio.create_task(
            PythonExecutor().run(
                "import time; time.sleep(30)", working_root=tmp_path, timeout=30
            )
        )
        await asyncio.sleep(0.1)
        task.cancel()
        result = await task
        assert result.status is PythonTaskStatus.CANCELLED

    asyncio.run(run_and_cancel())


def test_python_executor_cancellation_cleans_up_child_processes(
    tmp_path: Path,
) -> None:
    async def run_and_cancel() -> None:
        task = asyncio.create_task(
            PythonExecutor().run(
                """
import subprocess
import sys
import time

subprocess.Popen([
    sys.executable,
    '-c',
    "import pathlib, time; time.sleep(0.3); pathlib.Path('child-alive').write_text('leaked')",
])
time.sleep(30)
""",
                working_root=tmp_path,
                timeout=30,
            )
        )
        await asyncio.sleep(0.1)
        task.cancel()
        result = await task
        assert result.status is PythonTaskStatus.CANCELLED

    asyncio.run(run_and_cancel())
    assert not (tmp_path / "child-alive").exists()


def test_python_executor_streams_rate_limited_redacted_output(
    tmp_path: Path,
) -> None:
    async def run_with_output() -> list[tuple[str, str]]:
        events: list[tuple[str, str]] = []

        async def on_output(stream: str, chunk: str) -> None:
            events.append((stream, chunk))

        result = await PythonExecutor(max_output_rate_bytes=1024).run(
            "print('API_KEY=super-secret')",
            working_root=tmp_path,
            on_output=on_output,
        )

        assert result.stdout == "API_KEY=[REDACTED]\n"
        assert events == [("stdout", "API_KEY=[REDACTED]\n")]
        return events

    asyncio.run(run_with_output())


def test_python_executor_limits_streamed_output_rate(tmp_path: Path) -> None:
    async def run_with_output() -> int:
        emitted = 0

        async def on_output(_stream: str, chunk: str) -> None:
            nonlocal emitted
            emitted += len(chunk.encode())

        await PythonExecutor(max_output_rate_bytes=128).run(
            "print('x' * 4096)",
            working_root=tmp_path,
            on_output=on_output,
        )
        return emitted

    assert asyncio.run(run_with_output()) <= 128


def test_python_executor_redacts_sensitive_value_split_across_chunks(
    tmp_path: Path,
) -> None:
    async def run_with_output() -> str:
        chunks: list[str] = []

        async def on_output(_stream: str, chunk: str) -> None:
            chunks.append(chunk)

        await PythonExecutor().run(
            "import sys; sys.stdout.write('API_KEY=sec'); sys.stdout.flush(); sys.stdout.write('ret-value\\n'); sys.stdout.flush()",
            working_root=tmp_path,
            on_output=on_output,
        )
        return "".join(chunks)

    output = asyncio.run(run_with_output())
    assert "secret-value" not in output
    assert "API_KEY=[REDACTED]" in output


def test_local_python_rejects_timeout_outside_allowed_range() -> None:
    """05-M3: the payload timeout is bounded, not broker-controlled."""
    service = LocalPythonService(LocalFileStore([RootConfig("/projects", Path("."))]))
    base = {
        "working_root": "/projects",
        "script": "print('hello')",
        "environment": [],
    }
    with pytest.raises(ValueError, match="timeout"):
        asyncio.run(service.execute({**base, "timeout": 601}))
    with pytest.raises(ValueError, match="timeout"):
        asyncio.run(service.execute({**base, "timeout": 0}))
    with pytest.raises(ValueError, match="timeout"):
        asyncio.run(service.execute({**base, "timeout": -5}))
    with pytest.raises(TypeError, match="timeout"):
        asyncio.run(service.execute({**base, "timeout": "30"}))


def test_local_python_rejects_oversized_expected_output_before_reading(
    tmp_path: Path,
) -> None:
    """05-M4: size is checked before the whole file is read into memory."""
    payload = {
        "working_root": "/projects",
        "script": "open('big.bin', 'wb').write(b'x' * 8)",
        "expected_outputs": ["/projects/big.bin"],
        "environment": [],
        "timeout": 30,
    }
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    uploader = MemoryArtifactUploader(max_bytes=4)
    files = LocalFileStore([RootConfig("/projects", tmp_path)])
    service = LocalPythonService(files, consent=consent, uploader=uploader)

    def refuse_read(logical_path: str) -> bytes:
        raise AssertionError("read_bytes must not run past the size check")

    files.read_bytes = refuse_read  # type: ignore[method-assign]

    with pytest.raises(ArtifactUploadError, match="size limit"):
        asyncio.run(service.execute(payload))
    assert uploader.items == {}
