"""Owned status/login channel. Executable tasks arrive only by signed WSS."""
from __future__ import annotations

import argparse
import base64
import json
import platform
import queue
import sys
import threading
from pathlib import Path

from .audit import LocalAuditLog
from .browser_login import BrowserLogin
from .compatibility import CompatibilityGate
from .local_results import LocalResultRegistry
from .platform_chat import DesktopChat, empty_state
from .process_job import own_process_tree
from .settings import load_settings
from .file_service import WorkspaceSelection, WorkspaceFileStore
from .files import FileAccessError, RootConfig
from .knowledge_import import KnowledgeImportError, KnowledgeImportRegistry, category_for
from .knowledge_publish import KnowledgePublicationRegistry, KnowledgePublishError
from .skill_import import SkillImportError, SkillImportRegistry
from .skill_script import SkillScriptError
from .secrets import SecretStoreError, create_default_secret_store
from .task_guard import TaskGuard
from .receipt_ledger import ReceiptLedger, ReceiptStorageError, profile_binding
from .receipts import content_hash
from .tray import load_controller


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument('--update-health', action='store_true')
    parser.add_argument('--desktop-version', default='0.1.0')
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
    knowledge_graph_commands: queue.Queue = queue.Queue(maxsize=1)
    knowledge_wiki_commands: queue.Queue = queue.Queue(maxsize=1)
    skill_commands: queue.Queue = queue.Queue(maxsize=1)
    skill_preference_commands: queue.Queue = queue.Queue(maxsize=1)
    skill_script_commands: queue.Queue = queue.Queue(maxsize=1)
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
                        and command['action'] in {'view', 'generate', 'locate', 'search', 'ask'}
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
                if (isinstance(command, dict) and set(command) == {'type', 'id', 'path', 'confirmed', 'scope'}
                        and command['type'] == 'workspace' and isinstance(command['id'], str)
                        and len(command['id']) <= 64 and isinstance(command['path'], str)
                        and len(command['path']) <= 32768 and command['confirmed'] is True
                        and isinstance(command['scope'], str)):
                    workspace_commands.put_nowait(command)
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

        def decide_consent(task_id, digest, approved, *, directory=False):
            if controller is None or login.status()['state'] != 'authenticated':
                raise ValueError('CONSENT_UNAVAILABLE')
            controller.client.resolve_local_consent(task_id, approved=approved, expected_hash=digest, directory=directory)

        args.config.parent.mkdir(parents=True, exist_ok=True)
        receipts = ReceiptLedger(args.config.with_name('receipts.db'))
        # Registered local results are display-only metadata for this identity;
        # they reach a Thread artifact only through the explicit chat upload
        # command, never through observation or task execution.
        local_results = LocalResultRegistry(args.config.with_name('local-results.db'))
        # Issue 112: explicit local imports keep the same discipline — the
        # registry stores device-local display facts, never file content.
        knowledge_imports = KnowledgeImportRegistry(args.config.with_name('knowledge-imports.db'))
        # Issue 115: explicit publications record the outcome of a confirmed
        # server copy attempt; a preview alone never writes a row.
        knowledge_publications = KnowledgePublicationRegistry(args.config.with_name('knowledge-publications.db'))
        # Issue 120: explicit skill package imports keep the same registry
        # discipline — device-local display facts, never package content.
        skill_imports = SkillImportRegistry(args.config.with_name('skill-imports.db'))
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
            knowledge_publications=knowledge_publications, skill_imports=skill_imports)

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
                audit=LocalAuditLog(db_path=args.config.with_name("audit.db")))
            if not controller.settings.session_token:
                raise ValueError("PAIRING_REQUIRED")
            controller.client.task_guard = TaskGuard(args.config.with_name("tasks.db"))
            controller.client.receipt_ledger = receipts
            controller.client.local_results = local_results
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
                        result = {'revoked': bool(revoked)}
                    else:
                        result = {'authorizations': registry.view(owner)}
                except SkillScriptError as exc:
                    error = str(exc)
                except Exception:
                    error = 'SKILL_SCRIPT_FAILED'
                emit({'v': 1, 'type': 'skill-scripts', 'id': script_command['id'],
                      'result': result, 'error': error})
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
            current_receipt_owner = profile_binding(load_settings(args.config)) if login.status()['state'] == 'authenticated' else None
            try:
                knowledge_rows = knowledge_imports.view(current_receipt_owner) if current_receipt_owner else []
            except KnowledgeImportError:
                knowledge_rows = []
            try:
                knowledge_publication_rows = knowledge_publications.view(current_receipt_owner) if current_receipt_owner else []
            except KnowledgePublishError:
                knowledge_publication_rows = []
            try:
                skill_rows = skill_imports.view(current_receipt_owner) if current_receipt_owner else []
            except SkillImportError:
                skill_rows = []
            script_service = getattr(controller, 'skill_script_service', None) if controller is not None else None
            try:
                script_rows = script_service.registry.view(current_receipt_owner) if current_receipt_owner and script_service is not None else []
            except SkillScriptError:
                script_rows = []
            script_registry_error = script_service.registry.error if script_service is not None else ''
            # The worker can complete a write while this thread reads SQLite
            # and controller status. Keep both activity observations so a stale
            # unknown count cannot look like an idle queue and falsely block
            # installation. A task appearing during the read still counts too.
            active_tasks_before = controller.client.active_task_count() if controller is not None else 0
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
                      "receiptStorageError": receipts.error,
                      "receiptScope": content_hash(current_receipt_owner) if current_receipt_owner else '',
                      "knowledgeImports": knowledge_rows[:20],
                      "knowledgeImportStorageError": knowledge_imports.error,
                      "knowledgePublications": knowledge_publication_rows[:20],
                      "knowledgePublishStorageError": knowledge_publications.error,
                      "skillImports": skill_rows[:20],
                      "skillImportStorageError": skill_imports.error,
                      "skillScriptAuthorizations": script_rows[:20],
                      "skillScriptStorageError": script_registry_error,
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
