# Issue 98 acceptance — 检索问答引用到页（三期·19）

[iDeer-Desktop #98](https://github.com/Orbit-Crew/iDeer-Desktop/issues/98)
gives the doc library's retrieval the full citation chain: every search
result carries the library identity (库/kbId, 版本/revisionNo, 清单指纹),
the frozen parse's page AND table anchors down to the hit line, the
structured missing rows for documents that could not contribute, and the
`evidenceComplete` fact — 依据不完整 is shown instead of faking a full
answer. The broker task and the user's own library search answer through the
one shared engine seam; the user's search additionally writes a durable
device audit row (query as digest only, fail-closed) so a citation stays
traceable to the retrieval credentials after the fact. The directory name
carries the `-retrieval-citations` suffix because the repo's existing
`issue-98/` records belong to the old numbering (the installer acceptance
ticket).

Execution date: 2026-11-09, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-98-retrieval-citations` from develop `57b7d27`
(includes the #97/#153 BM25 index and #99/#154 similarity merges), merged
with origin/develop `9845dab` before review (#101 revision semantics, #111
agent terminal, #117 result auto-open; conflicts resolved by union). Windows
11 Pro 10.0.26300 x64; Node 22.23.4 (project cache `node-dist`); bundled
Runtime Python 3.12.10 (`.runtime` via `runtime:prepare`, re-prepared after
the review fixes); machine Python carries pytest 8.3.5 with the runtime test
extras.

## What was delivered

- `local-runtime/core/knowledge_search.py`: `answer_frozen_revision` (the
  shared engine decision, also attaching `library` + `evidenceComplete`),
  `search_frozen_revision_indexed` gaining `position.table` from the frozen
  table spans and the honest `servableUnknown` flag, the literal engine
  citing page/table when the frozen layout is known (never guessing), and
  `search_registered_revision` + `project_search_view` (the bounded
  camelCase citation view; documents cited by frozen identity only).
- `local-runtime/core/file_service.py`: the broker search seam delegates to
  `answer_frozen_revision` — no duplicated engine decision; the broker wire
  result stays snake_case and additive.
- `local-runtime/core/platform_chat.py`: `knowledge_search` (binding-scoped
  registry lookup + the `knowledge_files()` grant, search-specific fixed
  categories read off `exc.code` — an unconfirmed workspace answers
  `KNOWLEDGE_SEARCH_WORKSPACE_UNAVAILABLE`, not a generic failure) and the
  durable audit row: `AuditKind.EXECUTION` `completed` for
  `local.knowledge.search`, the query only as `queryDigest`, the credential
  identity (`actor_id` + origin/device) on the row, written before the reply;
  a broken audit log fails the answer closed (`KNOWLEDGE_SEARCH_FAILED`),
  and `auditTaskId` is set on the view only when the row exists.
- `local-runtime/core/desktop.py`: the exact-shape `knowledge-search` wire
  gate + single-slot queue + dispatch threading its command id as `task_id`.
- TS ladder: `src/shared/desktop.ts` (`KnowledgeSearchView`/`Hit`/`Gap` with
  the two-value engine union and `auditTaskId`), `src/main/runtime.ts`
  (single-slot map, pre-runtime validation, bounded reply projection),
  `src/main/index.ts` (`desktop:knowledge:search`, requireMainFrame +
  authenticated), `src/preload/index.ts`, `stores/docLibrary.ts`
  (`searchRecord`, generation-fenced, fixed-category explanations),
  `docLibraryPane.tsx` (per-record search + `SearchCitations` card with the
  library identity in the citation line, the 依据不完整 banner that names
  truncation vs missing documents distinctly, and the audit-record line),
  `KnowledgeGraphSection.tsx` (the 依据不完整 banner for a partial/failed
  scope).
- Security pins: `test/security.test.ts` channel list + smoke bridge keys
  both carry the new door in sorted order. Zero new dependencies; zero new
  wire capabilities (`local.knowledge.search` unchanged).

## Acceptance criteria evidence

| Criterion | Evidence (automated) |
| --- | --- |
| 引用展示 库/版本/文档/页（表）定位 | `test_knowledge_search.py::test_literal_scan_cites_frozen_parse_anchors_when_layout_known` (page 4 + table 2 on the anchored line; outside-span line cites no table), `::test_literal_scan_without_layouts_never_guesses_anchors`, `test_knowledge_index.py::test_indexed_search_cites_the_table_a_hit_lands_in`; view identity `test_platform_knowledge_search.py::test_library_search_answers_without_the_server_with_citations` (kbId/revisionNo/manifestHash + contentHash); UI chain `test/doc-library-pane.test.tsx` "searches one registered revision and displays citations down to page and table" (知识库/版本 R/第 4 页/表 2/指纹) |
| 引用与 Tool Receipt/检索凭据关联可查 | broker receipt chain: `test_knowledge_search.py::test_signed_knowledge_search_citations_are_receipt_pinned` (result_hash pins the cited result; ledger row binds the credentials); user path: `::test_library_search_answers_without_the_server_with_citations` (audit row task_id/digest/queryDigest/credentials + `view['auditTaskId']`; raw query absent from the row), loop-level `test_desktop_knowledge_search.py::test_loop_search_threads_command_id_into_audit_and_reply` (the real profile `audit.db` row pins the command id) |
| 离线/部分失败提示"依据不完整"而非假成功 | `::test_library_search_answers_without_the_server_with_citations` asserts zero Server requests (`records == []`); `test_platform_knowledge_search.py::test_library_search_reports_incomplete_evidence` (drifted doc → structured missing, 'CHANGED' never served); `::test_library_search_reports_incomplete_evidence_instead_of_faking` and the `evidenceComplete` legs: `test_knowledge_search.py::test_literal_scan_overflow_marks_truncation_and_incomplete_evidence`, `test_knowledge_index.py::test_unresolvable_servability_never_claims_complete_evidence`; UI banners `test/doc-library-pane.test.tsx` ("marks incomplete evidence…", "names truncation… when the cut alone broke completeness") and `test/knowledge-graph.test.tsx` (ask/query 依据不完整) |
| 桥契约与 Runtime 测试覆盖引用链 | shared types + request validation `test/knowledge-search.test.ts` (pre-runtime refusals + real bundled-runtime refusal `KNOWLEDGE_SEARCH_IDENTITY_UNAVAILABLE`); wire gate exact shape `local-runtime/core/desktop.py` + loop tests above; channel pin `test/security.test.ts`; smoke key `scripts/desktop-smoke.cjs` (`knowledgeSearch`); success projection pinned at the loop level (`auditTaskId`/page/table on the emitted frame) |

## Runs

- `npm run typecheck` — clean (both tsconfig.node.json and tsconfig.web.json),
  re-run after the merge and after the review fixes.
- Runtime pytest (`PYTHONPATH=local-runtime`, pytest 8.3.5): affected suites
  first, then the full `local-runtime/tests` suite after the review fixes:
  **1096 passed, 10 skipped, 0 failed** (671s).
- vitest: full `npx vitest run` after `runtime:prepare`: **719/720 passed
  (97 files)** — the single failure was `test/nsis-process-guard.test.ts`,
  an environment gap (the worktree's `.cache` lacked the
  `electron-builder/nsis` makensis toolchain a fresh checkout must fetch);
  after junctioning the project cache it passes (4/4 with
  `test/knowledge-publish.test.ts`, whose parallel-load timing flake also
  passes solo), and the suite's other 96 files were green in the same run.
- PR gate: `python scripts/verify-runtime-source.py` exit 0;
  `ruff --select E9,F63,F7,F82` over the touched files — all checks passed;
  `npm run build` + `npm run test:desktop` smoke — `"result": "passed"`
  (bridge inventory includes `knowledgeSearch`).

## Honest notes

- The GUI-level citation card is verified by renderer tests (jsdom), not a
  screenshot-level manual pass; the three-layer bookkeeping for this ticket
  is: layer 1 automated suites above (green), layer 2 real-app loop
  (`desktop-smoke` + the bundled-runtime bridge test + the desktop-loop
  pytest) green, layer 3 human acceptance of the real UI — not executed;
  the citation card's search affordances and banner texts are pinned by
  tests, and a manual pass remains available before release.
- A review pass (two axes, see `dev-log/review.md`) found one real defect
  before push — the workspace error mapping compared `str(exc)` against the
  fixed codes while the code lives on `exc.code`, so the honest workspace
  category was unreachable — plus eight smaller findings (loop-level
  task_id coverage, unresolvable servability claiming complete evidence,
  the audit row's credential identity, a truncation engine test, the
  truncation-vs-missing banner wording, the failed-scope banner wording, a
  hot-path layout read, test hygiene); all fixed and pinned before this
  report was finalized.
- `auditTaskId` is absent from the view when no audit log is wired (the
  seam test pins the absence) — the renderer then says 本机审计记录不可用
  instead of naming a record that does not exist. The desktop app always
  wires the profile audit log, so the practical surface always names a row.
- The graph/ask surface cannot gain page numbers: the Server does not state
  them, so the device states the incompleteness instead of inventing facts
  (the banners and the failed status line name the scope honestly).
