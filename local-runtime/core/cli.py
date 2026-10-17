"""Small local-only administration CLI for the runtime policy and approvals."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)

from .consent import ConsentStore
from .secrets import (
    InMemorySecretStore,
    SecretStore,
    SecretStoreError,
    create_default_secret_store,
    secret_ref,
)

SECRET_COMMANDS = {"secret-set", "secret-rotate", "secret-delete", "secret-list"}


def _secret_backend_option() -> argparse.ArgumentParser:
    backend = argparse.ArgumentParser(add_help=False)
    backend.add_argument(
        "--backend",
        choices=("auto", "memory"),
        default="auto",
        help="secret store backend: the OS secure store or an in-memory store",
    )
    return backend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ideer-local-runtime")
    parser.add_argument(
        "--db", type=Path, default=Path.home() / ".ideer" / "local-runtime.db"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    config = sub.add_parser("config-root", help="set the logical workspace root")
    config.add_argument("path", type=Path)
    policy = sub.add_parser("set-policy", help="set a capability policy")
    policy.add_argument("capability")
    policy.add_argument("decision", choices=("allow", "deny", "consent"))
    sub.add_parser("approvals", help="list local approval audit entries")
    sub.add_parser("list-pending", help="list approvals awaiting a local decision")
    runtime = sub.add_parser(
        "start-runtime",
        parents=[_secret_backend_option()],
        help="start the outbound-only runtime",
    )
    runtime.add_argument("--server-url", required=True)
    runtime.add_argument("--device-id", required=True)
    # Session credentials must not land in argv (ps/proc cmdline); see
    # _resolve_runtime_credentials for the stdin/env fallbacks (05-M8).
    runtime.add_argument(
        "--session-token",
        default=os.environ.get("IDEER_LOCAL_SESSION_TOKEN", ""),
        help="device session token; '-' reads it from stdin",
    )
    runtime.add_argument(
        "--private-key",
        default=os.environ.get("IDEER_LOCAL_PRIVATE_KEY", ""),
        help="base64 encoded Ed25519 private key; '-' reads it from stdin",
    )
    runtime.add_argument(
        "--mcp-config",
        type=Path,
        default=None,
        help="path to the local MCP server config (JSON); servers launch at startup",
    )
    tray = sub.add_parser("tray", help="start the native local-runtime tray window")
    tray.add_argument(
        "--config",
        type=Path,
        default=Path.home() / ".ideer" / "local-runtime.json",
        help="runtime settings JSON path",
    )
    tray.add_argument(
        "--headless", action="store_true", help="print status and keep no GUI"
    )
    complete = sub.add_parser(
        "pair-complete", help="finish an owner-confirmed device pairing"
    )
    complete.add_argument("--server-url", required=True)
    complete.add_argument("--device-id", required=True)
    complete.add_argument("--claim-token")
    complete.add_argument("--config", type=Path, required=True)
    begin = sub.add_parser(
        "pair-start", help="register a device with an owner pairing code"
    )
    begin.add_argument("--server-url", required=True)
    begin.add_argument("--pairing-code", required=True)
    begin.add_argument("--name", required=True)
    begin.add_argument("--config", type=Path, required=True)
    for name in ("approve", "deny"):
        command = sub.add_parser(name)
        command.add_argument("capability")
        command.add_argument("request_hash")
        command.add_argument("--actor", default="local-user")
    backend = _secret_backend_option()
    secret_set = sub.add_parser(
        "secret-set", parents=[backend], help="store a credential value"
    )
    secret_set.add_argument("name")
    secret_set.add_argument(
        "--value", help="credential value; read from stdin when omitted"
    )
    secret_rotate = sub.add_parser(
        "secret-rotate", parents=[backend], help="replace an existing credential"
    )
    secret_rotate.add_argument("name")
    secret_rotate.add_argument(
        "--value", help="credential value; read from stdin when omitted"
    )
    secret_delete = sub.add_parser(
        "secret-delete", parents=[backend], help="remove a stored credential"
    )
    secret_delete.add_argument("name")
    sub.add_parser(
        "secret-list", parents=[backend], help="list stored secret names (never values)"
    )
    return parser


def _read_secret_value() -> str:
    # Read to EOF so multi-line credentials such as SSH private keys work;
    # interactive users finish with Ctrl-D.
    value = sys.stdin.read().rstrip("\r\n")
    if not value:
        raise ValueError("a credential value must not be empty")
    return value


def _resolve_runtime_credentials(session_token: str, private_key: str) -> tuple[str, str]:
    """Resolve the start-runtime credentials without putting them in argv (05-M8).

    A literal ``-`` reads the value from stdin (to EOF, like secret-set), and
    both arguments fall back to the IDEER_LOCAL_SESSION_TOKEN /
    IDEER_LOCAL_PRIVATE_KEY environment variables. Anything passed as a
    command-line argument is readable by every local user via
    /proc/<pid>/cmdline, so the tray's OS credential store remains the
    recommended path.
    """
    if session_token == "-":
        # Line-based on purpose: both credentials are single-line values and
        # both may be piped in one invocation ("printf '%s\n%s' | ... - -").
        session_token = sys.stdin.readline().strip()
    if private_key == "-":
        private_key = sys.stdin.readline().strip()
    if not session_token or not private_key:
        raise ValueError(
            "start-runtime needs a session token and a base64 Ed25519 private "
            "key; pass '-' to read them from stdin, set "
            "IDEER_LOCAL_SESSION_TOKEN / IDEER_LOCAL_PRIVATE_KEY, or use the "
            "tray path, which keeps them in the OS credential store"
        )
    return session_token, private_key


def _secure_key_value(key: Ed25519PrivateKey) -> str:
    """Encode a device key for the OS credential store without a PEM file."""
    pem = key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    )
    return base64.b64encode(pem).decode("ascii")


def _run_secret_command(args: argparse.Namespace, store: SecretStore | None) -> int:
    try:
        secret_store = store
        if secret_store is None:
            secret_store = (
                InMemorySecretStore()
                if args.backend == "memory"
                else create_default_secret_store()
            )
        if args.command == "secret-set":
            value = args.value if args.value is not None else _read_secret_value()
            secret_store.set(args.name, value)
            print(secret_ref(args.name))
        elif args.command == "secret-rotate":
            secret_store.get(args.name)
            value = args.value if args.value is not None else _read_secret_value()
            secret_store.set(args.name, value)
            print(secret_ref(args.name))
        elif args.command == "secret-delete":
            secret_store.delete(args.name)
        elif args.command == "secret-list":
            for name in secret_store.names():
                print(name)
        return 0
    except SecretStoreError as exc:
        print(f"error: {exc.code}: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"error: INVALID_SECRET: {exc}", file=sys.stderr)
        return 1


def main(argv: list[str] | None = None, *, store: SecretStore | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command in SECRET_COMMANDS:
        return _run_secret_command(args, store)
    if args.command == "tray":
        from .tray import TrayApplication, load_controller

        controller = load_controller(args.config)
        if args.headless:
            print(json.dumps(controller.status().as_dict(), ensure_ascii=False))
            return 0
        controller.start()
        try:
            TrayApplication(controller).run()
        finally:
            controller.stop()
        return 0
    if args.command in {"pair-start", "pair-complete"}:
        from .protocol import public_key_text
        from .settings import RuntimeSettings, load_settings
        from .tray import _load_or_create_key

        key_path = args.config.with_name("runtime-key")
        if args.command == "pair-start":
            key = _load_or_create_key(key_path)
            base = args.server_url.rstrip("/")
            endpoint = (
                f"{base}/devices/register"
                if base.endswith("/api")
                else f"{base}/api/devices/register"
            )
            body = json.dumps(
                {
                    "pairing_code": args.pairing_code,
                    "name": args.name,
                    "public_key": public_key_text(key),
                    "protocol_version": "1",
                    "runtime_version": "0.1.0",
                    "capabilities": ["echo"],
                }
            ).encode("utf-8")
            request = urllib.request.Request(
                endpoint,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    result = json.load(response)
            except Exception as exc:  # noqa: BLE001 - do not expose response bodies
                print(f"pairing failed: {type(exc).__name__}", file=sys.stderr)
                return 1
            try:
                secure = create_default_secret_store()
                claim_ref = f"ideer-device-claim-{result['device']['id']}"
                secure.set(claim_ref, str(result["claim_token"]))
            except SecretStoreError as exc:
                print(f"pairing failed: {exc.code}", file=sys.stderr)
                return 1
            settings = RuntimeSettings(
                server_url=args.server_url,
                device_id=str(result["device"]["id"]),
                device_name=args.name,
                claim_token_ref=claim_ref,
                # The register response distributes the broker public key over
                # the pairing channel; bind it before any ws:// connection.
                server_public_key=str(result.get("server_public_key", "")),
                config_path=str(args.config),
            )
            key_ref = f"ideer-device-key-{settings.device_id}"
            try:
                secure.set(key_ref, _secure_key_value(key))
                key_path.unlink(missing_ok=True)
                settings.device_key_ref = key_ref
            except (SecretStoreError, OSError) as exc:
                print(f"pairing failed: {type(exc).__name__}", file=sys.stderr)
                return 1
            settings.save(args.config)
            print(
                json.dumps(
                    {
                        "pairing_id": result["pairing_id"],
                        "device_id": settings.device_id,
                        "claim_expires_at": result["claim_expires_at"],
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        settings = load_settings(args.config)
        try:
            secure = create_default_secret_store()
        except SecretStoreError as exc:
            print(f"pairing failed: {exc.code}", file=sys.stderr)
            return 1
        key_ref = settings.device_key_ref or f"ideer-device-key-{args.device_id}"
        key = _load_or_create_key(key_path, secure_store=secure, key_ref=key_ref)
        claim_token = args.claim_token
        if not claim_token and settings.claim_token_ref:
            try:
                claim_token = secure.get(settings.claim_token_ref)
            except SecretStoreError as exc:
                print(f"pairing failed: {exc.code}", file=sys.stderr)
                return 1
        if not claim_token:
            print("pairing failed: claim token is required", file=sys.stderr)
            return 1
        base = args.server_url.rstrip("/")
        endpoint = (
            f"{base}/devices/register/complete"
            if base.endswith("/api")
            else f"{base}/api/devices/register/complete"
        )
        body = json.dumps(
            {
                "device_id": args.device_id,
                "public_key": public_key_text(key),
                "claim_token": claim_token,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.load(response)
        except Exception as exc:  # noqa: BLE001 - do not expose response bodies
            print(f"pairing failed: {type(exc).__name__}", file=sys.stderr)
            return 1
        device = result.get("device", {})
        token = str(result.get("session_token", ""))
        # Keep the key captured at pair_start unless the complete response
        # distributes one; the pinned key must survive this rebuild of the
        # settings object.
        previous_broker_key = settings.server_public_key
        try:
            token_ref = f"ideer-device-session-{args.device_id}"
            secure.set(token_ref, token)
        except SecretStoreError as exc:
            print(f"pairing failed: {exc.code}", file=sys.stderr)
            return 1
        settings = RuntimeSettings(
            server_url=args.server_url,
            device_id=str(device.get("id", args.device_id)),
            session_id=str(result.get("session_id", "")),
            session_token_ref=token_ref,
            device_name=str(device.get("name", settings.device_name)),
            runtime_version=str(device.get("runtime_version", "0.1.0")),
            device_key_ref=key_ref,
            server_public_key=(
                str(result.get("server_public_key", "")) or previous_broker_key
            ),
            config_path=str(args.config),
        )
        settings.save(args.config)
        print(args.config)
        return 0
    args.db.parent.mkdir(parents=True, exist_ok=True)
    consent_store = ConsentStore(db_path=args.db)
    if args.command == "config-root":
        config_path = args.db.with_suffix(".json")
        config_path.write_text(
            json.dumps({"logical_root": str(args.path.resolve())}, indent=2) + "\n"
        )
        print(config_path)
        return 0
    if args.command == "set-policy":
        config_path = args.db.with_suffix(".json")
        current = json.loads(config_path.read_text()) if config_path.exists() else {}
        current.setdefault("policy", {})[args.capability] = args.decision
        config_path.write_text(json.dumps(current, indent=2) + "\n")
        return 0
    if args.command == "start-runtime":
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        from .mcp import LocalMCPService, MCPSupervisor, load_mcp_specs
        from .transport import LocalRuntimeClient

        try:
            session_token, private_key_text = _resolve_runtime_credentials(
                args.session_token, args.private_key
            )
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(private_key_text))
        mcp_service = None
        supervisor = None
        if args.mcp_config is not None:
            secret_store = (
                InMemorySecretStore()
                if args.backend == "memory"
                else create_default_secret_store()
            )

            def resolve_secret(name: str) -> str | None:
                try:
                    return secret_store.get(name)
                except SecretStoreError:
                    return None

            supervisor = MCPSupervisor(
                load_mcp_specs(args.mcp_config),
                secret_resolver=resolve_secret,
            )
            mcp_service = LocalMCPService(supervisor)

        client = LocalRuntimeClient(
            server_url=args.server_url,
            device_id=args.device_id,
            session_token=session_token,
            private_key=key,
            mcp_service=mcp_service,
        )

        async def run_runtime() -> None:
            if supervisor is not None:
                await supervisor.start_all()
            try:
                await client.run()
            finally:
                if supervisor is not None:
                    await supervisor.stop_all()

        asyncio.run(run_runtime())
        return 0
    if args.command in {"approve", "deny"}:
        getattr(consent_store, args.command)(
            args.capability, args.request_hash, actor_id=args.actor
        )
        return 0
    import sqlite3

    with sqlite3.connect(args.db) as db:
        if args.command == "list-pending":
            for row in db.execute(
                "SELECT capability, request_hash, payload FROM pending_consents ORDER BY rowid"
            ):
                print(
                    json.dumps(
                        {
                            "capability": row[0],
                            "request_hash": row[1],
                            "payload": json.loads(row[2]),
                        },
                        ensure_ascii=False,
                    )
                )
            return 0
        for row in db.execute(
            "SELECT capability, request_hash, decision, actor_id, decided_at FROM consent_audit ORDER BY rowid"
        ):
            print(
                json.dumps(
                    dict(
                        zip(
                            (
                                "capability",
                                "request_hash",
                                "decision",
                                "actor_id",
                                "decided_at",
                            ),
                            row,
                        )
                    ),
                    ensure_ascii=False,
                )
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
