"""Test-only MCP echo with an append-only side-effect ledger."""
import json
import os
import sys
from pathlib import Path

Path(os.environ["MCP_PID"]).write_text(str(os.getpid()))
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                  "serverInfo": {"name": "counting-fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Counting echo fixture",
                    "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}]}
    elif method == "tools/call":
        value = message["params"]["arguments"]["value"]
        with Path(os.environ["MCP_COUNT"]).open("a", encoding="utf-8") as ledger:
            ledger.write(value + "\n")
        result = {"content": [{"type": "text", "text": value}], "isError": False}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
