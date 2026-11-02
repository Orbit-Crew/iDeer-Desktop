"""Issue 93: 对话附件去向选择器 — three destinations, never silent.

The default destination parses the attachment on the device and sends the
extracted text into the conversation while the original bytes stay local; the
explicit upload destination forms a platform Thread attachment; the explicit
local-only view answers with a bounded read-only display and never enters the
conversation. Every per-attachment failure is honest, and nothing executes
without the destination the user picked.
"""
import base64
import hashlib
import time
import uuid

import pytest
from fixtures.document_fixtures import build_pdf
from test_platform_chat import AGENT, platform, request_header

from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings


def make_device_chat(tmp_path, origin):
    """A Desktop chat with the device binding the attachment upload path needs."""
    from core.platform_chat import DesktopChat
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    secure.set('device-session-105', 'device-session-105')
    config = tmp_path / 'profile' / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-93', server_public_key='broker-key-93',
        session_token_ref='device-session-105',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}), settings, config


def open_thread(chat):
    scope = chat.handle({'action': 'refresh'})['scope']
    chat.handle({'action': 'create', 'scope': scope, 'agentId': AGENT})
    return scope


def run_posts(records):
    return [body for path, body, _ in records if path == '/api/threads/thread-A/runs' and body]


def artifact_posts(records):
    return [row for row in records if row[0] == '/api/threads/thread-A/artifacts' and row[1] is not None]


def send_attachment(chat, scope, attachments, text='请处理这份附件', turn=None):
    result = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                          'turnId': turn or str(uuid.uuid4()), 'text': text, 'attachments': attachments})
    # Let the run stream settle so a following send never races the previous
    # turn — the same bounded wait the stream tests use.
    deadline = time.monotonic() + 10
    state = chat.handle({'action': 'state'})
    while time.monotonic() < deadline and (state['stream'] != 'idle'
                                           or state['run'] and state['run']['status'] in {'pending', 'running'}):
        time.sleep(0.02)
        state = chat.handle({'action': 'state'})
    return result


def test_default_destination_parses_on_device_and_never_uploads(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        notes = tmp_path / 'notes.txt'
        notes.write_text('附件正文第一行\n附件正文第二行', encoding='utf-8')
        digest = hashlib.sha256(notes.read_bytes()).hexdigest()
        result = send_attachment(chat, scope, [dict(id='a1', path=str(notes), name='notes.txt',
                                                    destination='parsed-text')])
        assert result['error'] == '', result['error']
        # The default path never uploads: no artifact request exists at all.
        assert artifact_posts(records) == []
        runs = run_posts(records)
        assert len(runs) == 1
        content = runs[0]['input']['messages'][0]['content']
        assert content.startswith('请处理这份附件')
        assert '附件正文第一行' in content and '附件正文第二行' in content
        assert '本机解析' in content and 'text-utf8' in content and '[/附件·notes.txt]' in content
        # The run records identity facts only — names, destination and hash,
        # never content.
        assert runs[0]['metadata']['desktop_attachments'] == [
            dict(id='a1', name='notes.txt', destination='parsed-text', sha256=digest)]
        assert result['attachmentStatuses'] == [
            dict(id='a1', name='notes.txt', destination='parsed-text', status='parsed',
                 sha256=digest, truncated=False)]


def test_upload_destination_forms_a_platform_thread_attachment(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        report = tmp_path / 'report.txt'
        report.write_text('UPLOAD-ME-93', encoding='utf-8')
        digest = hashlib.sha256(report.read_bytes()).hexdigest()
        result = send_attachment(chat, scope, [dict(id='u1', path=str(report), name='report.txt',
                                                    destination='upload')])
        assert result['error'] == '', result['error']
        posts = artifact_posts(records)
        assert len(posts) == 1
        path, body, headers = posts[0]
        assert body['version'] == 1 and body['kind'] == 'chat_attachment'
        assert body['name'] == 'report.txt' and body['sha256'] == digest
        assert body['bytes'] == len('UPLOAD-ME-93'.encode())
        assert base64.b64decode(body['content']) == b'UPLOAD-ME-93'
        assert body['handle'] == f'local://{digest}/report.txt'
        assert request_header(posts[0], 'Idempotency-Key') == body['handle']
        assert request_header(posts[0], 'X-Device-Session') == 'device-session-105'
        assert body['grant']['token'] and body['grant']['thread_id'] == 'thread-A'
        assert body['grant']['name'] == 'report.txt'
        grant = next(b for p, b, _ in records if p == '/api/threads/thread-A/artifacts/grant')
        assert grant == dict(thread_id='thread-A', name='report.txt', sha256=digest,
                             device_id='D1', bytes=len('UPLOAD-ME-93'.encode()))
        assert result['attachmentStatuses'] == [
            dict(id='u1', name='report.txt', destination='upload', status='uploaded',
                 sha256=digest, artifactId='art-1')]
        content = run_posts(records)[0]['input']['messages'][0]['content']
        assert '已上传为平台附件' in content and 'art-1' in content
        # The platform artifact is visible through the Thread's own artifact
        # list — the cross-device seam the destination promises. The task
        # observation refresh runs off-thread, so the state is polled until
        # the listing lands.
        chat._tasks_checked = time.monotonic() - 10
        deadline = time.monotonic() + 5
        state = chat.handle({'action': 'state'})
        while time.monotonic() < deadline and not any(
                row['artifact_id'] == 'art-1' and row['name'] == 'report.txt' for row in state['artifacts']):
            time.sleep(0.05)
            state = chat.handle({'action': 'state'})
        assert any(row['artifact_id'] == 'art-1' and row['name'] == 'report.txt'
                   for row in state['artifacts'])


def test_local_view_answers_readonly_without_entering_the_conversation(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        notes = tmp_path / 'notes.txt'
        notes.write_text('只读预览内容', encoding='utf-8')
        view = chat.handle({'action': 'attachment-view', 'scope': scope, 'threadId': 'thread-A',
                            'id': 'v1', 'path': str(notes), 'name': 'notes.txt'})
        assert view['error'] == ''
        # A local view is a pure device read: no run and no upload ever happens.
        assert run_posts(records) == [] and artifact_posts(records) == []
        got = view['attachmentView']
        assert got['id'] == 'v1' and got['name'] == 'notes.txt' and got['status'] == 'parsed'
        assert got['text'] == '只读预览内容' and got['truncated'] is False
        assert got['summary']['status'] == 'parsed' and got['summary']['parser'] == 'text-utf8'
        # A PDF view carries the engine's page facts for the read-only display.
        deck = tmp_path / 'deck.pdf'
        deck.write_bytes(build_pdf(['device page one']))
        pdf_view = chat.handle({'action': 'attachment-view', 'scope': scope, 'threadId': 'thread-A',
                                'id': 'v2', 'path': str(deck), 'name': 'deck.pdf'})
        got = pdf_view['attachmentView']
        assert got['status'] == 'parsed' and got['summary']['pages'] == 1
        assert 'device page one' in got['text'] and got['summary']['parser'] == 'pypdf'
        assert all('只读预览内容' not in message['text'] for message in pdf_view['messages'])


def test_attachment_failures_are_honest_and_never_stop_the_message(tmp_path, monkeypatch):
    import core.platform_chat as platform_chat
    with platform(grant_status=403) as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        # A missing file, a corrupt PDF and a legacy binary each fail with
        # their own fixed category; the user's text still goes out.
        gone = send_attachment(chat, scope, [dict(id='f1', path=str(tmp_path / 'gone.txt'),
                                                  name='missing.txt', destination='parsed-text')])
        status = gone['attachmentStatuses'][0]
        assert status['status'] == 'failed' and status['errorCode'] == 'ATTACHMENT_READ_FAILED'
        assert '[附件·missing.txt·处理失败：ATTACHMENT_READ_FAILED]' in \
            run_posts(records)[0]['input']['messages'][0]['content']
        corrupt = tmp_path / 'corrupt.pdf'
        corrupt.write_bytes(b'%PDF-1.4 not really a pdf')
        broken = send_attachment(chat, scope, [dict(id='f2', path=str(corrupt), name='corrupt.pdf',
                                                    destination='parsed-text')])
        assert broken['error'] == '', broken['error']
        status = broken['attachmentStatuses'][0]
        assert status['status'] == 'failed' and status['errorCode'] == 'PARSE_PDF_CORRUPT'
        legacy_file = tmp_path / 'old.doc'
        legacy_file.write_bytes(b'\xd0\xcf\x11\xe0 legacy ole bytes')
        legacy = send_attachment(chat, scope, [dict(id='f3', path=str(legacy_file),
                                                    name='old.doc', destination='parsed-text')])
        assert legacy['error'] == '', legacy['error']
        status = legacy['attachmentStatuses'][0]
        assert status['status'] == 'skipped' and status['errorCode'] == 'PARSE_FORMAT_UNSUPPORTED'
        # A server-refused upload fails per attachment with the honest
        # category; nothing pretends success.
        plain = tmp_path / 'plain.txt'
        plain.write_text('denied', encoding='utf-8')
        denied = send_attachment(chat, scope, [dict(id='f4', path=str(plain), name='plain.txt',
                                                    destination='upload')])
        status = denied['attachmentStatuses'][0]
        assert status['status'] == 'failed' and status['errorCode'] == 'CHAT_FORBIDDEN'
        assert artifact_posts(records) == []
        # An oversized original is refused before any staging or request.
        monkeypatch.setattr(platform_chat, 'MAX_ATTACHMENT_UPLOAD_BYTES', 8)
        big = tmp_path / 'big.txt'
        big.write_text('x' * 100, encoding='utf-8')
        oversized = send_attachment(chat, scope, [dict(id='f5', path=str(big), name='big.txt',
                                                       destination='upload')])
        status = oversized['attachmentStatuses'][0]
        assert status['status'] == 'failed' and status['errorCode'] == 'ATTACHMENT_TOO_LARGE'
        assert artifact_posts(records) == []
        assert len(run_posts(records)) == 5


BAD_ATTACHMENTS = [
    {'attachments': []},
    {'attachments': 'a1'},
    {'attachments': {'id': 'a1'}},
    {'attachments': ['nope']},
    {'attachments': [dict(id='a1', path='', name='a.txt', destination='parsed-text')]},
    {'attachments': [dict(id='a1', path='p' * 4097, name='a.txt', destination='parsed-text')]},
    {'attachments': [dict(id='a1', path='p', name='', destination='parsed-text')]},
    {'attachments': [dict(id='a1', path='p', name='n' * 257, destination='parsed-text')]},
    {'attachments': [dict(id='a1', path='p', name='a.txt', destination='local-view')]},
    {'attachments': [dict(id='a1', path='p', name='a.txt', destination='auto')]},
    {'attachments': [dict(id='', path='p', name='a.txt', destination='parsed-text')]},
    {'attachments': [dict(id='x' * 129, path='p', name='a.txt', destination='parsed-text')]},
    {'attachments': [dict(id='a1', path='p', name='a.txt', destination='parsed-text', extra='x')]},
    {'attachments': [dict(id='a1', path='p', name='a.txt', destination='parsed-text'),
                     dict(id='a1', path='p', name='b.txt', destination='parsed-text')]},
    {'attachments': [dict(id=f'id{i}', path='p', name='a.txt', destination='parsed-text') for i in range(9)]},
]


@pytest.mark.parametrize('patch', BAD_ATTACHMENTS)
def test_attachment_shapes_are_bounded_before_anything_executes(tmp_path, patch):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        result = chat.handle({'action': 'send', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': str(uuid.uuid4()), 'text': 'hi', **patch})
        assert result['error'] == 'CHAT_COMMAND_INVALID', patch
        assert run_posts(records) == [] and artifact_posts(records) == []


def test_attachments_never_ride_an_answer(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        result = chat.handle({'action': 'answer', 'scope': scope, 'threadId': 'thread-A',
                              'turnId': str(uuid.uuid4()), 'requestId': 'req', 'text': 'ok',
                              'attachments': [dict(id='a1', path='p', name='a.txt',
                                                   destination='parsed-text')]})
        assert result['error'] == 'CHAT_COMMAND_INVALID'
        assert run_posts(records) == []


def test_message_budget_bounds_the_parsed_text_honestly(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        notes = tmp_path / 'notes.txt'
        notes.write_text('字' * 20000, encoding='utf-8')
        result = send_attachment(chat, scope, [dict(id='a1', path=str(notes), name='notes.txt',
                                                    destination='parsed-text')], text='请总结')
        assert result['error'] == ''
        content = run_posts(records)[0]['input']['messages'][0]['content']
        assert len(content) <= 16000
        assert content.startswith('请总结')
        assert '（已截断）' in content and '[/附件·notes.txt]' in content
        assert result['attachmentStatuses'][0]['truncated'] is True


VIEW_BAD_SHAPES = [
    {'extra': 'x'},
    {'name': 'notes.txt', 'id': 'v1', 'path': ''},
    {'name': 'notes.txt', 'id': '', 'path': 'p'},
    {'name': 'notes.txt', 'id': 'x' * 129, 'path': 'p'},
    {'name': 'notes.txt', 'id': 'v1', 'path': 'p' * 4097},
    {'name': 'n' * 257, 'id': 'v1', 'path': 'p'},
]


@pytest.mark.parametrize('patch', VIEW_BAD_SHAPES)
def test_local_view_shapes_are_bounded(tmp_path, patch):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        command = {'action': 'attachment-view', 'scope': scope, 'threadId': 'thread-A',
                   'id': 'v1', 'path': 'p', 'name': 'notes.txt'}
        command.update(patch)
        result = chat.handle(command)
        assert result['error'] == 'CHAT_COMMAND_INVALID', patch
        assert 'attachmentView' not in result


def test_local_view_is_bound_to_the_open_thread_and_honest_about_failures(tmp_path):
    with platform() as (origin, records):
        chat, settings, config = make_device_chat(tmp_path, origin)
        scope = open_thread(chat)
        notes = tmp_path / 'notes.txt'
        notes.write_text('内容', encoding='utf-8')
        changed = chat.handle({'action': 'attachment-view', 'scope': scope, 'threadId': 'other-thread',
                               'id': 'v1', 'path': str(notes), 'name': 'notes.txt'})
        assert changed['error'] == 'CHAT_THREAD_CHANGED'
        missing = chat.handle({'action': 'attachment-view', 'scope': scope, 'threadId': 'thread-A',
                               'id': 'v2', 'path': str(tmp_path / 'gone.txt'), 'name': 'gone.txt'})
        assert missing['error'] == ''
        assert missing['attachmentView']['status'] == 'failed'
        assert missing['attachmentView']['errorCode'] == 'ATTACHMENT_READ_FAILED'
        assert missing['attachmentView']['text'] == ''
