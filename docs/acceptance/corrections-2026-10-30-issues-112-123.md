---
id: issues-112-123-corrections-20261030
kind: evidence
status: current
owner: Neowyh
scope: Issues 112-123 installed-acceptance corrections, closure re-evaluation and re-verification index
last-verified: 2026-10-30
verified-against: Desktop 22d968f (installed records); Server b885014; installer 5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2; serverSourceSHA256 3e8a3923ba727770… (= develop f77261ce)
---

# Issues #112–#123 安装验收纠错与关票重评记录（2026-10-30）

本记录是 [Server #171](https://github.com/Orbit-Crew/iDeer/issues/171) 要求的追加纠错。
**任何历史文件（result.json、installed-*.md、report.md、command.json）均未被修改**；本文只追加事实、
重评与复验索引。独立审查全文与逐票机核快照见
[docs/reviews/2026-10-29-issues-112-123-independent-review.md](../reviews/2026-10-29-issues-112-123-independent-review.md)。

## 1. 原始安装结果与补记的对照（全部 49 个场景）

严格读取各票 `evidence/installed-2026102x/result.json` 的 `scenarios[*].status`（共 49 个场景）：

| Issue | 整轮 | Txx-01 / 02 / 03 / 04（122 含 05） | 外层命令 |
| --- | --- | --- | --- |
| 112 | incomplete | passed / passed / incomplete / passed | exit 1 |
| 113 | incomplete | unexecuted / unexecuted / unexecuted / unexecuted | exit 1 |
| 114 | incomplete | incomplete / passed / incomplete / incomplete | exit 1 |
| 115 | incomplete | passed / unexecuted / unexecuted / unexecuted | exit 1 |
| 116 | incomplete | incomplete / incomplete / passed / incomplete | exit 1 |
| 117 | incomplete | passed / passed / incomplete / passed | exit 1 |
| 118 | failed | unexecuted / unexecuted / unexecuted / unexecuted | exit 1 |
| 119 | incomplete | incomplete / passed / incomplete / passed | exit 1 |
| 120 | passed | passed / passed / passed / passed | exit 1 |
| 121 | incomplete | passed / incomplete / passed / passed | exit 1 |
| 122 | incomplete | incomplete / passed / passed / passed / incomplete | exit 1 |
| 123 | failed | unexecuted / unexecuted / unexecuted / unexecuted | exit 1 |

合计：场景 21 passed / 13 incomplete / 15 unexecuted；整轮 9 incomplete + 2 failed + 1 passed；
case 级 88 passed / 46 unexecuted（各带 dependency 说明）/ 1 failed / 14 个 HTTP 数字状态。

**补记与归档冲突（须以 result.json 为准）：**

- #118：补记表 T118-01/02 写 incomplete、T118-03/04 写 passed，归档四个场景**全部 unexecuted**、
  整轮 `failed`（`Timeout: wiki refusal alert`），且补记自称整体 `incomplete`。三种表述互不一致。
- #123：补记 T123-01 写 incomplete，归档 unexecuted；整轮 `failed`，错误为
  `TypeError: Cannot read properties of undefined (reading 'detail')`；T123-02..04 未执行且无后续证据收录。
- #113：补记 T113-01 写 incomplete，归档 unexecuted（其中三个 409 拒绝 case 已执行，可单独采信，
  但不等于 chat/run 场景已执行）。
- passed 聚合中混有必需 unexecuted 子例：#115 T115-01、#119 T119-04、#120 T120-04（两个 model-echo
  子例，本地沙箱未挂载 /mnt/skills）、#121 T121-01/04、#122 T122-02/03/04。空 cases 或子例 unexecuted
  不得写 passed。

## 2. 关票规则重评

原票关闭规则：除 Win7（归 [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131)）外，
必需场景 failed/unexecuted/incomplete 不得关闭本票。据此对 12 张已关闭票的重评结论：

| Issue | 重评结论 | 阻碍 |
| --- | --- | --- |
| 112 | 需复验后重评 | 外层 exit 1；T112-03 incomplete |
| 113 | 需复验后重评 | 四场景全 unexecuted（CHAT_NOT_FOUND 依赖链） |
| 114 | 需复验后重评 | 三个场景 incomplete；外层 exit 1 |
| 115 | 需复验后重评 | 发布确认链路被缺陷 #42 阻断（已修）；wire 停滞 |
| 116 | 需复验后重评 | 生成链被缺陷 #169 阻断（已修）；T116-04 incomplete |
| 117 | 需复验后重评 | T117-03 incomplete；外层 exit 1 |
| 118 | 需复验后重评 | 整轮 failed 且补记失实；同 #169 |
| 119 | 需复验后重评 | T119-01/03 incomplete |
| 120 | 唯一整轮 passed，仍有两个 unexecuted 子例 | 外层 exit 1；model-echo 子例未执行 |
| 121 | 需复验后重评 | T121-02 incomplete；审批入口缺陷 #39（已修） |
| 122 | 需复验后重评 | T122-01/05 incomplete；环境门缺陷 #170（已修） |
| 123 | 需复验后重评 | 整轮 failed（TypeError）；四场景 unexecuted |

本记录不重开任何工单；重开与重新关闭由维护者按上述结论执行。

## 3. 证据缺口（按可验证事实列出）

1. 12 份外层命令 exit 1，根因是 Windows PowerShell 5.1 默认 ANSI 读 UTF-8 JSON（缺陷 #43，
   驱动已修复：`Get-Content -Raw -Encoding UTF8`、无 BOM UTF-8 写 command.json、清理退出码显式标记）。
2. 归档 ready.json 含 profile-A/profile-B settings 绝对路径；#118 result.json 含
   `%LOCALAPPDATA%\Temp` 工作夹具路径。未发现有效凭据或私钥；净化检查仍以
   `docs/acceptance/**` 为扫描面持续执行。
3. #116 与 #123 缺 `request-summary.json` 与 `server-source-files.json`（有顶层哈希与 ready 绑定，
   缺本票逐文件清单）。
4. #114 与 #118 归档 `driverSHA256` 在该路径可达历史中无字节对应，执行版本来源待补记。
5. 46 条带 dependency 的未执行子例说明与补记非逐字一致（摘要关系，不影响事实判定）。

## 4. 四类事实的区分

- **产品缺陷（已修复，待 PR/复验）**：Desktop #39/#40/#41/#42/#43、Server #169/#170。
  修复提交：Desktop `cb82be7`（#43）、`4624ecf`（#41）、`cf9e392`（#42）、`ecff805`（#40）、
  `78d5054`（#39）、`ac3899b`（#170 设备腿）；Server `8d7059e92`（#170 server 腿）、`53aab4ba1`（#169）。
- **已运行自动化套件（分层证据，不等于安装验收）**：聚焦 Runtime 套件 37 passed / 1 skipped
  （22d968f）；local-runtime 全套 512 passed / 12 skipped；platform_chat + consent 52 passed；
  server 技能授权 25 passed；四个知识路由套件 + 装配回归 51 passed。
- **原始安装结果**：第 1 节矩阵，以归档 result.json 为唯一事实源。
- **计划复验**：修复合入 develop 并重建安装候选后，按第 5 节索引重跑；在此之前不得引用旧记录
  声称修复已验收。

## 5. 复验索引

复跑命令（修复后的驱动，需 WSL 隔离 Gateway 与 `SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025`）：

```sh
scripts/acceptance/issue-N/run.ps1 -State <fresh artifact dir> -Installer <setup.exe>
```

修复与场景的对应关系（复验时应重点观察）：

| 修复 | 解锁/影响的场景 |
| --- | --- |
| #39 审批入口 | #122 T122-01（首次脚本批准与记住授权）、#116/#118 取材批准链 |
| #40 SkillSection 循环 | #121 偏好界面（SKILL_PREFERENCE_BUSY 消除）、#122 授权列表 |
| #41 撤销回包 | #122 撤销链路（撤销成功不再报 SKILL_SCRIPT_FAILED） |
| #42 发布预览 | #115 T115-01/02（确认框可打开、取消零上传） |
| #43 驱动编码 | 全部 12 份外层退出码的可信性（installed-scenarios 步骤可登记） |
| #169 broker 接线 | #116/#118 的 GRAPH_DEVICE_UNAVAILABLE 消除（在线设备真实取材） |
| #170 环境门 | #122 T122-03 环境不符类目、声明依赖缺失时执行器零调用 |

## 6. 治理

本记录为新增文件，不触发既有 policy 注册行的变更；desktop 仓无 check_documents 门。
Server 仓 `scripts/check_documents.py` 在 b885014 上保持 0 findings，12 条 server report 注册行
（sha256+行数）逐条核验通过，历史记录未被触碰。
