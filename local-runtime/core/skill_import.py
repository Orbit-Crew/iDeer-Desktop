"""Explicit Desktop skill package import: device preview plus platform private draft (#120).

The user picks one Markdown file, one ZIP archive, or one directory in the
trusted main process; the device reads and validates the package locally —
illegal members (path traversal, absolute paths, links, unscanned
executables, oversized entries) are refused before a single byte leaves the
machine — and projects the upload scope: body, scripts, references, per-file
and package SHA-256. Only after the explicit confirmation are the exact bytes
uploaded: a Server preview binds the authoritative identity, and the confirm
call lands it as the account's private draft. Publication then rides the
existing draft/validate/publish flow to a version copy. The device never
executes an imported skill locally and keeps no executable channel.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sqlite3
import stat
import threading
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

from .compat import is_junction

# Frozen cross-repo contract (server backend/app/agentplatform/resources):
# the platform enforces the same shape limits and the same canonical package
# hash (relative POSIX paths, length-prefixed, sorted), so the device-side
# preview hash and the platform draft hash must coincide exactly.
MAX_PACKAGE_FILES = 1000
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024
EXECUTABLE_SUFFIXES = {".bat", ".cmd", ".com", ".dll", ".exe", ".msi", ".ps1", ".sh", ".so"}
PREVIEW_BODY_LIMIT = 20000
PREVIEW_FILE_LIMIT = 200
PACKAGE_KINDS = ("markdown", "zip", "directory")


class SkillImportError(RuntimeError):
    """A fixed-category import failure; safe to surface as an error code."""


def category_for(error: BaseException) -> str:
    """Map device-side failures onto the fixed skill-import categories."""
    if isinstance(error, SkillImportError):
        return str(error)
    return "SKILL_IMPORT_FAILED"


def _refuse(message: str) -> SkillImportError:
    return SkillImportError(message)


def _validate_picked_path(raw: Any, protected: tuple[Path, ...]) -> Path:
    """One user-picked package path, verified link-free down to its root."""
    if not isinstance(raw, str) or not raw or len(raw) > 32768 or "\x00" in raw:
        raise _refuse("SKILL_IMPORT_PATH_INVALID")
    picked = Path(raw)
    # Check every ancestor before resolve, so a junctioned selection can
    # never masquerade as a plain package (same rule as knowledge imports).
    for component in [*reversed(picked.parents), picked]:
        try:
            if component.is_symlink() or is_junction(component):
                raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
        except OSError as exc:
            raise _refuse("SKILL_IMPORT_PATH_INVALID") from exc
    try:
        resolved = picked.resolve(strict=True)
    except OSError as exc:
        # A picked path that vanished (or is unreadable) is a plain invalid
        # selection, never an unexpected crash.
        raise _refuse("SKILL_IMPORT_PATH_INVALID") from exc
    for root in protected:
        if resolved == root or root in resolved.parents:
            raise _refuse("SKILL_IMPORT_PROTECTED_PATH")
    return resolved


def _frontmatter_name_description(text: str) -> tuple[str, str]:
    """The light device-side front-matter read for the preview display.

    The Server re-validates the full enterprise front-matter contract
    authoritatively; here a missing name or description only fails the
    preview early with a fixed category.
    """
    match = re.match(r"\A---\s*\n(.*?)\n---", text, re.DOTALL)
    if match is None:
        raise _refuse("SKILL_IMPORT_INVALID_FRONTMATTER")
    name = description = ""
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if stripped.startswith("name:") and not name:
            name = stripped.split(":", 1)[1].strip().strip("'\"")
        elif stripped.startswith("description:") and not description:
            description = stripped.split(":", 1)[1].strip().strip("'\"")
    if not name or not description:
        raise _refuse("SKILL_IMPORT_INVALID_FRONTMATTER")
    return name, description


def _hash_members(members: list[tuple[str, bytes]]) -> str:
    """The canonical package hash: sorted relative POSIX paths, length-prefixed.

    This is the same algorithm the platform uses for Skill drafts and
    versions, so one hash names the same bytes on both sides.
    """
    digest = hashlib.sha256()
    for relative, data in sorted(members, key=lambda item: item[0]):
        encoded = relative.encode()
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(data)
    return digest.hexdigest()


def _member_role(relative: PurePosixPath) -> str:
    posix = relative.as_posix()
    if posix == "SKILL.md":
        return "body"
    if len(relative.parts) > 1 and relative.parts[0] == "scripts":
        return "script"
    if len(relative.parts) > 1 and relative.parts[0] == "references":
        return "reference"
    return "attachment"


def _validate_member_name(name: str) -> PurePosixPath:
    if "\\" in name:
        raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
    if relative.as_posix() != name:
        raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
    return relative


def _validate_member_content(relative: PurePosixPath, data: bytes, total: int) -> int:
    if relative.suffix.lower() in EXECUTABLE_SUFFIXES:
        raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
    if len(data) > MAX_FILE_BYTES:
        raise _refuse("SKILL_IMPORT_FILE_TOO_LARGE")
    total += len(data)
    if total > MAX_TOTAL_BYTES:
        raise _refuse("SKILL_IMPORT_PACKAGE_TOO_LARGE")
    return total


def _members_from_zip(raw: bytes) -> list[tuple[str, bytes]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile, OSError) as exc:
        raise _refuse("SKILL_IMPORT_PACKAGE_INVALID") from exc
    with archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > MAX_PACKAGE_FILES:
            raise _refuse("SKILL_IMPORT_TOO_MANY_FILES")
        members: list[tuple[str, bytes]] = []
        total = 0
        for info in infos:
            relative = _validate_member_name(info.filename)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
            data = archive.read(info)
            total = _validate_member_content(relative, data, total)
            members.append((relative.as_posix(), data))
    return members


def _members_from_directory(root: Path) -> list[tuple[str, bytes]]:
    members: list[tuple[str, bytes]] = []
    total = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if path.is_symlink() or is_junction(path):
            raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
        if path.is_dir():
            continue
        if not path.is_file():
            raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
        posix = PurePosixPath(relative.as_posix())
        if posix.suffix.lower() in EXECUTABLE_SUFFIXES:
            raise _refuse("SKILL_IMPORT_ILLEGAL_CONTENT")
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise _refuse("SKILL_IMPORT_PACKAGE_INVALID") from exc
        total = _validate_member_content(posix, data, total)
        members.append((posix.as_posix(), data))
    if len(members) > MAX_PACKAGE_FILES:
        raise _refuse("SKILL_IMPORT_TOO_MANY_FILES")
    return members


def read_package(paths: list[Any], kind: str, *, protected: tuple[Path, ...] = ()) -> dict[str, Any]:
    """Read one picked package and project its upload scope; nothing is sent.

    Markdown wraps as SKILL.md; a directory is zipped in memory with plain
    0644 members; a ZIP is validated member by member. The returned preview
    carries the canonical package hash the confirmed upload must reproduce.
    """
    if kind not in PACKAGE_KINDS:
        raise _refuse("SKILL_IMPORT_KIND_INVALID")
    if not isinstance(paths, list) or len(paths) != 1:
        raise _refuse("SKILL_IMPORT_PATH_INVALID")
    picked = _validate_picked_path(paths[0], protected)
    if kind == "markdown":
        if not picked.is_file():
            raise _refuse("SKILL_IMPORT_PATH_INVALID")
        try:
            text = picked.read_text(encoding="utf-8")
        except (UnicodeError, OSError) as exc:
            raise _refuse("SKILL_IMPORT_UNSUPPORTED_TYPE") from exc
        name, description = _frontmatter_name_description(text)
        members = [("SKILL.md", text.encode("utf-8"))]
        upload = members[0][1]
    elif kind == "zip":
        if not picked.is_file():
            raise _refuse("SKILL_IMPORT_PATH_INVALID")
        try:
            upload = picked.read_bytes()
        except OSError as exc:
            raise _refuse("SKILL_IMPORT_PACKAGE_INVALID") from exc
        if len(upload) > MAX_TOTAL_BYTES:
            raise _refuse("SKILL_IMPORT_PACKAGE_TOO_LARGE")
        members = _members_from_zip(upload)
        name, description = _members_frontmatter(members)
    else:
        if not picked.is_dir():
            raise _refuse("SKILL_IMPORT_PATH_INVALID")
        members = _members_from_directory(picked)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, data in members:
                info = zipfile.ZipInfo(relative)
                info.external_attr = 0o600 << 16  # plain 0644 after platform normalization
                archive.writestr(info, data)
        upload = buffer.getvalue()
        name, description = _members_frontmatter(members)
    if "SKILL.md" not in {relative for relative, _data in members}:
        raise _refuse("SKILL_IMPORT_MISSING_SKILL_MD")
    files = [
        {"path": relative, "role": _member_role(PurePosixPath(relative)), "bytes": len(data),
         "sha256": hashlib.sha256(data).hexdigest()}
        for relative, data in sorted(members, key=lambda item: item[0])
    ]
    return {
        "origin": kind,
        "name": name,
        "description": description,
        "body": next(data.decode("utf-8", "replace") for relative, data in members if relative == "SKILL.md")[:PREVIEW_BODY_LIMIT],
        "files": files[:PREVIEW_FILE_LIMIT],
        "file_count": len(members),
        "total_bytes": sum(len(data) for _relative, data in members),
        "package_hash": _hash_members(members),
        "upload": upload,
    }


def _members_frontmatter(members: list[tuple[str, bytes]]) -> tuple[str, str]:
    body = next((data for relative, data in members if relative == "SKILL.md"), None)
    if body is None:
        raise _refuse("SKILL_IMPORT_MISSING_SKILL_MD")
    try:
        text = body.decode("utf-8")
    except UnicodeError as exc:
        raise _refuse("SKILL_IMPORT_UNSUPPORTED_TYPE") from exc
    return _frontmatter_name_description(text)


class SkillImportRegistry:
    """Device-local display facts for one identity's explicit skill imports.

    Like every device registry, rows are binding-scoped and keep identity
    fields only: a failed attempt is recorded as failed with its real fixed
    category and never impersonates an imported draft or published version.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS skill_imports (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    resource_id TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
                    file_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = "SKILL_IMPORT_STORAGE_UNAVAILABLE"

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
                self._error = "SKILL_IMPORT_STORAGE_UNAVAILABLE"
                raise SkillImportError(self._error) from exc

    def record(self, binding, row: dict[str, Any]) -> bool:
        """Keep the first fact per (identity, attempt); later attempts win a new identity."""
        fields = {
            "resource_id": str(row.get("resource_id", ""))[:64],
            "slug": str(row.get("slug", ""))[:128],
            "revision": int(row.get("revision", 0) or 0),
            "content_hash": str(row.get("content_hash", ""))[:64],
            "version": int(row.get("version", 0) or 0),
            "origin": str(row.get("origin", ""))[:16],
            "file_count": int(row.get("file_count", 0) or 0),
            "total_bytes": int(row.get("total_bytes", 0) or 0),
            "status": row["status"] if row.get("status") in {"imported", "published"} else "failed",
            "error_code": str(row.get("error_code", ""))[:128],
        }
        fields["identity"] = hashlib.sha256(json.dumps(
            [json.dumps(binding, sort_keys=True), fields["resource_id"], fields["status"], fields["error_code"],
             fields["revision"], fields["version"], fields["content_hash"]], sort_keys=True).encode()).hexdigest()

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO skill_imports (identity, binding, resource_id, slug, revision, content_hash,"
                " version, origin, file_count, total_bytes, status, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (fields["identity"], json.dumps(binding, sort_keys=True), fields["resource_id"], fields["slug"],
                 fields["revision"], fields["content_hash"], fields["version"], fields["origin"],
                 fields["file_count"], fields["total_bytes"], fields["status"], fields["error_code"]))
            return cursor.rowcount == 1

        return self._execute(write)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {
            "id": row["identity"], "resourceId": row["resource_id"], "slug": row["slug"],
            "revision": row["revision"], "contentHash": row["content_hash"], "version": row["version"],
            "origin": row["origin"], "fileCount": row["file_count"], "totalBytes": row["total_bytes"],
            "status": row["status"], "errorCode": row["error_code"], "createdAt": row["created_at"],
        }

    def view(self, binding, limit: int = 20) -> list[dict[str, Any]]:
        """Rows for the current identity only; another account never inherits them."""

        def read(db):
            rows = db.execute("SELECT * FROM skill_imports WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                              (json.dumps(binding, sort_keys=True), int(limit))).fetchall()
            return [self._view(row) for row in rows]

        return self._execute(read)

    def mark_published(self, binding, resource_id: str, revision: int, version: int, content_hash: str) -> bool:
        """Record the version copy a successful publication produced (first fact wins)."""
        return self.record(binding, dict(resource_id=resource_id, revision=revision, version=version,
                                         content_hash=content_hash, status='published'))
