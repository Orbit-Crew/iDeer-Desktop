"""Owned stdio status channel. Only shutdown is accepted; tasks arrive by WSS."""
from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
from pathlib import Path

from .audit import LocalAuditLog
from .process_job import own_process_tree
from .settings import load_settings
from .secrets import create_default_secret_store
from .task_guard import TaskGuard
from .tray import load_controller


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    job = own_process_tree()
    stop = threading.Event()

    def read_control() -> None:
        for line in sys.stdin:
            if line.strip() == '{"type":"shutdown"}':
                break
            # Unknown control input fails closed, never forwarded to tools.
        stop.set()

    threading.Thread(target=read_control, daemon=True).start()
    controller = None
    try:
        settings = load_settings(args.config)
        if settings.server_url and settings.device_id:
            # Desktop uses the existing pairing and OS secure store only.
            if not settings.session_token_ref or not settings.device_key_ref or not settings.server_public_key:
                raise ValueError("PAIRING_REQUIRED")
            if settings.session_token or settings.allow_unpinned_broker_key:
                raise ValueError("PAIRING_REQUIRED")
            from cryptography.hazmat.primitives.serialization import load_pem_private_key
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
            secure = create_default_secret_store()
            private_key = load_pem_private_key(base64.b64decode(secure.get(settings.device_key_ref)), password=None)
            if not isinstance(private_key, Ed25519PrivateKey):
                raise ValueError("PAIRING_REQUIRED")
            args.config.parent.mkdir(parents=True, exist_ok=True)
            controller = load_controller(args.config, private_key=private_key,
                audit=LocalAuditLog(db_path=args.config.with_name("audit.db")))
            if not controller.settings.session_token:
                raise ValueError("PAIRING_REQUIRED")
            controller.client.task_guard = TaskGuard(args.config.with_name("tasks.db"))
            controller.start()
        while not stop.is_set():
            tasks = []
            connection = "not-configured"
            if controller is not None:
                connection = controller.status().connection
                for entry in controller.audit.recent(limit=20):
                    if entry.task_id:
                        tasks.append({"taskId": entry.task_id[:256], "runId": (entry.run_id or "")[:256],
                                      "state": entry.action[:256], "capability": (entry.capability or "")[:256]})
            print(json.dumps({"v": 1, "connection": connection, "tasks": tasks}), flush=True)
            stop.wait(0.5)
        return 0
    except Exception:
        # Do not forward exception text or config/credential values to UI.
        print(json.dumps({"v": 1, "connection": "error", "tasks": []}), flush=True)
        return 1
    finally:
        if controller is not None:
            controller.stop()
        _ = job  # Keep ownership until process exit.


if __name__ == "__main__":
    raise SystemExit(main())
