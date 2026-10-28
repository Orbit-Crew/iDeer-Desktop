"""The T123 fixed connector component: a stdlib-only stdio MCP server.

Shipped as the entry of the test connector packages. Tools have known
outputs: ``echo`` returns its input, ``read_file``/``write_file`` operate
only inside the directory given through ``MCP_ROOT`` (the environment the
controlled install configuration pins to the connector's own managed data
directory), so out-of-root writes and symlink escapes fail with an error
result instead of an effect. A marker file records the process pid so the
lifecycle gate can prove no orphan survives a removal.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "echo",
        "description": "Return the given value unchanged.",
        "inputSchema": {
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a UTF-8 text file under the managed data root.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write a UTF-8 text file under the managed data root.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
]


def resolve(path: str) -> Path:
    root = Path(os.environ["MCP_ROOT"]).resolve()
    candidate = (root / path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("path escapes the managed data root")
    return candidate


def call_tool(name: str, arguments: dict) -> list[dict]:
    if name == "echo":
        return [{"type": "text", "text": str(arguments["value"])}]
    if name == "read_file":
        text = resolve(str(arguments["path"])).read_text(encoding="utf-8")
        return [{"type": "text", "text": text}]
    if name == "write_file":
        target = resolve(str(arguments["path"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(arguments["content"]), encoding="utf-8")
        return [{"type": "text", "text": "written"}]
    raise ValueError(f"unknown tool: {name}")


def dispatch(message: dict) -> dict | None:
    method = message.get("method")
    if "id" not in message:
        return None
    if method == "initialize":
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fixture-connector", "version": "1.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = message.get("params", {})
        try:
            result = {
                "content": call_tool(str(params.get("name")), dict(params.get("arguments", {}))),
                "isError": False,
            }
        except (ValueError, OSError, KeyError) as exc:
            result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
    elif method == "ping":
        result = {}
    else:
        return {
            "jsonrpc": "2.0",
            "id": message["id"],
            "error": {"code": -32601, "message": f"unknown method: {method}"},
        }
    return {"jsonrpc": "2.0", "id": message["id"], "result": result}


def main() -> int:
    marker = os.environ.get("CONNECTOR_PID_MARKER")
    if marker:
        try:
            Path(marker).write_text(str(os.getpid()), encoding="utf-8")
        except OSError:
            pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict):
            continue
        response = dispatch(message)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
