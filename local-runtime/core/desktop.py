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
from .platform_chat import DesktopChat, empty_state
from .process_job import own_process_tree
from .settings import load_settings
from .file_service import WorkspaceSelection
from .secrets import SecretStoreError, create_default_secret_store
from .task_guard import TaskGuard
from .receipt_ledger import ReceiptLedger, ReceiptStorageError, profile_binding
from .receipts import content_hash
from .tray import load_controller


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    job = own_process_tree()
    stop = threading.Event()
    commands: queue.Queue = queue.Queue(maxsize=1)
    workspace_commands: queue.Queue = queue.Queue(maxsize=1)
    receipt_commands: queue.Queue = queue.Queue(maxsize=1)
    chat_commands: queue.Queue = queue.Queue(maxsize=8)
    output_lock = threading.Lock()

    def emit(value):
        with output_lock:
            print(json.dumps(value), flush=True)

    def read_control() -> None:
        for line in sys.stdin:
            if line.strip() == '{"type":"shutdown"}':
                break
            try:
                if len(line) > 131072:
                    continue
                command = json.loads(line)
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'action', 'offset', 'scope'}
                        and command['type'] == 'receipts' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and command['action'] in {'history', 'clear-confirmed'}
                        and type(command['offset']) is int and 0 <= command['offset'] <= 1000000000):
                    receipt_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'path', 'confirmed', 'scope'}
                        and command['type'] == 'workspace' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['path'], str)
                        and len(command['path']) <= 32768 and command['confirmed'] is True
                        and isinstance(command['scope'], str)):
                    workspace_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'command'}
                        and command['type'] == 'chat' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['command'], dict)):
                    chat_commands.put_nowait(command)
                    continue
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

        workspace = WorkspaceSelection(args.config)
        def local_consents():
            return controller.pending_consents() if controller is not None else ()

        def decide_consent(task_id, digest, approved):
            if controller is None or login.status()['state'] != 'authenticated':
                raise ValueError('CONSENT_UNAVAILABLE')
            controller.client.resolve_local_consent(task_id, approved=approved, expected_hash=digest)

        chat = DesktopChat(args.config, login.secure, login.status, local_consents=local_consents, decide_consent=decide_consent)
        args.config.parent.mkdir(parents=True, exist_ok=True)
        receipts = ReceiptLedger(args.config.with_name('receipts.db'))

        def chat_control():
            while not stop.is_set():
                try:
                    command = chat_commands.get(timeout=0.5)
                except queue.Empty:
                    continue
                try:
                    result = chat.handle(command['command'])
                except Exception:
                    result = empty_state()
                    result['error'] = 'CHAT_PROTOCOL_ERROR'
                emit({'v': 1, 'type': 'chat', 'id': command['id'], 'result': result})

        threading.Thread(target=chat_control, daemon=True).start()

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
            from .protocol import public_key_text
            actual_key = public_key_text(private_key)
            if settings.device_public_key != actual_key:
                settings.device_public_key = actual_key
                settings.save(args.config)
            args.config.parent.mkdir(parents=True, exist_ok=True)
            controller = load_controller(args.config, private_key=private_key, desktop_mode=True,
                audit=LocalAuditLog(db_path=args.config.with_name("audit.db")))
            if not controller.settings.session_token:
                raise ValueError("PAIRING_REQUIRED")
            controller.client.task_guard = TaskGuard(args.config.with_name("tasks.db"))
            controller.client.receipt_ledger = receipts
            controller.client.user_id = settings.user_id
            controller.client.file_service.available = lambda: login.status()['state'] == 'authenticated'
            controller.start()
            return controller

        controller = connect()
        while not stop.is_set():
            browser_url = None
            try:
                receipt_command = receipt_commands.get_nowait()
            except queue.Empty:
                receipt_command = None
            if receipt_command:
                error = ''
                receipt_owner = profile_binding(load_settings(args.config))
                try:
                    if receipt_command['action'] == 'clear-confirmed':
                        if receipt_owner is None or receipt_command['scope'] != content_hash(receipt_owner):
                            error = 'RECEIPT_BINDING_CHANGED'
                        else:
                            receipts.clear_confirmed(receipt_owner)
                except ReceiptStorageError:
                    error = 'RECEIPT_STORAGE_UNAVAILABLE'
                emit({'v': 1, 'type': 'receipts', 'id': receipt_command['id'],
                      'result': receipts.snapshot(receipt_owner, offset=receipt_command['offset']), 'error': error})
            try:
                selection = workspace_commands.get_nowait()
            except queue.Empty:
                selection = None
            if selection:
                try:
                    if login.status()['state'] != 'authenticated' or selection['scope'] != workspace.scope():
                        raise ValueError('WORKSPACE_UNAVAILABLE')
                    workspace.select(selection['path'], confirmed=True)
                    if controller is not None:
                        controller.stop()
                    controller = connect()
                    emit({'v': 1, 'type': 'workspace', 'id': selection['id'], 'error': ''})
                except Exception:
                    emit({'v': 1, 'type': 'workspace', 'id': selection['id'], 'error': 'WORKSPACE_SELECTION_FAILED'})
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
            current_receipt_owner = profile_binding(load_settings(args.config))
            receipt_view = receipts.snapshot(current_receipt_owner)
            tasks = [{"taskId": row['task_id'][:256], "runId": row['run_id'][:256],
                      "state": (row['status'] if row['delivery_state'] != 'cleaned' else 'cleaned')[:256],
                      "capability": row['capability'][:256]} for row in receipt_view['rows']]
            connection = "offline" if load_settings(args.config).device_id else "not-configured"
            if controller is not None:
                connection = controller.status().connection
            status = {"v": 1, "connection": connection, "tasks": tasks, "login": login.status(),
                      "receiptStorageError": receipts.error,
                      "receiptScope": content_hash(current_receipt_owner) if current_receipt_owner else '',
                      "selectionScope": workspace.scope(),
                      "workspace": workspace.status() if login.status()["state"] == "authenticated" else {"state": "unavailable", "logicalRoot": ""}}
            if browser_url:
                status["browserUrl"] = browser_url
            emit(status)
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
