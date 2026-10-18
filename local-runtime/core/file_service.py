"""Policy-gated local file task handlers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .consent import ConsentStore, request_hash
from .files import LocalFileStore
from .policy import LocalPolicy, PolicyDecision


@dataclass(frozen=True)
class FileTaskResult:
    decision: PolicyDecision
    value: Any = None


class LocalFileService:
    def __init__(
        self,
        files: LocalFileStore,
        *,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
    ) -> None:
        self.files = files
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()

    def execute(
        self, capability: str, payload: dict[str, Any], *, consent: bool = False
    ) -> FileTaskResult:
        if capability not in {"local.files.list", "local.files.read", "local.files.write"}:
            raise ValueError("unsupported local file capability")
        digest = request_hash(payload)
        decision = self.policy.authorize(
            capability,
            payload,
            consent=consent or self.consent.consume(capability, digest),
        )
        if decision is not PolicyDecision.ALLOW:
            return FileTaskResult(decision)
        if capability == "local.files.list":
            return FileTaskResult(decision, self.files.list(str(payload["path"])))
        if capability == "local.files.read":
            return FileTaskResult(decision, self.files.read(str(payload["path"])))
        if capability == "local.files.write":
            self.files.write(str(payload["path"]), str(payload["content"]))
            return FileTaskResult(decision, {"written": True})
