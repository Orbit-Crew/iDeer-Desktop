---
id: issue-100-wiki-navigation-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 100 Desktop side of the wiki graph navigation — overview and neighborhood canvas, frozen source positions, clear/rebuild display semantics, and the component tests
last-verified: 2026-11-07
verified-against: feat/issue-100-wiki-navigation working tree on top of 29df1e2 (= origin/develop); every command below ran in the isolated worktree exactly as committed
---

# Issue 100 Desktop acceptance

The candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-100-wiki-navigation`, branch
`feat/issue-100-wiki-navigation`, based on `origin/develop` (`29df1e2`).
The directory is `issue-100-wiki-navigation` because `docs/acceptance/issue-100/`
belongs to the iDeer repo issue of the same number (same convention as
`issue-115-cad-viewer` and `issue-97-bm25-index`).

## Implemented surface

- `src/renderer/src/components/wikiGraphModel.ts` (new): the deterministic
  wiki graph model over the Server's navigation projection. Overview lays
  every page on one circle in frozen manifest order; the neighborhood
  centers the selected page and rings its one-hop and two-hop closure over
  resolved links and backlinks (the original linz ego switch's depth 2),
  capped at 60 nodes. Edges come from `links` only — backlinks are their
  exact inverse and are walked, not redrawn; a link between two pages that
  reference each other stays two opposite directed edges; an unresolved
  target never becomes a node or an edge. Node radius grows with visible
  relations only. `wikiSourceLine` renders
  `来源 {filename} · 冻结位置 {i}/{n} · 文档指纹：{sha256}` — the position is
  the manifest order, the only location the platform states for a
  per-document page; no in-document locator is invented.
- `src/renderer/src/components/WikiGraphCanvas.tsx` (new): fixed SVG
  projection of the model — nodes colored by their honest page status,
  sized by visible relations, directed edges with arrows, selected-node
  ring, per-node relation count tooltip. No physics engine, no randomness.
- `src/renderer/src/components/WikiGraphPanel.tsx` (new): the 概览/邻域
  Segmented switch, status legend, canvas, and the selected node's frozen
  source line. Clicking a node selects it; a completed page is read through
  the existing per-page read seam; a skipped or failed page only becomes
  the selection and keeps its status visible — never a body.
- `src/renderer/src/components/WikiSection.tsx`: embeds the panel above the
  page index; both page lists annotate the frozen source position;
  清空展示状态 (Popconfirm) clears only this device's derived display state
  via the new optional `onClear` — the confirm copy states that Server
  pages stay, a re-view shows them again, and a rebuild replaces each page;
  the per-revision generate button reads 重新生成 once that revision's
  displayed state is not `not_generated` (the Server performs generate as
  an idempotent per-document drop-and-rewrite from the frozen manifest).
- `src/renderer/src/components/RuntimePanel.tsx`: wires `onClear` to reset
  the wiki view, navigation index, and open page body. No bridge, IPC,
  preload, shared-type, main-process, or runtime change; no new dependency;
  `test/security.test.ts` channel lists untouched.

## Acceptance evidence

All commands ran with Node 22.23.4 from the project cache in the worktree,
after `npm run runtime:prepare` (bundled CPython 3.12.10) for the live
bridge cases.

- `npx vitest run test/wiki-graph-model.test.ts` — 9 tests: overview nodes
  carry honest statuses and 1-based manifest positions; layout is
  deterministic (same input → same graph); one page sits at the canvas
  center; edges derive from resolved links without duplicating a link row
  that a backlink also names; mutual references stay two directed edges;
  the neighborhood walks exactly two hops from the requested (or first
  completed) center; a skipped page inside the closure keeps its status;
  the closure stays ≤ 60 nodes under a 120-page hub; `wikiSourceLine`
  pins the position annotation.
- `npx vitest run test/wiki.test.tsx` — 17 tests, the pre-existing #118/#119
  describes kept green plus the new #100 describe: the overview canvas
  renders every page node with the status legend and frozen source
  positions; a completed node click issues exactly
  `{action:'read', kbId, revisionId, documentId}`; a skipped node click
  issues nothing; switching to 邻域 drops the unrelated page while keeping
  the selected page and its linked page; 清空展示状态 fires `onClear` only
  after the explicit 确认清空 confirm; a displayed revision offers
  重新生成 while an unshown one offers 生成Wiki.
- `npm run typecheck` — clean (node + web tsconfig).
- `npx vitest run` (full renderer/main suite) — 660 passed, 1 failed:
  `test/nsis-process-guard.test.ts`, which fails identically on the base
  checkout (`29df1e2`, main workspace) on this machine — a pre-existing
  environment failure (child-process result shape), unrelated to this
  change. `test/receipt-history.test.ts` failed once under full-suite load
  and passes in isolation on both the candidate and the base.
- `npm run test:runtime` (`PYTHONPATH` pointed at the worktree's
  `local-runtime`) — 1003 passed, 9 skipped; no runtime change is claimed
  by this ticket.

## Coverage limits

- Component- and model-level acceptance only: the platform wiki endpoints
  themselves are not exercised live from this candidate (no authenticated
  Server round-trip was run in this session); the projection contract those
  tests build on is pinned by `local-runtime/tests/test_platform_wiki.py`
  (old-numbering #118/#119, unchanged here).
- The graph is a display surface over the Server's navigation payload; link
  extraction, backlink inversion, and status aggregation remain the
  Server's authority and are not re-implemented locally.
- No installer run and no Win7 verification; `dist:win` packaging stays a
  recorded-pending step as in prior knowledge tickets.
