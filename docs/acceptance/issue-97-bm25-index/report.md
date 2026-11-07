# Issue 97 acceptance — BM25 全文索引与漂移标注（三期·18）

[iDeer-Desktop #97](https://github.com/Orbit-Crew/iDeer-Desktop/issues/97)
replaces the doc library's per-search UTF-8 literal scan with a real
device-side BM25 index: imports build the index from their own parsed text,
retrieval ranks the hash-verified frozen content and locates hits by document,
line, and page anchor, drift against the frozen digests is recorded and
annotated (已过期/重建中) instead of hidden, and a background rebuild that
re-verifies every manifest document can be canceled at a document boundary.
The literal scan stays as the visible degraded fallback. The directory name
carries the `-bm25-index` suffix because the repo's existing `issue-97/`
records belong to the old numbering (the installer acceptance ticket).

Execution date: 2026-11-07, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-97-bm25-index` from develop `29df1e2` (includes the
2026-11-07 merges: #115 CAD viewer, #116 Tecplot pane, #147 doc library, #145
project bindings, #144 synapse map). Windows 11 Pro 10.0.26300 x64; Node
22.23.4 (project cache `node-dist`); bundled Runtime Python 3.12.10
(`.runtime` via `runtime:prepare`); machine Python carries pytest 8.3.5 with
the runtime test extras.

## What was delivered

- `local-runtime/core/knowledge_index.py` (new): the `KnowledgeIndexStore`
  (sqlite `knowledge-index.db`; per-revision documents/terms tables; state
  derived from rows, never stored as a claim) and the `KnowledgeIndexRebuild`
  background job (one daemon thread, one slot, cancel at the document
  boundary, honest completed/canceled/failed outcomes). The tokenizer is
  stdlib-only and deterministic (ASCII word runs + CJK character bigrams,
  casefolded, 40-char term cap); BM25 (k1=1.5, b=0.75, non-negative idf)
  ranks documents; per-term line hits (≤200) and the frozen parse's layout
  anchors resolve each hit to its page.
- `local-runtime/core/knowledge_import.py`: both manifest builders keep the
  extracted text under the transient `_text` field; the registration wire and
  the registry rows exclude it by their fixed field lists (pinned by test).
- `local-runtime/core/platform_chat.py`: `_register_frozen_entries` indexes
  the freshly registered revision device-side (导入文档建立索引) and strips
  `_text` in a `finally`; an index failure never fails the registration and
  is recorded honestly (`mark_build_error`).
- `local-runtime/core/knowledge_search.py`: the walk and the content-addressed
  revalidation are shared (`locate_frozen_files`, `revalidate_frozen_documents`
  with a single-read `serve` callback — digest and scanned content always come
  from the same bytes, preserving the original's TOCTOU-safe property);
  `search_frozen_revision_indexed` answers intact documents from the BM25
  index with line+page positions and records observed drift;
  `search_frozen_revision` is the kept literal fallback and now names itself
  (`engine: 'literal'`).
- `local-runtime/core/file_service.py`: the search seam picks the engine — a
  ready index plus a tokenizable query answers BM25; anything else (missing /
  partial / failed / storage / untokenized query) degrades visibly with
  `engine`/`fallbackReason`/`index` on the result.
- `local-runtime/core/desktop.py`: the two exact-shape control commands
  (`knowledge-index-rebuild` with the frozen identity + scope fence +
  binding-scoped registry check; `knowledge-index-rebuild-cancel`), their
  single-slot queues, and the snapshot facts (`knowledgeIndexRebuild`,
  `knowledgeIndexStorageError`, per-row `index` view).
- TS ladder: `src/shared/desktop.ts` (`KnowledgeIndexView`,
  `KnowledgeIndexJobView`, `KnowledgeImportView.index`,
  `RuntimeStatus.knowledgeIndexRebuild/knowledgeIndexStorageError`, bridge
  methods), `src/main/runtime.ts` (single-slot request maps, reply handlers,
  shape-validating `parseKnowledgeIndexJob`/`parseKnowledgeIndexView`),
  `src/main/index.ts` (`desktop:knowledge:index-rebuild` + `-cancel` with
  main-side validation; no dialogs — read-only compute over the confirmed
  workspace), `src/preload/index.ts`, and the doc library pane
  (`docLibraryPane.tsx` + `stores/docLibrary.ts`): per-record index
  annotation (未建/重建中/已过期/未完成/失败 stay distinct), rebuild and
  cancel buttons, fixed-category explanations.
- Zero new dependencies; zero new IPC capabilities (`local.knowledge.search`
  unchanged); two new control-pipe commands with security-test pins.

## Acceptance criteria evidence

| Criterion | Evidence (automated) |
| --- | --- |
| BM25 索引建立并可检索，结果含文档与页定位 | `test_knowledge_index.py::test_index_revision_builds_a_ready_derived_state`, `::test_indexed_search_ranks_and_locates_with_pages` (BM25 ranking; chunks carry line and the frozen parse's page anchor; CJK bigram query hits notes.txt line 2 page 2), `::test_service_answers_from_the_index_and_annotates_the_engine` (service answers engine 'bm25') |
| 索引漂移（文档变更后）如实标注 | `::test_indexed_search_reports_drift_and_records_it` (drifted file → structured missing 'content_drift', indexed text never served, 'CHANGED' absent from the response, driftedDocuments recorded and returned), `::test_rebuild_counts_drift_instead_of_faking_content`; renderer annotation `test/doc-library-pane.test.tsx` "says 已过期 with the drifted count on top of a ready index" |
| 后台重建可取消，完成后状态刷新 | `::test_rebuild_restores_a_lost_index` (completed → ready), `::test_cancelled_rebuild_keeps_consistent_rows` (cancel between documents behind an event gate → partial, rows self-consistent), `::test_rebuild_refuses_unknown_revisions_and_a_second_job`; control-pipe gates in `test_desktop_protocol.py` (suite green); renderer progress + cancel `test/doc-library-pane.test.tsx` "shows the running rebuild with its progress and an honest cancel" |
| 现状字面扫描路径被替换（保留为降级可见） | `::test_service_answers_from_the_index_and_annotates_the_engine` (index removed → engine 'literal', fallbackReason 'index-missing', same verified answers), `::test_untokenized_query_answers_no_chunks_from_the_index`; unchanged `test_knowledge_search.py` contract suite green on the fallback engine |
| Runtime 检索测试覆盖索引/漂移/重建 | `local-runtime/tests/test_knowledge_index.py` (22 tests), `test_knowledge_import.py` (`_text` pinned in the entry; wire/registry exclusion), `test_knowledge_search.py`, `test_desktop_protocol.py`, `test/security.test.ts` (channel pins), `test/doc-library-pane.test.tsx` (5 new tests) |

## Runs

- `npm run typecheck` — clean (both tsconfig.node.json and tsconfig.web.json).
- Runtime pytest (`PYTHONPATH=local-runtime`, pytest 8.3.5): the affected
  suites first (`test_knowledge_index.py` 22, `test_knowledge_search.py`,
  `test_knowledge_import.py`, `test_file_service.py`, `test_desktop_protocol.py`,
  `test_desktop_files.py` — 88 passed), then the full `local-runtime/tests`
  suite green.
- vitest: `test/security.test.ts` (8, channel pins updated in sorted order)
  and `test/doc-library-pane.test.tsx` (12) green; full `npm test` re-run
  after `runtime:prepare` on the fresh worktree — see the honest note below.
- PR gate: `npm run verify:provenance` (linz provenance f88141b) exit 0;
  `python scripts/verify-runtime-source.py` exit 0 (file_service.py's further
  divergence is covered by its existing `modified` migration record);
  `ruff --select E9,F63,F7,F82 local-runtime` all checks passed.

## Honest notes

- The first full `npm test` run on the fresh worktree failed 29 live-bridge
  tests across 22 files: the worktree had no `.runtime` yet (every failing
  test spawns the bundled Runtime). After `npm run runtime:prepare` the suite
  was re-run in full; the result is recorded in the final commit message and
  the PR description. No failure was attributed to this diff without being
  re-verified.
- The rebuild's derived state after a canceled rebuild is `partial`, and a
  partial index degrades retrieval to the literal scan with
  `fallbackReason: 'index-partial'` — canceling a rebuild on a previously
  ready index keeps the old rows (each is self-consistent frozen content) and
  the index stays ready; the `partial` outcome appears when the rebuild had to
  create the revision's rows (an index that was missing or incomplete before).
- `_text` doubles the transient memory of a batch's manifest entries (bounded
  by the parse caps: 200 documents × 400k chars per batch) and is released per
  folder batch and after each explicit import.
