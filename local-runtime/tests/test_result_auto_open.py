"""Issue 117: the snapshot labels each registered result with its standing
against the *current* workspace grant, so the device can auto-open an
in-authority result file and never auto-open one it cannot prove authorized.

The registry keeps history; the grant moves. Classification is therefore
re-derived per snapshot through desktop.py's own ``classify`` seam and fails
closed: no seam, a stale grant, or any classifier error is ``outside``.
"""
import hashlib
import pytest

from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings
from test_platform_chat import platform

CONTENT = 'RESULT-117-AUTO-OPEN'


def prepare_result(tmp_path, origin, *, task_id='task-117', thread_id='thread-A',
                   seam='wired', reselect_other=False, logical_name='mesh-117.stl'):
    """A Desktop chat with one registered workspace result, mirroring the
    desktop.py wiring including the classify seam under test."""
    from core.local_results import LocalResultRegistry
    from core.platform_chat import DesktopChat
    from core.receipt_ledger import profile_binding
    from core.file_service import WorkspaceSelection, WorkspaceFileService
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    secure.set('device-session-117', 'device-session-117')
    config = tmp_path / 'profile' / 'settings.json'
    work = tmp_path / 'work'
    work.mkdir(exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-117', server_public_key='broker-key-117',
        session_token_ref='device-session-117',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    registry = LocalResultRegistry(config.with_name('local-results.db'))
    root = WorkspaceSelection(config).select(str(work), confirmed=True)['logicalRoot']
    target = work / logical_name
    target.write_text(CONTENT, encoding='utf-8')
    registry.record(profile_binding(settings), dict(task_id=task_id, run_id='run-117',
        thread_id=thread_id, capability='local.files.write', logical_root=root,
        logical_path=f'{root}/{logical_name}', name=logical_name,
        sha256=hashlib.sha256(CONTENT.encode()).hexdigest(), bytes=len(CONTENT.encode())))
    if reselect_other:
        other = tmp_path / 'other-work'
        other.mkdir(exist_ok=True)
        WorkspaceSelection(config).select(str(other), confirmed=True)
    classify = None
    if seam == 'wired':
        classify = lambda path: WorkspaceFileService(WorkspaceSelection(config)).classify(path)
    elif seam == 'protected':
        classify = lambda path: 'protected'
    elif seam == 'raises':
        def classify(path):
            raise RuntimeError('CLASSIFIER_DOWN')
    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       local_results=registry, classify_path=classify)
    return chat, root


def opened_result(chat, task_id='task-117'):
    scope = chat.handle({'action': 'refresh'})['scope']
    opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
    return next(task for task in opened['localTasks'] if task['task_id'] == task_id)


def test_result_inside_current_grant_is_inside(tmp_path):
    with platform() as (origin, records):
        chat, _ = prepare_result(tmp_path, origin)
        row = opened_result(chat)
        assert row['localResult']['workspace_state'] == 'inside'
        # Viewing never uploads: the verdict is metadata only, the artifact
        # boundary stays behind the explicit upload command.
        assert not any(path.endswith('/artifacts') and body is not None
                       for path, body, _ in records)


def test_result_under_stale_grant_is_outside(tmp_path):
    """The grant moved after registration; the old logical root proves nothing."""
    with platform() as (origin, records):
        chat, stale_root = prepare_result(tmp_path, origin, reselect_other=True)
        row = opened_result(chat)
        assert row['localResult']['workspace_state'] == 'outside'
        assert row['localResult']['logical_root'] == stale_root


def test_unwired_classifier_fails_closed_outside(tmp_path):
    with platform() as (origin, records):
        chat, _ = prepare_result(tmp_path, origin, seam='none')
        row = opened_result(chat)
        assert row['localResult']['workspace_state'] == 'outside'


def test_classifier_failure_fails_closed_outside(tmp_path):
    with platform() as (origin, records):
        chat, _ = prepare_result(tmp_path, origin, seam='raises')
        row = opened_result(chat)
        assert row['localResult']['workspace_state'] == 'outside'


def test_protected_verdict_passes_through(tmp_path):
    """A real verdict other than inside is preserved verbatim for honest UI."""
    with platform() as (origin, records):
        chat, _ = prepare_result(tmp_path, origin, seam='protected')
        row = opened_result(chat)
        assert row['localResult']['workspace_state'] == 'protected'


def test_orphan_registry_row_is_classified_too(tmp_path):
    """Results whose task row left the Server history still carry a verdict."""
    with platform() as (origin, records):
        chat, _ = prepare_result(tmp_path, origin, task_id='task-orphan')
        scope = chat.handle({'action': 'refresh'})['scope']
        opened = chat.handle({'action': 'open', 'scope': scope, 'threadId': 'thread-A'})
        orphan = next(task for task in opened['localTasks'] if task['task_id'] == 'task-orphan')
        assert orphan['status'] == 'unknown'
        assert orphan['localResult']['workspace_state'] == 'inside'
