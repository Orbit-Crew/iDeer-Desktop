"""Authenticated Desktop chat. All orchestration and durable history belong to Server."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import socket
import string
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
from .document_parse import MAX_PARSE_FILE_BYTES, parse_document, parse_summary
from .local_results import LocalResultError
from .policy import PolicyDecision
from .receipt_ledger import profile_binding
from .secrets import SecretStore, SecretStoreError
from .session_tier import DEFAULT_SESSION_TIER, SessionTier, SessionTierRegistry
from .settings import load_settings

MAX_RESPONSE = 2 * 1024 * 1024
# The workspace write boundary already caps a single result at MAX_TEXT_BYTES;
# the explicit upload path enforces the same bound before staging anything.
MAX_RESULT_BYTES = 65536
# Issue 37: an SSE run stream is a long-lived connection — one model phase can
# stay silent far past any request round-trip — so stream reads carry their own
# generous socket timeout instead of the 15s request timeout, and a stream that
# still drops resumes from the last delivered event id a bounded number of
# times before the disconnect becomes visible.
STREAM_READ_TIMEOUT = 90.0
STREAM_RECONNECTS = 3
STREAM_RECONNECT_DELAY = 1.0
# Issue 76: the structured sub-agent ledger is bounded next to the 50-entry
# raw event ledger, and one entry's copied result/error text is bounded too —
# the conversation's own tool messages keep the platform's full report.
MAX_SUBAGENT_ENTRIES = 50
MAX_SUBAGENT_RESULT = 8000
MAX_SUBAGENT_ERROR = 2000
MAX_SUBAGENT_DESCRIPTION = 2000
MAX_SUBAGENT_NAMES = 200
# Issue 77: the Desktop's own observation cadence for backgrounded Runs. This
# bounds only how often the Server is asked about runs the user left running —
# never how many sessions or tasks the platform may run in parallel. The
# ledger is generous (100) because an overflowing entry is the oldest one
# silently going unobserved; the per-tick poll limit keeps the Server load
# bounded no matter how full the ledger is.
BACKGROUND_TICK_SECONDS = 2.0
BACKGROUND_POLL_LIMIT = 8
BACKGROUND_LEDGER_LIMIT = 100
# Issue 78: one branch names one completed assistant turn; the turn's
# assistant message ids stay a bounded list on the wire.
MAX_BRANCH_TURN_MESSAGES = 64
# Issue 93: 对话附件去向选择器的边界。每条附件的去向由用户显式选择：默认
# "发送解析文本"只在设备上解析（原件不出电脑），"上传原件"走 Thread 工件的
# 显式接缝（10 MiB：比任务结果的 64 KiB 宽，仍远小于解析引擎 50 MiB 的读取
# 上限），"仅本机查看"回答一段有界的只读文本。消息本身的 16000 字符预算是
# 平台的约束：附件文本块按剩余预算截断并如实标注。
MAX_MESSAGE_ATTACHMENTS = 8
MAX_ATTACHMENT_PATH = 4096
MAX_ATTACHMENT_NAME = 256
MAX_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENT_VIEW_CHARS = 100_000
# Per-attachment message-budget reservations, checked BEFORE any file is
# read, parsed or staged: an upload block is at most the name plus artifact
# id and hash fragments (~512), a parsed block is at most its markers plus
# the no-room fallback line around a full-length name (~600, the engine's
# parser identity and the truncation marker included). With these reserved
# the composed message fits by construction; the trailing guard only pins
# that invariant.
ATTACHMENT_UPLOAD_RESERVE = 512
ATTACHMENT_PARSED_RESERVE = 600
# Slack inside one parsed block: the '\n' pair and the truncation suffix.
ATTACHMENT_BLOCK_SLACK = 24
# Issue 80: once the platform answers again, a session left with an unknown
# outcome reconciles itself at most this often. The cooldown bounds the
# reconnect attempts the Desktop's own poll can spend — the Server load and
# the replay contract stay the platform's own.
RECONNECT_COOLDOWN_SECONDS = 5.0
# The cheap reachability probe the reconcile carries when nothing else has
# talked to the Server since the last failure; short so a status-loop tick
# never stalls behind a dead connection.
RECONNECT_PROBE_TIMEOUT_SECONDS = 3.0
# The identity charset every notify fact must survive on the wire; facts
# outside it are skipped rather than ever emitted malformed.
_WIRE_ID_CHARS = frozenset(string.ascii_letters + string.digits + '_-')


def _is_wire_id(value) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 128 and all(c in _WIRE_ID_CHARS for c in value)


class ChatError(Exception):
    """Only fixed error categories cross the Desktop boundary."""

    def __init__(self, code: str, detail: str = "") -> None:
        # str(error) stays the fixed category; the optional detail keeps the
        # server's machine-readable refusal (e.g. LOCAL_PUBLISH_* codes)
        # without ever entering the displayed category.
        super().__init__(code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class ChatSession:
    scope: str
    origin: str
    user_id: str
    token: str = field(repr=False)


def _bounded_text(value, limit=200):
    return value if isinstance(value, str) and 0 < len(value) <= limit else ""


def requirements_fingerprint_of(declaration) -> str:
    """The scope identity a script approval binds (#122); an unreadable
    declaration reads as empty rather than blocking the display."""
    try:
        from .skill_script import parse_execution_environment, requirements_fingerprint
        parsed = parse_execution_environment(declaration)
        return requirements_fingerprint(parsed) if parsed is not None else ""
    except Exception:  # noqa: BLE001 - display fact only, never a gate
        return ""


def _graph_view_payload(view):
    """Project the platform graph view into the Desktop display shape.

    Every row is validated and bounded; anything the platform did not state
    is dropped rather than invented, so the panel can only show real
    entity/relation/source facts bound to the frozen revision.
    """
    if not isinstance(view, dict) or not isinstance(view.get("manifest_hash"), str) \
            or len(view["manifest_hash"]) != 64 or type(view.get("revision_no")) is not int:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    status = view.get("status")
    if status not in {"not_generated", "completed", "partial", "failed"}:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    sources = []
    for row in (view.get("sources") or [])[:200]:
        if not isinstance(row, dict):
            continue
        document_id = _bounded_text(row.get("document_id"), 64)
        if not document_id:
            continue
        sources.append({"documentId": document_id,
                        "filename": _bounded_text(row.get("filename"), 255),
                        "contentHash": _bounded_text(row.get("content_hash"), 64),
                        "status": _bounded_text(row.get("status"), 32),
                        "errorCode": _bounded_text(row.get("error_code"), 64)})
    entities = []
    for row in (view.get("entities") or [])[:200]:
        if not isinstance(row, dict):
            continue
        name = _bounded_text(row.get("name"))
        if not name:
            continue
        entities.append({"name": name, "type": _bounded_text(row.get("type"), 64),
                         "documentId": _bounded_text(row.get("document_id"), 64),
                         "filename": _bounded_text(row.get("filename"), 255)})
    relations = []
    for row in (view.get("relations") or [])[:200]:
        if not isinstance(row, dict):
            continue
        source = _bounded_text(row.get("source"))
        target = _bounded_text(row.get("target"))
        relation = _bounded_text(row.get("relation"))
        if not source or not target or not relation:
            continue
        relations.append({"source": source, "target": target, "relation": relation,
                          "documentId": _bounded_text(row.get("document_id"), 64),
                          "filename": _bounded_text(row.get("filename"), 255)})
    return {"kbId": "", "revisionId": _bounded_text(view.get("revision_id"), 64),
            "revisionNo": view["revision_no"], "manifestHash": view["manifest_hash"],
            "status": status,
            "generated": view["generated"] if type(view.get("generated")) is int else 0,
            "failed": view["failed"] if type(view.get("failed")) is int else 0,
            "entities": entities, "relations": relations, "sources": sources}


def _scope_rows(rows):
    """Project the platform's per-document scope rows for display (#117)."""
    projected = []
    for row in (rows or [])[:200]:
        if not isinstance(row, dict):
            continue
        document_id = _bounded_text(row.get("document_id"), 64)
        if not document_id:
            continue
        projected.append({"documentId": document_id,
                          "filename": _bounded_text(row.get("filename"), 255),
                          "contentHash": _bounded_text(row.get("content_hash"), 64),
                          "status": _bounded_text(row.get("status"), 32),
                          "errorCode": _bounded_text(row.get("error_code"), 64)})
    return projected


def _graph_scope_payload(view, *, with_answer):
    """Project a scoped query or ask answer into the Desktop display shape (#117).

    Like the graph view, every row is validated and bounded and anything the
    platform did not state is dropped rather than invented. A refused ask is
    projected as exactly that: no answer text, with the per-document fixed
    categories the platform returned.
    """
    if not isinstance(view, dict) or not isinstance(view.get("manifest_hash"), str) \
            or len(view["manifest_hash"]) != 64 or type(view.get("revision_no")) is not int:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    status = view.get("status")
    if status not in {"not_generated", "completed", "partial", "failed"}:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    payload = {"kbId": "", "revisionId": _bounded_text(view.get("revision_id"), 64),
               "revisionNo": view["revision_no"], "manifestHash": view["manifest_hash"],
               "status": status, "scope": _scope_rows(view.get("scope"))}
    if with_answer:
        answer = view.get("answer")
        payload["question"] = _bounded_text(view.get("question"), 4000)
        payload["answerAvailable"] = view.get("answer_available") is True and isinstance(answer, str) and bool(answer.strip())
        payload["answer"] = _bounded_text(answer, 8000) if payload["answerAvailable"] else ""
        payload["errorCode"] = _bounded_text(view.get("error_code"), 64)
        return payload
    payload["query"] = _bounded_text(view.get("query"), 512)
    entities = []
    for row in (view.get("entities") or [])[:200]:
        if not isinstance(row, dict):
            continue
        name = _bounded_text(row.get("name"))
        if not name:
            continue
        entities.append({"name": name, "type": _bounded_text(row.get("type"), 64),
                         "documentId": _bounded_text(row.get("document_id"), 64),
                         "filename": _bounded_text(row.get("filename"), 255),
                         "contentHash": _bounded_text(row.get("content_hash"), 64)})
    relations = []
    for row in (view.get("relations") or [])[:200]:
        if not isinstance(row, dict):
            continue
        source = _bounded_text(row.get("source"))
        target = _bounded_text(row.get("target"))
        relation = _bounded_text(row.get("relation"))
        if not source or not target or not relation:
            continue
        relations.append({"source": source, "target": target, "relation": relation,
                          "documentId": _bounded_text(row.get("document_id"), 64),
                          "filename": _bounded_text(row.get("filename"), 255),
                          "contentHash": _bounded_text(row.get("content_hash"), 64)})
    payload["entities"] = entities
    payload["relations"] = relations
    return payload


def _scoped_document_ids(document_ids):
    """Validate the selected frozen-document scope before anything is sent."""
    if not isinstance(document_ids, list) or not 1 <= len(document_ids) <= 50 \
            or any(not isinstance(value, str) or not value or len(value) > 64 or any(
                c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in value)
                for value in document_ids):
        raise ChatError('CHAT_COMMAND_INVALID')
    return list(dict.fromkeys(document_ids))


_WIKI_PAGE_STATUSES = {"completed", "skipped", "failed", "not_generated"}


def _wiki_document_id(document_id):
    """Validate the requested page's frozen document id before anything is sent."""
    if not isinstance(document_id, str) or not document_id or len(document_id) > 64 \
            or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in document_id):
        raise ChatError('CHAT_COMMAND_INVALID')
    return document_id


def _wiki_view_payload(view):
    """Project the platform wiki page list into the Desktop display shape (#118).

    Every row is validated and bounded; anything the platform did not state
    is dropped rather than invented, and a page body never travels with the
    list — bodies stay behind the per-page read.
    """
    if not isinstance(view, dict) or not isinstance(view.get("manifest_hash"), str) \
            or len(view["manifest_hash"]) != 64 or type(view.get("revision_no")) is not int:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    status = view.get("status")
    if status not in {"not_generated", "completed", "partial", "failed"}:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    pages = []
    for row in (view.get("pages") or [])[:200]:
        if not isinstance(row, dict):
            continue
        document_id = _bounded_text(row.get("document_id"), 64)
        if not document_id:
            continue
        page_status = _bounded_text(row.get("status"), 32)
        if page_status not in _WIKI_PAGE_STATUSES:
            raise ChatError("CHAT_PROTOCOL_ERROR")
        pages.append({"documentId": document_id,
                      "filename": _bounded_text(row.get("filename"), 255),
                      "title": _bounded_text(row.get("title"), 200),
                      "contentHash": _bounded_text(row.get("content_hash"), 64),
                      "status": page_status,
                      "errorCode": _bounded_text(row.get("error_code"), 64)})
    return {"kbId": "", "revisionId": _bounded_text(view.get("revision_id"), 64),
            "revisionNo": view["revision_no"], "manifestHash": view["manifest_hash"],
            "status": status,
            "generated": view["generated"] if type(view.get("generated")) is int else 0,
            "failed": view["failed"] if type(view.get("failed")) is int else 0,
            "skipped": view["skipped"] if type(view.get("skipped")) is int else 0,
            "pages": pages}


def _wiki_page_payload(page):
    """Project one wiki page read into the Desktop display shape (#118).

    A body only ever travels with a completed page; a skipped or failed page
    projects as exactly that — its fixed category, never text.
    """
    if not isinstance(page, dict) or not isinstance(page.get("manifest_hash"), str) \
            or len(page["manifest_hash"]) != 64 or type(page.get("revision_no")) is not int:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    status = page.get("status")
    if status not in _WIKI_PAGE_STATUSES:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    document_id = _bounded_text(page.get("document_id"), 64)
    if not document_id:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    body = page.get("body")
    has_body = status == "completed" and isinstance(body, str) and bool(body.strip())
    return {"kbId": "", "revisionId": _bounded_text(page.get("revision_id"), 64),
            "revisionNo": page["revision_no"], "manifestHash": page["manifest_hash"],
            "documentId": document_id,
            "filename": _bounded_text(page.get("filename"), 255),
            "title": _bounded_text(page.get("title"), 200),
            "contentHash": _bounded_text(page.get("content_hash"), 64),
            "status": status,
            "errorCode": _bounded_text(page.get("error_code"), 64),
            "body": _bounded_text(body, 20000) if has_body else ""}


def _wiki_link_rows(rows):
    """Project resolved link/backlink rows; every row names its page status."""
    projected = []
    for row in (rows or [])[:100]:
        if not isinstance(row, dict):
            continue
        document_id = _bounded_text(row.get("document_id"), 64)
        status = _bounded_text(row.get("status"), 32)
        if not document_id or status not in _WIKI_PAGE_STATUSES:
            raise ChatError("CHAT_PROTOCOL_ERROR")
        projected.append({"documentId": document_id,
                          "title": _bounded_text(row.get("title"), 200),
                          "status": status})
    return projected


def _wiki_associations_payload(associations):
    """Project the association graph with its frozen document sources (#119).

    Entities and relations are exactly the Server's stored #116 rows with
    their document binding and digest; un-generated or failed documents
    appear as honest coverage rows and contribute nothing else.
    """
    if not isinstance(associations, dict):
        raise ChatError("CHAT_PROTOCOL_ERROR")
    status = associations.get("status")
    if status not in {"not_generated", "completed", "partial", "failed"}:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    sources = []
    for row in (associations.get("sources") or [])[:200]:
        if not isinstance(row, dict):
            continue
        document_id = _bounded_text(row.get("document_id"), 64)
        if not document_id:
            continue
        sources.append({"documentId": document_id,
                        "filename": _bounded_text(row.get("filename"), 255),
                        "contentHash": _bounded_text(row.get("content_hash"), 64),
                        "status": _bounded_text(row.get("status"), 32),
                        "errorCode": _bounded_text(row.get("error_code"), 64)})
    entities = []
    for row in (associations.get("entities") or [])[:200]:
        if not isinstance(row, dict):
            continue
        name = _bounded_text(row.get("name"))
        if not name:
            continue
        entities.append({"name": name, "type": _bounded_text(row.get("type"), 64),
                         "documentId": _bounded_text(row.get("document_id"), 64),
                         "filename": _bounded_text(row.get("filename"), 255),
                         "contentHash": _bounded_text(row.get("content_hash"), 64)})
    relations = []
    for row in (associations.get("relations") or [])[:200]:
        if not isinstance(row, dict):
            continue
        source = _bounded_text(row.get("source"))
        target = _bounded_text(row.get("target"))
        relation = _bounded_text(row.get("relation"))
        if not source or not target or not relation:
            continue
        relations.append({"source": source, "target": target, "relation": relation,
                          "documentId": _bounded_text(row.get("document_id"), 64),
                          "filename": _bounded_text(row.get("filename"), 255),
                          "contentHash": _bounded_text(row.get("content_hash"), 64)})
    return {"status": status,
            "generated": associations["generated"] if type(associations.get("generated")) is int else 0,
            "failed": associations["failed"] if type(associations.get("failed")) is int else 0,
            "sources": sources, "entities": entities, "relations": relations}


def _wiki_navigation_payload(index):
    """Project the wiki index with links, backlinks, and associations (#119).

    Every page row keeps its honest status; links and backlinks resolve only
    inside the Server's revision and a target that names nothing there stays
    an explicit missing entry — nothing is fabricated into an accessible page.
    """
    if not isinstance(index, dict) or not isinstance(index.get("manifest_hash"), str) \
            or len(index["manifest_hash"]) != 64 or type(index.get("revision_no")) is not int:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    status = index.get("status")
    if status not in {"not_generated", "completed", "partial", "failed"}:
        raise ChatError("CHAT_PROTOCOL_ERROR")
    pages = []
    for row in (index.get("pages") or [])[:200]:
        if not isinstance(row, dict):
            continue
        document_id = _bounded_text(row.get("document_id"), 64)
        if not document_id:
            continue
        page_status = _bounded_text(row.get("status"), 32)
        if page_status not in _WIKI_PAGE_STATUSES:
            raise ChatError("CHAT_PROTOCOL_ERROR")
        missing = []
        for target in (row.get("missing_links") or [])[:100]:
            text = _bounded_text(target, 255)
            if text:
                missing.append(text)
        pages.append({"documentId": document_id,
                      "filename": _bounded_text(row.get("filename"), 255),
                      "title": _bounded_text(row.get("title"), 200),
                      "contentHash": _bounded_text(row.get("content_hash"), 64),
                      "status": page_status,
                      "errorCode": _bounded_text(row.get("error_code"), 64),
                      "links": _wiki_link_rows(row.get("links")),
                      "missingLinks": missing,
                      "backlinks": _wiki_link_rows(row.get("backlinks"))})
    return {"kbId": "", "revisionId": _bounded_text(index.get("revision_id"), 64),
            "revisionNo": index["revision_no"], "manifestHash": index["manifest_hash"],
            "status": status,
            "generated": index["generated"] if type(index.get("generated")) is int else 0,
            "failed": index["failed"] if type(index.get("failed")) is int else 0,
            "skipped": index["skipped"] if type(index.get("skipped")) is int else 0,
            "pages": pages,
            "associations": _wiki_associations_payload(index.get("associations"))}


def empty_state(scope=""):
    return dict(scope=scope, resources=[], threads=[], thread=None, messages=[], run=None,
                events=[], stream='idle', error='', lastEventId='', stop=None,
                localTasks=[], taskError='', artifacts=[],
                # Issue 73: the chat-side model display facts. `model` is the
                # resolved choice for the next submission plus its honest
                # availability; `modelOptions` mirrors the platform's
                # authorized list (already permission-filtered by the Server).
                model=dict(name='', source='platform-default', available=True,
                           reason='', notice='', switchedFrom=''),
                modelOptions=[],
                subagents=[],
                localTier=DEFAULT_SESSION_TIER.value)


def inherited_binding(source_binding):
    """Issue 78: the one place a branch's project folder binding is decided.

    A source session with a binding hands a copy to the branch; a source
    without one stays unbound (无绑定为空). The binding producer and the run
    context that consumes it arrive with the project folder binding ticket
    (二期 #92) — until then nothing registers an entry, so every branch
    resolves to no binding, and that ticket cannot grow a second inheritance
    path because the branch action consults only this function.
    """
    if not isinstance(source_binding, dict) or not source_binding:
        return None
    return dict(source_binding)


class DesktopChat:
    def __init__(self, config: Path, secure: SecretStore, login_status, *, local_consents=lambda: (), decide_consent=None,
                 local_receipts=lambda thread_id, run_ids: [], stop_local=lambda run_id: None, local_results=None,
                 compatibility_gate=None, knowledge_imports=None, knowledge_files=None, knowledge_publications=None,
                 skill_imports=None, session_tiers: SessionTierRegistry | None = None):
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
        self.knowledge_publications = knowledge_publications
        self.knowledge_files = knowledge_files
        # Issue 120: explicit skill package imports keep the same discipline —
        # the registry stores device-local display facts, never package content.
        self.skill_imports = skill_imports
        # Issue 74: the device's session-tier registry; every loaded session
        # starts at the lowest tier and a tier choice never outlives the
        # thread load that made it.
        self.session_tiers = session_tiers
        self._tasks_checked = 0.0
        self._tasks_loading = None
        # Issue 73: per-session temporary model choices, the cached authorized
        # model list, and the cached account default. All three are display/
        # resolution facts bound to the authenticated identity — nothing here
        # holds a provider, endpoint or key.
        self._session_models = {}
        self._models_cache = None
        self._account_default_cache = None
        # Issue 78: per-thread project folder bindings, in memory only. The
        # branch action is the only place a binding crosses sessions, through
        # `inherited_binding`; the producer arrives with 二期 #92.
        self._thread_bindings = {}
        # Issue 76: task tool_call id → sub-agent type, derived only from the
        # parent AI messages the platform itself published; a display fact for
        # the ledger, never an orchestration input.
        self._subagent_names = {}
        # Issue 77: runs the user left behind by switching sessions. The Run
        # itself keeps running on the Server (on_disconnect='continue'); this
        # ledger only bounds what the Desktop observes and notifies about —
        # never what the platform may run in parallel.
        self._background: list = []
        self._notified_consents: dict = {}
        self._background_checked = 0.0
        self._background_loading = None
        # Issue 80: the last observed platform reachability, recorded at the
        # one transport seam every Server contact passes through. None means
        # nothing has been observed yet; the display and the new-Turn gate
        # read this, never a guess.
        self._platform_ok: bool | None = None
        self._platform_detail = ''
        # The first self-reconnect waits one full cooldown from startup.
        self._reconnect_at = time.monotonic()
        self._reconcile_loading = None

    def _mark_platform(self, ok: bool, detail: str = '') -> None:
        """Record one Server contact outcome; a failure pauses new Turns."""
        with self._lock:
            self._platform_ok = ok
            self._platform_detail = '' if ok else (detail or 'CHAT_SERVER_UNAVAILABLE')

    def _consents(self, session):
        """The pending device decisions the Desktop chat can settle (#39).

        Issue 122 script asks and #116 knowledge-material asks are device
        authority exactly like file writes: they sit in the same pending
        queue and were invisible in Desktop mode only because this
        projection dropped every non-write capability, so the request timed
        out into a denial with no surface to answer it.
        """
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
            capability = pending.capability
            if payload.get('thread_id') != thread['id'] or payload.get('run_id') != run['id']:
                continue
            if capability == 'local.files.write':
                args = payload.get('arguments', payload.get('args', payload))
                if not isinstance(args, dict) or not isinstance(args.get('path'), str) or not isinstance(args.get('content'), str):
                    continue
                row = dict(taskId=pending.task_id, runId=run['id'], threadId=thread['id'],
                    requestHash=pending.request_hash, kind='file-write',
                    path=args['path'], content=args['content'])
                row['directory'] = pending.summary.get('directory', '')
            elif capability == 'local.skill.script':
                # Identity and scope facts only: the script bytes stay in the
                # gate, the card names what the user is approving (#122).
                if not isinstance(payload.get('skill_id'), str) or not isinstance(payload.get('script_path'), str):
                    continue
                row = dict(taskId=pending.task_id, runId=run['id'], threadId=thread['id'],
                    requestHash=pending.request_hash, kind='skill-script',
                    skill=payload['skill_id'], scriptPath=payload['script_path'],
                    version=str(payload.get('skill_version', '')),
                    scriptSha256=payload.get('script_sha256', ''),
                    requirementsSha256=requirements_fingerprint_of(payload.get('declaration')))
            elif capability == 'local.knowledge.material':
                args = payload.get('arguments', payload.get('args', payload))
                if not isinstance(args, dict) or not isinstance(args.get('documents'), list):
                    continue
                documents = []
                for entry in args['documents']:
                    if not isinstance(entry, dict) or not isinstance(entry.get('filename'), str) \
                            or not isinstance(entry.get('content_hash'), str):
                        documents = []
                        break
                    documents.append(dict(filename=entry['filename'], contentHash=entry['content_hash']))
                if not documents:
                    continue
                row = dict(taskId=pending.task_id, runId=run['id'], threadId=thread['id'],
                    requestHash=pending.request_hash, kind='knowledge-material',
                    revisionId=str(args.get('revision_id', '')), manifestHash=str(args.get('manifest_hash', '')),
                    documents=documents)
            else:
                continue
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
        self._subagent_names.clear()
        self._tasks_checked = 0.0
        self._tasks_loading = None
        self._reconcile_loading = None
        # The model facts belong to the identity that cached them.
        self._session_models.clear()
        self._models_cache = None
        self._account_default_cache = None
        # Issue 78: the binding registry belongs to the authenticated identity
        # the same way the model facts do.
        self._thread_bindings.clear()
        # Issue 77: a reset tore down the session the ledger was observing
        # (auth or identity failure), so the observation debt goes with it.
        # The Server keeps the runs; reopening their sessions shows the truth.
        self._background.clear()
        self._notified_consents.clear()

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
            if kind == 'ai':
                self._note_subagent_calls(raw)
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

    def _note_subagent_calls(self, raw):
        """Issue 76: record the task tool calls a published AI message carries.
        The sub-agent type lives only in the parent message's own tool_calls —
        the desktop derives this display fact from what the platform itself
        published, never from a local roster."""
        calls = raw.get('tool_calls')
        if not isinstance(calls, list):
            return
        for call in calls:
            if not isinstance(call, dict) or call.get('name') != 'task':
                continue
            call_id, args = call.get('id'), call.get('args')
            agent_type = args.get('subagent_type') if isinstance(args, dict) else None
            if not isinstance(call_id, str) or not 1 <= len(call_id) <= 128:
                continue
            if not isinstance(agent_type, str) or not agent_type:
                continue
            if len(self._subagent_names) >= MAX_SUBAGENT_NAMES:
                self._subagent_names.pop(next(iter(self._subagent_names)))
            self._subagent_names[call_id] = agent_type[:128]
            row = self._subagent_row(call_id)
            if row is not None:
                row['agent'] = self._subagent_names[call_id]

    def _subagent_row(self, task_id):
        """The ledger row one task id maps to, or None when the platform
        never reported it."""
        return next((row for row in self._state['subagents'] if row['taskId'] == task_id), None)

    def _subagent_event(self, payload):
        """Issue 76: fold one platform task_* custom event into the structured
        sub-agent ledger. The status name mirrors the pushed event exactly —
        the desktop never invents a state the platform did not send, and an
        event about an unknown or malformed task identity is dropped."""
        kind = payload.get('type')
        status = {'task_started': 'running', 'task_running': 'running', 'task_completed': 'completed',
                  'task_failed': 'failed', 'task_cancelled': 'cancelled',
                  'task_timed_out': 'timed_out'}.get(kind)
        if status is None:
            return
        task_id = payload.get('task_id')
        if not isinstance(task_id, str) or not 1 <= len(task_id) <= 128:
            return
        rows = {row['taskId']: row for row in self._state['subagents']}
        row = rows.get(task_id)
        if row is None:
            row = dict(taskId=task_id, description='', agent=self._subagent_names.get(task_id, ''),
                       status=status, step=None, totalSteps=None, model='', usage=None,
                       result='', resultTruncated=False, error='', errorTruncated=False)
            rows[task_id] = row
        row['status'] = status
        if kind == 'task_started':
            description = payload.get('description')
            if isinstance(description, str):
                row['description'] = description[:MAX_SUBAGENT_DESCRIPTION]
        elif kind == 'task_running':
            index, total = payload.get('message_index'), payload.get('total_messages')
            if type(index) is int and index >= 0:
                row['step'] = index
            if type(total) is int and total >= 0:
                row['totalSteps'] = total
        elif kind == 'task_completed':
            result = payload.get('result')
            if isinstance(result, str):
                row['result'], row['resultTruncated'] = result[:MAX_SUBAGENT_RESULT], len(result) > MAX_SUBAGENT_RESULT
        else:
            error = payload.get('error')
            if isinstance(error, str):
                row['error'], row['errorTruncated'] = error[:MAX_SUBAGENT_ERROR], len(error) > MAX_SUBAGENT_ERROR
        model = payload.get('model_name')
        if isinstance(model, str) and model:
            row['model'] = model[:128]
        usage = payload.get('usage')
        if isinstance(usage, dict):
            row['usage'] = {key: value for key, value in (
                ('inputTokens', usage.get('input_tokens')), ('outputTokens', usage.get('output_tokens')),
                ('totalTokens', usage.get('total_tokens'))) if type(value) is int and value >= 0} or None
        self._state['subagents'] = list(rows.values())[-MAX_SUBAGENT_ENTRIES:]

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
        # The Server reads below join the one locked commit at the end: a
        # background reconnect (#80) must never show a poller a half-loaded
        # thread — the record lands as one visible state, like the tasks
        # poll's own single-commit discipline.
        model = self._chat_model_view(session)
        tasks, task_error, artifacts = self._task_history(session, thread_id, [])
        with self._lock:
            # Issue 77: a Run still in flight on the thread being switched away
            # keeps running on the Server; register it for observation so its
            # completion and its approval asks can still reach the user. Reopening
            # or reconnecting the same thread never registers its own Run.
            previous_thread, previous_run = self._state.get('thread'), self._state.get('run')
            if (previous_thread and previous_run and previous_thread['id'] != thread_id
                    and previous_run['status'] in {'pending', 'running'}):
                self._register_background(previous_thread['id'], previous_run['id'])
            self._generation += 1
            self._state.update(thread=dict(id=thread_id, status=thread['status'],
                agentId=agent_id, skillId=skill_id),
                messages=[], events=[], run=self._run(latest) if latest else None,
                stream='idle', lastEventId='', error='', stop=None, localTasks=tasks,
                taskError=task_error, artifacts=artifacts)
            # Issue 74: a (re)loaded session starts at the lowest tier. The tier
            # is the session's own in-flight choice, never a remembered one —
            # even a reopened thread re-declares its intent.
            if self.session_tiers is not None:
                self.session_tiers.reset()
            self._state['localTier'] = DEFAULT_SESSION_TIER.value
            # Issue 73: a thread change resets the switch story; the session's own
            # model choice survives (it is bound to this thread id).
            self._state['modelOptions'] = model['options']
            self._state['model'].update(notice='', switchedFrom='', name=model['name'],
                source=model['source'], available=model['available'], reason=model['reason'])
            self._messages(messages)
            self._tasks_checked = time.monotonic()
            # Issue 77: the loaded thread is the visible session again — its runs
            # are observed by the foreground stream, not by the background ledger.
            self._background = [row for row in self._background if row['thread_id'] != thread_id]
        if self._state['run'] and self._state['run']['status'] in {'pending', 'running'}:
            self._observe(session)

    def _branch(self, session, thread_id, message_id, message_ids):
        """Issue 78: branch onto a new platform Thread from one settled turn.

        The platform's Thread branch capability owns everything — checkpoint
        discovery, inherited history, the new Thread row and its project
        membership. This Runtime names the target turn, re-reads the new
        Thread like any other open (no local copy of history exists at any
        point), and carries the source session's project folder binding over
        through `inherited_binding` — present hands a copy over, absent stays
        unbound. In-flight work is refused by the Server itself; the shared
        conflict category surfaces it.
        """
        if not self._state['thread'] or thread_id != self._state['thread']['id']:
            raise ChatError('CHAT_THREAD_CHANGED')
        if not self._thread_permissions(session)['canRename']:
            # The platform gates branches behind the same threads:write
            # permission the rename path pre-checks; the Server stays
            # authoritative either way.
            raise ChatError('CHAT_FORBIDDEN')
        source_id = self._state['thread']['id']
        created = self._json(session, f'/api/threads/{source_id}/branches',
                             {'message_id': message_id,
                              'message_ids': message_ids or [message_id]})
        if not isinstance(created, dict) or not isinstance(created.get('thread_id'), str):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        new_id = self._id(created['thread_id'])
        binding = inherited_binding(self._thread_bindings.get(source_id))
        if binding is not None:
            self._thread_bindings[new_id] = binding
        self._load_thread(session, new_id)

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

    # --- Background session observation (issue 77) --------------------------

    def _register_background(self, thread_id, run_id):
        """Record one Run the user left running by switching sessions.

        The ledger is display-only: it bounds what the Desktop observes and
        notifies about, never what the platform may run in parallel. A run id
        outside the wire identity charset is never registered — it could only
        become a malformed notification."""
        if not _is_wire_id(run_id):
            return
        with self._lock:
            if any(row['thread_id'] == thread_id and row['run_id'] == run_id
                   for row in self._background):
                return
            self._background.append(dict(thread_id=thread_id, run_id=run_id,
                                         title=self._thread_title(thread_id)))
            del self._background[:-BACKGROUND_LEDGER_LIMIT]

    def background_runs(self):
        """The bounded background-run summary for the Desktop status snapshot."""
        with self._lock:
            return [dict(threadId=row['thread_id'], runId=row['run_id'])
                    for row in self._background]

    def _thread_title(self, thread_id):
        with self._lock:
            return next((str(row.get('title', ''))[:200] for row in self._state['threads']
                         if row.get('id') == thread_id), '')

    @staticmethod
    def _consent_summary(approval, payload):
        """One bounded identity line per ask; content bytes never leave it."""
        args = payload.get('arguments', payload.get('args', payload)) if isinstance(payload, dict) else {}
        if approval == 'file-write':
            return str(args.get('path', ''))[:200] if isinstance(args, dict) else ''
        if approval == 'skill-script':
            return str(payload.get('skill_id', ''))[:200] if isinstance(payload, dict) else ''
        if approval == 'knowledge-material':
            return str(args.get('revision_id', ''))[:200] if isinstance(args, dict) else ''
        return ''

    def background_tick(self, force=False):
        """Observation-only background facts for the Desktop status loop (#77).

        Returns the notification events accumulated since the last tick:
        backgrounded Runs that reached an end state, and device approval asks
        whose session is not the visible one. The cadence bounds Server
        polling, not the platform's own concurrency; every event carries
        identity facts only."""
        now = time.monotonic()
        if not force:
            if now - self._background_checked < BACKGROUND_TICK_SECONDS:
                return []
        with self._lock:
            if self._background_loading is not None:
                return []
            ticket = object()
            self._background_loading = ticket
            self._background_checked = now
        try:
            return self._background_observe()
        finally:
            with self._lock:
                if self._background_loading is ticket:
                    self._background_loading = None

    def reconcile(self):
        """Issue 80: one guarded self-reconnect attempt for a session left
        with an unknown outcome. The chat state poll and the status loop
        share this entry point, so recovery never depends on a panel being
        open. The entry point only schedules the attempt — the probe and the
        record reload run on their own thread, the same discipline as the
        tasks poll: network observations never hold up a user's command. When
        nothing else has talked to the Server since the last failure, the
        attempt carries its own short reachability probe; once the platform
        answers, it reloads the Server's own record — the run stream,
        messages and task history come back from the platform; nothing is
        resubmitted, re-dispatched or invented locally. An unresolved stop
        keeps its explicit reconcile contract instead."""
        with self._lock:
            if (not self._state['thread']
                    or self._state['stream'] not in {'uncertain', 'disconnected'}
                    or self._state.get('stop')
                    or self._reconcile_loading is not None
                    or time.monotonic() - self._reconnect_at < RECONNECT_COOLDOWN_SECONDS):
                return
            thread_id = self._state['thread']['id']
            self._reconnect_at = time.monotonic()
            ticket = object()
            self._reconcile_loading = ticket

        def attempt():
            try:
                session = self._session()
                if session.scope != self._state['scope']:
                    return
                if self._platform_ok is not True:
                    with self._request(session, '/api/v1/auth/me', timeout=RECONNECT_PROBE_TIMEOUT_SECONDS) as response:
                        response.read(MAX_RESPONSE + 1)
                    if self._platform_ok is not True:
                        return
                self._load_thread(session, thread_id)
            except Exception:  # noqa: BLE001 - a failed recovery is the outage
                return          # speaking for itself; the next attempt retells it.
            finally:
                with self._lock:
                    if self._reconcile_loading is ticket:
                        self._reconcile_loading = None

        threading.Thread(target=attempt, daemon=True).start()

    def _background_observe(self):
        try:
            session = self._session()
        except ChatError:
            return []  # 暂时不可用：保留登记，下一轮再观察
        with self._lock:
            if session.scope != self._state['scope']:
                # 配对身份已变化：旧身份的观察账本随之清除，绝不外泄。
                self._background.clear()
                self._notified_consents.clear()
                return []
            foreground = (self._state.get('thread') or {}).get('id', '')
            background = list(self._background)
        events = self._background_consents(session, foreground)
        events.extend(self._background_runs(session, background))
        return events

    def _background_consents(self, session, foreground):
        """Approval asks on sessions the user cannot currently see.

        The unfiltered device queue already knows every ask's session; only
        asks outside the visible session are notified here, exactly once, so
        the visible session keeps its chat cards and a resolved ask that
        reappears is asked again."""
        try:
            pending = list(self.local_consents())
        except Exception:
            return []  # 快照不可用时跳过本轮审批观察
        alive = set()
        events = []
        for row in pending:
            payload = getattr(row, 'payload', None)
            task_id = getattr(row, 'task_id', '')
            alive.add(str(task_id)[:128])
            thread_id = payload.get('thread_id') if isinstance(payload, dict) else None
            if not isinstance(thread_id, str) or not thread_id or thread_id == foreground:
                continue
            approval = {'local.files.write': 'file-write', 'local.skill.script': 'skill-script',
                        'local.knowledge.material': 'knowledge-material'}.get(str(getattr(row, 'capability', '')), '')
            if not approval:
                continue  # 未识别的审批类别不进通知（前台卡片也不支持它）
            # 每个事实都必须能原样过线：身份字段不符合线格式的问题跳过，
            # 绝不发射会让主进程当作畸形状态行处理的通知。
            if not _is_wire_id(task_id) or not _is_wire_id(payload.get('run_id')):
                continue
            with self._lock:
                if task_id in self._notified_consents:
                    continue
                self._notified_consents[task_id] = True
            events.append(dict(kind='approval-required', threadId=thread_id,
                runId=payload.get('run_id'), taskId=task_id,
                approval=approval, summary=self._consent_summary(approval, payload),
                title=self._thread_title(thread_id)))
        with self._lock:
            # 已不在待审队列的旧记录移出去重集，同一任务再问仍会通知。
            for task_id in [key for key in self._notified_consents if key not in alive]:
                del self._notified_consents[task_id]
        return self._scrub_events(session, events)

    def _background_runs(self, session, background):
        """Ask the Server about each registered Run, oldest first; a Run that
        left {pending, running} is reported once and dropped. A unreachable
        Server keeps the ledger untouched for the next tick."""
        events = []
        polled = 0
        for row in background:
            if polled >= BACKGROUND_POLL_LIMIT:
                break
            polled += 1
            try:
                run = self._json(session, f"/api/threads/{row['thread_id']}/runs/{row['run_id']}")
            except ChatError as exc:
                if str(exc) == 'CHAT_NOT_FOUND':
                    # 平台已找不到该 Run（如会话被删除）：静默移出账本。
                    with self._lock:
                        self._background = [item for item in self._background
                                            if not (item['thread_id'] == row['thread_id'] and item['run_id'] == row['run_id'])]
                    continue
                break
            if not isinstance(run, dict) or not isinstance(run.get('status'), str):
                break
            if run['status'] in {'pending', 'running'}:
                continue
            with self._lock:
                self._background = [item for item in self._background
                                    if not (item['thread_id'] == row['thread_id'] and item['run_id'] == row['run_id'])]
            status = run['status'][:32]
            if not status:
                continue  # 空状态发不出去，也不算完成事实
            events.append(dict(kind='run-finished', threadId=row['thread_id'], runId=row['run_id'],
                status=status, title=row.get('title', '')))
        return self._scrub_events(session, events)

    def _scrub_events(self, session, events):
        if not events or not getattr(session, 'token', ''):
            return events
        scrubbed = []
        for event in events:
            encoded = json.dumps(event).replace(session.token, '[REDACTED]')
            scrubbed.append(json.loads(encoded))
        return scrubbed

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

        def consume():
            try:
                attempts = 0
                # Streamed message ids survive across resume connections: the
                # Server replays the stream from after the cursor, so the
                # first replayed chunk of a live message is a continuation.
                streamed_ids = set()
                while True:
                    try:
                        if not self._consume_stream(session, thread_id, run_id, generation, streamed_ids):
                            return  # outlived its turn or identity; touch nothing
                        break
                    except ChatError as exc:
                        # A stream that ended by itself or a connection-level
                        # refusal resumes; a server-reported error stays
                        # terminal once the attempts run out.
                        if exc.code not in {'CHAT_STREAM_DISCONNECTED', 'CHAT_SERVER_UNAVAILABLE'} or attempts >= STREAM_RECONNECTS:
                            raise
                        attempts += 1
                        with self._lock:
                            if generation != self._generation:
                                return
                        time.sleep(STREAM_RECONNECT_DELAY)
                with self._lock:
                    if generation == self._generation:
                        run = self._json(session, f'/api/threads/{thread_id}/runs/{run_id}')
                        self._state.update(run=self._run(run), stream='idle')
            except Exception as exc:
                with self._lock:
                    if generation == self._generation:
                        self._state.update(stream='disconnected', error=str(exc) if isinstance(exc, ChatError) else 'CHAT_STREAM_DISCONNECTED')

        threading.Thread(target=consume, daemon=True).start()

    def _consume_stream(self, session, thread_id, run_id, generation, streamed_ids):
        """One SSE connection for the run stream (#37).

        Raises CHAT_STREAM_DISCONNECTED when the connection goes silent past
        the stream read window or ends without the server's end event; the
        caller decides whether to resume with the Last-Event-ID cursor.
        Returns False when the stream outlived its turn or identity: the
        caller must then leave the state to whichever command replaced it.
        """
        with self._lock:
            cursor = self._state['lastEventId']
        headers = {'Last-Event-ID': cursor} if cursor else {}
        with self._request(session, f'/api/threads/{thread_id}/runs/{run_id}/stream',
                           headers=headers, timeout=STREAM_READ_TIMEOUT) as response:
            event, data, event_id, size, ended = '', [], '', 0, False
            while True:
                try:
                    line = response.readline(MAX_RESPONSE + 1)
                except (socket.timeout, ConnectionError):
                    # A silent window or a reset mid-stream is a dropped
                    # stream, not a run failure; both resume from the cursor.
                    raise ChatError('CHAT_STREAM_DISCONNECTED') from None
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
                            return False
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
                            elif root == 'custom' and isinstance(value, dict):
                                # Issue 76: the lead Agent's parallel sub-agents
                                # report through the platform's own task_* custom
                                # events (root or subgraph-namespaced); fold them
                                # into the structured ledger beside the raw record.
                                self._subagent_event(value)
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
        return True

    def _send(self, session, command):
        turn_id = self._uuid(command.get('turnId'))
        # Issue 75: the structured input commands ride the send action only —
        # an answer never carries them. Shapes are bounded before anything
        # else: a violation fails without consuming the turn or the session.
        delegate_id = command.get('delegateAgentId')
        skill_ids = command.get('skillIds')
        collab = command.get('collab')
        attachments = self._validate_attachments(command)
        # The bounds mirror the main process exactly: at most 8 mounted
        # Skills (shared MAX_MESSAGE_SKILLS) and ids within 128 characters.
        if command['action'] != 'send' and (delegate_id is not None or skill_ids is not None or collab is not None):
            raise ChatError('CHAT_COMMAND_INVALID')
        if delegate_id is not None and (not isinstance(delegate_id, str) or not delegate_id or len(delegate_id) > 128):
            raise ChatError('CHAT_COMMAND_INVALID')
        if skill_ids is not None and (not isinstance(skill_ids, list) or not skill_ids or len(skill_ids) > 8
                                      or len(set(skill_ids)) != len(skill_ids)
                                      or any(not isinstance(value, str) or not value or len(value) > 128 for value in skill_ids)):
            raise ChatError('CHAT_COMMAND_INVALID')
        if collab is not None and not isinstance(collab, bool):
            raise ChatError('CHAT_COMMAND_INVALID')
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
        # Issue 93: with attachments the extracted text blocks carry part of
        # the message, so an empty user text is acceptable — the composed
        # content below still must be non-empty and within the platform's own
        # message bound. The reserve check runs before any file is read, any
        # parse happens or any byte is staged: a send that cannot honestly fit
        # fails without consuming the turn or touching the network.
        if not isinstance(text, str) or (attachments is None and not text.strip()) or len(text) > 16000:
            raise ChatError('CHAT_MESSAGE_INVALID')
        if attachments is not None:
            reserve = 2 * len(attachments) + sum(ATTACHMENT_UPLOAD_RESERVE if row['destination'] == 'upload'
                                                 else ATTACHMENT_PARSED_RESERVE for row in attachments)
            if len(text) + reserve > 16000:
                raise ChatError('CHAT_MESSAGE_INVALID')
        # Issue 75: the delegate Agent must be a published agent; the mention
        # text itself stays the lead Agent's cue and the platform delegates
        # through its own sub-agents inside THIS session (assistant_id stays
        # the session's main Agent). The mounted Skills must be published; the
        # first chip wins the platform's one explicit Skill per run and is
        # validated by the same agent-closure rule as a create-time Skill,
        # while the whole mount is recorded on the run. A run without any
        # explicit Skill is exactly where the account's own Server-side
        # trigger-preference injection applies — never alongside it.
        resolved_delegate = ''
        resolved_skills: list = []
        if delegate_id:
            resolved_delegate = self._uuid(delegate_id)
            delegate_published = self._published(session, resolved_delegate)
            if delegate_published['resource']['type'] != 'agent':
                raise ChatError('CHAT_RESOURCE_UNAVAILABLE')
        if skill_ids:
            resolved_skills = [self._uuid(value) for value in skill_ids]
            for value in resolved_skills:
                self._published(session, value)
            closure = set()
            self._published(session, agent_id, closure)
            if resolved_skills[0] not in closure:
                raise ChatError('CHAT_SKILL_OUTSIDE_AGENT')
        # Issue 73: resolve and preflight the model before the Turn is
        # consumed — an unavailable choice stops here with an explicit
        # category, so the user can switch and resend without reconnecting.
        model_pick = self._resolve_send_model(session, thread)
        composed, attachment_statuses, attachment_facts = text, None, []
        if attachments is not None:
            composed, attachment_statuses, attachment_facts = self._compose_attachments(
                session, thread['id'], text, attachments)
            # By construction the composition respects the bound; this guard
            # keeps the platform contract absolute even if a marker grows.
            if not composed.strip() or len(composed) > 16000:
                raise ChatError('CHAT_MESSAGE_INVALID')
        message = dict(id=turn_id, type='human', content=composed)
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
        context = {'agent_name': agent_id, **local_context}
        if resolved_skills or thread['skillId']:
            context['skill_resource_id'] = resolved_skills[0] if resolved_skills else thread['skillId']
        if model_pick['name']:
            context['model_name'] = model_pick['name']
        if collab is not None:
            # Issue 76: the collab switch maps onto the platform's own
            # delegation seam with an explicit boolean, exactly like the Web
            # client's own mode switch: the platform's silent default is
            # delegation OFF, so "on" must say so. The flag rides send
            # commands only (the composer always sends it) — an answer run
            # keeps the platform default. Which sub-agents exist stays the
            # lead Agent's own configuration (the platform ANDs this flag
            # with its allowlist), and no local orchestration channel
            # appears.
            context['subagent_enabled'] = collab is not False
        metadata = {'desktop_turn_id': turn_id}
        if resolved_delegate:
            metadata['desktop_delegate_agent_id'] = resolved_delegate
        if resolved_skills:
            # The whole mount rides the run as the user's own choice; the
            # explicit seam above stays the platform's one-Skill-per-run cap.
            metadata['desktop_skill_ids'] = resolved_skills
        if attachment_facts:
            # Issue 93: the per-attachment destination facts ride the run as
            # identity facts only — names, chosen destination and source hash,
            # never content.
            metadata['desktop_attachments'] = attachment_facts
        body = dict(assistant_id=agent_id, input={'messages': [message]},
                    context=context,
                    metadata=metadata, stream_mode=['messages-tuple', 'values', 'custom'],
                    stream_subgraphs=True, multitask_strategy='reject', on_disconnect='continue')
        try:
            run = self._json(session, f"/api/threads/{thread['id']}/runs", body, {'Idempotency-Key': turn_id})
        except ChatError as exc:
            # Issue 73: one bounded fallback re-submission when the Server
            # names the model as the refusal; anything else keeps the existing
            # uncertain-submission contract. The switch is displayed, never
            # silent.
            fallback_pick = self._fallback_retry_pick(session, thread, model_pick, exc)
            if fallback_pick is None:
                if self._model_denial(exc):
                    raise ChatError('CHAT_MODEL_UNAVAILABLE') from None
                self._state['stream'] = 'uncertain'
                raise
            body['context'] = {**body['context'], 'model_name': fallback_pick['name']}
            try:
                run = self._json(session, f"/api/threads/{thread['id']}/runs", body, {'Idempotency-Key': turn_id})
            except ChatError:
                self._state['stream'] = 'uncertain'
                raise
            model_pick = fallback_pick
        self._generation += 1
        # The structured sub-agent ledger belongs to the run that dispatched
        # it; a new turn starts empty while finished results remain in the
        # conversation's own tool messages (#76).
        self._state.update(run=self._run(run), lastEventId='', events=[], error='', stop=None, subagents=[])
        self._apply_send_model(model_pick)
        self._observe(session)
        # Issue 93: the per-attachment outcomes ride only this send's reply,
        # transient like a download — the composed message text itself stays
        # the conversation's durable record of what happened.
        return attachment_statuses

    def _validate_attachments(self, command):
        """Issue 93: the attachment list is a send-only, bounded structure.

        The shapes mirror the main process exactly: at most
        MAX_MESSAGE_ATTACHMENTS entries with unique bounded ids, an explicit
        destination of ``parsed-text`` or ``upload`` (``local-view`` is its own
        attachment-view command and never rides a send). A violation fails
        before anything executes. ``None`` means no attachments were sent.
        """
        attachments = command.get('attachments')
        if attachments is None:
            return None
        if command['action'] != 'send' or not isinstance(attachments, list) \
                or not 1 <= len(attachments) <= MAX_MESSAGE_ATTACHMENTS:
            raise ChatError('CHAT_COMMAND_INVALID')
        seen = set()
        for row in attachments:
            if not isinstance(row, dict) or set(row) != {'id', 'path', 'name', 'destination'}:
                raise ChatError('CHAT_COMMAND_INVALID')
            attachment_id, path, name, destination = row['id'], row['path'], row['name'], row['destination']
            if (not isinstance(attachment_id, str) or not attachment_id or len(attachment_id) > 128
                    or attachment_id in seen):
                raise ChatError('CHAT_COMMAND_INVALID')
            if not isinstance(path, str) or not path or len(path) > MAX_ATTACHMENT_PATH:
                raise ChatError('CHAT_COMMAND_INVALID')
            if not isinstance(name, str) or not name or len(name) > MAX_ATTACHMENT_NAME:
                raise ChatError('CHAT_COMMAND_INVALID')
            if destination not in {'parsed-text', 'upload'}:
                raise ChatError('CHAT_COMMAND_INVALID')
            seen.add(attachment_id)
        return attachments

    @staticmethod
    def _read_attachment_bytes(path):
        """Read one user-picked attachment, bounded by the parse engine's own
        per-file ceiling; an unreadable file answers ``None`` and the
        attachment fails honestly instead of failing the message."""
        try:
            with open(path, 'rb') as handle:
                return handle.read(MAX_PARSE_FILE_BYTES + 1)
        except OSError:
            return None

    def _upload_attachment(self, session, thread_id, name, raw, settings, binding):
        """Take one explicitly uploaded attachment original to the Thread's
        own artifact seam. Mirrors the registered-result upload (#105) minus
        the task registry: the user's explicit destination choice is the
        authorization, identity and device binding are re-checked on the way,
        and the Server must echo exactly what was stored."""
        digest = hashlib.sha256(raw).hexdigest()
        self._check_compatibility('local.artifacts.upload')
        try:
            handle = FileArtifactUploader(Path(self.config.parent) / 'artifact-staging',
                                          max_bytes=MAX_ATTACHMENT_UPLOAD_BYTES).upload(name, raw)
        except ArtifactUploadError:
            raise ChatError('ATTACHMENT_STAGING_FAILED') from None
        if handle != f'local://{digest}/{name}':
            raise ChatError('ATTACHMENT_STAGING_FAILED')
        grant_basis = {'thread_id': thread_id, 'name': name, 'sha256': digest,
                       'device_id': settings.device_id, 'bytes': len(raw)}
        issued = self._json(session, f'/api/threads/{thread_id}/artifacts/grant', grant_basis,
                            self._device_headers(session, binding))
        if (not isinstance(issued, dict) or not isinstance(issued.get('token'), str)
                or not 16 <= len(issued['token']) <= 512
                or any(issued.get(key) != value for key, value in
                       {'thread_id': thread_id, 'name': name, 'device_id': settings.device_id}.items())):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        # A slow grant cannot authorize bytes under a retired account or
        # device binding — re-read through the current identity before the
        # content leaves the device.
        headers = self._device_headers(session, binding)
        self._check_compatibility('local.artifacts.upload')
        if self._session().scope != session.scope:
            raise ChatError('CHAT_IDENTITY_CHANGED')
        body = {'version': 1, 'kind': 'chat_attachment', 'name': name, 'sha256': digest,
                'bytes': len(raw), 'content': base64.b64encode(raw).decode('ascii'), 'handle': handle,
                'grant': {'thread_id': thread_id, 'name': name, 'token': issued['token']}}
        created = self._json(session, f'/api/threads/{thread_id}/artifacts', body,
                             {**headers, 'Idempotency-Key': handle})
        artifact_id = created.get('artifact_id') if isinstance(created, dict) else None
        if (not isinstance(artifact_id, str) or not 1 <= len(artifact_id) <= 128
                or created.get('name') != name or created.get('sha256') != digest
                or created.get('bytes') != len(raw) or created.get('thread_id') != thread_id):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        return artifact_id

    def _compose_attachments(self, session, thread_id, text, attachments):
        """Process each attachment per its explicit destination and compose
        the outgoing message.

        The default parsed-text destination keeps the original on the device
        and bounds the extracted text by the message's remaining budget; the
        upload destination hands the original to the Thread artifact seam
        before the run is submitted so the message can name the real artifact.
        Every per-attachment problem becomes an honest line in the message and
        a status entry — it never fails the user's text and never pretends.
        Returns (composed text, reply statuses, run metadata facts).
        """
        settings = load_settings(self.config)
        binding = profile_binding(settings)
        blocks: list = []
        statuses: list = []
        facts: list = []
        used = len(text)
        for row in attachments:
            name = row['name']
            status = dict(id=row['id'], name=name, destination=row['destination'])
            raw = self._read_attachment_bytes(row['path'])
            if raw is None:
                status.update(status='failed', errorCode='ATTACHMENT_READ_FAILED')
                blocks.append(f'[附件·{name}·处理失败：ATTACHMENT_READ_FAILED]')
                statuses.append(status)
                facts.append(dict(id=row['id'], name=name, destination=row['destination']))
                continue
            digest = hashlib.sha256(raw).hexdigest()
            status['sha256'] = digest
            fact = dict(id=row['id'], name=name, destination=row['destination'], sha256=digest)
            if row['destination'] == 'upload':
                if len(raw) > MAX_ATTACHMENT_UPLOAD_BYTES:
                    status.update(status='failed', errorCode='ATTACHMENT_TOO_LARGE')
                    blocks.append(f'[附件·{name}·处理失败：ATTACHMENT_TOO_LARGE]')
                else:
                    try:
                        artifact_id = self._upload_attachment(session, thread_id, name, raw,
                                                              settings, binding)
                        status.update(status='uploaded', artifactId=artifact_id)
                        fact['artifactId'] = artifact_id
                        blocks.append(f'[附件·{name}·原件已上传为平台附件·附件 {artifact_id}'
                                      f'·SHA-256 {digest[:16]}…]')
                    except ChatError as exc:
                        status.update(status='failed', errorCode=str(exc))
                        blocks.append(f'[附件·{name}·处理失败：{exc}]')
            else:
                result = parse_document(raw, name)
                if result['status'] == 'parsed':
                    marker = f'[附件·{name}·本机解析·{result["parser"]}@{result["parser_version"]}]'
                    closing = f'[/附件·{name}]'
                    allowance = 16000 - used - len(marker) - len(closing) - ATTACHMENT_BLOCK_SLACK
                    body_text = result['text']
                    if allowance <= 0:
                        content, over = '（超出本条消息长度预算，附件文本未并入）', True
                    else:
                        content, over = body_text[:allowance], len(body_text) > allowance
                    truncated = over or bool(result.get('truncated'))
                    if over:
                        closing += '（已截断）'
                    block = f'{marker}\n{content}\n{closing}'
                    status.update(status='parsed', truncated=truncated)
                else:
                    block = f'[附件·{name}·解析失败：{result["reason"]}]'
                    status.update(status=result['status'], errorCode=result['reason'])
                blocks.append(block)
                # The citation facts ride the run record too: the parser
                # identity and version let any later device re-derive the
                # extraction from the hash-verified bytes (#81). The layout
                # anchors stay a bounded display fact and never ride the wire.
                if result['status'] == 'parsed':
                    fact['parser'] = result['parser']
                    fact['parserVersion'] = result['parser_version']
            used += len(blocks[-1]) + 2
            statuses.append(status)
            facts.append(fact)
        parts = ([text] if text.strip() else []) + blocks
        return '\n\n'.join(parts), statuses, facts

    def _attachment_view(self, session, command):
        """Issue 93: 仅本机查看。A pure device read that answers one bounded
        read-only display record: no run is created, nothing is uploaded and
        nothing enters the conversation. The display text is bounded by
        MAX_ATTACHMENT_VIEW_CHARS; the parse summary carries the engine's
        identity, page and table facts for the card."""
        if set(command) != {'action', 'scope', 'threadId', 'id', 'path', 'name'}:
            raise ChatError('CHAT_COMMAND_INVALID')
        attachment_id, path, name = command.get('id'), command.get('path'), command.get('name')
        if (not isinstance(attachment_id, str) or not attachment_id or len(attachment_id) > 128
                or not isinstance(path, str) or not path or len(path) > MAX_ATTACHMENT_PATH
                or not isinstance(name, str) or not name or len(name) > MAX_ATTACHMENT_NAME):
            raise ChatError('CHAT_COMMAND_INVALID')
        if not self._state['thread'] or command.get('threadId') != self._state['thread']['id']:
            raise ChatError('CHAT_THREAD_CHANGED')
        view = dict(id=attachment_id, name=name, status='failed', text='', truncated=False, errorCode='')
        raw = self._read_attachment_bytes(path)
        if raw is None:
            view['errorCode'] = 'ATTACHMENT_READ_FAILED'
            return view
        result = parse_document(raw, name)
        summary = parse_summary(result)
        view.update(status=result['status'],
                    truncated=bool(result.get('truncated')),
                    errorCode=result.get('reason', ''))
        if result['status'] == 'parsed':
            text = result['text']
            if len(text) > MAX_ATTACHMENT_VIEW_CHARS:
                text, view['truncated'] = text[:MAX_ATTACHMENT_VIEW_CHARS], True
            view['text'] = text
        view['summary'] = summary
        return view

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

    def _request(self, session, path, body=None, headers=None, method=None, timeout=15):
        csrf = secrets.token_urlsafe(32)
        # A pre-encoded body (multipart upload) carries its own Content-Type
        # through the headers override; JSON requests keep the default.
        request_headers = {'Cookie': f'access_token={session.token}; csrf_token={csrf}',
                           'X-CSRF-Token': csrf, 'Origin': session.origin, 'Content-Type': 'application/json',
                           **(headers or {})}
        request = urllib.request.Request(session.origin + path, headers=request_headers,
                                         data=None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode()),
                                         method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            # Issue 80: a 4xx answer is still an answer — refusals say
            # something about identity or the request, never that the
            # platform is away. A 5xx is the server side failing, which is
            # the same outage a dead socket is.
            self._mark_platform(exc.code < 500, 'CHAT_SERVER_ERROR' if exc.code >= 500 else '')
            codes = {401: 'CHAT_UNAUTHENTICATED', 403: 'CHAT_FORBIDDEN', 404: 'CHAT_NOT_FOUND',
                     409: 'CHAT_CONFLICT', 422: 'CHAT_RESOURCE_UNAVAILABLE'}
            try:
                detail = exc.read(4096).decode('utf-8', 'replace')
            except OSError:
                detail = ''
            finally:
                exc.close()
            raise ChatError(codes.get(exc.code, 'CHAT_SERVER_ERROR'), detail) from None
        except (OSError, ValueError):
            # Issue 80: the one place an unreachable platform is observed.
            # The named category becomes the visible reason a new Turn is
            # refused while the outage lasts.
            self._mark_platform(False, 'CHAT_SERVER_UNAVAILABLE')
            raise ChatError('CHAT_SERVER_UNAVAILABLE') from None
        self._mark_platform(True)
        return response

    def _json(self, session, path, body=None, headers=None, method=None):
        with self._request(session, path, body, headers, method=method) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ChatError('CHAT_RESPONSE_TOO_LARGE')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise ChatError('CHAT_PROTOCOL_ERROR') from None

    def _empty(self, session, path, body, method, expected=204, headers=None):
        """One Server write that returns no body; only the expected status passes."""
        with self._request(session, path, body, method=method, headers=headers) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if response.status != expected or raw:
            raise ChatError('CHAT_PROTOCOL_ERROR')

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

    # --- Controlled knowledge-graph entry (issue 116) -----------------------

    def knowledge_graph(self, kb_id, revision_id, *, action, document_id=None, document_ids=None, query=""):
        """View, generate, locate, or scope-query one frozen revision's graph.

        The Server owns the graph and every scoped answer: the view/generate
        answers carry entity, relation, and source facts bound to the frozen
        KB/Revision identity, projected exactly as the platform returned them
        (bounded for display). ``search`` and ``ask`` post the selected
        frozen-document scope to the Server's scoped endpoints, so retrieval
        and QA ride the Server's authorization chain and its own model — the
        device never runs a local model or filters authorization by display
        labels. ``locate`` never calls the Server for content: it resolves
        the source document against this device's workspace by (filename,
        frozen digest) and answers with the workspace logical path for the
        local user only.
        """
        from .knowledge_material import locate_frozen_document
        kb_id = self._uuid(kb_id)
        revision_id = self._uuid(revision_id)
        session = self._session()
        if action in {"search", "ask"}:
            documents = _scoped_document_ids(document_ids)
            text = _bounded_text(query, 512 if action == "search" else 4000)
            if not text:
                raise ChatError("CHAT_COMMAND_INVALID")
            endpoint = "query" if action == "search" else "ask"
            body = {"document_ids": documents}
            body["query" if action == "search" else "question"] = text
            payload = _graph_scope_payload(
                self._json(session, f"/api/resources/{kb_id}/knowledge-revisions/{revision_id}/graph/{endpoint}", body),
                with_answer=action == "ask",
            )
            payload["kbId"] = kb_id
            return payload
        if action == "view":
            payload = _graph_view_payload(self._json(
                session, f"/api/resources/{kb_id}/knowledge-revisions/{revision_id}/graph"))
            payload["kbId"] = kb_id
            return payload
        if action == "generate":
            self._json(session, f"/api/resources/{kb_id}/knowledge-revisions/{revision_id}/graph", body={})
            payload = _graph_view_payload(self._json(
                session, f"/api/resources/{kb_id}/knowledge-revisions/{revision_id}/graph"))
            payload["kbId"] = kb_id
            return payload
        if action == "locate":
            if self.knowledge_files is None:
                raise ChatError("CHAT_COMMAND_INVALID")
            view = _graph_view_payload(self._json(
                session, f"/api/resources/{kb_id}/knowledge-revisions/{revision_id}/graph"))
            source = next((row for row in view["sources"] if row["documentId"] == (document_id or "")), None)
            if source is None:
                raise ChatError("KNOWLEDGE_GRAPH_SOURCE_UNKNOWN")
            from .files import FileAccessError
            from .knowledge_material import KnowledgeMaterialError
            try:
                _settings, grant, files = self.knowledge_files()
            except (FileAccessError, KnowledgeMaterialError) as exc:
                from .knowledge_import import category_for
                raise KnowledgeMaterialError(category_for(exc)) from exc
            from .receipt_ledger import profile_binding
            binding = profile_binding(load_settings(self.config))
            if binding is None:
                raise ChatError("KNOWLEDGE_GRAPH_IDENTITY_UNAVAILABLE")
            payload = {"revision_id": revision_id, "manifest_hash": view["manifestHash"],
                       "documents": [{"document_id": source["documentId"], "filename": source["filename"],
                                      "content_hash": source["contentHash"]}]}
            located = locate_frozen_document(payload, files=files, logical_root=grant["logical_root"])
            if located.get("missing") is True:
                return {"kbId": kb_id, "revisionId": revision_id, "documentId": source["documentId"],
                        "missing": True, "reason": str(located.get("reason") or "document_unavailable")}
            return {"kbId": kb_id, "revisionId": revision_id, "documentId": source["documentId"],
                    "filename": located.get("filename", ""),
                    "logicalPath": str(located.get("logical_path") or "")}
        raise ChatError("CHAT_COMMAND_INVALID")

    # --- Controlled wiki entry (issue 118) ----------------------------------

    def wiki(self, kb_id, revision_id, *, action, document_id=None):
        """View, generate, read, or navigate one frozen revision's wiki.

        The Server owns every page: the view carries the page list with its
        per-page progress, skips, and frozen source bindings (never bodies),
        ``generate`` lets the Server orchestrate the batch and re-reads the
        list, ``read`` fetches exactly one page whose document id must be
        frozen in this revision — the Server refuses anything else, so an
        out-of-scope page can never leak a title or a body — and ``navigate``
        projects the index with links, backlinks, and the association graph
        derived only from this revision's own artifacts (#119). A skipped or
        failed page projects as exactly that: its fixed category, never text.
        """
        kb_id = self._uuid(kb_id)
        revision_id = self._uuid(revision_id)
        session = self._session()
        base = f"/api/resources/{kb_id}/knowledge-revisions/{revision_id}/wiki"
        if action == "view":
            payload = _wiki_view_payload(self._json(session, base))
            payload["kbId"] = kb_id
            return payload
        if action == "generate":
            self._json(session, base, body={})
            payload = _wiki_view_payload(self._json(session, base))
            payload["kbId"] = kb_id
            return payload
        if action == "read":
            document = _wiki_document_id(document_id)
            payload = _wiki_page_payload(self._json(session, f"{base}/pages/{document}"))
            payload["kbId"] = kb_id
            return payload
        if action == "navigate":
            payload = _wiki_navigation_payload(self._json(session, f"{base}/navigation"))
            payload["kbId"] = kb_id
            return payload
        raise ChatError("CHAT_COMMAND_INVALID")

    # --- Explicit skill package import (issue 120) --------------------------

    def _post_multipart_form(self, session, path, fields, filename, content, file_type):
        """POST one multipart form (fields plus one file) and parse the JSON reply."""
        boundary = '----ideer120' + secrets.token_hex(16)
        parts = []
        for name, value in fields:
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
                          f'{value}\r\n').encode())
        safe_filename = filename.replace('\\', '%5C').replace('"', '\\"')
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="archive"; filename="{safe_filename}"\r\n'
                      f'Content-Type: {file_type}\r\n\r\n').encode() + content + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        with self._request(session, path, b''.join(parts),
                           {'Content-Type': f'multipart/form-data; boundary={boundary}'}) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ChatError('CHAT_RESPONSE_TOO_LARGE')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise ChatError('CHAT_PROTOCOL_ERROR') from None

    def import_skill_package(self, kind, paths, *, confirmed):
        """Preview or confirm one Desktop skill package import (#120).

        The device-side read is entirely local and uploads nothing: the
        preview projects the package's body, scripts, and references with
        their hashes. A confirmed attempt re-reads the exact bytes, binds
        them through the Server's preview identity (hash equality), and
        lands them as the account's private draft. Publication stays an
        explicit later step on the existing draft/publish flow, and nothing
        here executes locally: the package only ever becomes catalog
        content for Server-orchestrated Runs.
        """
        from .receipt_ledger import profile_binding
        from .settings import load_settings
        from .skill_import import PACKAGE_KINDS, SkillImportError, read_package
        if self.skill_imports is None:
            raise ChatError('CHAT_COMMAND_INVALID')
        if kind not in PACKAGE_KINDS or not isinstance(paths, list) or len(paths) != 1 \
                or any(not isinstance(path, str) or not path or len(path) > 32768 for path in paths) \
                or not isinstance(confirmed, bool):
            raise ChatError('CHAT_COMMAND_INVALID')
        binding = profile_binding(load_settings(self.config))
        try:
            package = read_package(paths, kind, protected=(self.config.parent,))
            upload = package.pop('upload')
            if not confirmed:
                return dict(confirmed=False, origin=kind, name=package['name'],
                            description=package['description'], body=package['body'],
                            files=package['files'], fileCount=package['file_count'],
                            totalBytes=package['total_bytes'], packageHash=package['package_hash'],
                            destination=dict(resourceType='skill', visibility='private'))
            session = self._session()
            file_type = 'text/markdown' if kind == 'markdown' else 'application/zip'
            # The Server preview binds the authoritative identity of the exact
            # bytes this device just read; any drift refuses the import before
            # the confirm call can create anything.
            server_preview = self._post_multipart_form(
                session, '/api/resources/import/skill/preview', [('origin', kind)],
                'package' if kind == 'markdown' else 'package.zip', upload, file_type)
            if not isinstance(server_preview, dict) or not isinstance(server_preview.get('package_hash'), str) \
                    or len(server_preview['package_hash']) != 64 \
                    or server_preview['package_hash'] != package['package_hash']:
                raise SkillImportError('SKILL_IMPORT_HASH_MISMATCH')
            created = self._post_multipart_form(
                session, '/api/resources/import/skill/confirm',
                [('origin', kind), ('expected_package_hash', package['package_hash'])],
                'package' if kind == 'markdown' else 'package.zip', upload, file_type)
            if not isinstance(created, dict) or not isinstance(created.get('id'), str) \
                    or not isinstance(created.get('slug'), str) \
                    or not isinstance(created.get('draft'), dict) \
                    or type(created['draft'].get('revision')) is not int \
                    or not isinstance(created['draft'].get('content_hash'), str) \
                    or len(created['draft']['content_hash']) != 64 \
                    or created['draft']['content_hash'] != package['package_hash']:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            outcome = dict(confirmed=True, resourceId=created['id'], slug=created['slug'],
                           revision=created['draft']['revision'], contentHash=created['draft']['content_hash'],
                           fileCount=package['file_count'], totalBytes=package['total_bytes'])
            self.skill_imports.record(binding, dict(
                resource_id=created['id'], slug=created['slug'], revision=created['draft']['revision'],
                content_hash=created['draft']['content_hash'], version=0, origin=kind,
                file_count=package['file_count'], total_bytes=package['total_bytes'], status='imported'))
            return outcome
        except (SkillImportError, ChatError) as exc:
            # The failure is recorded with its real fixed category so the
            # display never impersonates an imported draft.
            category = str(exc)
            if isinstance(exc, ChatError) and not category.startswith('CHAT_'):
                category = 'SKILL_IMPORT_FAILED'
            try:
                self.skill_imports.record(binding, dict(status='failed', error_code=category, origin=kind))
            except SkillImportError:
                pass
            raise SkillImportError(category) from exc

    def publish_skill(self, resource_id, expected_draft_revision):
        """Publish one confirmed imported Skill draft through the platform flow (#120).

        The platform owns validation and versioning: the call reuses the
        canonical publish endpoint, so success yields the next immutable
        version copy (with its content hash). A Run in progress keeps its
        frozen version, and no local edit can impersonate the published one.
        """
        from .receipt_ledger import profile_binding
        from .settings import load_settings
        from .skill_import import SkillImportError
        if self.skill_imports is None:
            raise ChatError('CHAT_COMMAND_INVALID')
        resource_id = self._uuid(resource_id)
        if type(expected_draft_revision) is not int or not 1 <= expected_draft_revision <= 1000000:
            raise ChatError('CHAT_COMMAND_INVALID')
        binding = profile_binding(load_settings(self.config))
        try:
            version = self._json(self._session(), f'/api/resources/{resource_id}/publish',
                                 {'expected_draft_revision': expected_draft_revision,
                                  'scan_result': {'status': 'desktop_confirmed_import'}})
            if not isinstance(version, dict) or type(version.get('version')) is not int or version['version'] < 1 \
                    or not isinstance(version.get('content_hash'), str) or len(version['content_hash']) != 64:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            self.skill_imports.mark_published(binding, resource_id, expected_draft_revision,
                                              version['version'], version['content_hash'])
            return dict(resourceId=resource_id, version=version['version'], contentHash=version['content_hash'])
        except ChatError as exc:
            # The failure is recorded with its real fixed category so the
            # display never impersonates a published version copy.
            category = str(exc) if str(exc).startswith('CHAT_') else 'SKILL_PUBLISH_FAILED'
            try:
                self.skill_imports.record(binding, dict(resource_id=resource_id, status='failed',
                                                        error_code=category))
            except SkillImportError:
                pass
            raise ChatError(category) from exc

    # --- Server-side trigger preferences (issue 121) ------------------------

    def _preference_projection(self, listing):
        """Project the Server's own preference list into the Desktop display shape (#121).

        Every field is validated and bounded; anything the Server did not state
        is dropped rather than invented. The rows carry identity and the
        caller's own preference fields — never Skill content — and matching
        happens only Server-side at Run preparation.
        """
        if not isinstance(listing, dict) or not isinstance(listing.get('items'), list):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        rows = []
        for item in listing['items'][:200]:
            if not isinstance(item, dict) or not isinstance(item.get('skill'), dict):
                continue
            skill = item['skill']
            keywords = item.get('keywords')
            agent_ids = item.get('applicable_agent_ids')
            row = dict(skillId=_bounded_text(item.get('skill_resource_id'), 64),
                       slug=_bounded_text(skill.get('slug'), 255),
                       displayName=_bounded_text(skill.get('display_name'), 255),
                       latestVersion=skill['latest_version'] if type(skill.get('latest_version')) is int else 0,
                       available=skill.get('available') is True,
                       enabled=item.get('enabled') is True,
                       keywords=[_bounded_text(keyword, 64) for keyword in keywords[:16]] if isinstance(keywords, list) else [],
                       alwaysInject=item.get('always_inject') is True,
                       applicableAgentIds=[_bounded_text(agent_id, 64) for agent_id in agent_ids[:32]] if isinstance(agent_ids, list) else [],
                       priority=item['priority'] if type(item.get('priority')) is int else 0)
            if row['skillId']:
                rows.append(row)
        return rows

    def skill_preferences(self, command):
        """Relay one trigger-preference command to the Server endpoints (#121).

        The Desktop never matches keywords and never drives a model: the
        preference document goes to the Server's own endpoints, and the reply
        is the Server's bounded projection. Authority (visibility, published
        availability, dependency closure) is the Server's decision at Run
        preparation, re-validated on every match.
        """
        action = command.get('action')
        if action not in {'list', 'set', 'clear'}:
            raise ChatError('CHAT_COMMAND_INVALID')
        session = self._session()
        if action == 'list':
            return dict(skills=self._preference_projection(
                self._json(session, '/api/resources/skill-trigger-preferences')))
        skill_id = self._uuid(command.get('skillId'))
        if action == 'set':
            keywords = command.get('keywords')
            agent_ids = command.get('applicableAgentIds')
            priority = command.get('priority')
            if not isinstance(keywords, list) or not isinstance(agent_ids, list) \
                    or type(priority) is not int or isinstance(priority, bool) \
                    or not -1000 <= priority <= 1000:
                raise ChatError('CHAT_COMMAND_INVALID')
            payload = dict(enabled=command.get('enabled') is True,
                           keywords=[str(keyword).strip() for keyword in keywords][:16],
                           always_inject=command.get('alwaysInject') is True,
                           applicable_agent_ids=[self._uuid(agent_id) for agent_id in agent_ids][:32],
                           priority=priority)
            self._empty(session, f'/api/resources/{skill_id}/trigger-preference', payload, 'PUT')
        else:
            self._empty(session, f'/api/resources/{skill_id}/trigger-preference', None, 'DELETE')
        return dict(skills=self._preference_projection(
            self._json(session, '/api/resources/skill-trigger-preferences')))

    # --- Model settings surface (issue 73) ----------------------------------

    def _model_rows(self, session):
        """The Server's own authorized model list, bounded for display.

        The Server already filters the list by the account's permissions, so
        the Desktop projects exactly what was granted — names and display
        facts only. No provider, endpoint or key field exists in the reply.
        """
        listing = self._json(session, '/api/models')
        raw = listing.get('models') if isinstance(listing, dict) else None
        if not isinstance(raw, list):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        rows = []
        for row in raw[:50]:
            if not isinstance(row, dict) or not isinstance(row.get('name'), str) \
                    or not row['name'] or len(row['name']) > 200:
                continue
            rows.append(dict(name=row['name'],
                             displayName=_bounded_text(row.get('display_name'), 200),
                             description=_bounded_text(row.get('description'), 500),
                             supportsThinking=row.get('supports_thinking') is True))
        return rows

    def _models(self, session, max_age=60.0):
        """The cached authorized list, refreshed past ``max_age`` seconds.

        Raises on fetch failure so explicit callers (the settings view) can
        surface it; the submission path catches and falls back to the last
        cache rather than blocking a send on a list read.
        """
        cached = self._models_cache
        if cached is not None and time.monotonic() - cached['at'] <= max_age:
            return cached
        entry = dict(at=time.monotonic(), rows=self._model_rows(session))
        self._models_cache = entry
        return entry

    def _account_default(self, session, max_age=60.0):
        """The account-level default model, the same setting the Web writes.

        Read from the Server's own preferences endpoint with the owner fence
        header; an unset or malformed value reads as "no default" and the
        platform default applies.
        """
        cached = self._account_default_cache
        if cached is not None and time.monotonic() - cached['at'] <= max_age:
            return cached['name']
        prefs = self._json(session, '/api/v1/auth/preferences',
                           headers={'X-Expected-User-Id': session.user_id})
        if not isinstance(prefs, dict):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        name = prefs.get('model_name')
        name = _bounded_text(name, 200) if isinstance(name, str) else ''
        self._account_default_cache = dict(at=time.monotonic(), name=name)
        return name

    def _fallback_name(self):
        name = load_settings(self.config).model_fallback_name
        return name if isinstance(name, str) and 0 < len(name) <= 200 else ''

    def _require_listed(self, session, name):
        """A selection must come from the authorized list the Server granted.

        A failed list read propagates its real category — an outage during a
        selection must not masquerade as an invalid command.
        """
        rows = self._models(session, 0.0)['rows']
        if name not in {row['name'] for row in rows}:
            raise ChatError('CHAT_COMMAND_INVALID')

    def _cached_model_rows(self, session, max_age=60.0):
        """The bounded authorized rows, or the last cache on a failed read."""
        try:
            return self._models(session, max_age)['rows']
        except ChatError:
            cached = self._models_cache
            return cached['rows'] if cached else []

    def _cached_account_default(self, session, max_age=60.0):
        """The account default, or the last cache on a failed read."""
        try:
            return self._account_default(session, max_age)
        except ChatError:
            cached = self._account_default_cache
            return cached['name'] if cached else ''

    def _model_choice(self, session, *, list_max_age, default_max_age):
        """The open thread's model resolution facts (#73).

        Returns (rows, default, override): the bounded authorized rows, the
        account-level default, and the session's own temporary choice for the
        loaded thread. The resolution order is override, default, then no
        name — the platform default applies.
        """
        rows = self._cached_model_rows(session, list_max_age)
        default = self._cached_account_default(session, default_max_age)
        thread = self._state['thread']
        override = self._session_models.get(thread['id']) if thread else None
        return rows, default, override

    def _model_view(self, session):
        """The settings-page view: fresh authoritative facts only (#73)."""
        try:
            rows = self._models(session, 0.0)['rows']
            can_read, reason = True, ''
        except ChatError as exc:
            if exc.code != 'CHAT_FORBIDDEN':
                raise
            can_read, rows, reason = False, [], 'CHAT_MODEL_LIST_FORBIDDEN'
        stored = load_settings(self.config).model_fallback_name
        return dict(models=rows[:50], canRead=can_read, reason=reason,
                    accountDefault=self._account_default(session, 0.0),
                    fallback=stored if isinstance(stored, str) and len(stored) <= 200 else '')

    def models_manage(self, command):
        """Relay one model-settings command to the platform's own endpoints (#73).

        The account default rides ``/api/v1/auth/preferences`` — the exact
        setting the Web writes — and the 备用模型 pick is a device-local
        preference because the platform preference schema has no field for it.
        Neither command carries or returns any provider, Base URL or key; the
        Desktop never holds a model credential, and the list is the Server's
        own permission-filtered catalog.
        """
        action = command.get('action')
        if action not in {'list', 'set-default', 'set-fallback'}:
            raise ChatError('CHAT_COMMAND_INVALID')
        session = self._session()
        if action == 'set-fallback':
            name = command.get('modelName')
            if not isinstance(name, str) or len(name) > 200:
                raise ChatError('CHAT_COMMAND_INVALID')
            if name:
                self._require_listed(session, name)
            settings = load_settings(self.config)
            settings.model_fallback_name = name
            settings.save(self.config)
            return self._model_view(session)
        if action == 'set-default':
            name = command.get('modelName')
            if not isinstance(name, str) or len(name) > 200:
                raise ChatError('CHAT_COMMAND_INVALID')
            if name:
                self._require_listed(session, name)
                payload = {'model_name': name}
            else:
                payload = {'model_name': None}
            try:
                self._empty(session, '/api/v1/auth/preferences', payload, 'PATCH',
                            headers={'X-Expected-User-Id': session.user_id})
            except ChatError as exc:
                # The preferences owner fence signals an account change with
                # 409; the Desktop names it the same way chat identity does.
                if exc.code == 'CHAT_CONFLICT':
                    raise ChatError('CHAT_IDENTITY_CHANGED') from None
                raise
            self._account_default_cache = dict(at=time.monotonic(), name=name)
            return self._model_view(session)
        return self._model_view(session)

    def _chat_model_view(self, session, *, fresh=False):
        """Read the #73 chat model display facts from the Server. The caller
        commits them, so a background load can land them in its one atomic
        state commit instead of through a separate beat."""
        max_age = 0.0 if fresh else 60.0
        rows, default, override = self._model_choice(session, list_max_age=max_age, default_max_age=max_age)
        names = {row['name'] for row in rows}
        name = override or default
        source = 'session-override' if override else ('account-default' if default else 'platform-default')
        available = (not name) or (not rows) or name in names
        return dict(options=rows[:50], name=name, source=source, available=available,
                    reason='' if available else 'CHAT_MODEL_UNAVAILABLE')

    def _refresh_chat_model(self, session, *, fresh=False):
        """Recompute the chat model display from Server facts (#73).

        Display only: this never switches a model and never raises for an
        unavailable choice — the submission path owns those decisions. A
        previous switch notice stays visible until the thread changes or the
        user picks a different model.
        """
        view = self._chat_model_view(session, fresh=fresh)
        self._state['modelOptions'] = view['options']
        self._state['model'].update(name=view['name'], source=view['source'],
                                    available=view['available'], reason=view['reason'])

    def _resolve_send_model(self, session, thread):
        """Resolve and preflight the model for one submission (#73).

        Resolution order: the session's temporary choice, then the account
        default the platform stores for Web and Desktop alike, then no name —
        the platform default applies. The default is read authoritatively per
        submission, so a change made on the Web reaches the next new session
        without waiting on any cache. A choice that left the authorized list
        is never silently replaced: without a usable fallback the submission
        stops with an explicit category before anything is sent, and with one
        the switch becomes the session's displayed model.
        """
        rows, default, override = self._model_choice(session, list_max_age=60.0, default_max_age=0.0)
        names = {row['name'] for row in rows}
        name = override or default
        source = 'session-override' if override else ('account-default' if default else 'platform-default')
        state = self._state['model']
        if not name:
            state.update(name='', source='platform-default', available=True, reason='')
            return dict(name='', source='platform-default', switched_from='', notice='')
        if rows and name not in names:
            fallback = self._fallback_name()
            if fallback and fallback != name and fallback in names:
                notice = f'主模型 {name} 已不在授权列表，已按备用设置切换到 {fallback}。'
                self._session_models[thread['id']] = fallback
                state.update(name=fallback, source='session-override', available=True,
                             reason='', notice=notice, switchedFrom=name)
                return dict(name=fallback, source='session-override', switched_from=name, notice=notice)
            state.update(name=name, source=source, available=False, reason='CHAT_MODEL_UNAVAILABLE',
                         notice=f'模型 {name} 已不可用（不在授权列表），请更换模型后再发送。')
            raise ChatError('CHAT_MODEL_UNAVAILABLE')
        state.update(name=name, source=source, available=True, reason='')
        return dict(name=name, source=source, switched_from='', notice='')

    @staticmethod
    def _model_denial(exc):
        """True when a submission failure names the model, not the caller."""
        return exc.code in {'CHAT_FORBIDDEN', 'CHAT_SERVER_ERROR'} and (
            'Model access denied' in exc.detail or
            'is not in the configured model allowlist' in exc.detail)

    def _fallback_retry_pick(self, session, thread, pick, exc):
        """One bounded fallback switch after a model-attributable denial (#73).

        Returns the switched pick, or None when no switch is honest: the
        failure does not name the model, no fallback is configured, the
        fallback equals the denied model, or the fallback left the
        authorized list.
        """
        if not self._model_denial(exc):
            return None
        rows = self._cached_model_rows(session)
        names = {row['name'] for row in rows}
        fallback = self._fallback_name()
        if not fallback or fallback == pick['name'] or (rows and fallback not in names):
            self._state['model'].update(
                available=False, reason='CHAT_MODEL_UNAVAILABLE',
                notice=f'主模型调用失败，且备用模型不可用（{(fallback or "未设置")}），请更换模型后再发送。')
            return None
        notice = f'主模型 {pick["name"] or "平台默认模型"} 调用失败，已按备用设置切换到 {fallback} 重试。'
        self._session_models[thread['id']] = fallback
        return dict(name=fallback, source='session-override', switched_from=pick['name'], notice=notice)

    def _apply_send_model(self, pick):
        """Record the submitted model; a switch stays displayed for the session."""
        state = self._state['model']
        state.update(name=pick['name'], source=pick['source'], available=True, reason='')
        if pick['notice']:
            state.update(notice=pick['notice'], switchedFrom=pick['switched_from'])
    # --- Session sidebar management (issue 72) ------------------------------

    def _thread_permissions(self, session):
        """The account's own Thread capabilities, as the Server states them.

        The sidebar grays out and explains every operation this account cannot
        perform; the Server re-checks and stays authoritative on every write.
        """
        account = self._json(session, '/api/v1/auth/me')
        if account.get('id') != session.user_id:
            raise ChatError('CHAT_IDENTITY_CHANGED')
        permissions = account.get('permissions') or []
        return dict(canRename='threads:write' in permissions, canDelete='threads:delete' in permissions)

    def _thread_rows(self, session, limit=200):
        """One bounded platform search page, projected and recency-sorted.

        Rows carry identity facts only; the Server's own updated_at drives the
        ordering and no thread roster is ever stored on this device. Search
        fetches the platform's full single-page ceiling so a session beyond
        the newest 200 still answers a query; the reply stays bounded.
        """
        rows = self._json(session, '/api/threads/search', {'limit': limit})
        if not isinstance(rows, list):
            raise ChatError('CHAT_PROTOCOL_ERROR')
        threads = []
        for row in rows[:200]:
            if not isinstance(row, dict) or not isinstance(row.get('thread_id'), str) or not row['thread_id']:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            values = row.get('values') if isinstance(row.get('values'), dict) else {}
            metadata = row.get('metadata') if isinstance(row.get('metadata'), dict) else {}
            title = _bounded_text(values.get('title') or metadata.get('title'), 256) or row['thread_id']
            threads.append(dict(id=row['thread_id'], title=title,
                                status=_bounded_text(row.get('status', 'idle'), 32) or 'idle',
                                updatedAt=_bounded_text(row.get('updated_at', ''), 64)))
        threads.sort(key=lambda row: row['updatedAt'], reverse=True)
        return threads

    def threads_manage(self, command):
        """One session-sidebar round-trip against the Server's Thread API (#72).

        list/search/rename/delete share one wire shape: every reply carries the
        account's thread permissions plus the platform's own post-action list,
        so the sidebar re-reads authoritative state in the same round. A rename
        rides the state endpoint whose values.title the Server syncs into the
        thread display name; a delete demands the Server's own success flag and
        never touches this device's receipt ledger — unconfirmed local receipts
        stay queryable after the platform thread is gone.
        """
        with self._lock:
            session = self._session()
            if not isinstance(command, dict) or command.get('scope') != session.scope:
                raise ChatError('CHAT_IDENTITY_CHANGED')
            action = command.get('action')
            if action == 'list':
                expected = {'type', 'id', 'action', 'scope'}
            elif action == 'search':
                query = command.get('query')
                if not isinstance(query, str) or len(query) > 128:
                    raise ChatError('CHAT_COMMAND_INVALID')
                expected = {'type', 'id', 'action', 'scope', 'query'}
            elif action in {'rename', 'delete'}:
                self._id(command.get('threadId'))
                expected = {'type', 'id', 'action', 'scope', 'threadId'}
                if action == 'rename':
                    title = command.get('title')
                    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200:
                        raise ChatError('CHAT_COMMAND_INVALID')
                    expected = expected | {'title'}
            else:
                raise ChatError('CHAT_COMMAND_INVALID')
            if set(command) != expected:
                raise ChatError('CHAT_COMMAND_INVALID')
            permissions = self._thread_permissions(session)
            if action == 'rename':
                if not permissions['canRename']:
                    raise ChatError('CHAT_FORBIDDEN')
                self._json(session, f"/api/threads/{self._id(command['threadId'])}/state",
                           {'values': {'title': command['title'].strip()}})
            elif action == 'delete':
                if not permissions['canDelete']:
                    raise ChatError('CHAT_FORBIDDEN')
                outcome = self._json(session, f"/api/threads/{self._id(command['threadId'])}", method='DELETE')
                if not isinstance(outcome, dict) or outcome.get('success') is not True:
                    raise ChatError('CHAT_PROTOCOL_ERROR')
            threads = self._thread_rows(session, limit=1000 if action == 'search' else 200)
            if action == 'search':
                query = command['query'].strip().lower()
                if query:
                    threads = [row for row in threads if query in row['title'].lower() or query in row['id'].lower()]
            result = dict(threads=threads, permissions=permissions)
            if action == 'rename':
                result['renamed'] = True
            elif action == 'delete':
                result['deleted'] = True
            return result

    # --- Canonical connector identities (issue 123) -------------------------

    def register_connector_identity(self, slug, display_name, version, manifest_hash):
        """Register one installed connector's platform-canonical identity (#123).

        The call carries identity fields only — slug, display name, declared
        version and the frozen manifest hash. The runnable binding (command,
        entry, environment, credentials) has no field in this request and
        never leaves this device; the Server owns the owner-scoped identity
        row and nothing else. A 409 (the same version already bound to
        different content) surfaces as CHAT_CONFLICT so the device can show
        its own actionable category.
        """
        if not isinstance(slug, str) or not 1 <= len(slug) <= 64 \
                or not isinstance(display_name, str) or not 1 <= len(display_name) <= 200 \
                or not isinstance(version, str) or not 1 <= len(version) <= 32 \
                or not isinstance(manifest_hash, str) or len(manifest_hash) != 64:
            raise ChatError('CHAT_COMMAND_INVALID')
        session = self._session()
        return self._json(session, '/api/connectors', dict(
            slug=slug, display_name=display_name, version=version, manifest_hash=manifest_hash))

    def unregister_connector_identity(self, connector_id):
        """Remove the platform identity after a confirmed local removal (#123).

        An already-absent identity is a successful no-op: the authoritative
        state — the device no longer has the component — is what matters.
        """
        connector_id = self._uuid(connector_id)
        session = self._session()
        try:
            self._empty(session, f'/api/connectors/{connector_id}', None, 'DELETE')
        except ChatError as exc:
            if exc.code != 'CHAT_NOT_FOUND':
                raise
        return dict(unregistered=True)

    # --- Explicit server-side publication (issue 115) -----------------------

    def publish_local_revision(self, kb_id, revision_id, paths, *, confirmed, publish_polls=20):
        """Publish one frozen local revision to an independent server copy.

        The preview step reads the platform's read-only destination preview
        and uploads nothing; only ``confirmed=True`` sends the exact registered
        content through the platform's own document upload endpoint and asks
        the platform to verify, freeze, and build the copy. The device KB is
        never re-scoped and nothing syncs automatically in either direction.
        """
        from .knowledge_import import (MAX_IMPORT_DOCUMENTS, MAX_IMPORT_FILE_BYTES, KnowledgeImportError,
                                       build_manifest, category_for, logical_paths_for)
        from .files import FileAccessError
        from .knowledge_publish import (PUBLISH_CONFIRMATION_REQUIRED, PUBLISH_CONTENT_DRIFTED,
                                        KnowledgePublishError, verify_against_registration)
        from .receipt_ledger import profile_binding
        from .settings import load_settings
        if self.knowledge_imports is None or self.knowledge_files is None or self.knowledge_publications is None:
            raise ChatError('CHAT_COMMAND_INVALID')
        session = self._session()
        kb_id = self._uuid(kb_id)
        if not isinstance(revision_id, str) or not revision_id.strip() or len(revision_id) > 64:
            raise ChatError('CHAT_COMMAND_INVALID')
        revision_id = revision_id.strip()
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_IMPORT_DOCUMENTS \
                or any(not isinstance(path, str) or not path or len(path) > 32768 for path in paths):
            raise ChatError('CHAT_COMMAND_INVALID')
        binding = profile_binding(load_settings(self.config))
        copy_resource_id, copy_slug = '', ''
        try:
            try:
                settings, grant, files = self.knowledge_files()
            except (FileAccessError, KnowledgeImportError) as exc:
                raise KnowledgeImportError(category_for(exc)) from exc
            registered = self.knowledge_imports.find_registration_by_revision(binding, kb_id, revision_id)
            if registered is None:
                # Only a revision this identity registered on this device can
                # ever be published from it.
                raise KnowledgeImportError('KNOWLEDGE_PUBLISH_REVISION_UNKNOWN')
            logical_paths = logical_paths_for(grant, list(paths))
            entries = build_manifest(files, logical_paths)
            # Refuse drifted or extra content before a single byte leaves the device.
            verify_against_registration(entries, registered)
            base = f'/api/resources/{kb_id}/knowledge-revisions/{revision_id}/local-publication'
            if not confirmed:
                # Read-only destination preview: no upload, no copy, no state.
                preview = self._json(session, f'{base}/preview')
                if not isinstance(preview, dict) or not isinstance(preview.get('source'), dict) \
                        or not isinstance(preview.get('documents'), list) or not isinstance(preview.get('destination'), dict):
                    raise ChatError('CHAT_PROTOCOL_ERROR')
                # Issue 42: the Server names the destination `display_name`
                # while the Desktop wire contract is `displayName`. Normalize
                # at this seam and fail closed when the preview omits it, so
                # a real preview reaches the confirmation dialog instead of
                # being refused before it opens.
                destination = dict(preview['destination'])
                display_name = destination.pop('display_name', None)
                if not isinstance(display_name, str) or not display_name.strip() or 'displayName' in destination:
                    raise ChatError('CHAT_PROTOCOL_ERROR')
                destination['displayName'] = display_name
                return dict(confirmed=False, kbId=kb_id, revisionId=revision_id,
                            source=preview['source'], destination=destination,
                            documents=[dict(filename=entry['filename'], sha256=entry['sha256'],
                                            bytes=entry['bytes'], mime=entry['mime']) for entry in entries])
            confirmed_payload = self._json(session, base, {'confirmed': True})
            copy = confirmed_payload.get('copy') if isinstance(confirmed_payload, dict) else None
            if not isinstance(copy, dict) or not isinstance(copy.get('resource_id'), str) or not copy['resource_id']:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            copy_resource_id, copy_slug = copy['resource_id'], str(copy.get('slug', ''))[:255]
            for logical_path, entry in zip(logical_paths, entries):
                content = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES)
                if hashlib.sha256(content).hexdigest() != entry['sha256']:
                    raise KnowledgePublishError(PUBLISH_CONTENT_DRIFTED)
                self._upload_document(session, copy_resource_id, entry['filename'], entry['mime'], content)
            outcome = self._json(session, f'{base}/complete', {})
            if not isinstance(outcome, dict) or outcome.get('status') not in {'publishing', 'published'}:
                raise ChatError('CHAT_PROTOCOL_ERROR')
            status = outcome
            for _ in range(max(1, int(publish_polls))):
                if status.get('status') in {'published', 'failed'}:
                    break
                time.sleep(0.5)
                status = self._json(session, base)
            revision = status.get('revision') if isinstance(status.get('revision'), dict) else {}
            record_status = 'published' if status.get('status') == 'published' else 'failed'
            self.knowledge_publications.record(binding, dict(
                kb_id=kb_id, revision_id=revision_id, copy_resource_id=copy_resource_id, copy_slug=copy_slug,
                copy_revision_id=str(revision.get('id', ''))[:128], status=record_status,
                error_code='' if record_status == 'published' else str(revision.get('failure_code') or 'KNOWLEDGE_PUBLISH_FAILED'),
                document_count=len(entries)))
            return dict(confirmed=True, kbId=kb_id, revisionId=revision_id,
                        copyResourceId=copy_resource_id, copySlug=copy_slug,
                        copyRevisionId=str(revision.get('id', '')), status=str(status.get('status')),
                        failureCode=str(revision.get('failure_code') or ''), documentCount=len(entries))
        except (KnowledgeImportError, KnowledgePublishError, ChatError) as exc:
            # The failure is recorded with its real fixed category so the
            # display never impersonates a published copy.
            category = str(exc)
            if isinstance(exc, ChatError):
                detail = getattr(exc, 'detail', '') or ''
                category = next((code for code in (PUBLISH_CONFIRMATION_REQUIRED, PUBLISH_CONTENT_DRIFTED) if code in detail), category)
            try:
                self.knowledge_publications.record(binding, dict(
                    kb_id=kb_id, revision_id=revision_id, copy_resource_id=copy_resource_id,
                    copy_slug=copy_slug, status='failed', error_code=category, document_count=0))
            except KnowledgePublishError:
                pass
            raise KnowledgePublishError(category) from exc

    def _upload_document(self, session, resource_id, filename, mime_type, content):
        """Upload one document through the platform's own multipart endpoint."""
        boundary = '----ideer115' + secrets.token_hex(16)
        safe_filename = filename.replace('\\', '%5C').replace('"', '\\"')
        part = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{safe_filename}"\r\n'
                f'Content-Type: {mime_type}\r\n\r\n').encode() + content + f'\r\n--{boundary}--\r\n'.encode()
        with self._request(session, f'/api/resources/{resource_id}/documents', part,
                           {'Content-Type': f'multipart/form-data; boundary={boundary}'}) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ChatError('CHAT_RESPONSE_TOO_LARGE')
        try:
            document = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ChatError('CHAT_PROTOCOL_ERROR') from None
        if not isinstance(document, dict) or not isinstance(document.get('id'), str) \
                or document.get('content_hash') != hashlib.sha256(content).hexdigest():
            raise ChatError('CHAT_PROTOCOL_ERROR')
        return document

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
            attachment_statuses = None
            view = None
            try:
                session = self._session()
                if session.scope != self._state['scope']:
                    self._reset(session.scope)
                action = command.get('action') if isinstance(command, dict) else None
                if action not in {'state', 'refresh', 'compatibility'} and command.get('scope') != session.scope:
                    raise ChatError('CHAT_IDENTITY_CHANGED')
                # Issue 80: an observed outage pauses new work by name — this
                # named category is the visible reason, checked before any
                # Server round-trip. Observation and recovery actions stay
                # available and fail honestly while the platform is away.
                if action in {'create', 'send', 'answer', 'branch'} and self._platform_ok is False:
                    raise ChatError('CHAT_PLATFORM_UNREACHABLE')
                # Issue 93: a local attachment view is a device read — it must
                # keep working while the platform is away, like the other
                # observation surfaces.
                can_run = self._authorize(session) if action not in {'state', 'consent', 'stop', 'attachment-view'} else False
                if action in {'create', 'send', 'answer'} and not can_run:
                    raise ChatError('CHAT_FORBIDDEN')
                if action == 'refresh':
                    resources = self._resources(session, can_run)
                    threads = self._json(session, '/api/threads/search', {'limit': 100})
                    self._state.update(resources=resources, threads=[dict(id=t['thread_id'],
                        title=t.get('values', {}).get('title') or t.get('metadata', {}).get('title') or t['thread_id'],
                        status=t['status']) for t in threads], error='')
                    self._refresh_chat_model(session, fresh=True)
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
                    attachment_statuses = self._send(session, command)
                elif action == 'set-model':
                    # Issue 73: the session's temporary model choice. It lives
                    # in chat state (never persisted, never synced), is bound
                    # to the open thread, and clearing returns to the account
                    # default resolution chain.
                    if set(command) != {'action', 'scope', 'threadId', 'modelName'}:
                        raise ChatError('CHAT_COMMAND_INVALID')
                    name = command.get('modelName')
                    if not isinstance(name, str) or len(name) > 200:
                        raise ChatError('CHAT_COMMAND_INVALID')
                    thread = self._state['thread']
                    if not thread or command.get('threadId') != thread['id']:
                        raise ChatError('CHAT_THREAD_CHANGED')
                    if name:
                        self._session_models[thread['id']] = name
                    else:
                        self._session_models.pop(thread['id'], None)
                    self._state['model'].update(notice='', switchedFrom='')
                    self._refresh_chat_model(session)
                elif action == 'stop':
                    self._stop(session, command)
                elif action == 'reconnect':
                    if not self._state['thread'] or command.get('threadId') != self._state['thread']['id']:
                        raise ChatError('CHAT_THREAD_CHANGED')
                    self._load_thread(session, self._state['thread']['id'])
                elif action == 'branch':
                    # Issue 78: 消息级分支。The renderer names the target turn
                    # only; the Server creates the branch from its own
                    # checkpoint and this session re-opens onto the platform's
                    # new Thread. No title rides the wire — the Server's own
                    # default naming applies.
                    expected = {'action', 'scope', 'threadId', 'messageId'}
                    if command.get('messageIds') is not None:
                        expected = expected | {'messageIds'}
                    message_id, message_ids = command.get('messageId'), command.get('messageIds')
                    if (set(command) != expected or not isinstance(message_id, str)
                            or message_ids is not None and (not isinstance(message_ids, list)
                                or not 1 <= len(message_ids) <= MAX_BRANCH_TURN_MESSAGES
                                or any(not isinstance(item, str) or not item for item in message_ids)
                                or len(set(message_ids)) != len(message_ids))):
                        raise ChatError('CHAT_COMMAND_INVALID')
                    self._branch(session, command.get('threadId'), self._id(message_id),
                                 [self._id(item) for item in message_ids] if message_ids is not None else None)
                elif action == 'consent':
                    expected = {'action', 'scope', 'threadId', 'runId', 'taskId', 'requestHash', 'decision'}
                    # Issue 39: a script approval may ask the device to remember
                    # the exact content/scope grant (#122 AC2); the flag is
                    # refused for every other kind, and the coordinator never
                    # turns a script "remember" into a capability-wide bypass.
                    remember_script = command.get('rememberScript') is True
                    if remember_script:
                        expected = expected | {'rememberScript'}
                    if set(command) != expected or command.get('decision') not in {'allow', 'allow-directory', 'deny'} or self.decide_consent is None:
                        raise ChatError('CHAT_COMMAND_INVALID')
                    pending = next((row for row in self._consents(session) if all(command.get(key) == row[key] for key in ('threadId', 'runId', 'taskId', 'requestHash'))), None)
                    if pending is None:
                        raise ChatError('CONSENT_MISMATCH')
                    if remember_script and (pending.get('kind') != 'skill-script' or command['decision'] != 'allow'):
                        raise ChatError('CHAT_COMMAND_INVALID')
                    try:
                        if command['decision'] == 'allow-directory':
                            self.decide_consent(command['taskId'], command['requestHash'], True, directory=True)
                        else:
                            self.decide_consent(command['taskId'], command['requestHash'], command['decision'] == 'allow',
                                                always=remember_script)
                    except Exception:
                        raise ChatError('CONSENT_UNAVAILABLE') from None
                    self._state['error'] = ''
                elif action == 'tier':
                    # Issue 74: the session's own permission tier. The lowest
                    # tier is the default for every loaded session; the full
                    # tier needs the explicit confirm flag the Desktop main
                    # process signs after its own confirmation dialog. The
                    # tier only ever narrows the device consent flow — the
                    # local policy veto and the platform capability set stay
                    # ahead of it.
                    expected = {'action', 'scope', 'threadId', 'tier'}
                    if command.get('confirm') is True:
                        expected = expected | {'confirm'}
                    tier_value = command.get('tier')
                    if (set(command) != expected
                            or tier_value not in {member.value for member in SessionTier}
                            or (command.get('confirm') is True and tier_value != SessionTier.FULL.value)
                            or (tier_value == SessionTier.FULL.value and command.get('confirm') is not True)
                            or self.session_tiers is None):
                        raise ChatError('CHAT_COMMAND_INVALID')
                    if not self._state['thread'] or command.get('threadId') != self._state['thread']['id']:
                        raise ChatError('CHAT_THREAD_CHANGED')
                    self.session_tiers.set(str(self._state['thread']['id']), SessionTier(tier_value))
                    self._state['localTier'] = tier_value
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
                elif action == 'attachment-view':
                    view = self._attachment_view(session, command)
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
                if action == 'state':
                    self.reconcile()
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
            # Issue 80: the display reads the last observed contact outcome,
            # never a guess; unknown starts optimistic and a failure pauses
            # new Turns until the platform answers again.
            result['platform'] = dict(reachable=self._platform_ok is not False,
                                      detail=self._platform_detail)
            if self.compatibility_gate is not None:
                result['compatibility'] = self.compatibility_gate.snapshot()
            if download is not None and not result['error']:
                # Only the requesting main-process call receives bytes; no
                # polling snapshot or persisted history retains the payload.
                result['download'] = download
            if attachment_statuses and not result['error']:
                # Issue 93: the destination outcomes ride only the send's own
                # reply; the durable story stays in the message text itself.
                result['attachmentStatuses'] = attachment_statuses
            if view is not None and not result['error']:
                # Issue 93: the read-only display rides only the view's own
                # reply, transient like a download.
                result['attachmentView'] = view
            return result
