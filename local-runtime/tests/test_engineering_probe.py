"""Issue 87: desktop-side CATIA/Abaqus discovery — probe, announce, guide.

The Desktop only detects and reports: per-component state, one actionable
hint per missing piece, and the authorized folder job results must land in.
The external software loop itself belongs to iDeer #124/#125, so every test
here exercises filesystem-and-environment evidence only; nothing launches
software.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core.engineering_probe import (
    EngineeringSoftwareProbe,
    PROBE_OPERATIONS,
    RESULT_OPERATIONS,
    register_engineering_result,
)
from core.files import FileAccessError, LocalFileStore, RootConfig
from core.local_results import LocalResultRegistry
from core.file_service import LocalFileService
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.transport import LocalRuntimeClient


def _python_artifact(directory: Path) -> Path:
    name = "python.exe" if os.name == "nt" else "python"
    path = directory / name
    path.write_bytes(b"")
    if os.name != "nt":
        path.chmod(0o755)
    return path


def _probe(env: dict[str, str], home: Path) -> EngineeringSoftwareProbe:
    # The scan roots (Program Files, ProgramData, LOCALAPPDATA, SystemDrive)
    # all point into the test's own home, so machine state never leaks in.
    # SystemDrive acts as the drive root here, exactly as "C:\" does on a
    # real machine (SIMULIA and Python3* live directly beneath it).
    base = {
        "PATH": str(home / "bin"),
        "ProgramFiles": str(home / "Program Files"),
        "ProgramData": str(home / "ProgramData"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "SystemDrive": str(home),
    }
    base.update(env)
    return EngineeringSoftwareProbe(env=base)


# ---------------------------------------------------------------------------
# Component probes and hints
# ---------------------------------------------------------------------------


def test_every_component_missing_gets_its_own_hint(tmp_path: Path) -> None:
    report = _probe(
        {
            "IDEER_CATIA_MCP_DIR": str(tmp_path / "absent-catia"),
            "IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent-abaqus"),
        },
        tmp_path,
    ).probe("catia")

    assert report.tool == "catia"
    assert report.ready is False
    assert report.components["software"].status == "missing"
    assert report.components["plugin"].status == "missing"
    assert report.components["python"].status == "missing"
    # Without any license signal the honest answer is unknown, not missing:
    # the desktop cannot prove absence of a license it cannot see.
    assert report.components["license"].status == "unknown"

    hints = report.hints
    assert hints, "every missing component owes an actionable hint"
    assert len(set(hints)) == len(hints), "hints must be specific, not one generic error"
    for name in ("software", "plugin", "python"):
        assert report.components[name].hint
    assert report.components["license"].hint


def test_catia_software_found_via_program_files_release_dir(tmp_path: Path) -> None:
    install = tmp_path / "Program Files" / "Dassault Systemes" / "B31" / "win_b64"
    install.mkdir(parents=True)
    report = _probe(
        {"IDEER_CATIA_MCP_DIR": str(tmp_path / "absent")}, tmp_path
    ).probe("catia")

    assert report.components["software"].status == "present"
    assert "B31" in report.components["software"].detail
    assert report.components["software"].hint == ""


def test_catia_software_found_via_catinstalldir_env(tmp_path: Path) -> None:
    install = tmp_path / "DS" / "B32"
    (install / "win_b64").mkdir(parents=True)
    report = _probe(
        {
            "CATINSTALLDIR": str(install),
            "IDEER_CATIA_MCP_DIR": str(tmp_path / "absent"),
        },
        tmp_path,
    ).probe("catia")

    assert report.components["software"].status == "present"
    assert str(install) in report.components["software"].detail


def test_catia_plugin_needs_server_dir_and_module(tmp_path: Path) -> None:
    env = {"IDEER_CATIA_MCP_DIR": str(tmp_path / "server")}
    report = _probe(env, tmp_path).probe("catia")
    assert report.components["plugin"].status == "missing"
    assert "catia_mcp" in report.components["plugin"].hint

    (tmp_path / "server" / "catia_mcp").mkdir(parents=True)
    report = _probe(env, tmp_path).probe("catia")
    assert report.components["plugin"].status == "present"
    assert report.components["plugin"].hint == ""


def test_catia_license_states_track_the_visible_signals(tmp_path: Path) -> None:
    license_file = tmp_path / "catia.lic"
    env = {"IDEER_CATIA_MCP_DIR": str(tmp_path / "absent")}

    pointing_at_nothing = dict(env, CATALICENCE_FILE=str(tmp_path / "nope.lic"))
    report = _probe(pointing_at_nothing, tmp_path).probe("catia")
    assert report.components["license"].status == "missing"
    assert report.components["license"].hint

    report = _probe(env, tmp_path).probe("catia")
    assert report.components["license"].status == "unknown"

    license_file.write_text("node")
    report = _probe(dict(env, CATALICENCE_FILE=str(license_file)), tmp_path).probe("catia")
    assert report.components["license"].status == "present"
    assert report.components["license"].hint == ""

    licenses = tmp_path / "ProgramData" / "DassaultSystemes" / "Licenses"
    licenses.mkdir(parents=True)
    (licenses / "dsy.lic").write_text("dsls")
    report = _probe(env, tmp_path).probe("catia")
    assert report.components["license"].status == "present"

    # A stray README is not a grant: the directory must carry a real .lic
    # file for the DSLS signal to count, otherwise the answer stays unknown.
    (licenses / "dsy.lic").unlink()
    (licenses / "README.txt").write_text("docs")
    report = _probe(env, tmp_path).probe("catia")
    assert report.components["license"].status == "unknown"


def test_abaqus_software_found_via_abaqus_home(tmp_path: Path) -> None:
    home = tmp_path / "Abaqus" / "2024"
    (home / "code" / "bin").mkdir(parents=True)
    report = _probe(
        {"IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent"), "ABAQUS_HOME": str(home)},
        tmp_path,
    ).probe("abaqus")

    assert report.components["software"].status == "present"
    assert "2024" in report.components["software"].detail


def test_abaqus_software_found_via_simulia_commands(tmp_path: Path) -> None:
    launcher = tmp_path / "SIMULIA" / "Commands" / "abaqus.bat"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("bat")
    report = _probe(
        {"IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent")}, tmp_path
    ).probe("abaqus")

    assert report.components["software"].status == "present"


def test_abaqus_cae_year_dir_is_version_evidence_but_junk_is_not(tmp_path: Path) -> None:
    cae = tmp_path / "SIMULIA" / "CAE"
    cae.mkdir(parents=True)
    (cae / "scratch").mkdir()
    report = _probe(
        {"IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent")}, tmp_path
    ).probe("abaqus")
    assert report.components["software"].status == "missing"

    (cae / "2024").mkdir()
    report = _probe(
        {"IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent")}, tmp_path
    ).probe("abaqus")
    assert report.components["software"].status == "present"
    assert "2024" in report.components["software"].detail


def test_abaqus_plugin_needs_server_dir_and_entry_script(tmp_path: Path) -> None:
    env = {"IDEER_ABAQUS_MCP_DIR": str(tmp_path / "server")}
    report = _probe(env, tmp_path).probe("abaqus")
    assert report.components["plugin"].status == "missing"
    assert "mcp_server.py" in report.components["plugin"].hint

    (tmp_path / "server").mkdir()
    (tmp_path / "server" / "mcp_server.py").write_text("print('mcp')\n")
    report = _probe(env, tmp_path).probe("abaqus")
    assert report.components["plugin"].status == "present"


def test_abaqus_license_states_track_the_visible_signals(tmp_path: Path) -> None:
    env = {"IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent")}
    report = _probe(env, tmp_path).probe("abaqus")
    assert report.components["license"].status == "unknown"
    assert report.components["license"].hint

    report = _probe(
        dict(env, ABAQUSLM_LICENSE_FILE="27000@license-server"), tmp_path
    ).probe("abaqus")
    assert report.components["license"].status == "present"

    dangling = tmp_path / "dangling.lic"
    report = _probe(
        dict(env, ABAQUSLM_LICENSE_FILE=str(dangling)), tmp_path
    ).probe("abaqus")
    assert report.components["license"].status == "missing"


def test_python_detected_from_path_and_missing_reported(tmp_path: Path) -> None:
    env = {"IDEER_CATIA_MCP_DIR": str(tmp_path / "absent")}
    report = _probe(env, tmp_path).probe("catia")
    assert report.components["python"].status == "missing"

    found = _probe(env, tmp_path)
    found.env["PATH"] = str(tmp_path)
    _python_artifact(tmp_path)
    report = found.probe("catia")
    assert report.components["python"].status == "present"


# ---------------------------------------------------------------------------
# Honest readiness announcement
# ---------------------------------------------------------------------------


def _fully_equipped_env(tmp_path: Path) -> dict[str, str]:
    catia_install = tmp_path / "Program Files" / "Dassault Systemes" / "B31" / "win_b64"
    catia_install.mkdir(parents=True)
    catia_server = tmp_path / "catia-server"
    (catia_server / "catia_mcp").mkdir(parents=True)
    license_file = tmp_path / "catia.lic"
    license_file.write_text("node")
    abaqus_home = tmp_path / "Abaqus" / "2024"
    (abaqus_home / "code" / "bin").mkdir(parents=True)
    abaqus_server = tmp_path / "abaqus-server"
    abaqus_server.mkdir()
    (abaqus_server / "mcp_server.py").write_text("print('mcp')\n")
    return {
        "PATH": "",
        "ProgramFiles": str(tmp_path / "Program Files"),
        "ProgramData": str(tmp_path / "ProgramData"),
        "LOCALAPPDATA": str(tmp_path / "AppData" / "Local"),
        "SystemDrive": str(tmp_path),
        "CATINSTALLDIR": str(catia_install),
        "IDEER_CATIA_MCP_DIR": str(catia_server),
        "CATALICENCE_FILE": str(license_file),
        "ABAQUS_HOME": str(abaqus_home),
        "IDEER_ABAQUS_MCP_DIR": str(abaqus_server),
        "ABAQUSLM_LICENSE_FILE": "27000@license-server",
    }


def _equipped_probe(tmp_path: Path) -> EngineeringSoftwareProbe:
    env = _fully_equipped_env(tmp_path)
    probe = EngineeringSoftwareProbe(env=env)
    # The equipped layout has no interpreter on PATH; hand the service one
    # from the test tree so readiness hinges on the license/plugin layout.
    probe.env["PATH"] = str(tmp_path)
    _python_artifact(tmp_path)
    return probe


def test_ready_requires_every_component_of_that_tool(tmp_path: Path) -> None:
    probe = _equipped_probe(tmp_path)

    catia = probe.probe("catia")
    assert catia.ready is True
    abaqus = probe.probe("abaqus")
    assert abaqus.ready is True
    assert set(probe.capability_names()) == {
        "local.catia.probe",
        "local.abaqus.probe",
        "local.catia.ready",
        "local.abaqus.ready",
    }

    # One missing piece — the license signal — and the tool stops being
    # announced as ready while the probe itself stays available.
    (tmp_path / "catia.lic").unlink()
    catia = probe.probe("catia")
    assert catia.ready is False
    assert "local.catia.ready" not in probe.capability_names()
    assert "local.catia.probe" in probe.capability_names()
    assert "local.abaqus.ready" in probe.capability_names()


def test_probe_operation_returns_wire_shape(tmp_path: Path) -> None:
    probe = _equipped_probe(tmp_path)
    result = probe.run_probe_operation("local.catia.probe")

    assert result["tool"] == "catia"
    assert result["ready"] is True
    assert set(result["components"]) == {"software", "plugin", "python", "license"}
    for component in result["components"].values():
        assert component["status"] in {"present", "missing", "unknown"}
    assert isinstance(result["hints"], list)
    json.dumps(result)  # the result crosses the wire as plain JSON

    with pytest.raises(ValueError):
        probe.run_probe_operation("local.unknown.probe")


def test_probe_operations_cover_both_tools() -> None:
    assert PROBE_OPERATIONS == {"local.catia.probe": "catia", "local.abaqus.probe": "abaqus"}
    assert RESULT_OPERATIONS == {"local.catia.result": "catia", "local.abaqus.result": "abaqus"}


# ---------------------------------------------------------------------------
# Authorized-boundary result registration
# ---------------------------------------------------------------------------


def _registry(tmp_path: Path) -> tuple[LocalResultRegistry, dict[str, str]]:
    registry = LocalResultRegistry(tmp_path / "results.db")
    binding = {
        "server_origin": "https://server",
        "user_id": "alice",
        "device_id": "device-1",
        "device_public_key": "pk",
        "broker_public_key": "bk",
    }
    return registry, binding


def test_result_registration_inside_boundary_records_metadata(tmp_path: Path) -> None:
    (tmp_path / "jobs").mkdir()
    output = tmp_path / "jobs" / "result.odb"
    output.write_bytes(b"odb-bytes")
    store = LocalFileStore([RootConfig("/workspace", tmp_path)])
    registry, binding = _registry(tmp_path)

    fact = register_engineering_result(
        store=store,
        registry=registry,
        binding=binding,
        tool="abaqus",
        logical_path="/workspace/jobs/result.odb",
        thread_id="thread-1",
        run_id="run-1",
        task_id="task-1",
    )

    assert fact["capability"] == "local.abaqus.result"
    assert fact["logical_root"] == "/workspace"
    assert fact["sha256"]
    assert fact["bytes"] == len(b"odb-bytes")
    assert fact["registered"] is True
    row = registry.get(binding, "task-1")
    assert row is not None
    assert row["capability"] == "local.abaqus.result"
    assert row["logical_path"] == "/workspace/jobs/result.odb"


def test_result_registration_refuses_paths_outside_the_boundary(tmp_path: Path) -> None:
    other = tmp_path.parent / (tmp_path.name + "-outside")
    other.mkdir()
    output = other / "stolen.odb"
    output.write_bytes(b"outside")
    store = LocalFileStore([RootConfig("/workspace", tmp_path)])
    registry, binding = _registry(tmp_path)

    with pytest.raises(FileAccessError) as excinfo:
        register_engineering_result(
            store=store,
            registry=registry,
            binding=binding,
            tool="catia",
            logical_path="/outside/stolen.odb",
        )
    assert excinfo.value.code == "OUTSIDE_ALLOWED_ROOTS"
    assert registry.get(binding, "") is None


def test_result_registration_refuses_missing_and_directory_paths(tmp_path: Path) -> None:
    (tmp_path / "dir").mkdir()
    store = LocalFileStore([RootConfig("/workspace", tmp_path)])
    registry, binding = _registry(tmp_path)

    with pytest.raises(FileAccessError) as missing:
        register_engineering_result(
            store=store, registry=registry, binding=binding, tool="catia",
            logical_path="/workspace/absent.odb",
        )
    assert missing.value.code == "NOT_FOUND"

    with pytest.raises(FileAccessError) as directory:
        register_engineering_result(
            store=store, registry=registry, binding=binding, tool="catia",
            logical_path="/workspace/dir",
        )
    assert directory.value.code == "NOT_A_FILE"

    # A malformed task must not masquerade as a boundary escape: an empty
    # target is an invalid argument, not OUTSIDE_ALLOWED_ROOTS.
    with pytest.raises(FileAccessError) as empty:
        register_engineering_result(
            store=store, registry=registry, binding=binding, tool="catia",
            logical_path="",
        )
    assert empty.value.code == "INVALID_PATH"


# ---------------------------------------------------------------------------
# Runtime dispatch and capability announcements
# ---------------------------------------------------------------------------


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


def _client(server_key: Ed25519PrivateKey, probe, tmp_path: Path) -> LocalRuntimeClient:
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        server_public_key=public_key_text(server_key),
        engineering_probe=probe,
        file_service=LocalFileService(LocalFileStore([RootConfig("/workspace", tmp_path)])),
        local_results=LocalResultRegistry(tmp_path / "results.db"),
    )
    client.connection = FakeConnection()
    return client


def _task(server_key: Ed25519PrivateKey, payload: dict) -> object:
    envelope = sign_envelope(
        private_key=server_key,
        message_type=MessageType.TASK,
        device_id="device-1",
        session_id="session-1",
        task_id="task-87",
        payload=payload,
    )
    return verify_envelope(
        envelope,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )


def _sent_types(client: LocalRuntimeClient) -> list[str]:
    return [json.loads(frame)["type"] for frame in client.connection.sent]


def test_probe_task_round_trip_announces_probe_capabilities(tmp_path: Path) -> None:
    probe = _probe(
        {
            "IDEER_CATIA_MCP_DIR": str(tmp_path / "absent"),
            "IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent"),
        },
        tmp_path,
    )
    server_key = Ed25519PrivateKey.generate()
    client = _client(server_key, probe, tmp_path)

    names = client.current_capabilities()
    assert "local.catia.probe" in names
    assert "local.abaqus.probe" in names
    assert "local.catia.ready" not in names

    asyncio.run(client._handle_task(_task(server_key, {"operation": "local.catia.probe"})))

    assert _sent_types(client)[-1] == MessageType.TASK_RESULT
    result = json.loads(client.connection.sent[-1])["payload"]["result"]
    assert result["tool"] == "catia"
    assert result["ready"] is False
    assert result["hints"]
    receipt = json.loads(client.connection.sent[-1])["payload"]["receipt"]
    assert receipt["capability"] == "local.catia.probe"
    assert receipt["policy_decision"] == "allow"


def test_ready_flip_republishes_capabilities(tmp_path: Path) -> None:
    server_dir = tmp_path / "catia-server"
    (server_dir / "catia_mcp").mkdir(parents=True)
    license_file = tmp_path / "catia.lic"
    license_file.write_text("node")
    install = tmp_path / "DS" / "B32"
    (install / "win_b64").mkdir(parents=True)
    probe = _probe(
        {
            "PATH": str(tmp_path),
            "CATINSTALLDIR": str(install),
            "IDEER_CATIA_MCP_DIR": str(server_dir),
            "CATALICENCE_FILE": str(license_file),
        },
        tmp_path,
    )
    _python_artifact(tmp_path)
    server_key = Ed25519PrivateKey.generate()
    client = _client(server_key, probe, tmp_path)

    asyncio.run(client.send_hello())
    assert "local.catia.ready" in client.current_capabilities()

    # The license signal disappears: the next probe sees it, and the device
    # announcement is refreshed in the same breath — never stale.
    license_file.unlink()
    asyncio.run(client._handle_task(_task(server_key, {"operation": "local.catia.probe"})))

    types = _sent_types(client)
    assert MessageType.CAPABILITY_UPDATE in types
    assert types.index(MessageType.CAPABILITY_UPDATE) > types.index(MessageType.TASK_ACK)
    updates = [
        json.loads(frame)
        for frame in client.connection.sent
        if json.loads(frame)["type"] == MessageType.CAPABILITY_UPDATE
    ]
    assert "local.catia.ready" not in updates[-1]["payload"]["capabilities"]
    assert "local.catia.probe" in updates[-1]["payload"]["capabilities"]


def test_result_task_registers_within_boundary(tmp_path: Path) -> None:
    probe = _probe(
        {
            "IDEER_CATIA_MCP_DIR": str(tmp_path / "absent"),
            "IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent"),
        },
        tmp_path,
    )
    (tmp_path / "jobs").mkdir()
    (tmp_path / "jobs" / "shot.png").write_bytes(b"png-bytes")
    server_key = Ed25519PrivateKey.generate()
    client = _client(server_key, probe, tmp_path)

    asyncio.run(client._handle_task(_task(server_key, {
        "operation": "local.abaqus.result",
        "path": "/workspace/jobs/shot.png",
    })))

    last = json.loads(client.connection.sent[-1])
    assert last["type"] == MessageType.TASK_RESULT
    fact = last["payload"]["result"]
    assert fact["capability"] == "local.abaqus.result"
    assert fact["sha256"]
    assert last["payload"]["receipt"]["capability"] == "local.abaqus.result"


def test_result_task_outside_boundary_is_an_explicit_error(tmp_path: Path) -> None:
    probe = _probe(
        {
            "IDEER_CATIA_MCP_DIR": str(tmp_path / "absent"),
            "IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent"),
        },
        tmp_path,
    )
    server_key = Ed25519PrivateKey.generate()
    client = _client(server_key, probe, tmp_path)

    asyncio.run(client._handle_task(_task(server_key, {
        "operation": "local.catia.result",
        "path": "/elsewhere/model.odb",
    })))

    last = json.loads(client.connection.sent[-1])
    assert last["type"] == MessageType.ERROR
    assert last["payload"]["error_code"] == "OUTSIDE_ALLOWED_ROOTS"


def test_unpaired_connection_gets_no_probe_answers(tmp_path: Path) -> None:
    probe = _probe(
        {
            "IDEER_CATIA_MCP_DIR": str(tmp_path / "absent"),
            "IDEER_ABAQUS_MCP_DIR": str(tmp_path / "absent"),
        },
        tmp_path,
    )
    server_key = Ed25519PrivateKey.generate()
    client = _client(server_key, probe, tmp_path)
    client.server_public_key = None

    asyncio.run(client._handle_task(_task(server_key, {"operation": "local.catia.probe"})))

    last = json.loads(client.connection.sent[-1])
    assert last["type"] == MessageType.ERROR
    assert last["payload"]["receipt"]["policy_decision"] == "deny"


def test_runtime_without_probe_service_announces_nothing(tmp_path: Path) -> None:
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        file_service=LocalFileService(LocalFileStore([RootConfig("/workspace", tmp_path)])),
    )
    names = client.current_capabilities()
    assert not any(name.startswith("local.catia.") or name.startswith("local.abaqus.") for name in names)
