"""Public Desktop chat commands across the authenticated HTTP artifact contract."""
import pytest

from test_platform_chat import CONTENT, UPLOAD_COMMAND, platform, prepare_result, upload_posts


def test_explicit_upload_uses_server_grant_and_the_current_device_session(tmp_path):
    with platform() as (origin, records):
        chat, _, _, _, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert not [row for row in records if row[0].endswith('/artifacts/grant')]
        result = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert result['error'] == ''
        grants = [row for row in records if row[0].endswith('/artifacts/grant')]
        assert len(grants) == 1
        _, body, headers = grants[0]
        assert body == dict(device_id='D1', run_id='run-105', task_id='task-105', name='result-105.txt',
                            sha256='0e72092273360afa4c59cd372e0a9aee7cb612cf474ccb20048b305e4fbf1274',
                            bytes=len(CONTENT.encode()))
        assert headers['X-Device-Session'] == 'device-session-105'
        _, uploaded, headers = upload_posts(records)[0]
        assert uploaded['grant']['token'].startswith('server-issued-grant-')
        assert set(uploaded['grant']) == {'run_id', 'task_id', 'thread_id', 'name', 'token'}
        assert headers['X-Device-Session'] == 'device-session-105'


def test_second_device_can_download_owned_thread_artifact_without_a_workspace(tmp_path):
    import base64
    with platform() as (origin, records):
        chat, _, settings, config, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert chat.handle({**UPLOAD_COMMAND, 'scope': scope})['error'] == ''
        # Same account, different device, no local file grant or local result.
        settings.device_id, settings.device_public_key, settings.workspace = 'D2', 'device-key-D2', {}
        settings.save(config)
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert opened['artifacts'][0]['artifact_id'] == 'art-1'
        assert all(not task.get('localResult') for task in opened['localTasks'])
        downloaded = chat.handle(dict(action='download', scope=scope, threadId='thread-A', artifactId='art-1'))
        assert downloaded['error'] == ''
        assert base64.b64decode(downloaded['download']['content']) == CONTENT.encode()
        assert downloaded['download']['sha256'] == '0e72092273360afa4c59cd372e0a9aee7cb612cf474ccb20048b305e4fbf1274'
        assert 'download' not in chat.handle({'action': 'state'})
        assert len(upload_posts(records)) == 1


@pytest.mark.parametrize('status,error', [(401, 'CHAT_UNAUTHENTICATED'), (403, 'CHAT_FORBIDDEN'),
                                          (409, 'CHAT_CONFLICT'), (503, 'CHAT_SERVER_ERROR')])
def test_refused_server_grant_never_sends_file_bytes_or_marks_uploaded(tmp_path, status, error):
    from core.receipt_ledger import profile_binding
    with platform(grant_status=status) as (origin, records):
        chat, registry, settings, _, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        result = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert result['error'] == error
        assert upload_posts(records) == []
        assert registry.get(profile_binding(settings), 'task-105')['artifact_ref'] == ''
        assert not any(CONTENT in str(body) for _, body, _ in records)


@pytest.mark.parametrize('change,error', [('policy', 'UPLOAD_POLICY_DENIED'),
                                         ('content', 'UPLOAD_CONTENT_CHANGED'),
                                         ('identity', 'CHAT_IDENTITY_CHANGED'),
                                         ('grant-task', 'CHAT_PROTOCOL_ERROR')])
def test_slow_grant_cannot_bypass_local_changes_before_upload(tmp_path, change, error):
    change_after_grant = []

    def on_grant(data):
        change_after_grant[0](data)

    with platform(on_grant=on_grant) as (origin, records):
        chat, _, settings, config, _, target, _ = prepare_result(tmp_path, origin)

        def change_state(data):
            if change == 'policy':
                settings.rules['local.artifacts.upload'] = 'deny'
                settings.save(config)
            elif change == 'content':
                target.write_text('TAMPERED', encoding='utf-8')
            elif change == 'identity':
                settings.device_id = 'rebound-device'
                settings.save(config)
            else:
                data['task_id'] = 'wrong-task'

        change_after_grant.append(change_state)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        result = chat.handle({**UPLOAD_COMMAND, 'scope': scope})
        assert result['error'] == error
        assert upload_posts(records) == []


def test_other_account_cannot_use_an_owned_artifact_after_switching_identity(tmp_path):
    with platform() as (origin, records):
        chat, _, settings, config, _, _, _ = prepare_result(tmp_path, origin)
        scope = chat.handle({'action': 'refresh'})['scope']
        chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        assert chat.handle({**UPLOAD_COMMAND, 'scope': scope})['error'] == ''
        chat.secure.set('business-B', 'business-B')
        settings.user_id, settings.business_token_ref = 'B', 'business-B'
        settings.save(config)
        refused = chat.handle(dict(action='download', scope=scope, threadId='thread-A', artifactId='art-1'))
        assert refused['error'] == 'CHAT_IDENTITY_CHANGED'
        current = chat.handle({'action': 'refresh'})
        refused = chat.handle(dict(action='open', scope=current['scope'], threadId='thread-A'))
        assert refused['error'] == 'CHAT_NOT_FOUND'
        assert not any(path.endswith('/download') for path, _, _ in records)
