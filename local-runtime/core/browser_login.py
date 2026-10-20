"""Browser approval and one-use completion; secrets remain in the Runtime."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .protocol import public_key_text
from .secrets import SecretStore, SecretStoreError
from .settings import load_settings


def platform_origin(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in {"https", "http"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in {"", "/"}
            or (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"})):
        raise ValueError("LOGIN_ORIGIN_INVALID")
    _ = parsed.port
    return f"{parsed.scheme}://{parsed.netloc}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("LOGIN_REDIRECT_REJECTED")


class BrowserLogin:
    """Only redacted status and a short-lived browser URL cross stdio."""

    def __init__(self, config: Path, secure: SecretStore):
        self.config = config
        self.secure = secure
        self._status = {"state": "unauthenticated", "account": "", "device": "", "error": ""}
        self._pending = None
        self._expires_at = None

    def restore(self) -> None:
        settings = load_settings(self.config)
        if not settings.business_token_ref:
            return
        if (not settings.business_expires_at or datetime.fromisoformat(settings.business_expires_at)
                <= datetime.now(timezone.utc)):
            self.fail("LOGIN_EXPIRED")
            self._status["state"] = "expired"
            return
        self._expires_at = datetime.fromisoformat(settings.business_expires_at)
        origin = platform_origin(settings.server_url)
        token = self.secure.get(settings.business_token_ref)
        request = urllib.request.Request(origin + "/api/v1/auth/me", headers={"Cookie": "access_token=" + token})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        with opener.open(request, timeout=10) as response:
            account = json.loads(response.read(65537))
        if account.get("id") != settings.user_id:
            raise ValueError("LOGIN_OWNER_MISMATCH")
        self._status = {"state": "authenticated", "account": str(account["email"])[:256],
                        "device": settings.device_name, "error": ""}

    def status(self) -> dict:
        if self._status["state"] == "authenticated" and self._expires_at and datetime.now(timezone.utc) >= self._expires_at:
            self.fail("LOGIN_EXPIRED")
            self._status["state"] = "expired"
        return dict(self._status)

    def begin(self, origin: str, name: str) -> str:
        origin = platform_origin(origin)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 255:
            raise ValueError("LOGIN_DEVICE_NAME_INVALID")
        if self._pending is not None:
            raise ValueError("LOGIN_IN_PROGRESS")
        settings = load_settings(self.config)
        if settings.device_id:
            key = serialization.load_pem_private_key(base64.b64decode(self.secure.get(settings.device_key_ref)), password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError("DEVICE_KEY_INVALID")
            name = settings.device_name
        else:
            key = Ed25519PrivateKey.generate()
        initiator = secrets.token_urlsafe(32)
        public_key = public_key_text(key)
        if settings.device_id and platform_origin(settings.server_url) != origin:
            raise ValueError("LOGIN_ORIGIN_INVALID")
        result = self._post(origin + "/api/devices/login/start", {
            "initiator_secret": initiator, "public_key": public_key, "name": name.strip(),
            "existing_device_id": settings.device_id or None,
        })
        login_id = result["login_id"]
        if not isinstance(login_id, str) or not login_id or len(login_id) > 64 or not all(c.isalnum() or c == '-' for c in login_id):
            raise ValueError("LOGIN_RESPONSE_INVALID")
        self._pending = (origin, login_id, initiator, key, time.monotonic() + 300)
        self._status = {"state": "awaiting-confirmation", "account": "", "device": name.strip(), "error": "",
                        "verification": hashlib.sha256(public_key.encode()).hexdigest()[:12]}
        return origin + "/desktop-login?login_id=" + urllib.parse.quote(login_id)

    def fail(self, code: str) -> None:
        self._pending = None
        self._status = {"state": "error", "account": "", "device": "", "error": code}

    def poll(self) -> bool:
        if self._pending is None:
            return False
        origin, login_id, initiator, key, deadline = self._pending
        if time.monotonic() >= deadline:
            self.fail("LOGIN_EXPIRED")
            return False
        result = self._post(origin + f"/api/devices/login/{login_id}/complete", {
            "initiator_secret": initiator, "public_key": public_key_text(key),
            "device_proof": base64.b64encode(key.sign(f"desktop-login\n{login_id}\n{initiator}".encode())).decode(),
        })
        if result.get("state") == "pending":
            return False
        device, account = result["device"], result["account"]
        if device["owner_id"] != account["id"]:
            raise ValueError("LOGIN_OWNER_MISMATCH")
        settings = load_settings(self.config)
        if settings.device_id and (settings.device_id != device["id"] or (settings.user_id and settings.user_id != account["id"])):
            raise ValueError("LOGIN_OWNER_MISMATCH")
        old_references = [settings.device_key_ref, settings.session_token_ref, settings.business_token_ref]
        prefix = "desktop-" + secrets.token_hex(16)
        credentials = {
            prefix + "-device-key": base64.b64encode(key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption())).decode(),
            prefix + "-device-session": result["session_token"],
            prefix + "-business-session": result["business_token"],
        }
        stored = []
        try:
            for reference, value in credentials.items():
                self.secure.set(reference, value)
                stored.append(reference)
            settings.server_url = origin
            settings.device_id = device["id"]
            settings.device_name = device["name"]
            settings.user_name = account["name"]
            settings.user_id = account["id"]
            settings.device_public_key = public_key_text(key)
            settings.device_key_ref = prefix + "-device-key"
            settings.session_token_ref = prefix + "-device-session"
            settings.business_token_ref = prefix + "-business-session"
            settings.session_id = result["session_id"]
            settings.server_public_key = result["server_public_key"]
            settings.business_expires_at = result.get("business_expires_at", "")
            settings.save(self.config)
        except BaseException:
            for reference in stored:
                try:
                    self.secure.delete(reference)
                except SecretStoreError:
                    pass
            self.fail("SECURE_STORAGE_FAILED")
            raise
        # A committed profile owns the new references; retire the prior ones.
        for reference in old_references:
            if reference and reference not in credentials:
                try:
                    self.secure.delete(reference)
                except SecretStoreError:
                    pass
        self._pending = None
        self._expires_at = datetime.fromisoformat(settings.business_expires_at) if settings.business_expires_at else None
        self._status = {"state": "authenticated", "account": settings.user_name[:256],
                        "device": settings.device_name, "error": ""}
        return True

    @staticmethod
    def _post(url: str, body: dict) -> dict:
        request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            with opener.open(request, timeout=10) as response:
                value = json.loads(response.read(65537))
        except urllib.error.HTTPError as exc:
            codes = {401: "LOGIN_BINDING_INVALID", 403: "LOGIN_OWNER_MISMATCH", 409: "LOGIN_ALREADY_USED", 410: "LOGIN_EXPIRED"}
            raise ValueError(codes.get(exc.code, "LOGIN_FAILED")) from None
        if not isinstance(value, dict):
            raise ValueError("LOGIN_RESPONSE_INVALID")
        return value
