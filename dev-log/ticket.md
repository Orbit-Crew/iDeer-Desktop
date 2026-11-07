# Ticket: Issue #97 [三期·18] BM25 全文索引与漂移标注

## Session facts (read first)

- Work tree: `G:/code/iDeer-worktrees/issue-97-bm25-index`, branch `feat/issue-97-bm25-index`, base `29df1e2` (= origin/develop, includes the 2026-11-07 merges #151/#152/#147/#145/#144).
- You work ONLY inside this work tree. NEVER touch `G:/code/iDeer-Desktop` (main workspace), never push to any remote, never `git stash`, never merge/rebase.
- Node: prepend `G:/code/iDeer-Desktop/.cache/node-dist/node-v22.23.4-win-x64` to PATH for every shell that runs node/npm. Repo npm scripts self-initialize the project env. A fresh worktree needs `npm ci` once (project-env resolves tsc/vitest from node_modules).
- Python: the machine Python (D:\software\anaconda) carries pytest 8.3.5 and the runtime test deps. Any pytest run that imports `core.*` MUST set `PYTHONPATH=G:/code/iDeer-worktrees/issue-97-bm25-index/local-runtime` so the worktree source is tested, never site-packages.
- The issue was assigned to Neowyh (the authenticated developer) before work started, per docs/agents/issue-tracker.md.
- Forbidden: commenting on GitHub issues, changing issue state, editing `docs/agents/issue-tracker.md` (the PR itself is opened by the orchestrating session after review).
- The repo's `docs/acceptance/issue-97/` belongs to the OLD numbering (installer acceptance). This ticket's records live in `docs/acceptance/issue-97-bm25-index/` (the `-suffix` convention from issue-116-tecplot-panel).

## Full issue text (Orbit-Crew/iDeer-Desktop#97)

> ## Parent
>
> [linz 全量能力等价：iDeer Desktop 总规格](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)（三期：知识）
>
> ## What to build
>
> 设备侧真实 BM25 全文索引：导入文档建立索引，支持"哪些文档/哪些页提到过"检索定位；索引落后于文档时如实标注"重建中/已过期"，后台重建可取消；替代现状 UTF-8 字面扫描。
>
> ## Acceptance criteria
>
> - [x] BM25 索引建立并可检索，结果含文档与页定位 — evidence: `local-runtime/tests/test_knowledge_index.py::test_indexed_search_ranks_and_locates_with_pages` (BM25 ranks guide.txt first; every chunk carries the line and the frozen parse's page anchor; the CJK bigram query '文索' lands on notes.txt line 2 page 2) + `::test_index_revision_builds_a_ready_derived_state` (the index is built at import from the parsed entries) + service seam `::test_service_answers_from_the_index_and_annotates_the_engine` (engine 'bm25')
> - [x] 索引漂移（文档变更后）如实标注 — evidence: `::test_indexed_search_reports_drift_and_records_it` (the drifted file is structured missing 'content_drift', its indexed text is never served, 'CHANGED' is absent from the whole response, driftedDocuments is recorded and returned in the result's index view) + `::test_subset_search_never_erases_the_drift_annotation` (per-document marks: a subset search neither erases another document's 已过期 nor keeps a restored file's stale mark) + `::test_rebuild_counts_drift_instead_of_faking_content` (the rebuild marks the drifted row non-servable and never indexes current bytes)
> - [x] 后台重建可取消，完成后状态刷新 — evidence: `::test_rebuild_restores_a_lost_index` (a completed rebuild → derived state ready, servableDocuments 2) + `::test_cancelled_rebuild_keeps_consistent_rows` (the cancel lands between documents behind an event gate; partial rows stay self-consistent; the derived state is honestly 'partial', never ready) + `::test_rebuild_refuses_unknown_revisions_and_a_second_job` (KNOWLEDGE_INDEX_BUSY / KNOWLEDGE_INDEX_REVISION_UNKNOWN) + control-pipe gates and dispatch in `local-runtime/core/desktop.py` (exact-shape `knowledge-index-rebuild` / `-cancel`, single-slot queues, binding-scoped registry lookup)
> - [x] 现状字面扫描路径被替换（保留为降级可见） — evidence: `::test_service_answers_from_the_index_and_annotates_the_engine` second half (index deleted → engine 'literal', fallbackReason 'index-missing', index view 'missing', documentsMatched 2 — the same verified answers, visibly degraded) + `search_frozen_revision` keeps the exact #113 semantics (the single-read serve callback preserves hash-and-content-from-the-same-bytes; the unchanged `test_knowledge_search.py` assertions all pass) + `::test_untokenized_query_answers_no_chunks_from_the_index` + `::test_verified_unparsable_document_is_not_searchable` (the indexed path's structured missing matches the literal engine's answer)
> - [x] Runtime 检索测试覆盖索引/漂移/重建 — evidence: `local-runtime/tests/test_knowledge_index.py` (25 tests: tokenizer/bigrams, page marks, store derived states, binding scoping, persistence across instances, build-error honesty, wire/registry text exclusion, ranked retrieval with pages, per-document drift marks incl. the subset-search preservation, same-name documents served separately, rebuild/cancel/busy/unknown) + updated `test_knowledge_import.py` (`_text` pinned in the manifest entry; the wire payload and the registry rows exclude it) + `test_knowledge_search.py` (the existing contract intact on the fallback engine)

## Design constraints (settled — do not reopen)

- The #113 frozen-revision contract is NOT weakened: every search still re-validates each manifest document against the live bytes (name match + SHA-256) before anything is served; digest and served content always come from the same single read. The index only replaces the line scan with a BM25 ranking over text that was indexed from hash-verified frozen bytes.
- A rebuild cannot recover drifted content: the frozen revision's bytes for a changed file are gone; the row stays non-servable and the drift is counted, never faked from current bytes.
- stdlib-only (the runtime dependency set is frozen by pyproject + `test/security.test.ts`): the tokenizer is `re`-based (ASCII word runs + CJK character bigrams), BM25 is implemented in the module, storage is sqlite3.
- Index identity is (binding, revision_id, manifest_hash) — the same binding-scoped discipline as `find_registration`; kb_id is not part of the key (the search task does not carry it).
- No new IPC capability: `local.knowledge.search` keeps its name; the new control commands are `knowledge-index-rebuild` / `knowledge-index-rebuild-cancel` (security test channel pins updated).

## Architecture map (verified)

- Index store + rebuild job: `local-runtime/core/knowledge_index.py` (`KnowledgeIndexStore`, sqlite `knowledge-index.db` via `config.with_name`; derived state is never stored as a claim; `KnowledgeIndexRebuild` daemon-thread job following the `KnowledgeFolderImport` idiom).
- Import-time indexing: `knowledge_import.py` `_entry_with_text` (transient `_text` on manifest entries) → `platform_chat.py` `_register_frozen_entries` → `_index_frozen_revision` (best-effort, never fails the registration; `_text` stripped in `finally`; the wire payload and `DOCUMENT_FIELDS` exclude it).
- Retrieval: `knowledge_search.py` — `locate_frozen_files` (the bounded walk, shared) + `revalidate_frozen_documents` (hash + optional single-read `serve` callback) + `search_frozen_revision` (literal fallback, engine 'literal') + `search_frozen_revision_indexed` (BM25 chunks with line/page, engine 'bm25', drift observed onto the store).
- Service dispatch + degraded annotation: `file_service.py` `_search_knowledge` (ready index + tokenizable query → BM25; otherwise the literal scan with `fallbackReason` index-missing/partial/failed/storage/untokenized and the index view attached).
- Desktop wiring: `desktop.py` — store/job construction, two command gates + queues, dispatch blocks, snapshot `knowledgeIndexRebuild`/`knowledgeIndexStorageError` + per-row `index` view.
- TS ladder: shared types (`KnowledgeIndexView`, `KnowledgeIndexJobView`, `KnowledgeImportView.index`, `RuntimeStatus.knowledgeIndexRebuild/knowledgeIndexStorageError`, bridge methods) → `src/main/runtime.ts` (single-slot maps, reply handlers, `parseKnowledgeIndexJob/View`, snapshot fields) → `src/main/index.ts` (`desktop:knowledge:index-rebuild` + `-cancel`, main-side validation, no dialogs — read-only compute) → `src/preload/index.ts` → `docLibraryPane.tsx` + `stores/docLibrary.ts` (badge, rebuild/cancel buttons, fixed-category explanations) → `test/security.test.ts` + `scripts/desktop-smoke.cjs` pins.

## Scope guidance

1. Renderer scope is the doc library pane only: per-record index facts + rebuild/cancel. Search results stay agent-facing over the platform task path (no new pane; the receipt carries the result).
2. The literal scan stays for `local.files.search` (raw workspace file search is a different capability, out of scope here).
3. A rebuild does not re-import: changed documents need a new revision through the ordinary import seam (#101's 重导入 semantics); the rebuild only repairs the index and records drift honestly.
