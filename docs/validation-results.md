# Issue #96 执行证据

2026-10-17，在 Linux x64 / WSL2 5.15.167.4、Node 22.23.2、npm 10.9.8 上执行。
来源为 linz f88141bb3d3450a572fcc52e0f9b48a1e60d3b13；Desktop 0.1.0。
Server / Runtime / 工程组件均未接入，未声明兼容组合。
候选源码以本记录所在分支的最终提交为准，CI 应将 `git rev-parse HEAD` 与最终包 hash 一起归档。
执行者为 Codex；尚无人工平台验收人签核。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 固定来源核验 | passed | `node scripts/verify-provenance.cjs /home/neowyh/code/linz`，全部来源指纹一致 |
| 类型检查 | passed | `npm run typecheck`，主进程/preload/renderer 全部通过 |
| 聚焦 UI 回归 | passed | startup.test.tsx，1 个测试；先因缺少 App 模块失败，随后实现通过 |
| 聚焦兼容及安全回归 | passed | compat.test.ts 和 security.test.ts，3 个测试通过 |
| 全量测试 | incomplete | 等待审查后的最终执行 |
| 生产构建 | passed | `npm run build`，main/preload/renderer 均成功 |
| 真实 Electron 开发候选 | passed | `xvfb-run -a npm run test:desktop`，Electron 22.3.27 / Node 16.17.1，隔离目录、沙箱、IPC 拒绝、CSP、侧栏和两种退出通过 |
| asar 打包 | passed | `npm run pack` 生成 Linux 检查候选，包含来源和 notices，未作为受支持平台发行 |
| asar 候选启动 | passed | `DESKTOP_EXECUTABLE="$PWD/dist/linux-unpacked/ideer-desktop" xvfb-run -a npm run test:desktop`，含真实 Node 16 循环克隆和跨 chunk UTF-8 文本流 |
| Windows NSIS 构建、安装、退出、卸载 | unexecuted | 已配置 PR 工作流；当前无 Windows 执行环境，未远端运行 CI |
| 真实 Win7 变更专项及最终安装包验收 | unexecuted | 未提供真实 Win7，W7-01 至 W7-08 全部待执行，现代 Windows 和 Linux 不能替代 |
| 真实跨仓 | unexecuted | 本票无认证/授权/通信/执行/回执接线；发布前及相应能力变更时仍须执行 |
| 上游许可证文本核验 | incomplete | 仅有原 MIT 声明，来源无根 LICENSE，维护者核验后才能分发 |

依赖锁 SHA-256 为 `bea29c6d05c40d059205f1e3629a366c611876a64ce3606607c076c6b4f95881`。
Linux 检查候选 app.asar SHA-256 为
`39f66ac88f61404f86effb6388c9435aa4fb2d44df348203ee7d543b245bb9ea`。
候选截图为本地 artifacts/desktop-startup.png；CI 上传截图、构建配置和 Windows 包 hash。

安装时 npm audit 报告 28 项告警，10 moderate、15 high、3 critical。
直接涉及 Electron、electron-builder、electron-vite、esbuild、PostCSS、Tailwind、Vite 和 Vitest。
保留上游 UI/构建基线及 Electron 22，不运行自动重大升级。Vitest 仅运行 CLI，
开发服务器限回环地址，生产候选禁外部连接；这些约束不等于已消除依赖漏洞。
维护者须逐项评估兼容修补方案和发布风险，当前无依赖安全放行结论。

放行状态为 incomplete。必需 Windows/Win7 证据、许可证核验和依赖风险处置未完成，
本次代码提交不能作为合并或发布放行依据。
