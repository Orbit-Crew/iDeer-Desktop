"""Inline controlled code execution (#105): the model's code runs as a
session temp script inside the authorized folder.

The wire contract for ``local.python`` tasks stays unchanged: the payload
still names a ``working_root`` inside the allowed roots and carries the
script bytes. What changes is where those bytes live while they run - the
runtime materializes them as a file under ``<root>/.ideer/inline/<thread>/``
(executed from disk, never through ``-c``), the execution picks the pinned
interpreter the payload's ``runtime`` field names (the bundled Python, or
the app's own Node when the Desktop passed one at spawn), and the scratch
directory is swept when the session ends. Denied or refused asks write
nothing.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from importlib import import_module
from pathlib import Path

import pytest

from core.files import FileAccessError, LocalFileStore, RootConfig
from core.policy import PolicyDecision
from core.python import LocalPythonService, PythonResult, PythonTaskStatus

from core.consent import ConsentStore, request_hash

inline_code = import_module("core.inline_code")
InlineScriptStore = inline_code.InlineScriptStore


# ---------------------------------------------------------------------------
# Recording executor: the service seam under test.
# ---------------------------------------------------------------------------


class RecordingExecutor:
    def __init__(self, result: PythonResult | None = None) -> None:
        self.calls: list[dict] = []
        self._result = result

    async def run(self, script: str, **kwargs):
        self.calls.append({"script": script, **kwargs})
        if self._result is not None:
            return self._result
        return PythonResult(
            status=PythonTaskStatus.COMPLETED, exit_code=0, stdout="", stderr=""
        )


def _store(tmp_path: Path) -> LocalFileStore:
    return LocalFileStore([RootConfig("/projects", tmp_path)])


def _payload(**overrides) -> dict:
    payload = {
        "working_root": "/projects",
        "script": "print('inline')",
        "thread_id": "thread-A",
        "run_id": "run-1",
        "environment": [],
    }
    payload.update(overrides)
    return payload


def _approved_service(
    tmp_path: Path, payload: dict, *, executor=None, node_executable=None
) -> LocalPythonService:
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    service = LocalPythonService(
        _store(tmp_path),
        consent=consent,
        executor=executor or RecordingExecutor(),
        node_executable=node_executable,
    )
    return service


# ---------------------------------------------------------------------------
# The scratch store: session temp scripts inside the authorized folder.
# ---------------------------------------------------------------------------


def test_materialize_writes_the_session_script_under_the_workspace(tmp_path: Path) -> None:
    store = InlineScriptStore(_store(tmp_path))
    logical, physical = store.materialize(
        thread_id="thread-A", run_id="run-1", language="python", script="print(1)\n"
    )

    # The session directory keeps the readable id plus a digest of the raw
    # name, so two distinct ids that sanitize alike never share a directory.
    assert logical.startswith("/projects/.ideer/inline/thread-A-")
    assert "/run-run-1-" in logical
    assert logical.endswith(".py")
    assert physical.is_file()
    assert physical.read_text(encoding="utf-8") == "print(1)\n"
    assert tmp_path in physical.parents


def test_distinct_sessions_that_sanitize_alike_get_their_own_directories(
    tmp_path: Path,
) -> None:
    store = InlineScriptStore(_store(tmp_path))
    _a_logical, a_physical = store.materialize(
        thread_id="a/b", run_id="run-1", language="python", script="pass"
    )
    _b_logical, b_physical = store.materialize(
        thread_id="a\\b", run_id="run-2", language="python", script="pass"
    )

    assert a_physical.parent != b_physical.parent
    store.cleanup_thread("a/b")
    assert not a_physical.exists()
    assert b_physical.exists()


def test_materialize_names_the_node_language_with_a_js_file(tmp_path: Path) -> None:
    store = InlineScriptStore(_store(tmp_path))
    _logical, physical = store.materialize(
        thread_id="thread-B", run_id="run-2", language="node", script="console.log(1)\n"
    )
    assert physical.name.endswith(".js")


def test_materialize_requires_an_attached_workspace(tmp_path: Path) -> None:
    store = InlineScriptStore(None)
    with pytest.raises(FileAccessError):
        store.materialize(
            thread_id="thread-A", run_id="run-1", language="python", script="pass"
        )


@pytest.mark.parametrize(
    "raw", ["a/b", "a\\b", "..", "c:relative", "thread with spaces", ""]
)
def test_thread_directory_names_are_sanitized(tmp_path: Path, raw: str) -> None:
    store = InlineScriptStore(_store(tmp_path))
    _logical, physical = store.materialize(
        thread_id=raw, run_id="run-1", language="python", script="pass"
    )
    # Every path component below the scratch root stays a safe name.
    relative = physical.relative_to(tmp_path).parts
    assert relative[0] == ".ideer" and relative[1] == "inline"
    for part in relative[2:-1]:
        assert part not in {"", ".", ".."}
        assert not any(ch in part for ch in "/\\: \t")


def test_cleanup_thread_removes_only_that_session(tmp_path: Path) -> None:
    store = InlineScriptStore(_store(tmp_path))
    store.materialize(
        thread_id="thread-A", run_id="run-1", language="python", script="pass"
    )
    keep_logical, keep_physical = store.materialize(
        thread_id="thread-B", run_id="run-2", language="python", script="pass"
    )

    store.cleanup_thread("thread-A")

    assert not (tmp_path / ".ideer" / "inline" / "thread-A").exists()
    assert keep_physical.is_file()
    store.cleanup_thread("thread-B")
    assert not (tmp_path / ".ideer").exists()


def test_cleanup_all_and_cleanup_of_unknown_sessions_are_tolerant(tmp_path: Path) -> None:
    store = InlineScriptStore(_store(tmp_path))
    store.cleanup_thread("never-materialized")
    store.cleanup_all()
    store.materialize(
        thread_id="thread-A", run_id="run-1", language="python", script="pass"
    )
    store.cleanup_all()
    assert not (tmp_path / ".ideer").exists()


def test_attaching_a_workspace_sweeps_stale_scratch_from_dead_runs(
    tmp_path: Path,
) -> None:
    """Scratch left behind by a crashed runtime is swept when a workspace is
    attached: no live process can still be executing from it."""
    stale = tmp_path / ".ideer" / "inline" / "thread-dead"
    stale.mkdir(parents=True)
    (stale / "run-old.py").write_text("pass", encoding="utf-8")

    files = _store(tmp_path)
    InlineScriptStore(files).attach(files)

    assert not stale.exists()


def test_rebinding_the_workspace_moves_the_scratch_root(tmp_path: Path) -> None:
    other = tmp_path / "second-workspace"
    other.mkdir()
    files = _store(tmp_path)
    store = InlineScriptStore(files)
    _old_logical, old_physical = store.materialize(
        thread_id="thread-A", run_id="run-1", language="python", script="pass"
    )

    rebound = LocalFileStore([RootConfig("/projects", other)])
    store.attach(rebound)
    _logical, physical = store.materialize(
        thread_id="thread-A", run_id="run-2", language="python", script="pass"
    )
    assert other in physical.parents
    # Leaving a workspace sweeps what this process left in its folder, so a
    # rebind never strands scripts in the previously authorized folder.
    assert not old_physical.exists()


# ---------------------------------------------------------------------------
# The service: materialize before run, only for an allowed ask.
# ---------------------------------------------------------------------------


def test_execute_materializes_the_script_and_runs_the_file(tmp_path: Path) -> None:
    payload = _payload()
    executor = RecordingExecutor()
    service = _approved_service(tmp_path, payload, executor=executor)

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.COMPLETED
    (call,) = executor.calls
    script_path = call["script_path"]
    assert script_path.is_file()
    assert script_path.read_text(encoding="utf-8") == payload["script"]
    relative = script_path.relative_to(tmp_path)
    assert relative.parts[0] == ".ideer" and relative.parts[1] == "inline"
    assert relative.parts[2].startswith("thread-A-")
    # The pinned interpreter and the payload's working root stay as declared.
    assert call["working_root"] == service.files.resolve("/projects")


def test_python_tasks_still_run_without_a_thread_identity(tmp_path: Path) -> None:
    payload = _payload()
    del payload["thread_id"]
    executor = RecordingExecutor()
    service = _approved_service(tmp_path, payload, executor=executor)

    asyncio.run(service.execute(payload))

    (call,) = executor.calls
    assert tmp_path / ".ideer" / "inline" in call["script_path"].parents


def test_refused_or_denied_asks_write_nothing(tmp_path: Path) -> None:
    payload = _payload()
    executor = RecordingExecutor()
    service = LocalPythonService(
        _store(tmp_path), consent=ConsentStore(), executor=executor
    )

    assert asyncio.run(service.execute(payload)) is PolicyDecision.CONSENT_REQUIRED
    assert executor.calls == []
    assert not (tmp_path / ".ideer").exists()

    denied = LocalPythonService(
        _store(tmp_path),
        policy=_DenyAllPolicy(),
        consent=ConsentStore(),
        executor=executor,
    )
    assert asyncio.run(denied.execute(payload, consent=True)) is PolicyDecision.DENY
    assert not (tmp_path / ".ideer").exists()


class _DenyAllPolicy:
    """A policy that denies the inline capability outright."""

    def authorize(self, capability, payload, consent=False):
        return PolicyDecision.DENY


def test_boundary_working_root_outside_the_roots_writes_nothing(
    tmp_path: Path,
) -> None:
    payload = _payload(working_root="/elsewhere")
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    executor = RecordingExecutor()
    service = LocalPythonService(
        _store(tmp_path), consent=consent, executor=executor
    )

    with pytest.raises(FileAccessError) as excinfo:
        asyncio.run(service.execute(payload))
    assert excinfo.value.code == "OUTSIDE_ALLOWED_ROOTS"
    assert executor.calls == []
    assert not (tmp_path / ".ideer").exists()


# ---------------------------------------------------------------------------
# Node: the pinned app runtime, never an arbitrary interpreter.
# ---------------------------------------------------------------------------


def test_node_task_without_a_configured_runtime_is_refused(tmp_path: Path) -> None:
    payload = _payload(runtime="node")
    executor = RecordingExecutor()
    service = _approved_service(tmp_path, payload, executor=executor)

    with pytest.raises(FileAccessError) as excinfo:
        asyncio.run(service.execute(payload))
    assert excinfo.value.code == "NODE_RUNTIME_UNAVAILABLE"
    assert executor.calls == []
    assert not (tmp_path / ".ideer").exists()


def test_unsupported_runtime_names_are_still_rejected(tmp_path: Path) -> None:
    service = _approved_service(tmp_path, _payload(runtime="ruby"))
    with pytest.raises(ValueError, match="runtime"):
        asyncio.run(service.execute(_payload(runtime="ruby"), consent=True))


def test_node_task_runs_with_the_pinned_runtime_and_app_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _payload(runtime="node")
    executor = RecordingExecutor()
    node_exe = "C:/app/Electron.exe"
    service = _approved_service(
        tmp_path, payload, executor=executor, node_executable=node_exe
    )

    captured: dict = {}

    def fake_probe(self, executable: str) -> str:
        captured["argv"] = [executable, "--version"]
        return "v22.14.0"

    monkeypatch.setattr(LocalPythonService, "_probe_node_version", fake_probe)
    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.COMPLETED
    (call,) = executor.calls
    assert call["interpreter"] == [node_exe]
    assert call["child_env"] == {"ELECTRON_RUN_AS_NODE": "1"}
    assert call["runtime_version"] == "v22.14.0"
    assert call["script_path"].name.endswith(".js")


def test_node_probe_validates_the_runtime_before_first_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first node task probes the configured executable once; a runtime
    that cannot answer refuses the task instead of launching blind."""
    payload = _payload(runtime="node")
    executor = RecordingExecutor()
    service = _approved_service(
        tmp_path, payload, executor=executor, node_executable="C:/app/Electron.exe"
    )

    seen: list[list[str]] = []

    def fake_run(argv, **kwargs):
        seen.append(list(argv))
        assert kwargs["timeout"] > 0
        assert kwargs["env"]["ELECTRON_RUN_AS_NODE"] == "1"
        raise subprocess.TimeoutExpired(argv[0], kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(FileAccessError) as excinfo:
        asyncio.run(service.execute(payload, consent=True))
    assert excinfo.value.code == "NODE_RUNTIME_UNAVAILABLE"
    assert seen == [["C:/app/Electron.exe", "--version"]]
    # The failed probe is not retried within the process.
    with pytest.raises(FileAccessError):
        asyncio.run(service.execute(payload, consent=True))
    assert seen == [["C:/app/Electron.exe", "--version"]]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_real_node_execution_runs_the_materialized_file(tmp_path: Path) -> None:
    payload = _payload(
        runtime="node", script="console.log('node-hello')", thread_id="thread-node"
    )
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    service = LocalPythonService(
        _store(tmp_path),
        consent=consent,
        node_executable=shutil.which("node"),
    )

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.COMPLETED
    assert result.stdout == "node-hello\n"
    scripts = list((tmp_path / ".ideer" / "inline").glob("thread-node-*/*.js"))
    assert len(scripts) == 1
    assert scripts[0].read_text(encoding="utf-8") == "console.log('node-hello')"


# ---------------------------------------------------------------------------
# Real execution: script file and relative artifacts land inside the folder.
# ---------------------------------------------------------------------------


def test_real_execution_writes_script_and_artifacts_into_the_folder(
    tmp_path: Path,
) -> None:
    payload = _payload(
        script="open('out.txt', 'w', encoding='utf-8').write('artifact')",
        working_root="/projects/data",
    )
    consent = ConsentStore()
    consent.approve("local.python", request_hash(payload))
    (tmp_path / "data").mkdir()
    service = LocalPythonService(_store(tmp_path), consent=consent)

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.COMPLETED
    # The temp script is on disk inside the authorized folder...
    scripts = list((tmp_path / ".ideer" / "inline").glob("thread-A-*/*.py"))
    assert len(scripts) == 1
    assert scripts[0].read_text(encoding="utf-8") == payload["script"]
    # ...and the artifact written relative to the working root stayed there too.
    assert (tmp_path / "data" / "out.txt").read_text(encoding="utf-8") == "artifact"
    # Session end sweeps the script, never the user's artifact.
    service.scripts.cleanup_thread("thread-A")
    assert not scripts[0].exists()
    assert (tmp_path / "data" / "out.txt").exists()
