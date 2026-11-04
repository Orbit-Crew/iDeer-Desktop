"""On-demand Skill dependency installation behind explicit consent (#104).

Covers the four #104 contracts on the device:

- the environment refusal carries the per-entry report, and only missing or
  unsatisfied dependency entries with a coherent exact ``==`` lock count as
  installable (interpreter, tool, data and range-only conditions never do);
- the plan only exists with a configured source, and the ask names the
  skill, the locked entries and that source (AC1);
- the consented install resolves every pin through the wheelhouse lock,
  verifies each artifact's sha256 before extracting a byte, and lands the
  wheels where this runtime actually imports them (AC2);
- every failure — unconfigured source, lock gap, bad hash, hostile wheel —
  refuses with a fixed category and bounded detail, and nothing installs
  when one artifact fails (AC4).
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest

from core.consent import ConsentStore
from core.policy import LocalPolicy
from core.protocol import public_key_text
from core.skill_dependencies import (
    SKILL_DEPENDENCIES_INSTALL_FAILED,
    MANIFEST_NAME,
    SKILL_DEPENDENCIES_UNAVAILABLE,
    DependencySource,
    SkillDependencyError,
    SkillDependencyService,
    normalize_name,
    resolve_target_dir,
    source_from_settings,
)
from core.skill_script import (
    SkillEnvironmentUnavailable,
    environment_report,
    installable_pins,
)


def declaration_with(**overrides):
    base = {"os": [], "dependencies": [], "software": [], "tools": [], "data": []}
    base.update(overrides)
    return base


def report_of(declaration: dict):
    return environment_report(declaration)


def unavailable_of(declaration: dict) -> SkillEnvironmentUnavailable:
    gap = SkillEnvironmentUnavailable(report_of(declaration))
    assert gap.unavailable, "the declaration must actually be unavailable"
    return gap


# --- environment report -------------------------------------------------------

def test_report_names_the_missing_distribution() -> None:
    report = report_of(declaration_with(dependencies=["ideer-demo==1.2.3"]))
    assert len(report) == 1
    entry = report[0]
    assert (entry.field, entry.name, entry.state) == ("dependencies", "ideer-demo", "missing")
    assert entry.pin == "1.2.3"
    assert entry.installed == ""


def test_report_marks_unsatisfied_range_and_keeps_the_pin(monkeypatch) -> None:
    monkeypatch.setattr(
        "importlib.metadata.version", lambda name: {"ideer-demo": "1.0.0"}[name]
    )
    report = report_of(declaration_with(dependencies=["ideer-demo>=2.0,==2.5.0"]))
    assert report[0].state == "unsatisfied"
    assert report[0].installed == "1.0.0"
    assert report[0].pin == "2.5.0"


def test_report_flags_interpreter_mismatch_as_never_installable() -> None:
    report = report_of(declaration_with(dependencies=["python3>=99.0"]))
    assert report[0].state == "interpreter"
    assert installable_pins(report) is None


def test_report_flags_absent_tools_and_data_conditions() -> None:
    report = report_of(declaration_with(tools=["definitely-not-on-path-xyz"], data=["corpus.db"]))
    states = {entry.field: entry.state for entry in report}
    assert states["tools"] == "absent"
    assert states["data"] == "unprovisioned"
    assert installable_pins(report) is None


def test_report_marks_grammar_violations_invalid() -> None:
    report = report_of(declaration_with(dependencies=["not a spec!"]))
    assert report[0].state == "invalid"
    assert installable_pins(report) is None


def test_unavailable_error_keeps_fixed_category_and_details() -> None:
    gap = unavailable_of(declaration_with(dependencies=["ideer-demo==1.2.3"]))
    assert str(gap) == "SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE"
    details = gap.details
    assert details["entries"][0]["name"] == "ideer-demo"
    assert details["entries"][0]["state"] == "missing"


# --- installability -----------------------------------------------------------

def test_only_exact_pins_are_installable() -> None:
    pinned = unavailable_of(declaration_with(dependencies=["ideer-demo==1.2.3"]))
    assert installable_pins(pinned.report) == [
        {"entry": "ideer-demo==1.2.3", "name": "ideer-demo", "version": "1.2.3"}
    ]


def test_range_only_gaps_are_not_installable() -> None:
    assert installable_pins(unavailable_of(declaration_with(dependencies=["ideer-demo>=1.0"])).report) is None


def test_coherent_compound_pin_is_installable_and_contradiction_is_not() -> None:
    coherent = unavailable_of(declaration_with(dependencies=["ideer-demo>=1.0,<2,==1.5.0"]))
    assert installable_pins(coherent.report) == [
        {"entry": "ideer-demo>=1.0,<2,==1.5.0", "name": "ideer-demo", "version": "1.5.0"}
    ]
    contradictory = unavailable_of(declaration_with(dependencies=["ideer-demo>=2,==1.5.0"]))
    assert installable_pins(contradictory.report) is None


def test_partial_installability_refuses_the_whole_plan() -> None:
    mixed = unavailable_of(declaration_with(dependencies=["ideer-demo==1.2.3", "ideer-other>=1.0"]))
    assert installable_pins(mixed.report) is None


# --- source configuration -----------------------------------------------------

def test_source_from_settings_validates_shape() -> None:
    assert source_from_settings({}) is None
    assert source_from_settings(None) is None
    source = source_from_settings({"kind": "offline", "location": "D:/wheels"})
    assert source == DependencySource("offline", "D:/wheels")
    assert source_from_settings({"kind": "pypi", "location": "https://x"}) is None
    assert source_from_settings({"kind": "intranet", "location": "  "}) is None


def test_normalize_name_follows_pep503() -> None:
    assert normalize_name("Demo_Pkg.A") == "demo-pkg-a"


# --- plan ----------------------------------------------------------------------

def make_service(tmp_path, *, source=None, fetcher=None):
    return SkillDependencyService(
        source=source,
        policy=LocalPolicy(),
        target_dir=tmp_path / "installed",
        fetcher=fetcher,
    )


def gap_payload(declaration):
    return {
        "skill_id": "44444444-4444-4444-8444-444444444444",
        "skill_version": 3,
        "declaration": dict(declaration, target="user_device"),
        "run_id": "run-104",
        "thread_id": "thread-104",
    }


def test_plan_requires_a_configured_source(tmp_path) -> None:
    service = make_service(tmp_path)
    gap = unavailable_of(declaration_with(dependencies=["ideer-demo==1.2.3"]))
    with pytest.raises(SkillDependencyError) as excinfo:
        service.plan(gap_payload(declaration_with(dependencies=["ideer-demo==1.2.3"])), gap.report)
    assert excinfo.value.code == SKILL_DEPENDENCIES_UNAVAILABLE


def test_plan_requires_offline_directory_to_exist(tmp_path) -> None:
    service = make_service(tmp_path, source=DependencySource("offline", str(tmp_path / "absent")))
    gap = unavailable_of(declaration_with(dependencies=["ideer-demo==1.2.3"]))
    with pytest.raises(SkillDependencyError) as excinfo:
        service.plan(gap_payload(declaration_with(dependencies=["ideer-demo==1.2.3"])), gap.report)
    assert excinfo.value.code == SKILL_DEPENDENCIES_UNAVAILABLE


def test_plan_names_skill_entries_and_source(tmp_path) -> None:
    source = DependencySource("intranet", "http://intranet.example/wheels")
    service = make_service(tmp_path, source=source)
    declaration = declaration_with(dependencies=["ideer-demo==1.2.3"])
    plan = service.plan(gap_payload(declaration), unavailable_of(declaration).report)
    assert plan["operation"] == "local.skill.dependencies"
    assert plan["skill_id"] == "44444444-4444-4444-8444-444444444444"
    assert plan["skill_version"] == 3
    assert plan["entries"] == [{"entry": "ideer-demo==1.2.3", "name": "ideer-demo", "version": "1.2.3"}]
    assert plan["source"] == {"kind": "intranet", "location": "http://intranet.example/wheels"}
    assert plan["run_id"] == "run-104"
    assert len(plan["requirements_sha256"]) == 64


def test_plan_returns_none_for_a_non_curable_report(tmp_path) -> None:
    service = make_service(tmp_path, source=DependencySource("offline", str(tmp_path)))
    declaration = declaration_with(dependencies=["python3>=99.0"])
    assert service.plan(gap_payload(declaration), unavailable_of(declaration).report) is None


# --- wheelhouse fixtures -------------------------------------------------------

def build_wheel_bytes(name: str, version: str) -> bytes:
    """A minimal real wheel: one module plus its dist-info metadata."""
    buffer = io.BytesIO()
    escaped = name.replace("-", "_")
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr(f"{escaped}/__init__.py", f"__version__ = '{version}'\n")
        dist_info = f"{escaped}-{version}.dist-info"
        bundle.writestr(f"{dist_info}/METADATA", f"Name: {name}\nVersion: {version}\n")
        bundle.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\n")
        bundle.writestr(f"{dist_info}/RECORD", "")
    return buffer.getvalue()


def make_offline_house(tmp_path, wheels: dict[str, tuple[str, str]]) -> DependencySource:
    """An offline wheelhouse directory with its lock manifest."""
    house = tmp_path / "house"
    house.mkdir()
    manifest = {"wheels": []}
    for (name, version), (filename, sha) in wheels.items():
        data = build_wheel_bytes(name, version)
        (house / filename).write_bytes(data)
        manifest["wheels"].append({
            "name": name, "version": version, "file": filename,
            "sha256": sha or hashlib.sha256(data).hexdigest(),
        })
    (house / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    return DependencySource("offline", str(house))


def install_plan(entries, source):
    return {
        "operation": "local.skill.dependencies",
        "skill_id": "44444444-4444-4444-8444-444444444444",
        "skill_version": 3,
        "requirements_sha256": "a" * 64,
        "entries": entries,
        "source": source,
        "run_id": "run-104",
        "thread_id": "thread-104",
    }


def offline_source(source: DependencySource):
    return {"kind": source.kind, "location": source.location}


# --- install -------------------------------------------------------------------

def test_install_extracts_verified_wheels_into_the_target(tmp_path) -> None:
    source = make_offline_house(tmp_path, {("ideer-demo", "1.2.3"): ("ideer_demo-1.2.3-py3-none-any.whl", "")})
    service = make_service(tmp_path, source=source)
    outcome = service.install(install_plan([
        {"entry": "ideer-demo==1.2.3", "name": "ideer-demo", "version": "1.2.3"},
    ], offline_source(source)))
    installed = outcome["installed"]
    assert installed[0]["name"] == "ideer-demo"
    assert installed[0]["version"] == "1.2.3"
    assert outcome["target_dir"] == str(tmp_path / "installed")
    assert (tmp_path / "installed" / "ideer_demo" / "__init__.py").read_text() == "__version__ = '1.2.3'\n"
    assert (tmp_path / "installed" / "ideer_demo-1.2.3.dist-info" / "METADATA").exists()


def test_install_is_all_or_nothing_on_a_bad_hash(tmp_path) -> None:
    source = make_offline_house(tmp_path, {
        ("ideer-demo", "1.2.3"): ("ideer_demo-1.2.3-py3-none-any.whl", "b" * 64),
        ("ideer-other", "0.1.0"): ("ideer_other-0.1.0-py3-none-any.whl", ""),
    })
    service = make_service(tmp_path, source=source)
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan([
            {"entry": "ideer-demo==1.2.3", "name": "ideer-demo", "version": "1.2.3"},
            {"entry": "ideer-other==0.1.0", "name": "ideer-other", "version": "0.1.0"},
        ], offline_source(source)))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED
    assert not (tmp_path / "installed").exists(), "nothing extracts when one artifact fails verification"


def test_install_refuses_lock_gaps_by_name(tmp_path) -> None:
    source = make_offline_house(tmp_path, {("ideer-demo", "1.2.3"): ("ideer_demo-1.2.3-py3-none-any.whl", "")})
    service = make_service(tmp_path, source=source)
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan([
            {"entry": "ideer-missing==9.9.9", "name": "ideer-missing", "version": "9.9.9"},
        ], offline_source(source)))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED
    assert "ideer-missing==9.9.9" in str(excinfo.value)


def test_install_refuses_hostile_wheel_members(tmp_path) -> None:
    house = tmp_path / "house"
    house.mkdir()
    house_source = DependencySource("offline", str(house))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("../escape.py", "print('slipped')\n")
    (house / "evil-1.0.0-py3-none-any.whl").write_bytes(buffer.getvalue())
    (house / MANIFEST_NAME).write_text(json.dumps({"wheels": [{
        "name": "evil", "version": "1.0.0", "file": "evil-1.0.0-py3-none-any.whl",
        "sha256": hashlib.sha256(buffer.getvalue()).hexdigest(),
    }]}), encoding="utf-8")
    service = make_service(tmp_path, source=house_source)
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan(
            [{"entry": "evil==1.0.0", "name": "evil", "version": "1.0.0"}],
            offline_source(house_source)))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED
    assert not (tmp_path / "installed").exists()


def test_install_refuses_data_dir_members(tmp_path) -> None:
    house = tmp_path / "house"
    house.mkdir()
    house_source = DependencySource("offline", str(house))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("demo/__init__.py", "")
        bundle.writestr("demo-1.0.0.data/scripts/run.bat", "echo hacked\n")
        bundle.writestr("demo-1.0.0.dist-info/METADATA", "Name: demo\n")
    (house / "demo-1.0.0-py3-none-any.whl").write_bytes(buffer.getvalue())
    (house / MANIFEST_NAME).write_text(json.dumps({"wheels": [{
        "name": "demo", "version": "1.0.0", "file": "demo-1.0.0-py3-none-any.whl",
        "sha256": hashlib.sha256(buffer.getvalue()).hexdigest(),
    }]}), encoding="utf-8")
    service = make_service(tmp_path, source=house_source)
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan(
            [{"entry": "demo==1.0.0", "name": "demo", "version": "1.0.0"}],
            offline_source(house_source)))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED


def test_install_refuses_a_malformed_lock(tmp_path) -> None:
    house = tmp_path / "house"
    house.mkdir()
    house_source = DependencySource("offline", str(house))
    (house / MANIFEST_NAME).write_text("{\"wheels\": [{\"name\": \"x\"}]}", encoding="utf-8")
    service = make_service(tmp_path, source=house_source)
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan(
            [{"entry": "x==1.0.0", "name": "x", "version": "1.0.0"}],
            offline_source(house_source)))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED


def test_install_validates_the_plan_shape(tmp_path) -> None:
    service = make_service(tmp_path, source=DependencySource("offline", str(tmp_path)))
    payload = install_plan(
        [{"entry": "x==1.0.0", "name": "x", "version": "1.0.0"}],
        {"kind": "offline", "location": str(tmp_path)})
    payload["surprise"] = "extra"
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(payload)
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED


def test_install_rides_the_intranet_fetcher_seam(tmp_path) -> None:
    wheel = build_wheel_bytes("ideer-demo", "1.2.3")
    manifest = json.dumps({"wheels": [{
        "name": "ideer-demo", "version": "1.2.3",
        "file": "ideer_demo-1.2.3-py3-none-any.whl",
        "sha256": hashlib.sha256(wheel).hexdigest(),
    }]}).encode()
    fetched: list[str] = []

    def fetcher(url: str, limit: int) -> bytes:
        fetched.append(url)
        if url.endswith(MANIFEST_NAME):
            return manifest
        return wheel

    service = make_service(
        tmp_path,
        source=DependencySource("intranet", "http://intranet.example/wheels"),
        fetcher=fetcher,
    )
    outcome = service.install(install_plan(
        [{"entry": "ideer-demo==1.2.3", "name": "ideer-demo", "version": "1.2.3"}],
        {"kind": "intranet", "location": "http://intranet.example/wheels"}))
    assert outcome["installed"][0]["version"] == "1.2.3"
    assert fetched == [
        "http://intranet.example/wheels/skill-deps.lock.json",
        "http://intranet.example/wheels/ideer_demo-1.2.3-py3-none-any.whl",
    ]


def test_resolve_target_dir_names_an_existing_directory() -> None:
    target = resolve_target_dir()
    assert target.is_absolute()


# --- wire round trips ---------------------------------------------------------

class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        pass


class FakeScriptExecutor:
    """Stands in for the constrained Python executor on the wire path."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def run(self, script, *, working_root, timeout, **kwargs):
        self.calls.append({"script": script, "timeout": timeout})
        from core.python import PythonResult, PythonTaskStatus
        return PythonResult(
            PythonTaskStatus.COMPLETED, 0, "after-install-ok\n", "",
            runtime_version="test", started_at=None, finished_at=None,
        )


WIRE_SCRIPT = "print('after-install-ok')\n"
WIRE_DECLARATION = {
    "target": "user_device",
    "os": ["windows"],
    "dependencies": ["ideerdemo==1.2.3"],
    "software": [],
    "tools": [],
    "data": [],
}


def wire_task_payload(**overrides):
    payload = {
        "skill_id": "44444444-4444-4444-8444-444444444444",
        "script_path": "scripts/analyze.py",
        "script_sha256": hashlib.sha256(WIRE_SCRIPT.encode()).hexdigest(),
        "skill_version": 3,
        "skill_content_hash": "a" * 64,
        "script": WIRE_SCRIPT,
        "declaration": json.loads(json.dumps(WIRE_DECLARATION)),
        "operation": "local.skill.script",
        "run_id": "run-104",
        "tool_call_id": "call-104",
    }
    payload.update(overrides)
    return payload


def make_wire_client(tmp_path, *, house=None, executor=None,
                     client_policy=None, with_dependency_service=True):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from core.receipt_ledger import ReceiptLedger
    from core.skill_script import SkillScriptRegistry, SkillScriptService
    from core.transport import LocalRuntimeClient

    server_key = Ed25519PrivateKey.generate()
    if house is None:
        house = make_offline_house(tmp_path, {("ideerdemo", "1.2.3"): ("ideerdemo-1.2.3-py3-none-any.whl", "")})
    target = tmp_path / "installed"
    dependency_service = None
    if with_dependency_service:
        dependency_service = SkillDependencyService(
            source=house, policy=LocalPolicy(), target_dir=target,
        )
    client = LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        server_public_key=public_key_text(server_key),
        receipt_ledger=ReceiptLedger(tmp_path / "receipts.db"),
        policy=client_policy,
        skill_script_service=SkillScriptService(
            SkillScriptRegistry(tmp_path / "grants.db"),
            policy=client_policy or LocalPolicy(),
            consent=ConsentStore(),
            executor=executor or FakeScriptExecutor(),
            current_system="windows",
        ),
        skill_dependency_service=dependency_service,
    )
    client.connection = FakeConnection()
    return client, server_key, target


def sign_wire(server_key, client, message_type, task_id, payload):
    from core.protocol import sign_envelope, verify_envelope

    envelope = sign_envelope(
        private_key=server_key,
        message_type=message_type,
        device_id="device-1",
        session_id="session-1",
        task_id=task_id,
        payload=payload,
    )
    return verify_envelope(
        envelope,
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )


def last_frame(client):
    return json.loads(client.connection.sent[-1])


def decide(client, server_key, frame, approved):
    from core.protocol import MessageType

    return sign_wire(
        server_key, client, MessageType.CONSENT_DECISION, frame["task_id"],
        {
            "approved": approved,
            "actor_id": "alice",
            "request_hash": frame["payload"]["request_hash"],
        },
    )


@pytest.mark.asyncio
async def test_wire_missing_pinned_dependency_asks_installs_then_asks_the_script(
    tmp_path, monkeypatch
) -> None:
    """AC1-AC3 over the signed wire: ask, install, re-ask the script, run."""
    from core.protocol import MessageType

    executor = FakeScriptExecutor()
    client, server_key, target = make_wire_client(tmp_path, executor=executor)
    monkeypatch.syspath_prepend(str(target))
    task = sign_wire(
        server_key, client, MessageType.TASK, "task-104", wire_task_payload()
    )
    await client._handle_task(task)

    ask = last_frame(client)
    assert ask["type"] == MessageType.CONSENT_REQUIRED
    assert ask["payload"]["capability"] == "local.skill.dependencies"
    install_payload = ask["payload"]["payload"]
    assert install_payload["skill_id"] == "44444444-4444-4444-8444-444444444444"
    assert install_payload["entries"] == [
        {"entry": "ideerdemo==1.2.3", "name": "ideerdemo", "version": "1.2.3"}
    ]
    assert install_payload["source"]["kind"] == "offline"
    assert install_payload["requirements_sha256"]
    assert executor.calls == []  # nothing runs, nothing installs before consent

    await client._handle_consent_decision(decide(client, server_key, ask, True))

    script_ask = last_frame(client)
    assert script_ask["type"] == MessageType.CONSENT_REQUIRED
    assert script_ask["payload"]["capability"] == "local.skill.script"
    assert (target / "ideerdemo" / "__init__.py").exists()  # installed only after consent

    await client._handle_consent_decision(decide(client, server_key, script_ask, True))

    result = last_frame(client)
    assert result["type"] == MessageType.TASK_RESULT
    receipt = result["payload"]["receipt"]
    assert receipt["capability"] == "local.skill.script"
    assert receipt["authorization_basis"] == "approved"
    assert executor.calls and executor.calls[0]["script"] == WIRE_SCRIPT
    stored = client.receipt_ledger.pending(client.receipt_binding())
    assert stored and stored[0]["receipt"]["capability"] == "local.skill.script"


@pytest.mark.asyncio
async def test_wire_denied_install_never_touches_the_device(tmp_path) -> None:
    from core.protocol import MessageType

    executor = FakeScriptExecutor()
    client, server_key, target = make_wire_client(tmp_path, executor=executor)
    task = sign_wire(server_key, client, MessageType.TASK, "task-104", wire_task_payload())
    await client._handle_task(task)
    ask = last_frame(client)

    await client._handle_consent_decision(decide(client, server_key, ask, False))

    error = last_frame(client)
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "DENIED"
    assert error["payload"]["receipt"]["capability"] == "local.skill.dependencies"
    assert executor.calls == []
    assert not target.exists()


@pytest.mark.asyncio
async def test_wire_install_failure_is_honest_and_retryable(tmp_path) -> None:
    """AC4: a bad artifact refuses with the fixed category; the next run asks again."""
    from core.protocol import MessageType

    house = make_offline_house(
        tmp_path, {("ideerdemo", "1.2.3"): ("ideerdemo-1.2.3-py3-none-any.whl", "c" * 64)}
    )
    client, server_key, _target = make_wire_client(tmp_path, house=house)
    task = sign_wire(server_key, client, MessageType.TASK, "task-104", wire_task_payload())
    await client._handle_task(task)
    ask = last_frame(client)
    await client._handle_consent_decision(decide(client, server_key, ask, True))

    error = last_frame(client)
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "SKILL_DEPENDENCIES_INSTALL_FAILED"

    # A fresh run asks again: the failure did not burn the path.
    retry = sign_wire(server_key, client, MessageType.TASK, "task-105", wire_task_payload())
    await client._handle_task(retry)
    assert last_frame(client)["payload"]["capability"] == "local.skill.dependencies"


@pytest.mark.asyncio
async def test_wire_non_installable_gap_refuses_with_details(tmp_path) -> None:
    from core.protocol import MessageType

    client, server_key, _target = make_wire_client(tmp_path)
    payload = wire_task_payload(
        declaration=dict(WIRE_DECLARATION, dependencies=["ideerdemo>=1.0"])
    )
    task = sign_wire(server_key, client, MessageType.TASK, "task-104", payload)
    await client._handle_task(task)

    error = last_frame(client)
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE"
    assert error["payload"]["details"]["entries"][0]["name"] == "ideerdemo"
    assert error["payload"]["details"]["entries"][0]["state"] == "missing"


@pytest.mark.asyncio
async def test_wire_without_a_service_the_gap_still_names_what_is_missing(tmp_path) -> None:
    from core.protocol import MessageType

    client, server_key, _target = make_wire_client(tmp_path, with_dependency_service=False)
    task = sign_wire(server_key, client, MessageType.TASK, "task-104", wire_task_payload())
    await client._handle_task(task)

    error = last_frame(client)
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE"
    assert error["payload"]["details"]["entries"][0]["state"] == "missing"


@pytest.mark.asyncio
async def test_wire_policy_denied_installs_never_ask(tmp_path) -> None:
    from core.policy import LocalPolicy as _Policy
    from core.protocol import MessageType

    vetoed = _Policy(denied_capabilities=frozenset({"local.skill.dependencies"}))
    client, server_key, target = make_wire_client(tmp_path, client_policy=vetoed)
    task = sign_wire(server_key, client, MessageType.TASK, "task-104", wire_task_payload())
    await client._handle_task(task)

    error = last_frame(client)
    assert error["type"] == MessageType.ERROR
    assert error["payload"]["error_code"] == "LOCAL_POLICY_DENIED"
    assert error["payload"]["receipt"]["capability"] == "local.skill.dependencies"
    assert not target.exists()


def test_intranet_source_must_be_http_s() -> None:
    """The fetcher opens exactly the configured URL: only http(s) locations
    are a source at all (a file:// or ftp:// string is not one)."""
    assert source_from_settings({"kind": "intranet", "location": "file:///C:/wheels"}) is None
    assert source_from_settings({"kind": "intranet", "location": "ftp://intranet/wheels"}) is None
    assert source_from_settings({"kind": "intranet", "location": "http://intranet/wheels"}) is not None
    assert source_from_settings({"kind": "intranet", "location": "https://intranet/wheels"}) is not None


def test_install_refuses_a_non_http_intranet_plan(tmp_path) -> None:
    service = make_service(tmp_path, source=DependencySource("intranet", "file:///C:/wheels"))
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan(
            [{"entry": "x==1.0.0", "name": "x", "version": "1.0.0"}],
            {"kind": "intranet", "location": "file:///C:/wheels"}))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED


def test_fetch_refuses_redirects(tmp_path) -> None:
    """The approved location is the only destination: a redirecting source
    refuses instead of following the bounce off-site."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Redirecting(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://elsewhere.example/wheel.whl")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Redirecting)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        service = make_service(
            tmp_path,
            source=DependencySource("intranet", f"http://127.0.0.1:{server.server_port}"),
        )
        with pytest.raises(SkillDependencyError) as excinfo:
            service.install(install_plan(
                [{"entry": "x==1.0.0", "name": "x", "version": "1.0.0"}],
                {"kind": "intranet", "location": f"http://127.0.0.1:{server.server_port}"}))
        assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_bounded_read_stats_before_reading(tmp_path) -> None:
    from core.skill_dependencies import _bounded_file_read
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * 16)
    with pytest.raises(OSError):
        _bounded_file_read(big, 8)
    assert _bounded_file_read(big, 16) == b"x" * 16


def test_wheel_uncompressed_budget_is_enforced(tmp_path, monkeypatch) -> None:
    import core.skill_dependencies as module
    house = tmp_path / "house"
    house.mkdir()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("demo/__init__.py", "x = '" + "0" * 4096 + "'\n")
        bundle.writestr("demo-1.0.0.dist-info/METADATA", "Name: demo\n")
    (house / "demo-1.0.0-py3-none-any.whl").write_bytes(buffer.getvalue())
    (house / MANIFEST_NAME).write_text(json.dumps({"wheels": [{
        "name": "demo", "version": "1.0.0", "file": "demo-1.0.0-py3-none-any.whl",
        "sha256": hashlib.sha256(buffer.getvalue()).hexdigest(),
    }]}), encoding="utf-8")
    monkeypatch.setattr(module, "MAX_EXTRACTED_BYTES", 1024)
    service = make_service(tmp_path, source=DependencySource("offline", str(house)))
    with pytest.raises(SkillDependencyError) as excinfo:
        service.install(install_plan(
            [{"entry": "demo==1.0.0", "name": "demo", "version": "1.0.0"}],
            {"kind": "offline", "location": str(house)}))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED
    assert "uncompressed" in str(excinfo.value)


def test_oserror_during_install_answers_the_wire(tmp_path) -> None:
    """AC4: even a disk failure mid-install is one honest category, never a
    stranded task."""
    from unittest.mock import patch
    source = make_offline_house(tmp_path, {("ideer-demo", "1.2.3"): ("ideer_demo-1.2.3-py3-none-any.whl", "")})
    service = make_service(tmp_path, source=source)
    with patch.object(SkillDependencyService, "_extract_wheel", side_effect=OSError("disk full")):
        with pytest.raises(SkillDependencyError) as excinfo:
            service.install(install_plan(
                [{"entry": "ideer-demo==1.2.3", "name": "ideer-demo", "version": "1.2.3"}],
                offline_source(source)))
    assert excinfo.value.code == SKILL_DEPENDENCIES_INSTALL_FAILED
