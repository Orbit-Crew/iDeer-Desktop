"""Windows file handles pinned against rename and reparse-point replacement."""
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import os


@contextmanager
def pinned(path, *, root=None):
    """Pin all ancestors without FILE_SHARE_DELETE before using a Win32 path."""
    from .files import FileAccessError
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
    handles = []
    try:
        for part in [*reversed(path.parents), path]:
            handle = kernel.CreateFileW(str(part), 0x80000000 if part == path and not path.is_dir() else 0x80, 3, None, 3,
                                        0x02000000 | 0x00200000, None)
            if handle == wintypes.HANDLE(-1).value:
                code = ctypes.get_last_error()
                raise FileAccessError({2: 'NOT_FOUND', 3: 'NOT_FOUND', 5: 'PERMISSION_DENIED'}.get(code, 'LOCKED_OR_UNAVAILABLE'))
            handles.append(handle)
            info = ctypes.create_string_buffer(52)
            if not kernel.GetFileInformationByHandle(handle, info):
                raise FileAccessError('LOCKED_OR_UNAVAILABLE')
            attributes = int.from_bytes(info.raw[:4], 'little')
            if attributes & 0x400:
                raise FileAccessError('OUTSIDE_ALLOWED_ROOTS')
        if root is not None and root.identity is not None:
            info = os.stat(root.physical_root, follow_symlinks=False)
            if (info.st_dev, info.st_ino) != root.identity:
                raise FileAccessError('WORKSPACE_UNAVAILABLE')
        yield handles[-1]
    finally:
        for handle in reversed(handles):
            kernel.CloseHandle(handle)


def open_read(path, *, root=None):
    import msvcrt
    # Duplicate the vetted file handle; all ancestors stay pinned until the
    # handle is duplicated, and later replacements cannot redirect this read.
    with pinned(path, root=root) as handle:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE,
            wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
            wintypes.BOOL, wintypes.DWORD]
        duplicate = wintypes.HANDLE()
        process = kernel.GetCurrentProcess()
        if not kernel.DuplicateHandle(process, handle, process, ctypes.byref(duplicate), 0, False, 2):
            from .files import FileAccessError
            raise FileAccessError('LOCKED_OR_UNAVAILABLE')
        return msvcrt.open_osfhandle(duplicate.value, os.O_RDONLY | os.O_BINARY)

