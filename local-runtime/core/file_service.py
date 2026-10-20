"""Policy-gated local file task handlers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .consent import ConsentStore, request_hash
from .files import LocalFileStore
from .policy import LocalPolicy, PolicyDecision


@dataclass(frozen=True)
class FileTaskResult:
    decision: PolicyDecision
    value: Any = None


class LocalFileService:
    def __init__(
        self,
        files: LocalFileStore,
        *,
        policy: LocalPolicy | None = None,
        consent: ConsentStore | None = None,
    ) -> None:
        self.files = files
        self.policy = policy or LocalPolicy()
        self.consent = consent or ConsentStore()

    def execute(
        self, capability: str, payload: dict[str, Any], *, consent: bool = False
    ) -> FileTaskResult:
        if capability not in {"local.files.list", "local.files.read", "local.files.write"}:
            raise ValueError("unsupported local file capability")
        digest = request_hash(payload)
        decision = self.policy.authorize(
            capability,
            payload,
            consent=consent or self.consent.consume(capability, digest),
        )
        if decision is not PolicyDecision.ALLOW:
            return FileTaskResult(decision)
        if capability == "local.files.list":
            return FileTaskResult(decision, self.files.list(str(payload["path"])))
        if capability == "local.files.read":
            return FileTaskResult(decision, self.files.read(str(payload["path"])))
        if capability == "local.files.write":
            self.files.write(str(payload["path"]), str(payload["content"]))
            return FileTaskResult(decision, {"written": True})

# Desktop workspaces deliberately do not reuse legacy configured file roots.
READ_CAPABILITIES = ('local.files.list', 'local.files.read', 'local.files.search')
MAX_TEXT_BYTES = 65536
MAX_ENTRIES = 500
MAX_SEARCH_FILES = 500
MAX_MATCHES = 100


class WorkspaceSelection:
    """Persistent local grant for one account/device and one directory generation."""
    def __init__(self, config):
        from pathlib import Path
        from .settings import _SAVE_LOCK
        self.config = Path(config)
        self.lock = _SAVE_LOCK

    @staticmethod
    def _binding(settings):
        return [settings.server_url.rstrip('/'), settings.user_id, settings.device_id,
                settings.device_public_key, settings.server_public_key]

    def scope(self):
        import hashlib
        import json
        from .settings import load_settings
        settings = load_settings(self.config)
        return hashlib.sha256(json.dumps(self._binding(settings)).encode()).hexdigest()

    def current(self):
        from .settings import load_settings
        from .files import FileAccessError
        settings = load_settings(self.config)
        from datetime import datetime, timezone
        if settings.business_expires_at and datetime.fromisoformat(settings.business_expires_at) <= datetime.now(timezone.utc):
            raise FileAccessError('WORKSPACE_UNAVAILABLE')
        grant = settings.workspace
        if (not settings.user_id or not settings.device_id or not grant
                or grant.get('binding') != self._binding(settings)):
            raise FileAccessError('WORKSPACE_UNAVAILABLE')
        return settings, grant

    def status(self):
        with self.lock:
            try:
                _, grant = self.current()
                return {'state': 'ready', 'logicalRoot': grant['logical_root']}
            except Exception:
                return {'state': 'unavailable', 'logicalRoot': ''}

    def select(self, physical_path, *, confirmed=False):
        import uuid
        from .compat import is_junction
        from pathlib import Path
        from .settings import load_settings
        from .files import FileAccessError
        with self.lock:
            settings = load_settings(self.config)
            if not confirmed or not settings.user_id or not settings.device_id:
                raise FileAccessError('WORKSPACE_CONFIRMATION_REQUIRED')
            path = Path(physical_path).absolute()
            # Check every ancestor before resolve, so a selected junction is never
            # silently converted into a grant for its target.
            for component in [*reversed(path.parents), path]:
                if component.is_symlink() or is_junction(component):
                    raise FileAccessError('OUTSIDE_ALLOWED_ROOTS')
            path = path.resolve(strict=True)
            if not path.is_dir() or WorkspaceFileStore.protected(path, selection=True):
                raise FileAccessError('PROTECTED_PATH')
            settings.workspace = {'binding': self._binding(settings),
                'logical_root': '/workspace/' + str(uuid.uuid4()), 'physical_root': str(path),
                'identity': [path.stat().st_dev, path.stat().st_ino]}
            settings.save(self.config)
            return self.status()


class WorkspaceFileStore(LocalFileStore):
    def __init__(self, roots, *, protected_roots=()):
        super().__init__(roots)
        self.protected_roots = protected_roots

    @staticmethod
    def protected(path, *, selection=False):
        import os
        from pathlib import Path
        names = {'.ssh', '.aws', '.azure', '.gnupg', '.codex', '.agents', '.git', 'node_modules'}
        if any(p.casefold() in names for p in path.parts):
            return True
        if path.name.casefold() == '.env' or path.name.casefold().startswith('.env.'):
            return True
        for name in ('SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData'):
            if os.environ.get(name):
                try:
                    path.relative_to(Path(os.environ[name]).resolve())
                    return True
                except ValueError:
                    pass
        return selection and (path == Path(path.anchor) or path == Path.home())

    def list(self, logical_path):
        return self.list_with_limit(logical_path)[0]

    def list_with_limit(self, logical_path):
        from .files import FileAccessError
        entries = super().list(logical_path, max_entries=MAX_ENTRIES + 1)
        visible = []
        for entry in entries:
            try:
                self._resolve(entry)
                visible.append(entry)
            except FileAccessError as exc:
                if exc.code != 'PROTECTED_PATH':
                    raise
        return visible, len(entries) > MAX_ENTRIES

    def _resolve(self, logical_path):
        from .files import FileAccessError
        root, path = super()._resolve(logical_path)
        if any(path == protected or protected in path.parents for protected in self.protected_roots):
            raise FileAccessError('PROTECTED_PATH')
        if self.protected(path):
            raise FileAccessError('PROTECTED_PATH')
        return root, path


class WorkspaceFileService(LocalFileService):
    """Signed task boundary, rechecking the current local grant for every call."""
    capabilities = READ_CAPABILITIES

    def __init__(self, selection, *, available=lambda: True):
        self.available = available
        self.selection = selection
        self.consent = ConsentStore()

    def execute(self, capability, payload, *, consent=False):
        import hashlib
        from pathlib import Path
        from .files import FileAccessError, RootConfig
        with self.selection.lock:
            if capability not in READ_CAPABILITIES:
                return FileTaskResult(PolicyDecision.DENY)
            if not self.available():
                raise FileAccessError('WORKSPACE_UNAVAILABLE')
            settings, grant = self.selection.current()
            decision = settings.policy().authorize(capability, payload)
            if decision is not PolicyDecision.ALLOW:
                return FileTaskResult(decision)
            args = payload.get('arguments', payload.get('args', payload))
            if not isinstance(args, dict) or not isinstance(args.get('path'), str):
                raise FileAccessError('INVALID_PATH')
            path = args['path']
            files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
                identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(self.selection.config.parent,))
            # The profile and audit files are never readable, even when the
            # selected parent is otherwise an ordinary working directory.
            physical = files.resolve(path)
            try:
                physical.relative_to(self.selection.config.parent)
                raise FileAccessError('PROTECTED_PATH')
            except ValueError:
                pass
            if capability == 'local.files.list':
                entries, scan_limited = files.list_with_limit(path)
                value = {'entries': entries[:MAX_ENTRIES], 'truncated': scan_limited or len(entries) > MAX_ENTRIES}
            elif capability == 'local.files.read':
                raw = files.read_bytes(path, max_bytes=MAX_TEXT_BYTES + 1)
                if len(raw) > MAX_TEXT_BYTES:
                    raise FileAccessError('FILE_TOO_LARGE')
                try:
                    text = raw.decode('utf-8')
                    if '\x00' in text:
                        raise UnicodeError()
                except UnicodeError:
                    raise FileAccessError('NOT_UTF8_TEXT') from None
                value = {'content': text, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            else:
                query = args.get('query')
                if not isinstance(query, str) or not 1 <= len(query) <= 256 or '\n' in query:
                    raise FileAccessError('INVALID_QUERY')
                pending, matches, scanned, truncated = [path], [], 0, False
                visited = 0
                while pending:
                    visited += 1
                    if visited > MAX_SEARCH_FILES or len(pending) > MAX_SEARCH_FILES:
                        truncated = True
                        break
                    current = pending.pop()
                    resolved = files.resolve(current)
                    if resolved.is_dir():
                        entries, scan_limited = files.list_with_limit(current)
                        pending.extend(reversed(entries[:MAX_SEARCH_FILES]))
                        truncated |= scan_limited or len(entries) > MAX_SEARCH_FILES
                    elif resolved.is_file():
                        scanned += 1
                        if scanned > MAX_SEARCH_FILES:
                            truncated = True
                            break
                        try:
                            raw = files.read_bytes(current, max_bytes=MAX_TEXT_BYTES + 1)
                            if len(raw) > MAX_TEXT_BYTES or b'\x00' in raw:
                                continue
                            text = raw.decode('utf-8')
                        except UnicodeError:
                            continue
                        for number, line in enumerate(text.splitlines(), 1):
                            if query in line:
                                matches.append({'path': current, 'line': number, 'text': line[:1000]})
                                if len(matches) >= MAX_MATCHES:
                                    truncated = True
                                    break
                        if truncated and len(matches) >= MAX_MATCHES:
                            break
                value = {'matches': matches, 'truncated': truncated, 'filesScanned': min(scanned, MAX_SEARCH_FILES)}
            value['source'] = {'path': path, 'logicalRoot': grant['logical_root'], 'operation': capability}
            return FileTaskResult(decision, value)
