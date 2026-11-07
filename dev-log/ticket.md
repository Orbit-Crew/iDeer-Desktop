# Ticket: Issue #98 [三期·19] 检索问答引用到页

## Session facts (read first)

- Work tree: `G:/code/iDeer-worktrees/issue-98-retrieval-citations`, branch
  `feat/issue-98-retrieval-citations`, base `57b7d27` (= origin/develop,
  includes the #97/#153 BM25 index and #99/#154 similarity merges).
- You work ONLY inside this work tree. NEVER touch `G:/code/iDeer-Desktop`
  (main workspace), never `git stash`, never merge/rebase.
- Node: prepend `G:/code/iDeer-Desktop/.cache/node-dist/node-v22.23.4-win-x64`
  to PATH for every shell that runs node/npm. Repo npm scripts self-initialize
  the project env. A fresh worktree needs `npm ci` and `npm run
  runtime:prepare` once (the real-runtime bridge tests spawn `.runtime`).
- Python: the machine Python (D:\software\anaconda) carries pytest 8.3.5 and
  the runtime test deps. Any pytest run that imports `core.*` MUST set
  `PYTHONPATH=<worktree>/local-runtime` so the worktree source is tested,
  never site-packages. Sandbox note: pytest's default `%TEMP%` is denied;
  point `TMP/TEMP/TMPDIR` at the adjacent `<checkout>.tmp` directory.
- The issue was assigned to Neowyh (the authenticated developer) before work
  started, per docs/agents/issue-tracker.md.
- The repo's `docs/acceptance/issue-98/` belongs to the OLD numbering
  (installer acceptance). This ticket's records live in
  `docs/acceptance/issue-98-retrieval-citations/` (the `-suffix` convention).

## Full issue text (Orbit-Crew/iDeer-Desktop#98)

> ## Parent
>
> [linz 全量能力等价：iDeer Desktop 总规格](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)（三期：知识）
>
> ## What to build
>
> 检索与问答引用到页：问答/检索结果标注库、Revision、文档与命中位置（页/表），关联回执与检索凭据；离线或部分失败如实说明依据不完整，不冒充无结果。
>
> ## Acceptance criteria
>
> - [ ] 引用展示 库/版本/文档/页（表）定位
> - [ ] 引用与 Tool Receipt/检索凭据关联可查
> - [ ] 离线/部分失败提示"依据不完整"而非假成功
> - [ ] 桥契约与 Runtime 测试覆盖引用链
>
> ## Blocked by
>
> - [三期·18 BM25 全文索引与漂移标注](…/issues/97)（已合并 #153）

## Design constraints (settled — do not reopen)

- The #113 frozen-revision contract is NOT weakened: every search still
  re-validates each manifest document against the live bytes before anything
  is served, and the structured missing list stays the honest gap report.
- One answering seam: `answer_frozen_revision` in `knowledge_search.py` is
  the shared engine decision (BM25 when ready + tokenizable query, literal
  scan otherwise with a visible `fallbackReason`). The broker task and the
  user's library search answer identically; only the projection differs.
- Citations come only from the frozen parse's layout anchors
  (`kind: page|table`): a hit outside every table span cites no table, and an
  unknown layout cites no page — never a guessed page number.
- The broker result stays snake_case and additive (`library`,
  `evidenceComplete`, `position.table`) — the Server consumed the #113 shape
  and additive keys are safe (result is content-hash bound).
- The user-facing view (`search_registered_revision`) is bounded camelCase;
  documents are cited by their frozen (filename, content hash) identity —
  the registry never stores platform document ids, so none are invented.
- Device-side retrieval never calls the Server: an offline device still
  answers its own question, and the retrieval credentials ride as the binding
  summary (origin/user/device) — public keys never cross the bridge.
- The receipt chain is content-addressed: `receipt.result_hash` pins the
  exact cited result; the ledger row binds the credential profile. No
  receipt hash inside the result (that would be circular).

## Architecture map (verified)

- Anchor helpers: `local-runtime/core/knowledge_index.py`
  (`table_line_marks`/`table_for_line` mirror the page marks; a table is a
  bounded span, unlike a from-here-on page) + `document_layouts` store read
  keyed by (lowercased filename, content hash).
- Engines: `local-runtime/core/knowledge_search.py` — indexed chunks gain
  `position.table`; the literal engine accepts `layouts` and cites
  page/table when the frozen parse is known. `answer_frozen_revision`
  attaches `library` + `evidenceComplete`; `search_registered_revision`
  builds the registry-driven payload (document_id = sha256, internal key
  only) and projects the display view; `project_search_view` bounds and
  camelCases everything.
- Broker seam: `local-runtime/core/file_service.py::_search_knowledge` now
  delegates to `answer_frozen_revision` (no duplicated engine decision).
- Desktop entry: `local-runtime/core/platform_chat.py::knowledge_search`
  (the `similarity` action's precedent: binding-scoped registry lookup +
  `knowledge_files()` grant) with search-specific fixed categories;
  `local-runtime/core/desktop.py` adds the exact-shape `knowledge-search`
  gate + single-slot queue + dispatch (only `CHAT_*`/`KNOWLEDGE_*` cross).
- TS ladder: shared types (`KnowledgeSearchView`/`Hit`/`Gap`, bridge method)
  → `src/main/runtime.ts` (single-slot map, pre-runtime validation, bounded
  reply projection; NO selectionScope gate — an unconfirmed workspace answers
  with the Runtime's honest `KNOWLEDGE_SEARCH_WORKSPACE_UNAVAILABLE`) →
  `src/main/index.ts` (`desktop:knowledge:search`, requireMainFrame +
  authenticated) → `src/preload/index.ts` → `stores/docLibrary.ts`
  (`searchRecord`, generation-fenced, fixed-category explanations) →
  `docLibraryPane.tsx` (per-record search + `SearchCitations` card) →
  security-test channel pin + smoke bridge keys.
- QA honesty: `KnowledgeGraphSection.tsx` adds the 依据不完整 banner for a
  partial/failed scope (answer or retrieval) on top of the existing refusal
  alert.

## Scope guidance

1. No changes to `local.knowledge.search`'s wire contract beyond additive
   keys; the Server-facing result keeps snake_case.
2. No new dependency; one new IPC channel with its security pin.
3. The graph/ask surface cannot gain page numbers (the Server does not state
   them) — the device states the incompleteness instead of inventing facts.
