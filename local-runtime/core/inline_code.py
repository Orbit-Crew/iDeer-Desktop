"""Inline controlled code execution (#105): session temp scripts.

The model's code never executes straight from the payload: it is written to
a file under ``<authorized root>/.ideer/inline/<session>/`` first, so the
user can see in their own folder exactly what ran, artifacts written beside
it stay inside the authorized folder, and the session end can sweep the
whole directory. The store owns only that directory tree; it rebinds to
whatever file store the workspace currently exposes and sweeps stale
scratch from dead runtimes when a workspace is attached.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Mapping

from .files import FileAccessError, LocalFileStore

#: The logical scratch directory below every authorized root.
SCRATCH_DIR = ".ideer/inline"

_SAFE_COMPONENT = re.compile(r"[^A-Za-z0-9._-]+")

#: Language of an inline task -> the file extension the pinned interpreter
#: expects. Python files keep ``.py``; Node runs CommonJS ``.js``.
LANGUAGE_EXTENSIONS = {"python": ".py", "node": ".js"}


def language_of(payload: Mapping) -> str:
    """The task's pinned language: ``node`` only when the payload says so."""
    return "node" if payload.get("runtime") == "node" else "python"


def display_language(language: str) -> str:
    """The user-facing name of a pinned language."""
    return "Node" if language == "node" else "Python"


def node_unavailable(detail: str) -> FileAccessError:
    """The one refusal every unusable-Node path raises."""
    return FileAccessError("NODE_RUNTIME_UNAVAILABLE", detail)


def _component(raw: str, fallback: str) -> str:
    """One safe path component for a wire-supplied identifier."""
    cleaned = _SAFE_COMPONENT.sub("-", (raw or "").strip())
    cleaned = cleaned.strip(".-")[:64].strip(".-")
    return cleaned or fallback


def session_dir_name(thread_id: str) -> str:
    """The scratch directory for one chat session.

    The readable prefix plus a short digest of the raw id: two distinct
    wire ids that sanitize to the same component still get their own
    directories, so sweeping one session can never take another's scripts.
    """
    digest = hashlib.sha256((thread_id or "").encode("utf-8")).hexdigest()[:8]
    return f"{_component(thread_id, 'adhoc')}-{digest}"


class InlineScriptStore:
    """The per-session temp script tree inside the authorized folder."""

    def __init__(self, files: LocalFileStore | None) -> None:
        self.files = files
        self._attached: set[tuple[str, ...]] = set()

    def attach(self, files: LocalFileStore) -> None:
        """Bind to a workspace file store and sweep scratch left by dead runs.

        Leaving a workspace sweeps what this process left in its folder, so
        a rebind never strands scripts in the previously authorized folder.
        A workspace's first attach in this process also sweeps whatever it
        finds there: a scratch directory can only be in use while the
        runtime process that materialized it is alive. Re-attaching the
        same workspace (a reconnect) never sweeps - the live sessions'
        scripts survive. Best effort: a locked leftover stays and is
        retried on the next attach.
        """
        previous = self.files
        if previous is not None and (files is None or self._root_key(files) != self._root_key(previous)):
            self._sweep_store(previous)
        self.files = files
        if files is None:
            return
        key = self._root_key(files)
        if key in self._attached:
            return
        self._attached.add(key)
        self.cleanup_all()

    @staticmethod
    def _root_key(files: LocalFileStore) -> tuple[str, ...]:
        return tuple(
            f"{root.logical_root}:{root.physical_root}" for root in files.roots
        )

    @classmethod
    def _sweep_store(cls, files: LocalFileStore) -> None:
        """Sweep one store's scratch tree regardless of the current binding."""
        scratch = files.roots[0].physical_root.joinpath(*SCRATCH_DIR.split("/"))
        cls._rmtree(scratch)
        cls._sweep_empty_parents(scratch)

    def _root(self) -> tuple[str, Path]:
        if self.files is None:
            raise FileAccessError("WORKSPACE_UNAVAILABLE", "no workspace is attached")
        root = self.files.roots[0]
        return root.logical_root, root.physical_root

    def _physical_scratch(self) -> Path:
        _logical_root, physical_root = self._root()
        return physical_root.joinpath(*SCRATCH_DIR.split("/"))

    def materialize(
        self, *, thread_id: str, run_id: str, language: str, script: str
    ) -> tuple[str, Path]:
        """Write one inline task's code as the session's temp script.

        Returns the logical path (the wire-facing name, inside the root so
        every other boundary check applies to it unchanged) and the physical
        path the executor runs. The write rides the file store, so a
        refused or denied ask that never reaches here writes nothing, and a
        protected-name collision raises instead of overwriting user data.
        """
        extension = LANGUAGE_EXTENSIONS.get(language)
        if extension is None:
            raise FileAccessError("INVALID_PATH", f"unsupported language {language}")
        logical_root, _physical_root = self._root()
        session_dir = f"{SCRATCH_DIR}/{session_dir_name(thread_id)}"
        name = (
            f"run-{_component(run_id, 'adhoc')}-{uuid.uuid4().hex[:8]}{extension}"
        )
        logical = f"{logical_root}/{session_dir}/{name}"
        self.files.write(logical, script)
        return logical, self.files.resolve(logical)

    def cleanup_thread(self, thread_id: str) -> None:
        """Sweep one session's scratch; a no-op for unknown sessions.

        The emptied ``inline`` wrapper is removed as well when the sweep took
        the last session out; a still-occupied tree stays.
        """
        if self.files is None:
            return
        scratch = self._physical_scratch()
        self._rmtree(scratch / session_dir_name(thread_id))
        self._sweep_empty_parents(scratch)

    def cleanup_all(self) -> None:
        """Sweep every session's scratch (identity change, shutdown)."""
        if self.files is None:
            return
        scratch = self._physical_scratch()
        self._rmtree(scratch)
        self._sweep_empty_parents(scratch)

    @staticmethod
    def _sweep_empty_parents(scratch: Path) -> None:
        """Remove the runtime's own empty namespace after a sweep.

        Tries ``inline`` then ``.ideer``: a directory is removed only when it
        exists and is empty, so anything still in them - sessions, user
        files, another runtime's scratch - stays untouched.
        """
        for candidate in (scratch, scratch.parent):
            try:
                candidate.rmdir()
            except OSError:
                pass

    @staticmethod
    def _rmtree(path: Path) -> None:
        shutil.rmtree(path, ignore_errors=True)


def probe_node_version(executable: str) -> str:
    """Validate the pinned Node runtime and read its version once.

    The Desktop passes the app's own executable, which only behaves as Node
    under ``ELECTRON_RUN_AS_NODE``; the probe proves the pairing works
    before the first task is allowed to launch it blind.
    """
    try:
        result = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            timeout=10,
            env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"},
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        raise node_unavailable("the configured Node runtime is unusable") from None
    if result.returncode != 0:
        raise node_unavailable("the configured Node runtime is unusable")
    version = result.stdout.decode("utf-8", errors="replace").strip()
    if not version:
        raise node_unavailable("the configured Node runtime reported no version")
    return version
