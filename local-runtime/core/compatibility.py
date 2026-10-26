"""Controlled, signed combination declarations for device-side admission."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import threading
import urllib.error
import urllib.request

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .browser_login import _NoRedirect, platform_origin
from .receipt_ledger import profile_binding
from .settings import load_settings

MAX_BYTES = 512 * 1024
LEVELS = {'compatible', 'capability', 'core'}


def release_public_key_path():
    runtime = Path(sys.executable).resolve().parent
    installed = runtime.parent / 'updates' / 'updates-public-key.pem'
    return installed if installed.is_file() else runtime.parent / 'resources' / 'updates' / 'updates-public-key.pem'


class CompatibilityGate:
    """One current identity and actual combination; only restricts execution."""

    def __init__(self, config, *, desktop_version, runtime_python, public_key_path=None):
        self.config = Path(config)
        self.desktop_version, self.runtime_python = desktop_version, runtime_python
        self.public_key_path = Path(public_key_path) if public_key_path else release_public_key_path()
        self._lock = threading.RLock()
        self._binding = None
        self.server_version = ''
        self._view = {}
        self.bind()

    def bind(self):
        with self._lock:
            binding = profile_binding(load_settings(self.config))
            if binding != self._binding:
                self._binding, self.server_version = binding, ''
                self._view = self._core('COMPAT_WAITING_FOR_SERVER')

    def set_server_version(self, version, binding=None):
        with self._lock:
            if binding is not None and binding != self._binding:
                return
            self.server_version = version if isinstance(version, str) and len(version) <= 128 else ''

    def _actual(self):
        return dict(desktop=self.desktop_version, runtime=self.runtime_python, server=self.server_version)

    def _core(self, error):
        return dict(level='core', disabledCapabilities=[], notes='', error=error,
            advice='核心兼容状态不可用，已停止新的本地任务。历史和未确认执行记录保留。请核对 Server 或升级组合。',
            candidateCombo=self._actual(), actualCombo=self._actual(), declarationHash='')

    def snapshot(self):
        with self._lock:
            settings = load_settings(self.config)
            if self._binding is None or settings.signed_out or profile_binding(settings) != self._binding:
                return self._core('COMPAT_IDENTITY_CHANGED')
            return dict(self._view)

    def _fetch(self, origin, suffix):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        with opener.open(origin + '/updates/' + suffix, timeout=10) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError('COMPAT_MANIFEST_TOO_LARGE')
        return raw

    @staticmethod
    def _level(row):
        level, disabled = row.get('level'), row.get('disabledCapabilities')
        if (level not in LEVELS or not isinstance(disabled, list) or len(disabled) > 128
                or any(not isinstance(cap, str) or not 1 <= len(cap) <= 128 for cap in disabled)
                or len(set(disabled)) != len(disabled) or (level != 'capability' and disabled)):
            raise ValueError('COMPAT_MANIFEST_MALFORMED')
        return level, disabled

    @staticmethod
    def _combo(row):
        if (not isinstance(row, dict) or any(not isinstance(row.get(key), str)
                or not 1 <= len(row[key]) <= 128 for key in ('desktop', 'runtime', 'server'))):
            raise ValueError('COMPAT_MANIFEST_MALFORMED')
        return {key: row[key] for key in ('desktop', 'runtime', 'server')}

    def refresh(self):
        with self._lock:
            settings = load_settings(self.config)
            if self._binding is None or settings.signed_out or profile_binding(settings) != self._binding:
                self._view = self._core('COMPAT_IDENTITY_CHANGED')
                return self.snapshot()
            try:
                origin = platform_origin(settings.server_url)
            except ValueError:
                self._view = self._core('COMPAT_IDENTITY_CHANGED')
                return self.snapshot()
            scope = hashlib.sha256(json.dumps(self._binding, sort_keys=True).encode()).hexdigest()
            cache = self.config.parent / 'compatibility' / (scope + '.json')
            seen = cache.exists()
            try:
                try:
                    raw = self._fetch(origin, 'compatibility.json')
                except urllib.error.HTTPError as error:
                    code = error.code
                    error.close()
                    if code != 404:
                        raise ValueError('COMPAT_SERVER_UNAVAILABLE') from None
                    if seen:
                        raise ValueError('COMPAT_DECLARATION_MISSING') from None
                    self._view = dict(level='compatible', disabledCapabilities=[], error='',
                        notes='未发布兼容声明，仅保留已支持的旧协议 1 行为。',
                        advice='旧协议 1 兼容。权限仍由 Server 与本地策略决定。',
                        candidateCombo=self._actual(), actualCombo=self._actual(), declarationHash='', legacy=True)
                    return self.snapshot()
                signature = self._fetch(origin, 'compatibility.sig').decode('ascii').strip()
                if len(signature) != 128 or any(c not in '0123456789abcdefABCDEF' for c in signature):
                    raise ValueError('COMPAT_SIGNATURE_INVALID')
                key = load_pem_public_key(self.public_key_path.read_bytes())
                if not isinstance(key, Ed25519PublicKey):
                    raise ValueError('COMPAT_SIGNATURE_INVALID')
                key.verify(bytes.fromhex(signature), raw)
                declaration = json.loads(raw)
                if not isinstance(declaration, dict) or declaration.get('version') != 1:
                    raise ValueError('COMPAT_MANIFEST_VERSION_UNSUPPORTED')
                level, disabled = self._level(declaration)
                candidate = self._combo(declaration.get('candidateCombo'))
                if type(declaration.get('minProtocol')) is not int or declaration['minProtocol'] < 1:
                    raise ValueError('COMPAT_MANIFEST_MALFORMED')
                notes = declaration.get('notes')
                if not isinstance(notes, str) or len(notes) > 2000:
                    raise ValueError('COMPAT_MANIFEST_MALFORMED')
                rows = declaration.get('supportedCombos', [])
                if not isinstance(rows, list) or len(rows) > 100:
                    raise ValueError('COMPAT_MANIFEST_MALFORMED')
                selected = (level, disabled) if candidate == self._actual() else None
                combos = [candidate]
                for row in rows:
                    combo = self._combo(row)
                    if combo in combos:
                        raise ValueError('COMPAT_MANIFEST_MALFORMED')
                    combos.append(combo)
                    choice = self._level({'level': row.get('level', level),
                        'disabledCapabilities': row.get('disabledCapabilities', disabled)})
                    if combo == self._actual():
                        selected = choice
                # Remember having seen a valid signed declaration before any
                # unsupported-combination/protocol refusal. Removing the HTTP
                # files later, including across restart, cannot restore legacy.
                try:
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    temporary = cache.with_suffix('.tmp')
                    temporary.write_text(json.dumps({'text': raw.decode('utf-8'), 'signature': signature,
                        'actualCombo': self._actual()}), encoding='utf-8')
                    temporary.replace(cache)
                except OSError:
                    raise ValueError('COMPAT_STORAGE_UNAVAILABLE') from None
                if declaration['minProtocol'] > 1:
                    raise ValueError('COMPAT_PROTOCOL_INCOMPATIBLE')
                if selected is None:
                    raise ValueError('COMPAT_COMBINATION_UNSUPPORTED')
                level, disabled = selected
                self._view = dict(level=level, disabledCapabilities=disabled, notes=notes, error='',
                    advice=('组合兼容。权限仍由 Server 与本地策略决定。' if level == 'compatible' else
                        '单项能力已停用，其余能力继续使用。' if level == 'capability' else
                        '核心通信或安全不兼容，已停止新的本地任务。历史与未确认执行记录保留，请升级组合。'),
                    candidateCombo=candidate, actualCombo=self._actual(),
                    declarationHash=hashlib.sha256(raw).hexdigest())
            except InvalidSignature:
                self._view = self._core('COMPAT_SIGNATURE_INVALID')
            except (OSError, ValueError, TypeError, KeyError, UnsupportedAlgorithm) as error:
                code = str(error) if isinstance(error, ValueError) and str(error).startswith('COMPAT_') else 'COMPAT_DECLARATION_UNAVAILABLE'
                self._view = self._core(code)
            return self.snapshot()

    def authorize(self, operation):
        view = self.refresh()
        if view['level'] == 'core':
            return view['error'] or 'COMPAT_CORE_INCOMPATIBLE'
        if operation in view['disabledCapabilities']:
            return 'COMPAT_CAPABILITY_DISABLED'
        return ''
