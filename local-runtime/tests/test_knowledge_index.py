"""Device-side BM25 index over frozen knowledge revisions (#97).

The index is an optimization layered on the same frozen-revision contract:
building keeps the hash-verified parse text device-side, retrieval still
re-validates every document against the live bytes before serving, drift is
recorded instead of hidden, and a rebuild re-indexes only what still hashes
to its frozen digest. Every test drives the real store and (for the job)
the real workspace boundary.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path

import pytest

from core.file_service import WorkspaceFileService, WorkspaceFileStore, WorkspaceSelection
from core.files import RootConfig
from core.knowledge_import import KnowledgeImportRegistry, registration_payload, strip_entry_text
from core.knowledge_index import (KnowledgeIndexError, KnowledgeIndexRebuild, KnowledgeIndexStore,
                                  document_terms, line_page_marks, page_for_line, table_for_line,
                                  table_line_marks, tokenize)
from core.knowledge_search import search_frozen_revision_indexed
from core.receipt_ledger import profile_binding
from core.settings import RuntimeSettings, load_settings

BINDING = {'user_id': 'A', 'device_id': 'D1'}
KB = '33333333-3333-8333-8333-333333333333'
REVISION = '44444444-4444-4444-8444-444444444444'
MANIFEST = hashlib.sha256(b'manifest').hexdigest()
GUIDE = 'the launch code is ALPHA-7\nsecond line has ALPHA-7 again\n'
NOTES = 'release notes mention ALPHA-7\nmore text with 全文索引 全文索引 here\n'


# --- tokenizer -----------------------------------------------------------------


def test_tokenizer_words_bigrams_and_case() -> None:
    assert tokenize('Hello World') == ['hello', 'world']
    # Contiguous CJK becomes overlapping bigrams; a lone character stays one.
    assert tokenize('全文索引') == ['全文', '文索', '索引']
    assert tokenize('图') == ['图']
    # Mixed runs split at the script boundary; digits stay word tokens.
    assert tokenize('BM25全文') == ['bm25', '全文']
    assert tokenize('a中b文') == ['a', '中', 'b', '文']
    # Punctuation separates and is never a term by itself.
    assert tokenize('!!!。。。') == []
    # Deterministic and casefolded: the index and the query share vocabulary.
    assert tokenize('Alpha-7') == tokenize('ALPHA-7') == ['alpha', '7']


def test_document_terms_records_tf_and_first_lines() -> None:
    terms = document_terms(GUIDE)
    assert terms['alpha']['tf'] == 2
    assert terms['alpha']['lines'] == [1, 2]
    assert terms['launch']['lines'] == [1]


def test_page_marks_cover_lines_in_order() -> None:
    layout = [{'kind': 'page', 'page': 1, 'line': 1, 'lines': 2},
              {'kind': 'table', 'table': 1, 'line': 2, 'lines': 1},
              {'kind': 'page', 'page': 2, 'line': 3, 'lines': 0},
              {'kind': 'page', 'page': 3, 'line': 5, 'lines': 2}]
    marks = line_page_marks(layout)
    assert page_for_line(marks, 1) == 1
    assert page_for_line(marks, 2) == 1
    assert page_for_line(marks, 4) == 2
    assert page_for_line(marks, 6) == 3
    assert page_for_line(marks, 9) == 3
    assert page_for_line([], 1) is None
    assert line_page_marks([{'kind': 'page', 'page': None, 'line': 1}]) == []


def test_table_marks_cover_only_their_own_span() -> None:
    """Issue 98: a table anchor is a bounded span, not a from-here-on mark —
    a hit line outside every span cites no table, and a degenerate anchor
    (no number, zero lines, malformed entry) never resolves."""
    layout = [{'kind': 'page', 'page': 1, 'line': 1, 'lines': 6},
              {'kind': 'table', 'table': 1, 'line': 2, 'lines': 2},
              {'kind': 'table', 'table': 2, 'line': 5, 'lines': 1},
              {'kind': 'table', 'table': None, 'line': 9, 'lines': 1},
              {'kind': 'table', 'table': 3, 'line': 10, 'lines': 0},
              {'kind': 'page', 'page': 1, 'line': 11, 'lines': 1}]
    marks = table_line_marks(layout)
    assert marks == [(2, 3, 1), (5, 5, 2)]
    assert table_for_line(marks, 1) is None
    assert table_for_line(marks, 2) == 1
    assert table_for_line(marks, 3) == 1
    assert table_for_line(marks, 4) is None
    assert table_for_line(marks, 5) == 2
    assert table_for_line(marks, 6) is None
    assert table_for_line([], 2) is None


# --- the store -----------------------------------------------------------------


def _entry(name: str, text: str, *, status: str = 'parsed') -> dict:
    return {'filename': name, 'sha256': hashlib.sha256(text.encode()).hexdigest(),
            'bytes': len(text), 'mime': 'text/plain',
            'parse': {'status': status, 'parser': 'text-utf8', 'parserVersion': '1',
                      'errorCode': '' if status == 'parsed' else 'PARSE_FORMAT_UNSUPPORTED'},
            '_text': text if status == 'parsed' else ''}


def _entries() -> list[dict]:
    return [_entry('guide.txt', GUIDE), _entry('notes.txt', NOTES)]


def _layout_for(name: str) -> list[dict]:
    pages = {'guide.txt': [{'kind': 'page', 'page': 1, 'line': 1, 'lines': 3}],
             'notes.txt': [{'kind': 'page', 'page': 1, 'line': 1, 'lines': 1},
                           {'kind': 'page', 'page': 2, 'line': 2, 'lines': 2}]}
    return pages.get(name, [])


def test_index_revision_builds_a_ready_derived_state(tmp_path) -> None:
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    entries = _entries()
    for entry in entries:
        entry['parse']['layout'] = _layout_for(entry['filename'])
    store.index_revision(BINDING, REVISION, MANIFEST, entries)

    view = store.revision_view(BINDING, REVISION, MANIFEST)
    assert view['state'] == 'ready'
    assert view['documents'] == 2 and view['indexedDocuments'] == 2
    assert view['servableDocuments'] == 2 and view['driftedDocuments'] == 0
    assert view['error'] == '' and view['builtAt'] != ''


def test_index_is_binding_scoped_and_missing_for_foreign_identities(tmp_path) -> None:
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST, _entries())
    assert store.revision_view({'user_id': 'B', 'device_id': 'D1'}, REVISION, MANIFEST)['state'] == 'missing'
    assert store.revision_view(BINDING, '55555555-5555-5555-8555-555555555555', MANIFEST)['state'] == 'missing'
    assert store.revision_view(BINDING, REVISION, 'a' * 64)['state'] == 'missing'


def test_unparsable_documents_stay_explicit_non_servable_rows(tmp_path) -> None:
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST,
                         [_entry('guide.txt', GUIDE), _entry('legacy.doc', '', status='skipped')])
    view = store.revision_view(BINDING, REVISION, MANIFEST)
    assert view['state'] == 'ready' and view['servableDocuments'] == 1
    assert view['indexedDocuments'] == 2


def test_rows_persist_across_store_instances(tmp_path) -> None:
    path = str(tmp_path / 'knowledge-index.db')
    KnowledgeIndexStore(path).index_revision(BINDING, REVISION, MANIFEST, _entries())
    view = KnowledgeIndexStore(path).revision_view(BINDING, REVISION, MANIFEST)
    assert view['state'] == 'ready'


def test_build_error_is_recorded_but_never_claims_readiness(tmp_path) -> None:
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.mark_build_error(BINDING, REVISION, MANIFEST, 'KNOWLEDGE_INDEX_FAILED')
    view = store.revision_view(BINDING, REVISION, MANIFEST)
    assert view['state'] == 'missing' and view['error'] == 'KNOWLEDGE_INDEX_FAILED'


def test_registration_wire_and_rows_never_carry_text(tmp_path) -> None:
    entries = _entries()
    payload = registration_payload(entries, 'device-1')
    assert '_text' not in json.dumps(payload)
    assert set(payload['documents'][0]) == {'filename', 'content_hash', 'size_bytes', 'mime_type'}
    strip_entry_text(entries)
    assert all('_text' not in entry for entry in entries)


# --- retrieval from the index ---------------------------------------------------


def _document(name: str, content: str) -> dict:
    content_hash = hashlib.sha256(content.encode()).hexdigest()
    return {"document_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"local-import:{name}:{content_hash}")),
            "filename": name, "content_hash": content_hash}


def _payload(work: str, *, query='ALPHA-7', documents=None) -> dict:
    return {'query': query, 'revision_id': REVISION, 'manifest_hash': MANIFEST,
            'documents': documents if documents is not None else [
                _document('guide.txt', GUIDE), _document('notes.txt', NOTES)]}


def _store_for(tmp_path: Path, files_root: Path) -> WorkspaceFileStore:
    return WorkspaceFileStore([RootConfig('/workspace', files_root, resolve_root=False)])


def test_indexed_search_ranks_and_locates_with_pages(tmp_path) -> None:
    (tmp_path / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (tmp_path / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    entries = _entries()
    for entry in entries:
        entry['parse']['layout'] = _layout_for(entry['filename'])
    store.index_revision(BINDING, REVISION, MANIFEST, entries)
    files = _store_for(tmp_path, tmp_path)

    result = search_frozen_revision_indexed(_payload(''), files=files, logical_root='/workspace',
                                            index=store, binding=BINDING)
    assert result['engine'] == 'bm25'
    assert result['documentsMatched'] == 2 and result['missing'] == []
    # guide.txt mentions the query twice on two lines; BM25 ranks it first,
    # and every chunk carries the line and the frozen parse's page anchor.
    assert result['chunks'][0]['document_keyword'] == 'guide.txt'
    assert [chunk['position']['line'] for chunk in result['chunks'][:2]] == [1, 2]
    assert all(chunk['position']['page'] == 1 for chunk in result['chunks'][:2])
    notes_chunks = [chunk for chunk in result['chunks'] if chunk['document_keyword'] == 'notes.txt']
    assert [chunk['position']['line'] for chunk in notes_chunks] == [1]
    assert [chunk['position']['page'] for chunk in notes_chunks] == [1]
    assert str(tmp_path) not in json.dumps(result)
    # The Chinese query reaches the bigram index through the same tokens,
    # and the hit lands on the page the frozen parse anchored it to.
    cjk = search_frozen_revision_indexed(_payload('', query='文索'), files=files,
                                         logical_root='/workspace', index=store, binding=BINDING)
    assert [chunk['document_keyword'] for chunk in cjk['chunks']] == ['notes.txt']
    assert cjk['chunks'][0]['position'] == {'logical_path': '/workspace/notes.txt', 'line': 2, 'page': 2,
                                            'table': None}
    assert cjk['chunks'][0]['content'].count('全文索引') == 2


def test_indexed_search_cites_the_table_a_hit_lands_in(tmp_path) -> None:
    """Issue 98: a hit line inside a frozen table span cites that table; a
    line outside every span cites none — the anchors come only from the
    frozen parse, never guessed from content."""
    text = 'report header line\nalpha in table body\nalpha after the table\n'
    (tmp_path / 'report.txt').write_bytes(text.encode('utf-8'))
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    entry = _entry('report.txt', text)
    entry['parse']['layout'] = [{'kind': 'page', 'page': 1, 'line': 1, 'lines': 3},
                                {'kind': 'table', 'table': 2, 'line': 2, 'lines': 1}]
    store.index_revision(BINDING, REVISION, MANIFEST, [entry])
    files = _store_for(tmp_path, tmp_path)

    result = search_frozen_revision_indexed(_payload('', query='alpha', documents=[_document('report.txt', text)]),
                                            files=files, logical_root='/workspace',
                                            index=store, binding=BINDING)
    positions = {chunk['position']['line']: chunk['position'] for chunk in result['chunks']}
    assert positions[2]['table'] == 2 and positions[2]['page'] == 1
    assert positions[3]['table'] is None and positions[3]['page'] == 1


def test_document_layouts_reads_back_the_frozen_parse_anchors(tmp_path) -> None:
    """Issue 98: the literal engine's layout source — keyed by the frozen
    (lowercased filename, content hash) identity, empty for a revision the
    index never stored, and never carrying text."""
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    assert store.document_layouts(BINDING, REVISION, MANIFEST) == {}
    entries = _entries()
    for entry in entries:
        entry['parse']['layout'] = _layout_for(entry['filename'])
    store.index_revision(BINDING, REVISION, MANIFEST, entries)

    layouts = store.document_layouts(BINDING, REVISION, MANIFEST)
    assert set(layouts) == {('guide.txt', hashlib.sha256(GUIDE.encode()).hexdigest()),
                            ('notes.txt', hashlib.sha256(NOTES.encode()).hexdigest())}
    assert layouts[('guide.txt', hashlib.sha256(GUIDE.encode()).hexdigest())] == _layout_for('guide.txt')
    # Layout rows carry anchors only — never the parsed text itself.
    assert all(set(anchor) <= {'kind', 'page', 'table', 'title', 'line', 'lines'}
               for anchors in layouts.values() for anchor in anchors)
    foreign = store.document_layouts({'user_id': 'B', 'device_id': 'D1'}, REVISION, MANIFEST)
    assert foreign == {}


def test_indexed_search_reports_drift_and_records_it(tmp_path) -> None:
    (tmp_path / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (tmp_path / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST, _entries())
    # One file drifts after indexing: it is structured missing, its indexed
    # text is never served, and the observed drift lands on the revision.
    (tmp_path / 'notes.txt').write_text('release notes CHANGED\n', encoding='utf-8')
    files = _store_for(tmp_path, tmp_path)

    result = search_frozen_revision_indexed(_payload(''), files=files, logical_root='/workspace',
                                            index=store, binding=BINDING)
    assert [row['reason'] for row in result['missing']] == ['content_drift']
    assert all(chunk['document_keyword'] != 'notes.txt' for chunk in result['chunks'])
    assert 'CHANGED' not in json.dumps(result)
    assert result['index']['driftedDocuments'] == 1
    assert store.revision_view(BINDING, REVISION, MANIFEST)['driftedDocuments'] == 1


def test_subset_search_never_erases_the_drift_annotation(tmp_path) -> None:
    """Drift is tracked per document: a later subset search that does not
    touch the drifted document must not reset 已过期 to zero, and a search
    that verifies the file again (it was restored) clears its own mark."""
    (tmp_path / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (tmp_path / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST, _entries())
    files = _store_for(tmp_path, tmp_path)
    (tmp_path / 'notes.txt').write_text('release notes CHANGED\n', encoding='utf-8')

    full = search_frozen_revision_indexed(_payload(''), files=files, logical_root='/workspace',
                                          index=store, binding=BINDING)
    assert full['index']['driftedDocuments'] == 1
    # A subset that only asks about the intact document leaves the annotation.
    subset = search_frozen_revision_indexed(
        _payload('', documents=[_document('guide.txt', GUIDE)]), files=files,
        logical_root='/workspace', index=store, binding=BINDING)
    assert subset['missing'] == [] and subset['documentsMatched'] == 1
    assert subset['index']['driftedDocuments'] == 1
    # The file is restored: a search that verifies it clears its own mark.
    (tmp_path / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    restored = search_frozen_revision_indexed(_payload(''), files=files, logical_root='/workspace',
                                              index=store, binding=BINDING)
    assert restored['missing'] == [] and restored['index']['driftedDocuments'] == 0


def test_verified_unparsable_document_is_not_searchable(tmp_path) -> None:
    """A document whose bytes verify but that the index cannot honestly serve
    (skipped legacy format) is structured missing — never a silent gap, and
    never counted as matched."""
    (tmp_path / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    legacy_bytes = b'legacy binary\x00'
    legacy = dict(_entry('legacy.doc', '', status='skipped'),
                  sha256=hashlib.sha256(legacy_bytes).hexdigest())
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST, [_entry('guide.txt', GUIDE), legacy])
    (tmp_path / 'legacy.doc').write_bytes(legacy_bytes)
    payload = _payload('', documents=[_document('guide.txt', GUIDE),
                                      {'document_id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'legacy')),
                                       'filename': 'legacy.doc', 'content_hash': legacy['sha256']}])
    files = _store_for(tmp_path, tmp_path)

    result = search_frozen_revision_indexed(payload, files=files, logical_root='/workspace',
                                            index=store, binding=BINDING)
    assert {'document_id': payload['documents'][1]['document_id'], 'reason': 'not_searchable'} in result['missing']
    assert result['documentsMatched'] == 1
    assert all(chunk['document_keyword'] != 'legacy.doc' for chunk in result['chunks'])


def test_same_name_documents_are_served_separately(tmp_path) -> None:
    """Two same-name documents with different digests (a folder import only
    dedups by content) must never merge in the index: both are ranked and
    served with their own lines and pages."""
    (tmp_path / 'first').mkdir()
    (tmp_path / 'second').mkdir()
    first, second = 'alpha report FIRST\n', 'alpha report SECOND\n'
    (tmp_path / 'first' / 'report.txt').write_bytes(first.encode('utf-8'))
    (tmp_path / 'second' / 'report.txt').write_bytes(second.encode('utf-8'))
    entries = [_entry('report.txt', first), _entry('report.txt', second)]
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST, entries)
    files = _store_for(tmp_path, tmp_path)

    result = search_frozen_revision_indexed(
        _payload('', query='alpha',
                 documents=[_document('report.txt', first), _document('report.txt', second)]),
        files=files, logical_root='/workspace', index=store, binding=BINDING)
    served = {(chunk['document_keyword'], chunk['position']['logical_path'], chunk['content'])
              for chunk in result['chunks']}
    assert ('report.txt', '/workspace/first/report.txt', 'alpha report FIRST') in served
    assert ('report.txt', '/workspace/second/report.txt', 'alpha report SECOND') in served
    assert result['documentsMatched'] == 2


def test_untokenized_query_answers_no_chunks_from_the_index(tmp_path) -> None:
    """A punctuation-only query has no indexable terms: the index honestly
    answers nothing; the service seam routes such queries to the literal
    scan instead (covered with the fallback tests below)."""
    (tmp_path / 'guide.txt').write_bytes(b'strange !!! punctuation\n')
    store = KnowledgeIndexStore(str(tmp_path / 'knowledge-index.db'))
    store.index_revision(BINDING, REVISION, MANIFEST, [_entry('guide.txt', 'strange !!! punctuation')])
    files = _store_for(tmp_path, tmp_path)

    result = search_frozen_revision_indexed(_payload('', query='!!!'), files=files,
                                            logical_root='/workspace', index=store, binding=BINDING)
    assert result['chunks'] == [] and result['engine'] == 'bm25'
    assert store.revision_view(BINDING, REVISION, MANIFEST)['state'] == 'ready'


def test_service_answers_from_the_index_and_annotates_the_engine(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (work / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    settings = RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1')
    settings.device_public_key = 'device-public-key'
    settings.server_public_key = 'broker-public-key'
    settings.save(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    binding = profile_binding(settings)
    assert binding is not None
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    assert registry.record(binding, dict(kb_id=KB, status='registered', revision_id=REVISION,
        revision_no=1, manifest_hash=MANIFEST, document_count=2, documents=[]))
    index = KnowledgeIndexStore(config.with_name("knowledge-index.db"))
    entries = _entries()
    for entry in entries:
        entry['parse']['layout'] = _layout_for(entry['filename'])
    index.index_revision(binding, REVISION, MANIFEST, entries)
    service = WorkspaceFileService(selection)

    task = service.execute('local.knowledge.search', {'arguments': _payload(root)})
    assert task.decision.value == 'allow'
    result = task.value
    assert result['engine'] == 'bm25' and len(result['chunks']) >= 2
    assert 'fallbackReason' not in result

    # Without an index the same task degrades visibly to the literal scan.
    index_path = config.with_name("knowledge-index.db")
    index_path.unlink()
    degraded = service.execute('local.knowledge.search', {'arguments': _payload(root)}).value
    assert degraded['engine'] == 'literal'
    assert degraded['fallbackReason'] == 'index-missing'
    assert degraded['index']['state'] == 'missing'
    assert degraded['documentsMatched'] == 2
    assert str(work) not in json.dumps(degraded)


# --- the cancellable rebuild job -------------------------------------------------


def _rebuild_harness(tmp_path: Path):
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    space = tmp_path / 'work'
    space.mkdir()
    settings = RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1')
    settings.device_public_key = 'device-public-key'
    settings.server_public_key = 'broker-public-key'
    settings.save(config)
    WorkspaceSelection(config).select(str(space), confirmed=True)
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    registry.record(profile_binding(load_settings(config)), dict(
        kb_id=KB, status='registered', revision_id=REVISION, revision_no=1, manifest_hash=MANIFEST,
        document_count=2, documents=[
            dict(filename='guide.txt', sha256=hashlib.sha256(GUIDE.encode()).hexdigest(),
                 bytes=len(GUIDE), mime='text/plain'),
            dict(filename='notes.txt', sha256=hashlib.sha256(NOTES.encode()).hexdigest(),
                 bytes=len(NOTES), mime='text/plain')]))

    def knowledge_files():
        current, grant = WorkspaceSelection(config).current()
        files = WorkspaceFileStore([RootConfig(grant['logical_root'], Path(grant['physical_root']),
            identity=tuple(grant['identity']), resolve_root=False)], protected_roots=(config.parent,))
        return current, grant, files

    index = KnowledgeIndexStore(str(config.parent / 'knowledge-index.db'))
    return (KnowledgeIndexRebuild(knowledge_files, registry, index), registry, index,
            profile_binding(load_settings(config)), space)


def wait_terminal(job: KnowledgeIndexRebuild, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = job.status()
        if status and status['state'] != 'running':
            return status
        time.sleep(0.02)
    raise AssertionError('index rebuild job did not settle')


def test_rebuild_restores_a_lost_index(tmp_path) -> None:
    job, _registry, index, binding, space = _rebuild_harness(tmp_path)
    (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (space / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    started = job.start(KB, REVISION, MANIFEST)
    assert started['state'] == 'running'
    status = wait_terminal(job)

    assert status['state'] == 'completed'
    assert status['totalDocuments'] == 2
    assert status['indexedDocuments'] == 2 and status['driftedDocuments'] == 0
    view = index.revision_view(binding, REVISION, MANIFEST)
    assert view['state'] == 'ready' and view['servableDocuments'] == 2


def test_rebuild_counts_drift_instead_of_faking_content(tmp_path) -> None:
    job, _registry, index, binding, space = _rebuild_harness(tmp_path)
    (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (space / 'notes.txt').write_text('release notes CHANGED\n', encoding='utf-8')
    job.start(KB, REVISION, MANIFEST)
    status = wait_terminal(job)

    assert status['state'] == 'completed'
    assert status['driftedDocuments'] == 1 and status['indexedDocuments'] == 1
    view = index.revision_view(binding, REVISION, MANIFEST)
    assert view['driftedDocuments'] == 1 and view['servableDocuments'] == 1
    # The drifted content never enters the store.
    assert 'CHANGED' not in json.dumps(index.search(binding, REVISION, MANIFEST, 'CHANGED', limit=10))


def test_rebuild_refuses_unknown_revisions_and_a_second_job(tmp_path) -> None:
    job, _registry, _index, _binding, space = _rebuild_harness(tmp_path)
    (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (space / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    job.start(KB, REVISION, MANIFEST)
    with pytest.raises(KnowledgeIndexError) as busy:
        job.start(KB, REVISION, MANIFEST)
    assert str(busy.value) == 'KNOWLEDGE_INDEX_BUSY'
    assert wait_terminal(job)['state'] == 'completed'

    unknown = '55555555-5555-5555-8555-555555555555'
    job.start(KB, unknown, MANIFEST)
    status = wait_terminal(job)
    assert status['state'] == 'failed' and status['error'] == 'KNOWLEDGE_INDEX_REVISION_UNKNOWN'


def test_cancelled_rebuild_keeps_consistent_rows(tmp_path, monkeypatch) -> None:
    """Cancel lands between documents; the rows written so far stay
    self-consistent frozen content and the derived state honestly shows the
    index is incomplete (partial), never ready."""
    import threading

    job, _registry, index, binding, space = _rebuild_harness(tmp_path)
    (space / 'guide.txt').write_bytes(GUIDE.encode('utf-8'))
    (space / 'notes.txt').write_bytes(NOTES.encode('utf-8'))
    original = index.update_document
    entered = threading.Event()
    release = threading.Event()

    def gated_update(*args, **kwargs):
        # Hold the worker inside the first document's write so the cancel
        # lands deterministically between documents, not before the first.
        entered.set()
        release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(index, 'update_document', gated_update)
    job.start(KB, REVISION, MANIFEST)
    assert entered.wait(5)
    assert job.cancel() is True
    release.set()
    status = wait_terminal(job)

    assert status['state'] == 'canceled'
    assert status['processedDocuments'] == 1 and status['indexedDocuments'] == 1
    view = index.revision_view(binding, REVISION, MANIFEST)
    assert view['state'] == 'partial'
    assert view['documents'] == 2 and view['indexedDocuments'] == 1
    assert view['servableDocuments'] == 1


def test_cancel_without_a_running_job_is_reported_honestly(tmp_path) -> None:
    job, _registry, _index, _binding, _space = _rebuild_harness(tmp_path)
    assert job.cancel() is False
    assert job.status() is None

