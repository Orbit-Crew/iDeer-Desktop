from __future__ import annotations

import ctypes
import os
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest

from core.files import (
    OUTSIDE_ALLOWED_ROOTS,
    FileAccessError,
    LocalFileStore,
    RootConfig,
)


@pytest.mark.parametrize(
    "logical_root",
    [
        "/",
        "/../outside",
        "/projects/./nested",
        "/projects//nested",
        "/projects/C:",
        r"\\server\share",
    ],
)
def test_root_names_must_be_logical_names(tmp_path: Path, logical_root: str) -> None:
    with pytest.raises(ValueError, match="logical root must be named"):
        RootConfig(logical_root, tmp_path)


def test_list_and_read_expose_only_logical_paths(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    (root / "hello.txt").write_text("hello", encoding="utf-8")
    store = LocalFileStore([RootConfig("/projects", root)])

    assert store.list("/projects") == ["/projects/hello.txt"]
    assert store.read("/projects/hello.txt") == "hello"


def test_windows_list_rejects_reparse_point_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows listing vets entries through their reparse tags, so a junction
    never surfaces through the logical view even when it stays in-root. The
    check is exercisable on every host by faking the scandir results."""
    root = tmp_path / "Projects"
    root.mkdir()

    class FakeStat:
        st_mode = stat.S_IFDIR
        st_reparse_tag = 0xA0000003  # IO_REPARSE_TAG_MOUNT_POINT (junction)

    class FakeEntry:
        name = "junction"

        def stat(self, *, follow_symlinks: bool = True) -> FakeStat:
            return FakeStat()

    class FakeScan:
        def __init__(self, entries: list[FakeEntry]) -> None:
            self._entries = entries

        def __enter__(self) -> Iterator[FakeEntry]:
            return iter(self._entries)

        def __exit__(self, *_exc: object) -> bool:
            return False

    monkeypatch.setattr(os, "scandir", lambda path: FakeScan([FakeEntry()]))
    # RootConfig must be built before os.name is patched: Path() instantiates
    # the platform class of the patched os.name.
    store = LocalFileStore([RootConfig("/projects", root)])
    monkeypatch.setattr(os, "name", "nt")

    with pytest.raises(FileAccessError) as error:
        store.list("/projects")
    assert error.value.code == OUTSIDE_ALLOWED_ROOTS


@pytest.mark.parametrize(
    ("path", "error"),
    [
        ("/projects/../secret.txt", "outside allowed roots"),
        ("/projects/hello.txt/../../secret", "outside allowed roots"),
        ("/PROJECTS-OTHER/secret.txt", "outside allowed roots"),
        ("//server/share/secret.txt", "outside allowed roots"),
        ("\\\\server\\share\\secret.txt", "invalid logical path"),
        ("/projects/C:/Windows/System32/config", "invalid logical path"),
        ("/projects/bad\x00name", "invalid logical path"),
    ],
)
def test_unsafe_paths_are_rejected(tmp_path: Path, path: str, error: str) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    store = LocalFileStore([RootConfig("/projects", root)])

    with pytest.raises(FileAccessError, match=error):
        store.read(path)


def test_logical_root_matching_uses_windows_case_semantics_on_every_host(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    store = LocalFileStore([RootConfig("/projects", root)])

    assert store.resolve("/PROJECTS") == root


@pytest.mark.skipif(os.name != "nt", reason="requires Windows path semantics")
def test_case_variant_file_inside_root_is_read_on_windows(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    (root / "ReadMe.txt").write_text("safe", encoding="utf-8")
    store = LocalFileStore([RootConfig("/projects", root)])

    assert store.read("/PROJECTS/README.TXT") == "safe"


@pytest.mark.skipif(os.name != "nt", reason="requires Windows junctions")
def test_junction_escape_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    outside = tmp_path / "Outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")
    junction = root / "linked"
    result = os.system(f'cmd /c mklink /J "{junction}" "{outside}" >NUL')
    if result != 0:
        pytest.skip("junction creation is unavailable")
    store = LocalFileStore([RootConfig("/projects", root)])

    with pytest.raises(FileAccessError, match="outside allowed roots"):
        store.read("/projects/linked/secret.txt")


@pytest.mark.skipif(os.name != "nt", reason="requires Windows exclusive file handles")
def test_locked_file_has_safe_error_without_drive_path(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    locked = root / "locked.txt"
    locked.write_text("secret", encoding="utf-8")
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(str(locked), 0x80000000, 0, None, 3, 0, None)
    if handle == ctypes.c_void_p(-1).value:
        pytest.skip("exclusive handle could not be created")
    try:
        store = LocalFileStore([RootConfig("/projects", root)])
        with pytest.raises(FileAccessError) as error:
            store.read("/projects/locked.txt")
        assert str(tmp_path).lower() not in str(error.value).lower()
    finally:
        kernel32.CloseHandle(handle)


def test_symlink_escape_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    link = root / "link.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are unavailable on this platform")
    store = LocalFileStore([RootConfig("/projects", root)])

    with pytest.raises(FileAccessError, match="outside allowed roots"):
        store.read("/projects/link.txt")


def test_symlink_inside_allowed_root_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    target = root / "real"
    target.mkdir()
    (target / "value.txt").write_text("safe", encoding="utf-8")
    link = root / "alias"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are unavailable on this platform")
    store = LocalFileStore([RootConfig("/projects", root)])

    with pytest.raises(FileAccessError) as error:
        store.read("/projects/alias/value.txt")
    assert error.value.code == OUTSIDE_ALLOWED_ROOTS


def test_errors_do_not_reveal_physical_paths(tmp_path: Path) -> None:
    store = LocalFileStore([RootConfig("/projects", tmp_path / "missing")])

    with pytest.raises(FileAccessError) as error:
        store.read("/projects/nope.txt")
    assert str(tmp_path) not in str(error.value)
