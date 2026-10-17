# 0.1.0 验证与放行

本票交付受控启动基线。Server、登录、聊天、设备任务及工具执行均未接入。
不得以此基线声称一期文件闭环、Runtime 切换或 AC01/AC15 全量验收完成。

2026-10-17 用户调整验收时序，权威规则见
[父规格 #95](https://github.com/Orbit-Crew/iDeer/issues/95)。
#96 至 #130 的前期开发、PR 合并、工单关闭和阶段候选验收采用现代 Windows 的适用证据。
真实 Win7 验证统一转交[最终收尾 #131](https://github.com/Orbit-Crew/iDeer/issues/131)，
不再作为前期工单的前置；其余安全、跨仓、真实软件及证据要求继续执行。

## 本地与 PR 命令

使用 Node 22 构建主机。`npm ci` 安装精确 lock，Electron 应用自身仍是 Node 16。

```sh
npm ci
npm run verify:provenance
npm run typecheck
npm test
npm run build
# Linux 仅用于开发验证，不列为产品支持平台
xvfb-run -a npm run test:desktop
# Windows
npm run dist:win
pwsh -File scripts/windows-install-smoke.ps1
```

`npm run test:security` 是固定快速安全回归，已包含于 `npm test`，不重复计数。
它核查真实构建依赖图无旧模型/MCP/终端执行依赖，以及 preload 仅有两项 IPC。
startup 测试通过公开 UI 验证不可用状态。兼容测试覆盖克隆和流解码的已知上游缺口。
desktop smoke 启动真实 Electron，检查 Node 16、隔离目录、最小桥接、拒绝外部页面 IPC、
导航/弹窗/CSP、侧栏操作、退出和 native close，并确认旧数据固定件未变。
Windows 脚本额外安装并运行生成包，再卸载。Linux 测试不能替代 Windows 验证。
Windows 安装脚本仅供设置了 RUNNER_TEMP 的一次性 CI 账号使用；会在系统实际
AppData 的 linz 和 Desktop 目录中创建唯一命名的数据固定件，验证后仅删除这些固定件。
不使用 APPDATA 环境覆盖假装隔离 Windows Known Folder，不改写任何已有资料。

PR 工作流对全部代码 PR 运行静态/合同及 Windows 打包/安装 smoke，无路径过滤。
产物带候选提交、依赖锁、构建配置、截图和安装包 SHA-256；它们是候选包，
没有因 CI 成功获得发布许可。main 分支保护需由仓库维护者配置这两个必需检查。
发布只走 PR/main/tag，不建立长期 develop；本票不改远端保护或发布未经批准的标签。

新增认证、授权、通信、执行或回执时，必须接续父规格的真实 Server/Runtime 跨仓
检查及 Runtime 原覆盖。当前无审批/执行接口，不能把尚不存在的 Runtime 集成用例记为通过。

## 转交最终收尾的真实 Win7 专项

本票涉及进程启动、沙箱、兼容补丁和打包，前期在现代 Windows 验证。
下列 Win7 项保持 unexecuted，负责人为维护者 Neowyh，统一转交 #131，
不阻塞本票的合并、关闭或后续工单领取。Electron 22、Node 兼容、沙箱和软渲染约束继续保留。
前期候选只声明现代 Windows 验证范围，不能把阶段通过写成 Win7 已验证。
收尾必须对最终安装包复验，历史 linz 或现代 Windows 记录不能替代。
由 Neowyh 指定验收人，对下面每项记录 passed / failed / unexecuted / incomplete。

| 编号 | 场景与可观察结果 |
| --- | --- |
| W7-01 | 记录 Win7 版本/SP、补丁、位数、GPU/驱动、构建配置和先决依赖；从最终包 SHA-256 确认候选 |
| W7-02 | 保留旧 linz 安装和旧工作区固定件，独立安装 Desktop，核对目录、快捷方式、卸载身份互不覆盖 |
| W7-03 | 从安装目录和快捷方式启动，Electron 22/Node 16、软渲染窗口正常，无黑屏或崩溃 |
| W7-04 | 未接 Server 显示明确不可用，无模型密钥、办公室、本地 Agent、shell/MCP 或工具执行入口；旧 API 不可调用 |
| W7-05 | 核对 userData 和 Session 均在独立目录，不读取/写入旧库、授权、密钥或会话 |
| W7-06 | 侧栏收起/恢复、中文排版、窗口缩放及未连接状态正常；导航/弹窗和外部页面 IPC 拒绝 |
| W7-07 | 界面退出、窗口关闭、再次启动及第二实例激活，无残留应用/子进程 |
| W7-08 | 卸载/重装保留 Desktop 数据和全部旧 linz 固定件；旧 linz 仍可单独打开查阅 |

#131 还需汇总后续 Runtime、身份、授权、文件、回执、更新恢复及全部声明的知识、技能和工程能力专项，
修复并复验兼容缺口。必需项失败、未执行或不完整时不得关闭收尾票、宣称 Win7 完整兼容交付或归档 linz。
收尾通过后，面向 Win7 的正式发布仍逐次验证最终包，高风险平台变更恢复合并前专项。

## 候选证据

本次执行结果记录于 docs/validation-results.md。人工记录须补充候选提交、
Desktop/Server/Runtime/组件版本、包 hash、依赖 lock hash、环境、配置、场景、命令、
耗时、最终摘要和验收人。Server/Runtime 未接入时写“未接入”，不伪造兼容版本组合。

来源许可证文本未核验或本阶段适用必需项 failed/unexecuted/incomplete 时不放行。
当前仓库无可用真实 Win7 环境，Win7 项保持 unexecuted 并转交 #131，不计作当前阶段阻塞。
