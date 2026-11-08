"""Issue 87: desktop-side CATIA/Abaqus discovery — probe, announce, guide.

The Desktop only detects and reports: per-component install/plugin/license
evidence with one actionable hint per missing piece, plus the authorized
boundary a job result must already sit inside before its facts are
registered. The external software loop belongs to iDeer #124/#125, so
nothing here launches software, spawns MCP servers, or runs jobs — every
probe is a plain filesystem-and-environment read.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

#: The one status per probed component; ``unknown`` is an honest answer when
#: a license cannot be confirmed without launching the software itself.
PRESENT = "present"
MISSING = "missing"
UNKNOWN = "unknown"

CATIA = "catia"
ABAQUS = "abaqus"
TOOLS = (CATIA, ABAQUS)

#: The probe capability is always announced once this service exists; the
#: ready capability only rides along while every component answers present.
PROBE_OPERATIONS = {"local.catia.probe": CATIA, "local.abaqus.probe": ABAQUS}
RESULT_OPERATIONS = {"local.catia.result": CATIA, "local.abaqus.result": ABAQUS}
READY_CAPABILITIES = {CATIA: "local.catia.ready", ABAQUS: "local.abaqus.ready"}

#: Directory overrides for the MCP server projects (the original probed a
#: hardcoded development path; the Desktop keeps the same defaults and adds
#: an environment override).
DEFAULT_CATIA_SERVER_DIR = r"E:\lijx\plane3d\3D_software_mcp\catia-v5-mcp-server"
DEFAULT_ABAQUS_SERVER_DIR = r"E:\lijx\plane3d\3D_software_mcp\abaqus-mcp"
CATIA_SERVER_DIR_ENV = "IDEER_CATIA_MCP_DIR"
ABAQUS_SERVER_DIR_ENV = "IDEER_ABAQUS_MCP_DIR"

#: Job-output facts are hashed in bounded chunks; a multi-gigabyte ODB never
#: loads whole.
_HASH_CHUNK_BYTES = 1 << 20

_VERSION_PATTERNS = (re.compile(r"\b[Bb](\d{2})\b"), re.compile(r"\b(20\d{2})\b"))


class EngineeringProbeError(RuntimeError):
    """A fixed-category probe failure; safe to surface as an error code."""


@dataclass(frozen=True)
class ComponentState:
    status: str
    detail: str = ""
    hint: str = ""


@dataclass(frozen=True)
class ProbeReport:
    tool: str
    components: dict[str, ComponentState]

    @property
    def ready(self) -> bool:
        return all(state.status == PRESENT for state in self.components.values())

    @property
    def hints(self) -> list[str]:
        return [state.hint for state in self.components.values() if state.hint]

    def as_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "ready": self.ready,
            "components": {
                name: {"status": state.status, "detail": state.detail, "hint": state.hint}
                for name, state in self.components.items()
            },
            "hints": self.hints,
        }


def _dir(env: Mapping[str, str], name: str) -> Path | None:
    value = env.get(name, "")
    return Path(value) if value else None


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _child_dirs(base: Path) -> list[Path]:
    try:
        return sorted(entry for entry in base.iterdir() if entry.is_dir())
    except OSError:
        return []


def _version_in(path: str) -> str:
    for pattern in _VERSION_PATTERNS:
        found = pattern.search(path)
        if found:
            return found.group(0)
    return ""


def _python_state(env: Mapping[str, str]) -> ComponentState:
    """The interpreter the MCP servers launch with — the original's
    ``detectPythonPath``: PATH first, then the usual Windows locations."""
    path_env = env.get("PATH", "")
    for name in ("python", "python3", "py"):
        found = shutil.which(name, path=path_env)
        if found and _is_file(Path(found)):
            return ComponentState(PRESENT, detail=found)
    suffix = ".exe" if os.name == "nt" else ""
    candidates: list[Path] = []
    local = _dir(env, "LOCALAPPDATA")
    if local is not None:
        candidates.append(local / "Microsoft" / "WindowsApps" / f"python{suffix}")
        programs = local / "Programs" / "Python"
        for entry in _child_dirs(programs):
            if entry.name.lower().startswith("python3"):
                candidates.append(entry / f"python{suffix}")
    system_drive = env.get("SystemDrive", "")
    if system_drive:
        root = Path(system_drive)
        if _is_dir(root):
            try:
                for entry in sorted(root.iterdir()):
                    if re.fullmatch(r"[Pp]ython3\d*", entry.name):
                        candidates.append(entry / f"python{suffix}")
            except OSError:
                pass
    for candidate in candidates:
        if _is_file(candidate):
            return ComponentState(PRESENT, detail=str(candidate))
    return ComponentState(
        MISSING,
        hint="未检测到可用的 Python 解释器(MCP 服务器以 python 方式启动):"
             "请安装 Python 3 并加入 PATH 后重新探测",
    )


def _catia_software_state(env: Mapping[str, str]) -> ComponentState:
    checked: list[str] = []
    install = _dir(env, "CATINSTALLDIR")
    if install is not None:
        checked.append(str(install))
        version = _version_in(str(install))
        if _is_dir(install / "win_b64"):
            detail = f"{version} ({install})" if version else str(install)
            return ComponentState(PRESENT, detail=detail)
    program_files = _dir(env, "ProgramFiles")
    if program_files is not None:
        base = program_files / "Dassault Systemes"
        for release in _child_dirs(base):
            checked.append(str(release))
            if _is_dir(release / "win_b64"):
                return ComponentState(PRESENT, detail=f"{release.name} ({release})")
    return ComponentState(
        MISSING,
        hint="未检测到 CATIA V5 安装:请安装 CATIA V5(安装目录含 win_b64),"
             "或设置环境变量 CATINSTALLDIR 指向安装目录后重新探测",
    )


def _catia_license_state(env: Mapping[str, str]) -> ComponentState:
    value = env.get("CATALICENCE_FILE", "")
    if value:
        if _is_file(Path(value)):
            return ComponentState(PRESENT, detail=str(value))
        return ComponentState(
            MISSING,
            hint="CATALICENCE_FILE 指向的许可文件不可见:请核对路径,"
                 "DSLS 许可请改用 %ProgramData%\\DassaultSystemes\\Licenses",
        )
    program_data = _dir(env, "ProgramData")
    if program_data is not None:
        licenses = program_data / "DassaultSystemes" / "Licenses"
        # A DSLS grant shows up as content in the license directory; an
        # empty directory proves nothing, so it stays an honest unknown.
        if _is_dir(licenses):
            try:
                entries = list(licenses.iterdir())
            except OSError:
                entries = []
            if entries:
                return ComponentState(PRESENT, detail=str(licenses))
    return ComponentState(
        UNKNOWN,
        hint="未能静态确认 CATIA 许可:文件许可请设置 CATALICENCE_FILE 指向 .lic 文件,"
             "DSLS 许可请确认 %ProgramData%\\DassaultSystemes\\Licenses 可访问后重新探测",
    )


def _abaqus_software_state(env: Mapping[str, str]) -> ComponentState:
    bases: list[Path] = []
    home = _dir(env, "ABAQUS_HOME")
    if home is not None:
        bases.append(home)
    system_drive = env.get("SystemDrive", "")
    if system_drive:
        bases.append(Path(system_drive) / "SIMULIA")
    program_files = _dir(env, "ProgramFiles")
    if program_files is not None:
        bases.append(program_files / "SIMULIA")
    for base in bases:
        launcher = base / "Commands" / "abaqus.bat"
        if _is_file(launcher):
            return ComponentState(PRESENT, detail=str(launcher))
        if _is_dir(base / "code"):
            version = _version_in(str(base))
            detail = f"{version} ({base})" if version else str(base)
            return ComponentState(PRESENT, detail=detail)
        for year in _child_dirs(base / "CAE"):
            return ComponentState(PRESENT, detail=f"{year.name} ({year})")
    return ComponentState(
        MISSING,
        hint="未检测到 Abaqus 安装:请安装 Abaqus/CAE,或设置环境变量 ABAQUS_HOME "
             "指向安装根目录后重新探测",
    )


def _abaqus_license_state(env: Mapping[str, str]) -> ComponentState:
    for name in ("ABAQUSLM_LICENSE_FILE", "LM_LICENSE_FILE"):
        value = env.get(name, "")
        if not value:
            continue
        if "@" in value:
            return ComponentState(PRESENT, detail=f"{name}={value}")
        if _is_file(Path(value)):
            return ComponentState(PRESENT, detail=str(value))
        return ComponentState(
            MISSING,
            hint=f"{name} 指向的许可文件不可见:请核对路径,"
                 "网络许可用 27000@server 形式",
        )
    return ComponentState(
        UNKNOWN,
        hint="未能静态确认 Abaqus 许可:网络许可请设置 ABAQUSLM_LICENSE_FILE"
             "(如 27000@server),或指向许可文件后重新探测",
    )


def _catia_plugin_state(env: Mapping[str, str]) -> ComponentState:
    base = Path(env.get(CATIA_SERVER_DIR_ENV, "") or DEFAULT_CATIA_SERVER_DIR)
    if not _is_dir(base):
        return ComponentState(
            MISSING,
            hint=f"未找到 CATIA MCP 插件目录(默认 {DEFAULT_CATIA_SERVER_DIR}):"
                 f"请准备包含 catia_mcp 模块的 catia-v5-mcp-server 项目,"
                 f"并设置 {CATIA_SERVER_DIR_ENV} 指向它后重新探测",
        )
    if not _is_dir(base / "catia_mcp"):
        return ComponentState(
            MISSING,
            hint=f"CATIA 插件目录存在但缺少 catia_mcp 模块({base}):"
                 "请核对该目录是否为完整的 catia-v5-mcp-server 项目",
        )
    return ComponentState(PRESENT, detail=str(base))


def _abaqus_plugin_state(env: Mapping[str, str]) -> ComponentState:
    base = Path(env.get(ABAQUS_SERVER_DIR_ENV, "") or DEFAULT_ABAQUS_SERVER_DIR)
    if not _is_dir(base):
        return ComponentState(
            MISSING,
            hint=f"未找到 Abaqus MCP 插件目录(默认 {DEFAULT_ABAQUS_SERVER_DIR}):"
                 f"请准备包含 mcp_server.py 的 abaqus-mcp 项目,"
                 f"并设置 {ABAQUS_SERVER_DIR_ENV} 指向它后重新探测",
        )
    if not _is_file(base / "mcp_server.py"):
        return ComponentState(
            MISSING,
            hint=f"Abaqus 插件目录存在但缺少 mcp_server.py({base}):"
                 "请核对该目录是否为完整的 abaqus-mcp 项目",
        )
    return ComponentState(PRESENT, detail=str(base))


def register_engineering_result(
    *,
    store,
    registry,
    binding: Mapping[str, str],
    tool: str,
    logical_path: str,
    thread_id: str = "",
    run_id: str = "",
    task_id: str = "",
) -> dict[str, Any]:
    """Register one job-output fact that already sits inside the boundary.

    ``store.resolve`` refuses anything outside the authorized roots, so a
    result that cannot be proven in-boundary is never recorded. The file
    itself never moves and its bytes never leave: only the logical path,
    hash and size join the display registry, exactly like workspace-write
    facts do.
    """
    from .files import LOCKED_OR_UNAVAILABLE, NOT_A_FILE, NOT_FOUND, FileAccessError

    if tool not in TOOLS:
        raise ValueError("unsupported probe tool")
    root, path = store.resolve_with_root(logical_path)
    if not path.exists():
        raise FileAccessError(NOT_FOUND, "file not found")
    if not path.is_file():
        raise FileAccessError(NOT_A_FILE, "not a file")
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(_HASH_CHUNK_BYTES), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise FileAccessError(LOCKED_OR_UNAVAILABLE, "locked or unavailable") from exc
    record = {
        "thread_id": str(thread_id),
        "run_id": str(run_id),
        "task_id": str(task_id),
        "capability": f"local.{tool}.result",
        "logical_root": root.logical_root,
        "logical_path": str(logical_path),
        "name": PurePosixPath(str(logical_path)).name,
        "sha256": digest.hexdigest(),
        "bytes": size,
    }
    registry.record(dict(binding), record)
    return {**record, "registered": True}


class EngineeringSoftwareProbe:
    """Honest desktop-side discovery for the CATIA/Abaqus seams.

    Announces the two probe capabilities unconditionally (the detection
    surface itself), plus ``local.<tool>.ready`` only while every component
    of that tool answers present — readiness never rides on stale state,
    because the announcement is recomputed from the filesystem every time.
    """

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.env: dict[str, str] = dict(os.environ if env is None else env)

    def probe(self, tool: str) -> ProbeReport:
        if tool == CATIA:
            components = {
                "software": _catia_software_state(self.env),
                "plugin": _catia_plugin_state(self.env),
                "python": _python_state(self.env),
                "license": _catia_license_state(self.env),
            }
        elif tool == ABAQUS:
            components = {
                "software": _abaqus_software_state(self.env),
                "plugin": _abaqus_plugin_state(self.env),
                "python": _python_state(self.env),
                "license": _abaqus_license_state(self.env),
            }
        else:
            raise EngineeringProbeError("unsupported probe tool")
        return ProbeReport(tool=tool, components=components)

    def capability_names(self) -> tuple[str, ...]:
        """The capability set this device announces for these tools."""
        names = set(PROBE_OPERATIONS)
        for tool in TOOLS:
            if self.probe(tool).ready:
                names.add(READY_CAPABILITIES[tool])
        return tuple(sorted(names))

    def run_probe_operation(self, operation: str) -> dict[str, Any]:
        tool = PROBE_OPERATIONS.get(operation)
        if tool is None:
            raise ValueError("unsupported probe operation")
        return self.probe(tool).as_dict()
