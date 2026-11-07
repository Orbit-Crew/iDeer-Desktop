# Issue #100 two-axis review (before final commit)

Diff reviewed file by file: `git diff 29df1e2...HEAD` over 3 modified + 4 new
source/test files (commit 4705f25), re-read against the acceptance criteria,
the neighboring implementations (KnowledgeGraphSection, the doc library pane),
the gap-analysis K05 line, and the original linz wiki components. Two
independent agents reviewed Standards and Spec in parallel; their findings and
the dispositions applied before the final commit follow. After the fixes:
typecheck clean, wiki tests 27/27.

## Standards

No documented-standard violations. Baseline smells (all judgement calls) and
dispositions:

1. **Comment claims nonexistent behavior (must-fix, fixed).** The canvas
   comment promised hover highlighting that does not exist, and the local
   `highlight` set named nothing it did. Comment rewritten to what the canvas
   does; the set is now `relations` and only feeds the honest per-node
   relation-count tooltip.
2. **Duplicated edge-extraction shape (fixed).** `buildOverview` and
   `buildNeighborhood` shared the rows→links→included→dedup walk; extracted
   as `extractEdges(rows, included)`, one shape, both callers.
3. **Duplicated status color map (fixed).** `STATUS_COLORS` (canvas) and
   `STATUS_DOT` (panel) collapsed into one exported
   `WIKI_STATUS_COLORS: Record<WikiPageSummary['status'], string>` in the
   model module; the panel derives its legend dots from it. The test-fixture
   duplication across the two wiki test files stays: each file keeps its own
   small fixtures for isolation, matching the repo's test idiom.
4. **Weak typing of the status maps (fixed).** The panel's maps are now
   `Record<WikiPageSummary['status'], string>`; the read command the panel
   issues is typed `WikiReadCommand = WikiCommand & { action: 'read' }`.
   (An `Extract<WikiCommand, …>` variant compiled to `never` — `WikiCommand`
   is a single interface, not a discriminated union.)
5. **`depth` field overload (fixed).** Overview entries no longer fake
   `depth: 0` to center a single page; placement decides the center
   explicitly (`entry.depth === 0 || (mode === 'overview' && pages.length === 1)`),
   and the unreachable `radius === 0` guard is gone (`ringPosition` documents
   its `count >= 1` precondition).
6. **Overview scale (noted, not changed).** The navigation projection itself
   caps the payload at 200 pages; the radius formula saturates at 300, so a
   200-page overview is crowded but usable and deterministic. The model
   comment now states the 200-page source bound; a denser layout is a
   display preference, not part of this ticket.

## Spec

The reviewer judged 清空 (display-state-only clear behind an explicit confirm
with honest copy) compliant given the verified no-DELETE gateway, and 位置
(manifest position) compliant given the payload carries no in-document
locator. Findings and dispositions:

1. **Truncated closure was silent (fixed).** The 60-node neighborhood bound
   cut pages without saying so. The panel now shows 邻域已达 60 页上限…
   完整范围见下方页面索引 whenever the bound applies, pinned by a test.
2. **生成Wiki label after 清空 (accepted, documented).** After a clear the
   button reads 生成Wiki again although Server pages persist. The label
   describes the action, never claims prior state; the confirm copy carries
   the honest Server-side sentence. Changing the label would require the
   renderer to remember cleared state, exactly what 清空 removes.
3. **冻结位置 assumes manifest order (accepted, inherited contract).** The
   Server builds both page lists from `manifest_entries(revision)` in order;
   the ordering is pinned by `local-runtime/tests/test_platform_wiki.py`
   (unchanged here). The model doc comment states the assumption.
4. No scope creep of substance: no bridge/IPC/shared-type/dependency change,
   `test/security.test.ts` channel lists untouched.

Standards: 1 must-fix + 4 actionable smells, all fixed. Spec: 2 findings
fixed, 2 accepted with written dispositions, 0 unresolved.
