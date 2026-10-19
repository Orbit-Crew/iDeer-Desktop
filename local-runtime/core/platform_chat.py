"""Authenticated Desktop chat. All orchestration and durable history belong to Server."""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path

from .browser_login import _NoRedirect, platform_origin
from .secrets import SecretStore, SecretStoreError
from .settings import load_settings

MAX_RESPONSE = 2 * 1024 * 1024


class ChatError(Exception):
    """Only fixed error categories cross the Desktop boundary."""


@dataclass(frozen=True)
class ChatSession:
    scope: str
    origin: str
    user_id: str
    token: str = field(repr=False)


def empty_state(scope=""):
    return dict(scope=scope, resources=[], threads=[], thread=None, messages=[], run=None,
                events=[], stream='idle', error='', lastEventId='')


class DesktopChat:
    def __init__(self, config: Path, secure: SecretStore, login_status):
        self.config, self.secure, self.login_status = config, secure, login_status
        self._lock = threading.RLock()
        self._state = empty_state()
        self._turns = set()
        self._generation = 0

    def _reset(self, scope=''):
        self._generation += 1
        self._state = empty_state(scope)
        self._turns.clear()

    @staticmethod
    def _id(value):
        if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(c not in
                'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in value):
            raise ChatError('CHAT_COMMAND_INVALID')
        return value

    @staticmethod
    def _uuid(value):
        try:
            if str(uuid.UUID(value)) != value:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ChatError('CHAT_COMMAND_INVALID') from None
        return value

    @staticmethod
    def _run(run):
        return dict(id=run['run_id'], status=run['status'], selection=run.get('metadata', {}).get('selection_snapshot', {}))

    def _messages(self, messages, *, delta=False):
        by_id = {m['id']: m for m in self._state['messages']}
        for raw in messages:
            if not isinstance(raw, dict):
                continue
            kind = raw.get('type', raw.get('role', ''))
            kind = {'AIMessageChunk': 'ai', 'assistant': 'ai', 'user': 'human', 'ToolMessageChunk': 'tool'}.get(kind, kind)
            if kind not in {'ai', 'human', 'tool'}:
                continue
            key = str(raw.get('id') or '')
            if not key:
                continue
            content = raw.get('content', '')
            text = content if isinstance(content, str) else '\n'.join(
                c.get('text', '') for c in content if isinstance(c, dict) and isinstance(c.get('text', ''), str)) if isinstance(content, list) else ''
            kwargs = raw.get('additional_kwargs') or {}
            if kwargs.get('hide_from_ui') and not kwargs.get('human_input_response'):
                continue
            if delta and key in by_id:
                text = by_id[key]['text'] + text
            request = (raw.get('artifact') or {}).get('human_input') if isinstance(raw.get('artifact'), dict) else None
            by_id[key] = dict(id=key, role=kind, text=text, name=raw.get('name', ''),
                             request=request, response=kwargs.get('human_input_response'))
        self._state['messages'] = list(by_id.values())
        requests, answered = {}, set()
        for message in self._state['messages']:
            if message.get('request'):
                requests[message['request']['request_id']] = message['request']
            response = message.get('response')
            if response and response['request_id'] in requests:
                answered.add(response['request_id'])
            elif message['role'] == 'human' and not response:
                pending = next((r for r in reversed(list(requests)) if r not in answered), None)
                if pending:
                    message['response'] = {'request_id': pending}
                    answered.add(pending)

    def _published(self, session, resource_id, seen=None):
        self._uuid(resource_id)
        seen = set() if seen is None else seen
        if resource_id in seen:
            return
        seen.add(resource_id)
        published = self._json(session, f'/api/resources/{resource_id}/published')
        resource = published['resource']
        if resource['lifecycle_status'] != 'active' or not published['version']['version']:
            raise ChatError('CHAT_RESOURCE_UNAVAILABLE')
        for dependency in published.get('dependencies', []):
            try:
                self._published(session, dependency['resource_id'], seen)
            except ChatError as exc:
                if dependency.get('required', True) or str(exc) not in {'CHAT_NOT_FOUND', 'CHAT_FORBIDDEN', 'CHAT_CONFLICT', 'CHAT_RESOURCE_UNAVAILABLE'}:
                    raise
        return published

    def _load_thread(self, session, thread_id):
        thread = self._json(session, f'/api/threads/{thread_id}')
        runs = self._json(session, f'/api/threads/{thread_id}/runs')
        messages, before = [], None
        while True:
            suffix = f'&before_seq={before}' if before else ''
            page = self._json(session, f'/api/threads/{thread_id}/messages/page?limit=200{suffix}')
            messages = [row.get('content', {}) for row in page['data']] + messages
            if not page['has_more']:
                break
            cursor = page['next_before_seq']
            if cursor == before or not cursor:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            before = cursor
        try:
            state = self._json(session, f'/api/threads/{thread_id}/state')
            messages.extend(state.get('values', {}).get('messages', []))
        except ChatError as exc:
            if str(exc) != 'CHAT_NOT_FOUND' or runs:
                raise
        latest = max(runs, key=lambda r: r.get('created_at', '')) if runs else None
        selection = (latest or {}).get('metadata', {}).get('selection_snapshot', {})
        agent_id = selection.get('agent', {}).get('resource_id') or thread.get('metadata', {}).get('agent_name', '')
        if agent_id:
            try:
                self._uuid(agent_id)
            except ChatError:
                alias = urllib.parse.quote(str(agent_id), safe='')
                try:
                    agent_id = self._json(session, f'/api/resources/aliases/agent/{alias}')['id']
                except ChatError as exc:
                    if str(exc) not in {'CHAT_NOT_FOUND', 'CHAT_FORBIDDEN'}:
                        raise
                    agent_id = ''
        skill_id = selection.get('preferred_skill', {}).get('resource_id') or thread.get('metadata', {}).get('skill_resource_id', '')
        self._generation += 1
        self._state.update(thread=dict(id=thread_id, status=thread['status'],
            agentId=agent_id, skillId=skill_id),
            messages=[], events=[], run=self._run(latest) if latest else None,
            stream='idle', lastEventId='', error='')
        self._messages(messages)
        if self._state['run'] and self._state['run']['status'] in {'pending', 'running'}:
            self._observe(session)

    def _observe(self, session):
        if self._state['stream'] == 'streaming':
            return
        self._state.update(stream='streaming', error='')
        thread_id, run_id = self._state['thread']['id'], self._state['run']['id']
        generation = self._generation
        cursor = self._state['lastEventId']

        def consume():
            try:
                headers = {'Last-Event-ID': cursor} if cursor else {}
                with self._request(session, f'/api/threads/{thread_id}/runs/{run_id}/stream', headers=headers) as response:
                    event, data, event_id, size, ended = '', [], '', 0, False
                    streamed_ids = set()
                    while True:
                        line = response.readline(MAX_RESPONSE + 1)
                        if not line:
                            break
                        size += len(line)
                        if size > MAX_RESPONSE:
                            raise ChatError('CHAT_RESPONSE_TOO_LARGE')
                        text = line.decode('utf-8').rstrip('\r\n')
                        if text.startswith('event:'):
                            event = text[6:].strip()
                        elif text.startswith('data:'):
                            data.append(text[5:].lstrip())
                        elif text.startswith('id:'):
                            event_id = text[3:].strip()
                        elif not text:
                            with self._lock:
                                if generation != self._generation or self._session().scope != session.scope:
                                    return
                                if data:
                                    value = json.loads('\n'.join(data))
                                    if event_id:
                                        self._state['lastEventId'] = event_id
                                    root = event.split('|')[0]
                                    if root == 'messages' and '|' not in event and isinstance(value, list) and value:
                                        message_id = value[0].get('id')
                                        self._messages([value[0]], delta=message_id in streamed_ids)
                                        streamed_ids.add(message_id)
                                    elif root == 'values' and '|' not in event and isinstance(value, dict):
                                        self._messages(value.get('messages', []))
                                    elif root in {'error', 'gap'}:
                                        raise ChatError('CHAT_STREAM_ERROR' if root == 'error' else 'CHAT_STREAM_GAP')
                                    self._state['events'] = (self._state['events'] + [dict(id=event_id,
                                        event=event, detail=json.dumps(value, ensure_ascii=False)[:4000])])[-50:]
                                    if root == 'end':
                                        ended = True
                                        break
                            event, data, event_id, size = '', [], '', 0
                    if not ended:
                        raise ChatError('CHAT_STREAM_DISCONNECTED')
                with self._lock:
                    if generation == self._generation:
                        run = self._json(session, f'/api/threads/{thread_id}/runs/{run_id}')
                        self._state.update(run=self._run(run), stream='idle')
            except Exception as exc:
                with self._lock:
                    if generation == self._generation:
                        self._state.update(stream='disconnected', error=str(exc) if isinstance(exc, ChatError) else 'CHAT_STREAM_DISCONNECTED')

        threading.Thread(target=consume, daemon=True).start()

    def _send(self, session, command):
        turn_id = self._uuid(command.get('turnId'))
        if turn_id in self._turns:
            raise ChatError('CHAT_TURN_ALREADY_SUBMITTED')
        if not self._state['thread'] or command.get('threadId') != self._state['thread']['id']:
            raise ChatError('CHAT_THREAD_CHANGED')
        if self._state['stream'] != 'idle' or (self._state['run'] and self._state['run']['status'] in {'pending', 'running'}):
            raise ChatError('CHAT_TURN_IN_PROGRESS')
        thread = self._state['thread']
        agent_id = self._uuid(thread['agentId'])
        self._published(session, agent_id)
        text = command.get('text')
        additional_kwargs = {}
        answered = {m['response']['request_id'] for m in self._state['messages'] if m.get('response')}
        pending = next((m['request'] for m in reversed(self._state['messages']) if m.get('request') and
                        m['request'].get('request_id') not in answered), None)
        if command['action'] == 'send' and pending:
            raise ChatError('CHAT_HUMAN_INPUT_REQUIRED')
        if command['action'] == 'answer':
            if not pending or pending.get('request_id') != command.get('requestId'):
                raise ChatError('CHAT_HUMAN_INPUT_STALE')
            response = dict(version=1, kind='human_input_response', source=pending['source'],
                            request_id=pending['request_id'], response_kind='text', value=text)
            option_id = command.get('optionId')
            if option_id:
                option = next((o for o in pending.get('options', []) if o['id'] == option_id), None)
                if not option:
                    raise ChatError('CHAT_HUMAN_INPUT_INVALID')
                response.update(response_kind='option', option_id=option_id, value=option['value'])
            elif pending['input_mode'] == 'single_choice':
                raise ChatError('CHAT_HUMAN_INPUT_INVALID')
            if not isinstance(response['value'], str) or not response['value'].strip():
                raise ChatError('CHAT_HUMAN_INPUT_INVALID')
            text = f'For your clarification "{pending["question"]}", my answer is: {response["value"]}'
            additional_kwargs = {'hide_from_ui': True, 'human_input_response': response}
        if not isinstance(text, str) or not text.strip() or len(text) > 16000:
            raise ChatError('CHAT_MESSAGE_INVALID')
        message = dict(id=turn_id, type='human', content=text)
        if additional_kwargs:
            message['additional_kwargs'] = additional_kwargs
        self._turns.add(turn_id)
        body = dict(assistant_id=agent_id, input={'messages': [message]},
                    context={'agent_name': agent_id, **({'skill_resource_id': thread['skillId']} if thread['skillId'] else {})},
                    metadata={'desktop_turn_id': turn_id}, stream_mode=['messages-tuple', 'values', 'custom'],
                    stream_subgraphs=True, multitask_strategy='reject', on_disconnect='continue')
        try:
            run = self._json(session, f"/api/threads/{thread['id']}/runs", body, {'Idempotency-Key': turn_id})
        except ChatError:
            self._state['stream'] = 'uncertain'
            raise
        self._generation += 1
        self._state.update(run=self._run(run), lastEventId='', events=[], error='')
        self._observe(session)

    def _session(self):
        settings = load_settings(self.config)
        if self.login_status().get('state') != 'authenticated' or not settings.business_token_ref:
            raise ChatError('CHAT_UNAUTHENTICATED')
        if (not settings.business_expires_at or datetime.fromisoformat(settings.business_expires_at)
                <= datetime.now(timezone.utc)):
            raise ChatError('CHAT_UNAUTHENTICATED')
        origin = platform_origin(settings.server_url)
        scope = hashlib.sha256(f'{origin}\n{settings.user_id}\n{settings.business_token_ref}'.encode()).hexdigest()
        return ChatSession(scope, origin, settings.user_id, self.secure.get(settings.business_token_ref))

    def _request(self, session, path, body=None, headers=None):
        csrf = secrets.token_urlsafe(32)
        request_headers = {'Cookie': f'access_token={session.token}; csrf_token={csrf}',
                           'X-CSRF-Token': csrf, 'Origin': session.origin, 'Content-Type': 'application/json',
                           **(headers or {})}
        request = urllib.request.Request(session.origin + path, headers=request_headers,
                                         data=None if body is None else json.dumps(body).encode())
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            return opener.open(request, timeout=15)
        except urllib.error.HTTPError as exc:
            codes = {401: 'CHAT_UNAUTHENTICATED', 403: 'CHAT_FORBIDDEN', 404: 'CHAT_NOT_FOUND',
                     409: 'CHAT_CONFLICT', 422: 'CHAT_RESOURCE_UNAVAILABLE'}
            exc.close()
            raise ChatError(codes.get(exc.code, 'CHAT_SERVER_ERROR')) from None
        except (OSError, ValueError):
            raise ChatError('CHAT_SERVER_UNAVAILABLE') from None

    def _json(self, session, path, body=None, headers=None):
        with self._request(session, path, body, headers) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ChatError('CHAT_RESPONSE_TOO_LARGE')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise ChatError('CHAT_PROTOCOL_ERROR') from None

    def _authorize(self, session):
        account = self._json(session, '/api/v1/auth/me')
        if account.get('id') != session.user_id:
            raise ChatError('CHAT_IDENTITY_CHANGED')
        return account.get('system_role') in {'user', 'department_admin', 'super_admin'} and 'runs:create' in (account.get('permissions') or [])

    def _resources(self, session, can_run):
        resources = []
        for kind in ['agent', 'skill']:
            offset = 0
            while True:
                page = self._json(session, f'/api/resources?type={kind}&limit=200&offset={offset}')
                for item in page['items']:
                    available = can_run and item['lifecycle_status'] == 'active' and bool(item['latest_version'])
                    reason = '' if available else 'CHAT_RESOURCE_UNAVAILABLE'
                    if available:
                        try:
                            self._published(session, item['id'])
                        except ChatError as exc:
                            if str(exc) in {'CHAT_SERVER_UNAVAILABLE', 'CHAT_UNAUTHENTICATED'}:
                                raise
                            available, reason = False, str(exc)
                    resources.append(dict(id=item['id'], type=kind, name=item['display_name'],
                                          visibility=item['visibility'], version=item['latest_version'],
                                          available=available, reason=reason))
                offset += len(page['items'])
                if not page['items'] or offset >= page['total']:
                    break
        return resources

    def handle(self, command):
        with self._lock:
            session = None
            try:
                session = self._session()
                if session.scope != self._state['scope']:
                    self._reset(session.scope)
                action = command.get('action') if isinstance(command, dict) else None
                if action not in {'state', 'refresh'} and command.get('scope') != session.scope:
                    raise ChatError('CHAT_IDENTITY_CHANGED')
                can_run = self._authorize(session) if action != 'state' else False
                if action in {'create', 'send', 'answer'} and not can_run:
                    raise ChatError('CHAT_FORBIDDEN')
                if action == 'refresh':
                    resources = self._resources(session, can_run)
                    threads = self._json(session, '/api/threads/search', {'limit': 100})
                    self._state.update(resources=resources, threads=[dict(id=t['thread_id'],
                        title=t.get('values', {}).get('title') or t.get('metadata', {}).get('title') or t['thread_id'],
                        status=t['status']) for t in threads], error='')
                elif action == 'create':
                    agent_id = self._uuid(command.get('agentId'))
                    closure = set()
                    published = self._published(session, agent_id, closure)
                    if published['resource']['type'] != 'agent':
                        raise ChatError('CHAT_RESOURCE_UNAVAILABLE')
                    skill_id = command.get('skillId', '')
                    if skill_id:
                        self._published(session, self._uuid(skill_id))
                        if skill_id not in closure:
                            raise ChatError('CHAT_SKILL_OUTSIDE_AGENT')
                    metadata = {'agent_name': agent_id, 'skill_resource_id': skill_id}
                    created = self._json(session, '/api/threads', {'metadata': metadata})
                    self._load_thread(session, self._id(created['thread_id']))
                elif action == 'open':
                    self._load_thread(session, self._id(command.get('threadId')))
                elif action in {'send', 'answer'}:
                    self._send(session, command)
                elif action == 'reconnect':
                    if not self._state['thread'] or command.get('threadId') != self._state['thread']['id']:
                        raise ChatError('CHAT_THREAD_CHANGED')
                    self._load_thread(session, self._state['thread']['id'])
                elif action != 'state':
                    raise ChatError('CHAT_COMMAND_INVALID')
                if self._session().scope != session.scope:
                    raise ChatError('CHAT_IDENTITY_CHANGED')
            except SecretStoreError:
                self._reset()
                self._state['error'] = 'CHAT_SECURE_STORAGE_FAILED'
            except ChatError as exc:
                if str(exc) in {'CHAT_UNAUTHENTICATED', 'CHAT_IDENTITY_CHANGED'}:
                    self._reset()
                self._state['error'] = str(exc)
            except Exception:
                self._state['error'] = 'CHAT_PROTOCOL_ERROR'
            encoded = json.dumps(self._state)
            if len(encoded) > MAX_RESPONSE:
                result = empty_state(self._state['scope'])
                result['error'] = 'CHAT_RESPONSE_TOO_LARGE'
                return result
            if session:
                encoded = encoded.replace(session.token, '[REDACTED]')
            return json.loads(encoded)
