# Ticket: Issue #100 [三期·21] Wiki 双链与邻域导航

## Session facts (read first)

- Work tree: `G:/code/iDeer-worktrees/issue-100-wiki-navigation`, branch
  `feat/issue-100-wiki-navigation`, base `29df1e2` (= origin/develop).
- Work happens only inside this work tree. Node: prepend
  `G:/code/iDeer-Desktop/.cache/node-dist/node-v22.23.4-win-x64` to PATH; repo
  npm scripts self-initialize the project env.
- Runtime tests: `npm run test:runtime` after `npm run runtime:prepare`; any
  pytest invocation needs `PYTHONPATH=G:/code/iDeer-worktrees/issue-100-wiki-navigation/local-runtime`
  so the worktree source is tested, never the stale conda site-packages copy.

## Full issue text (Orbit-Crew/iDeer-Desktop#100)

> ## Parent
>
> [linz 全量能力等价：iDeer Desktop 总规格](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)（三期：知识）
>
> ## What to build
>
> Wiki 双链与导航恢复：自动 Wiki 页面、双链/索引/来源、概览与邻域图导航；生成绑定库 Revision，清空后可重建。
>
> ## Acceptance criteria
>
> - [ ] Wiki 页面生成、双链与索引可用
> - [ ] 来源标注到文档与位置
> - [ ] 概览与邻域图导航可用
> - [ ] 清空/重建可用且状态如实
> - [ ] 组件测试扩展（既有 wiki 测试先例）
>
> ## Blocked by
>
> - [三期·17 文档库管理页](https://github.com/Orbit-Crew/iDeer-Desktop/issues/96)

## Coverage plan (how each criterion is pinned)

- Wiki 页面生成、双链与索引可用 — already delivered by #118/#119 (old
  numbering, commits 5b9f306/0fc854d) and pinned by the existing
  `test/wiki.test.tsx` describes; this ticket keeps them green.
- 来源标注到文档与位置 — `wikiSourceLine` (`test/wiki-graph-model.test.ts`,
  `来源 guide.txt · 冻结位置 1/2 · 文档指纹：<sha256>`) rendered in both page
  lists and the graph's selected-node line.
- 概览与邻域图导航可用 — `buildWikiGraph` overview/neighborhood tests +
  `test/wiki.test.tsx` canvas interactions (node click reads, skipped node
  never opens, 邻域 drops unrelated pages).
- 清空/重建可用且状态如实 — 清空展示状态 Popconfirm → `onClear` resets the
  renderer's derived state only (Server pages stay, copy says so); 重新生成
  is the Server's per-document idempotent rebuild, labeled per shown state.
- 组件测试扩展 — `test/wiki.test.tsx` extends the existing wiki test file
  (jsdom + testing-library), `test/wiki-graph-model.test.ts` pins the model.
