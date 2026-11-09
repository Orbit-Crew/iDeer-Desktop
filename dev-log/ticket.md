# Ticket: Issue #120 [六期·47] Win7 能力矩阵与专项收尾

## Session facts (read first)

- Work tree: `G:/code/iDeer-worktrees/issue-120-win7-capability-matrix`, branch
  `feat/issue-120-win7-capability-matrix`.
- Base: **integration base** — develop 9845dab merged with
  origin/feat/issue-119-installer-components (PR #162), then
  origin/feat/issue-88-third-party-verification (PR #163), then
  origin/feat/issue-89-acceptance-ledger (PR #164). #120 is formally blocked by
  #119/#88/#89-ledger infrastructure, whose PRs were green+CLEAN but unmerged at
  session start; the stacked base unblocks the matrix without merging on anyone's
  behalf. Merge order for maintainers: #162/#163/#164 first, then this PR.
- Node: `C:\Users\Neo\.ideer-tools\node22` prepended to PATH (22.14.0); repo npm
  scripts self-initialize the project env. `npm ci` run fresh in the worktree.
- No Python changes; pytest baseline (1076 passed / 9 skipped) is re-run on the
  integration base with `npm run test:runtime` after `runtime:prepare`.

## Full issue text (Orbit-Crew/iDeer-Desktop#120)

> ## Parent
>
> [linz 全量能力等价：iDeer Desktop 总规格](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)（六期：工程+Win7+迁移收尾）
>
> ## What to build
>
> Win7 能力矩阵与专项收尾：能力×系统（现代 Windows/Win7）矩阵逐格验收；先现代 Windows 全量验收，Win7 真机专项放最后；上不了 Win7 的能力逐项明示（不硬凑、不默默砍）；沿用 iDeer #131 退役三条件。
>
> ## Acceptance criteria
>
> - [ ] 能力矩阵建立并覆盖全部 46 项能力
> - [ ] 现代 Windows 全量验收完成并记账
> - [ ] Win7 真机专项按矩阵执行，结果如实
> - [ ] 未达标能力逐项明示（无静默缩范围）
> - [ ] 与 #131 退役条件的对照记录更新
>
> ## Blocked by
>
> - [六期·40 CAD 查看器](https://github.com/Orbit-Crew/iDeer-Desktop/issues/115)（已关）
> - [六期·42 结果自动开窗](https://github.com/Orbit-Crew/iDeer-Desktop/issues/117)（已关）
> - [六期·45 安装向导按需勾选](https://github.com/Orbit-Crew/iDeer-Desktop/issues/119)（PR #162 待合并）
> - [六期·46 第三方资源核验与维护者清单](https://github.com/Orbit-Crew/iDeer-Desktop/issues/88)（PR #163 待合并）

## Scope decision

AC1/AC4/AC5 are delivered here (matrix established over all 46 capabilities with
per-cell execution entries; below-bar itemized by the verifier; retirement
cross-reference recorded). AC2 is established as accounting only — its
completion needs an installed candidate run across scenarios and stays honestly
open. AC3 needs the real Win7 machine and stays unexecuted per issue order
(专项放最后). The matrix never claims candidate acceptance that has not run:
zero cells are 已验收 at initial accounting, 46/46 below bar, printed per row.
