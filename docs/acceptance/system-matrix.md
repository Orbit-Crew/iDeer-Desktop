---
id: system-capability-matrix
kind: framework
status: current
owner: Neowyh
scope: Issue 120 能力×系统矩阵（现代 Windows / Win7）的词汇、执行入口登记与更新协议；机器可读矩阵为 system-matrix.json（与 #89 台账锁步），本文不复制行数据
last-verified: 2026-11-09
verified-against: 集成基座（develop 9845dab + PR #162/#163/#164 分支）；各格执行入口以矩阵行内登记为准
---

# 能力×系统矩阵（#120）

[总规格 #70](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70) 的收尾票
[#120](https://github.com/Orbit-Crew/iDeer-Desktop/issues/120) 要求按
**能力 × 系统（现代 Windows / Win7）** 逐格验收：先现代 Windows 全量验收，
Win7 真机专项放最后，上不了 Win7 的能力逐项明示，并沿用
[iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131) 的退役三条件
（对照记录见 [retirement-conditions.md](retirement-conditions.md)）。
**机器可读矩阵 [system-matrix.json](system-matrix.json) 是系统轴的单一事实源**；
每格记录验收状态与执行入口登记，本文只定义词汇与规则。

## 系统轴

| 系统 | 定义 | 规则来源 |
| --- | --- | --- |
| `modernWindows` | 开发与 CI 主机环境（Windows 10/11 x64）上的**安装候选**验收列 | docs/validation.md 的现代 Windows 命令面 |
| `win7` | 退役目标真机（系统/SP/位数/GPU/驱动逐项记录）上的**最终候选**验收列 | iDeer #131 T131-02…06 与 docs/validation.md 的 W7-01…08 |

**现代 Windows 结果不能替代 Win7**（#131 明文，validation.md W7 表同样约束）；
两列各自独立记账，`win7` 列的候选 precondition 是最终安装包（执行入口统一含
`npm run dist:win` 登记，具体包哈希在证据落地时绑入证据文件，不入矩阵）。

## 与 #89 三层台账的关系

[capability-ledger](capability-ledger.md) 记账 **层 × 能力**；本矩阵记账
**系统 × 能力**，且 modernWindows 列是台账 `candidateAcceptance` 层在系统轴上的切片：

- 矩阵行集合不另行枚举——校验器直接读台账 JSON 对账（行数、id、kind、name 逐项锁步），
  #70 子票集合变动由 `verify:ledger` 拦截，矩阵与台账的漂移由 `verify:matrix` 拦截。
- modernWindows 格状态必须等于台账候选层状态；**确有分歧时须在该格 note 说明原因**
  （例如台账更新滞后于新证据），无 note 的分歧即报错。矩阵永远不领先于台账叙事。
- 台账的入口恢复/业务接线两层不在矩阵中出现；开发树与 CI 的绿色不改变任何格的状态。

## 状态词汇（与 #131 场景四态对照）

格状态沿用台账候选层的封闭五态；#131 的逐场景四态在证据文件内逐场景记录，
落格规则如下：

| 格状态 | 判定 | 对应 #131 场景态 |
| --- | --- | --- |
| `已验收` | 绑定候选的场景通过记录齐全 | passed |
| `部分验收` | 部分场景通过、其余未执行/未完成/失败（失败证据以专票报告承载） | incomplete（含 failed 场景在案） |
| `未执行` | 有跟踪文档明示未执行（格内可引用该文档） | unexecuted（有登记） |
| `未记录` | 无任何安装层记录 | unexecuted（无登记） |
| `不适用` | 仅治理行可用；能力行在 win7 列逐项明示除外 | — |

- `未记录` 格必须零证据、零日期，但**必须登记执行入口**（下面第三节）——登记不是证据。
- `未执行` 格可引用记载非执行事实的文档（与台账候选层同规），也必须登记执行入口。
- `已验收`/`部分验收` 须至少一条树内证据路径与 `lastVerified` 日期。
- `不适用`：modernWindows 列对能力行一律禁止（现代 Windows 必须先试）；
  win7 列允许能力行逐项明示"上不了 Win7"，但**必须附树内不兼容分析证据**（不硬凑），
  治理行则须 note 说明原因。

## 执行入口登记（entries）

每格 `entries` 登记能产出该格验收结论的入口，四类封闭：

| kind | ref 约束 | 例 |
| --- | --- | --- |
| `automated` | 树内存在且仓库相对的自动化入口（测试/驱动脚本） | `test/dock-store.test.ts` |
| `command` | package.json 脚本白名单内的固定命令 | `npm run dist:win` |
| `scenario` | iDeer #131 场景（`T131-NN`）或 desktop W7 表（`W7-NN`） | `T131-06` |
| `manual` | 1–160 字的人工路径描述 | `候选包安装后人工走查八种排列预设与重启布局恢复` |

win7 列的开放格（`未执行`/`未记录`）必须含至少一个 `scenario` 入口——
真机专项未开始，不等于没有登记好的执行方式；这正是 #131 T131-01
"逐项登记责任人与执行入口"在矩阵里的落点。

## 初记账如实声明（2026-11-09）

- modernWindows 列 = 台账候选层切片：`未执行` 6、`未记录` 41、`不适用` 1（治理行 #89）。
- win7 列 = 全部 `未执行`（含 #120 自身的 `T131-01` 锚点；#89 治理行 `不适用`）。
- **两列零格 `已验收`；46 项能力全部未达标**（校验器逐项打印，无静默缩范围）。
  这是收尾票的如实现状，不是缺陷：候选包验收自 #89 框架建立以来尚未在任何系统执行。
- 实现分支未并入 develop 的行（#98/#103/#87/#118/#119/#88）其 modernWindows 格如实
  `未记录`，执行入口注明"实现分支 PR 并入后执行"；矩阵不预支未合并分支的结论。

## 更新协议

1. 台账先行，矩阵随动：候选验收跑完后先按台账协议更新 `candidateAcceptance`，
   modernWindows 格随之对齐（不一致必须写 note 并说明原因与日期）。
2. win7 格随真机专项（#131 T131-02…06）推进逐格翻状态；翻格的证据绑定最终候选包
   事实（安装包 SHA-256、系统版本、执行日期），写入专票/收尾报告后由格内引用。
3. 只更新证据实际触达的格；禁止批量翻状态；`未记录`→其他状态的唯一途径是新证据。
4. 能力行宣告 win7 `不适用` 的唯一途径：树内提交不兼容分析证据 + note，校验器放行。
5. 每次变更跑 `npm run verify:matrix`；校验不过不得合入。

## 校验

```powershell
. .\scripts\project-env.ps1   # 直接调工具时先初始化环境
npm run verify:matrix         # 校验 schema、台账锁步、状态词汇、执行入口登记、未达标清单
npx vitest run test/system-matrix.test.ts       # 校验器失败模式测试（内存夹具，不动仓库树）
```

CI 接入：static-and-contract 车道在 `verify:third-party` 之后运行 `verify:matrix`。
#89 台账自身（verify:ledger）的 CI 接线是 #89 的后续项，本票不代接。
