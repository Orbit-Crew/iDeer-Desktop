"""Device-local secret storage, logical references, and redaction.

Secret plaintext lives only in the device's OS secure store. Tasks and MCP
configs carry `local:<name>` references; the runtime resolves them locally and
injects the values into local process environments only. Every outbound path
(stream output, previews, receipts, error messages) is scrubbed against the
resolved values, so no plaintext ever leaves the device.
"""

from __future__ import annotations

import ctypes
import re
import sys
from collections.abc import Callable, Iterable, Mapping
from typing import Protocol, runtime_checkable

SECRET_REF_PREFIX = "local:"
SECRET_NAME_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
REDACTED = "[REDACTED]"
MIN_REDACT_LENGTH = 3


class SecretStoreError(Exception):
    """A secret operation failed; messages carry names and codes, never values."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code.lower().replace("_", " "))


class SecretNotFound(SecretStoreError):
    """A `local:<name>` reference does not exist in the store."""


class SecretBackendUnavailable(SecretStoreError):
    """The OS secure-storage backend cannot be reached on this device."""


def is_valid_secret_name(name: object) -> bool:
    return isinstance(name, str) and SECRET_NAME_PATTERN.match(name) is not None


def is_secret_ref(value: object) -> bool:
    """True only for well-formed `local:<name>` references."""
    if not isinstance(value, str) or not value.startswith(SECRET_REF_PREFIX):
        return False
    return is_valid_secret_name(value[len(SECRET_REF_PREFIX) :])


def secret_ref(name: str) -> str:
    _validate_secret_name(name)
    return f"{SECRET_REF_PREFIX}{name}"


@runtime_checkable
class SecretStore(Protocol):
    """A device-local secret backend; values never leave the device."""

    def set(self, name: str, value: str) -> None: ...

    def get(self, name: str) -> str: ...

    def delete(self, name: str) -> None: ...

    def names(self) -> tuple[str, ...]: ...


def _validate_secret_name(name: str) -> str:
    if not is_valid_secret_name(name):
        raise ValueError("secret names must use [A-Za-z0-9._-] and stay under 128 chars")
    return name


def _validate_secret_value(value: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) < MIN_REDACT_LENGTH
        or "\x00" in value
    ):
        raise ValueError(
            "secret values must be strings of at least "
            f"{MIN_REDACT_LENGTH} characters without NUL"
        )
    return value


class InMemorySecretStore:
    """Process-local backend for tests and smoke runs; nothing is persisted."""

    def __init__(self) -> None:
        self._values: dict[str, str] = {}

    def set(self, name: str, value: str) -> None:
        _validate_secret_name(name)
        self._values[name] = _validate_secret_value(value)

    def get(self, name: str) -> str:
        _validate_secret_name(name)
        try:
            return self._values[name]
        except KeyError:
            raise SecretNotFound(
                "SECRET_REF_NOT_FOUND", f"secret {name!r} is not stored on this device"
            ) from None

    def delete(self, name: str) -> None:
        _validate_secret_name(name)
        if name not in self._values:
            raise SecretNotFound(
                "SECRET_REF_NOT_FOUND", f"secret {name!r} is not stored on this device"
            )
        del self._values[name]

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._values))


class _CREDENTIAL(ctypes.Structure):
    """CREDENTIALW from wincred.h; FILETIME is kept as two DWORDs."""

    _fields_ = [
        ("Flags", ctypes.c_uint32),
        ("Type", ctypes.c_uint32),
        ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p),
        ("LastWritten", ctypes.c_uint32 * 2),
        ("CredentialBlobSize", ctypes.c_uint32),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", ctypes.c_uint32),
        ("AttributeCount", ctypes.c_uint32),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


class WindowsCredentialStore:
    """Windows Credential Manager backend for generic credentials."""

    _TARGET_PREFIX = "IdeerLocalRuntime/"
    _CRED_TYPE_GENERIC = 1
    _CRED_PERSIST_LOCAL_MACHINE = 2
    _ERROR_NOT_FOUND = 1168

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE",
                "the Windows credential backend requires Windows",
            )
        try:
            self._advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        except OSError as exc:
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE", "advapi32 is unavailable"
            ) from exc
        self._advapi32.CredReadW.argtypes = [
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self._advapi32.CredWriteW.argtypes = [ctypes.POINTER(_CREDENTIAL), ctypes.c_uint32]
        self._advapi32.CredDeleteW.argtypes = [
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
        ]
        self._advapi32.CredEnumerateW.argtypes = [
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_void_p),
        ]

    def _target(self, name: str) -> str:
        _validate_secret_name(name)
        return f"{self._TARGET_PREFIX}{name}"

    def set(self, name: str, value: str) -> None:
        blob = _validate_secret_value(value).encode("utf-8")
        buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        credential = _CREDENTIAL(
            Flags=0,
            Type=self._CRED_TYPE_GENERIC,
            TargetName=self._target(name),
            Comment="iDeer Local Runtime secret",
            LastWritten=(ctypes.c_uint32 * 2)(0, 0),
            CredentialBlobSize=len(blob),
            CredentialBlob=ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
            Persist=self._CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount=0,
            Attributes=None,
            TargetAlias=None,
            UserName=None,
        )
        if not self._advapi32.CredWriteW(ctypes.byref(credential), 0):
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE",
                f"credential write failed (winerror {ctypes.get_last_error()})",
            )

    def get(self, name: str) -> str:
        target = self._target(name)
        credential_ptr = ctypes.c_void_p()
        if not self._advapi32.CredReadW(
            target, self._CRED_TYPE_GENERIC, 0, ctypes.byref(credential_ptr)
        ):
            error = ctypes.get_last_error()
            if error == self._ERROR_NOT_FOUND:
                raise SecretNotFound(
                    "SECRET_REF_NOT_FOUND", f"secret {name!r} is not stored on this device"
                )
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE",
                f"credential read failed (winerror {error})",
            )
        try:
            credential = ctypes.cast(credential_ptr, ctypes.POINTER(_CREDENTIAL)).contents
            size = credential.CredentialBlobSize
            if not size:
                raise SecretStoreError("SECRET_BACKEND_UNAVAILABLE", "stored secret is empty")
            blob = bytes(
                ctypes.cast(
                    credential.CredentialBlob, ctypes.POINTER(ctypes.c_ubyte * size)
                ).contents
            )
        finally:
            self._advapi32.CredFree(credential_ptr)
        try:
            return blob.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SecretStoreError(
                "SECRET_BACKEND_UNAVAILABLE", "stored secret is not valid UTF-8"
            ) from exc

    def delete(self, name: str) -> None:
        target = self._target(name)
        if not self._advapi32.CredDeleteW(target, self._CRED_TYPE_GENERIC, 0):
            error = ctypes.get_last_error()
            if error == self._ERROR_NOT_FOUND:
                raise SecretNotFound(
                    "SECRET_REF_NOT_FOUND", f"secret {name!r} is not stored on this device"
                )
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE",
                f"credential delete failed (winerror {error})",
            )

    def names(self) -> tuple[str, ...]:
        count = ctypes.c_uint32()
        credentials_ptr = ctypes.c_void_p()
        if not self._advapi32.CredEnumerateW(
            f"{self._TARGET_PREFIX}*",
            0,
            ctypes.byref(count),
            ctypes.byref(credentials_ptr),
        ):
            error = ctypes.get_last_error()
            if error == self._ERROR_NOT_FOUND:
                return ()
            raise SecretBackendUnavailable(
                "SECRET_BACKEND_UNAVAILABLE",
                f"credential enumeration failed (winerror {error})",
            )
        try:
            entries = ctypes.cast(
                credentials_ptr, ctypes.POINTER(ctypes.c_void_p * count.value)
            ).contents
            names = []
            for entry in entries:
                credential = ctypes.cast(entry, ctypes.POINTER(_CREDENTIAL)).contents
                target = credential.TargetName or ""
                if target.startswith(self._TARGET_PREFIX):
                    names.append(target[len(self._TARGET_PREFIX) :])
            return tuple(sorted(names))
        finally:
            self._advapi32.CredFree(credentials_ptr)


def create_default_secret_store() -> SecretStore:
    """Pick the OS secure store; fail closed when none exists on this platform."""
    if sys.platform == "win32":
        return WindowsCredentialStore()
    raise SecretBackendUnavailable(
        "SECRET_BACKEND_UNAVAILABLE",
        f"no OS secure store is available on {sys.platform}",
    )


class SecretRedactor:
    """Scrub known plaintext values out of any text leaving the device."""

    def __init__(self, values: Iterable[str] = ()) -> None:
        known = sorted(
            {value for value in values if isinstance(value, str) and len(value) >= MIN_REDACT_LENGTH},
            key=len,
            reverse=True,
        )
        self._pattern = (
            re.compile("|".join(re.escape(value) for value in known)) if known else None
        )
        # known is sorted by length descending, so known[0] is the longest.
        self.longest = len(known[0]) if known else 0

    def redact(self, text: str) -> str:
        if self._pattern is None:
            return text
        return self._pattern.sub(REDACTED, text)


class ResolvedSecrets:
    """Resolved injection material; repr and str never expose values."""

    __slots__ = ("environment", "_redactor")

    def __init__(self, environment: Mapping[str, str]) -> None:
        self.environment: Mapping[str, str] = dict(environment)
        self._redactor = SecretRedactor(self.environment.values())

    def redact(self, text: str) -> str:
        return self._redactor.redact(text)

    def __repr__(self) -> str:
        names = ", ".join(self.environment)
        return f"ResolvedSecrets({names or 'no secrets'}) [REDACTED]"

    __str__ = __repr__


def _validate_env_name(name: str) -> str:
    if not name or "=" in name or "\x00" in name:
        raise ValueError("secret environment names must be valid variable names")
    return name


class SecretResolver:
    """Resolves `local:<name>` references against a device-local store.

    ``on_use`` is notified with the *names* every time references are actually
    resolved, so the runtime can audit secret usage at the moment it happens
    without the callback ever seeing a value.
    """

    def __init__(
        self,
        store: SecretStore,
        *,
        on_use: Callable[[tuple[str, ...]], None] | None = None,
    ) -> None:
        self.store = store
        self._on_use = on_use

    def _note_use(self, names: Iterable[str]) -> None:
        if self._on_use is None:
            return
        self._on_use(tuple(sorted(set(names))))

    def resolve(self, ref: str) -> str:
        if not is_secret_ref(ref):
            raise ValueError(f"{ref!r} is not a local: secret reference")
        name = ref[len(SECRET_REF_PREFIX) :]
        value = self.store.get(name)
        self._note_use([name])
        return value


    def name_lookup(self) -> Callable[[str], str | None]:
        """Adapter for seams that ask by bare secret name.

        Consumers such as the MCP supervisor receive ``Callable[[name],
        value-or-None]``; a missing reference or an unavailable backend maps
        to ``None`` so the caller applies its own fail-closed semantics.
        """

        def lookup(name: str) -> str | None:
            try:
                return self.store.get(name)
            except SecretStoreError:
                return None

        return lookup

    def resolve_environment(self, env: Mapping[str, str]) -> ResolvedSecrets:
        """Resolve an `{env name: secret ref}` mapping; any failure aborts all."""
        resolved: dict[str, str] = {}
        for name, ref in env.items():
            _validate_env_name(name)
            if not is_secret_ref(ref):
                raise ValueError(
                    f"secret environment values must use {SECRET_REF_PREFIX} references"
                )
            resolved[name] = self.resolve(ref)
        return ResolvedSecrets(resolved)
