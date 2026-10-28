"""Offline connector install: validation, lifecycle, and the local.mcp loop (#123).

The fixed fixture package is stdlib-only Python: ``echo`` with known output
plus root-confined ``read_file``/``write_file``. The closed loop proves the
T123-01 chain — install validates version/dependency/entry, writes the
controlled configuration, the supervisor swap starts the process, tools are
discovered, a consented ``local.mcp.*`` call executes, an out-of-root write
is refused with no side effect, and shutdown leaves no orphan process.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path, PurePosixPath

import pytest

from core.connector_install import (
    MANIFEST_NAME,
    ConnectorInstallError,
    ConnectorInstallService,
    ConnectorRegistry,
    connectors_config_path,
    parse_manifest,
    read_package,
)
from core.consent import ConsentStore
from core.mcp import LocalMCPService, MCPError, MCPSupervisor
from core.policy import LocalPolicy, PolicyDecision

FIXTURE_ENTRY = Path(__file__).parent / "fixtures" / "connector_mcp_server.py"

BINDING = {"server_origin": "https://server.test", "user_id": "user-123", "device_id": "device-123",
           "device_public_key": "device-key", "broker_public_key": "broker-key"}
OTHER_BINDING = {**BINDING, "user_id": "other-user"}


def build_package(root: Path, *, slug: str = "demo-echo", display_name: str = "Demo Echo Connector",
                  version: str = "1.2.0", entry: str = "server.py", requirements: dict | None = None,
                  manifest_raw: str | None = None, extra: dict[str, bytes] | None = None,
                  write_entry: bool = True) -> Path:
    package = root / f"candidate-{slug}-{version.replace('.', '_')}"
    package.mkdir(parents=True, exist_ok=True)
    manifest = {
        "connector": slug,
        "displayName": display_name,
        "version": version,
        "entry": entry,
        "requirements": {"python": ">=3.9"} if requirements is None else requirements,
    }
    if manifest_raw is not None:
        (package / MANIFEST_NAME).write_text(manifest_raw, encoding="utf-8")
    else:
        (package / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    # Mirror the manifest grammar: a package-relative posix path. Absolute or
    # escaping entries are written nowhere — the manifest itself must refuse
    # them before any file lookup matters.
    relative = PurePosixPath(entry)
    inside = not relative.is_absolute() and ".." not in relative.parts
    target = package
    for part in relative.parts:
        target = target / part
    if inside:
        target.parent.mkdir(parents=True, exist_ok=True)
    if write_entry and inside:
        target.write_text(FIXTURE_ENTRY.read_text(encoding="utf-8"), encoding="utf-8")
    for name, payload in (extra or {}).items():
        member = package / name
        member.parent.mkdir(parents=True, exist_ok=True)
        member.write_bytes(payload)
    return package


@pytest.fixture
def service(tmp_path: Path) -> ConnectorInstallService:
    return ConnectorInstallService(
        ConnectorRegistry(tmp_path / "connectors.db"),
        config_path=tmp_path / "settings.json",
        interpreter=sys.executable,
    )


def test_manifest_fixed_key_set_refuses_unknown_configuration_keys() -> None:
    base = {"connector": "demo", "displayName": "Demo", "version": "1.0.0",
            "entry": "server.py", "requirements": {}}
    for extra in ({"command": "evil"}, {"env": {"X": "1"}}, {"args": {}}):
        with pytest.raises(ConnectorInstallError) as excinfo:
            parse_manifest({**base, **extra})
        assert str(excinfo.value) == "CONNECTOR_MANIFEST_INVALID"
    assert parse_manifest(base)["slug"] == "demo"


def test_manifest_refuses_unprobeable_dependency_as_missing() -> None:
    base = {"connector": "demo", "displayName": "Demo", "version": "1.0.0",
            "entry": "server.py", "requirements": {"dotnet": ">=8.0"}}
    with pytest.raises(ConnectorInstallError) as excinfo:
        parse_manifest(base)
    assert str(excinfo.value) == "CONNECTOR_DEPENDENCY_MISSING"


def test_package_validation_matrix(tmp_path: Path, service: ConnectorInstallService) -> None:
    good = build_package(tmp_path / "cases")
    assert service.preview(BINDING, str(good))["slug"] == "demo-echo"
    # Missing package and unreadable manifest.
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.preview(BINDING, str(tmp_path / "cases" / "absent"))
    assert str(excinfo.value) == "CONNECTOR_PACKAGE_INVALID"
    broken = build_package(tmp_path / "cases2", manifest_raw="{not json")
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.preview(BINDING, str(broken))
    assert str(excinfo.value) == "CONNECTOR_MANIFEST_INVALID"
    # Bad slug, version, display name.
    for overrides in ({"slug": "bad name"}, {"slug": "../escape"}, {"version": "1.2"},
                      {"version": "1.2.0.0"}, {"display_name": ""}, {"display_name": "x" * 201}):
        broken = build_package(tmp_path / f"case-{abs(hash(str(overrides)))}", **overrides)
        with pytest.raises(ConnectorInstallError) as excinfo:
            service.preview(BINDING, str(broken))
        assert str(excinfo.value) == "CONNECTOR_MANIFEST_INVALID"
    # Entry problems: missing file, absolute path, escape, wrong suffix.
    for entry, expected in (("absent.py", "CONNECTOR_ENTRY_INVALID"), ("/abs.py", "CONNECTOR_MANIFEST_INVALID"),
                            ("../escape.py", "CONNECTOR_MANIFEST_INVALID"), ("sub\\x.py", "CONNECTOR_MANIFEST_INVALID"),
                            ("tool.exe", "CONNECTOR_MANIFEST_INVALID")):
        broken = build_package(tmp_path / f"entry-{abs(hash(entry))}", entry=entry,
                               write_entry=entry != "absent.py")
        with pytest.raises(ConnectorInstallError) as excinfo:
            service.preview(BINDING, str(broken))
        assert str(excinfo.value) == expected, entry
    # A symlinked entry never masquerades as an ordinary file.
    linked = build_package(tmp_path / "linked")
    outside = tmp_path / "outside.py"
    outside.write_text("print('evil')", encoding="utf-8")
    (linked / "server.py").unlink()
    (linked / "server.py").symlink_to(outside)
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.preview(BINDING, str(linked))
    assert str(excinfo.value) == "CONNECTOR_ENTRY_INVALID"
    # Forbidden native member.
    native = build_package(tmp_path / "native", extra={"helper.dll": b"MZ"})
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.preview(BINDING, str(native))
    assert str(excinfo.value) == "CONNECTOR_PACKAGE_INVALID"


def test_version_floor_mismatch_is_actionable(tmp_path: Path, service: ConnectorInstallService) -> None:
    package = build_package(tmp_path / "floor", requirements={"python": ">=99.0"})
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.preview(BINDING, str(package))
    assert str(excinfo.value) == "CONNECTOR_VERSION_MISMATCH"
    # A floor this interpreter satisfies previews cleanly.
    package_ok = build_package(tmp_path / "floor-ok", requirements={
        "python": f">={sys.version_info.major}.{sys.version_info.minor}"})
    assert service.preview(BINDING, str(package_ok))["version"] == "1.2.0"


def test_preview_projection_carries_no_device_paths(tmp_path: Path, service: ConnectorInstallService) -> None:
    package = build_package(tmp_path / "deep" / "user" / "private")
    projection = service.preview(BINDING, str(package))
    assert projection["entry"] == "server.py"
    assert set(projection) == {"slug", "displayName", "version", "manifestHash", "packageHash",
                               "fileCount", "entry", "installed"}
    assert str(tmp_path) not in json.dumps(projection)


def test_unconfirmed_install_writes_nothing(tmp_path: Path, service: ConnectorInstallService) -> None:
    package = build_package(tmp_path / "pkg")
    result = service.install(BINDING, str(package), confirmed=False)
    assert result["installed"] is False or "installed" not in result or result.get("installed") is False
    assert not connectors_config_path(tmp_path / "settings.json").exists()
    assert service.registry.find(BINDING, "demo-echo") is None


def test_install_registers_identity_first_and_commits(tmp_path: Path) -> None:
    calls = []

    def registrar(slug, display_name, version, manifest_hash):
        calls.append((slug, display_name, version, manifest_hash))
        return {"connectorId": "platform-conn-1"}

    service = ConnectorInstallService(
        ConnectorRegistry(tmp_path / "connectors.db"), config_path=tmp_path / "settings.json",
        interpreter=sys.executable, registrar=registrar)
    package = build_package(tmp_path / "pkg")
    result = service.install(BINDING, str(package), confirmed=True)
    assert calls == [("demo-echo", "Demo Echo Connector", "1.2.0", result["manifestHash"])]
    row = service.registry.find(BINDING, "demo-echo")
    assert row["server_connector_id"] == "platform-conn-1"
    config = json.loads(connectors_config_path(tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert len(config["servers"]) == 1
    spec = config["servers"][0]
    assert spec["name"] == "demo-echo" and spec["transport"] == "stdio"
    # The controlled configuration: pinned interpreter, entry inside the
    # managed store, and the connector's own data directory as its file root.
    assert spec["command"] == [sys.executable, str(tmp_path / "connectors" / "demo-echo" / "server.py")]
    assert spec["env"] == {"MCP_ROOT": str(tmp_path / "connectors" / "demo-echo" / "data")}
    assert (tmp_path / "connectors" / "demo-echo" / "data").is_dir()


def test_registration_failure_keeps_the_device_unchanged(tmp_path: Path) -> None:
    def registrar(*_args):
        raise RuntimeError("platform offline")

    service = ConnectorInstallService(
        ConnectorRegistry(tmp_path / "connectors.db"), config_path=tmp_path / "settings.json",
        interpreter=sys.executable, registrar=registrar)
    package = build_package(tmp_path / "pkg")
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.install(BINDING, str(package), confirmed=True)
    assert str(excinfo.value) == "CONNECTOR_REGISTRATION_UNAVAILABLE"
    assert not (tmp_path / "connectors" / "demo-echo").exists()
    assert not connectors_config_path(tmp_path / "settings.json").exists()
    assert service.registry.find(BINDING, "demo-echo") is None


def test_frozen_identity_conflict_is_its_own_category(tmp_path: Path) -> None:
    class RegistrationConflict(RuntimeError):
        code = "CHAT_CONFLICT"

    def registrar(*_args):
        raise RegistrationConflict("409")

    service = ConnectorInstallService(
        ConnectorRegistry(tmp_path / "connectors.db"), config_path=tmp_path / "settings.json",
        interpreter=sys.executable, registrar=registrar)
    package = build_package(tmp_path / "pkg")
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.install(BINDING, str(package), confirmed=True)
    assert str(excinfo.value) == "CONNECTOR_IDENTITY_CONFLICT"
    assert service.registry.find(BINDING, "demo-echo") is None


def test_reinstall_same_content_is_idempotent(tmp_path: Path, service: ConnectorInstallService) -> None:
    package = build_package(tmp_path / "pkg")
    first = service.install(BINDING, str(package), confirmed=True)
    second = service.install(BINDING, str(package), confirmed=True)
    assert second["unchanged"] is True
    assert second["packageHash"] == first["packageHash"]


def test_removal_refuses_unknown_and_is_binding_scoped(tmp_path: Path, service: ConnectorInstallService) -> None:
    package = build_package(tmp_path / "pkg")
    service.install(BINDING, str(package), confirmed=True)
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.remove(OTHER_BINDING, "demo-echo", confirmed=True)
    assert str(excinfo.value) == "CONNECTOR_NOT_INSTALLED"
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.remove(BINDING, "never-installed", confirmed=True)
    assert str(excinfo.value) == "CONNECTOR_NOT_INSTALLED"
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.remove(BINDING, "../escape", confirmed=True)
    assert str(excinfo.value) == "CONNECTOR_NOT_INSTALLED"
    assert service.registry.find(BINDING, "demo-echo") is not None


def test_removal_unregisters_after_local_commit(tmp_path: Path) -> None:
    removed = []

    def registrar(*_args):
        return {"connectorId": "platform-conn-9"}

    def unregister(connector_id):
        removed.append(connector_id)
        raise RuntimeError("platform offline during removal")

    service = ConnectorInstallService(
        ConnectorRegistry(tmp_path / "connectors.db"), config_path=tmp_path / "settings.json",
        interpreter=sys.executable, registrar=registrar, unregister=unregister)
    package = build_package(tmp_path / "pkg")
    service.install(BINDING, str(package), confirmed=True)
    with pytest.raises(ConnectorInstallError) as excinfo:
        service.remove(BINDING, "demo-echo", confirmed=True)
    assert str(excinfo.value) == "CONNECTOR_REGISTRATION_UNAVAILABLE"
    # The local component is already gone; only the platform call failed.
    assert not (tmp_path / "connectors" / "demo-echo").exists()
    assert service.registry.find(BINDING, "demo-echo") is None
    assert json.loads(connectors_config_path(tmp_path / "settings.json").read_text(encoding="utf-8"))["servers"] == []
    assert removed == ["platform-conn-9"]


def closed_loop(tmp_path: Path, *, policy: LocalPolicy | None = None):
    """Swap a supervisor over the controlled specs and exercise the loop."""
    from core.mcp import parse_mcp_config

    config = json.loads(connectors_config_path(tmp_path / "settings.json").read_text(encoding="utf-8"))
    supervisor = MCPSupervisor(parse_mcp_config(config))
    mcp = LocalMCPService(supervisor, policy=policy or LocalPolicy(), consent=ConsentStore())
    return mcp, supervisor


def test_install_start_discovery_execute_and_no_orphans(tmp_path: Path, service: ConnectorInstallService) -> None:
    service.install(BINDING, str(build_package(tmp_path / "pkg")), confirmed=True)
    mcp, supervisor = closed_loop(tmp_path)

    async def scenario() -> None:
        await supervisor.start_all()
        # Tool discovery through the standard projection.
        assert set(supervisor.capabilities()) == {"local.mcp.demo-echo.echo", "local.mcp.demo-echo.read_file",
                                                  "local.mcp.demo-echo.write_file"}
        # Consented echo with the known fixture output.
        execution = await mcp.execute(
            "local.mcp.demo-echo.echo",
            {"run_id": "run-1", "task_id": "task-1", "arguments": {"value": "T123-echo-marker"}},
            consent=True)
        assert execution.status == "completed"
        assert execution.value["content"] == [{"type": "text", "text": "T123-echo-marker"}]
        receipt = execution.receipt.as_dict()
        # Receipts carry hashes and status only — never arguments or content.
        assert "T123-echo-marker" not in json.dumps(receipt)
        assert receipt["capability"] == "local.mcp.demo-echo.echo"
        # The controlled read/write roundtrip stays inside the managed root.
        write = await mcp.execute(
            "local.mcp.demo-echo.write_file",
            {"run_id": "run-1", "task_id": "task-2", "arguments": {"path": "note.txt", "content": "managed"}},
            consent=True)
        assert write.status == "completed"
        data_root = tmp_path / "connectors" / "demo-echo" / "data"
        assert (data_root / "note.txt").read_text(encoding="utf-8") == "managed"
        read = await mcp.execute(
            "local.mcp.demo-echo.read_file",
            {"run_id": "run-1", "task_id": "task-3", "arguments": {"path": "note.txt"}}, consent=True)
        assert read.value["content"] == [{"type": "text", "text": "managed"}]
        # An out-of-root write is a tool error with no side effect (T123-04).
        escape = await mcp.execute(
            "local.mcp.demo-echo.write_file",
            {"run_id": "run-1", "task_id": "task-4",
             "arguments": {"path": "../escape.txt", "content": "outside"}},
            consent=True)
        assert escape.status == "failed"
        assert not (tmp_path / "connectors" / "demo-echo" / "escape.txt").exists()
        assert not (tmp_path / "connectors" / "escape.txt").exists()
        # Shutdown: the supervised child process is gone — no orphan.
        process = supervisor._records["demo-echo"].connection.process
        await supervisor.stop_all()
        assert process.returncode is not None
        assert supervisor.state_of("demo-echo") == "stopped"
        assert supervisor.capabilities() == ()

    asyncio.run(scenario())


def test_local_deny_wins_over_tool_approval(tmp_path: Path, service: ConnectorInstallService) -> None:
    service.install(BINDING, str(build_package(tmp_path / "pkg")), confirmed=True)
    policy = LocalPolicy(denied_capabilities=frozenset({"local.mcp.demo-echo.echo"}))
    mcp, supervisor = closed_loop(tmp_path, policy=policy)

    async def scenario() -> None:
        await supervisor.start_all()
        decision = await mcp.execute(
            "local.mcp.demo-echo.echo",
            {"run_id": "run-2", "task_id": "task-5", "arguments": {"value": "denied?"}},
            consent=True)
        assert decision is PolicyDecision.DENY
        await supervisor.stop_all()

    asyncio.run(scenario())


def test_consent_is_required_and_payload_bound(tmp_path: Path, service: ConnectorInstallService) -> None:
    service.install(BINDING, str(build_package(tmp_path / "pkg")), confirmed=True)
    mcp, supervisor = closed_loop(tmp_path)

    async def scenario() -> None:
        await supervisor.start_all()
        consent = mcp.consent
        payload = {"run_id": "run-3", "task_id": "task-6", "arguments": {"value": "ask-first"}}
        decision = await mcp.execute("local.mcp.demo-echo.echo", dict(payload))
        assert decision is PolicyDecision.CONSENT_REQUIRED
        from core.consent import request_hash

        consent.approve("local.mcp.demo-echo.echo", request_hash(payload))
        execution = await mcp.execute("local.mcp.demo-echo.echo", dict(payload))
        assert execution.status == "completed"
        # A different payload for the same tool is a different ask.
        other = {"run_id": "run-3", "task_id": "task-7", "arguments": {"value": "different"}}
        decision = await mcp.execute("local.mcp.demo-echo.echo", other)
        assert decision is PolicyDecision.CONSENT_REQUIRED
        await supervisor.stop_all()

    asyncio.run(scenario())


def test_removed_component_refuses_to_start_with_actionable_state(
    tmp_path: Path, service: ConnectorInstallService
) -> None:
    package = build_package(tmp_path / "pkg")
    service.install(BINDING, str(package), confirmed=True)
    entry = tmp_path / "connectors" / "demo-echo" / "server.py"
    entry.unlink()  # T123-02: the component vanished after install.
    from core.mcp import parse_mcp_config

    config = json.loads(connectors_config_path(tmp_path / "settings.json").read_text(encoding="utf-8"))
    supervisor = MCPSupervisor(parse_mcp_config(config))

    async def scenario() -> None:
        await supervisor.start_all()
        # Spawn succeeded (interpreter exists) but the entry vanished, so the
        # child died before protocol start: the fixed crashed category, an
        # empty projection, and nothing that pretends to be usable.
        assert supervisor.state_of("demo-echo") == "failed"
        assert supervisor.last_error("demo-echo") == "SERVER_CRASHED"
        assert supervisor.capabilities() == ()

    asyncio.run(scenario())
