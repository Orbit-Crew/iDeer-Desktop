# Issue #96 执行证据

当前标准以 [逐场景验收报告](acceptance/issue-96/report.md) 为准。
2026-10-17 用户进一步调整 #96 的关闭范围，移出上游授权核验及真实旧 linz 共存查阅。
修订后范围内 T96-01 至 T96-05 均 passed，满足本票本次关闭条件；
授权子步骤保留未核验、真实旧应用子步骤保留 unexecuted，不作为已通过或正式发布依据。
下文的 incomplete/unexecuted 为执行当时的原始状态，范围修订未改写这些测试事实。
验收时序依据[父规格 #95](https://github.com/Orbit-Crew/iDeer/issues/95)。
issue #96 更新后，真实 Win7 统一后置到 #131，不再作为本票合并/关闭的前置；
本文件下方历史记录中的旧放行规则不作为当前标准。

最新补验：T96-02/03/04 已通过，补充日志/构建图/有效配置/退出快照位于
`artifacts/issue-96-windows/supplement/`，已重新打包并在原安装目录验收。
新包 SHA-256 为 `ed79d8200198dbb320827c6182727f53f0154f21fc3d9ff70454b89eec253806`。
T96-01 来源清单内 16 文件通过完整指纹比对，但用户要求不核验上游授权，整体 incomplete；
用户确认本机没有 linz，T96-05 的真实旧应用部分保持 unexecuted，固定件子步骤已通过。

补充：2026-10-17 已在真实 Windows 11 本机完成候选的原位安装、启动、退出、卸载和重装验证。
详见 [Windows 本机验收](windows-acceptance-2026-10-17.md)，包含包 hash、原安装路径、失败及修正记录。
下文为先前 Linux 执行的历史记录；其中 Windows unexecuted 已有上述后续证据，Win7 仍未执行。
整体验收及发布放行仍为 incomplete。

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
| 全量测试 | passed | 审查修正后 `npm test`，3 个文件、4 个测试全部通过，3.19 秒 |
| 生产构建 | passed | `npm run build`，main/preload/renderer 均成功 |
| 真实 Electron 开发候选 | passed | `xvfb-run -a npm run test:desktop`，Electron 22.3.27 / Node 16.17.1，隔离目录、沙箱、IPC 拒绝、CSP、侧栏和两种退出通过 |
| asar 打包 | passed | `npm run pack` 生成 Linux 检查候选，包含来源和 notices，未作为受支持平台发行 |
| asar 候选启动 | passed | `DESKTOP_EXECUTABLE="$PWD/dist/linux-unpacked/ideer-desktop" xvfb-run -a npm run test:desktop`，含真实 Node 16 循环克隆和跨 chunk UTF-8 文本流 |
| Windows NSIS 构建、安装、退出、卸载 | unexecuted | 已配置 PR 工作流；当前无 Windows 执行环境，未远端运行 CI |
| 真实 Win7 变更专项及最终安装包验收 | unexecuted | W7-01 至 W7-08 转交 #131，负责人 Neowyh；涉及 Electron 22/Node 16、沙箱、软渲染、进程生命周期及 NSIS。现代 Windows 和 Linux 不能替代，此项不阻塞当前阶段 |
| 真实跨仓 | unexecuted | 本票无认证/授权/通信/执行/回执接线；发布前及相应能力变更时仍须执行 |
| 上游许可证文本核验 | incomplete | 仅有原 MIT 声明，来源无根 LICENSE，维护者核验后才能分发 |

依赖锁 SHA-256 为 `1aaf12b960ebb685d358cae926b64fe829a1bf1b917bac5d17109a761d9fb8f6`。
Linux 检查候选 app.asar SHA-256 为
`d8cef606e9fe3e227b27d21e9fd1346415e0b61478f9430a3b0d688b2331f0fe`。
候选截图为本地 artifacts/desktop-startup.png；CI 上传截图、构建配置和 Windows 包 hash。
`npm ci --prefer-offline` 已重新安装成功；最终类型检查、来源校验与打包均通过。
两项独立代码审查及修正记录见 [code-review.md](code-review.md)。

安装时 npm audit 报告 28 项告警，10 moderate、15 high、3 critical。
直接涉及 Electron、electron-builder、electron-vite、esbuild、PostCSS、Tailwind、Vite 和 Vitest。
保留上游 UI/构建基线及 Electron 22，不运行自动重大升级。Vitest 仅运行 CLI，
开发服务器限回环地址，生产候选禁外部连接；这些约束不等于已消除依赖漏洞。
维护者须逐项评估兼容修补方案和发布风险，当前无依赖安全放行结论。

当前记录的放行状态仍为 incomplete。现代 Windows 证据、许可证核验和依赖风险处置未完成，
本次时序调整不自动补齐这些证据。Win7 验证单独转交 #131，不再作为前期阶段阻塞；
收尾验收通过前不能宣称 Win7 完整兼容交付或归档 linz。
