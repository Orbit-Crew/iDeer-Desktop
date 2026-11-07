"""Project folder bindings: one device-local registry row per project+device (#92).

The registry is keyed by the whole profile binding (server, account, device),
so another device never sees a binding it did not make — 换设备登录 reads
未绑定（原设备绑定不迁移） with no migration logic. Bind/unbind rides the
platform projects family: bind verifies the project still exists on the
Server's own list, unbind is local cleanup, and neither ever touches local
files or directory grants. The bound folder must stay usable as the file
tools' workspace/root input through the existing guarded selection seam.
"""
import json
import os
import pytest

from test_platform_projects import PROJECT_A, make_chat, platform, wire

BINDING_A = {'server_origin': 'http://127.0.0.1:1', 'user_id': 'A', 'device_id': 'device-1',
             'device_public_key': 'key-1', 'broker_public_key': 'broker-1'}
BINDING_B = dict(BINDING_A, device_id='device-2')


def make_registry(tmp_path):
    from core.project_binding import ProjectBindingRegistry
    return ProjectBindingRegistry(tmp_path / 'project-bindings.db')


def make_chat_with_bindings(tmp_path, origin):
    """The shared DesktopChat fixture plus its #92 binding registry."""
    from core.project_binding import ProjectBindingRegistry
    chat, settings, config = make_chat(tmp_path, origin)
    chat.project_bindings = ProjectBindingRegistry(config.with_name('project-bindings.db'))
    return chat, settings, config


def with_device_name(chat, settings, config, name='测试设备'):
    settings.device_name = name
    settings.save(config)
    return chat


def bind_scope(chat):
    return chat.handle({'action': 'state'})['scope']


# --- registry unit -------------------------------------------------------

def test_set_view_round_trip_carries_path_and_device_attribution(tmp_path):
    registry = make_registry(tmp_path)
    registry.set(BINDING_A, 'proj-1', os.path.abspath(tmp_path / 'folder'), '本机设备')
    rows = registry.view(BINDING_A)
    assert [row['projectId'] for row in rows] == ['proj-1']
    assert rows[0]['path'] == os.path.abspath(tmp_path / 'folder')
    assert rows[0]['deviceName'] == '本机设备'
    assert rows[0]['createdAt']
    assert registry.bound_path(BINDING_A, 'proj-1') == os.path.abspath(tmp_path / 'folder')
    assert registry.error == ''


def test_rebind_replaces_the_path_and_unbind_clears_it(tmp_path):
    registry = make_registry(tmp_path)
    first = tmp_path / 'first'
    second = tmp_path / 'second'
    registry.set(BINDING_A, 'proj-1', str(first), '本机设备')
    # 补绑 anytime: the same project rebinds to a new folder, never duplicates.
    registry.set(BINDING_A, 'proj-1', str(second), '本机设备')
    assert [row['path'] for row in registry.view(BINDING_A)] == [str(second)]
    assert registry.clear(BINDING_A, 'proj-1') is True
    assert registry.view(BINDING_A) == []
    # Unbind stays idempotent: clearing an absent row is a quiet success.
    assert registry.clear(BINDING_A, 'proj-1') is False


def test_set_refuses_an_oversized_path_instead_of_truncating(tmp_path):
    from core.project_binding import ProjectBindingError
    registry = make_registry(tmp_path)
    # The wire gates cap the path at 1024, so direct registry misuse is the
    # only way to get here: refuse the row outright rather than silently
    # storing a truncated folder that never matches the confirmed dialog path.
    with pytest.raises(ProjectBindingError) as excinfo:
        registry.set(BINDING_A, 'proj-1', 'C:\\' + 'x' * 1024, '本机设备')
    assert 'PROJECT_BINDING_OVERFLOW' in str(excinfo.value)
    assert registry.view(BINDING_A) == []
    with pytest.raises(ProjectBindingError):
        registry.set(BINDING_A, 'proj-1', str(tmp_path), 'x' * 1025)
    assert registry.view(BINDING_A) == []


def test_set_refuses_a_device_name_beyond_the_runtime_wire_grammar(tmp_path):
    from core.project_binding import ProjectBindingError
    registry = make_registry(tmp_path)
    # The main process pins binding rows to a 128-code-point device name and
    # fail-closes the runtime on anything longer. The login surface allows
    # 255, so the registry refuses what the wire grammar cannot carry; the
    # chat seam truncates the login length before this boundary is reached.
    with pytest.raises(ProjectBindingError) as excinfo:
        registry.set(BINDING_A, 'proj-1', str(tmp_path), 'x' * 129)
    assert 'PROJECT_BINDING_OVERFLOW' in str(excinfo.value)
    assert registry.view(BINDING_A) == []


def test_other_device_never_sees_the_binding(tmp_path):
    registry = make_registry(tmp_path)
    registry.set(BINDING_A, 'proj-1', str(tmp_path / 'folder'), '设备一')
    # Same account and server, a different device: rows are keyed by the whole
    # profile binding, so nothing migrates and the view stays empty.
    assert registry.view(BINDING_B) == []
    assert registry.bound_path(BINDING_B, 'proj-1') is None
    assert registry.view(BINDING_A) != []


# --- projects family round-trips ----------------------------------------

def test_bind_folder_records_device_local_row_without_platform_writes(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_chat_with_bindings(tmp_path, origin)
        with_device_name(chat, settings, config)
        folder = tmp_path / 'proj-folder'
        folder.mkdir()
        result = chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId=PROJECT_A, path=str(folder)))
        assert result['bound'] is True
        assert result['bindings'] == [{'projectId': PROJECT_A, 'path': os.path.abspath(str(folder)),
                                       'deviceName': '测试设备', 'createdAt': result['bindings'][0]['createdAt']}]
        # The platform saw the family's own reads only (the account permission
        # fence plus one listing): binding is a device-local record and never
        # writes platform state, local files or directory grants.
        assert [(method, path) for method, path, _, _ in records if method != 'GET'] == []
        assert [path for method, path, _, _ in records if method == 'GET' and path == '/api/projects'] == ['/api/projects']


def test_bind_truncates_a_login_length_device_name_to_the_wire_cap(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_chat_with_bindings(tmp_path, origin)
        # The login surface allows a 255-code-point device name; the binding
        # row must still stay inside the 128 the main process pins, so the
        # chat seam truncates the display attribution before storing it.
        login_name = '设' * 255
        with_device_name(chat, settings, config, login_name)
        folder = tmp_path / 'proj-folder'
        folder.mkdir()
        result = chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId=PROJECT_A, path=str(folder)))
        assert result['bound'] is True
        assert len(result['bindings'][0]['deviceName']) == 128
        assert result['bindings'][0]['deviceName'] == '设' * 128


def test_list_reply_carries_the_device_binding_back(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_chat_with_bindings(tmp_path, origin)
        with_device_name(chat, settings, config)
        folder = tmp_path / 'proj-folder'
        folder.mkdir()
        chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId=PROJECT_A, path=str(folder)))
        listed = chat.projects_manage(wire('list', bind_scope(chat)))
        assert [row['projectId'] for row in listed['bindings']] == [PROJECT_A]
        assert 'bound' not in listed and 'unbound' not in listed


def test_unbind_is_idempotent_local_cleanup(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat_with_bindings(tmp_path, origin)
        folder = tmp_path / 'proj-folder'
        folder.mkdir()
        chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId=PROJECT_A, path=str(folder)))
        cleared = chat.projects_manage(wire('unbind-folder', bind_scope(chat), projectId=PROJECT_A))
        assert cleared['unbound'] is True
        assert cleared['bindings'] == []
        again = chat.projects_manage(wire('unbind-folder', bind_scope(chat), projectId=PROJECT_A))
        assert again['unbound'] is True
        assert again['bindings'] == []


def test_unbind_needs_no_platform_precondition(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat_with_bindings(tmp_path, origin)
        # The platform already lost the project (deleted elsewhere); unbind is
        # local cleanup and must still work.
        cleared = chat.projects_manage(wire('unbind-folder', bind_scope(chat), projectId='proj-gone-1'))
        assert cleared['unbound'] is True


def test_bind_refuses_an_unknown_platform_project(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat_with_bindings(tmp_path, origin)
        folder = tmp_path / 'proj-folder'
        folder.mkdir()
        with pytest.raises(Exception) as excinfo:
            chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId='proj-gone-1', path=str(folder)))
        assert 'CHAT_NOT_FOUND' in str(excinfo.value)


def test_bind_validates_the_folder(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat_with_bindings(tmp_path, origin)
        scope = bind_scope(chat)
        missing = tmp_path / 'missing'
        a_file = tmp_path / 'a-file.txt'
        a_file.write_text('x', encoding='utf-8')
        for bad in ('relative/path', str(missing), str(a_file), '', 'x' * 1025):
            with pytest.raises(Exception) as excinfo:
                chat.projects_manage(wire('bind-folder', scope, projectId=PROJECT_A, path=bad))
            assert 'CHAT_COMMAND_INVALID' in str(excinfo.value)


def test_bind_and_unbind_stay_behind_the_session_fence(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat_with_bindings(tmp_path, origin)
        chat.handle({'action': 'state'})
        folder = tmp_path / 'proj-folder'
        folder.mkdir()
        for command in (wire('bind-folder', 'not-the-session-scope', projectId=PROJECT_A, path=str(folder)),
                        wire('unbind-folder', 'not-the-session-scope', projectId=PROJECT_A)):
            with pytest.raises(Exception) as excinfo:
                chat.projects_manage(command)
            assert 'CHAT_IDENTITY_CHANGED' in str(excinfo.value)
        assert [row for row in records if row[0] in ('POST', 'PATCH', 'DELETE')] == []


def test_bind_rebind_and_device_isolation_through_the_chat_surface(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_chat_with_bindings(tmp_path, origin)
        with_device_name(chat, settings, config)
        first, second = tmp_path / 'first', tmp_path / 'second'
        first.mkdir()
        second.mkdir()
        chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId=PROJECT_A, path=str(first)))
        rebound = chat.projects_manage(wire('bind-folder', bind_scope(chat), projectId=PROJECT_A, path=str(second)))
        assert [row['path'] for row in rebound['bindings']] == [os.path.abspath(str(second))]


# --- the file tools' boundary input -------------------------------------

def test_bound_folder_is_usable_as_the_workspace_root_input(tmp_path):
    """The file tools' root input stays the confirmed device workspace; the
    bound folder must pass the exact same guarded selection seam (#92)."""
    from core.file_service import WorkspaceFileStore, WorkspaceSelection
    from core.files import RootConfig
    profile = tmp_path / 'profile'
    profile.mkdir()
    registry = make_registry(profile)
    folder = tmp_path / 'bound-folder'
    folder.mkdir()
    (folder / 'hello.txt').write_text('hello', encoding='utf-8')
    registry.set(BINDING_A, 'proj-1', str(folder), '本机设备')
    config = profile / 'settings.json'
    config.write_text(json.dumps({'user_id': 'A', 'device_id': 'device-1'}), encoding='utf-8')
    selection = WorkspaceSelection(config)
    # The bind flow's explicit workspace offer selects the bound folder like
    # any user-chosen directory: junction/protected-path guards still apply.
    assert selection.select(registry.bound_path(BINDING_A, 'proj-1'), confirmed=True)['state'] == 'ready'
    _, grant = selection.current()
    assert grant['physical_root'] == str(folder.resolve())
    store = WorkspaceFileStore(
        [RootConfig(grant['logical_root'], folder, identity=tuple(grant['identity']), resolve_root=False)],
        protected_roots=(profile,))
    root = grant['logical_root']
    assert store.list(root) == [root + '/hello.txt']
    assert store.read(root + '/hello.txt') == 'hello'
