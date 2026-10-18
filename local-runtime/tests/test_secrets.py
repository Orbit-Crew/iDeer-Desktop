"""Local secret store, logical references, and the full-chain redaction gate."""

from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

import pytest
from core.cli import main as runtime_cli
from core.files import LocalFileStore, RootConfig
from core.policy import LocalPolicy
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.python import LocalPythonService, PythonTaskStatus
from core.secrets import (
    InMemorySecretStore,
    ResolvedSecrets,
    SecretBackendUnavailable,
    SecretNotFound,
    SecretRedactor,
    SecretResolver,
    SecretStore,
    WindowsCredentialStore,
    create_default_secret_store,
    is_secret_ref,
    secret_ref,
)
from core.transport import LocalRuntimeClient
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

TOKEN = "ghp_supersecrettokenvalue123"
OTHER_TOKEN = "ssh-rsa othersshkeymaterial456"


class UnavailableStore:
    """A store whose OS backend cannot be reached."""

    def set(self, name: str, value: str) -> None:
        raise SecretBackendUnavailable("SECRET_BACKEND_UNAVAILABLE", "backend down")

    def get(self, name: str) -> str:
        raise SecretBackendUnavailable("SECRET_BACKEND_UNAVAILABLE", "backend down")

    def delete(self, name: str) -> None:
        raise SecretBackendUnavailable("SECRET_BACKEND_UNAVAILABLE", "backend down")

    def names(self) -> tuple[str, ...]:
        raise SecretBackendUnavailable("SECRET_BACKEND_UNAVAILABLE", "backend down")


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)


def store_with(**secrets: str) -> InMemorySecretStore:
    store = InMemorySecretStore()
    for name, value in secrets.items():
        store.set(name, value)
    return store


def always_allow_python() -> LocalPolicy:
    return LocalPolicy(always_allow_capabilities=frozenset({"local.python"}))


def sign_server_task(
    server_key: Ed25519PrivateKey,
    task_id: str,
    payload: dict[str, object],
) -> dict[str, object]:
    return sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id=task_id,
        payload=payload,
    )


# ---------------------------------------------------------------------------
# Secret store backends


def test_memory_store_round_trips_values_without_exposing_them_in_names() -> None:
    store = store_with(**{"git.company": TOKEN, "ssh.projectA": OTHER_TOKEN})

    assert store.names() == ("git.company", "ssh.projectA")
    assert store.get("git.company") == TOKEN
    store.set("git.company", "rotated-value-789")
    assert store.get("git.company") == "rotated-value-789"
    store.delete("git.company")
    assert store.names() == ("ssh.projectA",)


def test_memory_store_rejects_empty_values_and_invalid_names() -> None:
    store = InMemorySecretStore()
    with pytest.raises(ValueError):
        store.set("git.company", "")
    for bad_name in ("", "has space", "with:colon", "with/slash", "a" * 129):
        with pytest.raises(ValueError):
            store.set(bad_name, "value")


def test_store_rejects_values_shorter_than_the_redaction_floor() -> None:
    # Every stored value must be scrubbed from output; a value below the
    # redactor's floor would leak verbatim, so it is refused at write time.
    store = InMemorySecretStore()
    with pytest.raises(ValueError, match="at least 3"):
        store.set("git.company", "ab")


def test_memory_store_missing_secret_raises_typed_not_found() -> None:
    store = InMemorySecretStore()
    with pytest.raises(SecretNotFound) as excinfo:
        store.get("git.company")
    assert excinfo.value.code == "SECRET_REF_NOT_FOUND"
    with pytest.raises(SecretNotFound):
        store.delete("git.company")


def test_memory_store_satisfies_store_protocol() -> None:
    assert isinstance(store_with(git=TOKEN), SecretStore)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Credential Manager")
def test_windows_credential_store_round_trip() -> None:
    store = WindowsCredentialStore()
    store.set("git.company", TOKEN)
    try:
        assert store.get("git.company") == TOKEN
        assert "git.company" in store.names()
    finally:
        store.delete("git.company")
    with pytest.raises(SecretNotFound):
        store.get("git.company")


@pytest.mark.skipif(sys.platform == "win32", reason="requires a non-Windows host")
def test_default_store_is_unavailable_without_an_os_backend() -> None:
    with pytest.raises(SecretBackendUnavailable) as excinfo:
        create_default_secret_store()
    assert excinfo.value.code == "SECRET_BACKEND_UNAVAILABLE"


# ---------------------------------------------------------------------------
# Logical references


@pytest.mark.parametrize(
    ("value", "expected"),
    (
        ("local:git.company", True),
        ("local:ssh.projectA", True),
        ("local:A_b-1.d", True),
        ("local:", False),
        ("local:has space", False),
        ("local:two:colons", False),
        ("locally:wrong", False),
        ("file:git.company", False),
        ("plaintext", False),
        ("", False),
        (None, False),
        (7, False),
    ),
)
def test_is_secret_ref_accepts_only_well_formed_references(
    value: object, expected: bool
) -> None:
    assert is_secret_ref(value) is expected


def test_secret_ref_renders_the_logical_reference_form() -> None:
    assert secret_ref("git.company") == "local:git.company"


# ---------------------------------------------------------------------------
# Resolution and redaction


def test_resolver_resolves_references_to_local_plaintext() -> None:
    resolver = SecretResolver(store_with(**{"git.company": TOKEN}))
    assert resolver.resolve("local:git.company") == TOKEN


def test_resolver_reports_missing_references_without_a_value_fallback() -> None:
    resolver = SecretResolver(InMemorySecretStore())
    with pytest.raises(SecretNotFound) as excinfo:
        resolver.resolve("local:git.company")
    assert excinfo.value.code == "SECRET_REF_NOT_FOUND"


def test_resolver_maps_environment_names_to_resolved_values() -> None:
    resolver = SecretResolver(store_with(**{"git.company": TOKEN}))
    resolved = resolver.resolve_environment({"GIT_TOKEN": "local:git.company"})
    assert resolved.environment == {"GIT_TOKEN": TOKEN}
    assert isinstance(resolved, ResolvedSecrets)


def test_resolver_rejects_literal_values_inside_secret_slots() -> None:
    resolver = SecretResolver(store_with(**{"git.company": TOKEN}))
    with pytest.raises(ValueError, match="local:"):
        resolver.resolve_environment({"GIT_TOKEN": TOKEN})


def test_resolver_surfaces_backend_unavailability() -> None:
    resolver = SecretResolver(UnavailableStore())
    with pytest.raises(SecretBackendUnavailable):
        resolver.resolve_environment({"GIT_TOKEN": "local:git.company"})


def test_resolved_secrets_repr_never_carries_plaintext() -> None:
    resolved = SecretResolver(store_with(**{"git.company": TOKEN})).resolve_environment(
        {"GIT_TOKEN": "local:git.company"}
    )
    assert TOKEN not in repr(resolved)
    assert TOKEN not in str(resolved)


def test_redactor_scrubs_known_values_longest_first() -> None:
    redactor = SecretRedactor([TOKEN, OTHER_TOKEN, "token123"])
    scrubbed = redactor.redact(f"head {TOKEN} middle {OTHER_TOKEN} token123 tail")
    assert TOKEN not in scrubbed
    assert OTHER_TOKEN not in scrubbed
    assert "token123" not in scrubbed
    assert scrubbed.count("[REDACTED]") == 3


def test_redactor_leaves_unrelated_text_untouched() -> None:
    redactor = SecretRedactor([TOKEN])
    text = "nothing to see here"
    assert redactor.redact(text) == text


def test_redactor_ignores_degenerate_values() -> None:
    redactor = SecretRedactor(["a", "", "  "])
    assert redactor.redact("a short line") == "a short line"


# ---------------------------------------------------------------------------
# CLI surface (write / rotate / delete / list)


@pytest.fixture()
def cli_store() -> InMemorySecretStore:
    return InMemorySecretStore()


def test_cli_set_list_rotate_and_delete_round_trip(cli_store: InMemorySecretStore) -> None:
    assert runtime_cli(["secret-set", "git.company", "--value", TOKEN], store=cli_store) == 0
    assert runtime_cli(["secret-list"], store=cli_store) == 0
    assert runtime_cli(
        ["secret-rotate", "git.company", "--value", "rotated-456"], store=cli_store
    ) == 0
    assert cli_store.get("git.company") == "rotated-456"
    assert runtime_cli(["secret-delete", "git.company"], store=cli_store) == 0
    assert cli_store.names() == ()


def test_cli_list_prints_names_only_and_never_values(
    cli_store: InMemorySecretStore, capsys: pytest.CaptureFixture[str]
) -> None:
    runtime_cli(["secret-set", "git.company", "--value", TOKEN], store=cli_store)
    runtime_cli(["secret-list"], store=cli_store)
    out = capsys.readouterr().out
    assert "git.company" in out
    assert TOKEN not in out


def test_cli_rotate_requires_an_existing_secret(
    cli_store: InMemorySecretStore, capsys: pytest.CaptureFixture[str]
) -> None:
    assert runtime_cli(["secret-rotate", "git.company", "--value", "x"], store=cli_store) == 1
    assert "SECRET_REF_NOT_FOUND" in capsys.readouterr().err


def test_cli_delete_missing_secret_fails_with_a_stable_code(
    cli_store: InMemorySecretStore, capsys: pytest.CaptureFixture[str]
) -> None:
    assert runtime_cli(["secret-delete", "git.company"], store=cli_store) == 1
    assert "SECRET_REF_NOT_FOUND" in capsys.readouterr().err


def test_cli_set_reads_the_value_from_stdin_when_not_given(
    cli_store: InMemorySecretStore,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{TOKEN}\n"))
    assert runtime_cli(["secret-set", "git.company"], store=cli_store) == 0
    assert cli_store.get("git.company") == TOKEN
    assert TOKEN not in capsys.readouterr().out


def test_cli_set_stores_multi_line_credentials_from_stdin(
    cli_store: InMemorySecretStore,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ssh_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nmore material\n-----END OPENSSH PRIVATE KEY-----"
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{ssh_key}\n"))
    assert runtime_cli(["secret-set", "ssh.projectA"], store=cli_store) == 0
    assert cli_store.get("ssh.projectA") == ssh_key
    assert "b3BlbnNzaC1rZXktdjEAAAAA" not in capsys.readouterr().out


def test_cli_rejects_empty_secret_values(
    cli_store: InMemorySecretStore, capsys: pytest.CaptureFixture[str]
) -> None:
    assert runtime_cli(["secret-set", "git.company", "--value", ""], store=cli_store) == 1
    assert capsys.readouterr().err


@pytest.mark.skipif(sys.platform == "win32", reason="auto backend requires no OS store here")
def test_cli_auto_backend_reports_unavailability_as_a_stable_code(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert runtime_cli(["secret-list", "--backend", "auto"]) == 1
    assert "SECRET_BACKEND_UNAVAILABLE" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Task payload injection (the seam ticket 01 reserved)


def _python_service(
    store: InMemorySecretStore | UnavailableStore | None, tmp_path: Path
) -> LocalPythonService:
    return LocalPythonService(
        LocalFileStore([RootConfig("/projects", tmp_path)]),
        policy=always_allow_python(),
        secrets=SecretResolver(store) if store is not None else None,
    )


def _python_payload(
    script: str, secrets: dict[str, str] | None = None
) -> dict[str, object]:
    payload: dict[str, object] = {
        "working_root": "/projects",
        "script": script,
        "environment": [],
    }
    if secrets is not None:
        payload["secrets"] = secrets
    return payload


def test_python_task_injects_referenced_secret_into_process_environment_only(
    tmp_path: Path,
) -> None:
    service = _python_service(store_with(**{"git.company": TOKEN}), tmp_path)
    payload = _python_payload(
        "import os; print('len', len(os.environ['GIT_TOKEN']))",
        {"GIT_TOKEN": "local:git.company"},
    )

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.COMPLETED
    assert result.exit_code == 0
    assert result.stdout == f"len {len(TOKEN)}\n"
    assert TOKEN not in result.stdout


def test_python_task_output_is_scrubbed_when_the_script_prints_the_secret(
    tmp_path: Path,
) -> None:
    service = _python_service(store_with(**{"git.company": TOKEN}), tmp_path)
    payload = _python_payload(
        "import os; print(os.environ['GIT_TOKEN']); "
        "raise SystemExit('boom ' + os.environ['GIT_TOKEN'])",
        {"GIT_TOKEN": "local:git.company"},
    )

    result = asyncio.run(service.execute(payload))

    assert result.status is PythonTaskStatus.FAILED
    assert TOKEN not in result.stdout
    assert TOKEN not in result.stderr
    assert "[REDACTED]" in result.stdout
    assert result.receipt is not None
    assert TOKEN not in json.dumps(result.receipt.as_dict())


def test_python_task_rejects_literal_values_in_secret_slots(tmp_path: Path) -> None:
    service = _python_service(store_with(**{"git.company": TOKEN}), tmp_path)
    payload = _python_payload("print('never')", {"GIT_TOKEN": TOKEN})

    with pytest.raises(ValueError, match="local:"):
        asyncio.run(service.execute(payload, consent=True))


def test_python_task_fails_structurally_when_a_reference_is_missing(
    tmp_path: Path,
) -> None:
    service = _python_service(store_with(**{"ssh.projectA": OTHER_TOKEN}), tmp_path)
    payload = _python_payload("print('never')", {"GIT_TOKEN": "local:git.company"})

    with pytest.raises(SecretNotFound) as excinfo:
        asyncio.run(service.execute(payload, consent=True))
    assert excinfo.value.code == "SECRET_REF_NOT_FOUND"
    assert TOKEN not in str(excinfo.value)


def test_python_task_fails_structurally_when_the_backend_is_unavailable(
    tmp_path: Path,
) -> None:
    service = _python_service(UnavailableStore(), tmp_path)
    payload = _python_payload("print('never')", {"GIT_TOKEN": "local:git.company"})

    with pytest.raises(SecretBackendUnavailable) as excinfo:
        asyncio.run(service.execute(payload, consent=True))
    assert excinfo.value.code == "SECRET_BACKEND_UNAVAILABLE"


def test_python_task_without_a_configured_store_cannot_resolve_references(
    tmp_path: Path,
) -> None:
    service = _python_service(None, tmp_path)
    payload = _python_payload("print('never')", {"GIT_TOKEN": "local:git.company"})

    with pytest.raises(SecretBackendUnavailable):
        asyncio.run(service.execute(payload, consent=True))


# ---------------------------------------------------------------------------
# Transport wire gate: no plaintext on any envelope that leaves the device


def _client(
    store: InMemorySecretStore | UnavailableStore | None,
    tmp_path: Path,
) -> tuple[LocalRuntimeClient, Ed25519PrivateKey]:
    server_key = Ed25519PrivateKey.generate()
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        server_public_key=public_key_text(server_key),
        python_service=_python_service(store, tmp_path),
        policy=always_allow_python(),
    )
    client.connection = FakeConnection()
    return client, server_key


def _handle_task(client: LocalRuntimeClient, server_key: Ed25519PrivateKey, payload: dict[str, object]) -> None:
    task = sign_server_task(server_key, "task-1", payload)
    verified = verify_envelope(
        task,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )
    asyncio.run(client._handle_task(verified))


def _wire(client: LocalRuntimeClient) -> str:
    return "\n".join(client.connection.sent)  # type: ignore[attr-defined]


def test_python_task_result_and_progress_envelopes_carry_no_plaintext(
    tmp_path: Path,
) -> None:
    client, server_key = _client(store_with(**{"git.company": TOKEN}), tmp_path)
    payload = {
        "operation": "local.python",
        "working_root": "/projects",
        "script": "import os; print(os.environ['GIT_TOKEN'])",
        "environment": [],
        "secrets": {"GIT_TOKEN": "local:git.company"},
        "run_id": "run-1",
    }

    _handle_task(client, server_key, payload)

    assert TOKEN not in _wire(client)
    assert "[REDACTED]" in _wire(client)
    result = json.loads(client.connection.sent[-1])  # type: ignore[attr-defined]
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["receipt"]["status"] == "completed"


def test_missing_reference_returns_a_structured_error_without_a_plaintext_fallback(
    tmp_path: Path,
) -> None:
    client, server_key = _client(store_with(**{"ssh.projectA": OTHER_TOKEN}), tmp_path)
    payload = {
        "operation": "local.python",
        "working_root": "/projects",
        "script": "print('never')",
        "environment": [],
        "secrets": {"GIT_TOKEN": "local:git.company"},
        "run_id": "run-1",
    }

    _handle_task(client, server_key, payload)

    assert TOKEN not in _wire(client)
    error = json.loads(client.connection.sent[-1])  # type: ignore[attr-defined]
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "SECRET_REF_NOT_FOUND"
    assert error["payload"]["receipt"]["status"] == "failed"


def test_unavailable_backend_returns_a_structured_error(tmp_path: Path) -> None:
    client, server_key = _client(UnavailableStore(), tmp_path)
    payload = {
        "operation": "local.python",
        "working_root": "/projects",
        "script": "print('never')",
        "environment": [],
        "secrets": {"GIT_TOKEN": "local:git.company"},
        "run_id": "run-1",
    }

    _handle_task(client, server_key, payload)

    error = json.loads(client.connection.sent[-1])  # type: ignore[attr-defined]
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "SECRET_BACKEND_UNAVAILABLE"


def test_local_secrets_operations_are_not_model_callable_capabilities(
    tmp_path: Path,
) -> None:
    client, server_key = _client(store_with(**{"git.company": TOKEN}), tmp_path)
    payload = {
        "operation": "local.secrets.read",
        "name": "git.company",
        "run_id": "run-1",
    }

    _handle_task(client, server_key, payload)

    assert TOKEN not in _wire(client)
    error = json.loads(client.connection.sent[-1])  # type: ignore[attr-defined]
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "INVALID_TASK"
