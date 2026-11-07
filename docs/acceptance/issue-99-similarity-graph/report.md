# Issue 99 acceptance — 文档相似图与实体图（三期·20）

[iDeer-Desktop #99](https://github.com/Orbit-Crew/iDeer-Desktop/issues/99)
restores the linz similarity/entity graph capability over the Desktop's
existing controlled knowledge-graph entry: the entity/relation layer keeps
coming from the platform, and the missing similarity layer is computed on
this device from the revision the current identity registered — every
document re-verified content-addressed before its tokens are used — and both
layers render on one interactive canvas with pan, node drag, wheel zoom,
filters, and a bounded JSON export. The directory name carries the
`-similarity-graph` suffix because the repo's existing `issue-99/` records
belong to the old numbering (the installer acceptance ticket).

Execution date: 2026-11-07, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-99-similarity-graph` from develop `29df1e2`
(includes the #115 CAD viewer, #116 Tecplot pane, #147 doc library, #145
project bindings, #144 synapse map merges). Windows 11 Pro 10.0.26300 x64;
Node 22.23.4 (project cache); bundled Runtime Python 3.12.10 (`.runtime` via
`scripts/prepare-runtime.py`); machine Python carries pytest with the runtime
test extras.

## What was delivered

- `local-runtime/core/knowledge_similarity.py` (new): the device-side
  similarity layer. The workspace walk, the per-candidate content-addressed
  SHA-256 re-validation, and the structured per-document statuses
  (`matched` / `content_drift` / `not_searchable` / `file_unavailable` /
  `not_enough_content`) mirror the #113 search honesty model; the measure is
  a deterministic token-set Jaccard (ASCII words lowercased + CJK bigrams,
  stdlib only) over documents with at least `MIN_TOKENS=8` tokens; the
  candidate edge set is computed at the fixed baseline threshold 0.05,
  deterministically ordered (weight desc, then source/target), bounded at
  2000 edges, and an over-cap answer carries `truncated: true`. Duplicate
  manifest basenames are disambiguated symmetrically by digest suffix so two
  different files never merge. The answer echoes the frozen identity
  (`kbId` / `revisionId` / `revisionNo` / `manifestHash`).
- `local-runtime/core/platform_chat.py`: the `similarity` action inside the
  controlled `knowledge_graph` entry, device-local like `locate`: it never
  calls the Server; the frozen documents come only from this identity's
  binding-scoped `find_registration_by_revision` row (`status='registered'`),
  a foreign or unregistered revision fails closed with the fixed category
  `KNOWLEDGE_GRAPH_REVISION_UNREGISTERED`, and workspace failures keep their
  `KNOWLEDGE_*` categories.
- `local-runtime/core/desktop.py`: the command gate whitelist admits
  `similarity`; the single-slot `knowledge_graph_commands` queue, the fixed
  error pass-through, and the 60 s timeout are unchanged family behavior.
- TS ladder: `src/shared/desktop.ts` (`KnowledgeGraphCommand.action` gains
  `similarity`; new `KnowledgeSimilarityDocument` / `KnowledgeSimilarityEdge`
  / `KnowledgeSimilarityView`; bridge return union), `src/main/runtime.ts`
  (action whitelist; request map type). Zero new IPC channels — the
  `desktop:knowledge:graph` allowlist pin in `test/security.test.ts` and
  `scripts/desktop-smoke.cjs` is unchanged.
- Renderer: `src/renderer/src/components/graphCanvasModel.ts` (new pure
  model: entity/similarity graph builders, deterministic layered layout —
  groups as clusters on a ring, no Math.random — threshold filtering, zoom
  clamp, `screenToWorld`/`zoomAround` viewport math, and the export payload);
  `KnowledgeGraphCanvas.tsx` (new SVG canvas: background-drag pan, node drag
  with pointer capture, non-passive wheel zoom around the cursor, reset
  layout, entity-type checkboxes, similarity threshold slider, JSON export of
  exactly the displayed graph); `KnowledgeGraphSection.tsx` (生成相似图 entry
  per registered revision; canvas mounted for either layer);
  `RuntimePanel.tsx` (similarity state; `view`/`generate`/`similarity` each
  switch the whole graph family's revision context, per the review fix).
- Zero new dependencies; zero new IPC capabilities; pointer math converts
  client coordinates through `getScreenCTM().inverse()` so the viewBox
  letterboxing never skews drag/zoom (review finding, fixed).

## Acceptance criteria evidence

| Criterion | Evidence (automated) |
| --- | --- |
| 相似图与实体图可生成并展示 | `test_platform_knowledge_similarity.py::test_similarity_binds_to_the_registered_revision_without_the_server` (device computes the layer, edges from overlapping vocabulary), `::test_similarity_reports_drift_and_missing_documents_alongside_matched_ones`; renderer `test/knowledge-graph.test.tsx` "draws the entity graph canvas with its nodes and relation labels" (platform entities/relations on the canvas), "shows the device similarity layer with honest per-document statuses" (相似图 mode renders without a platform graph) |
| 画布可拖拽、筛选、导出 | `test/graph-canvas-model.test.ts` "zooms around the cursor without moving the world under it" (`screenToWorld`/`zoomAround` exact at any mounted size via the CTM contract), "clamps zoom into the fixed band", "filters edges by the display threshold and labels weights honestly", "builds one node per entity plus uncategorized relation endpoints" (type filter basis), "exports exactly the filtered display graph with its revision binding"; controls pinned in `test/knowledge-graph.test.tsx` (`aria-label="重置布局"`, `aria-label="导出当前图 JSON"`, entity-type checkbox group, threshold slider `aria-label="相似度阈值"`); drag/pan are pointer-capture handlers over the same model functions |
| 生成绑定当前库 Revision 并可查 | The similarity answer echoes `kbId`/`revisionId`/`revisionNo`/`manifestHash` from the binding-scoped registry row — `::test_similarity_binds_to_the_registered_revision_without_the_server`; a foreign/unregistered revision is refused — `::test_similarity_refuses_revisions_this_identity_never_registered`; the section shows 版本 R{n} 与清单指纹 next to the layer (`test/knowledge-graph.test.tsx` "shows the device similarity layer…"); re-requesting a revision recomputes against re-verified bytes (derived state, never a stored claim) |
| 部分失败如实标（成功/失败分别呈现） | `::test_similarity_reports_drift_and_missing_documents_alongside_matched_ones` (partial: matched + content_drift + file_unavailable rows, no invented edges), `::test_similarity_reports_short_documents_without_fabricating_edges` (not_enough_content), `::test_similarity_reports_undecodable_frozen_bytes` (not_searchable), `::test_similarity_caps_edges_and_flags_truncation` (bounded edge list with `truncated: true`); renderer keeps failed documents visible as nodes with their own statuses and the warning 缺失的文档不代表完整相似图 (`test/knowledge-graph.test.tsx`, asserted verbatim) |
| 图谱组件测试扩展（既有 knowledge-graph 先例） | `test/knowledge-graph.test.tsx` extended in place: the #116/#117 suites pass untouched plus the new `device similarity layer and interactive canvas (#99)` describe (5 tests incl. command validation through `RuntimeProcess`); new `test/graph-canvas-model.test.ts` (7 tests); new `local-runtime/tests/test_platform_knowledge_similarity.py` (7 tests); `test/security.test.ts` channel pin unchanged and green |

## Runs

- `npm run typecheck` — clean (both tsconfig.node.json and tsconfig.web.json).
- vitest full suite (`npm test`, includes the project-env gate): **658 passed
  (92 files), 0 failed** on the final candidate.
- Runtime pytest (`PYTHONPATH=local-runtime`) full suite: **1009 passed,
  10 skipped, 0 failed**.
- `python -m ruff check local-runtime --select E9,F63,F7,F82` — all checks
  passed. `npm run verify:provenance` exit 0; `python
  scripts/verify-runtime-source.py` exit 0.
- `npm run build` + `npm run test:desktop` (playwright `_electron` smoke) —
  exit 0, re-run after the review fixes.

## Honest notes

- The similarity layer is computed on demand and never persisted: "生成绑定
  库 Revision 并可查" is met as recompute-on-demand whose answer always
  names and re-verifies the frozen revision (the repo's derived-state
  accounting), not as a stored artifact. This also avoids the unresolved
  清除/重做 version-semantics question recorded in the linz research.
- The threshold slider is a display preference over the device-computed
  candidate set (baseline 0.05, `MAX_EDGES=2000` with `truncated: true`); it
  can only narrow, never widen beyond what the device stated.
- The entity graph merges same-name entities on the canvas because relation
  endpoints reference names only; the section's entity list still shows each
  declared row, so no platform fact is hidden (review judgement call).
- `_workspace_candidates` mirrors the #113 walk idiom (fourth site): a shared
  helper extraction is deferred to keep this diff off other issues' files
  (notably the unmerged #97 branch, which touches the same modules).
- The token set caps at the #112 import contract (200 documents × 50 MiB);
  Jaccard is O(pairs) with deterministic ordering, and the walk keeps the
  500-file scan bound.
- The first worktree `npm test` runs showed 19 failing live-bridge files: the
  fresh worktree lacked `.runtime` and the electron-builder NSIS cache; after
  `scripts/prepare-runtime.py` and cache seeding, the remaining intermittent
  failures (`grant-management` / `knowledge-publish` / `nsis-process-guard`,
  different files per run) were reproduced on unmodified develop under the
  same parallel load — pre-existing load flakes, not this diff. The final
  full-suite run was green (658/658).
- A two-axis review (Standards + Spec) ran before push; the two real findings
  — pointer math ignoring the viewBox mapping, and the similarity action not
  switching the graph family's revision context — are fixed in commit
  `48d699e` and covered by the model test and the family-reset semantics
  above.
