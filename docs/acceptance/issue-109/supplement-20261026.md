# #109 真实安装故障与恢复后功能验收

执行日期为 2026-10-26，Asia/Shanghai。执行者为 Codex，全部为自动验收，原生对话框的选择来自测试驱动。本轮完成六组真实 NSIS 安装及随包维护 helper 故障检查，并在真实 Server/Desktop/Runtime 组合上完成恢复后的文件任务、原回执补传、授权和 KB 访问检查。没有产品代码修改。

## 候选与边界

Desktop 执行基线为 `a30ec98134600fea97bd4745b8a280d9573c5261`，包含 #108 修复提交 `d17721cb6950ba4eb2457c4d2ccc3c0fae5c4a17`。本轮分支为 `codex/issues-109-111-acceptance`。验收驱动执行时尚未提交，完整逐文件记录在 [candidate-binding.json](evidence/supplement-20261026/candidate-binding.json)。

验收驱动和报告随后提交为 `a30258315b23215c6659adc2ea12d9846d88e86f`。与实际执行字节的 168 项核对及 Git 换行说明见 [publication.json](publication.json)。后续文档提交只记录发布对应关系。

- 安装包为 `ideer-desktop-0.2.0-windows-x64-setup.exe`，92,395,057 字节，SHA-256 `b04e83d30a1230d46b909c72caeba1cad55793b2e52c81fc617a4705f9fe370d`。
- 160 个产品、测试及构建文件的执行指纹仍为 `8f8c87ee4d9cd1e4e4ea53bb0338f3d90882312ef1bf2d7cb5deabf2b234253a`，与 #108 最终候选一致。源清单见 [desktop-source-binding.json](evidence/supplement-20261026/desktop-source-binding.json)。新增内容是验收驱动及文档，没有重建或替换该安装包。
- Server 为 `99cd9b8961be2a9ee079a06b9dede0f0dd3c86bf` 的真实 Gateway，产品源指纹 `3d85edf53ecbb35db5c0969428258e312b01f0786a91405f0c19148ebd8a78cc`。模型确定性选择实际工具，没有外部模型调用。
- Windows 11 Pro 10.0.26300 x64；构建及驱动 Node 22.14.0；Electron 22.3.27；随包 Python 3.12.10；Windows 测试 Python 3.12.14。沿用隔离测试公钥，指纹 `2836a6c72360fca73c8bbf737a2d789224fdaa4ebf964ec6f53e5676ea7f49db`，归档含公钥及签名，私钥留在仓库外。

每组使用新的 TEMP 安装目录及 `--user-data-dir`，不置换真实用户的配置目录。原生故障驱动编译仓库的暂存/事务 API，并执行安装包 ASAR 中提取的维护 helper。原生 host 方法、签名、进程检查与健康响应均未替换为 mock。

## 逐场景结论

| 场景 | 操作、预期与实测 | 结果 |
| --- | --- | --- |
| T109-01 | 在真实第二文件复制失败、维护进程复制中断和 Runtime 启动失败处注入故障。用户文件 canary 及真实 SQLite pending 账本的前后 hash 一致。跨仓组另外创建真实目录授权并撤销，生成真实写入回执，再经失败回滚验证当前合法凭据引用、撤销事实和 pending 记录保持。 | passed |
| T109-02 | 四组可读数据故障均恢复完整原程序 hash，并取得真实窗口/renderer/IPC/Runtime echo。另一签名候选在实际启动时将格式写为 2 并退出，旧读取器仅接受 1；helper 保留新数据、备份及诊断，报 `RECOVERY_DATA_FORMAT_UNREADABLE`，没有盲目启动旧程序。 | passed |
| T109-03 | 正确签名、声明 Desktop 0.2.1 但 ASAR 实际仍为 0.2.0，真实健康握手发现组合不符后回滚。再损坏隔离备份，恢复报 `RECOVERY_BACKUP_INTEGRITY_FAILED`；再次启动 helper 不重试事务。可读配置上的实际 UI 显示恢复状态，第二次安装返回 `UPDATE_RECOVERY_LOCKED`，人工修复说明保留数据与备份路径。 | passed |
| T109-04 | 配对组从真实写入生成 pending 回执，故意丢弃 Server ACK，实际回滚后同一身份、设备、Run、Task、请求/回执 hash 补传并确认，原任务仅一次派发和执行。恢复后的新写入及读取均通过真实工具；原撤销授权不复活，KB canonical 资源的原所有者仍可查询、另一用户仍拒绝。 | passed |

原生矩阵中的凭据引用和 KB canary 只证明文件保持，不当作真实身份或检索证明。真实凭据引用、目录授权及 KB HTTP 访问由配对组分别验证。KB 检查覆盖资源归属和 provider-binding 元数据；隔离环境未配置检索提供方，其初始化失败状态在更新前已稳定并如实保留。本轮不宣称 KB 内容检索或入库能力交付。

## 实测命令与证据

完整入口见 [驱动说明](../../../scripts/acceptance/issue-109/README.md)。所有结果及命令记录均在 [本轮证据目录](evidence/supplement-20261026/)，包含完整参数、UTC 起止时间、退出码、时长、程序 hash、截图及压缩日志。

| 执行入口 | 退出码及结果 | 耗时 |
| --- | --- | --- |
| `native.cjs copy-failure ...` | 0，实际部分复制后恢复完整旧组合 | 36.187 秒 |
| `native.cjs interruption ...` | 0，终止自己的维护进程后从同一持久事务恢复一次 | 33.953 秒 |
| `native.cjs startup-failure ...` | 0，真实 Runtime 启动失败后恢复并核验 | 52.484 秒 |
| `native.cjs combination-mismatch ...` | 0，真实版本不匹配后恢复 | 44.734 秒 |
| `native.cjs unreadable-format ...` | 0，正确进入持久 `recovery-failed` 并保留格式 2 | 56.141 秒 |
| `native.cjs recovery-failure ...` | 0，正确锁定人工修复，后续 helper 不重试 | 33.219 秒 |
| `run-paired.ps1 ...`，`paired-stable` | 0，完整真实跨仓恢复功能；其中 Desktop 驱动 80.812 秒 | 105.172 秒 |
| `vitest run test/recovery.test.ts --reporter=json ...` | 0，18 passed | 21.938 秒 |
| Server `uv run --no-sync pytest -q ...` | 0，165 passed、6 warnings；任务/回执/恢复、身份、MCP、附件归属与更新路由集合 | 20.078 秒，pytest 16.33 秒 |

本轮没有产品变更。#108 相同的 160 文件指纹绑定 typecheck、Vitest 94 passed、Runtime 400 passed/6 skipped、ruff、provenance 及 Windows 打包结果；这些是匹配候选的已执行记录，没有称为本轮重跑。另已核对 Desktop [PR #19](https://github.com/Orbit-Crew/iDeer-Desktop/pull/19) 的 Linux 与 Windows CI 均成功。完整 Server 交付门禁将作为后续 #111 的独立记录，不能由本表 165 项聚焦测试替代。

原生矩阵的最终驱动 SHA-256 为 `483ed29983ab6d18b284588a1607cec080f75085e1843241fd4bd704cd724820`。不可读格式另归档实际 `health-request.json` 的 `rollback=false`、最终事务及修复说明，且安装后的 ASAR 仍为新候选，未恢复旧 ASAR。

从绑定的 Windows 工作树执行 `node docs/acceptance/issue-109/evidence/supplement-20261026/verify-evidence.cjs`，核对源文件、原安装包、签名、六组故障及配对结果。`--archive-only` 可独立核对归档结果与签名；输出明确标记未核对本机原安装包和执行树。Git 会规范化源码换行，执行绑定保留实际 Windows 文件字节。

## 失败尝试、环境与清理

早期驱动遇到 ASAR 内路径、清理完成的健康会话、签名 ASAR 缺项及残留测试进程等问题，部分原始失败已归档为 `historical-*`。没有将失败记录改写为通过。两次子任务因模型服务容量/额度中断，父任务先归档未提交驱动，再独立复核六组最终记录、补跑真实跨仓链路。

配对组前两次在撤销授权后的重连时序上失败；第三次真实回滚及读写已成功，最后因 KB 异步初始化的前后快照时间不同失败。驱动随后等待真实 broker 握手及 KB 初始化稳定，再用全新安装、身份和状态完成最终 `paired-stable`。原始失败与最终成功分别归档，均未重派不确定任务。

跨仓传输沿用任务私有的 WSL 私有接口及 Windows `127.0.0.1` 原始 TCP 转发，真实 HTTP、WebSocket、认证和业务响应保持原样。没有重启 WSL 或改系统网络配置。最终 Gateway 与转发器均以 0 退出，剩余连接为 0；六个本组合成凭据引用均已移除。程序清理只操作已完成验证的隔离进程，不用强制清理充当写任务安全停止证明。

本结论限于现代 Windows 上本票的自动化及 UI 验证，不代表人工发布批准。真实 Win7 仍为 `unexecuted`，由 Neowyh 在 [#131](https://github.com/Orbit-Crew/iDeer/issues/131) 承接；待复验六组故障、数据保护和恢复后的真实功能。
