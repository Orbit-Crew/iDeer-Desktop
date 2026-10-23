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
    assert service.execute('local.files.write', {'path': root + '/marker.py', 'content': 'bad'}).decision.value == 'consent_required'
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


def test_workspace_write_requires_each_approval_and_preserves_exact_utf8_bytes(tmp_path):
    import hashlib
    config, work, selection, service, root = _workspace(tmp_path)
    payload = {'operation': 'local.files.write', 'run_id': 'run-102',
               'arguments': {'path': root + '/new.txt', 'content': 'AFTER\n中文\r\n'}}
    assert service.execute('local.files.write', payload).decision.value == 'consent_required'
    assert not (work / 'new.txt').exists()
    result = service.execute('local.files.write', payload, consent=True)
    expected = b'AFTER\n\xe4\xb8\xad\xe6\x96\x87\r\n'
    assert (work / 'new.txt').read_bytes() == expected
    assert result.value['sha256'] == hashlib.sha256(expected).hexdigest()
    assert result.value['bytes'] == len(expected)
    assert service.execute('local.files.write', payload).decision.value == 'consent_required'
    settings = RuntimeSettings.from_dict(__import__('json').loads(config.read_text()))
    settings.rules['local.files.write'] = 'allow'
    settings.save(config)
    assert service.execute('local.files.write', payload).decision.value == 'consent_required'
    settings.rules['local.files.write'] = 'deny'
    settings.save(config)
    assert service.execute('local.files.write', payload, consent=True).decision.value == 'deny'


@pytest.mark.parametrize('content,code', [('x' * 65537, 'FILE_TOO_LARGE'), ('\x00', 'NOT_UTF8_TEXT'), (1, 'NOT_UTF8_TEXT'), ('\ud800', 'NOT_UTF8_TEXT')], ids=['oversized', 'nul', 'not-string', 'surrogate'])
def test_workspace_write_rejects_non_text_or_oversized_content_without_effect(tmp_path, content, code):
    _, work, _, service, root = _workspace(tmp_path)
    (work / 'target.txt').write_bytes(b'BEFORE')
    with pytest.raises(FileAccessError) as rejected:
        service.execute('local.files.write', {'path': root + '/target.txt', 'content': content}, consent=True)
    assert rejected.value.code == code
    assert (work / 'target.txt').read_bytes() == b'BEFORE'


def test_workspace_write_readback_failure_reports_uncertain_after_real_effect(tmp_path, monkeypatch):
    from core.file_service import WorkspaceFileStore
    _, work, _, service, root = _workspace(tmp_path)
    (work / 'target.txt').write_bytes(b'BEFORE')
    def unavailable(*args, **kwargs):
        raise FileAccessError('PERMISSION_DENIED')
    monkeypatch.setattr(WorkspaceFileStore, 'read_bytes', unavailable)
    with pytest.raises(FileAccessError) as uncertain:
        service.execute('local.files.write', {'path': root + '/target.txt', 'content': 'AFTER'}, consent=True)
    assert uncertain.value.code == 'RESULT_UNCERTAIN'
    assert (work / 'target.txt').read_bytes() == b'AFTER'


def test_workspace_write_cleanup_failure_reports_uncertain_after_real_effect(tmp_path, monkeypatch):
    _, work, _, service, root = _workspace(tmp_path)
    (work / 'target.txt').write_bytes(b'BEFORE')
    original_unlink = os.unlink
    def unavailable_cleanup(path, *args, **kwargs):
        if str(path).split(os.sep)[-1].startswith('.local-write-'):
            raise OSError('fixture cleanup unavailable')
        return original_unlink(path, *args, **kwargs)
    monkeypatch.setattr(os, 'unlink', unavailable_cleanup)
    with pytest.raises(FileAccessError) as uncertain:
        service.execute('local.files.write', {'path': root + '/target.txt', 'content': 'AFTER'}, consent=True)
    assert uncertain.value.code == 'RESULT_UNCERTAIN'
    assert (work / 'target.txt').read_bytes() == b'AFTER'


@pytest.mark.skipif(os.name != 'nt', reason='Windows pinned ancestor contract')
def test_workspace_write_pins_parent_against_rename_between_validation_and_replace(tmp_path, monkeypatch):
    _, work, _, service, root = _workspace(tmp_path)
    parent = work / 'inner'
    parent.mkdir()
    (parent / 'target.txt').write_bytes(b'BEFORE')
    blocked = []
    original_replace = os.replace
    def replace(source, target, *args, **kwargs):
        with pytest.raises(PermissionError):
            parent.rename(tmp_path / 'escaped')
        blocked.append(True)
        return original_replace(source, target, *args, **kwargs)
    monkeypatch.setattr(os, 'replace', replace)
    result = service.execute('local.files.write', {'path': root + '/inner/target.txt', 'content': 'AFTER'}, consent=True)
    assert result.value['written'] is True
    assert blocked == [True]
    assert (parent / 'target.txt').read_bytes() == b'AFTER'
    assert not (tmp_path / 'escaped').exists()


@pytest.mark.skipif(os.name != 'nt', reason='Windows junction contract')
def test_workspace_write_rejects_junction_escape_without_touching_external_target(tmp_path):
    import subprocess
    _, work, _, service, root = _workspace(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'target.txt').write_bytes(b'BEFORE')
    link = work / 'link'
    created = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(link), str(outside)], capture_output=True)
    assert created.returncode == 0
    try:
        with pytest.raises(FileAccessError) as rejected:
            service.execute('local.files.write', {'path': root + '/link/target.txt', 'content': 'AFTER'}, consent=True)
        assert rejected.value.code == 'OUTSIDE_ALLOWED_ROOTS'
        assert (outside / 'target.txt').read_bytes() == b'BEFORE'
    finally:
        link.rmdir()


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

