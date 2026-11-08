"""Legacy linz workspace scan and migration facts (#118).

The wizard is a one-time aid (GLOSSARY 迁移向导): the scan lists the old
linz install's workspaces read-only, and the migrate composes the two
existing primitives — one platform project create (#91) plus one device-
local folder binding (#92) — for a workspace the user explicitly confirmed
in the trusted main process. Nothing is claimed silently: a workspace id
that no scan of the legacy root can back is refused before any platform
round-trip (未确认项不迁移), and a workspace already migrated refuses a
second project (一次性辅助流程).

The never-migrate list (旧聊天/模型密钥/批准记忆/执行状态) is structural:
the scan whitelists exactly the roster's workspace fields and stats the
per-workspace database files without ever opening them, so the legacy
config's keys, remembered approvals and tool permissions, and the chat
databases' contents, never cross this surface. Nothing under the legacy
root is ever written.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

MAX_TEXT = 1024
MAX_NAME = 128
MAX_WORKSPACES = 50
LEGACY_CONFIG_NAME = 'aeromind-config.json'
LEGACY_WORKSPACES_DIR = 'workspaces'
# The per-workspace database trio linz writes into workspaces/<id>/; the
# scan stats each file for evidence and never opens a single byte of them.
LEGACY_EVIDENCE_FILES = (('data', 'data.db'), ('kb', 'kb.db'), ('tables', 'tables.db'))
CONFIG_UNREADABLE = 'MIGRATION_CONFIG_UNREADABLE'


def _safe_workspace_id(workspace_id: str) -> bool:
    """A roster id is joined into workspaces/<id>/ for the evidence stats, so
    a foreign config.json may never smuggle separators or dot segments into
    that path — anything but a plain folder name lists as nothing."""
    return (0 < len(workspace_id) <= MAX_NAME
            and not any(sep in workspace_id for sep in ('/', '\\'))
            and workspace_id not in ('.', '..'))


class WorkspaceMigrationError(RuntimeError):
    """Only fixed categories cross the Desktop boundary."""


def legacy_linz_root() -> Path:
    """The old linz install's userData root, where electron-store puts the
    roster and the per-workspace databases live (reference linz layout)."""
    if os.name == 'nt':
        return Path(os.environ.get('APPDATA', '')) / 'linz'
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'linz'
    return Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'linz'


def _bounded_text(value, limit: int) -> str:
    return value if isinstance(value, str) and len(value) <= limit else ''


def _read_roster(config_path: Path) -> tuple[list[dict[str, Any]], str]:
    """Whitelist read of the roster: only the workspace fields come back,
    so the config's keys, approvals and tool policy stay structurally
    unread — an absent or broken file is an honest, listed condition."""
    try:
        raw = json.loads(config_path.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeError):
        return [], CONFIG_UNREADABLE
    if not isinstance(raw, dict):
        return [], CONFIG_UNREADABLE
    workspaces = raw.get('workspaces')
    if not isinstance(workspaces, dict):
        return [], ''
    roster = workspaces.get('list')
    if not isinstance(roster, list):
        return [], ''
    rows: list[dict[str, Any]] = []
    for entry in roster:
        if not isinstance(entry, dict):
            continue
        workspace_id = _bounded_text(entry.get('id'), MAX_NAME)
        if not workspace_id or not _safe_workspace_id(workspace_id):
            continue
        rows.append({
            'id': workspace_id,
            'name': _bounded_text(entry.get('name'), MAX_NAME),
            'folder': _bounded_text(entry.get('folder'), MAX_TEXT),
            'current': workspaces.get('current') == workspace_id,
            'createdAt': _bounded_text(entry.get('createdAt'), 64),
            'lastOpenedAt': _bounded_text(entry.get('lastOpenedAt'), 64),
        })
    return rows, ''


def scan_legacy_workspaces(root: Path | None) -> dict[str, Any]:
    """One read-only listing of the legacy install. The roster is the
    workspace list; workspace folders on disk without a roster entry still
    list (名册缺失), because the wizard never silently drops a workspace.
    A roster beyond the display cap is an announced truncation, never a
    silent drop; an absent root is an honest empty listing."""
    scan: dict[str, Any] = {'root': str(root)[:512] if root is not None else '',
                            'workspaces': [], 'configError': '', 'truncated': False}
    if root is None or not Path(root).is_dir():
        return scan
    root = Path(root)
    roster, scan['configError'] = _read_roster(root / LEGACY_CONFIG_NAME)
    seen: set[str] = set()

    def evidence(workspace_id: str) -> dict[str, dict[str, Any]]:
        folder = root / LEGACY_WORKSPACES_DIR / workspace_id
        files: dict[str, dict[str, Any]] = {}
        for key, filename in LEGACY_EVIDENCE_FILES:
            try:
                stat = (folder / filename).stat()
                files[key] = {'present': True, 'size': stat.st_size}
            except OSError:
                files[key] = {'present': False, 'size': 0}
        return files

    if len(roster) > MAX_WORKSPACES:
        scan['truncated'] = True
    for row in roster[:MAX_WORKSPACES]:
        seen.add(row['id'])
        scan['workspaces'].append({**row, 'orphan': False, 'files': evidence(row['id'])})
    orphans_dir = root / LEGACY_WORKSPACES_DIR
    if orphans_dir.is_dir():
        try:
            children = sorted(child.name for child in orphans_dir.iterdir() if child.is_dir())
        except OSError:
            children = []
        for name in children:
            if name in seen or not _safe_workspace_id(name):
                continue
            if len(scan['workspaces']) >= MAX_WORKSPACES:
                scan['truncated'] = True
                break
            scan['workspaces'].append({'id': name, 'name': '', 'folder': '', 'current': False,
                                       'createdAt': '', 'lastOpenedAt': '', 'orphan': True,
                                       'files': evidence(name)})
    return scan


class WorkspaceMigrationLedger:
    """Device-local rows about this identity's own migration attempts.

    Like every device registry, rows carry the whole profile binding so
    another account or machine reads an empty view; a row is one attempt's
    outcome — failed rows keep their fixed error category and a created
    project id, so a retry can finish without duplicating the project.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ''
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS workspace_migrations (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL DEFAULT '',
                    project_id TEXT NOT NULL DEFAULT '', project_name TEXT NOT NULL DEFAULT '',
                    folder TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        except (sqlite3.Error, OSError):
            self._error = 'MIGRATION_STORAGE_UNAVAILABLE'

    @property
    def error(self) -> str:
        return self._error

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, uri=self.path.startswith('file:'))
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            with db:
                yield db
        finally:
            db.close()

    def _execute(self, operation):
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                self._error = ''
                return result
            except (sqlite3.Error, OSError) as exc:
                self._error = 'MIGRATION_STORAGE_UNAVAILABLE'
                raise WorkspaceMigrationError(self._error) from exc

    @staticmethod
    def _identity(binding, workspace_id: str) -> str:
        return hashlib.sha256(json.dumps(
            [json.dumps(binding, sort_keys=True), workspace_id], sort_keys=True).encode()).hexdigest()

    def record(self, binding, workspace_id: str, workspace_name: str, project_id: str,
               project_name: str, folder: str, status: str, error_code: str) -> None:
        """Record or replace this identity's attempt for one workspace (重试)."""
        fields = (workspace_name, project_id, project_name, folder, status, error_code)
        if (not isinstance(workspace_id, str) or not 0 < len(workspace_id) <= MAX_NAME
                or any(not isinstance(value, str) or len(value) > MAX_TEXT for value in fields)
                or status not in ('migrated', 'failed')):
            raise WorkspaceMigrationError('MIGRATION_OVERFLOW')

        def write(db):
            db.execute(
                "INSERT INTO workspace_migrations (identity, binding, workspace_id, workspace_name,"
                " project_id, project_name, folder, status, error_code)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(identity) DO UPDATE SET workspace_name=excluded.workspace_name,"
                " project_id=excluded.project_id, project_name=excluded.project_name,"
                " folder=excluded.folder, status=excluded.status, error_code=excluded.error_code,"
                " updated_at=CURRENT_TIMESTAMP",
                (self._identity(binding, workspace_id), json.dumps(binding, sort_keys=True),
                 workspace_id, workspace_name, project_id, project_name, folder, status, error_code))

        self._execute(write)

    def find(self, binding, workspace_id: str) -> dict[str, Any] | None:
        def read(db):
            row = db.execute('SELECT * FROM workspace_migrations WHERE identity=?',
                             (self._identity(binding, workspace_id),)).fetchone()
            return self._view(row) if row is not None else None

        return self._execute(read)

    @staticmethod
    def _view(row) -> dict[str, Any]:
        return {'workspaceId': row['workspace_id'], 'workspaceName': row['workspace_name'],
                'projectId': row['project_id'], 'projectName': row['project_name'],
                'folder': row['folder'], 'status': row['status'], 'errorCode': row['error_code'],
                'createdAt': row['created_at'], 'updatedAt': row['updated_at']}

    def view(self, binding) -> list[dict[str, Any]]:
        def read(db):
            return [self._view(row) for row in db.execute(
                'SELECT * FROM workspace_migrations WHERE binding=? ORDER BY updated_at DESC, workspace_id',
                (json.dumps(binding, sort_keys=True),))]

        return self._execute(read)


def migration_manage(command, *, root: Path | None, chat, owner, ledger: WorkspaceMigrationLedger | None):
    """The wizard's two actions: `scan` is the read-only listing; `migrate`
    carries one confirmed workspace with its project name and the confirmed
    folder (empty = 不绑定), composes create+bind, and records an honest,
    retryable ledger row either way."""
    if not isinstance(command, dict) or not isinstance(command.get('action'), str):
        raise WorkspaceMigrationError('MIGRATION_COMMAND_INVALID')
    if command['action'] == 'scan':
        if set(command) != {'type', 'id', 'action', 'scope'}:
            raise WorkspaceMigrationError('MIGRATION_COMMAND_INVALID')
        return scan_legacy_workspaces(Path(root) if root is not None else Path())
    if command['action'] != 'migrate' or owner is None or ledger is None:
        raise WorkspaceMigrationError('MIGRATION_COMMAND_INVALID' if command['action'] != 'migrate'
                                      else 'MIGRATION_UNAUTHENTICATED')
    if set(command) != {'type', 'id', 'action', 'scope', 'workspaceId', 'name', 'folder'}:
        raise WorkspaceMigrationError('MIGRATION_COMMAND_INVALID')
    workspace_id = command['workspaceId']
    name = command['name'].strip() if isinstance(command.get('name'), str) else ''
    folder = command['folder']
    if (not isinstance(workspace_id, str) or not 0 < len(workspace_id) <= MAX_NAME
            or not isinstance(name, str) or not 0 < len(name) <= MAX_NAME
            or not isinstance(folder, str) or len(folder) > MAX_TEXT
            or (folder and not os.path.isabs(folder))):
        raise WorkspaceMigrationError('MIGRATION_COMMAND_INVALID')

    # The confirmation seam: only a workspace this very scan can back is
    # migratable, so a stale or invented id never reaches the platform.
    workspace = next((row for row in scan_legacy_workspaces(Path(root))['workspaces']
                      if row['id'] == workspace_id), None) if root is not None else None
    if workspace is None:
        raise WorkspaceMigrationError('MIGRATION_WORKSPACE_UNKNOWN')
    prior = ledger.find(owner, workspace_id)
    if prior is not None and prior['status'] == 'migrated':
        raise WorkspaceMigrationError('MIGRATION_ALREADY_MIGRATED')

    def record(status, project_id, error_code):
        ledger.record(owner, workspace_id, workspace['name'], project_id, name, folder, status, error_code)
        return ledger.view(owner)

    def failed_step(step, project_id):
        try:
            step()
        except Exception as exc:
            # Only fixed categories cross the Desktop boundary; a server
            # detail never leaks paths or content.
            message = str(exc)
            code = message if message.startswith('CHAT_') else 'MIGRATION_FAILED'
            return {'migrated': False, 'workspaceId': workspace_id, 'projectId': project_id,
                    'errorCode': code, 'ledger': record('failed', project_id, code)}
        return None

    project_id = prior['projectId'] if prior is not None else ''
    if not project_id:
        def create():
            nonlocal project_id
            created = chat.projects_manage({'type': 'projects', 'id': command['id'],
                                            'action': 'create', 'scope': command['scope'], 'name': name})
            project_id = created.get('createdId') or ''
            if not project_id:
                raise WorkspaceMigrationError('MIGRATION_FAILED')
        outcome = failed_step(create, '')
        if outcome is not None:
            return outcome
    if folder:
        outcome = failed_step(lambda: chat.projects_manage(
            {'type': 'projects', 'id': command['id'], 'action': 'bind-folder',
             'scope': command['scope'], 'projectId': project_id, 'path': folder}), project_id)
        if outcome is not None:
            return outcome
    return {'migrated': True, 'workspaceId': workspace_id, 'projectId': project_id, 'errorCode': '',
            'ledger': record('migrated', project_id, '')}
