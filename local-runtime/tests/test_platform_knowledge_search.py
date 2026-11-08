"""The user's doc-library retrieval through the Desktop knowledge entry (#98).

Every test drives the real DesktopChat seam against a registered frozen
revision and a real confirmed workspace: the search rides the same engines
as the broker task, every document is re-validated content-addressed before
a line is answered, hits cite the frozen parse's page/table anchors, and
the view carries the library identity, the ``evidenceComplete`` fact, and
the binding summary (the retrieval credentials). A revision this identity
never registered is refused, and no request about it reaches the Server.
"""
from __future__ import annotations

import hashlib
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from core.audit import AuditKind, LocalAuditLog
from core.file_service import WorkspaceFileStore, WorkspaceSelection
from core.files import FileAccessError, RootConfig
from core.knowledge_import import KnowledgeImportRegistry
from core.knowledge_index import KnowledgeIndexStore
from core.platform_chat import ChatError, DesktopChat
from core.receipt_ledger import profile_binding
from core.secrets import InMemorySecretStore
from core.settings import RuntimeSettings, load_settings

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '88888888-8888-4888-8888-888888888888'
MANIFEST = hashlib.sha256(b'manifest-98').hexdigest()

REPORT = 'report header line\nalpha in table body\nalpha after the table\n'
GUIDE = 'the launch code is ALPHA-7\nsecond line\n'
REPORT_HASH = hashlib.sha256(REPORT.encode()).hexdigest()
GUIDE_HASH = hashlib.sha256(GUIDE.encode()).hexdigest()
REPORT_LAYOUT = [{'kind': 'page', 'page': 4, 'line': 1, 'lines': 3},
                 {'kind': 'table', 'table': 2, 'line': 2, 'lines': 1}]
DOCUMENTS = [
    {'filename': 'report.txt', 'sha256': REPORT_HASH, 'bytes': len(REPORT), 'mime': 'text/plain'},
    {'filename': 'guide.txt', 'sha256': GUIDE_HASH, 'bytes': len(GUIDE), 'mime': 'text/plain'}]


@contextmanager
def platform():
    """An idle protocol fixture: the library search must never need it."""
    records = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            records.append(('GET', self.path, None, dict(self.headers)))
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'{}')

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            self.rfile.read(length)
            records.append(('POST', self.path, None, dict(self.headers)))
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'{}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}', records
    finally:
        server.shutdown()
        server.server_close()


def prepare(tmp_path: Path, origin: str):
    """A DesktopChat with a confirmed workspace, mirroring desktop.py wiring."""
    secure = InMemorySecretStore()
    secure.set('business-A', 'business-A')
    config = tmp_path / 'profile' / 'settings.json'
    space = tmp_path / 'work'
    space.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(server_url=origin, user_id='A', device_id='D1',
        device_public_key='device-key-099', server_public_key='broker-key-099',
        session_token_ref='device-session-099',
        business_token_ref='business-A', business_expires_at='2099-01-01T00:00:00+00:00')
    settings.save(config)
    WorkspaceSelection(config).select(str(space), confirmed=True)
    imports = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    audit = LocalAuditLog()
    chat = DesktopChat(config, secure, lambda: {'state': 'authenticated'},
                       knowledge_imports=imports, knowledge_files=knowledge_files, audit=audit)
    binding = profile_binding(load_settings(config))
    return chat, imports, binding, space, config, audit


def document(filename: str, content: str, layout=None) -> dict:
    parse = {'status': 'parsed', 'parser': 'text-utf8', 'parserVersion': '1', 'errorCode': ''}
    if layout is not None:
        parse['layout'] = layout
    # `_text` is the import pipeline's transient field the indexer consumes;
    # the wire payload and the registry rows never carry it.
    return {'filename': filename, 'sha256': hashlib.sha256(content.encode()).hexdigest(),
            'bytes': len(content), 'mime': 'text/plain', 'parse': parse, '_text': content}


def _index_revision(config, binding, entries):
    index = KnowledgeIndexStore(config.with_name('knowledge-index.db'))
    index.index_revision(binding, REVISION, MANIFEST, entries)


def test_library_search_answers_without_the_server_with_citations(tmp_path) -> None:
    with platform() as (origin, records):
        chat, imports, binding, space, config, audit = prepare(tmp_path, origin)
        (space / 'report.txt').write_bytes(REPORT.encode('utf-8'))
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=2,
                                     manifest_hash=MANIFEST, document_count=2,
                                     status='registered', error_code='', documents=DOCUMENTS))
        _index_revision(config, binding, [document('report.txt', REPORT, REPORT_LAYOUT),
                                          document('guide.txt', GUIDE)])

        view = chat.knowledge_search(KB, REVISION, query='ALPHA', task_id='task-98')
        assert records == []
        assert view['kbId'] == KB and view['revisionId'] == REVISION and view['revisionNo'] == 2
        assert view['manifestHash'] == MANIFEST
        assert view['engine'] == 'bm25' and view['documentsMatched'] == 2 and view['documentsTotal'] == 2
        assert view['evidenceComplete'] is True and view['missing'] == [] and view['truncated'] is False
        report_hits = [chunk for chunk in view['chunks'] if chunk['filename'] == 'report.txt']
        by_line = {chunk['position']['line']: chunk['position'] for chunk in report_hits}
        assert by_line[2]['page'] == 4 and by_line[2]['table'] == 2
        assert by_line[3]['table'] is None
        assert all(chunk['contentHash'] == REPORT_HASH for chunk in report_hits)
        assert view['credentials'] == {'serverOrigin': origin, 'userId': 'A', 'deviceId': 'D1'}
        assert str(space) not in str(view)
        # The durable device record: one audit row written before the reply,
        # carrying the frozen identity, the evidence fact, and the credential
        # identity, the query only as its digest — and the view names it so a
        # citation is traceable.
        rows = audit.recent(kind=AuditKind.EXECUTION)
        assert len(rows) == 1
        row = rows[0]
        assert row.capability == 'local.knowledge.search' and row.task_id == 'task-98'
        assert row.digest == MANIFEST and row.detail['evidenceComplete'] is True
        assert row.detail['queryDigest'] == hashlib.sha256(b'ALPHA').hexdigest()
        assert row.detail['engine'] == 'bm25'
        assert row.actor_id == 'A'
        assert row.detail['serverOrigin'] == origin and row.detail['deviceId'] == 'D1'
        assert view['auditTaskId'] == 'task-98'
        assert 'ALPHA' not in json.dumps(row.as_dict())


def test_library_search_reports_incomplete_evidence(tmp_path) -> None:
    """A drifted document is structured missing with its filename — the
    answer says 依据不完整 and never substitutes current bytes."""
    with platform() as (origin, _records):
        chat, imports, binding, space, config, _audit = prepare(tmp_path, origin)
        (space / 'report.txt').write_bytes(REPORT.encode('utf-8'))
        (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
        imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=1,
                                     manifest_hash=MANIFEST, document_count=2,
                                     status='registered', error_code='', documents=DOCUMENTS))
        _index_revision(config, binding, [document('report.txt', REPORT, REPORT_LAYOUT),
                                          document('guide.txt', GUIDE)])
        (space / 'report.txt').write_bytes('report CHANGED\n'.encode('utf-8'))

        view = chat.knowledge_search(KB, REVISION, query='ALPHA')
        assert view['evidenceComplete'] is False
        assert view['missing'] == [{'filename': 'report.txt', 'reason': 'content_drift'}]
        assert all(chunk['filename'] != 'report.txt' for chunk in view['chunks'])
        assert 'CHANGED' not in str(view)


def test_library_search_names_an_unconfirmed_workspace_and_file_boundary_honestly(tmp_path) -> None:
    """An unconfirmed workspace is not a generic failure: the fixed category
    crosses the boundary so the UI can say exactly what is missing — and the
    error code is read off the exception (``str`` is the human message)."""
    with platform() as (origin, _records):
        chat, imports, binding, space, config, _audit = prepare(tmp_path, origin)

        def _unavailable():
            raise FileAccessError('WORKSPACE_UNAVAILABLE')

        chat.knowledge_files = _unavailable
        with pytest.raises(ChatError) as refused:
            chat.knowledge_search(KB, REVISION, query='ALPHA')
        assert str(refused.value) == 'KNOWLEDGE_SEARCH_WORKSPACE_UNAVAILABLE'

        def _outside():
            raise FileAccessError('PROTECTED_PATH')

        chat.knowledge_files = _outside
        with pytest.raises(ChatError) as unavailable:
            chat.knowledge_search(KB, REVISION, query='ALPHA')
        assert str(unavailable.value) == 'KNOWLEDGE_SEARCH_FILE_UNAVAILABLE'


def test_library_search_refuses_unregistered_revisions_and_bad_queries(tmp_path) -> None:
    with platform() as (origin, records):
        chat, imports, binding, space, config, _audit = prepare(tmp_path, origin)
        (space / 'report.txt').write_bytes(REPORT.encode('utf-8'))
        imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=1,
                                     manifest_hash=MANIFEST, document_count=1,
                                     status='registered', error_code='', documents=DOCUMENTS[:1]))
        foreign = '99999999-9999-4999-8999-999999999999'
        with pytest.raises(ChatError) as unknown:
            chat.knowledge_search(KB, foreign, query='ALPHA')
        assert str(unknown.value) == 'KNOWLEDGE_SEARCH_REVISION_UNREGISTERED'

        for bad_query in ('', 'a\nb', 'x' * 513):
            with pytest.raises(ChatError) as invalid:
                chat.knowledge_search(KB, REVISION, query=bad_query)
            assert str(invalid.value) == 'CHAT_COMMAND_INVALID'
        with pytest.raises(ChatError) as bad_kb:
            chat.knowledge_search('not-a-uuid', REVISION, query='ALPHA')
        assert str(bad_kb.value) == 'CHAT_COMMAND_INVALID'
        assert records == []


def test_library_search_fails_closed_when_the_audit_record_cannot_be_written(tmp_path) -> None:
    """A broken audit log never yields an untraceable citation: the answer
    fails with the fixed category instead of leaving the seam unrecorded."""
    with platform() as (origin, records):
        chat, imports, binding, space, config, _audit = prepare(tmp_path, origin)
        (space / 'report.txt').write_bytes(REPORT.encode('utf-8'))
        imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=1,
                                     manifest_hash=MANIFEST, document_count=1,
                                     status='registered', error_code='', documents=DOCUMENTS[:1]))

        class _BrokenAudit:
            def record(self, *args, **kwargs):
                raise RuntimeError('audit storage unavailable')

        chat.audit = _BrokenAudit()
        with pytest.raises(ChatError) as failed:
            chat.knowledge_search(KB, REVISION, query='ALPHA', task_id='task-98')
        assert str(failed.value) == 'KNOWLEDGE_SEARCH_FAILED'
        assert records == []


def test_library_search_names_no_audit_record_when_none_was_written(tmp_path) -> None:
    """Without a wired audit log the view honestly omits ``auditTaskId``
    instead of naming a record that does not exist."""
    with platform() as (origin, _records):
        chat, imports, binding, space, config, _audit = prepare(tmp_path, origin)
        (space / 'report.txt').write_bytes(REPORT.encode('utf-8'))
        imports.record(binding, dict(kb_id=KB, revision_id=REVISION, revision_no=1,
                                     manifest_hash=MANIFEST, document_count=1,
                                     status='registered', error_code='', documents=DOCUMENTS[:1]))

        chat.audit = None
        view = chat.knowledge_search(KB, REVISION, query='ALPHA')
        assert 'auditTaskId' not in view
        assert view['evidenceComplete'] is True
