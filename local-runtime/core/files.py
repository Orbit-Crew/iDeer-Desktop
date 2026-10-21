"""Safe logical-root file operations for the local runtime."""

from __future__ import annotations

import os
import posixpath
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .compat import is_junction


class FileAccessError(Exception):
    """A user-safe file error; physical paths are never included."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code.lower().replace("_", " "))


INVALID_PATH = "INVALID_PATH"
OUTSIDE_ALLOWED_ROOTS = "OUTSIDE_ALLOWED_ROOTS"
NOT_FOUND = "NOT_FOUND"
NOT_A_FILE = "NOT_A_FILE"
NOT_A_DIRECTORY = "NOT_A_DIRECTORY"
PERMISSION_DENIED = "PERMISSION_DENIED"
LOCKED_OR_UNAVAILABLE = "LOCKED_OR_UNAVAILABLE"


@dataclass(frozen=True)
class RootConfig:
    logical_root: str
    physical_root: Path
    identity: tuple[int, int] | None = None
    resolve_root: bool = True

    def __post_init__(self) -> None:
        logical = "/" + self.logical_root.strip("/")
        parts = logical.split("/")
        if (
            logical == "/"
            or "\\" in logical
            or any(not part or part in {".", ".."} or ":" in part for part in parts[1:])
        ):
            raise ValueError("logical root must be named")
        object.__setattr__(self, "logical_root", logical)
        object.__setattr__(
            self, "physical_root", Path(self.physical_root).resolve(strict=False) if self.resolve_root else Path(self.physical_root).absolute()
        )


class LocalFileStore:
    def __init__(self, roots: list[RootConfig] | tuple[RootConfig, ...]) -> None:
        self.roots = tuple(roots)

    def _resolve(self, logical_path: str) -> tuple[RootConfig, Path]:
        if (
            not isinstance(logical_path, str)
            or not logical_path.startswith("/")
            or "\\" in logical_path
            or "\x00" in logical_path
        ):
            raise FileAccessError(INVALID_PATH, "invalid logical path")
        if logical_path.startswith("//"):
            raise FileAccessError(INVALID_PATH, "outside allowed roots")
        parts = logical_path.split("/")
        if any(part == ".." for part in parts):
            raise FileAccessError(OUTSIDE_ALLOWED_ROOTS, "outside allowed roots")
        if any(":" in part for part in parts[1:]):
            raise FileAccessError(INVALID_PATH, "invalid logical path")
        normalized = posixpath.normpath(logical_path)
        normalized_key = normalized.casefold()
        matches = [
            r
            for r in self.roots
            if normalized_key == r.logical_root.casefold()
            or normalized_key.startswith(r.logical_root.casefold() + "/")
        ]
        if not matches:
            raise FileAccessError(OUTSIDE_ALLOWED_ROOTS, "outside allowed roots")
        root = max(matches, key=lambda item: len(item.logical_root))
        suffix = normalized[len(root.logical_root) :].lstrip("/")
        self._reject_link_components(root.physical_root, suffix)
        try:
            candidate = (root.physical_root / suffix).resolve(strict=False)
        except (OSError, RuntimeError) as exc:
            raise FileAccessError(
                LOCKED_OR_UNAVAILABLE, "locked or unavailable"
            ) from exc
        try:
            candidate.relative_to(root.physical_root)
        except ValueError as exc:
            raise FileAccessError(
                OUTSIDE_ALLOWED_ROOTS, "outside allowed roots"
            ) from exc
        return root, candidate

    @staticmethod
    def _reject_link_components(root: Path, suffix: str) -> None:
        """Reject links before canonicalisation, including links that stay in-root."""
        current = root
        try:
            root_stat = os.lstat(current)
            if (stat.S_ISLNK(root_stat.st_mode)
                    or getattr(root_stat, "st_reparse_tag", 0)
                    or getattr(root_stat, "st_file_attributes", 0) & 0x400
                    or is_junction(current)):
                raise FileAccessError(OUTSIDE_ALLOWED_ROOTS, "outside allowed roots")
            for component in filter(None, suffix.split("/")):
                current = current / component
                try:
                    item_stat = os.lstat(current)
                except FileNotFoundError:
                    break
                if (stat.S_ISLNK(item_stat.st_mode)
                        or getattr(item_stat, "st_reparse_tag", 0)
                        or getattr(item_stat, "st_file_attributes", 0) & 0x400
                        or is_junction(current)):
                    raise FileAccessError(
                        OUTSIDE_ALLOWED_ROOTS, "outside allowed roots"
                    )
        except FileAccessError:
            raise
        except FileNotFoundError as exc:
            raise FileAccessError(NOT_FOUND, "not found") from exc
        except PermissionError as exc:
            raise FileAccessError(PERMISSION_DENIED, "permission denied") from exc
        except OSError as exc:
            raise FileAccessError(
                LOCKED_OR_UNAVAILABLE, "locked or unavailable"
            ) from exc

    def resolve(self, logical_path: str) -> Path:
        """Resolve a logical path for an internal executor without exposing it."""
        return self._resolve(logical_path)[1]

    def list(self, logical_path: str, *, max_entries: int = -1) -> list[str]:
        root, path = self._resolve(logical_path)
        try:
            if os.name == "nt":
                from .files_nt import pinned
                if __import__("sys").platform == "win32":
                    with pinned(path, root=root):
                        return self._list_nt(root, path, max_entries=max_entries)
                return self._list_nt(root, path, max_entries=max_entries)
            directory_fd = self._open_directory(root, path)
            entries: list[str] = []
            try:
                with os.scandir(directory_fd) as scan:
                    names = []
                    for item in scan:
                        names.append(item.name)
                        if max_entries >= 0 and len(names) >= max_entries:
                            break
                for name in names:
                    item = path / name
                    try:
                        item_stat = os.stat(
                            name, dir_fd=directory_fd, follow_symlinks=False
                        )
                    except FileNotFoundError as exc:
                        raise FileAccessError(
                            LOCKED_OR_UNAVAILABLE, "locked or unavailable"
                        ) from exc
                    if stat.S_ISLNK(item_stat.st_mode):
                        raise FileAccessError(
                            OUTSIDE_ALLOWED_ROOTS, "outside allowed roots"
                        )
                    relative = item.relative_to(root.physical_root)
                    entries.append(f"{root.logical_root}/{relative.as_posix()}")
            finally:
                os.close(directory_fd)
            return sorted(entries)
        except FileAccessError:
            raise
        except PermissionError as exc:
            raise FileAccessError(PERMISSION_DENIED, "permission denied") from exc
        except OSError as exc:
            raise FileAccessError(
                LOCKED_OR_UNAVAILABLE, "locked or unavailable"
            ) from exc

    def read(self, logical_path: str) -> str:
        root, path = self._resolve(logical_path)
        try:
            fd = self._open_file(root, path, os.O_RDONLY)
            with os.fdopen(fd, "r", encoding="utf-8") as stream:
                return stream.read()
        except FileNotFoundError as exc:
            raise FileAccessError(NOT_FOUND, "not found") from exc
        except IsADirectoryError as exc:
            raise FileAccessError(NOT_A_FILE, "not a file") from exc
        except PermissionError as exc:
            raise FileAccessError(PERMISSION_DENIED, "permission denied") from exc
        except OSError as exc:
            if getattr(exc, "errno", None) in {40, 62}:
                raise FileAccessError(
                    OUTSIDE_ALLOWED_ROOTS, "outside allowed roots"
                ) from exc
            raise FileAccessError(
                LOCKED_OR_UNAVAILABLE, "locked or unavailable"
            ) from exc

    def read_bytes(self, logical_path: str, *, max_bytes: int = -1) -> bytes:
        root, path = self._resolve(logical_path)
        try:
            fd = self._open_file(root, path, os.O_RDONLY)
            with os.fdopen(fd, "rb") as stream:
                return stream.read(max_bytes)
        except FileNotFoundError as exc:
            raise FileAccessError(NOT_FOUND, "not found") from exc
        except IsADirectoryError as exc:
            raise FileAccessError(NOT_A_FILE, "not a file") from exc
        except PermissionError as exc:
            raise FileAccessError(PERMISSION_DENIED, "permission denied") from exc
        except OSError as exc:
            if getattr(exc, "errno", None) in {40, 62}:
                raise FileAccessError(
                    OUTSIDE_ALLOWED_ROOTS, "outside allowed roots"
                ) from exc
            raise FileAccessError(
                LOCKED_OR_UNAVAILABLE, "locked or unavailable"
            ) from exc

    def write(self, logical_path: str, content: str) -> None:
        root, path = self._resolve(logical_path)
        if path.exists() and not path.is_file():
            raise FileAccessError(NOT_A_FILE, "not a file")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                fd, temporary = tempfile.mkstemp(
                    prefix=".local-write-", dir=path.parent
                )
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, path)
                except BaseException:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
                    raise
                return
            parent_fd = self._open_directory(root, path.parent)
            temporary_fd, temporary_name = self._mkstemp_at(parent_fd)
            try:
                with os.fdopen(temporary_fd, "w", encoding="utf-8") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(
                    temporary_name,
                    path.name,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                )
            except BaseException:
                try:
                    os.unlink(temporary_name, dir_fd=parent_fd)
                except OSError:
                    pass
                raise
            finally:
                os.close(parent_fd)
        except PermissionError as exc:
            raise FileAccessError(PERMISSION_DENIED, "permission denied") from exc
        except OSError as exc:
            raise FileAccessError(
                LOCKED_OR_UNAVAILABLE, "locked or unavailable"
            ) from exc

    @staticmethod
    def _list_nt(root: RootConfig, path: Path, *, max_entries: int = -1) -> list[str]:
        """Enumerate a resolved directory on Windows.

        Directory descriptors and dir_fd calls are POSIX-only, so entries are
        vetted through lstat reparse tags instead: a symlink or a junction —
        including one that stays inside the root, and any other reparse point
        (such as a cloud placeholder) — must never surface through the logical
        view.
        """
        entries: list[str] = []
        with os.scandir(path) as scan:
            for entry in scan:
                item_stat = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(item_stat.st_mode) or item_stat.st_reparse_tag:
                    raise FileAccessError(
                        OUTSIDE_ALLOWED_ROOTS, "outside allowed roots"
                    )
                relative = (path / entry.name).relative_to(root.physical_root)
                entries.append(f"{root.logical_root}/{relative.as_posix()}")
                if max_entries >= 0 and len(entries) >= max_entries:
                    break
        return sorted(entries)

    @staticmethod
    def _open_directory(root: RootConfig, path: Path) -> int:
        """Open every path component from the physical root, POSIX only."""
        relative = path.relative_to(root.physical_root)
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(root.physical_root.anchor, flags)
        try:
            # Anchor absolute ancestors as well as workspace-relative segments.
            # Replacing a parent of the selected root must not redirect reads.
            for component in root.physical_root.parts[1:]:
                next_fd = os.open(component, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            if root.identity is not None and (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != root.identity:
                raise FileAccessError("WORKSPACE_UNAVAILABLE")
            for component in relative.parts:
                next_fd = os.open(
                    component,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=fd,
                )
                os.close(fd)
                fd = next_fd
            return fd
        except BaseException:
            os.close(fd)
            raise

    @classmethod
    def _open_file(cls, root: RootConfig, path: Path, flags: int) -> int:
        if os.name == "nt":
            if flags == os.O_RDONLY:
                from .files_nt import open_read
                return open_read(path, root=root)
            return os.open(path, flags)
        parent_fd = cls._open_directory(root, path.parent)
        try:
            return os.open(
                path.name, flags | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd
            )
        finally:
            os.close(parent_fd)

    @staticmethod
    def _mkstemp_at(parent_fd: int) -> tuple[int, str]:
        for _ in range(100):
            name = f".local-write-{next(tempfile._get_candidate_names())}"
            try:
                return os.open(
                    name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd
                ), name
            except FileExistsError:
                continue
        raise FileAccessError(LOCKED_OR_UNAVAILABLE, "locked or unavailable")
