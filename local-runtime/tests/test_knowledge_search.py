"""Frozen-revision local retrieval through the unique Runtime (#113).

Every test drives the real workspace boundary: the task payload carries the
frozen manifest identity only, each document must still hash to its frozen
digest at read time, drifted or missing files are reported as structured
missing entries instead of current content, and a revision this identity
never registered on this device is refused outright.

Since #98 every hit also cites the frozen parse's page/table anchors and
the result carries the library identity plus the ``evidenceComplete`` fact;
the user's doc-library search rides the same engines through
``search_registered_revision`` and projects a bounded camelCase view.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.server import serve

from core.file_service import WorkspaceFileService, WorkspaceFileStore, WorkspaceSelection
from core.files import RootConfig
from core.knowledge_import import KnowledgeImportRegistry
from core.knowledge_index import KnowledgeIndexStore
from core.knowledge_search import (
    KnowledgeSearchError,
    parse_search_payload,
    search_frozen_revision,
    search_registered_revision,
)
from core.protocol import public_key_text
from core.receipt_ledger import BINDING_FIELDS, ReceiptLedger, profile_binding
from core.receipts import content_hash
from core.settings import CapabilityRule, RuntimeSettings
from core.transport import LocalRuntimeClient
from server_protocol import MessageType as ServerMessageType, sign_envelope as server_sign

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '44444444-4444-4444-8444-444444444444'
GUIDE = 'the launch code is ALPHA-7\nsecond line\n'
NOTES = 'release notes mention ALPHA-7 twice\n'
MANIFEST = hashlib.sha256(json.dumps(
    sorted(['guide.txt', 'notes.txt'])).encode()).hexdigest()


def _document(name: str, content: str) -> dict:
    content_hash = hashlib.sha256(content.encode()).hexdigest()
    return {"document_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"local-import:{name}:{content_hash}")),
            "filename": name,
            "content_hash": content_hash}


def _payload(work: str, *, documents=None, query='ALPHA-7', manifest_hash=MANIFEST, revision_id=REVISION) -> dict:
    return {'query': query, 'revision_id': revision_id, 'manifest_hash': manifest_hash,
            'documents': documents if documents is not None else [
                _document('guide.txt', GUIDE), _document('notes.txt', NOTES)]}


# --- payload validation -------------------------------------------------------


def test_payload_validation_is_exact() -> None:
    parsed = parse_search_payload(_payload(''))
    assert parsed['revision_id'] == REVISION and len(parsed['documents']) == 2
    for broken, code in [
        ({**_payload(''), 'query': ''}, 'INVALID_QUERY'),
        ({**_payload(''), 'query': 'a\nb'}, 'INVALID_QUERY'),
        ({**_payload(''), 'query': 'x' * 513}, 'INVALID_QUERY'),
        ({**_payload(''), 'revision_id': 'not-a-uuid'}, 'INVALID_MANIFEST'),
        ({**_payload(''), 'manifest_hash': 'zz'}, 'INVALID_MANIFEST'),
        ({**_payload(''), 'documents': []}, 'INVALID_MANIFEST'),
        ({**_payload(''), 'documents': [dict(_document('a.txt', 'x')), dict(_document('a.txt', 'x'))]}, 'INVALID_MANIFEST'),
        ({**_payload(''), 'documents': [{'document_id': _document('a.txt', 'x')['document_id'], 'filename': '../escape', 'content_hash': 'a' * 64}]}, 'INVALID_MANIFEST'),
        (['not', 'a', 'dict'], 'INVALID_MANIFEST'),
    ]:
        with pytest.raises(KnowledgeSearchError) as error:
            parse_search_payload(broken)
        assert str(error.value) == code


# --- content-addressed revalidation -------------------------------------------


def _store(work_root):
    return WorkspaceFileStore([RootConfig('/workspace', work_root, resolve_root=False)])


def test_frozen_match_returns_chunk_with_logical_position(tmp_path) -> None:
    (tmp_path / 'docs').mkdir()
    (tmp_path / 'docs' / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (tmp_path / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    result = search_frozen_revision(_payload(''), files=_store(tmp_path), logical_root='/workspace')

    assert result['truncated'] is False
    assert result['documentsMatched'] == 2
    assert [chunk['position']['line'] for chunk in result['chunks']] == [1, 1]
    assert all(chunk['document_keyword'] in {'guide.txt', 'notes.txt'} for chunk in result['chunks'])
    assert all(chunk['content'].count('ALPHA-7') == 1 for chunk in result['chunks'])
    positions = {chunk['position']['logical_path'] for chunk in result['chunks']}
    assert positions == {'/workspace/docs/guide.txt', '/workspace/notes.txt'}
    assert str(tmp_path) not in json.dumps(result)


def test_drifted_file_is_missing_and_never_substituted(tmp_path) -> None:
    """A file whose bytes no longer match the frozen digest reports missing."""
    (tmp_path / 'guide.txt').write_text('the launch code is ALPHA-7 CHANGED\n', encoding='utf-8')
    (tmp_path / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    result = search_frozen_revision(_payload(''), files=_store(tmp_path), logical_root='/workspace')

    assert [chunk['document_id'] for chunk in result['chunks']] == [_document('notes.txt', NOTES)['document_id']]
    assert result['missing'] == [{'document_id': _document('guide.txt', GUIDE)['document_id'], 'reason': 'content_drift'}]
    assert 'CHANGED' not in json.dumps(result)
    assert result['documentsMatched'] == 1


def test_removed_file_reports_unavailable_and_binary_reports_not_searchable(tmp_path) -> None:
    (tmp_path / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    result = search_frozen_revision(_payload(''), files=_store(tmp_path), logical_root='/workspace')

    assert result['missing'] == [{'document_id': _document('notes.txt', NOTES)['document_id'], 'reason': 'file_unavailable'}]

    (tmp_path / 'notes.txt').write_bytes(b'\x00\x01\x02binary\x00')
    notes = _document('notes.txt', NOTES)
    notes = {'document_id': notes['document_id'], 'filename': 'notes.txt',
             'content_hash': hashlib.sha256(b'\x00\x01\x02binary\x00').hexdigest()}
    binary_payload = _payload('', documents=[_document('guide.txt', GUIDE), notes])
    result = search_frozen_revision(binary_payload, files=_store(tmp_path), logical_root='/workspace')

    assert [row['reason'] for row in result['missing']] == ['not_searchable']
    assert all(chunk['document_id'] != notes['document_id'] for chunk in result['chunks'])


def test_duplicate_names_still_find_the_frozen_bytes(tmp_path) -> None:
    """A drifted copy with the same name must not hide a frozen match."""
    (tmp_path / 'guide.txt').write_text('drifted\n', encoding='utf-8')
    (tmp_path / 'archive').mkdir()
    (tmp_path / 'archive' / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    result = search_frozen_revision(
        _payload('', documents=[_document('guide.txt', GUIDE)]), files=_store(tmp_path), logical_root='/workspace')

    assert result['missing'] == []
    assert len(result['chunks']) == 1
    assert result['chunks'][0]['position']['logical_path'] == '/workspace/archive/guide.txt'


# --- citation facts (#98) -------------------------------------------------------


REPORT = 'report header line\nalpha in table body\nalpha after the table\n'
REPORT_LAYOUT = [{'kind': 'page', 'page': 4, 'line': 1, 'lines': 3},
                 {'kind': 'table', 'table': 2, 'line': 2, 'lines': 1}]


def test_literal_scan_cites_frozen_parse_anchors_when_layout_known(tmp_path) -> None:
    (tmp_path / 'report.txt').write_bytes(REPORT.encode('utf-8'))
    layouts = {('report.txt', hashlib.sha256(REPORT.encode()).hexdigest()): REPORT_LAYOUT}
    result = search_frozen_revision(_payload('', documents=[_document('report.txt', REPORT)], query='alpha'),
                                    files=_store(tmp_path), logical_root='/workspace', layouts=layouts)

    positions = {chunk['position']['line']: chunk['position'] for chunk in result['chunks']}
    assert positions[2]['page'] == 4 and positions[2]['table'] == 2
    # A line outside every table span cites none; the page still resolves.
    assert positions[3]['table'] is None and positions[3]['page'] == 4


def test_literal_scan_without_layouts_never_guesses_anchors(tmp_path) -> None:
    """An unknown frozen parse layout cites nothing — never an invented page."""
    (tmp_path / 'report.txt').write_bytes(REPORT.encode('utf-8'))
    result = search_frozen_revision(_payload('', documents=[_document('report.txt', REPORT)], query='alpha'),
                                    files=_store(tmp_path), logical_root='/workspace')

    assert result['chunks']
    assert all(chunk['position']['page'] is None and chunk['position']['table'] is None
               for chunk in result['chunks'])
    assert all(chunk['position']['logical_path'].startswith('/workspace/') for chunk in result['chunks'])


def test_service_result_carries_library_identity_and_evidence(tmp_path) -> None:
    """The registered revision's identity rides the result (库/Revision), and
    evidenceComplete says whether every document contributed (#98)."""
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (work / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding)

    complete = service.execute('local.knowledge.search', {'arguments': _payload(root)}).value
    assert complete['library'] == {'kbId': KB, 'revisionId': REVISION, 'revisionNo': 1,
                                   'manifestHash': MANIFEST}
    assert complete['evidenceComplete'] is True
    assert complete['missing'] == [] and complete['truncated'] is False

    (work / 'notes.txt').write_text('release notes CHANGED\n', encoding='utf-8')
    partial = service.execute('local.knowledge.search', {'arguments': _payload(root)}).value
    assert partial['evidenceComplete'] is False
    assert partial['missing'] == [{'document_id': _document('notes.txt', NOTES)['document_id'],
                                   'reason': 'content_drift'}]
    assert partial['documentsMatched'] == 1
    assert 'CHANGED' not in json.dumps(partial)


# --- the user's library search (#98) --------------------------------------------


def _indexed_space(tmp_path: Path):
    """Work files, a registered revision, and a ready BM25 index with table
    anchors — the library search answers from the same engines."""
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'report.txt').write_bytes(REPORT.encode('utf-8'))
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    settings = _settings(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    binding = profile_binding(settings)
    assert binding is not None
    documents = [
        dict(filename='report.txt', sha256=hashlib.sha256(REPORT.encode()).hexdigest(),
             bytes=len(REPORT), mime='text/plain'),
        dict(filename='guide.txt', sha256=hashlib.sha256(GUIDE.encode()).hexdigest(),
             bytes=len(GUIDE), mime='text/plain')]
    _register(config, binding, documents=documents)
    index = KnowledgeIndexStore(config.with_name('knowledge-index.db'))
    entries = [
        {'filename': 'report.txt', 'sha256': documents[0]['sha256'], 'bytes': len(REPORT), 'mime': 'text/plain',
         'parse': {'status': 'parsed', 'parser': 'text-utf8', 'parserVersion': '1', 'errorCode': '',
                   'layout': REPORT_LAYOUT}, '_text': REPORT},
        {'filename': 'guide.txt', 'sha256': documents[1]['sha256'], 'bytes': len(GUIDE), 'mime': 'text/plain',
         'parse': {'status': 'parsed', 'parser': 'text-utf8', 'parserVersion': '1', 'errorCode': '',
                   'layout': [{'kind': 'page', 'page': 1, 'line': 1, 'lines': 2}]}, '_text': GUIDE}]
    index.index_revision(binding, REVISION, MANIFEST, entries)
    files = WorkspaceFileStore([RootConfig(root, work, resolve_root=False)])
    registration = KnowledgeImportRegistry(config.with_name('knowledge-imports.db')).find_registration_by_revision(
        binding, KB, REVISION)
    assert registration is not None
    return registration, index, binding, files, root, work


def test_library_search_projects_citations_with_library_identity(tmp_path) -> None:
    registration, index, binding, files, root, work = _indexed_space(tmp_path)
    view = search_registered_revision(registration, 'ALPHA', files=files, logical_root=root,
                                      index=index, binding=binding)

    assert view['kbId'] == KB and view['revisionId'] == REVISION
    assert view['revisionNo'] == 1 and view['manifestHash'] == MANIFEST
    assert view['engine'] == 'bm25' and view['fallbackReason'] == ''
    assert view['documentsMatched'] == 2 and view['documentsTotal'] == 2
    assert view['truncated'] is False and view['evidenceComplete'] is True and view['missing'] == []
    report_hits = [chunk for chunk in view['chunks'] if chunk['filename'] == 'report.txt']
    assert report_hits and all(chunk['contentHash'] == hashlib.sha256(REPORT.encode()).hexdigest()
                               for chunk in report_hits)
    by_line = {chunk['position']['line']: chunk['position'] for chunk in report_hits}
    assert by_line[2]['page'] == 4 and by_line[2]['table'] == 2
    assert by_line[3]['table'] is None
    # The retrieval credentials are the binding summary this search ran under.
    assert view['credentials'] == {'serverOrigin': 'https://test.invalid', 'userId': 'A', 'deviceId': 'D1'}
    assert str(work) not in json.dumps(view)
    assert all(set(chunk) == {'filename', 'contentHash', 'content', 'position'} for chunk in view['chunks'])
    assert all(set(chunk['position']) == {'logicalPath', 'line', 'page', 'table'} for chunk in view['chunks'])


def test_library_search_reports_incomplete_evidence_instead_of_faking(tmp_path) -> None:
    """A drifted document is structured missing with its filename: the answer
    names 依据不完整 (evidenceComplete false) and never substitutes bytes."""
    registration, index, binding, files, root, _work = _indexed_space(tmp_path)
    (tmp_path / 'work' / 'report.txt').write_text('report CHANGED\n', encoding='utf-8')

    view = search_registered_revision(registration, 'ALPHA', files=files, logical_root=root,
                                      index=index, binding=binding)
    assert view['evidenceComplete'] is False
    assert view['missing'] == [{'filename': 'report.txt', 'reason': 'content_drift'}]
    assert all(chunk['filename'] != 'report.txt' for chunk in view['chunks'])
    assert view['documentsMatched'] == 1
    assert 'CHANGED' not in json.dumps(view)


def test_library_search_degrades_visibly_without_an_index(tmp_path) -> None:
    registration, index, binding, files, root, _work = _indexed_space(tmp_path)
    index_path = index.path
    os.unlink(index_path)
    fresh = KnowledgeIndexStore(index_path)

    view = search_registered_revision(registration, 'ALPHA', files=files, logical_root=root,
                                      index=fresh, binding=binding)
    assert view['engine'] == 'literal' and view['fallbackReason'] == 'index-missing'
    # No layout rows either: the scan cites no anchors rather than guessing.
    assert all(chunk['position']['page'] is None for chunk in view['chunks'])
    assert view['evidenceComplete'] is True


def test_library_search_refuses_unknown_or_malformed_registrations(tmp_path) -> None:
    registration, index, binding, files, root, _work = _indexed_space(tmp_path)

    with pytest.raises(KnowledgeSearchError) as unknown:
        search_registered_revision(None, 'ALPHA', files=files, logical_root=root,
                                   index=index, binding=binding)
    assert str(unknown.value) == 'KNOWLEDGE_SEARCH_REVISION_UNREGISTERED'

    broken = dict(registration, documents=[{'filename': '../escape', 'sha256': 'z' * 64}])
    with pytest.raises(KnowledgeSearchError) as malformed:
        search_registered_revision(broken, 'ALPHA', files=files, logical_root=root,
                                   index=index, binding=binding)
    assert str(malformed.value) == 'KNOWLEDGE_SEARCH_REVISION_UNREGISTERED'

    empty = dict(registration, documents=[])
    with pytest.raises(KnowledgeSearchError) as empty_docs:
        search_registered_revision(empty, 'ALPHA', files=files, logical_root=root,
                                   index=index, binding=binding)
    assert str(empty_docs.value) == 'KNOWLEDGE_SEARCH_REVISION_UNREGISTERED'


# --- registry-bound workspace service -----------------------------------------


def _settings(config) -> RuntimeSettings:
    settings = RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1')
    settings.device_public_key = 'device-public-key'
    settings.server_public_key = 'broker-public-key'
    settings.save(config)
    return settings


def _register(config, binding, *, revision_id=REVISION, manifest_hash=MANIFEST, documents=None) -> None:
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    assert registry.record(binding, dict(kb_id=KB, status='registered', revision_id=revision_id,
        revision_no=1, manifest_hash=manifest_hash, document_count=2,
        documents=documents if documents is not None else [
            dict(filename='guide.txt', sha256=hashlib.sha256(GUIDE.encode()).hexdigest(), bytes=len(GUIDE), mime='text/plain'),
            dict(filename='notes.txt', sha256=hashlib.sha256(NOTES.encode()).hexdigest(), bytes=len(NOTES), mime='text/plain')]))


def _service(config, work) -> tuple[WorkspaceFileService, str, dict]:
    settings = _settings(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    binding = profile_binding(settings)
    assert binding is not None
    return WorkspaceFileService(selection), root, binding


def test_service_returns_verified_chunks_for_registered_revision(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (work / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    settings = _settings(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    binding = profile_binding(settings)
    assert binding is not None
    _register(config, binding)
    service = WorkspaceFileService(selection)

    task = service.execute('local.knowledge.search', {'arguments': _payload(root)})
    assert task.decision.value == 'allow'
    result = task.value
    assert result['documentsMatched'] == 2 and len(result['chunks']) == 2
    assert str(work) not in json.dumps(result)


def test_unknown_or_foreign_revision_is_refused(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding)

    with pytest.raises(KnowledgeSearchError) as unknown:
        service.execute('local.knowledge.search', {'arguments': _payload(root, revision_id='55555555-5555-5555-8555-555555555555')})
    assert str(unknown.value) == 'KNOWLEDGE_SEARCH_REVISION_UNKNOWN'

    with pytest.raises(KnowledgeSearchError) as tampered:
        service.execute('local.knowledge.search', {'arguments': _payload(root, manifest_hash='a' * 64)})
    assert str(tampered.value) == 'KNOWLEDGE_SEARCH_REVISION_UNKNOWN'

    # Registry rows are binding-scoped: another identity on this device has
    # no registered revision to re-validate, even for the same manifest.
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    assert registry.find_registration(binding, REVISION, MANIFEST) is not None
    foreign = dict(binding, user_id='B')
    assert registry.find_registration(foreign, REVISION, MANIFEST) is None


def test_local_policy_can_still_deny_the_capability(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    settings = _settings(config)
    settings.set_rule('local.knowledge.search', CapabilityRule.DENY)
    settings.save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    binding = profile_binding(settings)
    assert binding is not None
    _register(config, binding)
    service = WorkspaceFileService(selection)

    task = service.execute('local.knowledge.search', {'arguments': _payload(root)})
    assert task.decision.value == 'deny' and task.value is None


# --- signed transport contract -------------------------------------------------


@asynccontextmanager
async def connected_client(**options):
    broker_key = Ed25519PrivateKey.generate()
    ready = asyncio.Queue()
    done = asyncio.Event()

    async def broker(socket):
        await ready.put(socket)
        await done.wait()

    async with serve(broker, "127.0.0.1", 0) as server:
        client = LocalRuntimeClient(
            server_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}",
            device_id="desktop-test", session_token="isolated-test-token",
            private_key=Ed25519PrivateKey.generate(), server_public_key=public_key_text(broker_key),
            **options,
        )
        running = asyncio.create_task(client.run())
        socket = await asyncio.wait_for(ready.get(), 5)
        hello = json.loads(await socket.recv())

        def frame(payload, task_id="task-113", **kwargs):
            return server_sign(private_key=broker_key, message_type=ServerMessageType.TASK,
                device_id="desktop-test", session_id=hello["session_id"], task_id=task_id,
                payload=payload, **kwargs).model_dump(mode="json", by_alias=True)

        await socket.send(json.dumps(server_sign(private_key=broker_key,
            message_type=ServerMessageType.HELLO, device_id="desktop-test",
            session_id=hello["session_id"], payload={"server_public_key": public_key_text(broker_key),
            "protocol_version": "1"}).model_dump(mode="json", by_alias=True)))
        try:
            yield socket, frame
        finally:
            done.set()
            await client.shutdown()
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


async def _outcome(socket):
    while True:
        value = json.loads(await asyncio.wait_for(socket.recv(), 5))
        if value["type"] in {"error", "task_result"}:
            return value


def test_signed_knowledge_search_returns_receipt_tied_to_the_run(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (work / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding)

    async def scenario():
        async with connected_client(file_service=service, capabilities=service.capabilities) as (socket, frame):
            await socket.send(json.dumps(frame({'operation': 'local.knowledge.search', 'run_id': 'run-113',
                'tool_call_id': 'call-113', 'arguments': _payload(root)}, task_id='task-113')))
            response = await _outcome(socket)
            assert response['type'] == 'task_result'
            result = response['payload']['result']
            assert result['documentsMatched'] == 2
            receipt = response['payload']['receipt']
            assert receipt['run_id'] == 'run-113'
            assert receipt['task_id'] == 'task-113'
            assert receipt['capability'] == 'local.knowledge.search'
            assert receipt['status'] == 'completed'
            assert str(work) not in json.dumps(response)

    asyncio.run(scenario())


def test_signed_knowledge_search_unknown_revision_fails_without_result(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, _binding = _service(config, work)

    async def scenario():
        async with connected_client(file_service=service, capabilities=service.capabilities) as (socket, frame):
            await socket.send(json.dumps(frame({'operation': 'local.knowledge.search', 'run_id': 'run-113',
                'arguments': _payload(root)}, task_id='task-unknown')))
            response = await _outcome(socket)
            assert response['type'] == 'error'
            assert response['payload']['error_code'] == 'KNOWLEDGE_SEARCH_REVISION_UNKNOWN'
            assert 'result' not in response['payload']
            assert str(work) not in json.dumps(response)

    asyncio.run(scenario())


def test_signed_knowledge_search_citations_are_receipt_pinned(tmp_path) -> None:
    """The citation chain (#98): the result carries the library identity and
    the page/table citations; the receipt's result_hash pins exactly that
    cited result; and the durable ledger row binds the retrieval credentials
    (the profile binding) the search ran under — so a citation is traceable
    to its receipt and its credentials."""
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (work / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding)
    ledger_path = tmp_path / 'receipts.db'
    ledger = ReceiptLedger(str(ledger_path))
    captured: dict[str, str] = {}

    async def scenario():
        async with connected_client(file_service=service, capabilities=service.capabilities,
                                    receipt_ledger=ledger, user_id='A') as (socket, frame):
            await socket.send(json.dumps(frame({'operation': 'local.knowledge.search', 'run_id': 'run-98',
                'tool_call_id': 'call-98', 'arguments': _payload(root)}, task_id='task-98')))
            response = await _outcome(socket)
            assert response['type'] == 'task_result'
            result = response['payload']['result']
            assert result['library'] == {'kbId': KB, 'revisionId': REVISION, 'revisionNo': 1,
                                         'manifestHash': MANIFEST}
            assert result['evidenceComplete'] is True
            assert result['chunks']
            assert all(set(chunk['position']) == {'logical_path', 'line', 'page', 'table'}
                       for chunk in result['chunks'])
            receipt = response['payload']['receipt']
            assert receipt['task_id'] == 'task-98' and receipt['run_id'] == 'run-98'
            assert receipt['capability'] == 'local.knowledge.search'
            assert receipt['result_hash'] == content_hash(result)
            captured['result_hash'] = receipt['result_hash']
            assert str(work) not in json.dumps(response)

    asyncio.run(scenario())

    # The durable row keeps the admission identity (task/run/capability), the
    # receipt with the pinned result hash, and the credential binding.
    with sqlite3.connect(str(ledger_path)) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT binding, task, receipt, receipt_hash FROM local_receipts").fetchone()
    assert row is not None
    credentials = json.loads(row['binding'])
    assert set(credentials) == set(BINDING_FIELDS) and all(credentials.values())
    assert credentials['user_id'] == 'A'
    admitted = json.loads(row['task'])
    assert admitted['task_id'] == 'task-98' and admitted['run_id'] == 'run-98'
    assert admitted['capability'] == 'local.knowledge.search'
    stored = json.loads(row['receipt'])
    assert stored['result_hash'] == captured['result_hash']
