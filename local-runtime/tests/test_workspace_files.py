from pathlib import Path
import os

import pytest

from core.file_service import WorkspaceFileService, WorkspaceSelection
from core.files import OUTSIDE_ALLOWED_ROOTS, FileAccessError, LocalFileStore, RootConfig
from core.settings import RuntimeSettings


def test_selected_workspace_is_read_only_bounded_and_bound_to_identity(tmp_path: Path):
    config = tmp_path / 'profile' / 'settings.json'
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'marker.py').write_bytes(b'known_marker = 100\n')
    RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1').save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    service = WorkspaceFileService(selection)
    assert service.execute('local.files.list', {'args': {'path': root}}).value['entries'] == [root + '/marker.py']
    read = service.execute('local.files.read', {'args': {'path': root + '/marker.py'}}).value
    assert read['content'] == 'known_marker = 100\n'
    assert read['source']['path'] == root + '/marker.py'
    found = service.execute('local.files.search', {'args': {'path': root, 'query': 'known_marker'}}).value
    assert found['matches'] == [{'path': root + '/marker.py', 'line': 1, 'text': 'known_marker = 100'}]
    assert service.execute('local.files.write', {'path': root + '/marker.py', 'content': 'bad'}).decision.value == 'deny'
    assert WorkspaceSelection(config).status()['logicalRoot'] == root
    selection.select(str(work), confirmed=True)
    with pytest.raises(FileAccessError, match='outside allowed roots'):
        service.execute('local.files.read', {'path': root + '/marker.py'})
    settings = RuntimeSettings.from_dict(__import__('json').loads(config.read_text()))
    settings.user_id = 'B'
    settings.save(config)
    assert selection.status()['state'] == 'unavailable'
    with pytest.raises(FileAccessError) as rejected:
        service.execute('local.files.list', {'path': root})
    assert rejected.value.code == 'WORKSPACE_UNAVAILABLE'



def _workspace(tmp_path):
    config = tmp_path / 'profile' / 'settings.json'
    work = tmp_path / 'work'
    work.mkdir()
    RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1',
                    device_public_key='key-A', server_public_key='broker-A').save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    return config, work, selection, WorkspaceFileService(selection), root


def test_workspace_denies_local_policy_and_expired_or_changed_binding(tmp_path):
    from datetime import datetime, timedelta, timezone
    config, work, selection, service, root = _workspace(tmp_path)
    (work / 'marker.txt').write_bytes(b'PRIVATE-100')
    settings = RuntimeSettings.from_dict(__import__('json').loads(config.read_text()))
    settings.rules['local.files.read'] = 'deny'
    settings.save(config)
    assert service.execute('local.files.read', {'path': root + '/marker.txt'}).decision.value == 'deny'
    settings.rules.clear()
    settings.business_expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    settings.save(config)
    with pytest.raises(FileAccessError) as expired:
        service.execute('local.files.read', {'path': root + '/marker.txt'})
    assert expired.value.code == 'WORKSPACE_UNAVAILABLE'
    settings.business_expires_at = ''
    settings.device_public_key = 'rebound-key'
    settings.save(config)
    assert selection.status()['state'] == 'unavailable'


def test_workspace_search_excludes_profile_and_protected_files(tmp_path):
    config = tmp_path / 'profile' / 'settings.json'
    RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1').save(config)
    (config.parent / 'audit.db').write_bytes(b'SECRET100')
    (tmp_path / '.env').write_bytes(b'SECRET100')
    (tmp_path / 'ordinary.py').write_bytes(b'answer = "MARKER100"\n')
    selection = WorkspaceSelection(config)
    root = selection.select(str(tmp_path), confirmed=True)['logicalRoot']
    service = WorkspaceFileService(selection)
    found = service.execute('local.files.search', {'arguments': {'path': root, 'query': 'SECRET100'}}).value
    assert found['matches'] == []
    for suffix in ('/profile/audit.db', '/.env'):
        with pytest.raises(FileAccessError) as denied:
            service.execute('local.files.read', {'path': root + suffix})
        assert denied.value.code == 'PROTECTED_PATH'


def test_workspace_rejects_replaced_selected_root(tmp_path):
    config, work, selection, service, root = _workspace(tmp_path)
    work.rename(tmp_path / 'original')
    work.mkdir()
    (work / 'marker.txt').write_bytes(b'UNAUTHORIZED-REPLACEMENT')
    with pytest.raises(FileAccessError) as denied:
        service.execute('local.files.read', {'path': root + '/marker.txt'})
    assert denied.value.code == 'WORKSPACE_UNAVAILABLE'


@pytest.mark.skipif(__import__('os').name != 'nt', reason='Windows junction contract')
def test_workspace_rejects_root_replaced_by_external_junction(tmp_path):
    import subprocess
    config, work, selection, service, root = _workspace(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'marker.txt').write_bytes(b'OUTSIDE-CONTENT-100')
    work.rename(tmp_path / 'original')
    created = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(work), str(outside)], capture_output=True)
    assert created.returncode == 0
    try:
        with pytest.raises(FileAccessError) as denied:
            service.execute('local.files.read', {'path': root + '/marker.txt'})
        assert denied.value.code == 'OUTSIDE_ALLOWED_ROOTS'
    finally:
        work.rmdir()


def test_workspace_rejects_binary_and_oversized_text(tmp_path):
    config, work, selection, service, root = _workspace(tmp_path)
    (work / 'binary.bin').write_bytes(b'\x00\xff')
    (work / 'huge.txt').write_bytes(b'x' * 65537)
    for name, code in [('binary.bin', 'NOT_UTF8_TEXT'), ('huge.txt', 'FILE_TOO_LARGE')]:
        with pytest.raises(FileAccessError) as denied:
            service.execute('local.files.read', {'path': root + '/' + name})
        assert denied.value.code == code


def test_workspace_list_and_search_report_hidden_entry_scan_limit(tmp_path):
    config, work, selection, service, root = _workspace(tmp_path)
    # Raw enumeration reaches its cap even though filtering leaves fewer than
    # 500 visible files. The caller must never receive a false completeness claim.
    for number in range(30):
        (work / f'.env.{number:03}').write_bytes(b'PROTECTED')
    for number in range(480):
        (work / f'ordinary-{number:03}.txt').write_bytes(b'ordinary content')
    listed = service.execute('local.files.list', {'path': root}).value
    assert len(listed['entries']) <= 500
    assert listed['truncated'] is True
    searched = service.execute('local.files.search', {'path': root, 'query': 'ABSENT100'}).value
    assert searched['matches'] == []
    assert searched['truncated'] is True

@pytest.mark.parametrize('component', ['root', 'child'])
@pytest.mark.parametrize('reparse_facts', [
    {'st_reparse_tag': 0xA000001D},  # WSL LX_SYMLINK, regular st_mode on Windows.
    {'st_file_attributes': 0x400},  # Other/unknown reparse points fail closed too.
])
def test_read_rejects_unrecognized_reparse_points_before_open(tmp_path, monkeypatch, component, reparse_facts):
    from types import SimpleNamespace
    root = tmp_path / 'Projects'
    root.mkdir()
    target = root / 'marker.txt'
    target.write_bytes(b'MUST-NOT-READ-REPARSE-CONTENT')
    store = LocalFileStore([RootConfig('/projects', root)])
    reparse_path = root if component == 'root' else target
    real_lstat = os.lstat

    def lstat(path, *args, **kwargs):
        original = real_lstat(path, *args, **kwargs)
        if Path(path) == reparse_path:
            return SimpleNamespace(**{'st_mode': original.st_mode, 'st_reparse_tag': 0, 'st_file_attributes': 0, **reparse_facts})
        return original

    monkeypatch.setattr(os, 'lstat', lstat)
    with pytest.raises(FileAccessError) as rejected:
        store.read('/projects/marker.txt')
    assert rejected.value.code == OUTSIDE_ALLOWED_ROOTS

