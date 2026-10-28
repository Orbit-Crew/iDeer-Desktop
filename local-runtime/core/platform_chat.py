"""Authenticated Desktop chat. All orchestration and durable history belong to Server."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path

from .artifacts import ArtifactUploadError, FileArtifactUploader
from .browser_login import _NoRedirect, platform_origin
from .local_results import LocalResultError
from .policy import PolicyDecision
from .receipt_ledger import profile_binding
from .secrets import SecretStore, SecretStoreError
from .settings import load_settings

MAX_RESPONSE = 2 * 1024 * 1024
# The workspace write boundary already caps a single result at MAX_TEXT_BYTES;
# the explicit upload path enforces the same bound before staging anything.
MAX_RESULT_BYTES = 65536


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
                events=[], stream='idle', error='', lastEventId='', stop=None,
                localTasks=[], taskError='', artifacts=[])


class DesktopChat:
    def __init__(self, config: Path, secure: SecretStore, login_status, *, local_consents=lambda: (), decide_consent=None,
                 local_receipts=lambda thread_id, run_ids: [], stop_local=lambda run_id: None, local_results=None,
                 compatibility_gate=None, knowledge_imports=None, knowledge_files=None):
        self.config, self.secure, self.login_status = config, secure, login_status
        self._lock = threading.RLock()
        self._state = empty_state()
        self._turns = set()
        self._generation = 0
        self.local_consents, self.decide_consent = local_consents, decide_consent
        self.local_receipts = local_receipts
        self.stop_local = stop_local
        self.local_results = local_results
        self.compatibility_gate = compatibility_gate
        # Issue 112: explicit local imports reuse this session's transport
        # discipline; the registry keeps device-local display facts and the
        # file callback yields the confirmed workspace store for reads.
        self.knowledge_imports = knowledge_imports
        self.knowledge_files = knowledge_files
        self._tasks_checked = 0.0
        self._tasks_loading = None

    def _consents(self, session):
        rows = []
        thread, run = self._state.get('thread'), self._state.get('run')
        if not thread or not run:
            return rows
        if self._state.get('stop') or run['status'] not in {'pending', 'running'}:
            return rows
        try:
            pending_rows = self.local_consents()
        except Exception:
            raise ChatError('CONSENT_UNAVAILABLE') from None
        for pending in pending_rows:
            payload = pending.payload
            if pending.capability != 'local.files.write' or payload.get('thread_id') != thread['id'] or payload.get('run_id') != run['id']:
                continue
            args = payload.get('arguments', payload.get('args', payload))
            if not isinstance(args, dict) or not isinstance(args.get('path'), str) or not isinstance(args.get('content'), str):
                continue
            row = dict(taskId=pending.task_id, runId=run['id'], threadId=thread['id'],
                requestHash=pending.request_hash, path=args['path'], content=args['content'])
            row['directory'] = pending.summary.get('directory', '')
            # The credential scrubber must remain active, but a scrubbed card
            # cannot authorize bytes the user could not see. Check on both
            # display and decision paths, before calling the local approver.
            if session.token and (session.token in json.dumps(row) or any(session.token in str(value) for value in row.values())):
                raise ChatError('CONSENT_CONTENT_REDACTED')
            rows.append(row)
        return rows

    def _reset(self, scope=''):
        self._generation += 1
        self._state = empty_state(scope)
        self._turns.clear()
        self._tasks_checked = 0.0
        self._tasks_loading = None

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
        def identity(key, kind):
            # Match Server/Web identity across DynamicContext's human rewrite.
            return (key.removesuffix('__user') or key) if kind == 'human' else key

        by_id = {identity(m['id'], m['role']): m for m in self._state['messages']}
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
            message_identity = identity(key, kind)
            if delta and message_identity in by_id:
                text = by_id[message_identity]['text'] + text
            request = (raw.get('artifact') or {}).get('human_input') if isinstance(raw.get('artifact'), dict) else None
            by_id[message_identity] = dict(id=key, role=kind, text=text, name=raw.get('name', ''),
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
            stream='idle', lastEventId='', error='', stop=None, localTasks=[], taskError='', artifacts=[])
        self._messages(messages)
        self._load_tasks(session)
        if self._state['run'] and self._state['run']['status'] in {'pending', 'running'}:
            self._observe(session)

    def _load_tasks(self, session):
        """Observation only. A recovered task can never submit a new Turn."""
        self._tasks_checked = time.monotonic()
        thread_id = self._state['thread']['id']
        tasks, error, artifacts = self._task_history(session, thread_id, self._state['localTasks'])
        self._state.update(localTasks=tasks, taskError=error, artifacts=artifacts)

    def _artifacts(self, session, thread_id):
        """Read Server-owned attachments independently of device-local history."""
        artifacts, offset, size = [], 0, 0
        while True:
            page = self._json(session, f'/api/threads/{thread_id}/artifacts?limit=50&offset={offset}')
            if not isinstance(page, dict) or not isinstance(page.get('artifacts'), list):
                raise ChatError('CHAT_PROTOCOL_ERROR')
            size += len(json.dumps(page))
            if size > MAX_RESPONSE:
                raise ChatError('CHAT_RESPONSE_TOO_LARGE')
            for row in page['artifacts']:
                if (not isinstance(row, dict) or row.get('thread_id') != thread_id
                        or not isinstance(row.get('name'), str) or not 1 <= len(row['name']) <= 255
                        or any(c in row['name'] for c in '/\\\x00\r\n')
                        or not isinstance(row.get('sha256'), str) or len(row['sha256']) != 64
                        or any(c not in '0123456789abcdef' for c in row['sha256'])
                        or type(row.get('bytes')) is not int or not 0 <= row['bytes'] <= MAX_RESULT_BYTES):
                    raise ChatError('CHAT_PROTOCOL_ERROR')
                self._id(row.get('artifact_id'))
                artifacts.append({key: row.get(key, '') for key in
                    ('artifact_id', 'thread_id', 'name', 'sha256', 'bytes', 'task_id', 'run_id')})
            if not page.get('has_more'):
                return artifacts
            cursor = page.get('next_offset')
            if type(cursor) is not int or cursor <= offset:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            offset = cursor

    def _task_history(self, session, thread_id, tasks):
        error = ''
        artifacts = []
        try:
            loaded, offset, size = [], 0, 0
            while True:
                page = self._json(session, f'/api/threads/{thread_id}/local-tasks?limit=50&offset={offset}')
                size += len(json.dumps(page))
                if size > MAX_RESPONSE:
                    raise ChatError('CHAT_RESPONSE_TOO_LARGE')
                loaded.extend(page['tasks'])
                if not page['has_more']:
                    break
                cursor = page['next_offset']
                if not isinstance(cursor, int) or cursor <= offset:
                    raise ChatError('CHAT_PROTOCOL_ERROR')
                offset = cursor
            tasks = loaded
        except ChatError as exc:
            if str(exc) in {'CHAT_UNAUTHENTICATED', 'CHAT_IDENTITY_CHANGED'}:
                raise
            error = str(exc)
        except Exception:
            error = 'CHAT_TASK_HISTORY_UNAVAILABLE'
        try:
            artifacts = self._artifacts(session, thread_id)
        except ChatError as exc:
            if str(exc) in {'CHAT_UNAUTHENTICATED', 'CHAT_IDENTITY_CHANGED'}:
                raise
            error = str(exc)
        try:
            local = {row['task_id']: row for row in self.local_receipts(thread_id, {row['run_id'] for row in tasks})}
            merged = []
            for task in tasks:
                row = local.pop(task['task_id'], None)
                merged.append({**task, 'local': row})
            merged.extend(dict(task_id=row['task_id'], run_id=row['run_id'], capability=row.get('capability', ''),
                logical_target=row.get('logical_target', ''), status='unknown', local=row) for row in local.values())
            return self._merge_local_results(thread_id, merged), error, artifacts
        except Exception:
            return tasks, 'CHAT_TASK_HISTORY_UNAVAILABLE', artifacts

    def _merge_local_results(self, thread_id, merged):
        """Attach the device-local result registry view; failures hide nothing else.

        Registry rows stay metadata-only and identity-bound: another device (or
        another account on this one) sees the Server's task rows and platform
        attachments, never this device's registered local results.
        """
        results = {}
        if self.local_results is not None:
            try:
                binding = profile_binding(load_settings(self.config))
                if binding is not None:
                    results = {row['task_id']: row for row in self.local_results.view(
                        binding, thread_id, {row['run_id'] for row in merged})}
            except Exception:
                results = {}
            for row in merged:
                row['localResult'] = results.pop(row['task_id'], None)
            merged.extend(dict(task_id=row['task_id'], run_id=row['run_id'], capability=row.get('capability', ''),
                logical_target=row.get('logical_path', ''), status='unknown', local=None, localResult=row)
                for row in results.values())
        return merged

    def _poll_tasks(self, session):
        """Network observations cannot hold up a user's local Stop command."""
        if self._tasks_loading is not None:
            return
        ticket = object()
        self._tasks_loading = ticket
        self._tasks_checked = time.monotonic()
        generation = self._generation
        thread_id = self._state['thread']['id']
        tasks = self._state['localTasks']
        stopped = self._state.get('stop')
        active = self._state['run'] and self._state['run']['status'] in {'pending', 'running'}

        def refresh():
            try:
                rows, error, artifacts = self._task_history(session, thread_id, tasks)
                run = self._json(session, f"/api/threads/{thread_id}/runs/{stopped['runId']}") if stopped and active else None
                with self._lock:
                    if generation != self._generation:
                        return
                    if self._session().scope != session.scope:
                        raise ChatError('CHAT_IDENTITY_CHANGED')
                    self._state.update(localTasks=rows, taskError=error, artifacts=artifacts)
                    if run:
                        self._state['run'] = self._run(run)
                        if run['status'] not in {'pending', 'running'}:
                            self._generation += 1
                            self._state['stream'] = 'idle'
            except Exception as exc:
                with self._lock:
                    if generation == self._generation:
                        code = str(exc) if isinstance(exc, ChatError) else 'CHAT_TASK_HISTORY_UNAVAILABLE'
                        if code in {'CHAT_UNAUTHENTICATED', 'CHAT_IDENTITY_CHANGED'}:
                            self._reset()
                        self._state['taskError'] = code
            finally:
                with self._lock:
                    if self._tasks_loading is ticket:
                        self._tasks_loading = None
        threading.Thread(target=refresh, daemon=True).start()

    def _stop(self, session, command):
        if set(command) != {'action', 'scope', 'threadId', 'runId'}:
            raise ChatError('CHAT_COMMAND_INVALID')
        thread, run = self._state['thread'], self._state['run']
        if not thread or command['threadId'] != thread['id'] or not run or command['runId'] != run['id']:
            raise ChatError('CHAT_THREAD_CHANGED')
        if (self._state.get('stop') or {}).get('state') == 'requested' or run['status'] not in {'pending', 'running'}:
            return
        # Persisted Server state remains authoritative. An accepted request is
        # not proof of cancellation or of whether a local effect occurred.
        self._state['stop'] = {'runId': run['id'], 'state': 'uncertain'}
        try:
            self.stop_local(run['id'])
        except Exception:
            # Still attempt Server cancellation if the local controller failed.
            self._state['taskError'] = 'CHAT_LOCAL_STOP_UNAVAILABLE'
        with self._request(session, f"/api/threads/{thread['id']}/runs/{run['id']}/cancel?wait=false&action=interrupt", {}) as response:
            if response.status not in {202, 204}:
                raise ChatError('CHAT_PROTOCOL_ERROR')
        self._state['stop']['state'] = 'requested'
        self._state['error'] = ''

    def _upload(self, session, command):
        """Turn one registered local result into a Thread artifact, explicitly.

        Every rejection is a fixed error category and leaves the registry
        unmarked: a failed upload never displays as success, and nothing is
        sent while local policy, identity, ownership or content verification
        fails. The Server stays the authority on artifact visibility.
        """
        thread, thread_id = self._state['thread'], self._id(command['threadId'])
        task_id, run_id = self._id(command['taskId']), self._id(command['runId'])
        if not thread or thread['id'] != thread_id:
            raise ChatError('CHAT_THREAD_CHANGED')
        settings = load_settings(self.config)
        binding = profile_binding(settings)
        if binding is None:
            raise ChatError('UPLOAD_RESULT_NOT_FOUND')
        try:
            row = self.local_results.get(binding, task_id)
        except LocalResultError:
            raise ChatError('UPLOAD_STORAGE_UNAVAILABLE') from None
        if row is None:
            raise ChatError('UPLOAD_RESULT_NOT_FOUND')
        if row['thread_id'] != thread_id or row['run_id'] != run_id:
            raise ChatError('CHAT_THREAD_CHANGED')
        if row['artifact_ref']:
            # Idempotent replay: the registered fact already carries the
            # platform reference, so no new request, grant or record is made.
            self._load_tasks(session)
            self._state['error'] = ''
            return
        self._check_compatibility('local.artifacts.upload')
        upload_basis = {'task_id': task_id, 'run_id': run_id, 'thread_id': thread_id,
                        'name': row['name'], 'sha256': row['sha256']}
        decision = settings.policy().authorize('local.artifacts.upload', upload_basis, consent=True)
        if decision is not PolicyDecision.ALLOW:
            raise ChatError('UPLOAD_POLICY_DENIED')
        raw = self._read_local_result(row)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != row['sha256']:
            raise ChatError('UPLOAD_CONTENT_CHANGED')
        try:
            handle = FileArtifactUploader(Path(self.config.parent) / 'artifact-staging',
                                          max_bytes=MAX_RESULT_BYTES).upload(row['name'], raw)
        except ArtifactUploadError:
            raise ChatError('UPLOAD_STAGING_FAILED') from None
        if handle != f'local://{digest}/{row["name"]}':
            raise ChatError('UPLOAD_STAGING_FAILED')
        grant_basis = {key: value for key, value in upload_basis.items() if key != 'thread_id'}
        grant_basis.update(device_id=settings.device_id, bytes=len(raw))
        issued = self._json(session, f'/api/threads/{thread_id}/artifacts/grant', grant_basis,
                            self._device_headers(session, binding))
        if (not isinstance(issued, dict) or not isinstance(issued.get('token'), str)
                or not 16 <= len(issued['token']) <= 512
                or any(issued.get(key) != value for key, value in
                       {'run_id': run_id, 'task_id': task_id, 'thread_id': thread_id,
                        'name': row['name'], 'device_id': settings.device_id}.items())):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        # A slow grant response cannot authorize bytes from a retired account,
        # device binding, or a newly denied policy. Re-read through the current
        # workspace grant before sending content to the Server.
        headers = self._device_headers(session, binding)
        self._check_compatibility('local.artifacts.upload')
        current = load_settings(self.config)
        if current.policy().authorize('local.artifacts.upload', upload_basis, consent=True) is not PolicyDecision.ALLOW:
            raise ChatError('UPLOAD_POLICY_DENIED')
        if self._read_local_result(row) != raw:
            raise ChatError('UPLOAD_CONTENT_CHANGED')
        body = {'version': 1, 'kind': 'local_result', 'task_id': task_id, 'run_id': run_id,
                'name': row['name'], 'sha256': digest, 'bytes': len(raw),
                'content': base64.b64encode(raw).decode('ascii'), 'handle': handle,
                'grant': {'run_id': run_id, 'task_id': task_id, 'thread_id': thread_id,
                          'name': row['name'], 'token': issued['token']}}
        created = self._json(session, f'/api/threads/{thread_id}/artifacts', body,
                             {**headers, 'Idempotency-Key': handle})
        self._device_headers(session, binding)
        artifact_id = created.get('artifact_id') if isinstance(created, dict) else None
        if (not isinstance(artifact_id, str) or not 1 <= len(artifact_id) <= 128
                or created.get('name') != row['name'] or created.get('sha256') != digest
                or created.get('bytes') != len(raw) or created.get('thread_id') != thread_id):
            # The Server must confirm exactly what was uploaded before the
            # local fact can claim a platform artifact.
            raise ChatError('CHAT_PROTOCOL_ERROR')
        try:
            self.local_results.mark_uploaded(binding, task_id, artifact_id)
        except LocalResultError as exc:
            code = 'UPLOAD_STORAGE_UNAVAILABLE' if 'STORAGE' in str(exc) else 'RESULT_UPLOAD_CONFLICT'
            raise ChatError(code) from None
        self._load_tasks(session)
        self._state['error'] = ''

    def _device_headers(self, session, binding):
        settings = load_settings(self.config)
        if self._session().scope != session.scope or profile_binding(settings) != binding:
            raise ChatError('CHAT_IDENTITY_CHANGED')
        if not settings.session_token_ref:
            raise ChatError('UPLOAD_DEVICE_UNAVAILABLE')
        token = self.secure.get(settings.session_token_ref)
        if not token:
            raise ChatError('UPLOAD_DEVICE_UNAVAILABLE')
        return {'X-Device-Session': token}

    def _check_compatibility(self, operation):
        if self.compatibility_gate is not None:
            code = self.compatibility_gate.authorize(operation)
            if code:
                raise ChatError(code)

    def _download(self, session, command):
        if set(command) != {'action', 'scope', 'threadId', 'artifactId'}:
            raise ChatError('CHAT_COMMAND_INVALID')
        thread_id, artifact_id = self._id(command['threadId']), self._id(command['artifactId'])
        if not self._state['thread'] or self._state['thread']['id'] != thread_id:
            raise ChatError('CHAT_THREAD_CHANGED')
        # Fetch owner-authorized metadata again. A download never uses a
        # renderer URL, a local workspace, or this device's result registry.
        artifact = next((row for row in self._artifacts(session, thread_id)
                         if row['artifact_id'] == artifact_id), None)
        if artifact is None:
            raise ChatError('CHAT_ARTIFACT_NOT_FOUND')
        with self._request(session, f'/api/threads/{thread_id}/artifacts/{artifact_id}/download') as response:
            raw = response.read(MAX_RESULT_BYTES + 1)
            echoed_hash = response.headers.get('X-Content-SHA256')
        if (len(raw) != artifact['bytes'] or hashlib.sha256(raw).hexdigest() != artifact['sha256']
                or echoed_hash != artifact['sha256']):
            raise ChatError('CHAT_ARTIFACT_INTEGRITY')
        if self._session().scope != session.scope:
            raise ChatError('CHAT_IDENTITY_CHANGED')
        return {**artifact, 'content': base64.b64encode(raw).decode('ascii')}

    def _read_local_result(self, row) -> bytes:
        """Read the registered bytes through the current workspace grant only."""
        from .file_service import MAX_TEXT_BYTES, WorkspaceFileStore, WorkspaceSelection
        from .files import FileAccessError, RootConfig
        selection = WorkspaceSelection(self.config)
        try:
            _, grant = selection.current()
            files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
                identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(self.config.parent,))
            raw = files.read_bytes(row['logical_path'], max_bytes=MAX_TEXT_BYTES + 1)
        except (FileAccessError, OSError, ValueError, TypeError):
            raise ChatError('UPLOAD_LOCAL_FILE_UNAVAILABLE') from None
        if len(raw) > MAX_RESULT_BYTES or grant['logical_root'] != row['logical_root']:
            raise ChatError('UPLOAD_LOCAL_FILE_UNAVAILABLE')
        return raw

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
        from .file_service import WorkspaceSelection
        workspace = WorkspaceSelection(self.config).status()
        local_context = {}
        if workspace['state'] == 'ready':
            settings = load_settings(self.config)
            local_context = {'local_device_id': settings.device_id,
                             'local_workspace_root': workspace['logicalRoot']}
        body = dict(assistant_id=agent_id, input={'messages': [message]},
                    context={'agent_name': agent_id, **local_context, **({'skill_resource_id': thread['skillId']} if thread['skillId'] else {})},
                    metadata={'desktop_turn_id': turn_id}, stream_mode=['messages-tuple', 'values', 'custom'],
                    stream_subgraphs=True, multitask_strategy='reject', on_disconnect='continue')
        try:
            run = self._json(session, f"/api/threads/{thread['id']}/runs", body, {'Idempotency-Key': turn_id})
        except ChatError:
            self._state['stream'] = 'uncertain'
            raise
        self._generation += 1
        self._state.update(run=self._run(run), lastEventId='', events=[], error='', stop=None)
        self._observe(session)

    def _session(self):
        settings = load_settings(self.config)
        if self.login_status().get('state') != 'authenticated' or not settings.business_token_ref:
            raise ChatError('CHAT_UNAUTHENTICATED')
        if (not settings.business_expires_at or datetime.fromisoformat(settings.business_expires_at)
                <= datetime.now(timezone.utc)):
            raise ChatError('CHAT_UNAUTHENTICATED')
        origin = platform_origin(settings.server_url)
        scope = hashlib.sha256(json.dumps([origin, settings.user_id, settings.business_token_ref,
                                           profile_binding(settings)], sort_keys=True).encode()).hexdigest()
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

    # --- Explicit local knowledge imports (issue 112) -----------------------

    def register_local_import(self, kb_id, paths):
        """Freeze one explicit local import as a platform Revision manifest.

        The platform call carries identity fields only; original bytes and the
        device index never leave this device. A failed attempt is recorded as
        failed with its real category and never impersonates a registration.
        """
        from .knowledge_import import (MAX_IMPORT_DOCUMENTS, KnowledgeImportError, build_manifest,
                                       category_for, logical_paths_for, registration_payload)
        from .files import FileAccessError
        from .receipt_ledger import profile_binding
        from .settings import load_settings
        if self.knowledge_imports is None or self.knowledge_files is None:
            raise ChatError('CHAT_COMMAND_INVALID')
        session = self._session()
        kb_id = self._uuid(kb_id)
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_IMPORT_DOCUMENTS \
                or any(not isinstance(path, str) or not path or len(path) > 32768 for path in paths):
            raise ChatError('CHAT_COMMAND_INVALID')
        try:
            settings, grant, files = self.knowledge_files()
        except (FileAccessError, KnowledgeImportError) as exc:
            raise KnowledgeImportError(category_for(exc)) from exc
        binding = profile_binding(load_settings(self.config))
        try:
            entries = build_manifest(files, logical_paths_for(grant, list(paths)))
            created = self._json(session, f'/api/resources/{kb_id}/knowledge-revisions/local-imports',
                                 registration_payload(entries, settings.device_id))
            if not isinstance(created, dict) or not isinstance(created.get('id'), str) \
                    or type(created.get('revision_no')) is not int \
                    or not isinstance(created.get('manifest_hash'), str) or len(created['manifest_hash']) != 64 \
                    or created.get('document_count') != len(entries):
                raise ChatError('CHAT_PROTOCOL_ERROR')
        except (KnowledgeImportError, ChatError) as exc:
            # The failure is recorded with its real fixed category so the
            # display never impersonates a registered revision.
            category = str(exc)
            try:
                self.knowledge_imports.record(binding, dict(kb_id=kb_id, status='failed',
                    error_code=category, documents=[]))
            except KnowledgeImportError:
                pass
            raise KnowledgeImportError(category) from exc
        outcome = dict(kbId=kb_id, revisionId=created['id'], revisionNo=created['revision_no'],
                       manifestHash=created['manifest_hash'], documentCount=created['document_count'])
        self.knowledge_imports.record(binding, dict(kb_id=kb_id, status='registered',
            revision_id=created['id'], revision_no=created['revision_no'],
            manifest_hash=created['manifest_hash'], document_count=created['document_count'],
            documents=entries))
        return outcome

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
            download = None
            try:
                session = self._session()
                if session.scope != self._state['scope']:
                    self._reset(session.scope)
                action = command.get('action') if isinstance(command, dict) else None
                if action not in {'state', 'refresh', 'compatibility'} and command.get('scope') != session.scope:
                    raise ChatError('CHAT_IDENTITY_CHANGED')
                can_run = self._authorize(session) if action not in {'state', 'consent', 'stop'} else False
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
                elif action == 'stop':
                    self._stop(session, command)
                elif action == 'reconnect':
                    if not self._state['thread'] or command.get('threadId') != self._state['thread']['id']:
                        raise ChatError('CHAT_THREAD_CHANGED')
                    self._load_thread(session, self._state['thread']['id'])
                elif action == 'consent':
                    expected = {'action', 'scope', 'threadId', 'runId', 'taskId', 'requestHash', 'decision'}
                    if set(command) != expected or command.get('decision') not in {'allow', 'allow-directory', 'deny'} or self.decide_consent is None:
                        raise ChatError('CHAT_COMMAND_INVALID')
                    pending = next((row for row in self._consents(session) if all(command.get(key) == row[key] for key in ('threadId', 'runId', 'taskId', 'requestHash'))), None)
                    if pending is None:
                        raise ChatError('CONSENT_MISMATCH')
                    try:
                        if command['decision'] == 'allow-directory':
                            self.decide_consent(command['taskId'], command['requestHash'], True, directory=True)
                        else:
                            self.decide_consent(command['taskId'], command['requestHash'], command['decision'] == 'allow')
                    except Exception:
                        raise ChatError('CONSENT_UNAVAILABLE') from None
                    self._state['error'] = ''
                elif action == 'upload':
                    # Issue 105: the only path from a registered local result to a
                    # platform artifact. It exists solely behind this explicit,
                    # user-authorized command; every observation path above is
                    # upload-free by construction.
                    expected = {'action', 'scope', 'threadId', 'runId', 'taskId', 'decision'}
                    if (set(command) != expected or command.get('decision') != 'allow'
                            or self.local_results is None):
                        raise ChatError('CHAT_COMMAND_INVALID')
                    self._upload(session, command)
                elif action == 'download':
                    download = self._download(session, command)
                    self._state['error'] = ''
                elif action == 'compatibility':
                    if set(command) != {'action'} or self.compatibility_gate is None:
                        raise ChatError('CHAT_COMMAND_INVALID')
                    self._state['compatibility'] = self.compatibility_gate.refresh()
                    self._state['error'] = ''
                elif action != 'state':
                    raise ChatError('CHAT_COMMAND_INVALID')
                if self._session().scope != session.scope:
                    raise ChatError('CHAT_IDENTITY_CHANGED')
                if action == 'state' and self._state['thread'] and time.monotonic() - self._tasks_checked >= 2:
                    self._poll_tasks(session)
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
            try:
                self._state['localConsents'] = self._consents(session) if session and self._state['scope'] else []
                if self._state['error'] in {'CONSENT_UNAVAILABLE', 'CONSENT_CONTENT_REDACTED'}:
                    self._state['error'] = ''
            except ChatError as exc:
                self._state.update(localConsents=[], error=str(exc))
            encoded = json.dumps(self._state)
            if len(encoded) > MAX_RESPONSE:
                result = empty_state(self._state['scope'])
                result['error'] = 'CHAT_RESPONSE_TOO_LARGE'
                return result
            if session:
                encoded = encoded.replace(session.token, '[REDACTED]')
            result = json.loads(encoded)
            if self.compatibility_gate is not None:
                result['compatibility'] = self.compatibility_gate.snapshot()
            if download is not None and not result['error']:
                # Only the requesting main-process call receives bytes; no
                # polling snapshot or persisted history retains the payload.
                result['download'] = download
            return result
