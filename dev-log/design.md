# Issue #100 design decisions (settled before code)

## D1 — Renderer-only surface; no bridge, IPC, or platform changes

The Server's wiki navigation endpoint
(`GET …/knowledge-revisions/{rid}/wiki/navigation`, built for old-numbering
#119) already projects everything the graph needs: pages with honest
`completed/skipped/failed/not_generated` statuses, resolved links, explicit
missing targets, backlinks as the exact inverse of links, and the frozen
document sources. The gap analysis (K05) names the Desktop gap as the
canvas/organization, not the protocol. So #100 adds zero protocol surface:
no `WikiCommand` action, no `src/shared/desktop.ts` type, no
`runtime.ts`/`desktop.py`/`platform_chat.py` change, no
`test/security.test.ts` channel-list update. This also keeps the branch
conflict-free against the two open knowledge PRs (#153/#154), which do touch
those files.

## D2 — Deterministic graph model, no layout engine

`wikiGraphModel.ts` derives nodes/edges/positions purely from the navigation
payload: overview lays every page on one circle in manifest order; 邻域
centers the selected page and rings its one-hop and two-hop closure over
links ∪ backlinks (mirroring the original linz ego mode's depth 2), capped
at 60 nodes. No cytoscape/d3 dependency (the pinned dependency list in
`test/security.test.ts` must not grow), no randomness, no animation — the
same index always draws the same picture, which is what makes the model
unit-testable. Node radius grows with visible relations only (edges among
rendered nodes), so size always names what is on screen.

Honesty rules carried over from the text index: an unresolved link target
never becomes a node or edge (it stays an explicit dead end in the page
rows below the canvas); a skipped/failed page in the closure renders with
its own status color and is never clickable into a body; backlink rows are
not drawn as second edges — edges come from `links` only, and the closure
walk uses backlinks purely to reach referencing pages.

## D3 — 清空/重建 semantics with the Server as owner

The original linz wiki stored pages locally, so 清空 deleted them. On the
platform, pages are Server-owned per frozen revision and the gateway has no
DELETE wiki route (verified: only POST generate, GET view/page/navigation).
The honest Desktop translation, matching "生成绑定库 Revision，清空后可重建":

- 清空展示状态 (Popconfirm): clears only this device's derived display
  state (view, navigation, page bodies in `RuntimePanel`) via `onClear`.
  The confirm copy states that Server pages stay, a re-view shows them
  again, and a rebuild replaces them per page — the surface never claims a
  Server deletion that did not happen.
- 重建: the existing `generate` action, which the Server performs as a
  per-document drop-and-rewrite (idempotent rebuild of every page from the
  frozen manifest). The per-revision button reads 重新生成 once that
  revision's displayed state is not `not_generated`, and 生成Wiki before.

## D4 — 来源标注到文档与位置

`wikiSourceLine` renders `来源 {filename} · 冻结位置 {i}/{n} · 文档指纹：
{sha256}` on both page lists and the selected node. The position is the
row's index inside the revision's frozen manifest order — the only honest
"位置" the platform states (pages are generated per whole document; the
payload carries no in-document locators, and none are invented). The
association coverage rows keep their existing format: they are the #116
graph rows' own sources, already document- and digest-bound.

## D5 — Component structure and state

`WikiGraphPanel` owns the two display-only states (mode, selected node) as
local component state; they are view preferences, not data, and reset
naturally when the panel unmounts (each 清空/view/navigate swap in
`RuntimePanel` does exactly that). `WikiSection` stays a projection of its
props, gaining only the optional `onClear` callback and the 重新生成 label
decision. Tests follow the file's existing split: static markup via
`renderToStaticMarkup` for projections, jsdom + `@testing-library/react`
interactions for the new behaviors (the file gains the `@vitest-environment
jsdom` header; `renderToStaticMarkup` works unchanged under jsdom).
