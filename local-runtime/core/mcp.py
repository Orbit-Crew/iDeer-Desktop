"""Device-side MCP host: transports, discovery, supervision, and projection.

The Local Runtime is the Device-side MCP Execution Host. Servers configured on
this device are launched and supervised here; the Agent reaches them only
through Server → Local Task → Local Runtime → local MCP. This module owns the
MCP wire protocol (stdio and localhost HTTP), server lifecycle, and the
``local.mcp.<server>.<tool>`` capability projection.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
import subprocess
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .compat import StrEnum
from .consent import ConsentStore, request_hash
from .policy import LocalPolicy, PolicyDecision
from .receipts import LocalExecutionReceipt, content_hash
from .secrets import SecretRedactor

MCP_PROTOCOL_VERSION = "2024-11-05"
SUPPORTED_MCP_PROTOCOL_VERSIONS = frozenset({MCP_PROTOCOL_VERSION})
CLIENT_INFO = {"name": "ideer-local-runtime", "version": "0.1.0"}
SERVER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
SECRET_REFERENCE_PREFIX = "local:"


class MCPError(Exception):
    """A user-safe MCP failure; local paths and credentials are never included."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code.lower().replace("_", " "))


@dataclass(frozen=True)
class MCPTool:
    name: str
    description: str = ""
    input_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class MCPSpec:
    """One user-configured MCP server on this device."""

    name: str
    transport: str
    command: tuple[str, ...] = ()
    url: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    tool_timeout_seconds: float = 30.0
    start_timeout_seconds: float = 10.0
    max_restarts: int = 3
    restart_backoff_seconds: float = 1.0

    def __post_init__(self) -> None:
        if not SERVER_NAME_PATTERN.fullmatch(self.name):
            raise MCPError(
                "INVALID_SERVER_NAME", "server name must be letters, digits, '-' or '_'"
            )
        if self.transport not in {"stdio", "http"}:
            raise MCPError("INVALID_TRANSPORT", "transport must be stdio or http")
        if self.transport == "stdio" and not self.command:
            raise MCPError("INVALID_COMMAND", "stdio servers require a command")
        if self.transport == "http" and not self.url:
            raise MCPError("INVALID_URL", "http servers require a url")
        if self.tool_timeout_seconds <= 0 or self.start_timeout_seconds <= 0:
            raise MCPError("INVALID_TIMEOUT", "timeouts must be positive")
        if self.max_restarts < 0 or self.restart_backoff_seconds < 0:
            raise MCPError(
                "INVALID_RESTART_POLICY", "restart policy values must not be negative"
            )

    @property
    def capability_prefix(self) -> str:
        return f"local.mcp.{self.name}."


def parse_mcp_config(data: Mapping[str, Any]) -> list[MCPSpec]:
    """Parse the device-local MCP configuration; unknown keys are ignored."""
    specs: list[MCPSpec] = []
    names: set[str] = set()
    for entry in data.get("servers", ()):
        if not isinstance(entry, Mapping):
            raise MCPError("INVALID_CONFIG", "each MCP server entry must be an object")
        known = {
            name: entry[name]
            for name in (
                "name",
                "transport",
                "command",
                "url",
                "env",
                "headers",
                "enabled",
                "tool_timeout_seconds",
                "start_timeout_seconds",
                "max_restarts",
                "restart_backoff_seconds",
            )
            if name in entry
        }
        spec = MCPSpec(
            name=str(known.get("name", "")),
            transport=str(known.get("transport", "")),
            command=tuple(str(part) for part in known.get("command", ()) or ()),
            url=str(known["url"]) if known.get("url") else None,
            env={str(k): str(v) for k, v in dict(known.get("env") or {}).items()},
            headers={
                str(k): str(v) for k, v in dict(known.get("headers") or {}).items()
            },
            enabled=bool(known.get("enabled", True)),
            tool_timeout_seconds=float(known.get("tool_timeout_seconds", 30.0)),
            start_timeout_seconds=float(known.get("start_timeout_seconds", 10.0)),
            max_restarts=int(known.get("max_restarts", 3)),
            restart_backoff_seconds=float(known.get("restart_backoff_seconds", 1.0)),
        )
        if spec.name in names:
            raise MCPError(
                "DUPLICATE_SERVER", f"server name is duplicated: {spec.name}"
            )
        names.add(spec.name)
        specs.append(spec)
    return specs


def load_mcp_specs(path: str | Path) -> list[MCPSpec]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise MCPError("INVALID_CONFIG", "the MCP configuration must be an object")
    return parse_mcp_config(data)


@dataclass(frozen=True)
class MCPNetworkPolicy:
    """MCP egress policy: loopback always, approved intranet on request, no public net."""

    allow_public_internet: bool = False
    approved_hosts: frozenset[str] = field(default_factory=frozenset)

    def validate_url(self, url: str) -> None:
        parsed = _parse_http_url(url)
        if parsed is None:
            raise MCPError("INVALID_URL", "the MCP server URL is not a valid HTTP URL")
        _, host, _, _ = parsed
        if self.allow_public_internet:
            return
        if host.casefold() in {"localhost"} or host in self.approved_hosts:
            return
        if _is_literal_ip(host):
            if self._address_allowed(host):
                return
            raise MCPError(
                "NETWORK_DENIED",
                "the MCP server URL is outside the local network policy",
            )
        addresses = _resolve_hosts(host)
        if addresses and all(self._address_allowed(address) for address in addresses):
            return
        raise MCPError(
            "NETWORK_DENIED", "the MCP server URL is outside the local network policy"
        )

    def _address_allowed(self, address: str) -> bool:
        parsed = ipaddress.ip_address(address)
        if parsed.is_loopback:
            return True
        return self._approved_networks_contain(address)

    def _approved_networks_contain(self, address: str) -> bool:
        target = ipaddress.ip_address(address)
        for entry in self.approved_hosts:
            try:
                if target in ipaddress.ip_network(entry, strict=False):
                    return True
            except ValueError:
                continue
        return False


def _is_literal_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _resolve_hosts(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return []
    addresses: list[str] = []
    for info in infos:
        address = info[4][0]
        if address not in addresses:
            addresses.append(address)
    return addresses


@dataclass(frozen=True)
class MCPExecution:
    """One executed MCP tool task with its local execution receipt."""

    status: str
    value: dict[str, Any]
    receipt: LocalExecutionReceipt


class LocalMCPService:
    """Policy-gated facade over the supervisor, mirroring the other services.

    Model-visible capabilities are the projected ``local.mcp.<server>.<tool>``
    names only; the model never sees ports, command lines, or credentials.
    """

    def __init__(
        self,
        supervisor: MCPSupervisor,
        *,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
        on_capabilities_changed: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.supervisor = supervisor
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()
        self.on_capabilities_changed = on_capabilities_changed
        supervisor.on_change = self._on_supervisor_change

    async def _on_supervisor_change(self) -> None:
        if self.on_capabilities_changed is not None:
            await self.on_capabilities_changed()

    async def refresh(self) -> None:
        """Re-enumerate tools and surface the change to the registered hook."""
        await self.supervisor.refresh_all()
        await self._on_supervisor_change()

    async def execute(
        self,
        capability: str,
        payload: dict[str, Any],
        *,
        consent: bool = False,
        timeout: float | None = None,
    ) -> MCPExecution | PolicyDecision:
        if not split_capability(capability):
            raise ValueError("unsupported local MCP capability")
        arguments = payload.get("arguments", {})
        if not isinstance(arguments, dict):
            raise TypeError("arguments must be an object")
        digest = request_hash(payload)
        run_id = str(payload.get("run_id", ""))
        task_id = str(payload.get("task_id", ""))
        try:
            self.supervisor.ensure_callable(capability)
        except MCPError as exc:
            return self._failure_execution(
                capability,
                run_id,
                task_id,
                digest,
                exc,
                consent_decision=None,
                message=self.supervisor.redactor_for(capability).redact(str(exc)),
            )
        granted = consent or self.consent.consume(capability, digest)
        decision = self.policy.authorize(capability, payload, consent=granted)
        if decision is not PolicyDecision.ALLOW:
            return decision
        try:
            result = await self.supervisor.call_tool(
                capability, arguments, timeout=timeout
            )
        except MCPError as exc:
            return self._failure_execution(
                capability,
                run_id,
                task_id,
                digest,
                exc,
                consent_decision="approved" if granted else None,
                message=self.supervisor.redactor_for(capability).redact(str(exc)),
            )
        value = {
            "status": "failed" if result.is_error else "completed",
            "content": [dict(entry) for entry in result.content],
            "is_error": result.is_error,
            "structured_content": result.structured_content,
        }
        receipt = LocalExecutionReceipt(
            run_id=run_id,
            task_id=task_id,
            capability=capability,
            policy_decision=PolicyDecision.ALLOW.value,
            status=value["status"],
            payload_hash=digest,
            result_hash=content_hash(value),
            consent_decision="approved" if granted else None,
        )
        return MCPExecution(value["status"], value, receipt)

    @staticmethod
    def _failure_execution(
        capability: str,
        run_id: str,
        task_id: str,
        digest: str,
        exc: MCPError,
        *,
        consent_decision: str | None,
        message: str | None = None,
    ) -> MCPExecution:
        status = "timed_out" if exc.code == "MCP_TIMEOUT" else "failed"
        value = {
            "status": status,
            "error_code": exc.code,
            "message": message if message is not None else str(exc),
        }
        receipt = LocalExecutionReceipt(
            run_id=run_id,
            task_id=task_id,
            capability=capability,
            policy_decision=PolicyDecision.ALLOW.value,
            status=status,
            payload_hash=digest,
            consent_decision=consent_decision,
        )
        return MCPExecution(status, value, receipt)


def split_capability(capability: str) -> tuple[str, str]:
    """Split ``local.mcp.<server>.<tool>`` into its server and tool parts."""
    prefix = "local.mcp."
    if not capability.startswith(prefix):
        raise MCPError("INVALID_CAPABILITY", "not a local MCP capability")
    server, separator, tool = capability[len(prefix) :].partition(".")
    if not separator or not server or not tool:
        raise MCPError("INVALID_CAPABILITY", "incomplete local MCP capability")
    return server, tool


class MCPServerState(StrEnum):
    DISABLED = "disabled"
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    RESTARTING = "restarting"
    FAILED = "failed"


@dataclass
class _ServerRecord:
    spec: MCPSpec
    state: MCPServerState
    enabled: bool
    connection: Any = None
    tools: tuple[MCPTool, ...] = ()
    resolved_env: dict[str, str] = field(default_factory=dict)
    resolved_headers: dict[str, str] = field(default_factory=dict)
    restarts: int = 0
    last_error: str | None = None
    stopping: bool = False
    restart_task: asyncio.Task[None] | None = None

    def tool_names(self) -> frozenset[str]:
        return frozenset(tool.name for tool in self.tools)


class MCPSupervisor:
    """Lifecycle and fault isolation for this device's MCP servers.

    Every server lives in its own connection with its own restart budget; a
    crash, timeout, or schema change in one server never escapes into the
    Local Runtime or into another server.
    """

    def __init__(
        self,
        specs: list[MCPSpec],
        *,
        connection_factory: Callable[..., Any] | None = None,
        network_policy: MCPNetworkPolicy | None = None,
        secret_resolver: Callable[[str], str | None] | None = None,
        on_change: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.network_policy = network_policy or MCPNetworkPolicy()
        self.secret_resolver = secret_resolver
        self.on_change = on_change
        self._connection_factory = connection_factory or self._default_connection
        self._records: dict[str, _ServerRecord] = {}
        for spec in specs:
            initial = (
                MCPServerState.DISABLED if not spec.enabled else MCPServerState.STOPPED
            )
            self._records[spec.name] = _ServerRecord(spec, initial, spec.enabled)
        self._background: set[asyncio.Task[None]] = set()

    @staticmethod
    def _default_connection(
        spec: MCPSpec,
        *,
        env: dict[str, str],
        headers: dict[str, str],
        on_exit: Callable[[], None],
        on_tools_changed: Callable[[], None],
    ) -> Any:
        if spec.transport == "stdio":
            return StdioMCPConnection(
                list(spec.command),
                env=env,
                on_exit=on_exit,
                on_tools_changed=on_tools_changed,
            )
        return HTTPMCPConnection(str(spec.url), headers=headers)

    async def start(self, name: str) -> None:
        record = self._record(name)
        if not record.enabled:
            raise MCPError("SERVER_DISABLED", "the MCP server is disabled")
        if record.state in {
            MCPServerState.RUNNING,
            MCPServerState.STARTING,
            MCPServerState.RESTARTING,
        }:
            return
        record.restarts = 0
        await self._start_record(record)

    async def start_all(self) -> None:
        pending = [
            asyncio.create_task(self._start_enabled_record(record))
            for record in self._records.values()
            if record.enabled
            and record.state in {MCPServerState.STOPPED, MCPServerState.FAILED}
        ]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def stop(self, name: str) -> None:
        record = self._record(name)
        await self._shutdown_record(record, MCPServerState.STOPPED)

    async def stop_all(self) -> None:
        for record in self._records.values():
            await self._shutdown_record(record, MCPServerState.STOPPED)

    async def disable(self, name: str) -> None:
        record = self._record(name)
        record.enabled = False
        await self._shutdown_record(record, MCPServerState.DISABLED)

    async def enable(self, name: str) -> None:
        record = self._record(name)
        record.enabled = True
        record.restarts = 0
        await self._start_record(record)

    def server_names(self) -> tuple[str, ...]:
        """Configured server names, stable order, for display."""
        return tuple(sorted(self._records))

    def state_of(self, name: str) -> str:
        return self._record(name).state.value

    def last_error(self, name: str) -> str | None:
        return self._record(name).last_error

    def redactor_for(self, capability: str) -> SecretRedactor:
        """Redactor over one server's resolved credentials; safe before start."""
        try:
            server, _ = split_capability(capability)
            record = self._records[server]
        except (MCPError, KeyError):
            return SecretRedactor()
        return SecretRedactor(
            [*record.resolved_env.values(), *record.resolved_headers.values()]
        )

    def capabilities(self) -> tuple[str, ...]:
        projected: list[str] = []
        for name in sorted(self._records):
            record = self._records[name]
            if record.state is not MCPServerState.RUNNING:
                continue
            projected.extend(
                record.spec.capability_prefix + tool.name for tool in record.tools
            )
        return tuple(projected)

    def tools(self, name: str) -> tuple[MCPTool, ...]:
        """Return the last authorized schema snapshot for a running server."""
        return self._record(name).tools

    def ensure_callable(self, capability: str) -> tuple[_ServerRecord, str]:
        """Validate ``capability`` and return its record and tool name.

        Checked before the consent round trip so the user is never asked to
        approve a tool that does not exist. The network policy is re-applied
        for HTTP servers on every call, closing the DNS-rebinding window
        between start and call.
        """
        server_name, tool_name = split_capability(capability)
        record = self._record(server_name)
        if record.state is not MCPServerState.RUNNING or record.connection is None:
            raise MCPError("SERVER_UNAVAILABLE", "the MCP server is not running")
        if record.spec.transport == "http":
            self.network_policy.validate_url(str(record.spec.url))
        if tool_name not in record.tool_names():
            raise MCPError("TOOL_NOT_FOUND", "the MCP tool is not available")
        return record, tool_name

    async def call_tool(
        self,
        capability: str,
        arguments: Mapping[str, Any],
        *,
        timeout: float | None = None,
    ) -> MCPToolCallResult:
        record, tool_name = self.ensure_callable(capability)
        effective_timeout = timeout or record.spec.tool_timeout_seconds
        try:
            return _redact_result(
                await call_tool(
                    record.connection,
                    tool_name,
                    dict(arguments),
                    timeout=effective_timeout,
                ),
                self.redactor_for(capability),
            )
        except MCPError as exc:
            if exc.code == "SERVER_UNAVAILABLE" and record.spec.transport == "http":
                # A dead HTTP endpoint goes through the same restart budget
                # as a crashed stdio process instead of staying RUNNING.
                self._handle_exit(record.spec.name)
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            raise MCPError(
                "SERVER_UNAVAILABLE", "the MCP tool call failed unexpectedly"
            ) from None

    async def refresh_tools(self, name: str) -> None:
        record = self._record(name)
        if record.state is not MCPServerState.RUNNING or record.connection is None:
            return
        try:
            tools = tuple(
                await list_tools(
                    record.connection, timeout=record.spec.start_timeout_seconds
                )
            )
        except MCPError:
            # Schema refresh is best-effort; the last known tool list stays
            # projected so a failing refresh cannot destabilize the runtime.
            return
        record.tools = tools

    async def refresh_all(self) -> None:
        for name in self._records:
            await self.refresh_tools(name)

    async def _start_enabled_record(self, record: _ServerRecord) -> None:
        try:
            await self._start_record(record)
        except MCPError:
            return

    async def _start_record(self, record: _ServerRecord) -> None:
        record.stopping = False
        record.state = MCPServerState.STARTING
        connection: Any = None
        try:
            env = self._resolve_placeholders(record.spec.env)
            headers = self._resolve_placeholders(record.spec.headers)
            record.resolved_env = env
            record.resolved_headers = headers
            if record.spec.transport == "http":
                self.network_policy.validate_url(str(record.spec.url))
            connection = self._connection_factory(
                record.spec,
                env=env,
                headers=headers,
                on_exit=lambda server_name=record.spec.name: self._handle_exit(
                    server_name
                ),
                on_tools_changed=lambda server_name=record.spec.name: (
                    self._schedule_refresh(server_name)
                ),
            )
            await connection.start()
            await initialize(connection, timeout=record.spec.start_timeout_seconds)
            record.tools = tuple(
                await list_tools(connection, timeout=record.spec.start_timeout_seconds)
            )
        except MCPError as exc:
            record.state = MCPServerState.FAILED
            record.last_error = exc.code
            if connection is not None:
                try:
                    await connection.close()
                except Exception:
                    pass
            raise
        record.connection = connection
        record.state = MCPServerState.RUNNING

    async def _shutdown_record(
        self, record: _ServerRecord, final_state: MCPServerState
    ) -> None:
        record.stopping = True
        if record.restart_task is not None:
            record.restart_task.cancel()
            record.restart_task = None
        connection, record.connection = record.connection, None
        record.tools = ()
        record.state = final_state
        if connection is not None:
            try:
                await connection.close()
            except Exception:
                pass

    def _handle_exit(self, name: str) -> None:
        record = self._records.get(name)
        if record is None or record.state in {
            MCPServerState.DISABLED,
            MCPServerState.STOPPED,
        }:
            return
        record.connection = None
        if record.stopping:
            record.state = MCPServerState.STOPPED
            return
        if record.restarts < record.spec.max_restarts:
            record.restarts += 1
            record.state = MCPServerState.RESTARTING
            delay = record.spec.restart_backoff_seconds * (2 ** (record.restarts - 1))
            record.restart_task = asyncio.create_task(
                self._restart_after(record, delay)
            )
        else:
            record.state = MCPServerState.FAILED
            record.last_error = record.last_error or "SERVER_CRASHED"

    async def _restart_after(self, record: _ServerRecord, delay: float) -> None:
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            await self._start_record(record)
        except MCPError:
            return

    def _schedule_refresh(self, name: str) -> None:
        task = asyncio.create_task(self._refresh_and_notify(name))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _refresh_and_notify(self, name: str) -> None:
        await self.refresh_tools(name)
        if self.on_change is not None:
            await self.on_change()

    def _resolve_placeholders(self, values: Mapping[str, str]) -> dict[str, str]:
        resolved: dict[str, str] = {}
        for key, value in values.items():
            if isinstance(value, str) and value.startswith(SECRET_REFERENCE_PREFIX):
                secret_name = value[len(SECRET_REFERENCE_PREFIX) :]
                secret = (
                    self.secret_resolver(secret_name) if self.secret_resolver else None
                )
                if not isinstance(secret, str) or not secret:
                    raise MCPError(
                        "SECRET_UNAVAILABLE",
                        f"secret reference is unavailable: {SECRET_REFERENCE_PREFIX}{secret_name}",
                    )
                resolved[key] = secret
            else:
                resolved[key] = value
        return resolved

    def _record(self, name: str) -> _ServerRecord:
        record = self._records.get(name)
        if record is None:
            raise MCPError("SERVER_UNKNOWN", "the MCP server is not configured")
        return record


def _redact_value(value: Any, redactor: SecretRedactor) -> Any:
    if isinstance(value, str):
        return redactor.redact(value)
    if isinstance(value, dict):
        return {key: _redact_value(item, redactor) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_redact_value(item, redactor) for item in value)
    return value


def _redact_result(
    result: MCPToolCallResult, redactor: SecretRedactor
) -> MCPToolCallResult:
    """Scrub resolved credential values out of tool output before it travels."""
    if redactor.longest == 0:
        return result
    content = tuple(_redact_value(entry, redactor) for entry in result.content)
    structured = (
        _redact_value(result.structured_content, redactor)
        if result.structured_content is not None
        else None
    )
    return MCPToolCallResult(content, result.is_error, structured)


@dataclass(frozen=True)
class MCPToolCallResult:
    content: tuple[dict[str, Any], ...]
    is_error: bool
    structured_content: dict[str, Any] | None = None


def _safe_environment(extra: Mapping[str, str]) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME"}
    }
    for name, value in extra.items():
        if not name or "=" in name or "\x00" in name or "\x00" in value:
            raise MCPError(
                "INVALID_ENVIRONMENT", "environment references must be valid"
            )
        env[name] = value
    return env


class StdioMCPConnection:
    """One MCP server child process speaking newline-delimited JSON-RPC."""

    def __init__(
        self,
        command: list[str],
        *,
        env: Mapping[str, str] | None = None,
        on_exit: Any = None,
        on_tools_changed: Any = None,
    ) -> None:
        if not command or not all(isinstance(part, str) for part in command):
            raise MCPError("INVALID_COMMAND", "stdio command must be a list of strings")
        self.command = command
        self.env = _safe_environment(dict(env or {}))
        self.on_exit = on_exit
        self.on_tools_changed = on_tools_changed
        self.process: asyncio.subprocess.Process | None = None
        self.last_error: str | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._next_id = 0
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._write_lock: asyncio.Lock | None = None
        self._closing = False

    async def start(self) -> None:
        if self._write_lock is None:
            # asyncio.Lock binds its loop at construction on Python 3.9 and
            # older; connections are built outside any running loop, so the
            # lock belongs to start()'s running loop.
            self._write_lock = asyncio.Lock()
        try:
            self.process = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self.env,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
                if os.name == "nt"
                else 0,
            )
        except OSError as exc:
            # The OS error text embeds the absolute command path; only the
            # stable code and a generic message may cross the boundary.
            raise MCPError(
                "SERVER_START_FAILED", "the MCP server command failed to start"
            ) from exc
        assert (
            self.process is not None
            and self.process.stdout
            and self.process.stderr
            and self.process.stdin
        )
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        self._reader_task = asyncio.create_task(self._read_messages())

    async def request(
        self, method: str, params: Mapping[str, Any], *, timeout: float
    ) -> Any:
        if self.process is None or self.process.returncode is not None:
            raise MCPError("SERVER_UNAVAILABLE", "the MCP server is not running")
        self._next_id += 1
        message = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": dict(params),
        }
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[message["id"]] = future
        try:
            async with self._write_lock:
                assert self.process.stdin is not None
                self.process.stdin.write(
                    (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
                )
                await self.process.stdin.drain()
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            # asyncio.wait_for raises asyncio.TimeoutError, only an alias of
            # the builtin from Python 3.11 on.
            self._pending.pop(message["id"], None)
            raise MCPError("MCP_TIMEOUT", f"{method} timed out") from None
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            self._pending.pop(message["id"], None)
            raise MCPError("SERVER_UNAVAILABLE", "the MCP server pipe failed") from exc

    async def notify(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> None:
        if self.process is None or self.process.stdin is None:
            return
        message = {"jsonrpc": "2.0", "method": method, "params": dict(params or {})}
        try:
            async with self._write_lock:
                self.process.stdin.write(
                    (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
                )
                await self.process.stdin.drain()
        except (OSError, ValueError):
            pass

    async def close(self) -> None:
        self._closing = True
        process, self.process = self.process, None
        if process is None:
            if self._reader_task is not None:
                self._reader_task.cancel()
                await asyncio.gather(self._reader_task, return_exceptions=True)
            return
        try:
            if process.stdin is not None and not process.stdin.is_closing():
                process.stdin.close()
        except OSError:
            pass
        for _ in range(50):
            if process.returncode is not None:
                break
            await asyncio.sleep(0.02)
        if process.returncode is None:
            # The child was spawned with start_new_session, so a bare kill()
            # would orphan the grandchildren an npx-style wrapper spawned;
            # _terminate() signals the whole process group instead (05-M5).
            _terminate(process)
        await process.wait()
        if self._reader_task is not None:
            self._reader_task.cancel()
            await asyncio.gather(self._reader_task, return_exceptions=True)
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            await asyncio.gather(self._stderr_task, return_exceptions=True)
        self._fail_pending(MCPError("SERVER_STOPPED", "the MCP server was stopped"))

    def _fail_pending(self, error: MCPError) -> None:
        pending, self._pending = self._pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(error)

    async def _read_messages(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                await self._dispatch(line)
        finally:
            if not self._closing:
                self.last_error = (
                    self.last_error or "the MCP server exited unexpectedly"
                )
                self._fail_pending(MCPError("SERVER_CRASHED", self.last_error))
                if self.on_exit is not None:
                    self.on_exit()

    async def _dispatch(self, line: bytes) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(message, dict):
            return
        if "id" in message and ("result" in message or "error" in message):
            future = self._pending.pop(_coerce_id(message["id"]), None)
            if future is None or future.done():
                return
            if "error" in message:
                error = message["error"]
                future.set_exception(
                    MCPError(
                        "MCP_REQUEST_FAILED",
                        str(error.get("message", "request failed")),
                    )
                )
            else:
                future.set_result(message.get("result"))
            return
        method = message.get("method")
        if (
            method == "notifications/tools/list_changed"
            and self.on_tools_changed is not None
        ):
            self.on_tools_changed()

    async def _drain_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        collected: list[bytes] = []
        total = 0
        while True:
            line = await self.process.stderr.readline()
            if not line:
                break
            collected.append(line)
            total += len(line)
            if total > 8 * 1024:
                collected = collected[-4:]
                total = sum(len(part) for part in collected)
        if collected:
            self.last_error = b"".join(collected).decode("utf-8", errors="replace")[
                -4096:
            ]


def _coerce_id(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if os.name != "nt" and process.pid is not None:
        try:
            os.killpg(process.pid, 9)
            return
        except ProcessLookupError:
            return
    if os.name == "nt" and process.pid is not None:
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
        return
    process.kill()


class HTTPMCPConnection:
    """Minimal MCP client for localhost HTTP servers (JSON or SSE responses)."""

    def __init__(self, url: str, *, headers: Mapping[str, str] | None = None) -> None:
        parsed = _parse_http_url(url)
        if parsed is None:
            raise MCPError("INVALID_URL", "the MCP server URL is not a valid HTTP URL")
        self.scheme, self.host, self.port, self.path = parsed
        self.headers = dict(headers or {})
        self.last_error: str | None = None
        self._next_id = 0
        self._session_id: str | None = None

    async def start(self) -> None:
        return None

    async def request(
        self, method: str, params: Mapping[str, Any], *, timeout: float
    ) -> Any:
        self._next_id += 1
        body = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": dict(params),
        }
        try:
            status, content_type, payload, session_id = await asyncio.wait_for(
                self._post(body), timeout
            )
            if session_id:
                self._session_id = session_id
        except asyncio.TimeoutError:
            raise MCPError("MCP_TIMEOUT", f"{method} timed out") from None
        except (OSError, ValueError) as exc:
            raise MCPError(
                "SERVER_UNAVAILABLE", "the MCP HTTP endpoint failed"
            ) from exc
        if status in {400, 401, 403, 404, 405, 409, 410} and self._session_id:
            # A Streamable HTTP server uses these responses to indicate that
            # the negotiated session is no longer valid. Clear it so a later
            # explicit restart can negotiate a fresh session; never replay
            # this request because tools/call may have side effects.
            self._session_id = None
            raise MCPError("MCP_SESSION_EXPIRED", "the MCP session is no longer valid")
        if status != 200:
            raise MCPError(
                "SERVER_UNAVAILABLE", f"the MCP HTTP endpoint returned {status}"
            )
        if "text/event-stream" in content_type:
            payload = _sse_payload(payload, self._next_id)
            if payload is None:
                raise MCPError("SERVER_UNAVAILABLE", "the SSE response never completed")
        try:
            message = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise MCPError(
                "SERVER_UNAVAILABLE", "the MCP response is not JSON"
            ) from exc
        if "error" in message:
            raise MCPError(
                "MCP_REQUEST_FAILED",
                str(message["error"].get("message", "request failed")),
            )
        result = message.get("result")
        if method == "initialize":
            version = (
                result.get("protocolVersion") if isinstance(result, dict) else None
            )
            if version not in SUPPORTED_MCP_PROTOCOL_VERSIONS:
                self._session_id = None
                raise MCPError(
                    "MCP_PROTOCOL_UNSUPPORTED",
                    "the MCP server selected an unsupported protocol version",
                )
        return result

    async def notify(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> None:
        body = {"jsonrpc": "2.0", "method": method, "params": dict(params or {})}
        try:
            _, _, _, session_id = await asyncio.wait_for(self._post(body), timeout=10)
            if session_id:
                self._session_id = session_id
        except (asyncio.TimeoutError, MCPError, OSError):
            pass

    async def close(self) -> None:
        return None

    async def _post(
        self, body: Mapping[str, Any]
    ) -> tuple[int, str, bytes, str | None]:
        writer = None
        try:
            reader, writer = await asyncio.open_connection(self.host, self.port)
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers = {
                "Host": f"{self.host}:{self.port}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Content-Length": str(len(payload)),
                "Connection": "close",
                **self.headers,
            }
            if self._session_id:
                headers["Mcp-Session-Id"] = self._session_id
            head = (
                f"POST {self.path} HTTP/1.1\r\n"
                + "".join(f"{name}: {value}\r\n" for name, value in headers.items())
                + "\r\n"
            )
            writer.write(head.encode("latin-1") + payload)
            await writer.drain()
            status_line = await reader.readline()
            parts = status_line.decode("latin-1").split(" ", 2)
            status = int(parts[1]) if len(parts) > 1 else 0
            content_type = ""
            content_length = -1
            chunked = False
            session_id: str | None = None
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                name, _, value = line.decode("latin-1").partition(":")
                name = name.strip().lower()
                value = value.strip()
                if name == "content-type":
                    content_type = value.lower()
                elif name == "content-length":
                    content_length = int(value)
                elif name == "transfer-encoding" and "chunked" in value.lower():
                    chunked = True
                elif name == "mcp-session-id":
                    session_id = value
            if chunked:
                response = await _read_chunked(reader)
            elif content_length >= 0:
                response = await reader.readexactly(content_length)
            else:
                response = await reader.read()
            return status, content_type, response, session_id
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except (OSError, ConnectionError):
                    pass


def _parse_http_url(url: str) -> tuple[str, str, int, str] | None:
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    # The HTTP client is plaintext by design: localhost MCP endpoints are
    # plain HTTP, so https URLs would silently downgrade if accepted here.
    if parts.scheme != "http" or not parts.hostname:
        return None
    # Only http can reach this point, so the default port is always 80; the
    # former 443 https arm here was dead code (05-L7).
    return (
        parts.scheme,
        parts.hostname,
        parts.port if parts.port is not None else 80,
        parts.path or "/",
    )


def _sse_payload(raw: bytes, request_id: int) -> bytes | None:
    for line in raw.decode("utf-8", errors="replace").splitlines():
        if not line.startswith("data:"):
            continue
        candidate = line[len("data:") :].strip()
        try:
            message = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if message.get("id") == request_id:
            return candidate.encode("utf-8")
    return None


async def _read_chunked(reader: asyncio.StreamReader) -> bytes:
    chunks: list[bytes] = []
    while True:
        size_line = await reader.readline()
        try:
            size = int(size_line.strip() or b"0", 16)
        except ValueError as exc:
            raise ValueError("invalid chunked encoding") from exc
        if size == 0:
            await reader.readline()
            break
        chunks.append(await reader.readexactly(size))
        await reader.readline()
    return b"".join(chunks)


async def initialize(connection: Any, *, timeout: float) -> dict[str, Any]:
    result = await connection.request(
        "initialize",
        {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": CLIENT_INFO,
        },
        timeout=timeout,
    )
    await connection.notify("notifications/initialized")
    return dict(result or {})


async def list_tools(connection: Any, *, timeout: float) -> list[MCPTool]:
    tools: list[MCPTool] = []
    cursor: str | None = None
    for _ in range(100):
        params: dict[str, Any] = {} if cursor is None else {"cursor": cursor}
        result = await connection.request("tools/list", params, timeout=timeout) or {}
        for entry in result.get("tools", ()):
            tools.append(
                MCPTool(
                    name=str(entry.get("name", "")),
                    description=str(entry.get("description", "")),
                    input_schema=entry.get("inputSchema"),
                )
            )
        cursor = result.get("nextCursor")
        if not cursor:
            break
    return [tool for tool in tools if tool.name]


async def call_tool(
    connection: Any, name: str, arguments: Mapping[str, Any], *, timeout: float
) -> MCPToolCallResult:
    result = (
        await connection.request(
            "tools/call",
            {"name": name, "arguments": dict(arguments)},
            timeout=timeout,
        )
        or {}
    )
    content = tuple(
        entry for entry in result.get("content", ()) if isinstance(entry, dict)
    )
    structured = result.get("structuredContent")
    return MCPToolCallResult(
        content=content,
        is_error=bool(result.get("isError", False)),
        structured_content=dict(structured) if isinstance(structured, dict) else None,
    )
