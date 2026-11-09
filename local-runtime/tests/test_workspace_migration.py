"""Legacy linz workspace scan and one-confirmed-workspace migration (#118).

The wizard is a one-time aid: the scan reads the old linz install's roster
and per-workspace file evidence read-only; the migrate composes the two
existing primitives — one platform project create plus one device-local
folder binding — for a workspace the user explicitly confirmed. The seams
under test (agreed with the ticket's acceptance criteria):

- scan: whitelist roster read, file-evidence stat, orphan listing, honest
  empty, and the structural never-migrate guarantee (旧聊天/模型密钥/批准
  记忆/执行状态 never surface — the scan never opens the databases and
  never leaves the whitelist).
- migrate: create+bind composition, unknown-workspace refusal (未确认项
  不迁移), one project per workspace (重复迁移拒绝), honest retryable
  failure rows, and retry-after-created rebind without duplicate projects.
- ledger: device-local rows scoped by the whole profile binding.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from test_platform_projects import make_chat, platform

from core.project_binding import ProjectBindingRegistry
from core.receipt_ledger import profile_binding
from core.workspace_migration import (WorkspaceMigrationError, WorkspaceMigrationLedger,
                                      migration_manage, scan_legacy_workspaces)


def legacy_root(tmp_path: Path) -> Path:
    """A legacy linz install shaped like electron-store leaves it: one
    aeromind-config.json roster plus per-workspace database folders."""
    root = tmp_path / 'linz'
    (root / 'workspaces' / 'ws-a').mkdir(parents=True)
    (root / 'workspaces' / 'ws-a' / 'data.db').write_bytes(b'not-a-real-db-scan-must-not-parse')
    (root / 'workspaces' / 'ws-a' / 'kb.db').write_bytes(b'\x00\x01garbage')
    (root / 'workspaces' / 'ws-a' / 'tables.db').write_bytes(b'\xff' * 11)
    roster = {
        'apiKey': 'sk-secret123', 'apiKeyCipher': 'cipher-abc',
        'modelProvider': 'deepseek', 'modelName': 'deepseek-chat',
        'baseURL': 'https://api.deepseek.com',
        'ollama': {'baseURL': 'http://localhost:11434', 'modelName': 'qwen2.5:7b', 'enabled': False},
        'workspaces': {'current': 'ws-a', 'list': [
            {'id': 'ws-a', 'name': '结构仿真', 'path': '', 'createdAt': '2025-01-01T00:00:00.000Z',
             'lastOpenedAt': '2026-01-05T00:00:00.000Z', 'folder': 'C:/data/结构仿真'},
            {'id': 'ws-b', 'name': '空闲工作区', 'path': '', 'createdAt': '2025-02-01T00:00:00.000Z',
             'lastOpenedAt': '2025-02-02T00:00:00.000Z', 'folder': ''}]},
        'fileWorkspacePath': 'C:/legacy',
        'rememberedApprovals': [{'fingerprint': 'fp-1', 'toolName': 'write_file',
                                 'argsSummary': 'secrets.txt', 'ts': 1}],
        'toolPermissions': {'write_file': 'allow'},
        'protectedPaths': ['C:/secrets'],
    }
    (root / 'aeromind-config.json').write_text(json.dumps(roster, ensure_ascii=False), encoding='utf-8')
    return root


def tree_state(root: Path):
    """Every path, byte and mtime under the legacy root — the read-only proof."""
    return sorted((str(path.relative_to(root)), path.read_bytes(), path.stat().st_mtime_ns)
                  for path in sorted(root.rglob('*')) if path.is_file())


def wire(action, scope, **fields):
    return {'type': 'migration', 'id': 'req-1', 'action': action, 'scope': scope, **fields}


# ---------------------------------------------------------------- scan seam

def test_scan_lists_roster_workspaces_with_file_evidence(tmp_path):
    root = legacy_root(tmp_path)
    scan = scan_legacy_workspaces(root)
    assert scan['configError'] == ''
    assert scan['root'] == str(root)
    assert [row['id'] for row in scan['workspaces']] == ['ws-a', 'ws-b']
    first = scan['workspaces'][0]
    assert first == {'id': 'ws-a', 'name': '结构仿真', 'folder': 'C:/data/结构仿真',
                     'current': True, 'orphan': False,
                     'createdAt': '2025-01-01T00:00:00.000Z',
                     'lastOpenedAt': '2026-01-05T00:00:00.000Z',
                     'files': {'data': {'present': True, 'size': len(b'not-a-real-db-scan-must-not-parse')},
                               'kb': {'present': True, 'size': len(b'\x00\x01garbage')},
                               'tables': {'present': True, 'size': len(b'\xff' * 11)}}}
    # The roster's second workspace has no folder on disk yet — evidence is
    # honest absence, not an invented row.
    assert scan['workspaces'][1]['files'] == {
        key: {'present': False, 'size': 0} for key in ('data', 'kb', 'tables')}


def test_scan_whitelist_never_surfacing_legacy_secrets(tmp_path):
    root = legacy_root(tmp_path)
    scan = scan_legacy_workspaces(root)
    rendered = json.dumps(scan, ensure_ascii=False)
    for secret in ('sk-secret123', 'cipher-abc', 'deepseek', 'qwen2.5', 'fp-1',
                   'write_file', 'secrets.txt', 'rememberedApprovals', 'apiKey',
                   'fileWorkspacePath', 'protectedPaths', 'toolPermissions'):
        assert secret not in rendered


def test_scan_never_opens_or_writes_legacy_databases(tmp_path):
    root = legacy_root(tmp_path)
    before = tree_state(root)
    scan = scan_legacy_workspaces(root)
    # The evidence is a stat, not a parse: the garbage database bytes never
    # get read as SQLite and the whole tree stays byte- and mtime-identical.
    assert scan['workspaces'][0]['files']['data'] == {'present': True, 'size': len(b'not-a-real-db-scan-must-not-parse')}
    assert tree_state(root) == before


def test_scan_honest_empty_when_legacy_root_missing(tmp_path):
    scan = scan_legacy_workspaces(tmp_path / 'no-linz-here')
    assert scan == {'root': str(tmp_path / 'no-linz-here'), 'workspaces': [], 'configError': '',
                    'truncated': False}


def test_scan_announces_truncation_instead_of_silently_dropping(tmp_path):
    root = legacy_root(tmp_path)
    config = json.loads((root / 'aeromind-config.json').read_text(encoding='utf-8'))
    config['workspaces']['list'] = [
        {'id': f'ws-{index:02d}', 'name': f'工作区{index}', 'path': '', 'createdAt': '',
         'lastOpenedAt': '', 'folder': ''} for index in range(60)]
    (root / 'aeromind-config.json').write_text(json.dumps(config, ensure_ascii=False), encoding='utf-8')
    scan = scan_legacy_workspaces(root)
    assert len(scan['workspaces']) == 50
    assert scan['truncated'] is True


def test_scan_refuses_roster_ids_that_could_escape_the_workspaces_folder(tmp_path):
    """A foreign config.json's id is joined into workspaces/<id>/ for the
    evidence stats, so separator or dot-segment ids list as nothing — the
    read-only scan never follows a smuggled path."""
    root = legacy_root(tmp_path)
    config = json.loads((root / 'aeromind-config.json').read_text(encoding='utf-8'))
    config['workspaces']['list'] = [
        {'id': '../escape', 'name': '越界', 'path': '', 'createdAt': '', 'lastOpenedAt': '', 'folder': ''},
        {'id': 'a\\b', 'name': '反斜杠', 'path': '', 'createdAt': '', 'lastOpenedAt': '', 'folder': ''},
        {'id': 'ws-ok', 'name': '正常', 'path': '', 'createdAt': '', 'lastOpenedAt': '', 'folder': ''}]
    (root / 'aeromind-config.json').write_text(json.dumps(config, ensure_ascii=False), encoding='utf-8')
    scan = scan_legacy_workspaces(root)
    assert [row['id'] for row in scan['workspaces'] if not row['orphan']] == ['ws-ok']


def test_scan_lists_orphan_workspace_dirs_without_roster(tmp_path):
    root = legacy_root(tmp_path)
    (root / 'workspaces' / 'ws-orphan').mkdir()
    (root / 'workspaces' / 'ws-orphan' / 'data.db').write_bytes(b'x' * 5)
    scan = scan_legacy_workspaces(root)
    assert [row['id'] for row in scan['workspaces']] == ['ws-a', 'ws-b', 'ws-orphan']
    orphan = scan['workspaces'][2]
    assert orphan['orphan'] is True
    assert orphan['name'] == ''
    assert orphan['files']['data'] == {'present': True, 'size': 5}


def test_scan_config_unreadable_is_honest(tmp_path):
    root = legacy_root(tmp_path)
    (root / 'aeromind-config.json').write_text('{broken json', encoding='utf-8')
    scan = scan_legacy_workspaces(root)
    assert scan['configError'] == 'MIGRATION_CONFIG_UNREADABLE'
    # The on-disk evidence still lists — the wizard never silently drops a
    # workspace just because the roster is unreadable.
    assert [row['id'] for row in scan['workspaces']] == ['ws-a']
    assert all(row['orphan'] is True for row in scan['workspaces'])


# -------------------------------------------------------------- migrate seam

def prepared_chat(tmp_path, origin):
    from core.platform_chat import DesktopChat
    from core.secrets import InMemorySecretStore
    from core.settings import RuntimeSettings
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00',
                               device_id='device-1', device_name='本机设备',
                               device_public_key='dev-key', server_public_key='broker-key')
    settings.save(config)
    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       project_bindings=ProjectBindingRegistry(tmp_path / 'project-bindings.db'))
    return chat, profile_binding(settings)


def migrate_command(scope, workspace_id, name, folder=''):
    return wire('migrate', scope, workspaceId=workspace_id, name=name, folder=folder)


def test_migrate_creates_platform_project_and_binds_roster_folder(tmp_path):
    root = legacy_root(tmp_path)
    bind_dir = tmp_path / '本机绑定文件夹'
    bind_dir.mkdir()
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        result = migration_manage(migrate_command(scope, 'ws-a', '结构仿真', str(bind_dir)),
                                  root=root, chat=chat, owner=owner, ledger=ledger)
        assert result['migrated'] is True
        assert result['workspaceId'] == 'ws-a'
        assert result['projectId'] == 'proj-new-1'
        # Exactly one platform create; the bind is device-local after the
        # Server's own list verified the project.
        assert [(m, p) for m, p, _, _ in records if m == 'POST' and p == '/api/projects'] == [('POST', '/api/projects')]
        # The ledger and the platform binding are two sequential writes: their
        # wall-clock seconds may differ across a tick, so each store's own
        # timestamp is echoed rather than pinned against the other's.
        bindings = chat.projects_manage(wire_projects_list(scope))['bindings']
        assert bindings == [
            {'projectId': 'proj-new-1', 'path': str(bind_dir.resolve()),
             'deviceName': '本机设备', 'createdAt': bindings[0]['createdAt']}]
        assert result['ledger'] == [
            {'workspaceId': 'ws-a', 'workspaceName': '结构仿真', 'projectId': 'proj-new-1',
             'projectName': '结构仿真', 'folder': str(bind_dir.resolve()),
             'status': 'migrated', 'errorCode': '', 'createdAt': result['ledger'][0]['createdAt'],
             'updatedAt': result['ledger'][0]['updatedAt']}]


def wire_projects_list(scope):
    return {'type': 'projects', 'id': 'req-2', 'action': 'list', 'scope': scope}


def test_migrate_without_folder_creates_project_only(tmp_path):
    root = legacy_root(tmp_path)
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        result = migration_manage(migrate_command(scope, 'ws-b', '空闲工作区'),
                                  root=root, chat=chat, owner=owner, ledger=ledger)
        assert result['migrated'] is True
        assert chat.projects_manage(wire_projects_list(scope))['bindings'] == []
        assert result['ledger'][0]['folder'] == ''


def test_migrate_unknown_workspace_is_refused(tmp_path):
    """未确认项不迁移: a workspace id that no scan of the legacy root can
    back is refused before any platform round-trip, and nothing is recorded."""
    root = legacy_root(tmp_path)
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        for unknown in ('ws-never-scanned', '../escape'):
            with pytest.raises(WorkspaceMigrationError) as excinfo:
                migration_manage(migrate_command(scope, unknown, '任意名'),
                                 root=root, chat=chat, owner=owner, ledger=ledger)
            assert 'MIGRATION_WORKSPACE_UNKNOWN' in str(excinfo.value)
        assert [(m, p) for m, p, _, _ in records if m == 'POST' and p == '/api/projects'] == []
        assert ledger.view(owner) == []


def test_migrate_twice_is_refused_after_success(tmp_path):
    root = legacy_root(tmp_path)
    bind_dir = tmp_path / 'folder'
    bind_dir.mkdir()
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        assert migration_manage(migrate_command(scope, 'ws-a', '结构仿真', str(bind_dir)),
                                root=root, chat=chat, owner=owner, ledger=ledger)['migrated'] is True
        with pytest.raises(WorkspaceMigrationError) as excinfo:
            migration_manage(migrate_command(scope, 'ws-a', '结构仿真', str(bind_dir)),
                             root=root, chat=chat, owner=owner, ledger=ledger)
        assert 'MIGRATION_ALREADY_MIGRATED' in str(excinfo.value)
        # The one-time aid never creates a second project for one workspace.
        assert [(m, p) for m, p, _, _ in records if m == 'POST' and p == '/api/projects'] == [('POST', '/api/projects')]


def test_migrate_platform_failure_records_honest_retryable_row(tmp_path):
    root = legacy_root(tmp_path)
    with platform(permissions=('projects:read',)) as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        result = migration_manage(migrate_command(scope, 'ws-a', '结构仿真'),
                                  root=root, chat=chat, owner=owner, ledger=ledger)
        assert result['migrated'] is False
        assert result['errorCode'] == 'CHAT_FORBIDDEN'
        assert result['ledger'] == [
            {'workspaceId': 'ws-a', 'workspaceName': '结构仿真', 'projectId': '',
             'projectName': '结构仿真', 'folder': '', 'status': 'failed',
             'errorCode': 'CHAT_FORBIDDEN', 'createdAt': result['ledger'][0]['createdAt'],
             'updatedAt': result['ledger'][0]['updatedAt']}]
    # Retry on an account that may write: the failed row was never a success,
    # so the same workspace migrates cleanly in a fresh round.
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        ledger.record(owner, 'ws-a', '结构仿真', '', '结构仿真', '', 'failed', 'CHAT_FORBIDDEN')
        scope = chat.handle({'action': 'state'})['scope']
        result = migration_manage(migrate_command(scope, 'ws-a', '结构仿真'),
                                  root=root, chat=chat, owner=owner, ledger=ledger)
        assert result['migrated'] is True
        assert [(m, p) for m, p, _, _ in records if m == 'POST' and p == '/api/projects'] == [('POST', '/api/projects')]


def test_migrate_retry_after_created_project_rebinds_without_duplicates(tmp_path):
    """Create succeeded, bind failed: the retry reuses the already-created
    platform project and only re-runs the device-local bind."""
    root = legacy_root(tmp_path)
    bind_dir = tmp_path / '真正的文件夹'
    bind_dir.mkdir()
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        result = migration_manage(migrate_command(scope, 'ws-a', '结构仿真', str(tmp_path / '不存在的文件夹')),
                                  root=root, chat=chat, owner=owner, ledger=ledger)
        assert result['migrated'] is False
        assert result['errorCode'] == 'CHAT_COMMAND_INVALID'
        assert result['ledger'][0]['projectId'] == 'proj-new-1'
        assert result['ledger'][0]['status'] == 'failed'
        retried = migration_manage(migrate_command(scope, 'ws-a', '结构仿真', str(bind_dir)),
                                   root=root, chat=chat, owner=owner, ledger=ledger)
        assert retried['migrated'] is True
        assert retried['projectId'] == 'proj-new-1'
        # Still exactly one platform project across the whole retry chain.
        assert [(m, p) for m, p, _, _ in records if m == 'POST' and p == '/api/projects'] == [('POST', '/api/projects')]
        listing = chat.projects_manage(wire_projects_list(scope))
        assert [row['id'] for row in listing['projects'] if row['name'] == '结构仿真'] == ['proj-new-1']
        # Same two-store discipline as above: echo the binding's own timestamp.
        assert listing['bindings'] == [{'projectId': 'proj-new-1', 'path': str(bind_dir.resolve()),
                                        'deviceName': '本机设备', 'createdAt': listing['bindings'][0]['createdAt']}]
        assert [row['status'] for row in retried['ledger']] == ['migrated']


def test_migrate_command_shape_is_refused(tmp_path):
    root = legacy_root(tmp_path)
    bind_dir = tmp_path / 'folder'
    bind_dir.mkdir()
    with platform() as (origin, records):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        bad_shapes = (
            wire('destroy', scope),
            wire('scan', scope, extra=1),
            migrate_command(scope, 'ws-a', '   '),
            migrate_command(scope, 'ws-a', 'x' * 129),
            migrate_command(scope, 'ws-a', '结构仿真', '相对/不是绝对路径'),
            migrate_command(scope, 'ws-a', '结构仿真', 'x' * 1025),
            {'type': 'migration', 'id': 'req-1', 'action': 'migrate', 'scope': scope,
             'workspaceId': 'ws-a', 'name': '结构仿真'},
        )
        for command in bad_shapes:
            with pytest.raises(WorkspaceMigrationError) as excinfo:
                migration_manage(command, root=root, chat=chat, owner=owner, ledger=ledger)
            assert 'MIGRATION_COMMAND_INVALID' in str(excinfo.value)
        assert [(m, p) for m, p, _, _ in records if m == 'POST' and p == '/api/projects'] == []
        assert ledger.view(owner) == []


def test_migrate_unauthenticated_is_refused(tmp_path):
    root = legacy_root(tmp_path)
    assert migration_manage(wire('scan', 'any-scope'), root=None, chat=None, owner=None,
                            ledger=None)['workspaces'] == []
    with platform() as (origin, _):
        chat, owner = prepared_chat(tmp_path, origin)
        ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
        scope = chat.handle({'action': 'state'})['scope']
        with pytest.raises(WorkspaceMigrationError) as excinfo:
            migration_manage(migrate_command(scope, 'ws-a', '结构仿真'),
                             root=root, chat=chat, owner=None, ledger=ledger)
        assert 'MIGRATION_UNAUTHENTICATED' in str(excinfo.value)


# --------------------------------------------------------------- ledger seam

def test_ledger_rows_are_identity_scoped(tmp_path):
    from core.settings import RuntimeSettings
    ledger = WorkspaceMigrationLedger(tmp_path / 'workspace-migrations.db')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url='http://127.0.0.1:1', user_id='A',
                               business_token_ref='business-A', device_id='device-1',
                               device_public_key='dev-key', server_public_key='broker-key')
    owner = profile_binding(settings)
    other = profile_binding(RuntimeSettings(server_url='http://127.0.0.1:1', user_id='B',
                                            business_token_ref='business-B', device_id='device-1',
                                            device_public_key='dev-key', server_public_key='broker-key'))
    ledger.record(owner, 'ws-a', '结构仿真', 'proj-1', '结构仿真', '', 'migrated', '')
    assert [row['workspaceId'] for row in ledger.view(owner)] == ['ws-a']
    assert ledger.view(other) == []
    assert ledger.error == ''


def test_ledger_storage_outage_is_honest(tmp_path):
    ledger = WorkspaceMigrationLedger(tmp_path)  # a directory can never be a database
    assert ledger.error == 'MIGRATION_STORAGE_UNAVAILABLE'
    with pytest.raises(WorkspaceMigrationError) as excinfo:
        ledger.view(('s', 'a', 'd'))
    assert 'MIGRATION_STORAGE_UNAVAILABLE' in str(excinfo.value)


@pytest.mark.skipif(sys.platform != 'win32',
                    reason='Pins the Windows APPDATA branch, which instantiates the real WindowsPath')
def test_legacy_root_resolution_is_platform_default(monkeypatch):
    from core.workspace_migration import legacy_linz_root
    monkeypatch.setattr(os, 'name', 'nt')
    monkeypatch.setenv('APPDATA', str(Path('C:/Users/x/AppData/Roaming')))
    assert legacy_linz_root() == Path('C:/Users/x/AppData/Roaming') / 'linz'


@pytest.mark.skipif(sys.platform == 'win32',
                    reason='Pins the POSIX XDG branch, which the Windows lane cannot construct')
def test_legacy_root_resolution_is_platform_default_posix(monkeypatch):
    """The non-Windows branches stay constructible on POSIX runners, so the
    XDG path stays verified on the Linux CI lane that caught the Windows-only
    instantiation failure."""
    from core.workspace_migration import legacy_linz_root
    monkeypatch.setenv('XDG_CONFIG_HOME', str(Path('/home/x/.config')))
    assert legacy_linz_root() == Path('/home/x/.config') / 'linz'
