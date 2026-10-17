"""Ticket-02 secret mechanics composed with the ticket-01 MCP supervisor.

MCP env values exist only as ``local:<name>`` references in configs and task
payloads; the device resolves them into the server process environment only.
Tool arguments and receipts stay plaintext-free, and tool output that echoes
a resolved value is scrubbed before it can travel back to the server.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from core.mcp import LocalMCPService, MCPError, MCPSpec, MCPSupervisor, MCPToolCallResult
from core.policy import LocalPolicy
from core.secrets import InMemorySecretStore, SecretResolver

TOKEN = "ghp_mcp-secrets-token-value-99"
CAPABILITY = "local.mcp.secured.echo"


class RecordingConnection:
    """Fake stdio connection that records env, calls, and scripted results."""

    def __init__(self, *, tools=("echo",), results=None):
        self.tools = tuple(tools)
        self.results: dict[str, MCPToolCallResult] = results or {}
        self.calls: list[tuple[str, Any]] = []
        self.started = False
        self.closed = False
        self.on_exit = None
        self.on_tools_changed = None

    async def start(self) -> None:
        self.started = True

    async def request(self, method: str, params: Any, *, timeout: float) -> Any:
        if method == "initialize":
            return {"serverInfo": {"name": "fake"}}
        if method == "tools/list":
            return {"tools": [{"name": name} for name in self.tools]}
        if method == "tools/call":
            self.calls.append((params.get("name"), params.get("arguments")))
            scripted = self.results.get(params.get("name"))
            content = (
                [dict(entry) for entry in scripted.content]
                if scripted is not None
                else [{"type": "text", "text": "ok"}]
            )
            return {
                "content": content,
                "isError": bool(scripted.is_error) if scripted is not None else False,
            }
        raise MCPError("SERVER_UNAVAILABLE", f"unexpected method {method}")

    async def notify(self, method: str, params: Any = None) -> None:
        return None

    async def close(self) -> None:
        self.closed = True


def make_supervisor(specs, **kwargs):
    connections: list[RecordingConnection] = []
    seen_env: dict[str, str] = {}

    def factory(spec, *, env, headers, on_exit, on_tools_changed):
        seen_env.update(env)
        connection = RecordingConnection()
        connection.on_exit = on_exit
        connection.on_tools_changed = on_tools_changed
        connections.append(connection)
        return connection

    return (
        MCPSupervisor(specs, connection_factory=factory, **kwargs),
        connections,
        seen_env,
    )


def _service(store: InMemorySecretStore, supervisor: MCPSupervisor) -> LocalMCPService:
    return LocalMCPService(
        supervisor,
        policy=LocalPolicy(always_allow_capabilities=frozenset({CAPABILITY})),
    )


def _spec() -> MCPSpec:
    return MCPSpec(
        name="secured",
        transport="stdio",
        command=("x",),
        env={"API_TOKEN": "local:api.company"},
    )


def test_reference_reaches_only_the_server_process_environment() -> None:
    import json

    store = InMemorySecretStore()
    store.set("api.company", TOKEN)
    supervisor, connections, seen_env = make_supervisor(
        [_spec()], secret_resolver=SecretResolver(store).name_lookup()
    )

    async def scenario() -> None:
        await supervisor.start_all()
        service = _service(store, supervisor)
        execution = await service.execute(CAPABILITY, {"arguments": {"text": "hello"}})
        assert execution.value["status"] == "completed"
        assert TOKEN not in json.dumps(execution.receipt.as_dict())

    asyncio.run(scenario())

    assert seen_env["API_TOKEN"] == TOKEN
    # The config itself keeps only the reference; the task arguments carry no
    # secret material, and the receipt is hashes and status only.
    assert supervisor._records["secured"].spec.env == {"API_TOKEN": "local:api.company"}
    assert connections[0].calls == [("echo", {"text": "hello"})]
    assert supervisor.capabilities() == (CAPABILITY,)


def test_missing_reference_fails_closed_without_plaintext_fallback() -> None:
    store = InMemorySecretStore()  # the reference target is absent
    supervisor, connections, seen_env = make_supervisor(
        [_spec()], secret_resolver=SecretResolver(store).name_lookup()
    )

    async def scenario() -> None:
        with pytest.raises(MCPError) as excinfo:
            await supervisor.start("secured")
        assert excinfo.value.code == "SECRET_UNAVAILABLE"

    asyncio.run(scenario())

    assert supervisor.state_of("secured") == "failed"
    assert not connections  # the server never started with a partial env
    assert seen_env == {}

    async def execute_failure() -> None:
        execution = await _service(store, supervisor).execute(CAPABILITY, {"arguments": {}})
        assert execution.value["status"] == "failed"
        assert execution.value["error_code"] == "SERVER_UNAVAILABLE"
        assert "local:api.company" not in str(execution.value)
        assert TOKEN not in str(execution.receipt.as_dict())

    asyncio.run(execute_failure())


def test_failure_messages_echoing_the_secret_are_scrubbed() -> None:
    store = InMemorySecretStore()
    store.set("api.company", TOKEN)

    class FailingConnection(RecordingConnection):
        async def request(self, method: str, params: Any, *, timeout: float) -> Any:
            if method == "tools/call":
                raise MCPError("SERVER_UNAVAILABLE", f"endpoint rejected token {TOKEN}")
            return await super().request(method, params, timeout=timeout)

    def factory(spec, *, env, headers, on_exit, on_tools_changed):
        return FailingConnection()

    supervisor = MCPSupervisor(
        [_spec()], connection_factory=factory, secret_resolver=SecretResolver(store).name_lookup()
    )

    async def scenario() -> None:
        await supervisor.start_all()
        service = LocalMCPService(
            supervisor,
            policy=LocalPolicy(always_allow_capabilities=frozenset({CAPABILITY})),
        )
        execution = await service.execute(CAPABILITY, {"arguments": {}})
        assert execution.value["status"] == "failed"
        assert execution.value["error_code"] == "SERVER_UNAVAILABLE"
        assert TOKEN not in execution.value["message"]
        assert "[REDACTED]" in execution.value["message"]

    asyncio.run(scenario())


def test_tool_output_echoing_the_secret_is_scrubbed() -> None:
    store = InMemorySecretStore()
    store.set("api.company", TOKEN)

    connections: list[RecordingConnection] = []

    def factory(spec, *, env, headers, on_exit, on_tools_changed):
        connection = RecordingConnection(
            results={
                "echo": MCPToolCallResult(
                    content=({"type": "text", "text": f"token is {TOKEN}"},),
                    is_error=False,
                )
            }
        )
        connection.on_exit = on_exit
        connection.on_tools_changed = on_tools_changed
        connections.append(connection)
        return connection

    supervisor = MCPSupervisor(
        [_spec()], connection_factory=factory, secret_resolver=SecretResolver(store).name_lookup()
    )

    async def scenario() -> None:
        await supervisor.start_all()
        service = LocalMCPService(
            supervisor,
            policy=LocalPolicy(always_allow_capabilities=frozenset({CAPABILITY})),
        )
        execution = await service.execute(CAPABILITY, {"arguments": {}})
        assert execution.value["status"] == "completed"
        assert TOKEN not in str(execution.value)
        assert "[REDACTED]" in str(execution.value)
        assert TOKEN not in str(execution.receipt.as_dict())
        assert execution.receipt.result_hash

    asyncio.run(scenario())
