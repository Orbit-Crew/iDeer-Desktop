---
id: issue-120-win7-matrix-foundation
kind: evidence
status: current
owner: Neowyh
scope: Issue 120 能力×系统矩阵的建立、机器校验与如实初记账（AC1/AC4/AC5 交付；AC2 记账就绪未完成；AC3 未执行）
last-verified: 2026-11-09
verified-against: feat/issue-120-win7-capability-matrix 集成基座（develop 9845dab + PR #162/#163/#164 分支合并，HEAD 6052c4c）；证据产自同一工作树 G:\code\iDeer-worktrees\issue-120-win7-capability-matrix
---

# Issue 120 能力×系统矩阵——建立与初记账验收

The directory is named `issue-120-win7-matrix` because `docs/acceptance/issue-120/`
holds the unrelated old-numbering (iDeer-repository issue 120, skill import)
records — the same collision pattern as `issue-115-cad-viewer` and
`issue-97-bm25-index`.

## Delivered surface

[system-matrix.md](../system-matrix.md) defines the capability × system
vocabulary; [system-matrix.json](../system-matrix.json) is the machine-readable
48-row × 2-system single source; `scripts/verify-system-matrix.cjs`
(`npm run verify:matrix`) enforces the contract and itemizes the below-bar list;
[retirement-conditions.md](../retirement-conditions.md) maps the matrix outcome
to the iDeer #131 three retirement conditions.

| Issue criterion | Status | Evidence and remaining work |
| --- | --- | --- |
| 能力矩阵建立并覆盖全部 46 项能力 | complete (establishment + machine verification) | 48 行与 #89 台账逐行锁步（46 能力 + 2 治理，行集合由 `verify:ledger` 的枚举权威约束，矩阵不另行枚举）；每格登记四类执行入口；`npm run verify:matrix` 48 rows × 2 systems 通过；16/16 失败模式测试（test/system-matrix.test.ts）固定契约。 |
| 现代 Windows 全量验收完成并记账 | partial (accounting established; acceptance unexecuted) | 记账已建立且如实：modernWindows 列 = 台账候选层切片（未执行 6 / 未记录 41 / 不适用 1 治理行），与台账锁步校验强制一致。**全量验收本身未执行**——每格执行入口已登记（automated 测试路径、`npm run dist:win`、人工走查路径），完成需按入口跑候选场景（部分为人工 GUI），留待候选包轮次。AC 复选框保持未勾。 |
| Win7 真机专项按矩阵执行，结果如实 | unexecuted (by issue order) | win7 列 46 项能力全部如实 `未执行`，每格带 T131-02…06 / W7-01…08 场景锚点；真机专项放最后（题意），需真实 Win7 硬件与专业软件/许可（#131 T131 专项，维护者持有环境）。本票不冒充任何 Win7 结论。 |
| 未达标能力逐项明示（无静默缩范围） | complete (machine-derived) | `npm run verify:matrix` 逐行打印 below bar 46/46（`- p1-01 Dock 多窗格框架与布局预设` … `- p6-46 第三方资源核验与维护者清单`）；初记账零格已验收如实声明于框架文档。 |
| 与 #131 退役条件的对照记录更新 | complete (cross-reference recorded) | [retirement-conditions.md](../retirement-conditions.md)：三条件逐条现状（①未达成 ②③未开始，无代签）；T131-01 追溯矩阵行来源与 T131-06 能力矩阵载体的衔接写明；条件①随 verify:matrix 自动重算。 |

## 初记账的不变量（校验器强制）

- modernWindows 格状态 ≠ 台账候选层状态 ⇒ 必须带 note（初记账零分歧）。
- `未记录`/`不适用` 格零证据零日期；`未执行` 格证据可选但入口必须登记。
- 能力行在 win7 列宣告 `不适用` 必须附树内不兼容分析证据（不硬凑）；
  modernWindows 列能力行不得退出。
- 工单 open/closed 与实现分支是否并入 develop 都不是证据：#98/#103/#87/#118/#119/#88
  六行如实 `未记录`，入口注明"PR 并入后执行"。

## Commands and results

Windows 11 host, Git Bash, pinned Node 22.14.0 (`C:\Users\Neo\.ideer-tools\node22`),
fresh worktree with `npm ci`, `runtime:prepare` (Python 3.12.10), and
`.cache/electron-builder` + `.cache/electron` seeded from the main checkout
(a fresh worktree lacks makensis until electron-builder fetches it — the two
nsis test failures below were this environment gap, not a regression).
pytest run with `PYTHONPATH=<worktree>/local-runtime` (dev-log convention;
without it the stale conda site-packages copy resolves `core.*` and 12
collection errors follow).

- `npm run verify:matrix` — `system matrix verified: 48 rows × 2 systems, modern 已验收 0, win7 已验收 0` + below bar 46/46 逐行明示。
- `npm run verify:ledger` / `verify:third-party` / `verify:provenance` — 48 行 / 92 项 / f88141bb 全部通过（在集成基座上、任何 #120 工作开始前已验证一轮，见 merge commit 信息）。
- `npm run typecheck` — clean（tsconfig.node + tsconfig.web）。
- `npm test`（vitest 全量）— 810 中 804 绿。6 失败隔离重跑 25/25 全过：`nsis-components`/`nsis-process-guard`（缓存播种前，环境缺口）、`browser-slot`（10s 超时）、`session-sidebar`（5s 超时，基线即有的并行负载敏感类，PR #162/#163 有同款记录）、`grant-management`/`knowledge-publish`（隔离全过）。CI 独立跑者为权威。
- `npm run test:components` — **27/27**（真实 makensis 编译 + 静默安装/卸载矩阵，缓存播种后）。
- `npm run test:runtime`（pytest 全量）— **1076 passed / 9 skipped / 0 failed**（674s；Python 面零改动，develop 基线 1076/9 沿用）。
- `npm run dist:win` — 产出 `dist/ideer-desktop-0.2.0-windows-x64-setup.exe`，
  SHA-256 `BD7CDB33A9FDDFBB3CD5BB3CD0638C12E620B3DBFEE72B1095116D5A0869FEBC`
  （候选构建证据：三方集成分支可完整出包；`win-unpacked/resources/components/components-lock.json`
  appVersion 0.2.0 在位、`win-unpacked/resources/occt` 不存在——#119 的"未选不装"行为在合并树上完好）。
  该包是候选件，未经人工门（linz-license-grant）不得对外分发；矩阵任何格子都不因本次构建而翻状态。

## What this record does not claim

- 不声称任何能力在任一系统完成候选验收（两列零 `已验收` 是如实状态）。
- 不声称 Win7 任何结论；现代 Windows 证据不替代 Win7（#131/validation.md 规则）。
- 不复制 #131 场景记录；条件②③的确认必须来自本人（retirement-conditions.md 更新协议）。
