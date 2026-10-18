"""A minimal filesystem MCP server over stdio used by the M9 test gates.

Speaks newline-delimited JSON-RPC 2.0 per the MCP stdio transport. Tools are
confined to the directory given through the ``MCP_ROOT`` environment variable,
which also exercises the runtime's env injection seam.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "read_file",
        "description": "Read a UTF-8 text file under the allowed root.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write a UTF-8 text file under the allowed root.",
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
        raise ValueError("path escapes the allowed root")
    return candidate


def call_tool(name: str, arguments: dict) -> list[dict]:
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
            "serverInfo": {"name": "fixture-filesystem", "version": "0.1.0"},
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
            result = {
                "content": [{"type": "text", "text": str(exc)}],
                "isError": True,
            }
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
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = dispatch(message)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
