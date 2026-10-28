"""Offline connector component installation on this device (#123).

The user manually locates one connector package — a directory holding a
``connector.json`` manifest and its Python entry — and the device validates
it locally before anything is registered: fixed manifest key set, declared
version and a probeable dependency floor, an entry that is a plain relative
file inside the package (never a link, never an escape), and a member screen
that refuses executables and oversized content. A confirmed install copies
the package into this profile's managed store, generates the *controlled*
MCP configuration (the command is the pinned bundled interpreter; the only
injected environment is the connector's own managed data directory), records
the binding-scoped registry row, and the supervisor swap starts the server
and discovers its tools through the existing ``local.mcp.*`` machinery —
no parallel MCP framework. The runnable binding (command, environment,
paths) exists only on this device; the platform learns the canonical
identity (slug, display name, version, manifest hash) through the explicit
registration call the install flow makes first.

Failure categories are fixed and user-actionable; local paths and package
bytes never travel — the registry keeps them device-locally, and every
projection across the Desktop boundary carries identity fields only.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import sys
import threading
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

from .compat import is_junction

MANIFEST_NAME = "connector.json"
SLUG_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VERSION_PATTERN = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$")
FLOOR_PATTERN = re.compile(r"^>=([0-9]{1,3})\.([0-9]{1,3})(?:\.([0-9]{1,3}))?$")
MANIFEST_KEYS = frozenset({"connector", "displayName", "version", "entry", "requirements"})
PROBE_KEYS = frozenset({"python"})
ENTRY_SUFFIX = ".py"
MAX_ENTRY_BYTES = 1024 * 1024
MAX_PACKAGE_FILES = 100
MAX_PACKAGE_BYTES = 8 * 1024 * 1024
MAX_TEXT = 200
# A connector package is data plus interpreted Python: native executables and
# shell scripts have no reason to be in one and are refused outright.
FORBIDDEN_SUFFIXES = frozenset({".bat", ".cmd", ".com", ".dll", ".exe", ".msi", ".ps1", ".sh", ".so"})

REGISTRY_STATUSES = ("installed",)


class ConnectorInstallError(RuntimeError):
    """A fixed-category connector failure; safe to surface as an error code."""


def category_for(error: BaseException, *, action: str = "install") -> str:
    """Map device-side failures onto the fixed connector categories."""
    if isinstance(error, ConnectorInstallError):
        return str(error)
    return {
        "install": "CONNECTOR_INSTALL_FAILED",
        "remove": "CONNECTOR_REMOVE_FAILED",
    }.get(action, "CONNECTOR_FAILED")


def _refuse(code: str) -> ConnectorInstallError:
    return ConnectorInstallError(code)


def connectors_dir(config_path: str | Path) -> Path:
    return Path(config_path).with_name("connectors")


def connectors_config_path(config_path: str | Path) -> Path:
    return Path(config_path).with_name("connectors-mcp.json")


def connectors_registry_path(config_path: str | Path) -> Path:
    return Path(config_path).with_name("connectors.db")


def _link_free(path: Path) -> bool:
    try:
        return not path.is_symlink() and not is_junction(path)
    except OSError:
        return False


def _checked_relative(raw: Any) -> PurePosixPath:
    """One package-relative path that cannot escape or masquerade."""
    if not isinstance(raw, str) or not raw or len(raw) > 256 or "\x00" in raw:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    if "\\" in raw or raw.startswith("/"):
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or not relative.parts:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    for part in relative.parts:
        if part in {"", ".", ".."} or part.rstrip(" .") != part or ":" in part:
            raise _refuse("CONNECTOR_MANIFEST_INVALID")
    return relative


def parse_manifest(data: Any) -> dict[str, Any]:
    """Validate one manifest against the frozen shape; unknown keys are refused.

    A fixed key set is the contract: a manifest that carries configuration
    this device has not probed (extra commands, environment, hooks) must not
    look installable.
    """
    if not isinstance(data, dict):
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    if set(data) != MANIFEST_KEYS:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    slug = data["connector"]
    if not isinstance(slug, str) or not SLUG_PATTERN.fullmatch(slug):
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    display_name = data["displayName"]
    if not isinstance(display_name, str) or not 1 <= len(display_name) <= MAX_TEXT:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    version = data["version"]
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    entry = _checked_relative(data["entry"])
    if entry.suffix != ENTRY_SUFFIX or len(entry.parts) > 8:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    requirements = data["requirements"]
    if not isinstance(requirements, dict) or not set(requirements) <= PROBE_KEYS:
        # A dependency this device cannot probe is a missing dependency, not
        # an installable unknown.
        raise _refuse("CONNECTOR_DEPENDENCY_MISSING")
    for name, floor in requirements.items():
        if not isinstance(floor, str) or not FLOOR_PATTERN.fullmatch(floor):
            raise _refuse("CONNECTOR_MANIFEST_INVALID")
    return {
        "slug": slug,
        "display_name": display_name,
        "version": version,
        "entry": str(entry),
        "requirements": dict(requirements),
    }


def probe_requirements(requirements: dict[str, str]) -> None:
    """Probe the declared dependency floor against this interpreter."""
    floor = requirements.get("python")
    if floor is None:
        return
    match = FLOOR_PATTERN.fullmatch(floor)
    if match is None:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    major, minor, micro = (int(part or 0) for part in match.groups())
    if sys.version_info[:3] < (major, minor, micro):
        raise _refuse("CONNECTOR_VERSION_MISMATCH")


def package_hash(entries: dict[str, str]) -> str:
    """Canonical content hash: sorted relative paths with per-file digests."""
    encoded = json.dumps(sorted(entries.items()), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def read_package(picked: Path) -> dict[str, Any]:
    """Read and validate one candidate package directory; read-only."""
    if not picked.is_dir() or not _link_free(picked):
        raise _refuse("CONNECTOR_PACKAGE_INVALID")
    manifest_path = picked / MANIFEST_NAME
    if not manifest_path.is_file() or not _link_free(manifest_path):
        raise _refuse("CONNECTOR_PACKAGE_INVALID")
    try:
        raw = manifest_path.read_bytes()
    except OSError:
        raise _refuse("CONNECTOR_PACKAGE_INVALID") from None
    if len(raw) > MAX_ENTRY_BYTES or b"\x00" in raw:
        raise _refuse("CONNECTOR_MANIFEST_INVALID")
    try:
        manifest = parse_manifest(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeError):
        raise _refuse("CONNECTOR_MANIFEST_INVALID") from None
    probe_requirements(manifest["requirements"])
    entry_relative = PurePosixPath(manifest["entry"])
    entry_path = picked.joinpath(*entry_relative.parts)
    if not entry_path.is_file() or not _link_free(entry_path):
        raise _refuse("CONNECTOR_ENTRY_INVALID")
    try:
        if entry_path.stat().st_size > MAX_ENTRY_BYTES:
            raise _refuse("CONNECTOR_ENTRY_INVALID")
    except OSError:
        raise _refuse("CONNECTOR_ENTRY_INVALID") from None
    # Every ancestor between the package root and the entry must be a plain
    # directory: a linked directory would smuggle an outside file in.
    walked = picked
    for part in entry_relative.parts[:-1]:
        walked = walked / part
        if not walked.is_dir() or not _link_free(walked):
            raise _refuse("CONNECTOR_ENTRY_INVALID")
    entries: dict[str, str] = {}
    total = 0
    try:
        members = sorted(picked.rglob("*"))
    except OSError:
        raise _refuse("CONNECTOR_PACKAGE_INVALID") from None
    for member in members:
        relative = member.relative_to(picked)
        if len(relative.parts) > 8:
            raise _refuse("CONNECTOR_PACKAGE_INVALID")
        if not _link_free(member):
            raise _refuse("CONNECTOR_PACKAGE_INVALID")
        if member.is_dir():
            continue
        if not member.is_file() or member.suffix.lower() in FORBIDDEN_SUFFIXES:
            raise _refuse("CONNECTOR_PACKAGE_INVALID")
        try:
            digest = hashlib.sha256(member.read_bytes()).hexdigest()
        except OSError:
            raise _refuse("CONNECTOR_PACKAGE_INVALID") from None
        entries[relative.as_posix()] = digest
        total += member.stat().st_size
        if len(entries) > MAX_PACKAGE_FILES or total > MAX_PACKAGE_BYTES:
            raise _refuse("CONNECTOR_PACKAGE_INVALID")
    if MANIFEST_NAME not in entries or manifest["entry"] not in entries:
        raise _refuse("CONNECTOR_PACKAGE_INVALID")
    manifest["manifest_hash"] = hashlib.sha256(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    manifest["package_hash"] = package_hash(entries)
    manifest["file_count"] = len(entries)
    return manifest


class ConnectorRegistry:
    """Binding-scoped device-local facts about installed connectors.

    Like every device registry, rows carry identity fields and the local
    install facts; the physical layout stays derivable from the profile and
    is never projected across the Desktop boundary.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS connectors (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    slug TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
                    version TEXT NOT NULL DEFAULT '', manifest_hash TEXT NOT NULL DEFAULT '',
                    package_hash TEXT NOT NULL DEFAULT '', entry TEXT NOT NULL DEFAULT '',
                    server_connector_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'installed',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
                db.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_connectors_binding_slug ON connectors (binding, slug)")
        except (sqlite3.Error, OSError):
            self._error = "CONNECTOR_STORAGE_UNAVAILABLE"

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
                self._error = "CONNECTOR_STORAGE_UNAVAILABLE"
                raise ConnectorInstallError(self._error) from exc

    @staticmethod
    def _identity(binding, slug: str) -> str:
        return hashlib.sha256(json.dumps(
            [json.dumps(binding, sort_keys=True), slug], sort_keys=True).encode()).hexdigest()

    def record(self, binding, row: dict[str, Any]) -> None:
        fields = (
            str(row["slug"])[:64], str(row.get("display_name", ""))[:MAX_TEXT],
            str(row.get("version", ""))[:32], str(row.get("manifest_hash", ""))[:64],
            str(row.get("package_hash", ""))[:64], str(row.get("entry", ""))[:256],
            str(row.get("server_connector_id", ""))[:64], "installed",
        )

        def write(db):
            db.execute(
                "INSERT INTO connectors (identity, binding, slug, display_name, version, manifest_hash,"
                " package_hash, entry, server_connector_id, state) VALUES (?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(identity) DO UPDATE SET display_name=excluded.display_name,"
                " version=excluded.version, manifest_hash=excluded.manifest_hash,"
                " package_hash=excluded.package_hash, entry=excluded.entry,"
                " server_connector_id=excluded.server_connector_id, state='installed'",
                (self._identity(binding, fields[0]), json.dumps(binding, sort_keys=True), *fields))

        self._execute(write)

    def find(self, binding, slug: str) -> dict[str, Any] | None:
        def read(db):
            row = db.execute("SELECT * FROM connectors WHERE identity=? AND state='installed'",
                             (self._identity(binding, slug),)).fetchone()
            return dict(row) if row is not None else None

        return self._execute(read)

    def remove(self, binding, slug: str) -> bool:
        def write(db):
            cursor = db.execute("DELETE FROM connectors WHERE identity=? AND state='installed'",
                                (self._identity(binding, slug),))
            return cursor.rowcount == 1

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {
            "slug": row["slug"], "displayName": row["display_name"], "version": row["version"],
            "entry": row["entry"],
            "manifestHash": row["manifest_hash"], "packageHash": row["package_hash"],
            "serverConnectorId": row["server_connector_id"], "state": row["state"],
            "createdAt": row["created_at"],
        }

    def view(self, binding) -> list[dict[str, Any]]:
        def read(db):
            return [self._view(row) for row in db.execute(
                "SELECT * FROM connectors WHERE binding=? AND state='installed' ORDER BY slug",
                (json.dumps(binding, sort_keys=True),))]

        return self._execute(read)


class ConnectorInstallService:
    """Validate, commit, and remove this device's connector components.

    The service owns the managed store, the controlled MCP configuration,
    and the registry. Starting and stopping the MCP server belongs to the
    supervisor swap the caller (the tray controller) performs; this module
    only guarantees that a removed component leaves no configuration entry
    and no managed copy behind, so the swap cannot restart it.
    """

    def __init__(
        self,
        registry: ConnectorRegistry,
        *,
        config_path: str | Path,
        interpreter: str | None = None,
        registrar: Any = None,
        unregister: Any = None,
    ) -> None:
        self.registry = registry
        self.config_path = Path(config_path)
        self.interpreter = interpreter or sys.executable
        # Platform canonical identity calls (#123): the registrar runs before
        # the local commit so an installed connector is always traceable; the
        # unregister runs after a confirmed local removal.
        self.registrar = registrar
        self.unregister = unregister
        self._lock = threading.RLock()

    @property
    def store(self) -> Path:
        return connectors_dir(self.config_path)

    def projection(self, manifest: dict[str, Any]) -> dict[str, Any]:
        """Bounded identity projection — no paths, no package bytes."""
        return {
            "slug": manifest["slug"],
            "displayName": manifest["display_name"],
            "version": manifest["version"],
            "manifestHash": manifest["manifest_hash"],
            "packageHash": manifest["package_hash"],
            "fileCount": manifest["file_count"],
            "entry": PurePosixPath(manifest["entry"]).name,
        }

    def preview(self, binding, package_path: str) -> dict[str, Any]:
        """Validate a candidate and project its identity; nothing is written."""
        with self._lock:
            manifest = read_package(self._picked(package_path))
            installed = self.registry.find(binding, manifest["slug"])
            projection = self.projection(manifest)
            projection["installed"] = installed is not None
            if installed is not None and installed["package_hash"] == manifest["package_hash"]:
                projection["unchanged"] = True
            return projection

    def install(self, binding, package_path: str, *, confirmed: bool = False) -> dict[str, Any]:
        """Validate, register the canonical identity, then commit locally.

        Order matters: the platform identity is traceable from the first
        install, and an unreachable platform refuses the install instead of
        leaving an untracked managed component behind.
        """
        with self._lock:
            picked = self._picked(package_path)
            manifest = read_package(picked)
            slug = manifest["slug"]
            installed = self.registry.find(binding, slug)
            if installed is not None and installed["package_hash"] == manifest["package_hash"]:
                # Same frozen content again: nothing to change, still report
                # the live identity.
                return {**self.projection(manifest), "installed": True, "unchanged": True, "state": "installed"}
            if not confirmed:
                # The read-only projection: nothing is registered and nothing
                # is written — the platform learns nothing from a preview.
                return {**self.projection(manifest), "installed": False}
            registered = None
            if self.registrar is not None:
                try:
                    registered = self.registrar(
                        slug, manifest["display_name"], manifest["version"], manifest["manifest_hash"])
                except Exception as exc:
                    # The frozen-binding conflict is its own actionable
                    # category: the same version is already bound to different
                    # content, so the device must declare a real upgrade.
                    if getattr(exc, "code", "") == "CHAT_CONFLICT":
                        raise _refuse("CONNECTOR_IDENTITY_CONFLICT") from exc
                    raise _refuse("CONNECTOR_REGISTRATION_UNAVAILABLE") from exc
                if not isinstance(registered, dict) or not isinstance(registered.get("connectorId"), str):
                    raise _refuse("CONNECTOR_REGISTRATION_UNAVAILABLE")
            target = self.store / slug
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True)
            try:
                copied: dict[str, str] = {}
                for member in sorted(picked.rglob("*")):
                    if member.is_dir():
                        (target / member.relative_to(picked)).mkdir(parents=True, exist_ok=True)
                        continue
                    destination = target / member.relative_to(picked)
                    shutil.copy2(member, destination)
                    copied[member.relative_to(picked).as_posix()] = hashlib.sha256(
                        destination.read_bytes()).hexdigest()
            except OSError:
                shutil.rmtree(target, ignore_errors=True)
                raise _refuse("CONNECTOR_INSTALL_FAILED") from None
            actual = package_hash(copied)
            if actual != manifest["package_hash"]:
                shutil.rmtree(target, ignore_errors=True)
                raise _refuse("CONNECTOR_PACKAGE_INVALID")
            self._data_dir(slug).mkdir(exist_ok=True)
            self.registry.record(binding, {
                "slug": slug,
                "display_name": manifest["display_name"],
                "version": manifest["version"],
                "manifest_hash": manifest["manifest_hash"],
                "package_hash": manifest["package_hash"],
                "entry": manifest["entry"],
                "server_connector_id": str((registered or {}).get("connectorId", ""))[:64],
            })
            self.sync_config(binding)
            return {**self.projection(manifest), "installed": True, "state": "installed",
                    "serverConnectorId": str((registered or {}).get("connectorId", ""))[:64]}

    def remove(self, binding, slug: str, *, confirmed: bool = False) -> dict[str, Any]:
        """Stop-first removal: the caller stops the server, then this commits.

        The platform identity is unregistered only after the local removal
        succeeded, so an interrupted flow never leaves a platform identity
        for a component the device no longer has.
        """
        with self._lock:
            # The slug reaches the filesystem (the managed store path); the
            # frozen shape is checked before anything else touches it.
            if not isinstance(slug, str) or not SLUG_PATTERN.fullmatch(slug):
                raise _refuse("CONNECTOR_NOT_INSTALLED")
            row = self.registry.find(binding, slug)
            if row is None:
                raise _refuse("CONNECTOR_NOT_INSTALLED")
            if not confirmed:
                return {"slug": slug, "displayName": row["display_name"]}
            target = self.store / slug
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            self.registry.remove(binding, slug)
            self.sync_config(binding)
            connector_id = row.get("server_connector_id") or ""
            if self.unregister is not None and connector_id:
                try:
                    self.unregister(connector_id)
                except Exception as exc:
                    raise _refuse("CONNECTOR_REGISTRATION_UNAVAILABLE") from exc
            return {"slug": slug, "displayName": row["display_name"], "removed": True}

    def view(self, binding) -> list[dict[str, Any]]:
        return self.registry.view(binding)

    def specs(self, binding) -> list[dict[str, Any]]:
        """One controlled MCP server entry per installed connector."""
        entries = []
        for row in self.registry.view(binding):
            entry = self.store / row["slug"]
            manifest_entry = PurePosixPath(row["entry"])
            data_root = self._data_dir(row["slug"])
            entries.append({
                "name": row["slug"],
                "transport": "stdio",
                "command": [self.interpreter, str(entry.joinpath(*manifest_entry.parts))],
                "env": {"MCP_ROOT": str(data_root)},
                "enabled": True,
            })
        return entries

    def sync_config(self, binding) -> None:
        """Write the controlled MCP configuration for the current installs."""
        path = connectors_config_path(self.config_path)
        payload = {"servers": self.specs(binding)}
        temporary = path.with_name(path.name + ".tmp")
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            temporary.replace(path)
        except OSError as exc:
            raise _refuse("CONNECTOR_INSTALL_FAILED") from exc

    def _data_dir(self, slug: str) -> Path:
        directory = self.store / slug / "data"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _picked(self, package_path: str) -> Path:
        """One user-located package path, link-free down to its root."""
        if not isinstance(package_path, str) or not package_path or len(package_path) > 32768:
            raise _refuse("CONNECTOR_PACKAGE_INVALID")
        picked = Path(package_path)
        for component in [*reversed(picked.parents), picked]:
            if not _link_free(component):
                raise _refuse("CONNECTOR_PACKAGE_INVALID")
        try:
            resolved = picked.resolve(strict=True)
        except OSError:
            raise _refuse("CONNECTOR_PACKAGE_INVALID") from None
        if resolved == self.store or self.store in resolved.parents:
            # The managed store is device-managed; a package picked from it
            # would alias the installed copy instead of a candidate.
            raise _refuse("CONNECTOR_PACKAGE_INVALID")
        return resolved
