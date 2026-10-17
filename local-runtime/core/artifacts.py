"""Explicit, bounded artifact upload handles."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class ArtifactUploader(Protocol):
    def upload(self, name: str, content: bytes) -> str: ...


class ArtifactUploadError(ValueError):
    """A safe, caller-facing artifact upload rejection."""


@dataclass
class SingleUseUploadGrant:
    """Short-lived task-bound grant consumed once per expected artifact."""

    run_id: str
    task_id: str
    thread_id: str
    artifact_name: str
    token: str = ""
    consumed: bool = False

    def __post_init__(self) -> None:
        self.token = self.token or secrets.token_urlsafe(24)

    def consume(self, *, run_id: str, task_id: str, thread_id: str, name: str) -> str:
        if self.consumed or (run_id, task_id, thread_id, name) != (
            self.run_id,
            self.task_id,
            self.thread_id,
            self.artifact_name,
        ):
            raise ArtifactUploadError(
                "artifact upload grant is invalid or already used"
            )
        self.consumed = True
        return self.token


class MemoryArtifactUploader:
    def __init__(self, *, max_bytes: int = 10 * 1024 * 1024) -> None:
        self.items: dict[str, bytes] = {}
        self.max_bytes = max_bytes

    def upload(self, name: str, content: bytes) -> str:
        if len(content) > self.max_bytes:
            raise ArtifactUploadError("artifact exceeds configured size limit")
        if not name or Path(name).name != name:
            raise ArtifactUploadError("artifact name is invalid")
        digest = hashlib.sha256(content).hexdigest()
        handle = f"local://{digest}/{Path(name).name}"
        existing = self.items.get(handle)
        if existing is not None and existing != content:
            raise ArtifactUploadError("artifact handle content mismatch")
        self.items[handle] = content
        return handle


class FileArtifactUploader:
    """Durable local staging uploader with idempotent content handles."""

    def __init__(
        self, directory: str | Path, *, max_bytes: int = 10 * 1024 * 1024
    ) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes

    def upload(self, name: str, content: bytes) -> str:
        if len(content) > self.max_bytes:
            raise ArtifactUploadError("artifact exceeds configured size limit")
        safe_name = Path(name).name
        if not name or safe_name != name:
            raise ArtifactUploadError("artifact name is invalid")
        digest = hashlib.sha256(content).hexdigest()
        target = self.directory / f"{digest}-{safe_name}"
        if target.exists() and target.read_bytes() != content:
            raise ArtifactUploadError("artifact handle content mismatch")
        if not target.exists():
            temporary = target.with_name(f".{target.name}.tmp")
            temporary.write_bytes(content)
            temporary.replace(target)
        return f"local://{digest}/{safe_name}"
