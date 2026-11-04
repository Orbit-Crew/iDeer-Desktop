"""Runtime-period Skill dependency installation behind explicit consent (#104).

A Skill script runs only when every declared condition is verifiable on this
device (#170). This module adds the one bounded provisioning contract the
device leg supports: a missing or unsatisfied *exact-pinned* dependency
(``name==x.y.z`` in the frozen declaration) may be installed on demand, but
only

1. after the device asked and the user approved THIS install (the ask names
   the skill, the locked entries and the configured source — no install
   without a fresh confirmation, and no standing approval: every consent
   settles exactly one install, so the always-allow upgrade is dropped);
2. from a source the operator configured in the runtime settings — a local
   offline wheelhouse directory (``kind: "offline"``) or an intranet
   wheelhouse URL (``kind: "intranet"``). Nothing here ever contacts a
   default index: with no source configured there is no install path at
   all, and the environment refusal simply names what is missing;
3. for the exact artifacts the wheelhouse lock (``skill-deps.lock.json``
   beside the wheels) resolves to each pin, fetched or read in full and
   verified against the lock's sha256 before a byte is extracted — the
   same content-bound pattern the runtime's own distribution lock uses.

Wheels extract into the runtime's own provisioning target: the embedded
runtime directory (``python*._pth`` layout, where ``.`` is on ``sys.path``
for this process and every ``-I`` script subprocess alike) or, on a regular
interpreter, the purelib site-packages pip itself uses. Rebuilding the
embedded runtime removes what was installed this way; the next run of the
skill simply asks again. Range-constrained declarations, interpreter, tool,
software and data conditions have no installer here and refuse exactly as
before — with the per-entry report so the author knows why (#104 AC1).
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from .consent import ConsentStore
from .policy import LocalPolicy
from .skill_script import (
    _exact_lock,
    _parse_requirement,
    installable_pins,
    parse_execution_environment,
    requirements_fingerprint,
)

#: The capability the install ask grades under; it rides the desktop consent
#: machinery exactly like ``local.skill.script`` but is never a task the
#: server may dispatch — the device opens it from a script gate refusal.
SKILL_DEPENDENCY_CAPABILITIES = ("local.skill.dependencies",)

#: Fixed categories that cross the wire verbatim, like every device leg.
SKILL_DEPENDENCIES_UNAVAILABLE = "SKILL_DEPENDENCIES_UNAVAILABLE"
SKILL_DEPENDENCIES_INSTALL_FAILED = "SKILL_DEPENDENCIES_INSTALL_FAILED"

#: The wheelhouse lock beside the wheels; the offline and intranet source
#: kinds share the same manifest and artifact layout.
MANIFEST_NAME = "skill-deps.lock.json"

MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_WHEEL_BYTES = 512 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 30.0
MAX_WHEEL_MEMBERS = 20_000
MAX_ENTRIES = 16

_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_VERSION_PATTERN = re.compile(r"^[0-9][A-Za-z0-9.+-]*$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_PLAN_FIELDS = frozenset({
    "operation", "skill_id", "skill_version", "requirements_sha256",
    "entries", "source", "run_id", "thread_id",
})


class SkillDependencyError(RuntimeError):
    """A fixed-category install failure; ``code`` crosses the wire verbatim
    and ``str`` carries the bounded human detail."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


def _refuse(message: str) -> SkillDependencyError:
    return SkillDependencyError(SKILL_DEPENDENCIES_INSTALL_FAILED, message)


def _unconfigured(detail: str = "") -> SkillDependencyError:
    return SkillDependencyError(SKILL_DEPENDENCIES_UNAVAILABLE, detail)


def normalize_name(name: str) -> str:
    """The PEP 503 comparison form; the lock is matched the way pip matches."""
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def resolve_target_dir() -> Path:
    """Where an extracted wheel becomes importable for this runtime.

    The embedded runtime's ``python*._pth`` layout puts its own directory on
    ``sys.path`` (the ``.`` entry), for this process and every ``-I`` script
    subprocess alike; a regular interpreter gets the purelib site-packages
    pip itself uses. Both are places the next ``verify_environment`` and the
    skill script can actually see what was installed.
    """
    exe_dir = Path(sys.executable).resolve().parent
    if any(exe_dir.glob("python*._pth")):
        return exe_dir
    import sysconfig

    return Path(sysconfig.get_path("purelib"))


def source_from_settings(raw: Any) -> DependencySource | None:
    """The configured install source, or ``None`` when none is configured.

    A malformed setting returns ``None`` rather than raising: the runtime
    must still boot (this runs at controller construction), and a malformed
    source then refuses installs exactly like an absent one — never a
    silent fallback to some default index.
    """
    if not raw or not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind", ""))
    location = str(raw.get("location", "")).strip()
    if kind not in ("offline", "intranet") or not location:
        return None
    return DependencySource(kind, location)


@dataclass(frozen=True)
class DependencySource:
    """One configured wheelhouse: an offline directory or an intranet URL."""

    kind: str
    location: str

    def artifact_url(self, filename: str) -> str:
        return f"{self.location.rstrip('/')}/{urllib.parse.quote(filename)}"


class SkillDependencyService:
    """Plan and run one consented locked-dependency install (#104).

    The service is policy- and consent-aware like its script sibling: the
    local DENY veto applies before any ask, and the ConsentStore the ask
    settles through is the tray's shared one. ``fetcher`` is the network
    seam for tests; production uses bounded ``urllib`` reads.
    """

    def __init__(
        self,
        *,
        source: DependencySource | None = None,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
        target_dir: str | Path | None = None,
        fetcher: Callable[[str, int], bytes] | None = None,
    ) -> None:
        self.source = source
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()
        self._target_dir = str(target_dir) if target_dir is not None else ""
        self._fetcher = fetcher

    def target_dir(self) -> Path:
        if self._target_dir:
            return Path(self._target_dir)
        return resolve_target_dir()

    # --- planning -----------------------------------------------------------

    def plan(self, skill_payload: dict[str, Any], report: list) -> dict[str, Any] | None:
        """The consent payload for one install ask, or ``None`` when the gap
        is not fully curable with exact pins.

        Raises :class:`SkillDependencyError` with ``UNAVAILABLE`` when no
        usable source is configured: the device then refuses the script with
        the environment detail instead of pretending an install could help.
        """
        pins = installable_pins(report)
        if not pins:
            return None
        if len(pins) > MAX_ENTRIES:
            return None
        if self.source is None:
            raise _unconfigured("no Skill dependency source is configured")
        if self.source.kind == "offline" and not Path(self.source.location).is_dir():
            raise _unconfigured(f"offline dependency source is missing: {self.source.location}")
        declaration = parse_execution_environment(skill_payload.get("declaration"))
        return {
            "operation": "local.skill.dependencies",
            "skill_id": str(skill_payload.get("skill_id", "")),
            "skill_version": int(skill_payload.get("skill_version", 0)),
            "requirements_sha256": requirements_fingerprint(declaration),
            "entries": pins,
            "source": {"kind": self.source.kind, "location": self.source.location},
            "run_id": str(skill_payload.get("run_id", "")),
            "thread_id": str(skill_payload.get("thread_id", "")),
        }

    # --- installation -------------------------------------------------------

    def install(self, plan_payload: dict[str, Any]) -> dict[str, Any]:
        """The consented install: resolve, verify, extract, report (AC2/AC4).

        Every artifact is fetched and hash-verified before anything
        extracts, so a failure leaves the device exactly as it was. The
        outcome names the wheels and versions that landed and where they
        went; the receipt and audit trail carry the same facts.
        """
        self._validate_plan(plan_payload)
        entries = plan_payload["entries"]
        wanted = []
        for item in entries:
            entry = str(item["entry"])
            parsed = _parse_requirement(entry)
            pin = _exact_lock(parsed[1]) if parsed is not None else ""
            if parsed is None or not pin or normalize_name(parsed[0]) != normalize_name(str(item["name"])):
                raise _refuse(f"entry is not an exact pin: {entry}")
            if pin != str(item["version"]):
                raise _refuse(f"entry pin does not match the planned version: {entry}")
            wanted.append((normalize_name(parsed[0]), pin, entry))

        source = DependencySource(
            str(plan_payload["source"].get("kind", "")),
            str(plan_payload["source"].get("location", "")),
        )
        if source.kind not in ("offline", "intranet") or not source.location:
            raise _refuse("the plan's source is not a configured wheelhouse")
        lock = self._load_lock(source)
        resolved = []
        missing = []
        for key, pin, entry in wanted:
            wheel = lock.get((key, pin))
            if wheel is None:
                missing.append(f"{entry}")
                continue
            resolved.append(wheel)
        if missing:
            raise _refuse("dependency lock has no artifact for: " + ", ".join(missing))

        staged = []
        for wheel in resolved:
            data = self._wheel_bytes(source, wheel)
            if hashlib.sha256(data).hexdigest() != wheel["sha256"]:
                raise _refuse(f"wheel sha256 does not match the lock: {wheel['file']}")
            # Every member is validated before anything lands: a hostile or
            # unsupported wheel refuses the whole install, not half of it.
            self._validate_wheel(data)
            staged.append((wheel, data))

        target = self.target_dir()
        target.mkdir(parents=True, exist_ok=True)
        for wheel, data in staged:
            self._extract_wheel(data, target)
        return {
            "installed": [
                {"name": wheel["name"], "version": wheel["version"],
                 "file": wheel["file"], "sha256": wheel["sha256"]}
                for wheel, _data in staged
            ],
            "target_dir": str(target),
        }

    @staticmethod
    def _validate_plan(plan_payload: Any) -> None:
        if not isinstance(plan_payload, dict) or set(plan_payload) != _PLAN_FIELDS:
            raise _refuse("install plan shape is invalid")
        if plan_payload.get("operation") != "local.skill.dependencies":
            raise _refuse("install plan operation is invalid")
        if not isinstance(plan_payload.get("skill_id"), str) or not plan_payload["skill_id"]:
            raise _refuse("install plan skill identity is invalid")
        version = plan_payload.get("skill_version")
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise _refuse("install plan skill version is invalid")
        if not isinstance(plan_payload.get("requirements_sha256"), str):
            raise _refuse("install plan requirements hash is invalid")
        entries = plan_payload.get("entries")
        if not isinstance(entries, list) or not entries or len(entries) > MAX_ENTRIES:
            raise _refuse("install plan entries are invalid")
        for item in entries:
            if (
                not isinstance(item, dict)
                or set(item) != {"entry", "name", "version"}
                or not all(isinstance(item[key], str) and item[key] for key in ("entry", "name", "version"))
            ):
                raise _refuse("install plan entry is invalid")
        source = plan_payload.get("source")
        if (
            not isinstance(source, dict)
            or set(source) != {"kind", "location"}
            or not all(isinstance(source[key], str) and source[key] for key in ("kind", "location"))
        ):
            raise _refuse("install plan source is invalid")
        for field in ("run_id", "thread_id"):
            if not isinstance(plan_payload.get(field), str):
                raise _refuse("install plan routing fields are invalid")

    # --- wheelhouse lock ------------------------------------------------------

    def _load_lock(self, source: DependencySource) -> dict[tuple[str, str], dict[str, str]]:
        if source.kind == "offline":
            path = Path(source.location) / MANIFEST_NAME
            try:
                data = _bounded_file_read(path, MAX_MANIFEST_BYTES)
            except OSError:
                raise _refuse(f"dependency lock is unreadable: {MANIFEST_NAME}") from None
        else:
            data = self._fetch(source.artifact_url(MANIFEST_NAME), MAX_MANIFEST_BYTES)
        try:
            document = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _refuse(f"dependency lock is not valid JSON: {MANIFEST_NAME}") from None
        wheels = document.get("wheels") if isinstance(document, dict) else None
        if not isinstance(wheels, list) or not wheels or len(wheels) > 4096:
            raise _refuse("dependency lock wheels are invalid")
        lock: dict[tuple[str, str], dict[str, str]] = {}
        for wheel in wheels:
            if (
                not isinstance(wheel, dict)
                or set(wheel) != {"name", "version", "file", "sha256"}
                or not isinstance(wheel["name"], str) or not _NAME_PATTERN.match(wheel["name"])
                or not isinstance(wheel["version"], str) or not _VERSION_PATTERN.match(wheel["version"])
                or not isinstance(wheel["sha256"], str) or not _SHA256_PATTERN.match(wheel["sha256"])
                or not isinstance(wheel["file"], str)
            ):
                raise _refuse("dependency lock wheel entry is invalid")
            filename = wheel["file"]
            if (
                not filename
                or len(filename) > 255
                or PurePosixPath(filename).name != filename
                or "\\" in filename
                or ".." in filename
                or not filename.endswith(".whl")
            ):
                raise _refuse(f"dependency lock artifact name is invalid: {filename}")
            key = (normalize_name(wheel["name"]), wheel["version"])
            if key in lock:
                raise _refuse(f"dependency lock has duplicate artifacts for {key[0]}=={key[1]}")
            lock[key] = {
                "name": wheel["name"], "version": wheel["version"],
                "file": filename, "sha256": wheel["sha256"],
            }
        return lock

    def _wheel_bytes(self, source: DependencySource, wheel: dict[str, str]) -> bytes:
        if source.kind == "offline":
            try:
                return _bounded_file_read(Path(source.location) / wheel["file"], MAX_WHEEL_BYTES)
            except OSError:
                raise _refuse(f"locked wheel is unreadable: {wheel['file']}") from None
        return self._fetch(source.artifact_url(wheel["file"]), MAX_WHEEL_BYTES)

    def _fetch(self, url: str, limit: int) -> bytes:
        """One bounded read from the configured source, and nothing else.

        The URL is the operator's configured location plus a validated lock
        filename; no redirect-following index walks, no default indexes.
        """
        if self._fetcher is not None:
            return self._fetcher(url, limit)
        try:
            with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_SECONDS) as response:
                chunks: list[bytes] = []
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise _refuse("source artifact exceeds the bounded size")
                    chunks.append(chunk)
        except SkillDependencyError:
            raise
        except Exception as exc:  # noqa: BLE001 - every fetch failure is one honest category
            raise _refuse(f"dependency source is unreachable: {type(exc).__name__}") from None
        return b"".join(chunks)

    # --- extraction -----------------------------------------------------------

    @staticmethod
    def _validate_wheel(data: bytes) -> None:
        """Refuse every wheel this device leg does not provision: a valid
        zip with a bounded member count and purelib-only layout (``.data``
        members have no contract here; a curated lock does not carry them).
        """
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as bundle:
                members = bundle.infolist()
                if not members or len(members) > MAX_WHEEL_MEMBERS:
                    raise _refuse("wheel member count is invalid")
                for member in members:
                    _validate_member_name(member.filename)
        except zipfile.BadZipFile:
            raise _refuse("locked artifact is not a valid wheel") from None

    @staticmethod
    def _extract_wheel(data: bytes, target: Path) -> None:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as bundle:
                bundle.extractall(target)
        except zipfile.BadZipFile:
            raise _refuse("locked artifact is not a valid wheel") from None


def _validate_member_name(name: str) -> None:
    parts = PurePosixPath(name).parts
    if (
        not name
        or "\\" in name
        or name.startswith("/")
        or ".." in parts
        or "" in parts
        or re.match(r"^[A-Za-z]:", name)
    ):
        raise _refuse(f"wheel member escapes the package layout: {name}")
    top = parts[0]
    if top.endswith(".data"):
        raise _refuse(f"wheel carries an unsupported .data member: {name}")


def _bounded_file_read(path: Path, limit: int) -> bytes:
    data = path.read_bytes()
    if len(data) > limit:
        raise OSError("artifact exceeds the bounded size")
    return data
