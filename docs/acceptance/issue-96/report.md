# Issue #96 逐场景验收报告

## 依据与结论

核对日期：2026-10-17，Asia/Shanghai。依据 [issue #96](https://github.com/Orbit-Crew/iDeer/issues/96)
2026-10-17 19:23:59 +08:00 更新后的正文；本次读取时无评论。
本次补验于同日执行，最终恢复状态记录于 19:44:31（+08:00）：重新核对全部来源指纹、安装锁定依赖、
运行公共门禁和默认配置 Windows 打包，在用户原安装目录重验安装/退出/重装及快捷方式。
原始补充记录在 `artifacts/issue-96-windows/supplement/`，时间戳以日志为准。

**整体状态：incomplete，当前不能关闭 #96。**
真实 Win7 已明确后置到 [#131](https://github.com/Orbit-Crew/iDeer/issues/131)，
不再是 #96 合并、关闭或后续领取的前置。本次 Win11 满足“现代 Windows”平台范围，
不能因未测 Win10 就否定现代 Windows 结果；也不能据此宣称 Win10/Win7 已通过。

| 场景 | 自动部分 | 人工/交互部分 | 场景状态 | 当前缺口 |
| --- | --- | --- | --- | --- |
| T96-01 | 固定提交清单内 16 文件逐一指纹通过；差异/补丁/维护清单已归档 | 用户明确要求不核验上游授权 | incomplete | 授权部分未核验，未记通过 |
| T96-02 | 类型、全量/固定安全回归及默认配置 Windows 打包通过 | 主进程、preload 和导航配置复核完成 | passed | 日志、退出码、耗时、构建图和有效配置已归档 |
| T96-03 | 新候选原位安装、目录启动、侧栏、缩放、第二实例通过 | 实际桌面快捷方式启动和中文界面通过 | passed | 绑定本次新安装包 hash |
| T96-04 | UI 退出/关闭/重启、独立目录及前后进程快照通过 | 另用 Computer Use 点击原生标题栏关闭，之后零残留 | passed | 两种退出后进程清单均为空，已补专用证据 |
| T96-05 | 固定件卸载/重装保留检查通过，维护边界有记录 | 用户确认本机未安装 linz，真实旧应用查阅未执行 | unexecuted | 缺真实旧应用及历史资料；固定件结果不替代 |

“自动部分通过”只描述已覆盖子步骤，不能替代完整场景通过。
依赖风险处置沿用既有 incomplete 记录，不以本次文档核对获得安全放行。

## 执行候选与证据复用条件

- 实施仓库：Orbit-Crew/iDeer-Desktop，分支 `feat/issue-96-desktop-bootstrap`。
- HEAD：`327f16c49da91185c744c94962c7f8e3d622f918`；工作区含未提交的验收/测试修正。
  本次修改验收脚本并重新构建候选，应用生产源码不变，现有安装位置不变。
- 固定来源：Neowyh/linz `f88141bb3d3450a572fcc52e0f9b48a1e60d3b13`。
  Server、Runtime、工具组件均未接入，本次没有这些仓库的运行候选及跨仓执行证据。
- 系统：Windows 11 专业版 x64，10.0.26300；构建 Node 22.23.3 / npm 10.9.9。
- Desktop 0.1.0；Electron 22.3.27 / 应用 Node 16.17.1。
- 安装目录保持 `D:\software\iDeer Desktop\ideer-desktop`。
- 安装包 `dist/ideer-desktop-0.1.0-windows-x64-setup.exe`：
  SHA-256 `ed79d8200198dbb320827c6182727f53f0154f21fc3d9ff70454b89eec253806`；80,114,409 bytes。
- 有效依赖锁 package-lock.json：
  SHA-256 `38e20141bb06e8814177597d6164be854831e480783d38b4d41c2d1133ce857a`。
- 候选/安装时 app.asar：
  SHA-256 `e43e0f5fc04bbd582d482516c12bab4fea658e6dd0d4cfd963196458db948352`。
- electron-builder.yml：
  SHA-256 `907cc12f96b641b2e70c493b0a760556e2e927b87cee67b523e55bd9328666b4`。
- 构建命令：`npm.cmd run dist:win`，无配置覆盖，未禁用 signAndEditExecutable；
  `CSC_IDENTITY_AUTO_DISCOVERY=false`，NSIS x64 当前用户未签名候选。
  使用项目 `.cache/electron-builder` 工具缓存，处理经过记录，不更改系统权限。

新安装包与早期带覆盖参数的候选不同；本报告通过项使用新候选重新验证。
补充目录下 candidate-hashes.json、build-environment.json、runtime/final-state.json
绑定本次环境、配置及已安装 asar/exe；已安装 exe 与打包目录 exe 的 SHA-256 一致。
后续候选/依赖/配置/环境变更须重新判断证据适用性。

## 逐场景步骤与预期

### T96-01 — 来源、授权、依赖及能力去留

入口：`npm.cmd run verify:provenance -- --snapshot <supplement/upstream-snapshot>`；核对 `resources/provenance/linz-source.json`、
`THIRD_PARTY_NOTICES.md`、package-lock.json、`docs/porting.md`。
预期来源提交为上列固定 SHA；原包声明 MIT；来源文件应匹配来源清单。
维护/暂缓清单与兼容补丁责任见 porting.md；不从程序输出生成许可结论。

实测：从上述固定提交 raw URL 下载清单内 16 文件，逐一比对预先登记的 SHA-256，全部匹配。
来源校验退出 0，用时 1.464 秒；source-differences.json 记录来源与当前 Desktop 的指纹差异，
改编/保留方式及责任对应 porting.md。compat banner 和启动源码亦已归档。
用户明确答复“不核验上游授权”，本次未执行该部分；既有 MIT 字段不作为已确认授权。
证据：补充目录 source.log、upstream-download.json、source-differences.json、startup-review/。
人工授权确认人：无；状态 incomplete（仅授权子步骤未核验）。

### T96-02 — 公共基线及执行边界

实际入口：scripts/windows-acceptance-baseline.ps1，执行 `npm.cmd ci --no-audit --no-fund`、
`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run test:security`、
`node scripts/acceptance-graph.cjs <补充目录>`、`npm.cmd run dist:win`。
固定安全回归已包含于全量测试，另一次单独执行不重复计数。
预期 Electron 固定为 22.3.27（package.json），软渲染为 true，preload 仅 status/quit，
无旧模型、Agent、办公室和工具依赖/入口；沙箱和导航限制见主进程及窗口代码。

实测各项最终退出码均为 0。依赖安装 32.183 秒、类型检查 5.862 秒、全量命令 10.876 秒
（Vitest 内部 9.03 秒，3 文件/4 测试）、固定安全回归命令 3.041 秒；最终图归档 0.964 秒。
默认配置打包最终 52.186 秒，生成上述新候选。
依赖图无旧执行包，preload 仅 desktop:quit/desktop:status；运行日志验证 Electron、软渲染、沙箱及导航/IPC 拒绝。
证据：commands.json、各命令 .log、dependency-graph.json、dependency-boundary.json、
builder-effective-config.json、构建原配置、startup-review/ 和 runtime/installed-desktop-smoke.log。
状态 passed，执行者为 Codex。

环境处理与失败保留：早期 winCodeSign 解压失败由官方工具缓存中无关 macOS 符号链接导致。
本次将已下载官方 winCodeSign-2.6.0 包解压到项目缓存，排除 darwin 目录；工具来源 URL、
包 hash 和排除范围见 builder-cache-preparation.json，不修改项目配置或系统安全设置。
首次本次打包因 NSIS 下载 EOF 退出 1（40.120 秒）；复用已有同版本 NSIS 缓存后重试通过。
失败日志见 dist-win-attempt-1.log，短效下载 URL 查询参数已脱敏；commands.json 保留该失败。

### T96-03 — 安装、快捷方式、UI、第二实例

自动入口：`scripts/windows-local-acceptance.ps1 -Installer <上述候选> -InstallDirectory
'D:\software\iDeer Desktop\ideer-desktop'`，内部指定 DESKTOP_EXECUTABLE 后运行 desktop-smoke.cjs。
交互入口：资源管理器地址栏打开 `D:\desktop\iDeer Desktop.lnk`，观察原路径客户端窗口。
执行者：Codex 自动检查及 Computer Use 界面复核，无维护者人工签核声明。

预期常量：标题 iDeer Desktop；“未连接 Server”“当前无法登录、聊天或执行本地任务”；
仅一个主窗口，第二实例退出 0 并恢复原窗口。启动超时 30 秒、UI 等待 15 秒、
第二实例退出 15 秒；缩放检查尺寸 960×600、1440×900、1280×800。
这些是既有测试输入和需求约束，数值比较为精确断言，不使用输出反推预期。

实测全部满足；安装器退出 0，整个最终生命周期执行约 45.786 秒。
真实 Electron 冒烟命令退出 0，用时 23.005 秒；其内部测量为 21.861 秒。
证据：补充目录 runtime/ 下 lifecycle-results.json、installed-desktop-smoke.log、
installed-desktop-startup.png、shortcut-window.json、final-state.json。状态 passed。

### T96-04 — 退出、重启和独立目录

自动入口：desktop-smoke.cjs 中按钮“退出应用”、BrowserWindow.close()、再次启动，
以及本地生命周期脚本的 Wait-NoDesktop。预期完整退出、安装路径进程为零，重启仍未连接；
userData 为 `%APPDATA%/iDeer Desktop`，Session 为其子目录；进程等待上限 20 秒。

实测命令退出 0。desktop-processes.json 记录 initial-launch、before-ui-quit、after-ui-quit、
restart-before-native-close、after-native-close，包含实际时间、耗时、PID/父 PID/路径。
运行阶段各有 4 个应用进程，after-ui-quit 和 after-native-close 均为零，自动检查通过。
除自动 BrowserWindow.close() 检查外，还通过 Computer Use 点击真实标题栏“关闭”，
titlebar-before.json 记录 4 个进程，titlebar-after.json 为零；之后恢复打开并观察未连接状态。
目录仍为独立 userData/Session；证据另含 reopened-window.json 与 installed-desktop-smoke.log。
状态 passed；自动与交互执行者均为 Codex，不代替维护者签核。

### T96-05 — 冻结说明、卸载重装与真实旧应用查阅

已用入口：本地生命周期脚本创建唯一命名的 Desktop/linz 固定件，卸载重装后核对内容及 hash；
卸载等待上限 30 秒。固定件路径在真实 AppData 下，执行结束只移除测试文件。
预期 Desktop 卸载保留自身数据，旧 linz 安装/快捷方式/资料保持，可从旧应用查阅；
冻结仅限维护，不代表退役。说明见 porting.md 的“linz 冻结和旧数据查阅”。

已测子步骤：卸载/重装退出 0，独立 Desktop 和 linz 固定件保持；原位恢复完成。
本次固定件名 ideer-acceptance-220511b0-4e8d-4879-86c9-9a4733dd65c0.txt，分别在两者 AppData 目录。
runtime/data-retention.json 登记预期内容及安装前、安装后、卸载后、重装后的路径/hash。
linz 固定件 SHA-256 为 9e4d60f35cceffbd538e8e23766dfa73b9ed4a9544340bb281103123b9eb6680；
Desktop 固定件为 6c62a71042d353863bc0619a046520253c36d17b16659f297e14cc34b597eaf6，四时点均一致。
用户确认“没安装”，缺失依赖为真实 linz 安装、历史工作区文件清单、旧快捷方式及人工查阅。
固定件已按脚本清理，不能将本次结果写成真实存量资料保护通过。
补测入口：保存指定旧资料和快捷方式前后 SHA-256，运行同包卸载/重装，打开原 linz
查阅固定资料并由实际执行人记录结果；具体旧应用/固定件路径待提供绑定，不虚构入口。
状态 unexecuted（固定件子步骤 passed），不能后置到 #131。

## 后置 Win7 台账

所有项目状态 **unexecuted**；责任协调人 **Neowyh**（由其指定实际验收人）；
执行归属 [#131](https://github.com/Orbit-Crew/iDeer/issues/131)，对接 T131-01/T131-02。

| 待验范围 | 原编号 | 依赖/补丁 | 执行入口 |
| --- | --- | --- | --- |
| 系统/SP/补丁/位数/GPU/驱动及候选身份 | W7-01 | 真实 Win7 x64、最终包 hash、适配运行依赖 | 真实 Win7 环境记录及 Get-FileHash |
| 独立安装、旧资料/快捷方式/卸载身份 | W7-02 | 真实 linz、独立测试资料 | 真实 Win7 安装 UI + 前后文件 hash |
| 安装目录与快捷方式启动、黑屏/崩溃 | W7-03 | Electron 22.3.27、Node 16、disableHardwareAcceleration/disable-gpu | 最终包启动及人工画面检查 |
| 不可用状态及旧执行入口排除 | W7-04 | renderer/preload 最小桥接 | 适配 Win7 的桌面 smoke + UI |
| 独立 userData/Session | W7-05 | Windows Known Folder、独立路径 | 桌面 smoke 的目录断言 |
| 中文/缩放/侧栏、导航/IPC 拒绝 | W7-06 | Chrome 108、sandbox/contextIsolation、CSP | 桌面 smoke + Win7 人工画面检查 |
| 退出/关闭/重启/第二实例，无孤儿进程 | W7-07 | Node16 兼容 banner、软渲染及沙箱 | 桌面 smoke + 各时点进程快照 |
| 卸载重装保留新旧数据及旧应用查阅 | W7-08 | 最终 NSIS 包、真实 linz/资料 | Win7 原位生命周期 + 人工旧应用查阅 |

最终 Win7 使用最终候选及其组合重新绑定证据，不直接复用当前 Win11 安装包结论。
Win7 执行入口的适配与真实运行属于 #131，当前登记不表示这些入口已经在 Win7 可用。

## 证据位置与后续动作

既有详细执行记录：[Windows 本机验收](../../windows-acceptance-2026-10-17.md)。
原始证据在仓库 `artifacts/issue-96-windows/`（Git 忽略），包括本报告引用的日志和图片；
最新证据位于其 supplement/ 子目录，补验脚本、来源/差异、命令时序、构建图、配置、
包 hash、截图、退出进程及数据 hash 均已保存。根目录旧日志属于早期不同安装包的历史执行，
不得与新候选混用；旧 recheck-identity.json 也仅描述当时的旧候选。
归档包为 `dist/issue-96-windows-evidence-2026-10-17.zip`；单独提交本报告不等于原始证据已经入库。

按用户限定范围，自动核验及可用交互场景已补齐。票据完整通过仍缺 T96-01 授权核验
（用户明确要求不执行）及 T96-05 真实旧应用共存查阅（用户确认未安装）。
未安装 linz、未核验上游授权、未关闭 issue 或发布安装包；客户端最终已在原目录打开。
