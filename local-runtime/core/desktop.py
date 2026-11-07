"""Owned status/login channel. Executable tasks arrive only by signed WSS."""
from __future__ import annotations

import argparse
import base64
import json
import platform
import queue
import re
import sys
import threading
import uuid
from pathlib import Path

from .audit import LocalAuditLog
from .browser_control import BrowserControlService
from .browser_login import BrowserLogin
from .browser_remote import BrowserStreamProxy, normalize_input_event
from .compatibility import CompatibilityGate
from .connector_install import ConnectorInstallError
from .datasets import DatasetError, DatasetRegistry, datasets_manage
from .local_results import LocalResultRegistry
from .platform_chat import DesktopChat, empty_state
from .session_tier import SessionTierRegistry
from .process_job import own_process_tree
from .settings import load_settings
from .file_service import WorkspaceSelection, WorkspaceFileStore
from .files import FileAccessError, RootConfig
from .inline_code import InlineScriptStore
from .knowledge_import import (KnowledgeFolderImport, KnowledgeImportError, KnowledgeImportRegistry,
                               category_for)
from .knowledge_index import KnowledgeIndexError, KnowledgeIndexRebuild, KnowledgeIndexStore
from .knowledge_publish import KnowledgePublicationRegistry, KnowledgePublishError
from .project_binding import ProjectBindingError, ProjectBindingRegistry
from .skill_import import SkillImportError, SkillImportRegistry
from .skill_script import SkillScriptError
from .secrets import SecretStoreError, create_default_secret_store
from .task_guard import TaskGuard
from .receipt_ledger import ReceiptLedger, ReceiptStorageError, profile_binding
from .receipts import content_hash
from .scheduled_tasks import SchedulesError
from .tray import load_controller


def browse_files_view(workspace, protected_root, action, logical_path):
    """Issue 94: the human file-browsing seam.

    A human looking at their own confirmed workspace folder is free — this
    path consults no policy and no consent store, and records no grant rows.
    It reuses the workspace store's guarded resolution so a browse or a
    preview cannot reach farther than the Agent's read path could. The only
    physical path this can produce rides ``locate`` back to the trusted main
    process for an external open; it never reaches the renderer.
    """
    settings, grant = workspace.current()
    files = WorkspaceFileStore(
        [RootConfig(grant['logical_root'], Path(grant['physical_root']),
                    identity=tuple(grant['identity']), resolve_root=False)],
        protected_roots=(protected_root,))
    if action == 'list':
        entries, truncated = files.list_details_with_limit(logical_path)
        return {'entries': entries, 'truncated': truncated}
    if action == 'read':
        return files.preview(logical_path)
    if action == 'locate':
        return {'physical': str(files.resolve(logical_path))}
    raise FileAccessError('FILES_FAILED')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument('--update-health', action='store_true')
    parser.add_argument('--desktop-version', default='0.1.0')
    # Issue 105: the app's own executable, passed by the Desktop shell so
    # inline Node code runs the pinned app runtime under ELECTRON_RUN_AS_NODE.
    parser.add_argument('--node-executable', default=None)
    args = parser.parse_args()
    job = own_process_tree()
    stop = threading.Event()
    commands: queue.Queue = queue.Queue(maxsize=1)
    workspace_commands: queue.Queue = queue.Queue(maxsize=1)
    receipt_commands: queue.Queue = queue.Queue(maxsize=1)
    management_commands: queue.Queue = queue.Queue(maxsize=1)
    drain_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_publish_commands: queue.Queue = queue.Queue(maxsize=1)
    # Issue 96: the doc library's background folder import (start/cancel) and
    # the batch management of the import records (delete/retry).
    knowledge_folder_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_folder_cancel_commands: queue.Queue = queue.Queue(maxsize=1)
    # Issue 97: the doc library's background index rebuild (start/cancel),
    # same one-job discipline as the folder import.
    knowledge_index_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_index_cancel_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_manage_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_graph_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_wiki_commands: queue.Queue = queue.Queue(maxsize=1)
    skill_commands: queue.Queue = queue.Queue(maxsize=1)
    skill_preference_commands: queue.Queue = queue.Queue(maxsize=1)
    skill_script_commands: queue.Queue = queue.Queue(maxsize=1)
    model_commands: queue.Queue = queue.Queue(maxsize=1)
    template_commands: queue.Queue = queue.Queue(maxsize=1)
    thread_commands: queue.Queue = queue.Queue(maxsize=1)
    project_commands: queue.Queue = queue.Queue(maxsize=1)
    dataset_commands: queue.Queue = queue.Queue(maxsize=1)
    schedule_commands: queue.Queue = queue.Queue(maxsize=1)
    connector_commands: queue.Queue = queue.Queue(maxsize=1)
    files_commands: queue.Queue = queue.Queue(maxsize=1)
    # Issue 109: the remote browser's stream lifecycle rides one slot like the
    # other session families; input forwarding is high-rate by design and
    # gets its own bounded queue instead.
    browser_stream_commands: queue.Queue = queue.Queue(maxsize=1)
    browser_input_commands: queue.Queue = queue.Queue(maxsize=256)
    browser_streams: dict = {}
    # Issue 108: the Desktop's replies to the agent's consented browser
    # actions. One slot per in-flight request would dead-lock the reader on a
    # wedged service, so the bounded queue absorbs them until the main loop
    # routes each to its waiting task.
    browser_control_results: queue.Queue = queue.Queue(maxsize=64)
    chat_commands: queue.Queue = queue.Queue(maxsize=8)
    install_draining = args.update_health
    output_lock = threading.Lock()

    def emit(value):
        with output_lock:
            print(json.dumps(value), flush=True)

    def read_control() -> None:
        for line in sys.stdin:
            if line.strip() == '{"type":"shutdown"}':
                break
            try:
                if len(line) > 131072:
                    continue
                command = json.loads(line)
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'echo'}
                        and command['type'] == 'health' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and command['echo'] == 'ideer-update-health-v1'):
                    emit({'v': 1, 'type': 'health', 'id': command['id'], 'echo': command['echo'],
                          'python': '.'.join(map(str, sys.version_info[:3])), 'pid': __import__('os').getpid()})
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'action', 'grantId', 'scope'}
                        and command['type'] == 'manage' and command['action'] in {'logout', 'switch-account', 'revoke'}
                        and all(isinstance(command[key], str) and len(command[key]) <= 128 for key in ('id', 'grantId', 'scope'))):
                    management_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'action', 'scope'}
                        and command['type'] == 'install-drain' and command['action'] in {'begin', 'abort'}
                        and all(isinstance(command[key], str) and len(command[key]) <= 128 for key in ('id', 'scope'))):
                    drain_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'action', 'offset', 'scope'}
                        and command['type'] == 'receipts' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and command['action'] in {'history', 'clear-confirmed'}
                        and type(command['offset']) is int and 0 <= command['offset'] <= 1000000000):
                    receipt_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'kbId', 'paths', 'scope'}
                        and command['type'] == 'knowledge-import' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['kbId'], str)
                        and len(command['kbId']) <= 64 and isinstance(command['paths'], list)
                        and 1 <= len(command['paths']) <= 200
                        and all(isinstance(path, str) and 0 < len(path) <= 32768 for path in command['paths'])
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'kbId', 'path', 'scope'}
                        and command['type'] == 'knowledge-folder-import' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['kbId'], str)
                        and len(command['kbId']) <= 64 and isinstance(command['path'], str)
                        and 0 < len(command['path']) <= 32768
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_folder_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id'}
                        and command['type'] == 'knowledge-folder-import-cancel'
                        and isinstance(command['id'], str) and len(command['id']) <= 64):
                    knowledge_folder_cancel_commands.put_nowait(command)
                    continue
                # Issue 97: the index rebuild for one registered revision —
                # the renderer names the frozen identity only; the workspace
                # re-verification happens device-side on the job's own thread.
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'kbId', 'revisionId', 'manifestHash', 'scope'}
                        and command['type'] == 'knowledge-index-rebuild' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['kbId'], str)
                        and len(command['kbId']) <= 64 and isinstance(command['revisionId'], str)
                        and len(command['revisionId']) <= 64
                        and isinstance(command['manifestHash'], str)
                        and re.fullmatch(r'[0-9a-f]{64}', command['manifestHash'])
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_index_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id'}
                        and command['type'] == 'knowledge-index-rebuild-cancel'
                        and isinstance(command['id'], str) and len(command['id']) <= 64):
                    knowledge_index_cancel_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'ids', 'scope'}
                        and command['type'] == 'knowledge-imports-delete' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['ids'], list)
                        and 1 <= len(command['ids']) <= 100
                        and all(isinstance(item, str) and re.fullmatch(r'[0-9a-f]{64}', item)
                                for item in command['ids'])
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_manage_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'recordId', 'scope'}
                        and command['type'] == 'knowledge-import-retry' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['recordId'], str)
                        and re.fullmatch(r'[0-9a-f]{64}', command['recordId'])
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_manage_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'kbId', 'revisionId', 'paths', 'confirmed', 'scope'}
                        and command['type'] == 'knowledge-publish' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['kbId'], str)
                        and len(command['kbId']) <= 64 and isinstance(command['revisionId'], str)
                        and len(command['revisionId']) <= 64 and isinstance(command['paths'], list)
                        and 1 <= len(command['paths']) <= 200
                        and all(isinstance(path, str) and 0 < len(path) <= 32768 for path in command['paths'])
                        and command['confirmed'] in (True, False)
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_publish_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'kbId', 'revisionId', 'action', 'scope'},
                        {'type', 'id', 'kbId', 'revisionId', 'action', 'documentId', 'scope'},
                        {'type', 'id', 'kbId', 'revisionId', 'action', 'documentIds', 'query', 'scope'})
                        and command['type'] == 'knowledge-graph' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['kbId'], str)
                        and len(command['kbId']) <= 64 and isinstance(command['revisionId'], str)
                        and len(command['revisionId']) <= 64
                        and command['action'] in {'view', 'generate', 'locate', 'search', 'ask', 'similarity'}
                        and (command['action'] != 'locate' or isinstance(command.get('documentId'), str))
                        and (command['action'] not in {'search', 'ask'} or (
                            isinstance(command.get('documentIds'), list)
                            and 1 <= len(command['documentIds']) <= 50
                            and all(isinstance(d, str) and 0 < len(d) <= 64 for d in command['documentIds'])
                            and isinstance(command.get('query'), str) and 0 < len(command['query']) <= 4000))
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_graph_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'kbId', 'revisionId', 'action', 'scope'},
                        {'type', 'id', 'kbId', 'revisionId', 'action', 'documentId', 'scope'})
                        and command['type'] == 'knowledge-wiki' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['kbId'], str)
                        and len(command['kbId']) <= 64 and isinstance(command['revisionId'], str)
                        and len(command['revisionId']) <= 64
                        and command['action'] in {'view', 'generate', 'read', 'navigate'}
                        and (command['action'] != 'read' or isinstance(command.get('documentId'), str))
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    knowledge_wiki_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'action', 'kind', 'paths', 'confirmed', 'scope'},
                        {'type', 'id', 'action', 'resourceId', 'expectedDraftRevision', 'scope'})
                        and command['type'] == 'skills' and isinstance(command['id'], str)
                        and len(command['id']) <= 64
                        and command['action'] in {'import', 'publish'}
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128
                        and (command['action'] != 'import' or (
                            command['kind'] in ('markdown', 'zip', 'directory')
                            and isinstance(command['paths'], list)
                            and 1 <= len(command['paths']) <= 1
                            and all(isinstance(path, str) and 0 < len(path) <= 32768 for path in command['paths'])
                            and command['confirmed'] in (True, False)))
                        and (command['action'] != 'publish' or (
                            isinstance(command['resourceId'], str) and len(command['resourceId']) <= 64
                            and type(command['expectedDraftRevision']) is int
                            and 1 <= command['expectedDraftRevision'] <= 1000000))):
                    skill_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'action', 'scope'},
                        {'type', 'id', 'action', 'authorizationId', 'scope'})
                        and command['type'] == 'skill-scripts' and isinstance(command['id'], str)
                        and len(command['id']) <= 64
                        and command['action'] in {'list', 'revoke'}
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128
                        and (command['action'] != 'revoke' or (
                            isinstance(command.get('authorizationId'), str)
                            and 0 < len(command['authorizationId']) <= 128))):
                    skill_script_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'action', 'scope'},
                        {'type', 'id', 'action', 'query', 'scope'},
                        {'type', 'id', 'action', 'threadId', 'scope'},
                        {'type', 'id', 'action', 'threadId', 'title', 'scope'},
                        {'type', 'id', 'action', 'threadId', 'projectId', 'scope'})
                        and command['type'] == 'threads' and isinstance(command['id'], str)
                        and len(command['id']) <= 64
                        and command['action'] in {'list', 'search', 'rename', 'delete', 'move'}
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128
                        and (command['action'] != 'search' or (
                            isinstance(command['query'], str) and len(command['query']) <= 128))
                        and (command['action'] != 'rename' or (
                            isinstance(command['threadId'], str) and 0 < len(command['threadId']) <= 128
                            and isinstance(command['title'], str)
                            and 0 < len(command['title'].strip()) <= 200))
                        and (command['action'] != 'delete' or (
                            isinstance(command['threadId'], str) and 0 < len(command['threadId']) <= 128))
                        and (command['action'] != 'move' or (
                            isinstance(command['threadId'], str) and 0 < len(command['threadId']) <= 128
                            and isinstance(command['projectId'], str)
                            and 0 < len(command['projectId']) <= 128))):
                    thread_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'action', 'scope'},
                        {'type', 'id', 'action', 'name', 'scope'},
                        {'type', 'id', 'action', 'projectId', 'name', 'scope'},
                        {'type', 'id', 'action', 'projectId', 'scope'},
                        {'type', 'id', 'action', 'projectId', 'path', 'scope'})
                        and command['type'] == 'projects' and isinstance(command['id'], str)
                        and len(command['id']) <= 64
                        and command['action'] in {'list', 'create', 'rename', 'archive', 'restore', 'delete',
                                                  'bind-folder', 'unbind-folder'}
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128
                        and (command['action'] != 'create' or (
                            isinstance(command['name'], str) and 0 < len(command['name'].strip()) <= 128))
                        and (command['action'] != 'rename' or (
                            isinstance(command['projectId'], str) and 0 < len(command['projectId']) <= 128
                            and isinstance(command['name'], str)
                            and 0 < len(command['name'].strip()) <= 128))
                        and (command['action'] not in {'archive', 'restore', 'delete', 'bind-folder', 'unbind-folder'} or (
                            isinstance(command['projectId'], str) and 0 < len(command['projectId']) <= 128))
                        and (command['action'] != 'bind-folder' or (
                            isinstance(command['path'], str) and 0 < len(command['path']) <= 1024))):
                    project_commands.put_nowait(command)
                    continue
                # Issue 102: the table dataset family. A fixed per-action key
                # set only: import names the main-process-picked file and the
                # selected platform project (empty = unassociated), delete
                # names the registry row. The path never reaches a renderer.
                # The per-action fields are read with .get so a cross-action
                # key set can never raise inside this reader (the loop guard
                # only catches ValueError/queue.Full), matching the
                # knowledge-graph/skill-scripts gate idiom.
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'action', 'path', 'projectId', 'scope'},
                        {'type', 'id', 'action', 'datasetId', 'scope'})
                        and command.get('type') == 'datasets' and isinstance(command.get('id'), str)
                        and len(command['id']) <= 64
                        and command.get('action') in {'import', 'delete'}
                        and isinstance(command.get('scope'), str) and len(command['scope']) <= 128
                        and (command['action'] != 'import' or (
                            isinstance(command.get('path'), str) and 0 < len(command['path']) <= 32768
                            and isinstance(command.get('projectId'), str)
                            and len(command['projectId']) <= 128))
                        and (command['action'] != 'delete' or (
                            isinstance(command.get('datasetId'), str)
                            and 0 < len(command['datasetId']) <= 128))):
                    dataset_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and command.get('type') == 'skill-preferences'
                        and isinstance(command.get('id'), str) and len(command['id']) <= 64
                        and isinstance(command.get('scope'), str) and len(command['scope']) <= 128
                        and command.get('action') in {'list', 'set', 'clear'}
                        and (command['action'] == 'list' and set(command) == {'type', 'id', 'action', 'scope'}
                             or command['action'] == 'clear' and set(command) == {'type', 'id', 'action', 'skillId', 'scope'}
                             and isinstance(command.get('skillId'), str) and len(command['skillId']) <= 64
                             or command['action'] == 'set' and set(command) == {'type', 'id', 'action', 'skillId', 'enabled',
                                                                                'keywords', 'alwaysInject', 'applicableAgentIds',
                                                                                'priority', 'scope'}
                             and isinstance(command.get('skillId'), str) and len(command['skillId']) <= 64
                             and type(command.get('enabled')) is bool
                             and isinstance(command.get('keywords'), list) and len(command['keywords']) <= 16
                             and all(isinstance(keyword, str) and 0 < len(keyword.strip()) <= 64 for keyword in command['keywords'])
                             and type(command.get('alwaysInject')) is bool
                             and isinstance(command.get('applicableAgentIds'), list) and len(command['applicableAgentIds']) <= 32
                             and all(isinstance(agent_id, str) and 0 < len(agent_id) <= 64 for agent_id in command['applicableAgentIds'])
                             and type(command.get('priority')) is int and not isinstance(command.get('priority'), bool)
                             and -1000 <= command['priority'] <= 1000)):
                    skill_preference_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and command.get('type') == 'models'
                        and isinstance(command.get('id'), str) and len(command['id']) <= 64
                        and isinstance(command.get('scope'), str) and len(command['scope']) <= 128
                        and command.get('action') in {'list', 'set-default', 'set-fallback'}
                        and (command['action'] == 'list' and set(command) == {'type', 'id', 'action', 'scope'}
                             or command['action'] in {'set-default', 'set-fallback'}
                             and set(command) == {'type', 'id', 'action', 'modelName', 'scope'}
                             and isinstance(command.get('modelName'), str)
                             and len(command['modelName']) <= 200)):
                    model_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and command.get('type') == 'schedules'
                        and isinstance(command.get('id'), str) and len(command['id']) <= 64
                        and isinstance(command.get('scope'), str) and len(command['scope']) <= 128
                        and command.get('action') in {'list', 'get', 'create', 'update', 'pause',
                                                      'resume', 'trigger', 'delete', 'runs',
                                                      'set-skip', 'preview'}):
                    # Issue 85: the per-action key sets are the client's own
                    # contract (same split as the chat family) — this gate
                    # only fixes the envelope before it reaches the queue.
                    schedule_commands.put_nowait(command)
                # Issue 84: the prompt-template plaza. A fixed per-action key
                # set only; the rows and their visibility live Server-side.
                # Issue 106: `official-list` joins as the welcome page's one
                # read over the same family.
                if (isinstance(command, dict) and command.get('type') == 'templates'
                        and isinstance(command.get('id'), str) and len(command['id']) <= 64
                        and isinstance(command.get('scope'), str) and len(command['scope']) <= 128
                        and command.get('action') in {'list', 'official-list', 'create', 'update',
                                                      'delete', 'use'}
                        and (command['action'] in {'list', 'official-list'}
                             and set(command) == {'type', 'id', 'action', 'scope'}
                             or command['action'] == 'create'
                             and set(command) == {'type', 'id', 'action', 'name', 'category', 'content', 'scope'}
                             and isinstance(command.get('name'), str)
                             and 0 < len(command['name'].strip()) <= 200
                             and isinstance(command.get('category'), str)
                             and len(command['category']) <= 64
                             and isinstance(command.get('content'), str)
                             and 0 < len(command['content'].strip()) <= 16000
                             or command['action'] in {'delete', 'use'}
                             and set(command) == {'type', 'id', 'action', 'templateId', 'scope'}
                             and isinstance(command.get('templateId'), str)
                             and 0 < len(command['templateId']) <= 128
                             or command['action'] == 'update'
                             and isinstance(command.get('templateId'), str)
                             and 0 < len(command['templateId']) <= 128
                             and {'type', 'id', 'action', 'templateId', 'scope'} <= set(command)
                             and set(command) <= {'type', 'id', 'action', 'templateId', 'name',
                                                  'category', 'content', 'scope'}
                             and len(set(command)) >= 6
                             and all(isinstance(command.get(key), str) for key in
                                     ('name', 'category', 'content') if key in command)
                             and all(0 < len(command[key].strip()) <= 200 for key in ('name',) if key in command)
                             and all(len(command[key]) <= 64 for key in ('category',) if key in command)
                             and all(0 < len(command[key].strip()) <= 16000 for key in ('content',) if key in command))):
                    template_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) in (
                        {'type', 'id', 'action', 'scope'},
                        {'type', 'id', 'action', 'path', 'confirmed', 'scope'},
                        {'type', 'id', 'action', 'slug', 'confirmed', 'scope'})
                        and command['type'] == 'connectors' and isinstance(command['id'], str)
                        and len(command['id']) <= 64
                        and command['action'] in {'preview', 'install', 'remove', 'list'}
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128
                        and (command['action'] not in {'preview', 'install'} or (
                            isinstance(command['path'], str) and 0 < len(command['path']) <= 32768
                            and command['confirmed'] in (True, False)))
                        and (command['action'] != 'remove' or (
                            isinstance(command['slug'], str) and 0 < len(command['slug']) <= 64
                            and command['confirmed'] in (True, False)))):
                    connector_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'path', 'confirmed', 'scope'}
                        and command['type'] == 'workspace' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['path'], str)
                        and len(command['path']) <= 32768 and command['confirmed'] is True
                        and isinstance(command['scope'], str)):
                    workspace_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'action', 'path', 'scope'}
                        and command['type'] == 'files' and isinstance(command['id'], str)
                        and len(command['id']) <= 64
                        and command['action'] in {'list', 'read', 'locate'}
                        and isinstance(command['path'], str) and 0 < len(command['path']) <= 4096
                        and isinstance(command['scope'], str) and len(command['scope']) <= 128):
                    files_commands.put_nowait(command)
                    continue
                # Issue 109: the remote browser stream. Open names the owned
                # Thread plus the chat session scope (the fence re-checks it);
                # close needs nothing else. Input events are shape-checked in
                # the handler, where the bounded event vocabulary lives.
                if (isinstance(command, dict)
                        and command.get('type') == 'browser-stream'
                        and command.get('action') in {'open', 'close'}
                        and isinstance(command.get('id'), str) and len(command['id']) <= 64
                        and (command['action'] == 'close' and set(command) == {'type', 'id', 'action'}
                             or command['action'] == 'open'
                             and set(command) == {'type', 'id', 'action', 'threadId', 'scope'}
                             and isinstance(command['threadId'], str)
                             and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', command['threadId'])
                             and isinstance(command['scope'], str) and 0 < len(command['scope']) <= 128)):
                    browser_stream_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'streamId', 'event'}
                        and command['type'] == 'browser-input'
                        and isinstance(command['id'], str) and len(command['id']) <= 64
                        and isinstance(command['streamId'], str) and 0 < len(command['streamId']) <= 64
                        and isinstance(command['event'], dict)):
                    browser_input_commands.put_nowait(command)
                    continue
                # Issue 108: the Desktop's reply to one consented browser
                # action. The result body is whatever the Desktop sent - the
                # waiting service validates the bounds, not the reader.
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'result', 'error'}
                        and command['type'] == 'browser-control-result'
                        and isinstance(command['id'], str) and 0 < len(command['id']) <= 64
                        and isinstance(command['error'], str)):
                    browser_control_results.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'command'}
                        and command['type'] == 'chat' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['command'], dict)):
                    chat_commands.put_nowait(command)
                    continue
                if (isinstance(command, dict) and set(command) == {"type", "serverUrl", "deviceName"}
                        and command["type"] == "login" and isinstance(command["serverUrl"], str)
                        and isinstance(command["deviceName"], str)):
                    commands.put_nowait(command)
            except (ValueError, queue.Full):
                pass
        stop.set()

    threading.Thread(target=read_control, daemon=True).start()
    controller = None
    try:
        login = BrowserLogin(args.config, create_default_secret_store())
        try:
            login.restore()
        except SecretStoreError:
            login.fail("SECURE_STORAGE_FAILED")
        except Exception:
            login.fail("LOGIN_REAUTHENTICATION_REQUIRED")

        workspace = WorkspaceSelection(args.config)
        # Issue 105: one scratch store per runtime process. The chat layer
        # sweeps sessions through it; the controller's python service
        # materializes into it, so both always see the same workspace tree.
        inline_scripts = InlineScriptStore(None)
        def stop_controller():
            nonlocal controller
            previous, controller = controller, None
            if previous is not None:
                # Fence the old service before a bounded thread join. A slow
                # shutdown must never regain permission after a new login.
                previous.client.file_service.available = lambda: False
                previous.stop()

        def local_consents():
            return controller.pending_consents() if controller is not None else ()

        def decide_consent(task_id, digest, approved, *, directory=False, always=False):
            if controller is None or login.status()['state'] != 'authenticated':
                raise ValueError('CONSENT_UNAVAILABLE')
            controller.client.resolve_local_consent(task_id, approved=approved, expected_hash=digest,
                                                    directory=directory, always=always)

        args.config.parent.mkdir(parents=True, exist_ok=True)
        receipts = ReceiptLedger(args.config.with_name('receipts.db'))
        # Issue 74: the chat session tiers and the audit log they are recorded
        # in are one device-level pair, shared by the chat surface and the
        # transport session.
        audit_log = LocalAuditLog(db_path=args.config.with_name("audit.db"))
        session_tiers = SessionTierRegistry(audit=audit_log)
        # Issue 108: the agent's controlled browser channel rides this
        # process's stdout/stdin wire. One service lives across reconnects,
        # so a rebuilt controller re-attaches the same instance and a pending
        # action's future survives the socket it started under; the policy is
        # read fresh on every execution so tray regrades apply immediately.
        browser_control = BrowserControlService(emit=emit, policy=lambda: controller.client.policy if controller is not None else None)
        # Registered local results are display-only metadata for this identity;
        # they reach a Thread artifact only through the explicit chat upload
        # command, never through observation or task execution.
        local_results = LocalResultRegistry(args.config.with_name('local-results.db'))
        # Issue 112: explicit local imports keep the same discipline — the
        # registry stores device-local display facts, never file content.
        knowledge_imports = KnowledgeImportRegistry(args.config.with_name('knowledge-imports.db'))
        # Issue 97: the device BM25 index behind the frozen revisions — the
        # same binding-scoped identity discipline, device-local text only.
        knowledge_index = KnowledgeIndexStore(args.config.with_name('knowledge-index.db'))
        # Issue 102: table dataset imports keep the same registry discipline —
        # device-local display facts (schema, counts, fingerprints), never row
        # data, and the original file stays on this machine.
        datasets_registry = DatasetRegistry(args.config.with_name('datasets.db'))
        # Issue 115: explicit publications record the outcome of a confirmed
        # server copy attempt; a preview alone never writes a row.
        knowledge_publications = KnowledgePublicationRegistry(args.config.with_name('knowledge-publications.db'))
        # Issue 120: explicit skill package imports keep the same registry
        # discipline — device-local display facts, never package content.
        skill_imports = SkillImportRegistry(args.config.with_name('skill-imports.db'))
        # Issue 92: one device-local row per platform project+device; the
        # binding never migrates and never touches local files or grants.
        project_bindings = ProjectBindingRegistry(args.config.with_name('project-bindings.db'))
        compatibility = CompatibilityGate(args.config, desktop_version=args.desktop_version,
                                          runtime_python=platform.python_version())
        def local_receipts(thread_id, run_ids):
            owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
            return receipts.thread_history(owner, thread_id, run_ids)
        def stop_local(run_id):
            if controller is not None:
                controller.stop_run(run_id)
            else:
                settings = load_settings(args.config)
                TaskGuard(args.config.with_name('tasks.db')).stop_run(settings.device_id, run_id)
        def knowledge_files():
            """The confirmed workspace store for explicit imports; nothing is implicit."""
            if login.status()['state'] != 'authenticated':
                raise FileAccessError('WORKSPACE_UNAVAILABLE')
            settings, grant = workspace.current()
            files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
                identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(args.config.parent,))
            return settings, grant, files
        chat = DesktopChat(args.config, login.secure, login.status, local_consents=local_consents,
            decide_consent=decide_consent, local_receipts=local_receipts, stop_local=stop_local,
            local_results=local_results, compatibility_gate=compatibility,
            knowledge_imports=knowledge_imports, knowledge_files=knowledge_files,
            knowledge_publications=knowledge_publications, skill_imports=skill_imports,
            session_tiers=session_tiers, inline_scripts=inline_scripts,
            project_bindings=project_bindings, knowledge_index=knowledge_index)
        # Issue 96: the doc library's background folder import. One job at a
        # time on its own daemon thread; progress rides the status snapshot
        # and the cancel command lands at the next file or batch boundary.
        folder_imports = KnowledgeFolderImport(chat.register_import_entries, knowledge_files,
                                               knowledge_imports)
        # Issue 97: the index rebuild job — same one-job discipline as the
        # folder import; it re-verifies every manifest document against the
        # live bytes and re-indexes what still hashes to its frozen digest.
        index_rebuilds = KnowledgeIndexRebuild(knowledge_files, knowledge_imports, knowledge_index)

        def chat_control():
            while not stop.is_set():
                try:
                    command = chat_commands.get(timeout=0.5)
                except queue.Empty:
                    continue
                try:
                    result = chat.handle(command['command'])
                except Exception:
                    result = empty_state()
                    result['error'] = 'CHAT_PROTOCOL_ERROR'
                emit({'v': 1, 'type': 'chat', 'id': command['id'], 'result': result})

        threading.Thread(target=chat_control, daemon=True).start()

        def connect():
            if install_draining:
                return None
            settings = load_settings(args.config)
            if not settings.server_url or not settings.device_id:
                return None
            if login.status()["state"] != "authenticated":
                return None
            # Desktop uses the existing pairing and OS secure store only.
            if not settings.session_token_ref or not settings.device_key_ref or not settings.server_public_key:
                raise ValueError("PAIRING_REQUIRED")
            if settings.session_token or settings.allow_unpinned_broker_key:
                raise ValueError("PAIRING_REQUIRED")
            from cryptography.hazmat.primitives.serialization import load_pem_private_key
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
            secure = create_default_secret_store()
            private_key = load_pem_private_key(base64.b64decode(secure.get(settings.device_key_ref)), password=None)
            if not isinstance(private_key, Ed25519PrivateKey):
                raise ValueError("PAIRING_REQUIRED")
            from .protocol import public_key_text
            actual_key = public_key_text(private_key)
            if settings.device_public_key != actual_key:
                settings.device_public_key = actual_key
                settings.save(args.config)
            args.config.parent.mkdir(parents=True, exist_ok=True)
            controller = load_controller(args.config, private_key=private_key, desktop_mode=True,
                audit=audit_log, node_executable=args.node_executable,
                inline_scripts=inline_scripts)
            if not controller.settings.session_token:
                raise ValueError("PAIRING_REQUIRED")
            controller.client.task_guard = TaskGuard(args.config.with_name("tasks.db"))
            controller.client.receipt_ledger = receipts
            controller.client.local_results = local_results
            # Issue 74: the consent coordinator reads the chat session's tier
            # from the same registry the chat commands write.
            controller.client.session_tiers = session_tiers
            # Issue 108: every rebuilt controller rides the same browser
            # channel service (created once above this connect()).
            controller.client.browser_control = browser_control
            connector_service = getattr(controller, 'connector_service', None)
            if connector_service is not None:
                # Issue 123: the platform canonical identity rides this
                # device's own authenticated session; identity fields only.
                connector_service.registrar = chat.register_connector_identity
                connector_service.unregister = chat.unregister_connector_identity
            compatibility.bind()
            controller.client.compatibility_gate = compatibility
            controller.client.user_id = settings.user_id
            owner = profile_binding(settings)
            controller.client.file_service.available = lambda: (
                login.status()['state'] == 'authenticated' and controller.client.connected
                and profile_binding(load_settings(args.config)) == owner)
            controller.start()
            return controller

        controller = connect()
        while not stop.is_set():
            browser_url = None
            try:
                drain_command = drain_commands.get_nowait()
            except queue.Empty:
                drain_command = None
            if drain_command:
                error = ''
                try:
                    if drain_command['scope'] != workspace.scope():
                        raise ValueError('IDENTITY_CHANGED')
                    install_draining = drain_command['action'] == 'begin'
                    if drain_command['action'] == 'begin':
                        if controller is not None:
                            controller.client.begin_install_drain()
                    elif controller is not None:
                        controller.client.abort_install_drain()
                    elif not install_draining:
                        controller = connect()
                except Exception:
                    error = 'DRAIN_FAILED'
                emit({'v': 1, 'type': 'install-drain', 'id': drain_command['id'], 'error': error})
            try:
                management = management_commands.get_nowait()
            except queue.Empty:
                management = None
            if management:
                error = ''
                try:
                    if management['scope'] != workspace.scope():
                        raise ValueError('IDENTITY_CHANGED')
                    stop_controller()
                    if management['action'] == 'revoke':
                        if login.status()['state'] != 'authenticated':
                            raise ValueError('LOGIN_REQUIRED')
                        workspace.revoke(management['grantId'])
                        controller = connect()
                    else:
                        login.logout(forget_device=management['action'] == 'switch-account')
                except Exception:
                    error = 'MANAGEMENT_FAILED'
                emit({'v': 1, 'type': 'manage', 'id': management['id'], 'error': error})
            try:
                receipt_command = receipt_commands.get_nowait()
            except queue.Empty:
                receipt_command = None
            if receipt_command:
                error = ''
                receipt_owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
                try:
                    if receipt_command['action'] == 'clear-confirmed':
                        if receipt_owner is None or receipt_command['scope'] != content_hash(receipt_owner):
                            error = 'RECEIPT_BINDING_CHANGED'
                        else:
                            receipts.clear_confirmed(receipt_owner)
                except ReceiptStorageError:
                    error = 'RECEIPT_STORAGE_UNAVAILABLE'
                emit({'v': 1, 'type': 'receipts', 'id': receipt_command['id'],
                      'result': receipts.snapshot(receipt_owner, offset=receipt_command['offset']), 'error': error})
            try:
                knowledge_command = knowledge_commands.get_nowait()
            except queue.Empty:
                knowledge_command = None
            if knowledge_command:
                error = ''
                result = None
                try:
                    if knowledge_command['scope'] != workspace.scope():
                        raise KnowledgeImportError('KNOWLEDGE_IMPORT_IDENTITY_CHANGED')
                    result = chat.register_local_import(knowledge_command['kbId'], knowledge_command['paths'])
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; an
                    # unexpected failure never leaks paths or content.
                    error = category_for(exc)
                    if error == 'KNOWLEDGE_IMPORT_FAILED' and str(exc).startswith('CHAT_'):
                        error = str(exc)
                emit({'v': 1, 'type': 'knowledge-import', 'id': knowledge_command['id'],
                      'result': result, 'error': error})
            try:
                folder_command = knowledge_folder_commands.get_nowait()
            except queue.Empty:
                folder_command = None
            if folder_command:
                error = ''
                result = None
                try:
                    if folder_command['scope'] != workspace.scope():
                        raise KnowledgeImportError('KNOWLEDGE_IMPORT_IDENTITY_CHANGED')
                    result = folder_imports.start(folder_command['kbId'], folder_command['path'])
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; an
                    # unexpected failure never leaks paths or content.
                    error = category_for(exc)
                    if error == 'KNOWLEDGE_IMPORT_FAILED' and str(exc).startswith('CHAT_'):
                        error = str(exc)
                emit({'v': 1, 'type': 'knowledge-folder-import', 'id': folder_command['id'],
                      'result': result, 'error': error})
            try:
                folder_cancel = knowledge_folder_cancel_commands.get_nowait()
            except queue.Empty:
                folder_cancel = None
            if folder_cancel:
                # The event lands at the worker's next file or batch boundary;
                # a cancel without a running job is silently a no-op.
                folder_imports.cancel()
                emit({'v': 1, 'type': 'knowledge-folder-import-cancel', 'id': folder_cancel['id'],
                      'result': {'canceled': True}, 'error': ''})
            try:
                index_command = knowledge_index_commands.get_nowait()
            except queue.Empty:
                index_command = None
            if index_command:
                error = ''
                result = None
                try:
                    if index_command['scope'] != workspace.scope():
                        raise KnowledgeIndexError('KNOWLEDGE_INDEX_IDENTITY_CHANGED')
                    owner = profile_binding(load_settings(args.config)) \
                        if login.status()['state'] == 'authenticated' else None
                    if owner is None:
                        raise KnowledgeIndexError('KNOWLEDGE_INDEX_UNAUTHENTICATED')
                    # Only a revision this identity registered on this device
                    # can ever be re-indexed here, the same fail-closed lookup
                    # the frozen retrieval performs.
                    if knowledge_imports.find_registration(owner, index_command['revisionId'],
                                                           index_command['manifestHash']) is None:
                        raise KnowledgeIndexError('KNOWLEDGE_INDEX_REVISION_UNKNOWN')
                    result = index_rebuilds.start(index_command['kbId'], index_command['revisionId'],
                                                  index_command['manifestHash'])
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; an
                    # unexpected failure never leaks paths or content.
                    message = str(exc)
                    error = message if message.startswith(('KNOWLEDGE_INDEX_', 'IMPORT_STORAGE_UNAVAILABLE')) \
                        else 'KNOWLEDGE_INDEX_FAILED'
                emit({'v': 1, 'type': 'knowledge-index-rebuild', 'id': index_command['id'],
                      'result': result, 'error': error})
            try:
                index_cancel = knowledge_index_cancel_commands.get_nowait()
            except queue.Empty:
                index_cancel = None
            if index_cancel:
                # The event lands at the worker's next document boundary; a
                # cancel without a running job is silently a no-op.
                index_rebuilds.cancel()
                emit({'v': 1, 'type': 'knowledge-index-rebuild-cancel', 'id': index_cancel['id'],
                      'result': {'canceled': True}, 'error': ''})
            try:
                manage_command = knowledge_manage_commands.get_nowait()
            except queue.Empty:
                manage_command = None
            if manage_command:
                error = ''
                result = None
                try:
                    if manage_command['scope'] != workspace.scope():
                        raise KnowledgeImportError('KNOWLEDGE_IMPORT_IDENTITY_CHANGED')
                    if manage_command['type'] == 'knowledge-imports-delete':
                        # A delete removes device-local display rows only; the
                        # platform keeps every registered revision.
                        owner = profile_binding(load_settings(args.config)) \
                            if login.status()['state'] == 'authenticated' else None
                        result = {'deleted': knowledge_imports.delete(owner, manage_command['ids'])}
                    else:
                        result = chat.retry_import_record(manage_command['recordId'])
                except Exception as exc:
                    error = category_for(exc)
                    if error == 'KNOWLEDGE_IMPORT_FAILED' and str(exc).startswith(('CHAT_', 'KNOWLEDGE_')):
                        error = str(exc)
                emit({'v': 1, 'type': manage_command['type'], 'id': manage_command['id'],
                      'result': result, 'error': error})
            try:
                publish_command = knowledge_publish_commands.get_nowait()
            except queue.Empty:
                publish_command = None
            if publish_command:
                error = ''
                result = None
                try:
                    if publish_command['scope'] != workspace.scope():
                        raise KnowledgePublishError('KNOWLEDGE_PUBLISH_IDENTITY_CHANGED')
                    result = chat.publish_local_revision(publish_command['kbId'], publish_command['revisionId'],
                                                         publish_command['paths'],
                                                         confirmed=publish_command['confirmed'] is True)
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; an
                    # unexpected failure never leaks paths or content.
                    error = category_for(exc) if isinstance(exc, KnowledgeImportError) else str(exc) \
                        if str(exc).startswith(('KNOWLEDGE_PUBLISH_', 'KNOWLEDGE_IMPORT_', 'CHAT_')) else 'KNOWLEDGE_PUBLISH_FAILED'
                emit({'v': 1, 'type': 'knowledge-publish', 'id': publish_command['id'],
                      'result': result, 'error': error})
            try:
                graph_command = knowledge_graph_commands.get_nowait()
            except queue.Empty:
                graph_command = None
            if graph_command:
                error = ''
                result = None
                try:
                    result = chat.knowledge_graph(graph_command['kbId'], graph_command['revisionId'],
                                                  action=graph_command['action'],
                                                  document_id=graph_command.get('documentId'),
                                                  document_ids=graph_command.get('documentIds'),
                                                  query=graph_command.get('query') or '')
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary.
                    message = str(exc)
                    error = message if message.startswith(('CHAT_', 'KNOWLEDGE_')) else 'KNOWLEDGE_GRAPH_FAILED'
                emit({'v': 1, 'type': 'knowledge-graph', 'id': graph_command['id'],
                      'result': result, 'error': error})
            try:
                wiki_command = knowledge_wiki_commands.get_nowait()
            except queue.Empty:
                wiki_command = None
            if wiki_command:
                error = ''
                result = None
                try:
                    result = chat.wiki(wiki_command['kbId'], wiki_command['revisionId'],
                                       action=wiki_command['action'],
                                       document_id=wiki_command.get('documentId'))
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary.
                    message = str(exc)
                    error = message if message.startswith(('CHAT_', 'KNOWLEDGE_', 'WIKI_')) else 'KNOWLEDGE_WIKI_FAILED'
                emit({'v': 1, 'type': 'knowledge-wiki', 'id': wiki_command['id'],
                      'result': result, 'error': error})
            try:
                skill_command = skill_commands.get_nowait()
            except queue.Empty:
                skill_command = None
            if skill_command:
                error = ''
                result = None
                try:
                    if skill_command['action'] == 'import':
                        result = chat.import_skill_package(skill_command['kind'], skill_command['paths'],
                                                           confirmed=skill_command['confirmed'] is True)
                    else:
                        result = chat.publish_skill(skill_command['resourceId'],
                                                    skill_command['expectedDraftRevision'])
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; an
                    # unexpected failure never leaks paths or content.
                    message = str(exc)
                    error = message if message.startswith(('CHAT_', 'SKILL_IMPORT_', 'SKILL_PUBLISH_')) else 'SKILL_IMPORT_FAILED'
                emit({'v': 1, 'type': 'skills', 'id': skill_command['id'],
                      'result': result, 'error': error})
            try:
                preference_command = skill_preference_commands.get_nowait()
            except queue.Empty:
                preference_command = None
            if preference_command:
                error = ''
                result = None
                try:
                    result = chat.skill_preferences(preference_command)
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; an
                    # unexpected failure never leaks paths or content.
                    message = str(exc)
                    error = message if message.startswith(('CHAT_', 'SKILL_PREFERENCE_')) else 'SKILL_PREFERENCE_FAILED'
                emit({'v': 1, 'type': 'skill-preferences', 'id': preference_command['id'],
                      'result': result, 'error': error})
            try:
                script_command = skill_script_commands.get_nowait()
            except queue.Empty:
                script_command = None
            if script_command:
                error = ''
                result = None
                try:
                    if script_command['scope'] != workspace.scope():
                        raise SkillScriptError('SKILL_SCRIPT_IDENTITY_CHANGED')
                    owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
                    if owner is None or controller is None or controller.skill_script_service is None:
                        raise SkillScriptError('SKILL_SCRIPT_UNAVAILABLE')
                    registry = controller.skill_script_service.registry
                    if script_command['action'] == 'revoke':
                        revoked = registry.revoke_identity(owner, script_command['authorizationId'])
                        # Issue 41: carry the post-revoke list alongside the
                        # flag so the renderer drops the row in one round and
                        # a successful revoke never parses as a failure.
                        result = {'revoked': bool(revoked), 'authorizations': registry.view(owner)}
                    else:
                        result = {'authorizations': registry.view(owner)}
                except SkillScriptError as exc:
                    error = str(exc)
                except Exception:
                    error = 'SKILL_SCRIPT_FAILED'
                emit({'v': 1, 'type': 'skill-scripts', 'id': script_command['id'],
                      'result': result, 'error': error})
            try:
                thread_command = thread_commands.get_nowait()
            except queue.Empty:
                thread_command = None
            if thread_command:
                error = ''
                result = None
                try:
                    # Issue 72: the sidebar's own Thread management. The chat
                    # session identity is the fence — the command must carry
                    # the scope of the currently authenticated chat session.
                    result = chat.threads_manage(thread_command)
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; a
                    # server detail never leaks paths or content.
                    message = str(exc)
                    error = message if message.startswith('CHAT_') else 'THREADS_FAILED'
                emit({'v': 1, 'type': 'threads', 'id': thread_command['id'],
                      'result': result, 'error': error})
            try:
                project_command = project_commands.get_nowait()
            except queue.Empty:
                project_command = None
            if project_command:
                error = ''
                result = None
                try:
                    # Issue 91: platform project management on the Server's own
                    # Project API, fenced by the same chat session identity. The
                    # command never binds, clears or reads local files or
                    # directory grants — deletion and archiving are Server-side
                    # organization only.
                    result = chat.projects_manage(project_command)
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; a
                    # server detail never leaks paths or content.
                    message = str(exc)
                    error = message if message.startswith('CHAT_') else 'PROJECTS_FAILED'
                emit({'v': 1, 'type': 'projects', 'id': project_command['id'],
                      'result': result, 'error': error})
            try:
                dataset_command = dataset_commands.get_nowait()
            except queue.Empty:
                dataset_command = None
            if dataset_command:
                error = ''
                result = None
                try:
                    # Issue 102: device-local dataset import/delete on this
                    # identity's own registry. The workspace scope is the
                    # fence, the owner binding scopes the rows, and the picked
                    # original files are only ever read, never moved or removed.
                    if dataset_command['scope'] != workspace.scope():
                        raise DatasetError('DATASETS_IDENTITY_CHANGED')
                    owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
                    result = datasets_manage(dataset_command, registry=datasets_registry, owner=owner)
                except DatasetError as exc:
                    # Only fixed categories cross the Desktop boundary; file
                    # content and source details never do.
                    error = str(exc)
                except Exception:
                    error = 'DATASETS_FAILED'
                emit({'v': 1, 'type': 'datasets', 'id': dataset_command['id'],
                      'result': result, 'error': error})
            try:
                model_command = model_commands.get_nowait()
            except queue.Empty:
                model_command = None
            if model_command:
                error = ''
                result = None
                try:
                    result = chat.models_manage(model_command)
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; the
                    # model family carries no provider, endpoint or key data
                    # that could leak through an unexpected failure.
                    message = str(exc)
                    error = message if message.startswith(('CHAT_', 'MODEL_')) else 'MODEL_SETTINGS_FAILED'
                emit({'v': 1, 'type': 'models', 'id': model_command['id'],
                      'result': result, 'error': error})
            try:
                schedule_command = schedule_commands.get_nowait()
            except queue.Empty:
                schedule_command = None
            if schedule_command:
                error = ''
                result = None
                try:
                    # Issue 85: one scheduled-tasks management round-trip on
                    # the pinned platform contract. The session gate and the
                    # chat-session scope fence live in the facade; only fixed
                    # SCHEDULES_* categories cross to the Desktop.
                    result = chat.schedules_manage(schedule_command)
                except SchedulesError as exc:
                    error = exc.code
                except Exception:
                    error = 'SCHEDULES_FAILED'
                emit({'v': 1, 'type': 'schedules', 'id': schedule_command['id'],
                      'result': result, 'error': error})
            try:
                template_command = template_commands.get_nowait()
            except queue.Empty:
                template_command = None
            if template_command:
                error = ''
                result = None
                try:
                    result = chat.templates_manage(template_command)
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; a
                    # server detail never leaks paths or content.
                    message = str(exc)
                    error = message if message.startswith('CHAT_') else 'TEMPLATE_FAILED'
                emit({'v': 1, 'type': 'templates', 'id': template_command['id'],
                      'result': result, 'error': error})
            try:
                connector_command = connector_commands.get_nowait()
            except queue.Empty:
                connector_command = None
            if connector_command:
                error = ''
                result = None
                try:
                    if connector_command['scope'] != workspace.scope():
                        raise ConnectorInstallError('CONNECTOR_IDENTITY_CHANGED')
                    owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
                    if owner is None or controller is None or controller.connector_service is None:
                        raise ConnectorInstallError('CONNECTOR_UNAVAILABLE')
                    service = controller.connector_service
                    action = connector_command['action']
                    if action == 'preview':
                        result = service.preview(owner, connector_command['path'])
                    elif action == 'install':
                        result = service.install(owner, connector_command['path'],
                                                 confirmed=connector_command['confirmed'] is True)
                        if connector_command['confirmed'] is True:
                            # The controlled configuration changed: swap the
                            # supervisor and republish the tool projection.
                            controller.refresh_connectors()
                    elif action == 'remove':
                        result = service.remove(owner, connector_command['slug'],
                                                confirmed=connector_command['confirmed'] is True)
                        if connector_command['confirmed'] is True:
                            controller.refresh_connectors()
                    else:
                        result = {'connectors': service.view(owner)}
                except ConnectorInstallError as exc:
                    # Only the fixed connector categories cross the Desktop
                    # boundary; paths and package bytes never do.
                    error = str(exc)
                except Exception:
                    error = 'CONNECTOR_FAILED'
                emit({'v': 1, 'type': 'connectors', 'id': connector_command['id'],
                      'result': result, 'error': error})
            try:
                browse = files_commands.get_nowait()
            except queue.Empty:
                browse = None
            if browse:
                error = ''
                result = None
                try:
                    if login.status()['state'] != 'authenticated' or browse['scope'] != workspace.scope():
                        raise FileAccessError('WORKSPACE_UNAVAILABLE')
                    result = browse_files_view(workspace, args.config.parent,
                                               browse['action'], browse['path'])
                except FileAccessError as exc:
                    error = exc.code
                except Exception:
                    error = 'FILES_FAILED'
                emit({'v': 1, 'type': 'files', 'id': browse['id'], 'result': result, 'error': error})
            # Issue 109: the remote browser's stream lifecycle. The origin and
            # the access token come from the chat session's own secure store
            # through the identity fence; the proxy thread is the only client
            # of the platform socket. A replacement close is silent here — the
            # Desktop hub announces it — while identity loss is announced by
            # the status tick below.
            try:
                stream_command = browser_stream_commands.get_nowait()
            except queue.Empty:
                stream_command = None
            if stream_command:
                error = ''
                result = None
                try:
                    if stream_command['action'] == 'close':
                        for old in list(browser_streams.values()):
                            old.close()
                        browser_streams.clear()
                        result = {}
                    else:
                        if login.status()['state'] != 'authenticated':
                            raise ValueError('REMOTE_BROWSER_UNAUTHENTICATED')
                        session = chat.browser_stream_session(stream_command['scope'])
                        for old in list(browser_streams.values()):
                            old.close()
                        browser_streams.clear()
                        stream_id = uuid.uuid4().hex
                        proxy = BrowserStreamProxy(
                            session['origin'], session['token'], stream_command['threadId'],
                            lambda event, _id=stream_id: emit(
                                {'v': 1, 'type': 'browser-stream-event', 'streamId': _id, 'event': event}))
                        proxy.start()
                        browser_streams[stream_id] = proxy
                        result = {'streamId': stream_id}
                except Exception as exc:
                    message = str(exc)
                    error = message if message.startswith(('CHAT_', 'REMOTE_BROWSER_')) else 'REMOTE_BROWSER_FAILED'
                emit({'v': 1, 'type': 'browser-stream', 'id': stream_command['id'], 'result': result, 'error': error})
            try:
                input_command = browser_input_commands.get_nowait()
            except queue.Empty:
                input_command = None
            if input_command:
                error = ''
                try:
                    proxy = browser_streams.get(input_command['streamId'])
                    if proxy is None or not proxy.send_input(input_command['event']):
                        raise ValueError('REMOTE_BROWSER_STREAM_NOT_OPEN')
                except ValueError as exc:
                    error = str(exc)
                except Exception:
                    error = 'REMOTE_BROWSER_INPUT_FAILED'
                emit({'v': 1, 'type': 'browser-input', 'id': input_command['id'], 'error': error})
            # Issue 108: route each Desktop reply to the browser-control task
            # waiting on it. An unknown or already-answered id is dropped by
            # the service itself; the queue never routes to a stale future.
            try:
                control_result = browser_control_results.get_nowait()
            except queue.Empty:
                control_result = None
            if control_result and controller is not None:
                control_service = getattr(controller.client, 'browser_control', None)
                if control_service is not None:
                    control_service.resolve(
                        control_result['id'], control_result.get('result'), control_result['error'])
            try:
                selection = workspace_commands.get_nowait()
            except queue.Empty:
                selection = None
            if selection:
                try:
                    if login.status()['state'] != 'authenticated' or selection['scope'] != workspace.scope():
                        raise ValueError('WORKSPACE_UNAVAILABLE')
                    stop_controller()
                    workspace.select(selection['path'], confirmed=True)
                    controller = connect()
                    emit({'v': 1, 'type': 'workspace', 'id': selection['id'], 'error': ''})
                except Exception:
                    emit({'v': 1, 'type': 'workspace', 'id': selection['id'], 'error': 'WORKSPACE_SELECTION_FAILED'})
            try:
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    command = None
                if command:
                    browser_url = login.begin(command["serverUrl"], command["deviceName"])
                elif login.status()["state"] == "awaiting-confirmation":
                    if login.poll():
                        controller = connect()
            except SecretStoreError:
                login.fail("SECURE_STORAGE_FAILED")
            except Exception as exc:
                allowed = {"LOGIN_EXPIRED", "LOGIN_ALREADY_USED", "LOGIN_BINDING_INVALID", "LOGIN_OWNER_MISMATCH",
                           "LOGIN_ORIGIN_INVALID", "LOGIN_IN_PROGRESS", "DEVICE_ALREADY_PAIRED"}
                login.fail(str(exc) if str(exc) in allowed else "LOGIN_FAILED")
            if controller is not None and login.status()["state"] != "authenticated":
                stop_controller()
            # Issue 109: identity loss ends every live browser stream with
            # one honest announcement; nothing else closes a stream loudly.
            if browser_streams and login.status()["state"] != "authenticated":
                for old_id, old in list(browser_streams.items()):
                    old.close()
                    del browser_streams[old_id]
                    emit({'v': 1, 'type': 'browser-stream-event', 'streamId': old_id,
                          'event': {'kind': 'state', 'state': 'closed', 'code': 1000, 'category': 'IDENTITY_CHANGED'}})
            current_receipt_owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
            try:
                knowledge_rows = knowledge_imports.view(current_receipt_owner) if current_receipt_owner else []
            except KnowledgeImportError:
                knowledge_rows = []
            # Issue 97: each registered row carries its revision's index view
            # (derived state, honest counts, observed drift) so the doc
            # library can annotate 未建/重建中/已过期 without guessing. The
            # join runs over the slice the snapshot actually sends, and a
            # store failure reads as absent per row instead of silently
            # dropping the facts from the tail.
            for row in knowledge_rows[:20]:
                if row.get('status') == 'registered' and row.get('revisionId'):
                    try:
                        row['index'] = knowledge_index.revision_view(current_receipt_owner,
                                                                     row['revisionId'], row['manifestHash'])
                    except KnowledgeIndexError:
                        row['index'] = None
                else:
                    row['index'] = None
            try:
                knowledge_publication_rows = knowledge_publications.view(current_receipt_owner) if current_receipt_owner else []
            except KnowledgePublishError:
                knowledge_publication_rows = []
            try:
                skill_rows = skill_imports.view(current_receipt_owner) if current_receipt_owner else []
            except SkillImportError:
                skill_rows = []
            try:
                dataset_rows = datasets_registry.view(current_receipt_owner) if current_receipt_owner else []
            except DatasetError:
                dataset_rows = []
            script_service = getattr(controller, 'skill_script_service', None) if controller is not None else None
            try:
                script_rows = script_service.registry.view(current_receipt_owner) if current_receipt_owner and script_service is not None else []
            except SkillScriptError:
                script_rows = []
            script_registry_error = script_service.registry.error if script_service is not None else ''
            connector_service = getattr(controller, 'connector_service', None) if controller is not None else None
            try:
                connector_rows = connector_service.view(current_receipt_owner) if current_receipt_owner and connector_service is not None else []
            except ConnectorInstallError:
                connector_rows = []
            # Issue 92: this device's own project folder bindings ride the
            # same snapshot; a different device's rows are keyed away by the
            # profile binding, so the view is empty there by construction.
            try:
                binding_rows = project_bindings.view(current_receipt_owner) if current_receipt_owner else []
            except ProjectBindingError:
                binding_rows = []
            # The worker can complete a write while this thread reads SQLite
            # and controller status. Keep both activity observations so a stale
            # unknown count cannot look like an idle queue and falsely block
            # installation. A task appearing during the read still counts too.
            active_tasks_before = controller.client.active_task_count() if controller is not None else 0
            # Issue 77: the status loop drives the bounded background-session
            # observation; each event becomes one wire notification for the
            # Desktop's own notification center. The tick bounds Server
            # polling only — the platform's own concurrency is never narrowed.
            try:
                notify_events = chat.background_tick()
            except Exception:
                notify_events = []
            # Issue 80: the status loop drives the post-outage reconcile too,
            # so a session left with an unknown outcome recovers even when no
            # chat panel is polling.
            try:
                chat.reconcile()
            except Exception:
                pass
            # Issue 85: the catch-up sweep gate rides the same loop — one pass
            # per offline→online transition plus a bounded periodic re-scan.
            # The pass itself runs on its own thread so a slow Server answer
            # never stalls the status cadence.
            try:
                if chat.scheduled_tasks.catch_up_tick(login.status()['state'] == 'authenticated'):
                    threading.Thread(target=chat.scheduled_tasks.catch_up_after_offline,
                                     daemon=True).start()
            except Exception:
                pass
            for event in notify_events:
                emit({'v': 1, 'type': 'notify', 'event': event})
            receipt_view = receipts.snapshot(current_receipt_owner)
            try:
                unknown_write_effects = receipts.unknown_write_effects(None)
            except ReceiptStorageError:
                unknown_write_effects = 1  # An unreadable ledger cannot prove effects are known.
            tasks = [{"taskId": row['task_id'][:256], "runId": row['run_id'][:256],
                      "state": (row['status'] if row['delivery_state'] != 'cleaned' else 'cleaned')[:256],
                      "capability": row['capability'][:256]} for row in receipt_view['rows']]
            connection = "offline" if load_settings(args.config).device_id else "not-configured"
            if controller is not None:
                connection = controller.status().connection
            status = {"v": 1, "connection": connection, "tasks": tasks, "login": login.status(),
                      "serverOrigin": login.server_origin(),
                      "compatibility": compatibility.snapshot(),
                      "unknownWriteEffects": unknown_write_effects,
                      "installDrain": install_draining,
                      "activeTasks": max(active_tasks_before,
                          controller.client.active_task_count() if controller is not None else 0),
                      "backgroundRuns": chat.background_runs()[:20],
                      "receiptStorageError": receipts.error,
                      "receiptScope": content_hash(current_receipt_owner) if current_receipt_owner else '',
                      "knowledgeImports": knowledge_rows[:20],
                      "knowledgeImportStorageError": knowledge_imports.error,
                      # Issue 97: the rebuild job's own view and the index
                      # store's storage error ride beside the import facts.
                      "knowledgeIndexRebuild": index_rebuilds.status(),
                      "knowledgeIndexStorageError": knowledge_index.error,
                      "knowledgeFolderImport": folder_imports.status(),
                      "datasets": dataset_rows[:20],
                      "datasetsStorageError": datasets_registry.error,
                      "knowledgePublications": knowledge_publication_rows[:20],
                      "knowledgePublishStorageError": knowledge_publications.error,
                      "skillImports": skill_rows[:20],
                      "skillImportStorageError": skill_imports.error,
                      "skillScriptAuthorizations": script_rows[:20],
                      "skillScriptStorageError": script_registry_error,
                      "connectors": connector_rows[:20],
                      "connectorStorageError": connector_service.registry.error if connector_service is not None else '',
                      "projectBindings": binding_rows[:20],
                      "projectBindingStorageError": project_bindings.error,
                      "selectionScope": workspace.scope(),
                      "directoryGrants": [dict(id=row['id'], directory=row['directory'], operation=row['operation'],
                          userId=row['binding'][1], deviceId=row['binding'][2], createdAt=row['created_at'])
                          for row in workspace.grants()] if login.status()['state'] == 'authenticated' else [],
                      "workspace": workspace.status() if login.status()["state"] == "authenticated" else {"state": "unavailable", "logicalRoot": ""}}
            if browser_url:
                status["browserUrl"] = browser_url
            emit(status)
            stop.wait(0.5)
        return 0
    except Exception:
        # Do not forward exception text or config/credential values to UI.
        print(json.dumps({"v": 1, "connection": "error", "tasks": []}), flush=True)
        return 1
    finally:
        if controller is not None:
            stop_controller()
        _ = job  # Keep ownership until process exit.


if __name__ == "__main__":
    raise SystemExit(main())
