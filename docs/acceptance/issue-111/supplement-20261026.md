# #111 最终安装包逐场景复验

本轮执行日期为 2026-10-26，Asia/Shanghai。自动执行人为 Codex，人工登录及签核人为本会话用户。自动验收、完整 Server 门禁、人工浏览器登录及最终人工签核均已完成，本候选的现代 Windows 一期文件范围验收为 passed。首次人工尝试遇到临时前端配置问题，修复后在全新安装和隔离环境中复验通过。结论不扩展到真实 Win7，也不表示相关 PR 已合并。

## 候选、环境与复用条件

Desktop 执行基线为 `8d17d16e816456096bb8f37ddb496b8a7ac84443`，本轮分支 `codex/issue-111-acceptance`，包含 #108 产品修复 `d17721cb6950ba4eb2457c4d2ccc3c0fae5c4a17`。本轮仅补验收驱动和记录，没有产品源码修改或重建安装包。逐文件记录见 [candidate-binding.json](evidence/supplement-20261026/candidate-binding.json)。

验收驱动及报告提交为 `92b82557bd994f196f3147dfd9c9a12b739d8527`。237 个实际源文件/驱动与提交字节的核对及 Git 换行说明见 [publication.json](publication.json)；后续提交仅补发布与人工签核记录。

- 最终安装包 `ideer-desktop-0.2.0-windows-x64-setup.exe`，92,395,057 字节，SHA-256 `b04e83d30a1230d46b909c72caeba1cad55793b2e52c81fc617a4705f9fe370d`。各组均实际 NSIS 安装到新的 TEMP 目录，并使用独立 `--user-data-dir`。
- Desktop 的 160 个产品、测试和构建文件指纹为 `8f8c87ee4d9cd1e4e4ea53bb0338f3d90882312ef1bf2d7cb5deabf2b234253a`，与 [#108 最终候选](../issue-108/timeout-resolution-20261026.md)一致。typecheck、94 个 Vitest、400 个 Runtime 测试及 6 个 skip、ruff、provenance、实际 Windows 打包采用该完全相同输入和包的已有记录，不宣称本轮重新运行这些公共门禁。
- Server 最初为 `7079f760de39d946babaca0c0ef72c865e86a2de`，门禁修复后为 `dc5383266516438c3edfab0bcecff8b968cd3edc`。差异只有根目录 AGENTS.md 与 CLAUDE.md 的规范块。两者应用、测试及构建输入指纹均为 `d8d3a6e8325b86ccea1972cdbc19d2bfc1bdb3891092eda5133d59e69eb2c19c`。各运行的真实提交保留在各结果中，不把兼容固定件的 `SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025` 当作 Git 提交。
- Windows 11 Pro 10.0.26300 x64；Electron 22.3.27，应用内 Node 16.17.1，随包 Python 3.12.10；驱动 Node 22.14.0，Windows 测试 Python 3.12.14，Server Python 3.12.3、pnpm 10.26.2。锁文件与实际包通过源清单及安装证据绑定。
- 沿用隔离测试公钥，SPKI SHA-256 `2836a6c72360fca73c8bbf737a2d789224fdaa4ebf964ec6f53e5676ea7f49db`。只归档公钥、签名及脱敏结果，不归档私钥、真实模型凭据、浏览器 Cookie、用户配置或数据库。

大部分文件任务由确定性模型选择真实工具，实际经过 Gateway、任务 broker、签名任务、已安装 Runtime、Windows 文件系统及真实 UI 审批。另设真实外部 `agnes-3.0-flash` 会话，实际流式事件及回答标记通过，且重启原应用后重开同一 Thread/Run。自动准备的 API 登录与真实模型通过均不能替代人工浏览器登录。

## 场景与实测

| 场景 | 预期与实际覆盖 | 当前状态 |
| --- | --- | --- |
| T111-01 自动段 | 新安装包启动、真实配对身份、已有 Agent/Skill 选择、真实模型 SSE、同 Thread/Run 重开；生命周期另验安装、退出、卸载、数据保留、重装、原生关窗；记录真实版本、软渲染开关、sandbox/contextIsolation 与 preload IPC。 | passed |
| T111-01 人工段 | 用户在真实浏览器登录，核对设备名与校验码并确认本人设备，再由原 Desktop 完成一次性交换。使用新的浏览器及 Desktop 数据目录，无预置登录凭据。 | passed，用户明确确认，Runtime 实际 authenticated，后续真实模型及重开历史通过 |
| T111-02 | 实际读取和搜索、新建/覆盖；批准、拒绝、真实 300 秒超时；持续目录授权与逐次审批区分；账号切换、登出、会话轮换、设备撤销、用户和设备越界拒绝；实际文件 hash、错误类别、授权与回执核对。 | passed |
| T111-03 | 写入中停止、断线、重启、存储故障与未知副作用不重派；显式上传、幂等、D2 下载 hash、B 用户拒绝和生产设备撤销；真实在线/离线组合更新与失败回滚，原 pending 回执补传、当前合法身份与撤销事实保持，恢复后实际读写。 | passed |
| T111-04 自动段 | Desktop 相同候选公共门禁复用；Server 完整 core-full 重新运行，保留父子 lane、命令、退出码、耗时；受保护路径 Real E2E 的实际选择及历史运行记录单独核对。 | passed，浏览器组含 1 项重试通过的 flaky，见下文 |
| T111-04 人工段 | 用户审阅本轮最终报告及必需项，明确验收人和阶段结论。 | passed，本会话用户明确同意现代 Windows 一期验收通过，签核绑定所审报告 hash |

KB 仅覆盖 canonical 资源元数据、归属、provider-binding 与另一用户拒绝。隔离环境没有配置检索提供方，初始化失败基线如实保持，不据此声称 KB 检索能力通过。应用实际版本来自 Electron app.getVersion；旧 renderer 静态页脚显示 0.1.0 不作为版本判据。

## 入口、命令和时长

可复现入口及超时约束见 [驱动说明](../../../scripts/acceptance/issue-111/README.md)。下表耗时是完整外层命令实测，包含安装、Gateway 启停及清理。完整参数、UTC 时间和退出码见对应 `*-command.json`，日志与截图在 [本轮证据目录](evidence/supplement-20261026/)。

| 入口 | 实测结果 | 外层时长 |
| --- | --- | --- |
| `run-base.ps1 -Mode matrix` | 15 项通过；T111-04 本驱动明确未执行，由独立门禁及人工签核承担 | 104.688 秒，退出 0 |
| `run-base.ps1 -Mode writes` | 完整 T102 的 22 项，包含真实 300 秒审批到期 | 503.656 秒，退出 0 |
| `run-base.ps1 -Mode identity` | 完整 T103 的 15 项；6 个当前凭据清理，另 9 个已由登出或轮换退役 | 150.156 秒，退出 0 |
| `run-base.ps1 -Mode artifacts` | 完整 T105 的 8 项，实际跨设备下载和隔离拒绝 | 70.547 秒，退出 0 |
| `run-base.ps1 -Mode online` | 8 项，真实改变载荷的签名在线更新、排空与启动 | 73.438 秒，退出 0 |
| `run-base.ps1 -Mode offline` | 8 项，同候选的签名离线更新 | 75.641 秒，退出 0 |
| `run-base.ps1 -Mode recovery` | 6 项，真实更新失败、完整回滚和恢复后业务 | 117.953 秒，退出 0 |
| `run-provider.ps1` | 真实外部模型一次标记回合、已发布资源选择、SSE 和重开历史 | 51.297 秒，退出 0 |
| `lifecycle.cjs` | 6 个安装/退出/卸载/重装步骤，安全隔离及数据 canary 保持 | 39.734 秒，退出 0 |
| `manual-desktop.cjs` | 用户人工登录/设备确认，随后真实外部模型及同 Thread/Run 重开；含人工等待 | 554.875 秒，退出 0 |

独立外部模型自动运行中，实际创建的 Windows 安全存储引用为 6 个，均已删除。Artifact 组独立 D2 也清理其引用，共 8 个。自动组使用的真实 Gateway、TCP 代理退出情况均单独留证，不能用断言成功掩盖清理失败。

## Server 门禁与失败保留

完整入口为 `bash scripts/run-test-lane.sh core-full`，精确环境见归档的 [run_full_fixed.sh](evidence/supplement-20261026/run_full_fixed.sh)。使用独立 Server checkout、锁定依赖和任务级 PATH；不更改系统 pnpm，不使用会污染假 PATH 单元测试的全局 TEST_PNPM_BIN。

首轮完整门禁真实失败。backend-full 为 26,953 passed、12 failed、237 skipped，pytest 1,157.89 秒；frontend-core 通过；frontend-mock-e2e 在执行用例前启动失败。完整原始命令和日志以 `server-core-full.*` 归档，不将其改写成通过。

4 个后端失败来自根规范块被重新生成成未识别且超预算的版本。仅将 AGENTS/CLAUDE 恢复为独立核对过的既有规范块，不削弱检查器；根文件从 10,740 字节降为 8,087 字节，满足 8,180 上限。28 对镜像同步、67 项保护指纹、文档检查 0 findings 及补丁台账检查通过。图变更分析覆盖全部 2 个 Markdown section，0 个执行流程，partial=false、truncated=false；不声称整个代码图没有截断。

其余 8 个后端失败来自测试进程继承了全局 TEST_PNPM_BIN；前端浏览器启动失败来自 node_modules 指向 checkout 外部的符号链接。复验改为任务 PATH 固定 pnpm 10.26.2，并在独立 checkout 内复制完全相同的锁定依赖。未修改产品代码或依赖版本。聚焦原失败点复验 46 passed，pytest 8.48 秒、外层 12.609 秒。

第二轮完整门禁已结束，命令外层 2,949.921 秒、退出 0，官方父 lane 2,953 秒、状态 0。父子计时来自各自计时器，保留实测差异，不人为改成一致。

| 官方 lane | 实测结果 | 时长/状态 |
| --- | --- | --- |
| backend-full | 常规 26,965 passed、237 skipped、1,081 warnings，pytest 1,069.71 秒；串行 24 passed、10 skipped、27,347 deselected、3 warnings，pytest 19.39 秒 | 1,191 秒，0 |
| frontend-core | Rstest 167 文件/1,270 项，Vitest 355 文件/10,565 项；lint 0 errors、1,279 warnings，tsc 通过 | 802 秒，0 |
| frontend-mock-e2e | 414 项中 413 项直接通过，1 项首次失败、自动重试通过并标为 flaky；Playwright 14.7 分钟 | 952 秒，0 |
| core-full | 所有上述子 lane 返回，官方父结果 passed | 2,953 秒，0 |

flaky 为 `tests/e2e/chat.spec.ts:1843` 的 `shows structured upload errors as readable messages`。首次断言未在 sessionStorage 读到 `Summarize this report`，随后重试通过；完整失败及重试记录保留，不能写成 414 项首轮全绿。没有为消除这条记录再次跑完整门禁。Server 文档修复已发布 [PR #151](https://github.com/Orbit-Crew/iDeer/pull/151)，尚未合并。

原实现 Server PR #146 的受保护路径选择确实执行 Real E2E。运行 [40250431006/job/121340956243](https://github.com/Orbit-Crew/iDeer/actions/runs/40250431006/job/121340956243) 为 7 passed、5 skipped，3.3 分钟；real-model workflow 当次跳过。该历史检查与本轮独立真实外部模型会话分开记录，不能互相冒充。

本轮 `7079f760..dc538326` 的真实选择器命令为 `backend/.venv/bin/python scripts/select_test_lanes.py --base 7079f760de39d946babaca0c0ef72c865e86a2de --head dc5383266516438c3edfab0bcecff8b968cd3edc --plan-file ...`，实际只选择 governance、docs_only=true，未选择 Real E2E。完整 core-full 是本次阶段验收主动执行的门禁，不把文档差异选择说成受保护代码变更。

Server PR #151 的当前 GitHub Actions 中 Test Lane Shadow、Migration Tests、Real E2E Tests 工作流成功；其中 Real E2E 的选择和汇总 job 成功，实际 `real_e2e_tests` job 为 skipped，与文档差异选择一致，不当作又执行了一轮真实 E2E。

## 驱动问题与重试

保留 `historical-*` 命令和结果。早期 writes 在 WSL 启动超时后未进入 Desktop 场景；任务级 Gateway supervisor 后续避免反复启动 WSL。早期 identity 的 NSIS 等待超时未进入场景，之后功能断言通过但外层重复删除已清理凭据，正确记为退出 1；修正 launcher 的清理记账后重新安装、完整复验退出 0。早期真实模型固定件仅持业务会话而缺少当前恢复契约要求的设备绑定，未到模型调用；补真实设备配对后复验通过。没有把这些固定件失败归咎于产品，也没有据一次通过抹去失败。

首次人工尝试中，用户实际发起浏览器登录并反馈填写账号、点击登录后无响应。真实 Next 日志显示 `/_next/*`、字体及 HMR 因开发来源不在允许列表被拒绝，页面只有 SSR 外壳，未发出登录请求。五分钟设备请求随后过期，驱动退出 1，0 个凭据需要清理。修复仅为临时前端补上仓库已有 `DEER_FLOW_DEV_ALLOWED_ORIGINS`，不改认证或 CSRF；另用新数据库、全新安装和独立浏览器重新准备。复验前，实际带代理入口 Origin/Referer 的登录页及四个交互脚本均返回 200，留 `browser-resource-check.json`。首次失败日志保留，不能记为人工登录通过。

## 人工签核与平台边界

人工浏览器登录由本会话用户执行，并明确回复“已完成登录和设备确认”。Runtime 在 `2026-10-26T14:20:29.770Z` 从 awaiting-confirmation 变为 authenticated，账号为隔离普通用户 `t99-provider-a@test.com`、设备 `T111 Human 15aa`。此后实际外部模型标记回合及同 Thread/Run 重开通过，`2026-10-26T14:21:17.373Z` 完成，外层退出 0。该人工段未预填业务凭据、Cookie 或设备会话；确认记录见 `human-login-attestation.json`。

隔离测试账号仅存在本轮数据库，浏览器和 Desktop 使用独立目录。OS 打开浏览器的调用由验收适配器转至独立 Edge 数据目录，真实 Next 登录页、Gateway、CSRF 和设备一次性交换不替换。前端副本逐文件核对原提交字节，并保留绑定记录。人工段通过后，真实 BrowserLogin.logout 清理 3 个新凭据引用；Gateway、Next、代理和 supervisor 均已退出，两次独立测试 Edge 也已关闭。代理停止瞬间的原记录仍计有 2 个正在销毁的 socket，保留该原值；进程结束后的独立检查为 0 个实际安装目录进程、0 个活动 TCP 连接，见 `human-final-cleanup-check.json`。

最终人工验收人为本会话用户，明确回复“已审阅，同意现代 Windows 一期验收通过”，记录于 `2026-10-26T14:28:56Z`。签核及所审报告 SHA-256 见 [human-signoff.json](evidence/supplement-20261026/human-signoff.json)，原报告完整文本快照见 [reviewed-report.txt](evidence/supplement-20261026/reviewed-report.txt)。所审范围包含上述 flaky 记录及平台边界。本页随后补记该确认，原快照仍保留签核前状态，便于核对用户实际审阅内容。各 PR 仍待正常审查合并。

真实 Win7 单独为 unexecuted，仅后置到 [#131](https://github.com/Orbit-Crew/iDeer/issues/131)。需在真实 Win7 验安装/启动、Electron 22/Node、Python 与兼容补丁、浏览器配对、安全存储、文件工具和组合更新恢复；由 #131 的平台验收负责人领取执行，本轮未指定具体个人。现代 Windows 结论不能扩展为 Win7 兼容或 linz 退役结论。
