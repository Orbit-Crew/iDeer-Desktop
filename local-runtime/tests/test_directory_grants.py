"""Persistent directory consent through the public workspace service."""
from core.file_service import WorkspaceFileService, WorkspaceSelection
from core.policy import PolicyDecision
from core.settings import RuntimeSettings, load_settings
from core.files import FileAccessError
import pytest


def test_directory_write_grant_survives_content_changes_and_restart(tmp_path):
    config, work = tmp_path / 'profile/settings.json', tmp_path / 'W1'
    work.mkdir()
    (work / 'sub').mkdir()
    RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1',
        device_public_key='device-key', server_public_key='server-key').save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(work, confirmed=True)['logicalRoot']
    payload = {'arguments': {'path': root + '/old.txt', 'content': 'BEFORE'}}
    service = WorkspaceFileService(selection)
    assert service.execute('local.files.write', payload).decision is PolicyDecision.CONSENT_REQUIRED
    grant = service.remember_consent(payload)
    service = WorkspaceFileService(WorkspaceSelection(config))
    for path, content in [('old.txt', 'AFTER'), ('sub/new.txt', 'NEW')]:
        result = service.execute('local.files.write', {'arguments': {'path': root + '/' + path, 'content': content}})
        assert result.decision is PolicyDecision.ALLOW
        assert result.value['authorization'] == 'directory:' + grant['id']
        assert (work / path).read_text() == content
    assert selection.grants()[0]['operation'] == 'local.files.write'
    settings = load_settings(config)
    settings.session_id, settings.business_token_ref, settings.session_token_ref = 'rotated', 'new-business', 'new-device'
    settings.save(config)
    assert WorkspaceSelection(config).grants()[0]['id'] == grant['id']


@pytest.mark.parametrize('change', ['account', 'device', 'key', 'directory', 'revoke', 'deny', 'logout', 'protected', 'outside', 'legacy'])
def test_grants_never_bypass_identity_path_or_local_denial(tmp_path, change):
    config, work = tmp_path / 'profile/settings.json', tmp_path / 'W1'
    work.mkdir()
    target = work / 'target.txt'
    target.write_bytes(b'BEFORE')
    RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1',
        device_public_key='key', server_public_key='broker').save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(work, confirmed=True)['logicalRoot']
    service = WorkspaceFileService(selection)
    payload = {'arguments': {'path': root + '/target.txt', 'content': 'AFTER'}}
    if change == 'legacy':
        service.consent.set_always_allow('local.files.write')
    else:
        grant = service.remember_consent(payload)
    settings = load_settings(config)
    if change in {'account', 'device', 'key', 'logout', 'deny'}:
        if change == 'account': settings.user_id = 'B'
        if change == 'device': settings.device_id = 'D2'
        if change == 'key': settings.device_public_key = 'rebound'
        if change == 'logout': settings.signed_out = True
        if change == 'deny': settings.rules['local.files.write'] = 'deny'
        settings.save(config)
    if change == 'directory':
        other = tmp_path / 'W2'
        other.mkdir()
        selection.select(other, confirmed=True)
    if change == 'revoke': selection.revoke(grant['id'])
    if change == 'protected': payload['arguments']['path'] = root + '/.env'
    if change == 'outside': payload['arguments']['path'] = '/outside/target.txt'
    try:
        result = service.execute('local.files.write', payload)
        assert result.decision is not PolicyDecision.ALLOW
    except FileAccessError as error:
        assert error.code in {'WORKSPACE_UNAVAILABLE', 'OUTSIDE_ALLOWED_ROOTS', 'PROTECTED_PATH'}
    assert target.read_bytes() == b'BEFORE'
    if change == 'logout':
        settings.signed_out = False
        settings.save(config)
        assert service.execute('local.files.write', payload).decision is PolicyDecision.ALLOW
    if change == 'revoke':
        assert not selection.grants()


def test_signed_directory_consent_records_basis_and_skips_second_prompt(tmp_path):
    import asyncio
    import json
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from websockets.asyncio.server import serve
    from core.protocol import MessageType, public_key_text, sign_envelope
    from core.transport import LocalRuntimeClient
    from core.receipt_ledger import ReceiptLedger
    from core.task_guard import TaskGuard

    async def run():
        config, work = tmp_path / 'profile/settings.json', tmp_path / 'W1'
        work.mkdir()
        broker_key, key = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1',
            device_public_key=public_key_text(key), server_public_key=public_key_text(broker_key)).save(config)
        selection = WorkspaceSelection(config)
        root = selection.select(work, confirmed=True)['logicalRoot']
        prompts, outcomes = [], []
        done = asyncio.Event()

        async def prompt(pending):
            prompts.append(pending)
            return {'approved': True, 'directory': True}

        async def broker(socket):
            hello = json.loads(await socket.recv())
            def frame(kind, payload, task=None):
                return json.dumps(sign_envelope(private_key=broker_key, message_type=kind,
                    device_id='D1', session_id=hello['session_id'], task_id=task, payload=payload))
            await socket.send(frame(MessageType.HELLO, {'server_public_key': public_key_text(broker_key), 'receipt_replay': 1}))
            for index, content in enumerate(['BEFORE', 'AFTER', 'SCRIPT-MUST-NOT-RUN']):
                await socket.send(frame(MessageType.TASK, {'operation': 'local.files.write' if index < 2 else 'local.python',
                    'run_id': 'run', 'thread_id': 'thread', 'tool_call_id': 'call-' + str(index),
                    'arguments': {'path': root + '/target.txt', 'content': content}}, 'task-' + str(index)))
                while True:
                    result = json.loads(await socket.recv())
                    if result['type'] in {'task_result', 'error'}:
                        outcomes.append(result)
                        break
            done.set()
            await socket.wait_closed()

        async with serve(broker, '127.0.0.1', 0) as server:
            client = LocalRuntimeClient(server_url=f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}',
                device_id='D1', user_id='A', private_key=key, session_token='synthetic',
                restrict_capabilities=True, capabilities=('local.files.write',),
                server_public_key=public_key_text(broker_key), file_service=WorkspaceFileService(selection),
                receipt_ledger=ReceiptLedger(config.with_name('receipts.db')),
                task_guard=TaskGuard(config.with_name('tasks.db')), consent_prompt=prompt)
            task = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(done.wait(), 5)
            finally:
                await client.shutdown()
                await asyncio.gather(task, return_exceptions=True)
        assert (work / 'target.txt').read_bytes() == b'AFTER'
        assert len(prompts) == 1
        grant, = selection.grants()
        assert [outcome['payload']['receipt']['consent_decision'] for outcome in outcomes[:2]] == ['directory:' + grant['id']] * 2
        assert outcomes[2]['payload']['error_code'] == 'CAPABILITY_UNAVAILABLE'
    asyncio.run(run())
