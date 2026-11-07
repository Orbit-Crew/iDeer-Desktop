# Desktop 0.1.0 移植记录

规格为 [iDeer #96](https://github.com/Orbit-Crew/iDeer/issues/96)，上位合同为
[#95](https://github.com/Orbit-Crew/iDeer/issues/95)。来源固定为
[Neowyh/linz f88141b](https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13)。
一次性复制受管源码后裁剪，不维护 linz 同步分支，不复制工作树中的个人配置、
临时 ZIP、嵌套仓库或历史产物。未改变 linz 仓库或安装。

## 责任和身份

组织维护者 Neowyh 负责来源及许可证核验、跨仓验收、真实 Win7 验证和发布签核。
Orbit-Crew/iDeer-Desktop 维护主进程、preload、React UI、构建与安装包，以及后续迁入的
Python Runtime。Orbit-Crew/iDeer 维护 Server、共享协议和阶段协调；工具仓维护者负责
工程组件与许可证。本票只建立未连接的桌面基线，不宣称父规格 AC01/AC15 全部完成。

2026-10-17 用户确认前期仅在现代 Windows 验证，Win7 专项集中到最后的
[收尾 #131](https://github.com/Orbit-Crew/iDeer/issues/131)，权威时序见
[父规格 #95](https://github.com/Orbit-Crew/iDeer/issues/95)。本记录中的 Win7 兼容目标和验证要求保留，
执行时间后置；Win7 未执行不再阻塞前期票的合并、关闭及后续工单领取。

版本 0.1.0，包名 ideer-desktop，appId com.orbitcrew.ideer.desktop，显示名 iDeer Desktop，
可执行文件 ideer-desktop.exe。NSIS 使用独立 appId 派生的安装身份，用户选择安装目录，
默认按当前用户安装，不复用 linz 的安装记录或快捷方式。
数据固定在 `%APPDATA%/iDeer Desktop`，Chromium 会话在其 Session 子目录。
卸载保留应用数据。未读取或迁移旧 `%APPDATA%/linz`、旧工作区、密钥、会话或授权。

## 源码和依赖

resources/provenance/linz-source.json 保存来源文件的 SHA-256。
原 package.json 和完整 lock 原样保存用于追溯；它们不参与安装。
`npm run verify:provenance -- /path/to/linz` 可对指定提交逐文件核验。
发行实际依赖使用仓库根 package-lock.json，`npm ci` 重建。
直接 UI 和构建依赖沿用上游 lock 的确切版本；Electron 固定 22.3.27。
构建主机使用 Node 22，应用主进程面向 Electron 的 Node 16，renderer 面向 Chrome 108。

| 来源文件 | 处理 |
| --- | --- |
| src/main/index.ts、window.ts | 保留生命周期和窗口组织；移除旧服务初始化、托盘常驻、任意外链打开及补丁执行，加入独立目录、单实例和最小 IPC |
| src/preload/index.ts | 重建为 status/quit 两项接口，未迁移 aeromind 通用执行接口 |
| src/renderer/src/main.tsx、components/ErrorBoundary.tsx | 原样复制 |
| App.tsx、components/Layout/AppLayout.tsx、Sidebar.tsx、stores/uiStore.ts | 按原布局、配色与侧栏交互裁剪；移除业务路由、旧状态和本地编排 |
| assets/styles/globals.css | 保留基础样式段，去除 Agent 和业务样式 |
| postcss.config.js、tailwind.config.js | 原样复制 |
| electron.vite.config.ts、electron-builder.yml、renderer/index.html | 按最小产物调整，保留开发/打包路径定位，加入 CSP、独立安装身份和版本 |

原来源只声明 MIT，没有根 LICENSE。保留声明于 THIRD_PARTY_NOTICES.md，
维护者补齐授权核验前不得对外分发。没有伪造已确认的版权或许可证文本。
Desktop 的 package metadata 暂标 UNLICENSED，来源包原始 MIT 声明原样留存。

## 兼容补丁台账

| 补丁 | 原因、再应用与验证 | 责任、移除条件 |
| --- | --- | --- |
| resources/compat/node16-banner.cjs | 从上游 Vite banner 提取，构建时在 main bundle 顶部注入。保留 stream/web、Blob、structuredClone、文本流兼容。使用 v8 保留循环引用与 Date，无法克隆时抛错；文本流使用 TransformStream 保留背压和 decoder flush。避免上游 JSON 克隆失败返回原对象及手工 writable 的缺陷。test/compat.test.ts 验证；桌面 smoke 在真实 Electron Node 16 上复验 | Desktop 维护；Electron/Node 基线升级并完成 Win7 重新决议后才移除 |
| disableHardwareAcceleration / disable-gpu | ready 前设置，沿用软渲染策略。桌面 smoke 核对，真实 Win7 验证黑屏、窗口和退出 | Desktop 构建维护；真实支持矩阵改变后评审 |
| renderer sandbox、contextIsolation | 不沿用全局 no-sandbox 和 webview。最小 preload 只依赖 Electron 允许的 API，无旧模块必须退出沙箱；真实 Electron smoke 和 Win7 专项验证，若不兼容须阻断，不能静默关闭 | Desktop 维护；任何调整都需安全和 Win7 专项 |
| 原生资源与路径 | 随能力交付逐步补齐：node-pty 原生模块（#110，主进程 PTY）、随包 Python Runtime（runtime-migration）、occt-import-js WASM（#115，`extraResources resources/occt → occt`，装在 asar 之外由 glue 用 fs 读取，无需 asarUnpack）。仍无 worker；未机械携带 better-sqlite3。新增原生/WASM 资源时须补准确的 extraResources/资源定位与验证 | 各能力实施负责人；能力交付前必须补齐 |

这些补丁不修改 node_modules，`npm ci && npm run build` 会重新应用。
pi-tui 补丁随旧 Agent 依赖排除，不遗留无目标的 postinstall。
structuredClone 的 v8 补丁只保证可序列化数据，不声明 transfer 或完整浏览器克隆语义。

## 2026-10-31 dock 多窗格框架恢复（iDeer-Desktop #71）

一期·1 按同一受管移植模式恢复 [Neowyh/linz f88141b](https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13)
的 `src/renderer/src/dock/*`（11 个文件）与 `components/Chat/LayoutPresetDropdown.tsx`，
共 12 个来源文件已按原样 SHA-256 追加进 `resources/provenance/linz-source.json`，
`npm run verify:provenance -- /path/to/linz` 可逐文件核验。移植为裁剪适配而非逐行复刻：
chat 锚点直接承载平台聊天（无路由）、新增 Desktop 特有 `runtime` 伴随窗格、未接线能力按
原栏目位置注册如实占位、锚点页签不可拖出、`ensureAnchorPane` 修复单窗格根的可达性。
分歧清单与验收记账见 [docs/acceptance/issue-71/report.md](acceptance/issue-71/report.md)
（三层验收第一层：入口恢复）。

## 2026-11-03 文件树与只读预览恢复（iDeer-Desktop #94）

二期·15 恢复 linz `[FilePanel]` + `[file-browser IPC]`（来源固定为
[Neowyh/linz f88141b](https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13)的
`src/renderer/src/components/RightPanel/FilePanel.tsx` 与 `src/main/ipc/file-browser.ipc.ts`，
可在该提交查阅）的能力。本次为**全新实现而非受管复制**：未复制 linz 源码，无
provenance 条目；实现走 Desktop 自己的缝——人工浏览经 Runtime 新增的 `files` 控制
命令族复用工作区存储的守卫（链接/junction/保护路径纪律与 Agent 读路径一致），
不经任何审批；`locate` 的物理路径只回给可信主进程用于外部打开/资源管理器定位，
渲染层始终只见逻辑路径。与原版的既声明分歧：内置预览仅覆盖严格 UTF-8 文本
（1 MiB 封顶）与常见位图（2 MiB 封顶），PDF/Word/Excel/二进制走外部打开；
浏览要求已确认的工作区授权（授权本身绑定账号与设备）。

## 2026-11-05 本机浏览器窗格恢复（iDeer-Desktop #107）

五期·31 恢复原版浏览器窗格能力。与 #94 相同为**全新实现而非受管复制**：未复制
linz 的 `ipc/browser` 或浏览器面板源码，无 provenance 条目。实现走 Desktop 自己的缝：
唯一外部内容面是钉死固定持久分区（`persist:browser-pane`）的 webview，主进程在附加时
重新校验（该分区、无 node integration、无 preload、首文档必须是 http(s)）；分区级
权限请求默认拒绝并逐条可见、文档加载限制 http(s)、下载经 Runtime 守卫的 `files locate`
落到已确认授权文件夹（碰撞自动改名、无授权即拒绝）、弹出窗口不开原生窗而是作为事实
路由回所属窗格。渲染层地址栏与主进程共用同一地址语法（无搜索引擎代搜），清空分区
在可信主进程确认。分歧清单：不恢复旧任意 IPC 旁路与本地搜索引擎兜底；`instanceId`
不用（页签状态窗格本地、随窗格消亡，与 dock 持久化契约一致）；渲染层 CSP `frame-src`
从 `'none'` 放宽为 `http: https:`（仅为承载校验过的 webview，`connect-src` 仍为 `'none'`）。
安全缝测试更新见 test/security.test.ts；桥键与 webview 断言同步进桌面 smoke。

## 2026-11-07 CAD 三维查看器恢复（iDeer-Desktop #115）

六期·40 恢复原版 Viewer3D 能力：STEP/STL/OBJ 本机加载与三维显示。随包组件按前置
决议完成来源与许可核验后进入本包：

- **occt-import-js（OpenCASCADE WASM）**：glue `.js` 与 `.wasm` 二进制逐字节取自来源
  提交 [Neowyh/linz f88141b](https://github.com/Neowyh/linz/tree/f88141bb3d3450a572fcc52e0f9b48a1e60d3b13)
  的 `resources/occt/`，SHA-256 登记进 `resources/provenance/linz-source.json`
  （`npm run verify:provenance` 可核验），经 `electron-builder.yml` `extraResources`
  以 `resources/occt → occt` 随包（asar 之外）。上游为 occt-import-js（MIT，glue/wasm
  构建产物）与 Open CASCADE Technology（LGPL-2.1-with-OCCT-exception），登记于
  THIRD_PARTY_NOTICES.md；STEP 只读转换在可信主进程完成。
- **three.js 0.185.1**（MIT，npm 精确锁定）：渲染进程 WebGL 引擎；`@types/three`
  为开发依赖。依赖清单钉死测试同步更新。
- 实现与原版同构而走 Desktop 自己的缝：渲染端只提交工作区逻辑路径；主进程经
  Runtime 既有 `files locate` 守卫解析物理路径并读取字节（物理路径与文件字节不出主进程），
  STL/OBJ 由本地纯解析器转三角网格，STEP 经 occt-import-js 三角化，唯一 IPC 通道
  `desktop:cad` 单动作 `read-mesh`，回复为一份有界网格负载（TypedArray + 如实统计）。
- **大模型策略如实**：文件 100 MB 上限（原版 STEP 上限沿用并覆盖全部格式）、
  1,000,000 三角面软渲染预算（二进制 STL 由 84 字节头部在读正文前预检）；超限、
  空几何、坏索引、引擎缺失均按稳定错误码显式拒绝，不静默降级。
- **2D 回退**：three.js WebGL（软渲染基线）失败时自动切软件 2D canvas 引擎并明确提示；
  两种引擎均拖拽旋转/滚轮缩放，支持实体/线框/点云。
- 与原版的既声明分歧：入口为工作区逻辑路径（无工作区即显式待就绪态）；对话→面板
  自动开窗命令不在本票（#117 结果自动开窗）；几何编辑不做（原版也没有）；IGES 等
  新增格式不做，白名单外后缀按码拒绝。安全缝：viewer3d 与 terminal 同判——桌面本地
  内容，非外部内容，离开 external 占位缝，钉死测试与模块图断言见
  test/security.test.ts 与 test/cad-bridge.test.ts。Win7 真机渲染（SwiftShader 性能
  与 2D 回退可用性）留待 #131 收尾专项。

## 能力清单

以下来源均固定为 f88141b；未复制实现仍保留在该提交可查阅，未删除原覆盖。
未迁入代码不随包分发，因此不能通过隐藏路由或旧 IPC 执行。

| 能力及来源目录 | 状态与原因 | 依赖、重纳入条件、阶段及验证 | 维护责任 |
| --- | --- | --- | --- |
| main/window、renderer/Layout、React/antd/zustand | 本票保留最小 UI，显示未连接，关闭即退出 | 静态、状态/能力合同、Windows 安装/退出及 Win7 专项 | Desktop |
| ipc/chat、llm、pi、agents、scheduler、OfficePage、office 资源 | 排除自行驱动模型、Agent/多 Agent 和独立平台演进；办公室经范围决议（[Desktop #112](https://github.com/Orbit-Crew/iDeer-Desktop/issues/112)）收窄恢复为平台 Run/子代理事件只读可视化，无控制操作、无本地消息总线、无第二引擎 | 其余不列为后期承诺；办公室只读窗格按 #112 验收（纯只读、无事件不伪造、桥契约测试覆盖事件映射） | iDeer 规格维护者 |
| ipc/approval、security、tools、mcp、terminal、browser、file-workspace | 暂缓旧本地执行链，防止旁路；任意 shell 排除 | 一期按 Runtime 任务、目录授权和审批合同适配；接续安全、拒绝、身份、链接逃逸和真实跨仓验证 | Desktop Runtime / Server 各自维护者 |
| workspace、ChatPage、conversation、Agent/Skill 选择及 settings | 暂缓业务接线，无本地离线兜底 | 一期登录、设备、Server 资源及 Thread/Run/Turn 接入；用户/设备隔离和真实跨仓检查 | Desktop UI / Server |
| Python Runtime | 后续专票迁入，当前未安装且不启动 | 固定 Python 依赖、独立进程和稳定本机接口，接续原测试；切换验收后再删 Server 原设备实现 | Desktop Runtime |
| kb、parsers、database、knowledgeGraph、wiki、sql.js、better-sqlite3 | 暂缓，尚未适配平台身份、Revision 和 Runtime | 知识与技能阶段；原文件重导入，图谱/Wiki 重建，权限/引用/失败及 Win7 native ABI 验证；图片占位不作为 OCR 交付 | Desktop 知识 / Server 治理 |
| agent-skills、skills、脚本、pandoc、便携 Python | 暂缓，不能直接运行旧技能脚本 | 知识与技能阶段；完整包确认上传 private、固定版本、环境和脚本授权；随包二进制许可证/Win7 验证 | Desktop 技能 / 工具维护者 |
| Tecplot、CATIA、Abaqus | 暂缓，未纳入当前包 | 工程阶段；固定组件、依赖/许可探测、统一文件授权、实际软件和 Win7 专项（step/occt/Viewer3D 已按 #115 恢复，见 2026-11-07 段） | 工具仓及 Desktop 面板维护者 |
| catia-smart | 暂缓安装分发 | 先核验 SDK/插件权利、依赖和 Win7，再决定阶段，不自动列入下一期 | 工具维护者 |
| updater、gen-manifest、gen-patch | 暂缓旧未签名更新，不注册补丁文件关联或 CLI 执行 | 一期安全更新；签名、排空、组合恢复和数据保护专项 | Desktop 构建发布 |
| 旧会话、配置、密钥、自动迁移、macOS/Linux | 排除当前交付范围 | 人工迁移说明由退役阶段提供；不得自动读取或删除旧数据 | 迁移维护者 |

## linz 冻结和旧数据查阅

按父规格已确认冻结边界，linz 停止新功能，只接受安全、严重现用阻断和必要迁移修复。
其他开发进入 Desktop。冻结不表示立即归档。旧安装仍从原快捷方式打开，旧数据从原
工作区及原用户数据目录查阅。请保持原安装和目录；Desktop 的安装、启动和卸载没有
旧资料清理步骤。不得把旧模型密钥、批准记忆或单机身份带入新账号。

替代能力含图谱/Wiki 验收、#131 最终包真实 Win7 核心及全部声明能力专项通过、逐用户迁移确认或明确不再使用、旧数据保留告知、
阻断问题清零及维护者确认全部满足后才能停止有限维护并归档。建仓和一期可用均不满足退役条件。
