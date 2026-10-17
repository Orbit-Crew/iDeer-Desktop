# Issue #96 Windows 本机验收

本文件保留早期候选的执行详情（包 hash 为 1ccbef…）。后续已使用默认打包配置生成新候选，
补齐来源指纹、构建图/配置和退出进程快照；最新状态和新候选 hash 以
[逐场景报告](acceptance/issue-96/report.md)及其 supplement 证据为准，勿将不同候选混用。

## 结论与边界

2026-10-17（Asia/Shanghai），按用户澄清后的 [iDeer #96](https://github.com/Orbit-Crew/iDeer/issues/96)
完成当前主机上的安装、启动、退出、卸载与重装检查，执行结果 passed。
用户最初提供 #97，后明确本次只验收 #96；未把 Runtime 签名任务闭环计入本次结果。

实际平台为 **Windows 11 专业版 x64，10.0.26300**，不能记为 Win10 或 Win7 通过。
按更新后标准的逐场景结果见 [正式验收报告](acceptance/issue-96/report.md)。
整票及发布放行仍为 **incomplete**：授权核验、真实 linz 共存查阅及部分专用证据未完成。
真实 Win7 已后置到 #131，不再阻塞 #96 现代 Windows 验收，仍不得写为已通过。
未测试 Win10。未提供真实 linz 安装，旧应用可打开查阅及真实历史工作区共存为 unexecuted；
本机 linz 数据目录的保护仅通过唯一命名固定件验证，清理后该目录没有文件。
本次由 Codex 执行，不代替维护者人工签核，未修改 GitHub issue 状态或发布候选包。

## 候选与环境

- 分支：`feat/issue-96-desktop-bootstrap`。
- 源码 HEAD：`327f16c49da91185c744c94962c7f8e3d622f918`。
- 工作区含未提交的测试、验收脚本和记录修正；应用生产源码未修改，未因测试脚本修正重建安装包。
- Desktop 0.1.0；Electron 22.3.27；应用 Node 16.17.1；构建 Node 22.23.3 / npm 10.9.9。
- Server / Runtime / 工程组件：未接入，无兼容版本组合声明。
- 原安装及最终恢复目录：`D:\software\iDeer Desktop\ideer-desktop`。
- 安装包：`dist/ideer-desktop-0.1.0-windows-x64-setup.exe`，80,114,540 bytes。
- 安装包 SHA-256：`1ccbef239ada4915884eb84068655d654b71bb83e07a0049d0050b92609abce4`。
- 根 package-lock.json SHA-256：`38e20141bb06e8814177597d6164be854831e480783d38b4d41c2d1133ce857a`。
- 候选及安装后 app.asar SHA-256 均为：`e43e0f5fc04bbd582d482516c12bab4fea658e6dd0d4cfd963196458db948352`。
- 打包配置：仓库 electron-builder.yml，Windows NSIS x64，当前用户安装；本地命令额外设置
  `CSC_IDENTITY_AUTO_DISCOVERY=false`、`--config.win.signAndEditExecutable=false`。
  这是未签名候选，关闭可执行文件编辑以绕过本机签名组件解压时的符号链接权限限制；
  没有验证默认构建配置下的该步骤，也不视为正式发行配置验收。

## 实测结果

| 检查 | 状态 | 观察及证据 |
| --- | --- | --- |
| 来源存档、类型检查 | passed | `npm run verify:provenance`、`npm run typecheck`；来源存档指纹匹配，未提供 linz 源码检出逐文件比对 |
| 兼容、安全、UI 单元回归 | passed | `npm test`，3 文件、4 测试，11.46 秒；安全测试修正 Windows 路径分隔符后通过 |
| 原目录安装 | passed | 使用最终候选安装包，安装器返回 0，实际安装路径与用户指定目录一致 |
| 安装身份与快捷方式 | passed | 当前用户卸载记录为 iDeer Desktop 0.1.0；桌面、开始菜单快捷方式均指向原目录 exe |
| 安装产物匹配 | passed | 安装后 app.asar 与本地打包候选 hash 一致 |
| 从安装目录启动 | passed | Playwright 启动真实已安装 exe，显示“未连接 Server”和不可用说明 |
| 数据与会话目录 | passed | userData 为 `%APPDATA%/iDeer Desktop`，sessionData 为其 `Session` 子目录 |
| 运行时与软渲染 | passed | Electron 22.3.27 / Node 16.17.1，disable-gpu=true，循环引用克隆和 UTF-8 跨块文本流正常 |
| 进程隔离与执行边界 | passed | sandbox/contextIsolation=true，nodeIntegration/webview=false；旧 aeromind/require 不可用；status/quit 最小桥接 |
| 外部访问约束 | passed | 外部 webContents 的 IPC 被拒绝，导航、弹窗及 CSP 外部 fetch 被拦截 |
| 侧栏、中文与缩放 | passed | 收起/恢复侧栏；960×600、1440×900、1280×800 下可见未连接标题；截图复核中文，无黑屏 |
| 第二实例 | passed | 首实例最小化后启动第二实例，第二实例返回 0 退出，原窗口恢复且仅保留一个应用窗口 |
| 界面退出与原生关闭 | passed | 两种操作均使应用退出，脚本检查该安装路径无残留进程；再次启动成功 |
| 卸载及保留数据 | passed | 卸载器返回 0，exe 消失；Desktop 固定件及 linz 固定件内容/hash 保留；固定件非用户历史资料 |
| 原目录重装 | passed | 同一候选重装回原目录；固定件与快捷方式保持，完整生命周期最终运行约 36.22 秒 |
| 桌面快捷方式启动 | passed | 通过资源管理器打开 `D:\desktop\iDeer Desktop.lnk`，Computer Use 观察唯一的原路径客户端窗口和未连接界面 |
| 最终恢复 | passed | 原目录、卸载登记、app.asar hash 正确；客户端保持打开；只清理本次唯一命名测试文件和误建空目录 |
| Win10 / Win7 | unexecuted | 当前主机为 Win11；W7-01 至 W7-08 不能由此次测试替代 |
| 真实 linz 旧安装/工作区共存 | unexecuted | 无真实 linz 安装与历史工作区；固定件结果不等同真实软件验收 |
| 许可证、依赖风险与维护者签核 | incomplete | 沿用原验证记录中的未完成项，本次不作放行判断 |

## 失败尝试与修正

1. 初次本地安装脚本使用未加引号的 `/D=...`，electron-builder NSIS 的 StdUtils 参数解析
   将带空格路径截断为 `D:\software\iDeer`。安装器返回 0，但脚本正确检测到原路径缺少 exe。
   随即以 `/D="D:\software\iDeer Desktop\ideer-desktop"` 恢复到用户指定目录。
   修正本地及 CI 安装脚本的参数引用；最终复验通过，误建目录确认空后删除。
2. 后台 `Start-Process -WindowStyle Hidden` 后用 MainWindowTitle 检查可见窗口产生误判。
   将交互快捷方式验收与后台生命周期测试分开；随后从资源管理器实际打开快捷方式，确认可见窗口。
   两次失败记录保留在 `lifecycle-first-attempt.json` / `lifecycle-second-attempt.json`，未覆盖为通过。

## 复现与证据

已安装且允许正常关闭应用时，在仓库目录、Node 22 环境执行：

```powershell
npm.cmd run verify:provenance
npm.cmd run typecheck
npm.cmd test
.\scripts\windows-local-acceptance.ps1 `
  -Installer 'G:\code\iDeer-Desktop\dist\ideer-desktop-0.1.0-windows-x64-setup.exe' `
  -InstallDirectory 'D:\software\iDeer Desktop\ideer-desktop'
```

此脚本正常关闭原客户端，原位安装、运行真实 Electron 检查、卸载、重装，并恢复原有运行状态。
它检查实际当前用户安装身份，不伪造 RUNNER_TEMP；CI 专用 windows-install-smoke.ps1 仍只用于一次性 CI 账号。
可见快捷方式启动及界面复核单独执行，不以后台进程存在作为可见窗口通过证据。

本地原始证据在 `artifacts/issue-96-windows/`（Git 忽略）：
`environment.json`、`hashes.json`、`commit.txt`、静态/单元日志、
`installed-desktop-smoke.log`、`installed-desktop-startup.png`、`lifecycle-results.json`、
两次失败尝试、`shortcut-window.json` 和 `final-state.json`。
原始日志需随评审另行归档，文档提交本身不包含被忽略的图片和日志。
