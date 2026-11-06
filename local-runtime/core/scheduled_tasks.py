"""Scheduled-task management against the platform's own service (#85).

The platform owns the timing: tasks live on the Server and its
``scheduled_tasks`` service computes every ``next_run_at`` (decision #63-1).
This module is the device-side client for the pinned REST contract
(backend/app/gateway/routers/scheduled_tasks.py @ a7037c3f): the cron preview,
CRUD, pause/resume/manual trigger, and the per-task run listing. The Desktop
never computes or estimates a task's next run itself.

Cron previews ride the pinned ``preview-cron`` endpoint: the bundled runtime
Python carries no timezone database (verified), so IANA-zone cron expansion
cannot happen on this device, and the endpoint is defined by the contract to
use "the same semantics as scheduling" — the preview and the execution record
cannot drift apart. The device contributes the user's local timezone name and
renders the returned wall clocks verbatim.

The device does own one honest defect fix the REST contract does not cover
(recorded as a contract gap): missed-run catch-up. The contract exposes no
missed/catch-up semantics and no per-task "skip on missed" field, so the
device keeps a small ledger: the last ``next_run_at`` it observed per task is
the idempotency key (= the planned point, exactly as the platform computed
it). When the platform advances past that point, the schedule itself changed
after that point, or a platform run already covers it, nothing runs; a
genuinely missed point is caught up once — one trigger, one marking, never a
retry — and a task may be set to skip missed points instead. Unknown trigger
outcomes consume the point without a re-run (decision #63-2/5).
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .receipts import content_hash

MAX_TASK_ROWS = 200
MAX_RUN_ROWS = 200
MAX_MARKS_VIEW = 20
MAX_SWEEP_TASKS = 50
MAX_REPORT_ROWS = 20
MAX_TITLE = 200
MAX_PROMPT = 16000
MAX_TIMEZONE = 128
MAX_CRON = 256
MAX_ID = 128
MAX_ASSISTANT = 128
# Device-side interval bounds; the Server's own min/max stay authoritative and
# refine these with a 422 the client surfaces as SCHEDULES_RESOURCE_UNAVAILABLE.
MIN_INTERVAL_SECONDS = 60
MAX_INTERVAL_SECONDS = 30 * 24 * 3600
# While online, the sweep also re-scans on this cadence so a dispatch the
# platform skipped during its own outage is caught up without waiting for a
# device restart; every pass stays claim-gated, so no point can run twice.
CATCHUP_SWEEP_INTERVAL_SECONDS = 600.0

CONTEXT_MODES = ('fresh_thread_per_run', 'reuse_thread')
SCHEDULE_TYPES = ('cron', 'interval', 'once')
TASK_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
ASSISTANT_PATTERN = re.compile(r'^[a-z0-9-]{1,128}$')
TIMEZONE_SHAPE = re.compile(r'^[A-Za-z0-9_+\-/]{1,128}$')
# The pinned platform session raises its own fixed categories; only the code
# crosses this boundary, mapped onto the schedules family's own vocabulary
# (duck-typed so this module never imports the chat surface back).
PLATFORM_CODE_MAP = {
    'CHAT_UNAUTHENTICATED': 'SCHEDULES_UNAUTHENTICATED',
    'CHAT_FORBIDDEN': 'SCHEDULES_FORBIDDEN',
    'CHAT_NOT_FOUND': 'SCHEDULES_NOT_FOUND',
    'CHAT_CONFLICT': 'SCHEDULES_CONFLICT',
    'CHAT_RESOURCE_UNAVAILABLE': 'SCHEDULES_RESOURCE_UNAVAILABLE',
    'CHAT_SERVER_UNAVAILABLE': 'SCHEDULES_SERVER_UNAVAILABLE',
    'CHAT_IDENTITY_CHANGED': 'SCHEDULES_IDENTITY_CHANGED',
}
# A 4xx trigger answer proves nothing was dispatched; anything else is an
# ambiguous outcome that consumes the point without a retry.
REFUSED_CATEGORIES = {'SCHEDULES_NOT_FOUND', 'SCHEDULES_CONFLICT', 'SCHEDULES_FORBIDDEN',
                      'SCHEDULES_RESOURCE_UNAVAILABLE', 'SCHEDULES_COMMAND_INVALID'}


class SchedulesError(RuntimeError):
    """A fixed-category failure; only the code crosses the Desktop boundary."""

    def __init__(self, code: str, detail: str = '') -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def map_platform_error(exc: Exception) -> SchedulesError:
    return SchedulesError(PLATFORM_CODE_MAP.get(str(exc), 'SCHEDULES_SERVER_ERROR'))


def _text(value, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ''


def _integer(value) -> int | None:
    return value if type(value) is int else None


def _parse_instant(value):
    """Parse one platform ISO instant; None when it is not a usable timestamp."""
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _instant_key(value):
    """A sortable comparison key for a platform instant; falls back to the raw
    text when either side of a comparison cannot be parsed."""
    parsed = _parse_instant(value)
    if parsed is None:
        return (1, str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (0, parsed.astimezone(timezone.utc).timestamp())


def _tz_database_available() -> bool:
    """One cached probe: a working ZoneInfo('UTC') means this process has a
    timezone database. The bundled runtime Python has none, so timezone
    validation there degrades to a shape check and the Server stays
    authoritative (a bad name returns its own 422)."""
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo('UTC')
        return True
    except Exception:
        return False


_TZ_DATABASE = _tz_database_available()


def _validate_timezone(name) -> str:
    if not isinstance(name, str) or not TIMEZONE_SHAPE.fullmatch(name):
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    if _TZ_DATABASE:
        from zoneinfo import ZoneInfo
        try:
            ZoneInfo(name)
        except Exception:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID') from None
    return name


def _validate_cron_spec(spec) -> dict:
    if not isinstance(spec, dict) or set(spec) != {'cron'}:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    cron = spec['cron']
    if not isinstance(cron, str) or not 1 <= len(cron) <= MAX_CRON:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    return {'cron': cron}


def _validate_interval_spec(spec) -> dict:
    if not isinstance(spec, dict) or set(spec) != {'everySeconds'}:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    seconds = spec['everySeconds']
    if type(seconds) is not int or not MIN_INTERVAL_SECONDS <= seconds <= MAX_INTERVAL_SECONDS:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    return {'every_seconds': seconds}


def _validate_once_spec(spec) -> dict:
    if not isinstance(spec, dict) or set(spec) != {'runAt'}:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    run_at = spec['runAt']
    if not isinstance(run_at, str) or not 1 <= len(run_at) <= 64:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    try:
        parsed = datetime.fromisoformat(run_at)
    except ValueError:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID') from None
    if parsed.tzinfo is None:
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    return {'run_at': run_at}


def _validate_spec(schedule_type, spec) -> dict:
    if schedule_type == 'cron':
        return _validate_cron_spec(spec)
    if schedule_type == 'interval':
        return _validate_interval_spec(spec)
    if schedule_type == 'once':
        return _validate_once_spec(spec)
    raise SchedulesError('SCHEDULES_COMMAND_INVALID')


def _validate_draft_fields(draft, keys) -> dict:
    """Validate one validated-keys subset and map it to the platform payload."""
    payload: dict[str, Any] = {}
    if 'title' in keys:
        title = draft['title'].strip() if isinstance(draft['title'], str) else ''
        if not title or len(title) > MAX_TITLE:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        payload['title'] = title
    if 'prompt' in keys:
        prompt = draft['prompt']
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= MAX_PROMPT:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        payload['prompt'] = prompt
    if 'assistantId' in keys:
        assistant = draft['assistantId']
        if not isinstance(assistant, str) or len(assistant) > MAX_ASSISTANT:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        normalized = assistant.strip().lower().replace('_', '-')
        if normalized:
            # The pinned router normalizes and existence-checks assistant ids;
            # the device mirrors the normalization and lets the Server own
            # existence (the 修复项: the chosen agent config rides the wire).
            # An empty value means "platform default"; the pinned update
            # endpoint has no clear-to-default form (None is dropped), so an
            # update omits the field instead of pretending to clear it.
            if not ASSISTANT_PATTERN.fullmatch(normalized):
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
            payload['assistant_id'] = normalized
    if 'contextMode' in keys:
        if draft['contextMode'] not in CONTEXT_MODES:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        payload['context_mode'] = draft['contextMode']
    if 'threadId' in keys:
        thread_id = draft['threadId']
        if not isinstance(thread_id, str):
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        effective_mode = payload.get('context_mode') or draft.get('contextMode')
        if effective_mode == 'reuse_thread':
            if not TASK_ID_PATTERN.fullmatch(thread_id):
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
            payload['thread_id'] = thread_id
        elif effective_mode == 'fresh_thread_per_run':
            # The pinned endpoint has no clear-to-null form on updates (None
            # is dropped): switching back to fresh threads simply omits the
            # thread, so an explicit empty thread id is never useful here.
            if thread_id != '':
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        else:
            # A thread-id-only patch edits the reused session of a task the
            # Server already knows is in reuse_thread mode; the device cannot
            # see that mode, so it mirrors the platform's own ThreadId rule
            # and lets the Server own the mode consistency.
            if not TASK_ID_PATTERN.fullmatch(thread_id):
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
            payload['thread_id'] = thread_id
    if 'timezone' in keys:
        payload['timezone'] = _validate_timezone(draft['timezone'])
    if 'scheduleSpec' in keys or 'scheduleType' in keys:
        # A patch carries the schedule type it is editing against so the spec
        # shape can be validated device-side; the type itself is immutable on
        # the pinned update endpoint and is never mapped into the payload.
        schedule_type = draft.get('scheduleType')
        if schedule_type not in SCHEDULE_TYPES:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        if 'scheduleSpec' in keys:
            payload['schedule_spec'] = _validate_spec(schedule_type, draft['scheduleSpec'])
    return payload


def _validate_draft(draft, *, allowed, required=()) -> dict:
    if not isinstance(draft, dict):
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    if not set(draft) <= allowed or not set(required) <= set(draft):
        raise SchedulesError('SCHEDULES_COMMAND_INVALID')
    return _validate_draft_fields(draft, set(draft))


def _spec_view(spec) -> dict:
    if not isinstance(spec, dict):
        return {}
    view = {}
    cron = spec.get('cron')
    if isinstance(cron, str):
        view['cron'] = cron[:MAX_CRON]
    seconds = _integer(spec.get('every_seconds'))
    if seconds is not None:
        view['everySeconds'] = seconds
    run_at = spec.get('run_at')
    if isinstance(run_at, str):
        view['runAt'] = run_at[:64]
    return view


_PLANNED_KEYS = ('planned_for', 'scheduled_for', 'planned_at')
_TRIGGER_KEYS = ('trigger', 'trigger_type', 'triggered')


class ScheduleTaskLedger:
    """Device-local marks, the skip policy, and the observed-run cursor.

    Rows are keyed by the account/device binding so another login on this
    device never sees them. ``record_mark`` is the claim gate: INSERT OR
    IGNORE over one identity per (binding, task, planned point) means at most
    one catch-up is ever recorded per planned point, even across racing
    sweeps — the planned point itself is the idempotency key.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ''
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS schedule_points (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL, task_id TEXT NOT NULL,
                    planned_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
                    error TEXT NOT NULL DEFAULT '', marked_at TEXT NOT NULL)""")
                db.execute("""CREATE TABLE IF NOT EXISTS schedule_policy (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL, task_id TEXT NOT NULL,
                    skip_on_missed INTEGER NOT NULL, updated_at TEXT NOT NULL)""")
                db.execute("""CREATE TABLE IF NOT EXISTS schedule_cursor (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL, task_id TEXT NOT NULL,
                    last_seen_next_run_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        except (sqlite3.Error, OSError):
            self._error = 'SCHEDULES_STORAGE_UNAVAILABLE'

    @property
    def error(self) -> str:
        return self._error

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, uri=self.path.startswith("file:"))
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def _execute(self, operation):
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                self._error = ''
                return result
            except (sqlite3.Error, OSError) as exc:
                self._error = 'SCHEDULES_STORAGE_UNAVAILABLE'
                raise SchedulesError(self._error) from exc

    @staticmethod
    def _binding(binding) -> dict[str, str]:
        return {key: str((binding or {}).get(key, '')) for key in
                ('server_origin', 'user_id', 'device_id', 'device_public_key', 'broker_public_key')}

    @classmethod
    def _task_identity(cls, binding, task_id) -> str:
        return content_hash({**cls._binding(binding), 'task_id': str(task_id)})

    @classmethod
    def _point_identity(cls, binding, task_id, planned_at) -> str:
        # The planned point is part of the identity: distinct missed points of
        # one task each get their own claim row, and one point can only ever
        # be claimed once (decision #63-5: 一个计划点至多补跑一次).
        return content_hash({**cls._binding(binding), 'task_id': str(task_id),
                             'planned_at': str(planned_at)})

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def marks(self, binding, task_id, limit=MAX_MARKS_VIEW) -> list[dict[str, Any]]:
        encoded = json.dumps(self._binding(binding), sort_keys=True)

        def read(db):
            rows = db.execute(
                "SELECT planned_at, status, reason, error, marked_at FROM schedule_points"
                " WHERE binding=? AND task_id=? ORDER BY rowid DESC LIMIT ?",
                (encoded, str(task_id), int(limit))).fetchall()
            return [dict(planned_at=row['planned_at'], status=row['status'], reason=row['reason'],
                         error=row['error'], marked_at=row['marked_at']) for row in rows]

        return self._execute(read)

    def mark_for(self, binding, task_id, planned_at) -> dict[str, Any] | None:
        encoded = json.dumps(self._binding(binding), sort_keys=True)

        def read(db):
            row = db.execute(
                "SELECT planned_at, status, reason, error, marked_at FROM schedule_points"
                " WHERE binding=? AND task_id=? AND planned_at=?",
                (encoded, str(task_id), str(planned_at))).fetchone()
            return dict(planned_at=row['planned_at'], status=row['status'], reason=row['reason'],
                        error=row['error'], marked_at=row['marked_at']) if row is not None else None

        return self._execute(read)

    def record_mark(self, binding, task_id, planned_at, status, reason, error='') -> bool:
        """Claim one planned point; True only for the first claim (idempotency)."""
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        identity = self._point_identity(binding, task_id, planned_at)

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO schedule_points (identity, binding, task_id, planned_at,"
                " status, reason, error, marked_at) VALUES (?,?,?,?,?,?,?,?)",
                (identity, encoded, str(task_id), str(planned_at), status, reason, str(error),
                 self._now()))
            return cursor.rowcount == 1

        return self._execute(write)

    def update_mark(self, binding, task_id, planned_at, *, status=None, reason=None, error=None):
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        fields, values = [], []
        for column, value in (('status', status), ('reason', reason), ('error', error)):
            if value is not None:
                fields.append(f"{column}=?")
                values.append(str(value))
        if not fields:
            return
        values += [encoded, str(task_id), str(planned_at)]

        def write(db):
            db.execute(f"UPDATE schedule_points SET {', '.join(fields)}"
                       " WHERE binding=? AND task_id=? AND planned_at=?", values)

        self._execute(write)

    def policy(self, binding, task_id) -> bool:
        def read(db):
            row = db.execute("SELECT skip_on_missed FROM schedule_policy WHERE identity=?",
                             (self._task_identity(binding, task_id),)).fetchone()
            return bool(row['skip_on_missed']) if row is not None else False

        return self._execute(read)

    def set_policy(self, binding, task_id, skip_on_missed: bool) -> None:
        encoded = json.dumps(self._binding(binding), sort_keys=True)

        def write(db):
            db.execute(
                "INSERT INTO schedule_policy (identity, binding, task_id, skip_on_missed, updated_at)"
                " VALUES (?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET"
                " skip_on_missed=excluded.skip_on_missed, updated_at=excluded.updated_at",
                (self._task_identity(binding, task_id), encoded, str(task_id),
                 1 if skip_on_missed else 0, self._now()))

        self._execute(write)

    def last_seen(self, binding, task_id) -> str | None:
        def read(db):
            row = db.execute("SELECT last_seen_next_run_at FROM schedule_cursor WHERE identity=?",
                             (self._task_identity(binding, task_id),)).fetchone()
            return row['last_seen_next_run_at'] if row is not None else None

        return self._execute(read)

    def observe(self, binding, task_id, next_run_at) -> None:
        encoded = json.dumps(self._binding(binding), sort_keys=True)

        def write(db):
            db.execute(
                "INSERT INTO schedule_cursor (identity, binding, task_id, last_seen_next_run_at,"
                " updated_at) VALUES (?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET"
                " last_seen_next_run_at=excluded.last_seen_next_run_at, updated_at=excluded.updated_at",
                (self._task_identity(binding, task_id), encoded, str(task_id),
                 str(next_run_at), self._now()))

        self._execute(write)


class ScheduledTasksClient:
    """One authenticated identity's scheduled-tasks commands (#85).

    The platform session and the mapped transport arrive as callables so this
    module owns only the family logic: command shapes, the pinned contract's
    payload mapping, tolerant row projection, and the catch-up sweep. Every
    reply is projected to bounded display facts before it crosses the pipe.
    """

    def __init__(self, session_factory: Callable[[], Any], json_request: Callable[..., Any],
                 ledger: ScheduleTaskLedger, owner_resolver: Callable[[], dict | None]) -> None:
        self._session_factory = session_factory
        self._json_request = json_request
        self.ledger = ledger
        self._owner_resolver = owner_resolver
        self._tick_lock = threading.Lock()
        self._sweep_lock = threading.Lock()
        self._last_authenticated: bool | None = None
        self._last_sweep = 0.0

    # --- session, identity, and platform call seam ---------------------------

    def owner(self) -> dict | None:
        try:
            return self._owner_resolver()
        except Exception:
            return None

    def _session(self):
        try:
            return self._session_factory()
        except Exception as exc:
            raise map_platform_error(exc) from None

    def _call(self, session, path, body=None, method=None):
        try:
            return self._json_request(session, path, body, method=method)
        except SchedulesError:
            raise
        except Exception as exc:
            raise map_platform_error(exc) from None

    def _require_owner(self) -> dict:
        owner = self.owner()
        if owner is None:
            raise SchedulesError('SCHEDULES_UNAUTHENTICATED')
        if self.ledger.error:
            raise SchedulesError('SCHEDULES_STORAGE_UNAVAILABLE')
        return owner

    # --- command surface -----------------------------------------------------

    def manage(self, command, session=None):
        """One management round-trip on the pinned contract (#85).

        The command shape is a fixed per-action key set, validated before any
        platform call. Identity rides the authenticated session itself — every
        call acts as the currently paired account, exactly like the model
        settings family; the session scope fence is the facade's job and the
        Server's own authorization stays authoritative.
        """
        if not isinstance(command, dict) or command.get('type') != 'schedules':
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        action = command.get('action')
        base = {'type', 'id', 'action', 'scope'}
        if action == 'list':
            expected = base
        elif action in {'get', 'pause', 'resume', 'trigger', 'delete'}:
            expected = base | {'taskId'}
        elif action == 'create':
            expected = base | {'task'}
        elif action == 'update':
            expected = base | {'taskId', 'task'}
        elif action == 'runs':
            expected = base | {'taskId', 'limit', 'offset'}
        elif action == 'set-skip':
            expected = base | {'taskId', 'skipOnMissed'}
        elif action == 'preview':
            expected = base | {'cron', 'timezone', 'count'}
        else:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        if set(command) != expected:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        if not isinstance(command['id'], str) or not 0 < len(command['id']) <= 64 \
                or not isinstance(command['scope'], str) or len(command['scope']) > 128:
            raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        task_id = ''
        if 'taskId' in expected:
            task_id = command['taskId']
            if not isinstance(task_id, str) or not TASK_ID_PATTERN.fullmatch(task_id):
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        if action == 'create':
            payload = _validate_draft(command['task'],
                                      allowed={'title', 'prompt', 'scheduleType', 'scheduleSpec',
                                               'timezone', 'assistantId', 'contextMode', 'threadId'},
                                      required={'title', 'prompt', 'scheduleType', 'scheduleSpec',
                                                'timezone', 'assistantId', 'contextMode', 'threadId'})
            payload['schedule_type'] = command['task']['scheduleType']
        elif action == 'update':
            patch = _validate_draft(command['task'],
                                    allowed={'title', 'prompt', 'scheduleType', 'scheduleSpec',
                                             'timezone', 'assistantId', 'contextMode', 'threadId'})
            if not patch:
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
            payload = patch
        elif action == 'runs':
            limit, offset = command['limit'], command['offset']
            if type(limit) is not int or not 1 <= limit <= 200 \
                    or type(offset) is not int or offset < 0 or offset > 1000000:
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        elif action == 'set-skip':
            if type(command['skipOnMissed']) is not bool:
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
        elif action == 'preview':
            if not isinstance(command['cron'], str) or not 1 <= len(command['cron']) <= MAX_CRON:
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
            if type(command['count']) is not int or not 1 <= command['count'] <= 10:
                raise SchedulesError('SCHEDULES_COMMAND_INVALID')
            timezone_name = _validate_timezone(command['timezone'])

        session = session if session is not None else self._session()
        if action == 'list':
            owner = self.owner()
            return {'tasks': [self._task_view(row, owner) for row in self._tasks(session)]}
        if action == 'get':
            return {'task': self._task_view(self._call(session, f'/api/scheduled-tasks/{task_id}'),
                                            self.owner())}
        if action == 'create':
            return {'task': self._task_view(
                self._call(session, '/api/scheduled-tasks', payload, method='POST'), self.owner())}
        if action == 'update':
            return {'task': self._task_view(
                self._call(session, f'/api/scheduled-tasks/{task_id}', payload, method='PATCH'),
                self.owner())}
        if action == 'pause':
            return {'task': self._task_view(
                self._call(session, f'/api/scheduled-tasks/{task_id}/pause', {}, method='POST'),
                self.owner())}
        if action == 'resume':
            return {'task': self._task_view(
                self._call(session, f'/api/scheduled-tasks/{task_id}/resume', {}, method='POST'),
                self.owner())}
        if action == 'trigger':
            outcome = self._call(session, f'/api/scheduled-tasks/{task_id}/trigger', {}, method='POST')
            if not isinstance(outcome, dict) or outcome.get('triggered') is not True:
                raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
            return {'taskId': task_id, 'triggered': True}
        if action == 'delete':
            outcome = self._call(session, f'/api/scheduled-tasks/{task_id}', None, method='DELETE')
            if not isinstance(outcome, dict) or outcome.get('deleted') is not True \
                    or outcome.get('id') != task_id:
                raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
            return {'taskId': task_id, 'deleted': True}
        if action == 'runs':
            rows = self._call(
                session, f'/api/scheduled-tasks/{task_id}/runs?limit={command["limit"]}&offset={command["offset"]}')
            if not isinstance(rows, list):
                raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
            owner = self.owner()
            return {'runs': [self._run_view(row, owner, task_id) for row in rows[:MAX_RUN_ROWS]]}
        if action == 'preview':
            outcome = self._call(session, '/api/scheduled-tasks/preview-cron',
                                 {'cron': command['cron'], 'timezone': timezone_name,
                                  'count': command['count']}, method='POST')
            return self._preview_view(outcome)
        # set-skip: a device-local per-task preference (the platform schema has
        # no such field — recorded contract gap); the ledger owns it.
        owner = self._require_owner()
        self.ledger.set_policy(owner, task_id, command['skipOnMissed'])
        return {'taskId': task_id, 'skipOnMissed': command['skipOnMissed']}

    # --- platform reads ------------------------------------------------------

    def _tasks(self, session) -> list:
        rows = self._call(session, '/api/scheduled-tasks')
        if not isinstance(rows, list):
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
        return rows[:MAX_TASK_ROWS]

    def _runs(self, session, task_id, limit=50):
        try:
            rows = self._call(session, f'/api/scheduled-tasks/{task_id}/runs?limit={limit}&offset=0')
        except SchedulesError as exc:
            if exc.code == 'SCHEDULES_NOT_FOUND':
                return []
            raise
        if not isinstance(rows, list):
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
        return rows[:MAX_RUN_ROWS]

    def _trigger(self, session, task_id):
        outcome = self._call(session, f'/api/scheduled-tasks/{task_id}/trigger', {}, method='POST')
        if not isinstance(outcome, dict) or outcome.get('triggered') is not True:
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')

    # --- safe ledger reads (display degrades, management still works) --------

    def _safe_marks(self, owner, task_id) -> list:
        if owner is None or self.ledger.error:
            return []
        try:
            return self.ledger.marks(owner, task_id)
        except SchedulesError:
            return []

    def _safe_policy(self, owner, task_id) -> bool:
        if owner is None or self.ledger.error:
            return False
        try:
            return self.ledger.policy(owner, task_id)
        except SchedulesError:
            return False

    def _safe_mark_for(self, owner, task_id, planned_at):
        if owner is None or self.ledger.error or not planned_at:
            return None
        try:
            return self.ledger.mark_for(owner, task_id, planned_at)
        except SchedulesError:
            return None

    # --- projection ----------------------------------------------------------

    def _task_view(self, row, owner) -> dict:
        if not isinstance(row, dict):
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
        row_id = row.get('id', row.get('task_id'))
        if not isinstance(row_id, str) or not row_id:
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
        marks = [dict(plannedAt=mark['planned_at'], status=mark['status'], reason=mark['reason'],
                      error=mark['error'], markedAt=mark['marked_at'])
                 for mark in self._safe_marks(owner, row_id)]
        thread_id = row.get('thread_id')
        return dict(
            id=row_id,
            title=_text(row.get('title'), MAX_TITLE),
            prompt=_text(row.get('prompt'), MAX_PROMPT),
            status=_text(row.get('status'), 32) or 'unknown',
            scheduleType=_text(row.get('schedule_type'), 16) or 'unknown',
            scheduleSpec=_spec_view(row.get('schedule_spec')),
            timezone=_text(row.get('timezone'), MAX_TIMEZONE),
            assistantId=_text(row.get('assistant_id'), MAX_ASSISTANT),
            contextMode=_text(row.get('context_mode'), 32),
            threadId=thread_id[:MAX_ID] if isinstance(thread_id, str) else '',
            nextRunAt=_text(row.get('next_run_at'), 64),
            createdAt=_text(row.get('created_at'), 64),
            updatedAt=_text(row.get('updated_at'), 64),
            skipOnMissed=self._safe_policy(owner, row_id),
            missedMarks=marks[:MAX_MARKS_VIEW],
        )

    def _run_view(self, row, owner, task_id) -> dict:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'] \
                or not isinstance(row.get('status'), str):
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
        planned = ''
        for key in _PLANNED_KEYS:
            if isinstance(row.get(key), str) and row[key]:
                planned = row[key][:64]
                break
        trigger = ''
        for key in _TRIGGER_KEYS:
            if isinstance(row.get(key), str):
                trigger = row[key][:16]
                break
        mark = self._safe_mark_for(owner, task_id, planned)
        thread_id = row.get('thread_id')
        return dict(
            id=row['id'][:128],
            status=row['status'][:32] or 'unknown',
            plannedFor=planned,
            trigger=trigger,
            # 会话关联: the platform names the session the execution belongs
            # to; the Desktop only displays it, never resolves one itself.
            threadId=thread_id[:MAX_ID] if isinstance(thread_id, str) else '',
            createdAt=_text(row.get('created_at'), 64),
            error=_text(row.get('error') or row.get('detail'), 512),
            catchUp=dict(plannedAt=mark['planned_at'], status=mark['status'], reason=mark['reason'],
                         error=mark['error'], markedAt=mark['marked_at']) if mark else None,
        )

    def _preview_view(self, outcome) -> dict:
        """The pinned preview reply: the platform's own instants and wall
        clocks, bounded; nothing here is recomputed or estimated."""
        if not isinstance(outcome, dict) or not isinstance(outcome.get('cron'), str) \
                or not isinstance(outcome.get('timezone'), str) \
                or not isinstance(outcome.get('occurrences'), list):
            raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
        occurrences = []
        for row in outcome['occurrences'][:10]:
            if not isinstance(row, dict) or not isinstance(row.get('run_at'), str) \
                    or not isinstance(row.get('local_time'), str) or not row['run_at']:
                raise SchedulesError('SCHEDULES_PROTOCOL_ERROR')
            occurrences.append(dict(runAt=row['run_at'][:64], localTime=row['local_time'][:64]))
        return dict(cron=outcome['cron'][:MAX_CRON], timezone=outcome['timezone'][:MAX_TIMEZONE],
                    occurrences=occurrences)

    # --- device-side catch-up (#85, decision 2) ------------------------------

    def catch_up_tick(self, authenticated: bool) -> bool:
        """Edge-driven sweep gate: exactly one pass per online transition plus
        one bounded safety-net pass per interval while online. Returns whether
        a pass should run; the caller owns the thread it runs on."""
        now = time.monotonic()
        with self._tick_lock:
            previous = self._last_authenticated
            self._last_authenticated = bool(authenticated)
            due = bool(authenticated) and previous is not True
            periodic = bool(authenticated) and now - self._last_sweep >= CATCHUP_SWEEP_INTERVAL_SECONDS
            if not (due or periodic):
                return False
            self._last_sweep = now
        return True

    def catch_up_after_offline(self) -> list[dict]:
        """One bounded single-flight sweep: catch up each missed planned point
        at most once.

        The cursor per task is the last ``next_run_at`` this device observed —
        the platform's own accurate planned point. When the platform advances
        past it, the point came due: a covering platform run (or a ledger
        claim) consumes it; otherwise the task is triggered once and the point
        is marked 补跑, or marked skipped when the task's skip policy says so.
        An ambiguous trigger answer is recorded as unknown and never retried.
        """
        if not self._sweep_lock.acquire(blocking=False):
            return []
        try:
            return self._sweep()
        finally:
            self._sweep_lock.release()

    def _sweep(self) -> list[dict]:
        owner = self.owner()
        if owner is None or self.ledger.error:
            return []
        try:
            session = self._session()
            rows = self._tasks(session)
        except SchedulesError:
            return []
        report: list[dict] = []
        for row in rows[:MAX_SWEEP_TASKS]:
            try:
                report.extend(self._sweep_task(session, owner, row))
            except SchedulesError:
                continue
        return report[:MAX_REPORT_ROWS]

    def _sweep_task(self, session, owner, row) -> list[dict]:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) \
                or not TASK_ID_PATTERN.fullmatch(row['id']):
            return []
        task_id = row['id']
        if row.get('status') != 'enabled' or not isinstance(row.get('next_run_at'), str) \
                or not row['next_run_at']:
            return []
        next_run_at = row['next_run_at']
        previous = self.ledger.last_seen(owner, task_id)
        if previous is None:
            self.ledger.observe(owner, task_id, next_run_at)
            return []
        if next_run_at == previous:
            return []
        if _instant_key(next_run_at) < _instant_key(previous):
            # The task was rescheduled backwards; adopt the new plan silently.
            self.ledger.observe(owner, task_id, next_run_at)
            return []
        # A platform-side edit after the observed point moved the plan on
        # purpose: the old point was abandoned, not missed (the pinned update
        # endpoint recomputes next_run_at from now on every schedule change).
        updated = _parse_instant(row.get('updated_at'))
        point = _parse_instant(previous)
        if updated is not None and point is not None and updated > point:
            self.ledger.observe(owner, task_id, next_run_at)
            return []
        self.ledger.observe(owner, task_id, next_run_at)
        if self._point_covered(session, task_id, previous, next_run_at):
            return []
        if self._safe_policy(owner, task_id):
            if self.ledger.record_mark(owner, task_id, previous, 'skipped',
                                       'missed while away; skip_on_missed enabled'):
                return [{'taskId': task_id, 'plannedAt': previous, 'outcome': 'skipped',
                         'error': ''}]
            return []
        claimed = self.ledger.record_mark(owner, task_id, previous, 'caught_up',
                                          'missed while away; caught up once on device online')
        if not claimed:
            return []
        try:
            self._trigger(session, task_id)
            return [{'taskId': task_id, 'plannedAt': previous, 'outcome': 'caught_up',
                     'error': ''}]
        except SchedulesError as exc:
            if exc.code in REFUSED_CATEGORIES:
                # A 4xx answer proves nothing was dispatched: the point stays
                # consumed but the mark says refused, not caught up.
                self.ledger.update_mark(owner, task_id, previous, status='skipped',
                                        reason=f'catch-up refused by platform: {exc.code}',
                                        error='')
                return [{'taskId': task_id, 'plannedAt': previous, 'outcome': 'skipped',
                         'error': exc.code}]
            # A 5xx or transport failure is an ambiguous outcome — the dispatch
            # may have happened — so the point stays consumed without a retry.
            self.ledger.update_mark(owner, task_id, previous, error=exc.code)
            return [{'taskId': task_id, 'plannedAt': previous, 'outcome': 'unknown',
                     'error': exc.code}]

    def _point_covered(self, session, task_id, point, window_end) -> bool:
        """True when the platform already processed the planned point.

        Exact planned-point match when a run row names one; otherwise any run
        recorded inside the missed window counts, so an unknown run schema can
        only ever err on the no-duplicate-execution side.
        """
        for row in self._runs(session, task_id):
            if not isinstance(row, dict):
                continue
            for key in _PLANNED_KEYS:
                named = row.get(key)
                if named == point:
                    return True
                if named is not None and _instant_key(named) == _instant_key(point):
                    return True
            created = row.get('created_at')
            if isinstance(created, str) and _instant_key(point) <= _instant_key(created) < _instant_key(window_end):
                return True
        return False
