# Issue 118（迁移向导）acceptance

Specification: [iDeer-Desktop #118](https://github.com/Orbit-Crew/iDeer-Desktop/issues/118)
（六期·44），parent [#70](https://github.com/Orbit-Crew/iDeer-Desktop/issues/70)。
前置 [#91](https://github.com/Orbit-Crew/iDeer-Desktop/issues/91)、
[#92](https://github.com/Orbit-Crew/iDeer-Desktop/issues/92) 已在 develop 合并关闭。

Desktop base: `8f1bcb6`（= origin/develop），branch `feat/issue-118-migration-wizard`。
目录名带 `-migration-wizard` 后缀，因为 `docs/acceptance/issue-118/` 属于旧编号
时代的同名工单（见 dev-log 与 2026-10-30 corrections 索引）。

## 三层验收记账（GLOSSARY 三层验收）

| 层 | 范围 | 状态 | 证据 |
| --- | --- | --- | --- |
| 入口恢复 | 侧边栏「旧版迁移」入口、向导模态、永不迁告知、指路列表、失败可重试 UI | 自动化测试覆盖（`test/migration-wizard.test.tsx`，9 例） | 本报告 |
| 业务接线 | 只读扫描（名册白名单 + stat 证据 + 名册缺失/名册损坏如实标注）、逐个确认的 create+bind 组合、未确认不迁、重复迁移拒绝、失败行可重试且不重复建项目、状态快照迁移账目、wire 门禁 | 自动化测试覆盖（`local-runtime/tests/test_workspace_migration.py` 17 例 + `test/migration-bridge.test.ts` 形状契约；desktop 门禁由 desktop smoke 覆盖） | 本报告 |
| 实际候选验收 | 安装包内真实旧版 linz 共存扫描、真实平台 create/bind 往返、代表用户人工演练 | **未执行**，待真实候选与代表用户（衔接 iDeer #130 T130-01/T130-02） | 无 |

## Scenario contract（注册于实现前，随工单验收标准）

| 场景 | 对应 AC | 执行方式与结果 |
| --- | --- | --- |
| 旧工作区探测列出、逐个确认后才迁移 | AC1 | `test_workspace_migration.py::test_scan_*`（只读、白名单、证据、孤儿目录、名册损坏）；`migration-wizard.test.tsx`（确认勾选前迁移按钮禁用且点击无调用）。**passed** |
| 确认后自动建平台项目+绑定文件夹 | AC2 | `test_migrate_creates_platform_project_and_binds_roster_folder`、`test_migrate_without_folder_creates_project_only`（fake platform fixture 上恰好一次 POST /api/projects + 本机绑定行）。**passed** |
| 各重导入入口指路可达、逐项导入可重试 | AC3 | `migration-wizard.test.tsx` 指路测试（kb/runtime/templates 深链断言 + Agent 配置入口不虚设）；重试为 `test_migrate_retry_*` 两例（含"已建项目仅补绑定"）。**passed** |
| 未确认项不迁移（负路径用例） | AC4 | `test_migrate_unknown_workspace_is_refused`（扫描无法佐证的 workspaceId 在任何平台调用前拒绝，账目为空）。**passed** |
| 永不迁清单（密钥/批准记忆/执行状态/旧聊天）有验证 | AC5 | `test_scan_whitelist_never_surfacing_legacy_secrets`（诱饵 apiKey/密文/批准记忆/工具策略逐字不出现）；`test_scan_never_opens_or_writes_legacy_databases`（垃圾库字节不解析、目录树字节与 mtime 全等）。**passed** |
| 与 iDeer #130 人工演练流程衔接说明更新 | AC6 | docs/porting.md 2026-11-08 段（边界 + T130-01/T130-02 衔接）+ 本报告。**passed** |

## 边界与已知限制

- 探测根按参考 linz 布局固定为 `%APPDATA%/linz`（Windows）；装在别处的旧版不猜测。
- 扫描上限 50 个工作区；名册字段超界按空值处理，不截断原文进入界面。
- Runtime 服务与桌面门禁只接受固定类别错误（MIGRATION_* / CHAT_*）。
- 实际候选人工验收未执行；本报告不宣称向导在安装包内已通过真实旧版演练。

## 与 iDeer #130 的衔接

T130-01 的逐工作区确认记录 = 向导内「确认归属」勾选 + 受信任主进程原生确认
对话框（对话框正文即永不迁清单告知）。T130-01/T130-02 的"旧会话/执行状态不
迁、旧数据不覆盖不删除"由 porting.md 2026-11-08 段的冻结边界与本报告 AC5
证据共同承载。原文件重导入（KB/表格/技能）按向导指路入口人工执行，并按 #130
的逐用户记账要求留痕；向导的迁移账目（workspace-migrations.db）只是本设备
显示事实，不替代 #130 的人工演练记录。
