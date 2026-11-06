"""Scheduled-task management commands against the pinned platform contract (#85).

The fixture implements the REST surface of the pinned router
(backend/app/gateway/routers/scheduled_tasks.py @ a7037c3f): the cron preview,
task CRUD, pause/resume/trigger, the per-task run listing, and the identity
fence. The device-side catch-up ledger is exercised against it: a missed
planned point (the platform's own next_run_at the device last observed) is
caught up once with a marking, never twice, and a task may be set to skip
missed points. The agent-config 修复项 is asserted on the wire: the assistant
the user chose really reaches the platform create/update payload.
"""
import json
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

TASK_ID = 'task-a1b2c3d4'
KNOWN_ZONES = {'UTC', 'Asia/Shanghai', 'America/New_York'}
MAX_INTERVAL = 30 * 24 * 3600
MIN_ONCE_DELAY = 60


def iso(*offset_minutes):
    base = datetime(2026, 3, 2, 9, 0, 0, tzinfo=timezone.utc)
    return (base + timedelta(minutes=sum(offset_minutes))).isoformat()


def normalize_cron(cron):
    """The pinned router's normalize_cron_expression, as far as the fixture's
    known vocabulary goes: weekday names become numbers."""
    names = {'MON': '1', 'TUE': '2', 'WED': '3', 'THU': '4', 'FRI': '5', 'SAT': '6', 'SUN': '7'}
    fields = cron.split()
    if len(fields) == 5 and fields[4].upper() in names:
        fields[4] = names[fields[4].upper()]
        return ' '.join(fields)
    return cron


def next_run_at_now(schedule_type, spec, now):
    """The fixture's own compute_next_run_at for the vocabulary it accepts."""
    if schedule_type == 'once':
        return spec['run_at']
    if schedule_type == 'interval':
        return (now + timedelta(seconds=spec['every_seconds'])).isoformat()
    minute, hour = (int(part) for part in spec['cron'].split()[:2])
    candidate = now.replace(minute=minute, hour=hour, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate.isoformat()


@contextmanager
def platform(tasks=None, runs=None, trigger_status=200, cron_hour=9):
    """A minimal scheduled-tasks fixture following the pinned router contract.

    ``tasks`` maps task id to its platform row (snake_case, as the repo returns
    them); ``runs`` maps task id to a list of run rows. Every request is
    recorded so the tests can assert the exact platform payloads.
    """
    lock = threading.Lock()
    tasks = dict(tasks or {})
    runs = {key: list(value) for key, value in (runs or {}).items()}
    records = []
    run_seq = [0]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0) or 0)
            self.respond(json.loads(self.rfile.read(length)) if length else None)

        def do_PATCH(self):
            self.respond(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))))

        def do_DELETE(self):
            self.respond(None)

        def refuse(self, code, detail):
            return code, {'detail': detail}

        def respond(self, body):
            records.append((self.command, self.path, body, dict(self.headers)))
            cookie = self.headers.get('Cookie', '')
            user = 'B' if 'business-B' in cookie else 'A'
            status, data = 200, None
            now = datetime(2026, 3, 2, 8, 30, 0, tzinfo=timezone.utc)
            with lock:
                if self.path == '/api/scheduled-tasks/preview-cron':
                    if not isinstance(body, dict) or not isinstance(body.get('cron'), str) \
                            or body.get('timezone') not in KNOWN_ZONES \
                            or type(body.get('count')) is not int or not 1 <= body['count'] <= 10:
                        status, data = self.refuse(422, 'bad preview')
                    else:
                        zone = body['timezone']
                        offset = timedelta(hours=8) if zone == 'Asia/Shanghai' else timedelta(hours=-5) \
                            if zone == 'America/New_York' else timedelta(0)
                        occurrences = []
                        cursor = now
                        for _ in range(body['count']):
                            run_at = cursor.replace(hour=cron_hour, minute=0, second=0, microsecond=0)
                            if run_at <= cursor:
                                run_at += timedelta(days=1)
                            occurrences.append(dict(run_at=run_at.isoformat(),
                                                    local_time=run_at.astimezone(timezone(offset)).isoformat()))
                            cursor = run_at
                        data = dict(cron=normalize_cron(body['cron']), timezone=zone,
                                    start_at=now.isoformat(), occurrences=occurrences)
                elif self.path == '/api/scheduled-tasks':
                    if self.command == 'GET':
                        data = [dict(task) for task in tasks.values() if task['user_id'] == user]
                    elif self.command == 'POST':
                        status, data = self.create(body, user, now)
                    else:
                        status, data = self.refuse(405, 'method')
                elif self.path.startswith('/api/scheduled-tasks/'):
                    parts = self.path.split('?')[0].rstrip('/').split('/')
                    task_id, tail = parts[3], parts[4:]
                    task = tasks.get(task_id)
                    if task is None or task['user_id'] != user:
                        status, data = self.refuse(404, 'Scheduled task not found')
                    elif not tail:
                        if self.command == 'GET':
                            data = dict(task)
                        elif self.command == 'PATCH':
                            status, data = self.update(task, body, now)
                        elif self.command == 'DELETE':
                            del tasks[task_id]
                            data = {'id': task_id, 'deleted': True}
                        else:
                            status, data = self.refuse(405, 'method')
                    elif tail == ['pause']:
                        if task['status'] == 'running':
                            status, data = self.refuse(409, 'running')
                        else:
                            task['status'] = 'paused'
                            data = dict(task)
                    elif tail == ['resume']:
                        task['status'] = 'enabled'
                        data = dict(task)
                    elif tail == ['trigger']:
                        if trigger_status != 200:
                            status, data = self.refuse(trigger_status, 'dispatch refused')
                        else:
                            run_seq[0] += 1
                            runs.setdefault(task_id, []).append(
                                dict(id=f'run-{run_seq[0]}', task_id=task_id, status='queued',
                                     planned_for=task.get('next_run_at'), trigger='manual',
                                     created_at=iso()))
                            data = {'id': task_id, 'triggered': True}
                    elif tail == ['runs']:
                        data = [row for row in runs.get(task_id, []) if row.get('visible', True)]
                    else:
                        status, data = self.refuse(404, 'Not visible')
                elif self.command == 'GET' and self.path == '/api/threads/thread-9/scheduled-tasks':
                    data = [dict(task) for task in tasks.values()
                            if task['user_id'] == user and task.get('thread_id') == 'thread-9']
                elif self.path == '/api/v1/auth/me':
                    data = {'id': user, 'email': user + '@test.invalid', 'system_role': 'user',
                            'permissions': ['threads:read', 'threads:write', 'runs:create']}
                else:
                    status, data = self.refuse(404, 'Not visible')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())

        def create(self, body, user, now):
            """The pinned create endpoint's own validation and normalization."""
            if not isinstance(body, dict):
                return self.refuse(422, 'bad body')
            if body.get('context_mode') not in {'fresh_thread_per_run', 'reuse_thread'}:
                return self.refuse(422, 'context_mode')
            if body['context_mode'] == 'reuse_thread' and not body.get('thread_id'):
                return self.refuse(422, 'thread_id')
            if body.get('schedule_type') not in {'once', 'cron', 'interval'}:
                return self.refuse(422, 'schedule_type')
            if body.get('timezone') not in KNOWN_ZONES:
                return self.refuse(422, 'timezone')
            if not isinstance(body.get('title'), str) or not body['title'] \
                    or not isinstance(body.get('prompt'), str) or not body['prompt']:
                return self.refuse(422, 'title/prompt')
            spec = dict(body.get('schedule_spec') or {})
            schedule_type = body['schedule_type']
            if schedule_type == 'cron':
                if not isinstance(spec.get('cron'), str):
                    return self.refuse(422, 'cron spec')
                spec['cron'] = normalize_cron(spec['cron'])
            if schedule_type == 'interval':
                seconds = spec.get('every_seconds')
                if type(seconds) is not int or not MIN_ONCE_DELAY <= seconds <= MAX_INTERVAL:
                    return self.refuse(422, 'interval bounds')
            if schedule_type == 'once':
                try:
                    run_at = datetime.fromisoformat(spec.get('run_at', ''))
                except ValueError:
                    return self.refuse(422, 'run_at')
                if (run_at - now).total_seconds() < MIN_ONCE_DELAY:
                    return self.refuse(422, 'once too soon')
            assistant = body.get('assistant_id')
            if assistant is not None:
                assistant = assistant.lower().replace('_', '-')
                if not assistant or not assistant.replace('-', '').isalnum():
                    return self.refuse(422, 'assistant_id')
                if assistant == 'lead-agent':
                    assistant = 'lead_agent'
            task_id = f'task-{len(tasks) + 1:08x}'
            row = dict(id=task_id, user_id=user,
                       thread_id=body.get('thread_id') if body['context_mode'] == 'reuse_thread' else None,
                       context_mode=body['context_mode'], assistant_id=assistant or 'lead_agent',
                       title=body['title'], prompt=body['prompt'], schedule_type=schedule_type,
                       schedule_spec=spec, timezone=body['timezone'],
                       next_run_at=next_run_at_now(schedule_type, spec, now), status='enabled',
                       created_at=iso(-1), updated_at=iso(0))
            tasks[task_id] = row
            return 200, dict(row)

        def update(self, task, body, now):
            """The pinned update endpoint: partial merge, cron renormalized,
            next_run_at recomputed when the plan changed."""
            if not isinstance(body, dict) or not body:
                return self.refuse(422, 'empty patch')
            updates = {key: value for key, value in body.items() if value is not None}
            if 'context_mode' in updates and updates['context_mode'] not in \
                    {'fresh_thread_per_run', 'reuse_thread'}:
                return self.refuse(422, 'context_mode')
            if 'timezone' in updates and updates['timezone'] not in KNOWN_ZONES:
                return self.refuse(422, 'timezone')
            if 'assistant_id' in updates:
                assistant = str(updates['assistant_id']).lower().replace('_', '-')
                if not assistant or not assistant.replace('-', '').isalnum():
                    return self.refuse(422, 'assistant_id')
                updates['assistant_id'] = 'lead_agent' if assistant == 'lead-agent' else assistant
            spec = dict(task['schedule_spec'])
            if 'schedule_spec' in updates and isinstance(updates['schedule_spec'], dict):
                spec = dict(updates['schedule_spec'])
                if task['schedule_type'] == 'cron' and isinstance(spec.get('cron'), str):
                    spec['cron'] = normalize_cron(spec['cron'])
            task.update(updates)
            task['schedule_spec'] = spec
            if 'schedule_spec' in updates or 'timezone' in updates:
                task['next_run_at'] = next_run_at_now(task['schedule_type'], spec, now)
            task['updated_at'] = iso(0)
            return 200, dict(task)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', records
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def cron_task(**overrides):
    row = dict(id=TASK_ID, user_id='A', thread_id=None, context_mode='fresh_thread_per_run',
               assistant_id='lead_agent', title='每日报表', prompt='生成昨天的报表',
               schedule_type='cron', schedule_spec={'cron': '0 9 * * *'},
               timezone='Asia/Shanghai', next_run_at=iso(60), status='enabled',
               created_at=iso(-600), updated_at=iso(-600))
    row.update(overrides)
    return row


def make_chat(tmp_path, origin, **options):
    from core.platform_chat import DesktopChat
    from core.secrets import InMemorySecretStore
    from core.settings import RuntimeSettings
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'settings.json'
    settings = RuntimeSettings(server_url=origin, user_id='A', business_token_ref='business-A',
                               business_expires_at='2099-01-01T00:00:00+00:00',
                               device_id='device-1', device_public_key='dev-key',
                               server_public_key='broker-key')
    settings.save(config)
    return DesktopChat(config, secure, lambda: {'state': 'authenticated'}, **options), settings, config


def wire(action, scope, **fields):
    return {'type': 'schedules', 'id': 'req-1', 'action': action, 'scope': scope, **fields}


def scope_of(chat):
    return chat.handle({'action': 'state'})['scope']


def full_draft(**overrides):
    draft = dict(title='周报', prompt='汇总本周进展', scheduleType='cron',
                 scheduleSpec={'cron': '0 9 * * MON'}, timezone='Asia/Shanghai',
                 assistantId='my_agent', contextMode='fresh_thread_per_run', threadId='')
    draft.update(overrides)
    return draft


# --- Management surface ----------------------------------------------------

def test_list_projects_platform_rows_with_device_defaults(tmp_path):
    with platform(tasks={'task-a': cron_task(id='task-a')}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('list', scope_of(chat)))
        assert [row['id'] for row in result['tasks']] == ['task-a']
        row = result['tasks'][0]
        assert row['title'] == '每日报表'
        assert row['scheduleType'] == 'cron' and row['scheduleSpec'] == {'cron': '0 9 * * *'}
        assert row['assistantId'] == 'lead_agent'
        assert row['nextRunAt'] == iso(60)
        assert row['status'] == 'enabled' and row['timezone'] == 'Asia/Shanghai'
        assert row['skipOnMissed'] is False and row['missedMarks'] == []


def test_create_sends_agent_config_and_platform_fields(tmp_path):
    """修复项: the Agent config the user chose rides the create payload verbatim
    (normalized the same way the pinned router normalizes assistant ids)."""
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('create', scope_of(chat), task=full_draft()))
        assert result['task']['assistantId'] == 'my-agent'
        created = [body for method, path, body, _ in records
                   if method == 'POST' and path == '/api/scheduled-tasks']
        assert len(created) == 1
        body = created[0]
        # The 修复项 verification: the agent configuration is really passed on.
        assert body['assistant_id'] == 'my-agent'
        assert body['title'] == '周报' and body['prompt'] == '汇总本周进展'
        assert body['schedule_type'] == 'cron'
        # The device sends the user's own cron expression; the platform
        # normalizes weekday names (the reply shows the stored form).
        assert body['schedule_spec'] == {'cron': '0 9 * * MON'}
        assert result['task']['scheduleSpec'] == {'cron': '0 9 * * 1'}
        assert body['timezone'] == 'Asia/Shanghai'
        assert body['context_mode'] == 'fresh_thread_per_run'
        assert 'thread_id' not in body or body['thread_id'] is None


def test_create_without_agent_omits_assistant_id_and_platform_defaults_apply(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.schedules_manage(wire('create', scope_of(chat), task=full_draft(
            assistantId='', scheduleType='interval', scheduleSpec={'everySeconds': 3600},
            contextMode='reuse_thread', threadId='thread-9')))
        created = [body for method, path, body, _ in records
                   if method == 'POST' and path == '/api/scheduled-tasks'][0]
        assert 'assistant_id' not in created
        assert created['thread_id'] == 'thread-9'
        assert created['schedule_spec'] == {'every_seconds': 3600}


def test_create_once_sends_run_at(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('create', scope_of(chat), task=full_draft(
            scheduleType='once', scheduleSpec={'runAt': '2026-03-02T10:00:00+00:00'},
            assistantId='lead-agent')))
        created = [body for method, path, body, _ in records
                   if method == 'POST' and path == '/api/scheduled-tasks'][0]
        assert created['schedule_spec'] == {'run_at': '2026-03-02T10:00:00+00:00'}
        assert created['assistant_id'] == 'lead-agent'
        assert result['task']['assistantId'] == 'lead_agent'
        assert result['task']['status'] == 'enabled'


def test_create_reuse_thread_requires_thread_id(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('create', scope_of(chat), task=full_draft(
                contextMode='reuse_thread', threadId='')))
        assert str(raised.value) == 'SCHEDULES_COMMAND_INVALID'
        assert not [row for row in records if row[1] == '/api/scheduled-tasks' and row[0] == 'POST']


@pytest.mark.parametrize('bad_draft', [
    dict(title='   '),
    dict(prompt=''),
    dict(scheduleType='yearly'),
    dict(scheduleType='cron', scheduleSpec={'everySeconds': 60}),
    dict(scheduleType='interval', scheduleSpec={'everySeconds': 30}),
    dict(scheduleType='interval', scheduleSpec={'everySeconds': 'lots'}),
    dict(scheduleType='once', scheduleSpec={'runAt': 'not-a-date'}),
    dict(scheduleType='once', scheduleSpec={'runAt': '2026-03-02T10:00:00'}),
    dict(timezone='Not/AZone'),
    dict(timezone=''),
    dict(timezone='Asia/Shanghai '),
    dict(assistantId='bad name!'),
    dict(assistantId='x' * 129),
    dict(contextMode='single_thread'),
    dict(threadId='bad id!'),
])
def test_create_rejects_invalid_drafts_before_any_platform_call(tmp_path, bad_draft):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('create', scope_of(chat), task=full_draft(**bad_draft)))
        assert str(raised.value) == 'SCHEDULES_COMMAND_INVALID'
        assert not [row for row in records if row[0] == 'POST' and row[1] == '/api/scheduled-tasks']


def test_platform_refuses_a_once_in_the_past_with_mapped_category(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('create', scope_of(chat), task=full_draft(
                scheduleType='once', scheduleSpec={'runAt': '2026-03-02T08:00:00+00:00'})))
        assert str(raised.value) == 'SCHEDULES_RESOURCE_UNAVAILABLE'


def test_update_patches_only_the_sent_fields_and_platform_recomputes(tmp_path):
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('update', scope_of(chat), taskId=TASK_ID, task=dict(
            prompt='新提示词', scheduleType='cron', scheduleSpec={'cron': '30 8 * * *'})))
        assert result['task']['prompt'] == '新提示词'
        patched = [body for method, path, body, _ in records
                   if method == 'PATCH' and path == f'/api/scheduled-tasks/{TASK_ID}'][0]
        assert patched == {'prompt': '新提示词', 'schedule_spec': {'cron': '30 8 * * *'}}


def test_update_thread_id_only_patch_edits_the_reused_session(tmp_path):
    with platform(tasks={TASK_ID: cron_task(context_mode='reuse_thread', thread_id='thread-9')}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('update', scope_of(chat), taskId=TASK_ID, task=dict(
            threadId='thread-other')))
        assert result['task']['threadId'] == 'thread-other'
        patched = [body for method, path, body, _ in records
                   if method == 'PATCH' and path == f'/api/scheduled-tasks/{TASK_ID}'][0]
        assert patched == {'thread_id': 'thread-other'}


def test_update_rejects_schedule_type_and_empty_patch(tmp_path):
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('update', scope_of(chat), taskId=TASK_ID, task={}))
        assert str(raised.value) == 'SCHEDULES_COMMAND_INVALID'
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('update', scope_of(chat), taskId=TASK_ID, task=dict(
                scheduleType='once')))
        assert str(raised.value) == 'SCHEDULES_COMMAND_INVALID'
        assert not [row for row in records if row[0] == 'PATCH']


def test_pause_resume_trigger_delete_follow_the_pinned_router(tmp_path):
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = scope_of(chat)
        paused = chat.schedules_manage(wire('pause', scope, taskId=TASK_ID))
        assert paused['task']['status'] == 'paused'
        resumed = chat.schedules_manage(wire('resume', scope, taskId=TASK_ID))
        assert resumed['task']['status'] == 'enabled'
        triggered = chat.schedules_manage(wire('trigger', scope, taskId=TASK_ID))
        assert triggered == {'taskId': TASK_ID, 'triggered': True}
        deleted = chat.schedules_manage(wire('delete', scope, taskId=TASK_ID))
        assert deleted == {'taskId': TASK_ID, 'deleted': True}
        posts = [path for method, path, _, _ in records if method == 'POST']
        assert posts == [f'/api/scheduled-tasks/{TASK_ID}/pause',
                         f'/api/scheduled-tasks/{TASK_ID}/resume',
                         f'/api/scheduled-tasks/{TASK_ID}/trigger']


def test_get_and_runs_project_platform_rows_and_device_marks(tmp_path):
    runs = {TASK_ID: [dict(id='run-1', task_id=TASK_ID, status='succeeded', planned_for=iso(-120),
                           trigger='schedule', created_at=iso(-119))]}
    with platform(tasks={TASK_ID: cron_task()}, runs=runs) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.schedules_manage(wire('set-skip', scope_of(chat), taskId=TASK_ID, skipOnMissed=True))
        client = chat.scheduled_tasks
        owner = client.owner()
        ledger = client.ledger
        # One missed-and-caught-up mark on an earlier point enriches both views.
        ledger.record_mark(owner, TASK_ID, iso(-120), 'caught_up',
                           'missed while offline; caught up once on device online')
        view = chat.schedules_manage(wire('get', scope_of(chat), taskId=TASK_ID))
        assert view['task']['skipOnMissed'] is True
        assert [mark['plannedAt'] for mark in view['task']['missedMarks']] == [iso(-120)]
        assert view['task']['missedMarks'][0]['status'] == 'caught_up'
        listing = chat.schedules_manage(wire('runs', scope_of(chat), taskId=TASK_ID, limit=50, offset=0))
        assert [row['id'] for row in listing['runs']] == ['run-1']
        assert listing['runs'][0]['status'] == 'succeeded'
        assert listing['runs'][0]['plannedFor'] == iso(-120)
        assert listing['runs'][0]['trigger'] == 'schedule'
        assert listing['runs'][0]['catchUp']['plannedAt'] == iso(-120)


def test_runs_project_unknown_run_row_keys_tolerantly(tmp_path):
    runs = {TASK_ID: [dict(id='run-2', task_id=TASK_ID, status='failed', scheduled_for=iso(-60),
                           trigger_type='manual', created_at=iso(-59), detail='agent exploded')]}
    with platform(tasks={TASK_ID: cron_task()}, runs=runs) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        listing = chat.schedules_manage(wire('runs', scope_of(chat), taskId=TASK_ID, limit=10, offset=0))
        row = listing['runs'][0]
        assert row['plannedFor'] == iso(-60) and row['trigger'] == 'manual'
        assert row['error'] == 'agent exploded' and row['catchUp'] is None


def test_runs_bounded_limit_and_offset_reach_the_platform_query(tmp_path):
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        chat.schedules_manage(wire('runs', scope_of(chat), taskId=TASK_ID, limit=10, offset=5))
        gets = [path for method, path, _, _ in records if method == 'GET' and '/runs' in path]
        assert gets == [f'/api/scheduled-tasks/{TASK_ID}/runs?limit=10&offset=5']


def test_cron_preview_rides_the_pinned_endpoint_with_device_timezone(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('preview', scope_of(chat),
                                            cron='0 9 * * *', timezone='Asia/Shanghai', count=3))
        posted = [body for method, path, body, _ in records
                  if path == '/api/scheduled-tasks/preview-cron']
        assert posted == [{'cron': '0 9 * * *', 'timezone': 'Asia/Shanghai', 'count': 3}]
        assert result['cron'] == '0 9 * * *' and result['timezone'] == 'Asia/Shanghai'
        assert len(result['occurrences']) == 3
        for occurrence in result['occurrences']:
            # run_at is the platform instant; local_time is the platform's own
            # wall clock in the requested zone (+08:00 for Asia/Shanghai).
            assert occurrence['runAt'].startswith('T09:00') or 'T09:00' in occurrence['runAt']
            assert 'T17:00' in occurrence['localTime'] and occurrence['localTime'].endswith('+08:00')


def test_cron_preview_rejects_bad_shapes_before_any_platform_call(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        for command in (wire('preview', scope_of(chat), cron='', timezone='UTC', count=3),
                        wire('preview', scope_of(chat), cron='0 9 * * *', timezone='UTC x', count=3),
                        wire('preview', scope_of(chat), cron='0 9 * * *', timezone='UTC', count=0),
                        wire('preview', scope_of(chat), cron='0 9 * * *', timezone='UTC', count=11),
                        wire('preview', scope_of(chat), cron='0 9 * * *', timezone='UTC', count='3'),
                        wire('preview', scope_of(chat), cron='x' * 257, timezone='UTC', count=3)):
            with pytest.raises(Exception) as raised:
                chat.schedules_manage(command)
            assert str(raised.value) == 'SCHEDULES_COMMAND_INVALID', command
        assert records == []


def test_platform_not_found_maps_to_fixed_category(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        for action in ('get', 'pause', 'resume', 'trigger', 'delete'):
            with pytest.raises(Exception) as raised:
                chat.schedules_manage(wire(action, scope_of(chat), taskId='missing'))
            assert str(raised.value) == 'SCHEDULES_NOT_FOUND', action


def test_platform_conflict_maps_to_fixed_category(tmp_path):
    with platform(tasks={TASK_ID: cron_task(status='running')}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('pause', scope_of(chat), taskId=TASK_ID))
        assert str(raised.value) == 'SCHEDULES_CONFLICT'


def test_unauthenticated_session_refuses_with_schedules_category(tmp_path):
    from core.platform_chat import DesktopChat
    from core.secrets import InMemorySecretStore
    from core.settings import RuntimeSettings
    with platform() as (origin, records):
        secure = InMemorySecretStore()
        config = tmp_path / 'settings.json'
        RuntimeSettings(server_url=origin, user_id='A').save(config)
        chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'})
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('list', 'scope-x'))
        assert str(raised.value) == 'SCHEDULES_UNAUTHENTICATED'
        assert not [row for row in records if row[1] == '/api/scheduled-tasks']


def test_facade_rejects_wrong_wire_shapes_before_any_platform_call(tmp_path):
    with platform() as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        scope = scope_of(chat)
        bad_commands = [
            {'type': 'schedules', 'id': 'r', 'action': 'list', 'scope': scope, 'extra': 1},
            {'type': 'threads', 'id': 'r', 'action': 'list', 'scope': scope},
            {'type': 'schedules', 'id': 'r', 'action': 'pause', 'scope': scope},
            wire('fly', scope),
            wire('pause', scope, taskId='bad id!'),
            wire('pause', scope, taskId='x' * 129),
            wire('runs', scope, taskId=TASK_ID, limit=0, offset=0),
            wire('runs', scope, taskId=TASK_ID, limit=201, offset=0),
            wire('runs', scope, taskId=TASK_ID, limit=50, offset=-1),
            wire('runs', scope, taskId=TASK_ID, limit=1.5, offset=0),
            wire('set-skip', scope, taskId=TASK_ID, skipOnMissed='yes'),
            wire('create', scope, task='nope'),
        ]
        for command in bad_commands:
            with pytest.raises(Exception) as raised:
                chat.schedules_manage(command)
            assert str(raised.value) == 'SCHEDULES_COMMAND_INVALID', command
        # A stale scope (identity changed elsewhere) is fenced, not guessed.
        with pytest.raises(Exception) as raised:
            chat.schedules_manage(wire('list', 'stale-scope'))
        assert str(raised.value) == 'SCHEDULES_IDENTITY_CHANGED'
        assert records == []


# --- Device-side catch-up (#85 decision 2) ---------------------------------

def observe_then_advance(task, next_run_at):
    task['next_run_at'] = next_run_at


def test_catchup_triggers_once_for_the_missed_point_and_marks_it(tmp_path):
    task = cron_task(next_run_at=iso(180))
    with platform(tasks={TASK_ID: task}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        # First observation while online: adopt the cursor, run nothing.
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        assert not [row for row in records if row[1].endswith('/trigger')]
        # The platform now advances past the observed point: the observed
        # point came due while the device was away.
        observe_then_advance(task, iso(240))
        report = client.catch_up_after_offline()
        assert len(report) == 1 and report[0]['taskId'] == TASK_ID
        assert report[0]['outcome'] == 'caught_up'
        assert report[0]['plannedAt'] == iso(180) and report[0]['error'] == ''
        triggers = [row for row in records if row[1].endswith('/trigger')]
        assert len(triggers) == 1
        marks = client.ledger.marks(client.owner(), TASK_ID)
        # The missed planned point is the instant the device last observed as
        # next_run_at — the platform's own accurate computation (decision 6).
        assert [mark['planned_at'] for mark in marks] == [iso(180)]
        assert marks[0]['status'] == 'caught_up'
        assert marks[0]['reason'] == 'missed while away; caught up once on device online'
        # A second sweep sees the same cursor state: no duplicate execution.
        assert client.catch_up_after_offline() == []
        assert len([row for row in records if row[1].endswith('/trigger')]) == 1


def test_catchup_skips_the_missed_point_when_the_task_says_so(tmp_path):
    task = cron_task(next_run_at=iso(180))
    with platform(tasks={TASK_ID: task}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        observe_then_advance(task, iso(240))
        chat.schedules_manage(wire('set-skip', scope_of(chat), taskId=TASK_ID, skipOnMissed=True))
        report = client.catch_up_after_offline()
        assert report == [{'taskId': TASK_ID, 'plannedAt': iso(180), 'outcome': 'skipped', 'error': ''}]
        assert not [row for row in records if row[1].endswith('/trigger')]
        assert client.ledger.marks(client.owner(), TASK_ID)[0]['status'] == 'skipped'


def test_catchup_never_reruns_a_point_the_platform_already_executed(tmp_path):
    task = cron_task(next_run_at=iso(180))
    runs = {TASK_ID: [dict(id='run-9', task_id=TASK_ID, status='succeeded', planned_for=iso(180),
                           trigger='schedule', created_at=iso(181))]}
    with platform(tasks={TASK_ID: task}, runs=runs) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        observe_then_advance(task, iso(240))
        assert client.catch_up_after_offline() == []
        assert not [row for row in records if row[1].endswith('/trigger')]


def test_catchup_tolerant_coverage_when_run_rows_carry_no_planned_point(tmp_path):
    task = cron_task(next_run_at=iso(180))
    runs = {TASK_ID: [dict(id='run-9', task_id=TASK_ID, status='succeeded', trigger='schedule',
                           created_at=iso(190))]}
    with platform(tasks={TASK_ID: task}, runs=runs) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        observe_then_advance(task, iso(240))
        assert client.catch_up_after_offline() == []
        assert not [row for row in records if row[1].endswith('/trigger')]


def test_catchup_ignores_reschedules_that_happened_after_the_observed_point(tmp_path):
    """The platform moved next_run_at forward because the user edited the task
    while the device was away, not because the point came due: adopt the new
    plan silently, never trigger."""
    task = cron_task(next_run_at=iso(180))
    with platform(tasks={TASK_ID: task}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        task['updated_at'] = iso(200)
        observe_then_advance(task, iso(240))
        assert client.catch_up_after_offline() == []
        assert not [row for row in records if row[1].endswith('/trigger')]


def test_catchup_ignores_paused_tasks_but_first_observed_tasks_catch_up_later(tmp_path):
    paused = cron_task(id='task-p', status='paused', next_run_at=iso(180))
    fresh = cron_task(id='task-f', next_run_at=iso(180))
    with platform(tasks={'task-p': paused, 'task-f': fresh}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        # First observation adopts the platform's own cursor; nothing runs.
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        paused['next_run_at'] = iso(240)
        fresh['next_run_at'] = iso(240)
        report = client.catch_up_after_offline()
        assert [row['taskId'] for row in report] == ['task-f']
        assert len([row for row in records if row[1].endswith('/trigger')]) == 1


def test_catchup_unknown_trigger_outcome_is_consumed_without_a_retry(tmp_path):
    """A 5xx trigger answer is ambiguous — the dispatch may have happened — so
    the point is consumed with its recorded uncertainty and never retriggered
    (decision 2: 结果不明的写操作不自动重跑)."""
    task = cron_task(next_run_at=iso(180))
    with platform(tasks={TASK_ID: task}, trigger_status=502) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        observe_then_advance(task, iso(240))
        report = client.catch_up_after_offline()
        assert report[0]['outcome'] == 'unknown'
        marks = client.ledger.marks(client.owner(), TASK_ID)
        assert marks[0]['status'] == 'caught_up' and marks[0]['error'] == 'SCHEDULES_SERVER_ERROR'
        assert client.catch_up_after_offline() == []
        assert len([row for row in records if row[1].endswith('/trigger')]) == 1


def test_catchup_refused_trigger_is_marked_skipped_not_caught_up(tmp_path):
    """A 4xx refusal proves nothing was dispatched: the point stays consumed
    but the mark records the refusal honestly."""
    task = cron_task(next_run_at=iso(180))
    with platform(tasks={TASK_ID: task}, trigger_status=409) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        observe_then_advance(task, iso(240))
        report = client.catch_up_after_offline()
        assert report[0]['outcome'] == 'skipped' and report[0]['error'] == 'SCHEDULES_CONFLICT'
        mark = client.ledger.marks(client.owner(), TASK_ID)[0]
        assert mark['status'] == 'skipped' and 'SCHEDULES_CONFLICT' in mark['reason']
        assert client.catch_up_after_offline() == []


def test_catchup_rising_edge_only_and_periodic_gate(tmp_path):
    task = cron_task(next_run_at=iso(180))
    with platform(tasks={TASK_ID: task}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        assert client.catch_up_tick(True) is True
        assert client.catch_up_after_offline() == []
        assert client.catch_up_tick(True) is False
        assert client.catch_up_tick(False) is False
        task['next_run_at'] = iso(240)
        # Offline stays offline; the sweep only rides a rising edge.
        assert client.catch_up_tick(False) is False
        assert client.catch_up_tick(True) is True
        report = client.catch_up_after_offline()
        assert report and report[0]['outcome'] == 'caught_up'
        assert len([row for row in records if row[1].endswith('/trigger')]) == 1


def test_set_skip_persists_per_task_and_account(tmp_path):
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        result = chat.schedules_manage(wire('set-skip', scope_of(chat), taskId=TASK_ID, skipOnMissed=True))
        assert result == {'taskId': TASK_ID, 'skipOnMissed': True}
        view = chat.schedules_manage(wire('get', scope_of(chat), taskId=TASK_ID))
        assert view['task']['skipOnMissed'] is True
        chat.schedules_manage(wire('set-skip', scope_of(chat), taskId=TASK_ID, skipOnMissed=False))
        view = chat.schedules_manage(wire('get', scope_of(chat), taskId=TASK_ID))
        assert view['task']['skipOnMissed'] is False


def test_ledger_keeps_distinct_marks_for_distinct_planned_points(tmp_path):
    """The idempotency key is the planned point itself: two different missed
    points of one task each get their own claim, and one point claimed twice
    (racing sweeps) records exactly one row."""
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        owner = client.owner()
        assert client.ledger.record_mark(owner, TASK_ID, iso(-120), 'caught_up', 'first') is True
        assert client.ledger.record_mark(owner, TASK_ID, iso(-60), 'caught_up', 'second') is True
        assert client.ledger.record_mark(owner, TASK_ID, iso(-120), 'skipped', 'race') is False
        planned = [mark['planned_at'] for mark in client.ledger.marks(owner, TASK_ID)]
        assert sorted(planned) == [iso(-120), iso(-60)]


def test_ledger_rows_are_scoped_to_the_account_binding(tmp_path):
    with platform(tasks={TASK_ID: cron_task()}) as (origin, records):
        chat, _, _ = make_chat(tmp_path, origin)
        client = chat.scheduled_tasks
        owner = client.owner()
        client.ledger.set_policy(owner, TASK_ID, True)
        other = dict(owner, user_id='someone-else')
        assert client.ledger.policy(other, TASK_ID) is False
        assert client.ledger.policy(owner, TASK_ID) is True
        assert client.ledger.policy(owner, 'task-other') is False
