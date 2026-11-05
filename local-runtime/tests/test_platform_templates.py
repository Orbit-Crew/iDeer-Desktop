"""Issue 84: the prompt-template plaza — account-scoped CRUD, categories,
usage counts and the prefill-only `use` record, relayed to the Server's own
endpoints.

Every test drives the same protocol fixture discipline as test_platform_models:
a local HTTP fixture stands in for the Server, and the Desktop's replies are
checked for the exact bounded shapes the bridge projection will demand. The
relay carries no visibility field — creation is the Server's private default —
and every reply re-reads the post-action list in the same round.
"""
import json
import threading
import pytest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings

TEMPLATE_A = dict(id='11111111-1111-4111-8111-111111111111', name='周报助手',
                  category='办公', content='请根据 {{要点}} 写一份周报，语气 {{语气}}。',
                  usage_count=3, visibility='private', updated_at='2026-11-01T00:00:00Z')
TEMPLATE_B = dict(id='22222222-2222-4222-8222-222222222222', name='代码评审',
                  category='研发', content='评审以下 {{语言}} 代码：',
                  usage_count=0, visibility='private', updated_at='2026-11-02T00:00:00Z')


@contextmanager
def platform(*, templates=None, list_status=200, use_status=200):
    """Fixture Server with the template endpoints and the auth minimums."""
    records = []
    templates = list(templates) if templates is not None else [TEMPLATE_A, TEMPLATE_B]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            self.respond(body)

        def do_PATCH(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            self.respond(body)

        def do_DELETE(self):
            self.respond(None)

        def respond(self, body):
            records.append((self.path, body, dict(self.headers), self.command))
            cookie = self.headers.get('Cookie', '')
            user = 'B' if 'business-B' in cookie else 'A'
            status = 200
            data = None
            if self.path == '/api/v1/auth/me':
                data = {'id': user, 'email': user + '@test.invalid', 'system_role': 'user',
                        'permissions': ['runs:create']}
            elif self.path == '/api/templates':
                if self.command == 'GET':
                    status, data = list_status, {'templates': templates}
                elif self.command == 'POST':
                    status, data = 201, {'id': '33333333-3333-4333-8333-333333333333',
                                         'visibility': 'private'}
                else:
                    status, data = 405, {'detail': 'Method not allowed'}
            elif self.path.startswith('/api/templates/') and self.path.endswith('/use'):
                if self.path.split('/')[3] == '22222222-2222-4222-8222-222222222222':
                    status, data = use_status, {'used': True}
                else:
                    status, data = 404, {'detail': 'Not visible'}
            elif self.path.startswith('/api/templates/'):
                if self.path.split('/')[3] == '22222222-2222-4222-8222-222222222222':
                    status, data = 200, {'id': '22222222-2222-4222-8222-222222222222'}
                else:
                    status, data = 404, {'detail': 'Not visible'}
            else:
                status, data = 404, {'detail': 'Not visible'}
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            if data is not None:
                self.wfile.write(json.dumps(data).encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', records
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def make_chat(tmp_path, origin, *, state='authenticated'):
    from core.platform_chat import DesktopChat
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': state})


def request_header(row, name):
    return next((value for key, value in row[2].items() if key.lower() == name.lower()), None)

def wire(action, **fields):
    """The full wire command the desktop loop relays, as desktop.py emits it."""
    return {'type': 'templates', 'id': 'req-1', 'action': action, 'scope': 'test-scope', **fields}



# --- the list projection -----------------------------------------------------

def test_list_projects_bounded_rows_with_prefill_facts(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        view = chat.templates_manage(wire('list'))
        assert [row['id'] for row in view['templates']] == [TEMPLATE_A['id'], TEMPLATE_B['id']]
        assert set(view['templates'][0]) == {'id', 'name', 'category', 'content',
                                             'usageCount', 'visibility', 'updatedAt'}
        assert view['templates'][0]['usageCount'] == 3
        assert view['templates'][0]['visibility'] == 'private'
        assert 'created' not in view and 'used' not in view


def test_list_drops_malformed_rows_instead_of_repairing_them(tmp_path):
    broken = dict(id='', name='no-id', category='', content='', usage_count=1,
                  visibility='private', updated_at='')
    with platform(templates=[broken, TEMPLATE_A]) as (origin, _):
        chat = make_chat(tmp_path, origin)
        view = chat.templates_manage(wire('list'))
        assert [row['id'] for row in view['templates']] == [TEMPLATE_A['id']]


def test_list_protocol_error_surfaces_when_templates_missing(tmp_path):
    with platform(list_status=404) as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('list'))
        assert 'CHAT_NOT_FOUND' in str(exc.value)


# --- create / update / delete -------------------------------------------------

def test_create_posts_content_only_and_replies_with_the_post_action_list(tmp_path):
    with platform() as (origin, records):
        chat = make_chat(tmp_path, origin)
        view = chat.templates_manage(wire('create', name=' 新模板 ', category='办公',
                                      content='总结 {{主题}}'))
        posts = [row for row in records if row[0] == '/api/templates' and row[3] == 'POST']
        assert len(posts) == 1
        # The relay carries no visibility field: the creation is the Server's
        # own private default, and the Desktop never widens it.
        assert posts[0][1] == {'name': '新模板', 'category': '办公', 'content': '总结 {{主题}}'}
        assert 'visibility' not in json.dumps(posts[0][1])
        assert view['created'] is True
        assert [row['id'] for row in view['templates']] == [TEMPLATE_A['id'], TEMPLATE_B['id']]


def test_update_sends_only_the_provided_fields(tmp_path):
    with platform() as (origin, records):
        chat = make_chat(tmp_path, origin)
        view = chat.templates_manage(wire('update', templateId=TEMPLATE_B['id'], name='评审助手'))
        patches = [row for row in records if row[0] == f"/api/templates/{TEMPLATE_B['id']}"
                   and row[3] == 'PATCH']
        assert len(patches) == 1
        assert patches[0][1] == {'name': '评审助手'}
        assert view['updated'] is True
        assert [row['id'] for row in view['templates']] == [TEMPLATE_A['id'], TEMPLATE_B['id']]


def test_update_without_any_field_is_refused(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('update', templateId=TEMPLATE_B['id']))
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_delete_uses_the_server_endpoint_and_replies_with_the_list(tmp_path):
    with platform() as (origin, records):
        chat = make_chat(tmp_path, origin)
        view = chat.templates_manage(wire('delete', templateId=TEMPLATE_B['id']))
        deletes = [row for row in records if row[3] == 'DELETE']
        assert [row[0] for row in deletes] == [f"/api/templates/{TEMPLATE_B['id']}"]
        assert view['deleted'] is True


def test_delete_of_a_missing_template_surfaces_the_server_refusal(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('delete', templateId='missing'))
        assert 'CHAT_NOT_FOUND' in str(exc.value)


# --- the use record -----------------------------------------------------------

def test_use_records_one_prefill_and_never_sends_text(tmp_path):
    with platform() as (origin, records):
        chat = make_chat(tmp_path, origin)
        view = chat.templates_manage(wire('use', templateId=TEMPLATE_B['id']))
        uses = [row for row in records if row[0] == f"/api/templates/{TEMPLATE_B['id']}/use"]
        assert len(uses) == 1
        assert uses[0][3] == 'POST'
        assert uses[0][1] == {}
        assert view['used'] is True
        assert view['templates'][1]['usageCount'] == 0


def test_use_of_a_missing_template_surfaces_the_server_refusal(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('use', templateId='missing'))
        assert 'CHAT_NOT_FOUND' in str(exc.value)


# --- command validation and identity ------------------------------------------

def test_unknown_action_is_refused(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('publish', templateId=TEMPLATE_B['id']))
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_create_with_blank_content_is_refused(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('create', name='x', category='', content='   '))
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_create_with_an_oversized_name_is_refused(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('create', name='x' * 201, category='', content='body'))
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_commands_carrying_unexpected_keys_are_refused(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('list', extra=1))
        assert 'CHAT_COMMAND_INVALID' in str(exc.value)


def test_commands_require_an_authenticated_session(tmp_path):
    with platform() as (origin, _):
        chat = make_chat(tmp_path, origin, state='unauthenticated')
        with pytest.raises(Exception) as exc:
            chat.templates_manage(wire('list'))
        assert 'CHAT_UNAUTHENTICATED' in str(exc.value)
