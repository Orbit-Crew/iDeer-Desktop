"""Owned status/login channel. Executable tasks arrive only by signed WSS."""
from __future__ import annotations

import argparse
import base64
import json
import queue
import sys
import threading
from pathlib import Path

from .audit import LocalAuditLog
from .browser_login import BrowserLogin
from .process_job import own_process_tree
from .settings import load_settings
from .secrets import SecretStoreError, create_default_secret_store
from .task_guard import TaskGuard
from .tray import load_controller


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    job = own_process_tree()
    stop = threading.Event()
    commands: queue.Queue = queue.Queue(maxsize=1)

    def read_control() -> None:
        for line in sys.stdin:
            if line.strip() == '{"type":"shutdown"}':
                break
            try:
                command = json.loads(line[:8192])
                if (isinstance(command, dict) and set(command) == {"type", "serverUrl", "deviceName"}
                        and command["type"] == "login" and isinstance(command["serverUrl"], str)
                        and isinstance(command["deviceName"], str)):
                    commands.put_nowait(command)
            except (ValueError, queue.Full):
                pass
        stop.set()

    threading.Thread(target=read_control, daemon=True).start()
    controller = None
    try:
        login = BrowserLogin(args.config, create_default_secret_store())
        try:
            login.restore()
        except SecretStoreError:
            login.fail("SECURE_STORAGE_FAILED")
        except Exception:
            login.fail("LOGIN_REAUTHENTICATION_REQUIRED")

        def connect():
            settings = load_settings(args.config)
            if not settings.server_url or not settings.device_id:
                return None
            if login.status()["state"] != "authenticated":
                return None
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
            return controller

        controller = connect()
        while not stop.is_set():
            browser_url = None
            try:
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    command = None
                if command:
                    browser_url = login.begin(command["serverUrl"], command["deviceName"])
                elif login.status()["state"] == "awaiting-confirmation":
                    if login.poll():
                        controller = connect()
            except SecretStoreError:
                login.fail("SECURE_STORAGE_FAILED")
            except Exception as exc:
                allowed = {"LOGIN_EXPIRED", "LOGIN_ALREADY_USED", "LOGIN_BINDING_INVALID", "LOGIN_OWNER_MISMATCH",
                           "LOGIN_ORIGIN_INVALID", "LOGIN_IN_PROGRESS", "DEVICE_ALREADY_PAIRED"}
                login.fail(str(exc) if str(exc) in allowed else "LOGIN_FAILED")
            if controller is not None and login.status()["state"] != "authenticated":
                controller.stop()
                controller = None
            tasks = []
            connection = "offline" if load_settings(args.config).device_id else "not-configured"
            if controller is not None:
                connection = controller.status().connection
                for entry in controller.audit.recent(limit=20):
                    if entry.task_id:
                        tasks.append({"taskId": entry.task_id[:256], "runId": (entry.run_id or "")[:256],
                                      "state": entry.action[:256], "capability": (entry.capability or "")[:256]})
            status = {"v": 1, "connection": connection, "tasks": tasks, "login": login.status()}
            if browser_url:
                status["browserUrl"] = browser_url
            print(json.dumps(status), flush=True)
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
