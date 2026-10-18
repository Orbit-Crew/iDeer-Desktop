from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
import time
from pathlib import Path

import pytest
from core.consent import ConsentExchange, ConsentStore
from core.mcp import (
    HTTPMCPConnection,
    LocalMCPService,
    MCPError,
    MCPNetworkPolicy,
    MCPSpec,
    MCPSupervisor,
    MCPToolCallResult,
    StdioMCPConnection,
    call_tool,
    initialize,
    list_tools,
    load_mcp_specs,
    parse_mcp_config,
)
from core.policy import LocalPolicy, PolicyDecision
from core.protocol import MessageType, public_key_text, sign_envelope, verify_envelope
from core.transport import LocalRuntimeClient
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

FIXTURE_SERVER = Path(__file__).parent / "fixtures" / "filesystem_mcp_server.py"


def test_stdio_client_initializes_discovers_and_calls_tools(tmp_path: Path) -> None:
    (tmp_path / "hello.txt").write_text("from the device", encoding="utf-8")
    connection = StdioMCPConnection(
        [sys.executable, str(FIXTURE_SERVER)],
        env={"MCP_ROOT": str(tmp_path)},
    )

    async def scenario() -> None:
        try:
            await connection.start()
            info = await initialize(connection, timeout=10)
            assert info["serverInfo"]["name"] == "fixture-filesystem"
            tools = await list_tools(connection, timeout=10)
            assert [tool.name for tool in tools] == ["read_file", "write_file"]
            result = await call_tool(
                connection, "read_file", {"path": "hello.txt"}, timeout=10
            )
            assert result.is_error is False
            assert result.content[0]["text"] == "from the device"
        finally:
            print('PRE-CLOSE', flush=True)
            await connection.close()
            print('POST-CLOSE', flush=True)

    asyncio.run(scenario())


def test_stdio_call_timeout_is_contained_and_connection_stays_usable(
    tmp_path: Path,
) -> None:
    slow_server = textwrap.dedent(
        """
        import json, sys, time
        for line in sys.stdin:
            message = json.loads(line)
            if message.get("method") == "tools/call":
                time.sleep(0.6)
                response = {"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": "late"}], "isError": False}}
            elif "id" in message:
                response = {"jsonrpc": "2.0", "id": message["id"], "result": {}}
            else:
                continue
            sys.stdout.write(json.dumps(response) + "\\n")
            sys.stdout.flush()
        """
    )
    script = tmp_path / "slow_mcp_server.py"
    script.write_text(slow_server, encoding="utf-8")
    connection = StdioMCPConnection([sys.executable, str(script)])

    async def scenario() -> None:
        try:
            await connection.start()
            with pytest.raises(MCPError) as exc_info:
                await call_tool(connection, "slow", {}, timeout=0.2)
            assert exc_info.value.code == "MCP_TIMEOUT"
            result = await call_tool(connection, "read_file", {}, timeout=10)
            assert result.is_error is False
            assert result.content[0]["text"] == "late"
        finally:
            print('PRE-CLOSE', flush=True)
            await connection.close()
            print('POST-CLOSE', flush=True)

    asyncio.run(scenario())


def test_stdio_tool_error_and_unknown_method_surface_as_structured_failures(
    tmp_path: Path,
) -> None:
    (tmp_path / "outside.txt").write_text("x", encoding="utf-8")
    connection = StdioMCPConnection(
        [sys.executable, str(FIXTURE_SERVER)],
        env={"MCP_ROOT": str(tmp_path)},
    )

    async def scenario() -> None:
        try:
            await connection.start()
            await initialize(connection, timeout=10)
            escaped = await call_tool(
                connection, "read_file", {"path": "../outside.txt"}, timeout=10
            )
            assert escaped.is_error is True
            with pytest.raises(MCPError) as exc_info:
                await connection.request("no/such/method", {}, timeout=10)
            assert exc_info.value.code == "MCP_REQUEST_FAILED"
        finally:
            print('PRE-CLOSE', flush=True)
            await connection.close()
            print('POST-CLOSE', flush=True)

    asyncio.run(scenario())


def test_http_client_completes_initialize_list_and_call(tmp_path: Path) -> None:
    (tmp_path / "hello.txt").write_text("over localhost", encoding="utf-8")

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            while True:
                request = await _read_http_request(reader)
                if request is None:
                    break
                message = json.loads(request["body"])
                response_body = _fixture_response(message, tmp_path)
                payload = json.dumps(response_body).encode("utf-8")
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/json\r\n"
                    + f"Content-Length: {len(payload)}\r\n".encode()
                    + b"Connection: keep-alive\r\n\r\n"
                    + payload
                )
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    async def scenario(port_holder: list[int]) -> None:
        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port_holder.append(server.sockets[0].getsockname()[1])
        try:
            connection = HTTPMCPConnection(f"http://127.0.0.1:{port_holder[0]}/mcp")
            await connection.start()
            tools = await list_tools(connection, timeout=10)
            assert [tool.name for tool in tools] == ["read_file", "write_file"]
            result = await call_tool(
                connection, "read_file", {"path": "hello.txt"}, timeout=10
            )
            assert result.content[0]["text"] == "over localhost"
            print('PRE-CLOSE', flush=True)
            await connection.close()
            print('POST-CLOSE', flush=True)
        finally:
            server.close()
            await server.wait_closed()

    ports: list[int] = []
    asyncio.run(scenario(ports))


def test_http_client_replays_mcp_session_header() -> None:
    async def scenario() -> None:
        connection = HTTPMCPConnection("http://127.0.0.1:80/mcp")
        seen: list[dict[str, str]] = []

        async def post(body):
            seen.append({"session": connection._session_id or ""})
            if len(seen) == 1:
                return (
                    200,
                    "application/json",
                    b'{"result": {"protocolVersion": "2024-11-05"}}',
                    "session-1",
                )
            return 200, "application/json", b'{"result": {}}', None

        connection._post = post
        await connection.request("initialize", {}, timeout=1)
        await connection.request("tools/list", {}, timeout=1)
        assert seen == [{"session": ""}, {"session": "session-1"}]

    asyncio.run(scenario())


def test_http_client_rejects_expired_session_without_replaying_call() -> None:
    async def scenario() -> None:
        connection = HTTPMCPConnection("http://127.0.0.1:80/mcp")
        connection._session_id = "expired"
        seen: list[str] = []

        async def post(body):
            seen.append(connection._session_id or "")
            return 404, "application/json", b"{}", None

        connection._post = post
        with pytest.raises(MCPError) as exc_info:
            await connection.request("tools/call", {"name": "write_file"}, timeout=1)
        assert exc_info.value.code == "MCP_SESSION_EXPIRED"
        assert seen == ["expired"]
        assert connection._session_id is None

    asyncio.run(scenario())


def test_http_client_rejects_unsupported_initialize_version() -> None:
    async def scenario() -> None:
        connection = HTTPMCPConnection("http://127.0.0.1:80/mcp")

        async def post(body):
            return (
                200,
                "application/json",
                b'{"result": {"protocolVersion": "future"}}',
                "s1",
            )

        connection._post = post
        with pytest.raises(MCPError) as exc_info:
            await connection.request("initialize", {}, timeout=1)
        assert exc_info.value.code == "MCP_PROTOCOL_UNSUPPORTED"
        assert connection._session_id is None

    asyncio.run(scenario())


def _fixture_response(message: dict, root: Path) -> dict:
    sys.path.insert(0, str(FIXTURE_SERVER.parent.parent))
    try:
        from fixtures.filesystem_mcp_server import TOOLS, dispatch
    finally:
        sys.path.pop(0)
    previous = os.environ.get("MCP_ROOT")
    os.environ["MCP_ROOT"] = str(root)
    try:
        if message.get("method") == "tools/list":
            return {"jsonrpc": "2.0", "id": message["id"], "result": {"tools": TOOLS}}
        if "id" not in message:
            return {}
        response = dispatch(message)
        assert response is not None
        return response
    finally:
        if previous is None:
            os.environ.pop("MCP_ROOT", None)
        else:
            os.environ["MCP_ROOT"] = previous


async def _read_http_request(reader: asyncio.StreamReader) -> dict | None:
    request_line = await reader.readline()
    if not request_line:
        return None
    headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        name, _, value = line.decode("latin-1").partition(":")
        headers[name.strip().lower()] = value.strip()
    body = b""
    length = int(headers.get("content-length", "0"))
    if length:
        body = await reader.readexactly(length)
    return {"headers": headers, "body": body.decode("utf-8")}


def test_spec_requires_consistent_transport_and_safe_names() -> None:
    spec = MCPSpec(name="fs", transport="stdio", command=("echo",))
    assert spec.enabled is True
    with pytest.raises(MCPError):
        MCPSpec(name="bad name", transport="stdio", command=("echo",))
    with pytest.raises(MCPError):
        MCPSpec(name="fs", transport="stdio")
    with pytest.raises(MCPError):
        MCPSpec(name="fs", transport="http")
    with pytest.raises(MCPError):
        MCPSpec(name="fs", transport="rpc", url="http://127.0.0.1")
    with pytest.raises(MCPError):
        MCPSpec(name="fs", transport="stdio", command=("echo",), max_restarts=-1)


def test_parse_mcp_config_reads_server_list_and_rejects_duplicates() -> None:
    specs = parse_mcp_config(
        {
            "servers": [
                {
                    "name": "fs",
                    "transport": "stdio",
                    "command": ["mcp-server-fs"],
                    "env": {"MCP_ROOT": "local:fs_root"},
                },
                {
                    "name": "intranet",
                    "transport": "http",
                    "url": "http://10.0.0.5:8080/mcp",
                    "enabled": False,
                },
            ]
        }
    )
    assert [spec.name for spec in specs] == ["fs", "intranet"]
    assert specs[0].env["MCP_ROOT"] == "local:fs_root"
    assert specs[1].enabled is False
    with pytest.raises(MCPError):
        parse_mcp_config(
            {
                "servers": [
                    {"name": "fs", "transport": "stdio", "command": ["a"]},
                    {"name": "fs", "transport": "stdio", "command": ["b"]},
                ]
            }
        )
    assert parse_mcp_config({}) == []


def test_network_policy_allows_loopback_and_denies_public_by_default() -> None:
    policy = MCPNetworkPolicy()
    policy.validate_url("http://127.0.0.1:8123/mcp")
    policy.validate_url("http://localhost:8123/mcp")
    policy.validate_url("http://[::1]:8123/mcp")
    with pytest.raises(MCPError) as denied:
        policy.validate_url("http://example.com/mcp")
    assert denied.value.code == "NETWORK_DENIED"
    with pytest.raises(MCPError):
        policy.validate_url("http://192.168.1.10/mcp")


def test_network_policy_allows_approved_intranet_and_dns_resolution_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = MCPNetworkPolicy(
        approved_hosts=frozenset({"10.0.0.0/8", "files.intranet"})
    )
    policy.validate_url("http://10.1.2.3:9000/mcp")
    policy.validate_url("http://files.intranet:9000/mcp")

    def fake_getaddrinfo(host, port, *args, **kwargs):
        resolved = "93.184.216.34" if host == "rebind.internal" else "10.1.2.3"
        return [(2, 1, 6, "", (resolved, port))]

    monkeypatch.setattr("socket.getaddrinfo", fake_getaddrinfo)
    policy.validate_url("http://safe.internal/mcp")
    with pytest.raises(MCPError) as denied:
        policy.validate_url("http://rebind.internal/mcp")
    assert denied.value.code == "NETWORK_DENIED"
    assert (
        MCPNetworkPolicy(allow_public_internet=True).validate_url(
            "http://example.com/mcp"
        )
        is None
    )


class FakeMCPConnection:
    """Scriptable MCP connection: answers discovery, records calls, can crash."""

    def __init__(
        self,
        *,
        tools=("read_file", "write_file"),
        fail_starts=0,
        calls=None,
        hang_tools=(),
    ):
        self.tools = tuple(tools)
        self.fail_starts = fail_starts
        self.calls = calls if calls is not None else []
        self.hang_tools = set(hang_tools)
        self.started = False
        self.closed = False
        self.on_exit = None
        self.on_tools_changed = None
        self.pending: dict[int, asyncio.Future] = {}
        self.tool_results: dict[str, MCPToolCallResult] = {}
        self.refresh_fails = False
        self.fail_unavailable = False
        self._next_id = 0

    async def start(self) -> None:
        if self.fail_starts > 0:
            self.fail_starts -= 1
            raise MCPError("SERVER_START_FAILED", "simulated start failure")
        self.started = True

    async def request(self, method: str, params, *, timeout: float):
        self._next_id += 1
        request_id = self._next_id
        if method == "initialize":
            return {"serverInfo": {"name": "fake"}}
        if method == "tools/list":
            if self.refresh_fails:
                raise MCPError("SERVER_UNAVAILABLE", "discovery failed")
            return {"tools": [{"name": name} for name in self.tools]}
        if method == "tools/call":
            self.calls.append((params.get("name"), params.get("arguments")))
            if self.fail_unavailable:
                raise MCPError("SERVER_UNAVAILABLE", "the MCP HTTP endpoint failed")
            if params.get("name") in self.hang_tools:
                future: asyncio.Future = asyncio.get_running_loop().create_future()
                self.pending[request_id] = future
                return await future
            return self.tool_results.get(params.get("name")) or {
                "content": [{"type": "text", "text": "ok"}],
                "isError": False,
            }
        raise MCPError("MCP_REQUEST_FAILED", f"unexpected method: {method}")

    async def notify(self, method, params=None) -> None:
        return None

    async def close(self) -> None:
        self.closed = True

    def crash(self) -> None:
        pending, self.pending = self.pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(MCPError("SERVER_CRASHED", "server exited"))
        if self.on_exit is not None:
            self.on_exit()


def make_supervisor(
    specs, *, factory=None, fake_kwargs=None, **kwargs
) -> tuple[MCPSupervisor, dict[str, list[FakeMCPConnection]]]:
    connections: dict[str, list[FakeMCPConnection]] = {}
    fake_kwargs = fake_kwargs or {}
    if factory is None:

        def factory(spec, *, env, headers, on_exit, on_tools_changed):
            connection = FakeMCPConnection(**fake_kwargs.get(spec.name, {}))
            connection.on_exit = on_exit
            connection.on_tools_changed = on_tools_changed
            connections.setdefault(spec.name, []).append(connection)
            return connection

    return MCPSupervisor(specs, connection_factory=factory, **kwargs), connections


async def wait_for_state(
    supervisor: MCPSupervisor, name: str, state: str, timeout: float = 2.0
) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while supervisor.state_of(name) != state:
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(
                f"{name} never reached {state}; last={supervisor.state_of(name)}"
            )
        await asyncio.sleep(0.01)


def test_supervisor_discovers_tools_and_projects_capabilities() -> None:
    specs = [
        MCPSpec(name="fs", transport="stdio", command=("fs",)),
        MCPSpec(name="off", transport="stdio", command=("off",), enabled=False),
    ]
    supervisor, _ = make_supervisor(specs)

    async def scenario() -> None:
        await supervisor.start_all()

    asyncio.run(scenario())
    assert supervisor.state_of("fs") == "running"
    assert supervisor.capabilities() == (
        "local.mcp.fs.read_file",
        "local.mcp.fs.write_file",
    )
    assert not any(
        name.startswith("local.mcp.off.") for name in supervisor.capabilities()
    )


def test_disabled_server_refuses_start_and_stays_invisible() -> None:
    supervisor, connections = make_supervisor(
        [MCPSpec(name="off", transport="stdio", command=("x",), enabled=False)]
    )

    async def scenario() -> None:
        with pytest.raises(MCPError) as denied:
            await supervisor.start("off")
        assert denied.value.code == "SERVER_DISABLED"
        await supervisor.start_all()

    asyncio.run(scenario())
    assert supervisor.capabilities() == ()
    assert connections == {}


def test_crash_restarts_with_backoff_then_marks_failed() -> None:
    supervisor, connections = make_supervisor(
        [
            MCPSpec(
                name="fs",
                transport="stdio",
                command=("x",),
                max_restarts=1,
                restart_backoff_seconds=0,
            )
        ]
    )

    async def scenario() -> None:
        await supervisor.start_all()
        connections["fs"][0].crash()
        await wait_for_state(supervisor, "fs", "running")
        assert len(connections["fs"]) == 2
        connections["fs"][1].crash()
        await wait_for_state(supervisor, "fs", "failed")

    asyncio.run(scenario())
    assert supervisor.capabilities() == ()
    assert supervisor.last_error("fs") is not None


def test_manual_stop_does_not_schedule_a_restart() -> None:
    supervisor, connections = make_supervisor(
        [
            MCPSpec(
                name="fs",
                transport="stdio",
                command=("x",),
                max_restarts=3,
                restart_backoff_seconds=0,
            )
        ]
    )

    async def scenario() -> None:
        await supervisor.start_all()
        await supervisor.stop("fs")
        await asyncio.sleep(0.05)

    asyncio.run(scenario())
    assert supervisor.state_of("fs") == "stopped"
    assert len(connections["fs"]) == 1
    assert connections["fs"][0].closed is True
    assert supervisor.capabilities() == ()


def test_crash_is_isolated_from_other_servers() -> None:
    specs = [
        MCPSpec(name="a", transport="stdio", command=("a",), max_restarts=0),
        MCPSpec(name="b", transport="stdio", command=("b",), max_restarts=0),
    ]
    supervisor, connections = make_supervisor(specs)

    async def scenario() -> None:
        await supervisor.start_all()
        connections["a"][0].crash()
        await wait_for_state(supervisor, "a", "failed")
        result = await supervisor.call_tool("local.mcp.b.read_file", {})
        assert result.is_error is False

    asyncio.run(scenario())
    assert supervisor.state_of("b") == "running"
    assert supervisor.capabilities() == (
        "local.mcp.b.read_file",
        "local.mcp.b.write_file",
    )


def test_in_flight_call_fails_structured_and_other_servers_survive() -> None:
    specs = [
        MCPSpec(name="a", transport="stdio", command=("a",), max_restarts=0),
        MCPSpec(name="b", transport="stdio", command=("b",), max_restarts=0),
    ]
    supervisor, connections = make_supervisor(
        specs, fake_kwargs={"a": {"hang_tools": {"read_file"}}}
    )

    async def scenario() -> None:
        await supervisor.start_all()
        pending_call = asyncio.create_task(
            supervisor.call_tool("local.mcp.a.read_file", {})
        )
        await asyncio.sleep(0.02)
        connections["a"][0].crash()
        with pytest.raises(MCPError) as crashed:
            await pending_call
        assert crashed.value.code == "SERVER_CRASHED"
        result = await supervisor.call_tool("local.mcp.b.read_file", {})
        assert result.is_error is False

    asyncio.run(scenario())


def test_tool_list_change_refreshes_and_survives_discovery_failure() -> None:
    supervisor, connections = make_supervisor(
        [MCPSpec(name="fs", transport="stdio", command=("x",))]
    )

    async def scenario() -> None:
        await supervisor.start_all()
        connection = connections["fs"][0]
        connection.tools = ("read_file", "new_tool")
        connection.on_tools_changed()
        await asyncio.sleep(0.05)
        assert supervisor.capabilities() == (
            "local.mcp.fs.read_file",
            "local.mcp.fs.new_tool",
        )
        connection.refresh_fails = True
        connection.on_tools_changed()
        await asyncio.sleep(0.05)
        assert supervisor.capabilities() == (
            "local.mcp.fs.read_file",
            "local.mcp.fs.new_tool",
        )
        assert supervisor.state_of("fs") == "running"
        with pytest.raises(MCPError) as missing:
            await supervisor.call_tool("local.mcp.fs.gone_tool", {})
        assert missing.value.code == "TOOL_NOT_FOUND"

    asyncio.run(scenario())


def test_unresolved_secret_fails_closed_without_touching_other_servers() -> None:
    specs = [
        MCPSpec(
            name="secured",
            transport="stdio",
            command=("x",),
            env={"TOKEN": "local:api_token"},
        ),
        MCPSpec(name="plain", transport="stdio", command=("y",)),
    ]
    supervisor, connections = make_supervisor(specs, secret_resolver=lambda name: None)

    async def scenario() -> None:
        with pytest.raises(MCPError) as missing:
            await supervisor.start("secured")
        assert missing.value.code == "SECRET_UNAVAILABLE"
        await supervisor.start_all()

    asyncio.run(scenario())
    assert supervisor.state_of("secured") == "failed"
    assert "secured" not in connections
    assert supervisor.state_of("plain") == "running"


def test_resolved_secret_reaches_the_server_environment_and_policy_blocks_public_url() -> (
    None
):
    seen_env: dict[str, str] = {}

    def factory(spec, *, env, headers, on_exit, on_tools_changed):
        seen_env.update(env)
        return FakeMCPConnection()

    supervisor, _ = make_supervisor(
        [
            MCPSpec(
                name="secured",
                transport="stdio",
                command=("x",),
                env={"TOKEN": "local:api_token"},
            ),
            MCPSpec(name="public", transport="http", url="http://example.com/mcp"),
        ],
        factory=factory,
        secret_resolver=lambda name: {"api_token": "s3cret"}[name],
    )

    async def scenario() -> None:
        await supervisor.start_all()

    asyncio.run(scenario())
    assert seen_env["TOKEN"] == "s3cret"
    assert supervisor.state_of("secured") == "running"
    assert supervisor.state_of("public") == "failed"
    assert supervisor.last_error("public") == "NETWORK_DENIED"


def test_supervisor_runs_the_real_stdio_fixture_server(tmp_path: Path) -> None:
    (tmp_path / "hello.txt").write_text("supervised", encoding="utf-8")
    supervisor = MCPSupervisor(
        [
            MCPSpec(
                name="fs",
                transport="stdio",
                command=(sys.executable, str(FIXTURE_SERVER)),
                env={"MCP_ROOT": str(tmp_path)},
                tool_timeout_seconds=10,
                start_timeout_seconds=10,
            )
        ]
    )

    async def scenario() -> None:
        try:
            await supervisor.start_all()
            assert supervisor.capabilities() == (
                "local.mcp.fs.read_file",
                "local.mcp.fs.write_file",
            )
            result = await supervisor.call_tool(
                "local.mcp.fs.read_file", {"path": "hello.txt"}
            )
            assert result.content[0]["text"] == "supervised"
        finally:
            await supervisor.stop_all()

    asyncio.run(scenario())


def make_running_supervisor(
    **kwargs,
) -> tuple[MCPSupervisor, dict[str, list[FakeMCPConnection]]]:
    supervisor, connections = make_supervisor(
        [MCPSpec(name="fs", transport="stdio", command=("x",), tool_timeout_seconds=5)],
        **kwargs,
    )

    async def start() -> None:
        await supervisor.start_all()

    asyncio.run(start())
    return supervisor, connections


def test_local_mcp_capabilities_require_consent_by_default() -> None:
    from core.policy import RiskLevel

    policy = LocalPolicy()
    assert policy.risk_level("local.mcp.fs.read_file", {}) is RiskLevel.LEVEL_1
    assert (
        policy.authorize("local.mcp.fs.read_file", {})
        is PolicyDecision.CONSENT_REQUIRED
    )
    assert policy.risk_level("local.files.read", {}) is RiskLevel.LEVEL_0
    denied = LocalPolicy(denied_capabilities=frozenset({"local.mcp.fs.write_file"}))
    assert denied.authorize("local.mcp.fs.write_file", {}) is PolicyDecision.DENY


def test_mcp_service_round_trip_includes_consent_and_receipt() -> None:
    supervisor, _ = make_running_supervisor()
    service = LocalMCPService(supervisor)
    payload = {"arguments": {"path": "a.txt"}, "run_id": "run-1", "task_id": "task-1"}

    async def scenario() -> None:
        first = await service.execute("local.mcp.fs.read_file", dict(payload))
        assert first is PolicyDecision.CONSENT_REQUIRED
        request = ConsentExchange(service.consent).create_request(
            "local.mcp.fs.read_file", dict(payload)
        )
        ConsentExchange(service.consent).decide(
            request, approved=True, actor_id="alice"
        )
        execution = await service.execute(
            "local.mcp.fs.read_file", dict(payload), consent=True
        )
        assert execution.status == "completed"
        assert execution.value["content"][0]["text"] == "ok"
        assert execution.receipt.capability == "local.mcp.fs.read_file"
        assert execution.receipt.status == "completed"
        assert execution.receipt.run_id == "run-1"
        assert execution.receipt.task_id == "task-1"
        assert execution.receipt.result_hash

    asyncio.run(scenario())


def test_mcp_service_maps_failures_to_structured_statuses() -> None:
    supervisor, connections = make_running_supervisor(
        fake_kwargs={"fs": {"tools": ("read_file",)}}
    )
    policy = LocalPolicy(
        always_allow_capabilities=frozenset({"local.mcp.fs.read_file"})
    )
    service = LocalMCPService(supervisor, policy=policy)

    async def scenario() -> None:
        connections["fs"][0].tools = ("missing",)
        await supervisor.refresh_tools("fs")
        broken = await service.execute("local.mcp.fs.read_file", {"arguments": {}})
        assert broken.status == "failed"
        assert broken.value["error_code"] == "TOOL_NOT_FOUND"
        assert broken.receipt.status == "failed"

    asyncio.run(scenario())


def test_mcp_service_timeout_yields_structured_failure(tmp_path: Path) -> None:
    slow_server = textwrap.dedent(
        """
        import json, sys, time
        for line in sys.stdin:
            message = json.loads(line)
            if message.get("method") == "tools/call":
                time.sleep(0.5)
                response = {"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": "late"}], "isError": False}}
            elif "id" in message:
                response = {"jsonrpc": "2.0", "id": message["id"], "result": {"tools": [{"name": "read_file"}]}}
            else:
                continue
            sys.stdout.write(json.dumps(response) + "\\n")
            sys.stdout.flush()
        """
    )
    script = tmp_path / "slow_mcp_server.py"
    script.write_text(slow_server, encoding="utf-8")
    supervisor = MCPSupervisor(
        [
            MCPSpec(
                name="slow",
                transport="stdio",
                command=(sys.executable, str(script)),
                tool_timeout_seconds=10,
                start_timeout_seconds=10,
            )
        ]
    )
    policy = LocalPolicy(
        always_allow_capabilities=frozenset({"local.mcp.slow.read_file"})
    )
    service = LocalMCPService(supervisor, policy=policy)

    async def scenario() -> None:
        try:
            await supervisor.start_all()
            execution = await service.execute(
                "local.mcp.slow.read_file",
                {"arguments": {}},
                timeout=0.05,
            )
            assert execution.status == "timed_out"
            assert execution.value["error_code"] == "MCP_TIMEOUT"
            assert execution.receipt.status == "timed_out"
        finally:
            await supervisor.stop_all()

    asyncio.run(scenario())


class FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, value: str) -> None:
        self.sent.append(value)


def _client_with_mcp(supervisor, *, policy=None) -> LocalRuntimeClient:
    return LocalRuntimeClient(
        server_url="ws://unused",
        device_id="device-1",
        session_token="token",
        private_key=Ed25519PrivateKey.generate(),
        session_id="session-1",
        mcp_service=LocalMCPService(supervisor, policy=policy, consent=ConsentStore()),
    )


def _sign_task(server_key, task_id, payload):
    return verify_envelope(
        sign_envelope(
            private_key=server_key,
            message_type=MessageType.TASK,
            device_id="device-1",
            session_id="session-1",
            task_id=task_id,
            payload=payload,
        ),
        server_public_key=public_key_text(server_key),
        expected_device_id="device-1",
        expected_session_id="session-1",
    )


def test_client_projects_mcp_capabilities_into_hello_and_update() -> None:
    supervisor, _ = make_running_supervisor()
    client = _client_with_mcp(supervisor)
    client.connection = FakeConnection()

    async def scenario() -> None:
        await client.send_hello()
        await client.send_capability_update()

    asyncio.run(scenario())
    hello = json.loads(client.connection.sent[0])
    update = json.loads(client.connection.sent[1])
    assert "local.mcp.fs.read_file" in hello["payload"]["capabilities"]
    assert "local.mcp.fs.read_file" in update["payload"]["capabilities"]


def test_client_completes_mcp_task_through_consent_round_trip() -> None:
    supervisor, _ = make_running_supervisor()
    server_key = Ed25519PrivateKey.generate()
    client = _client_with_mcp(supervisor)
    client.connection = FakeConnection()
    task = _sign_task(
        server_key,
        "task-mcp",
        {
            "operation": "local.mcp.fs.read_file",
            "arguments": {"path": "a.txt"},
            "run_id": "run-9",
        },
    )

    async def scenario() -> None:
        await client._handle_task(task)
        consent_message = json.loads(client.connection.sent[-1])
        assert consent_message["type"] == MessageType.CONSENT_REQUIRED
        decision = verify_envelope(
            sign_envelope(
                private_key=server_key,
                message_type=MessageType.CONSENT_DECISION,
                device_id="device-1",
                session_id="session-1",
                task_id="task-mcp",
                payload={
                    "approved": True,
                    "actor_id": "alice",
                    "request_hash": consent_message["payload"]["request_hash"],
                },
            ),
            server_public_key=public_key_text(server_key),
            expected_device_id="device-1",
            expected_session_id="session-1",
        )
        await client._handle_consent_decision(decision)

    asyncio.run(scenario())
    result = json.loads(client.connection.sent[-1])
    assert result["type"] == MessageType.TASK_RESULT
    assert result["payload"]["result"]["content"][0]["text"] == "ok"
    receipt = result["payload"]["receipt"]
    assert receipt["capability"] == "local.mcp.fs.read_file"
    assert receipt["status"] == "completed"
    assert receipt["consent_decision"] == "approved"


def test_unknown_mcp_server_task_yields_structured_error_and_runtime_survives() -> None:
    supervisor, _ = make_running_supervisor()
    server_key = Ed25519PrivateKey.generate()
    client = _client_with_mcp(supervisor)
    client.connection = FakeConnection()
    task = _sign_task(
        server_key,
        "task-missing",
        {"operation": "local.mcp.nosuch.tool", "arguments": {}, "run_id": "run-9"},
    )

    async def scenario() -> None:
        await client._handle_task(task)
        echo = _sign_task(
            server_key,
            "task-echo",
            {"operation": "echo", "value": "still-here", "run_id": "run-9"},
        )
        await client._handle_task(echo)

    asyncio.run(scenario())
    failure = json.loads(client.connection.sent[2])
    assert failure["type"] == MessageType.TASK_RESULT
    assert failure["payload"]["result"]["error_code"] == "SERVER_UNKNOWN"
    assert failure["payload"]["receipt"]["status"] == "failed"
    assert failure["payload"]["receipt"]["capability"] == "local.mcp.nosuch.tool"
    echo_result = json.loads(client.connection.sent[-1])
    assert echo_result["type"] == MessageType.TASK_RESULT
    assert echo_result["payload"]["result"] == "still-here"


def test_client_republishes_capabilities_after_tool_set_change() -> None:
    supervisor, connections = make_running_supervisor()
    client = _client_with_mcp(supervisor)
    client.connection = FakeConnection()

    async def scenario() -> None:
        await client.send_capability_update()
        connections["fs"][0].tools = ("read_file", "renamed_tool")
        await client.refresh_mcp_capabilities()

    asyncio.run(scenario())
    first = json.loads(client.connection.sent[0])
    second = json.loads(client.connection.sent[1])
    assert "local.mcp.fs.renamed_tool" not in first["payload"]["capabilities"]
    assert "local.mcp.fs.renamed_tool" in second["payload"]["capabilities"]
    assert "local.mcp.fs.write_file" not in second["payload"]["capabilities"]


def test_https_urls_are_rejected_because_the_client_is_plaintext_http() -> None:
    with pytest.raises(MCPError) as invalid:
        MCPNetworkPolicy().validate_url("https://127.0.0.1:8443/mcp")
    assert invalid.value.code == "INVALID_URL"
    with pytest.raises(MCPError):
        HTTPMCPConnection("https://127.0.0.1:8443/mcp")


def test_http_endpoint_connection_failure_enters_the_restart_budget() -> None:
    def factory(spec, *, env, headers, on_exit, on_tools_changed):
        connection = FakeMCPConnection()
        connection.on_exit = on_exit
        connection.on_tools_changed = on_tools_changed
        connections.setdefault(spec.name, []).append(connection)
        return connection

    connections: dict[str, list[FakeMCPConnection]] = {}
    supervisor = MCPSupervisor(
        [
            MCPSpec(
                name="web",
                transport="http",
                url="http://127.0.0.1:9/mcp",
                max_restarts=1,
                restart_backoff_seconds=0,
                tool_timeout_seconds=5,
            )
        ],
        connection_factory=factory,
    )

    async def scenario() -> None:
        await supervisor.start_all()
        connections["web"][0].fail_unavailable = True
        with pytest.raises(MCPError):
            await supervisor.call_tool("local.mcp.web.read_file", {})
        await wait_for_state(supervisor, "web", "running")
        assert len(connections["web"]) == 2
        connections["web"][1].fail_unavailable = True
        with pytest.raises(MCPError):
            await supervisor.call_tool("local.mcp.web.read_file", {})
        await wait_for_state(supervisor, "web", "failed")
        assert supervisor.capabilities() == ()

    asyncio.run(scenario())


def test_network_policy_is_revalidated_on_every_http_call() -> None:
    connections: dict[str, list[FakeMCPConnection]] = {}

    def factory(spec, *, env, headers, on_exit, on_tools_changed):
        connection = FakeMCPConnection()
        connection.on_exit = on_exit
        connection.on_tools_changed = on_tools_changed
        connections.setdefault(spec.name, []).append(connection)
        return connection

    supervisor = MCPSupervisor(
        [
            MCPSpec(
                name="web",
                transport="http",
                url="http://10.1.2.3:9/mcp",
                tool_timeout_seconds=5,
            )
        ],
        connection_factory=factory,
        network_policy=MCPNetworkPolicy(approved_hosts=frozenset({"10.0.0.0/8"})),
    )

    async def scenario() -> None:
        await supervisor.start_all()
        supervisor.network_policy = MCPNetworkPolicy()
        with pytest.raises(MCPError) as denied:
            await supervisor.call_tool("local.mcp.web.read_file", {})
        assert denied.value.code == "NETWORK_DENIED"

    asyncio.run(scenario())


def test_tool_set_change_is_republished_automatically() -> None:
    supervisor, connections = make_running_supervisor()
    client = _client_with_mcp(supervisor)
    client.connection = FakeConnection()

    async def scenario() -> None:
        await client.send_capability_update()
        connections["fs"][0].tools = ("read_file", "renamed_tool")
        connections["fs"][0].on_tools_changed()
        await asyncio.sleep(0.1)

    asyncio.run(scenario())
    first = json.loads(client.connection.sent[0])
    republished = json.loads(client.connection.sent[1])
    assert "local.mcp.fs.renamed_tool" not in first["payload"]["capabilities"]
    assert "local.mcp.fs.renamed_tool" in republished["payload"]["capabilities"]
    assert republished["type"] == MessageType.CAPABILITY_UPDATE


def test_start_failure_message_never_carries_the_command_path(tmp_path: Path) -> None:
    supervisor = MCPSupervisor(
        [
            MCPSpec(
                name="gone",
                transport="stdio",
                command=(str(tmp_path / "no-such-binary"),),
            )
        ]
    )

    async def scenario() -> None:
        with pytest.raises(MCPError) as failed:
            await supervisor.start("gone")
        assert failed.value.code == "SERVER_START_FAILED"
        assert str(tmp_path) not in str(failed.value)

    asyncio.run(scenario())


def test_load_mcp_specs_reads_a_config_file(tmp_path: Path) -> None:
    config = tmp_path / "local-mcp.json"
    config.write_text(
        json.dumps(
            {
                "servers": [
                    {"name": "fs", "transport": "stdio", "command": ["mcp-server-fs"]}
                ]
            }
        ),
        encoding="utf-8",
    )
    specs = load_mcp_specs(config)
    assert [spec.name for spec in specs] == ["fs"]


@pytest.mark.skipif(os.name == "nt", reason="process-group reaping is POSIX-specific")
def test_stdio_close_reaps_grandchildren_of_the_server_process(
    tmp_path: Path,
) -> None:
    """05-M5: close() must tear down the whole process group, not just the
    direct child, and must return even with grandchildren keeping pipes open."""
    marker = tmp_path / "grandchild.pid"
    script = (
        "import subprocess, sys, time\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\n"
        f"open({str(marker)!r}, 'w').write(str(p.pid))\n"
        "time.sleep(300)\n"
    )
    connection = StdioMCPConnection([sys.executable, "-c", script])

    async def scenario() -> None:
        await connection.start()
        deadline = asyncio.get_running_loop().time() + 10
        while not marker.exists():
            assert (
                asyncio.get_running_loop().time() < deadline
            ), "grandchild never started"
            await asyncio.sleep(0.05)
        child_pid = connection.process.pid
        grandchild_pid = int(marker.read_text())
        completed = False
        try:
            await asyncio.wait_for(connection.close(), timeout=15)
            # The grandchild belongs to the child's process group, which
            # close() now signals as a whole; a bare kill() would leave it.
            deadline = asyncio.get_running_loop().time() + 5
            while True:
                try:
                    os.kill(grandchild_pid, 0)
                except ProcessLookupError:
                    completed = True
                    return
                assert (
                    asyncio.get_running_loop().time() < deadline
                ), "the grandchild survived close()"
                await asyncio.sleep(0.1)
        finally:
            if not completed:
                # Never leave sleepers behind to wedge the shutdown.
                for pid in (child_pid, grandchild_pid):
                    try:
                        os.kill(pid, 9)
                    except ProcessLookupError:
                        pass

    asyncio.run(scenario())
