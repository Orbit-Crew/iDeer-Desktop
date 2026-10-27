# #108 安装等待超时修复与重新验收

执行日期为 2026-10-26，Asia/Shanghai。本轮已复现并修复一条会造成安装等待超时的状态竞争；修复后的干净安装包通过在线、离线完整流程和真实故障拒绝测试。原 `online-b` 失败记录保留，未被改写成通过。

## 故障路径

Runtime 的状态线程先查询 SQLite 中的未知写入数，随后读取控制器状态，最后读取在途任务数。执行线程可以在这些读取之间完成写入、保存回执并移除在途任务。

这样会短暂产生来自不同时间点的组合：`activeTasks=0`、`unknownWriteEffects=1`。安装协调器据此拒绝安装并退出排空，即使下一次上报的未知写入数已为 0。此时不会生成维护日志。旧验收驱动只等待维护日志，最终将拒绝表现为约 240 秒的等待超时。

历史 `online-b` 没有保存当时的状态帧，因此无法逐帧还原那一次运行。本轮通过受控交错，在真实安装副本、真实 Server、真实写入和回执上复现了同一故障路径，并取得了修复前后的对照证据。

## 修复与安全边界

`local-runtime/core/desktop.py` 在账本和控制器读取前后各采样一次在途任务数，上报两者较大值。这只会保守地多等待一轮：刚完成的任务不会与旧的未知计数拼成“空闲但未知”；读取期间新进入的任务也不会被漏掉。

真正的未知写入、无法可靠落盘和无法确认进程停止仍会阻止安装。90 秒排空期限没有延长，权限、签名、回执归属及未确认记录的保护没有放松。

验收驱动同时保存状态变化和实际界面结果，遇到明确的 blocked、failed 或异常会立即失败，不再默默等待不存在的维护日志。

## 可复现的前后对照

证据目录为 [evidence/timeout-resolution-20261026](evidence/timeout-resolution-20261026)。

| 验证 | 修复前 | 修复后 |
| --- | --- | --- |
| 实际 `desktop.main()` 状态组装与真实 SQLite 回执库，完成发生在两次读取之间 | 1 failed、2 passed；失败帧为“在途 0、未知 1”，实际账本已无未知写入 | 三种边界均通过；加上排空拒绝回归共 5 passed |
| 临时安装副本中的受控时序，真实文件任务恰在状态读取期间完成 | `r-10c895e1`，退出 1，27.907 秒；界面明确拒绝安装，随后未知计数恢复为 0，未生成维护日志 | `r-d2bf248b`，退出 0，61.766 秒；同一时序下完成安装、重启和原回执补传 |

受控时序只暂停临时副本的观测方法，不修改任务结果、账本、权限或 Server 响应。两次运行均记录 `timingInjection.testOnly=true`。诊断代码和旧模块快照在证据目录 `diagnostic/`，不属于交付安装包。

新增回归 `local-runtime/tests/test_desktop_drain_snapshot.py` 覆盖完成、新任务进入、真正未知写入三种情况。修复前后的命令和完整压缩日志保留在 `snapshot-contract-*-command.json`、`snapshot-contract-*.log.gz`。

## 最终候选

提交与执行候选的对应关系见 [publication.json](publication.json)。发布核对覆盖 160 个产品、测试及构建文件和 4 个验收驱动。先校验执行文件的原始 hash，再将 CRLF 统一为 LF 与 Git 提交内容比较，结果一致。Git 文本换行规范化会改变原始字节 hash；原验收绑定继续记录实际执行字节。后续文档提交只发布索引及证据，不代表重建或重跑安装包。

- 分支 `codex/issue-108-acceptance`，基于 `7fe3877dc88fe8f156bb8e038a004ffa91fee2d2`，加上本分支的两项 #108 修复及回归。验收执行时尚未产生新提交，逐文件绑定见 `candidate-binding.json`。验收后相同产品及测试源码已提交为 [`d17721cb6950ba4eb2457c4d2ccc3c0fae5c4a17`](https://github.com/Orbit-Crew/iDeer-Desktop/commit/d17721cb6950ba4eb2457c4d2ccc3c0fae5c4a17)。
- 产品及测试源指纹为 `8f8c87ee4d9cd1e4e4ea53bb0338f3d90882312ef1bf2d7cb5deabf2b234253a`，算法与清单见 `desktop-source-binding.json`。
- 安装包 `ideer-desktop-0.2.0-windows-x64-setup.exe`，92,395,057 字节，SHA-256 `b04e83d30a1230d46b909c72caeba1cad55793b2e52c81fc617a4705f9fe370d`。
- Windows 11 Pro 10.0.26300 x64，Node 22.14.0，Electron 22.3.27，随包 Python 3.12.10，测试 Python 3.12.14。依赖锁、组件 hash、安装包信任 sidecar 和各驱动 hash 均已绑定。
- 正式候选的 `core/desktop.py` SHA-256 为 `b78dac996715b46578f9d7af8376a3b90a8fd92cd8ce167ce6cb46220a62d939`，与仓库和随包源码一致，不含观测屏障。三组正式结果均没有 `timingInjection`。
- 发布资产使用隔离测试 Ed25519 密钥，公钥指纹为 `2836a6c72360fca73c8bbf737a2d789224fdaa4ebf964ec6f53e5676ea7f49db`。证据中包含公钥、清单及签名，可独立验签；没有私钥、真实凭据、个人资料或数据库。
- Server 为原 PR146 head `99cd9b8961be2a9ee079a06b9dede0f0dd3c86bf` 的真实 Gateway，无 Server 产品源码改动。模型仅确定性选择真实工具；没有外部模型调用或人工签核声明。

## 干净安装包重新验收

| 场景 | 本轮结果与证据 | 结论 |
| --- | --- | --- |
| T108-01 | 在线 `clean-online-b`、离线 `clean-offline` 都通过真实 UI 取消、确认排空、在途写入正常完成、新派发 `UPDATE_DRAINING` 拒绝及零副作用检查 | passed |
| T108-02 | `clean-blockers` 对真实 SQLite 完成落盘失败、清除存储闩锁后仍存在的真实未知写入分别拒绝安装，保留程序 hash 和原未知记录。进程停止失败、排空超时及原生进程保护由同候选完整合同测试覆盖；本轮未模拟 OS 不可终止进程 | passed，覆盖层级如左列所述 |
| T108-03 | 两条更新路径都从真实写入生成 pending 回执；更新时无需等待 Server 确认；重启后同一身份、设备、Run、Task、请求及回执 hash 成功补传并获确认，原任务一次派发、一次执行 | passed |
| T108-04 | 在线实际下载签名清单、签名及补丁；离线实际导入同一资产；均完成维护、替换、真实 Desktop 窗口/renderer/IPC 和 Runtime echo 核验 | passed |

所有正式运行使用全新测试身份、数据库和 `--user-data-dir`。在线、离线从新 NSIS 安装开始；故障组使用离线更新后的同一程序及新的隔离身份。正式结果与受控诊断结果分别归档。

## 执行命令与结果

| 命令或运行 | 结果 | 耗时 |
| --- | --- | --- |
| `npm.cmd run typecheck` | 退出 0 | 8.313 秒 |
| `npm.cmd test -- --no-cache --reporter=json --outputFile=…` | 退出 0，94 passed | 28.469 秒 |
| `python -m pytest local-runtime/tests -q -rs --basetemp <独立 TEMP>` | 退出 0，400 passed、6 skipped、2 warnings | 139.469 秒 |
| `python -m ruff check local-runtime --select E9,F63,F7,F82` | 退出 0 | 0.297 秒 |
| `python scripts/verify-runtime-source.py` | 退出 0 | 0.156 秒 |
| `node scripts/verify-provenance.cjs` | 退出 0 | 0.641 秒 |
| `npm.cmd run dist:win` | 退出 0，最终安装包及信任 sidecar | 75.484 秒 |
| `acceptance.cjs <clean-online-b>` | 退出 0，在线 8 个记录用例 | 44.766 秒 |
| `acceptance.cjs <clean-offline>` | 退出 0，离线 8 个记录用例 | 63.313 秒 |
| `blockers.cjs <clean-blockers>` | 退出 0，2 个真实故障用例 | 30.750 秒 |

命令记录包含实际解释器、完整参数、UTC 起止时间、退出码及耗时。六项跳过为两个无 Windows symlink 权限的用例和四个 POSIX/非 Windows 专项，原因保留在完整 `-rs` 日志中；未记为通过。

## 测试环境与清理

本轮还遇到 WSL 宿主进程启动 `0x8007274c` 以及 Windows 自动 localhost 转发超时。Ubuntu 内部直接请求真实 Gateway 能得到正确补丁 hash。正式测试因此使用任务私有的 TCP 通道：Gateway 绑定 WSL 私有接口，Windows 入口仅绑定 `127.0.0.1`，逐字节转发到真实 Gateway，不处理或模拟 HTTP、WebSocket、认证或业务响应。

客户端的三条正式链路都先从 Windows 取得补丁并独立核对 hash，再生成隔离身份。临时绑定包装器、转发器源码和传输配置一并归档在 `diagnostic/`。没有重启用户 WSL、修改防火墙、系统 portproxy、生产权限或 Server 产品源码。测试结束后 Gateway 和转发器均退出；清理记录显示无残留连接，三轮各自六个合成凭据引用均已移除。

早期普通循环中通过的尝试、未进入目标阶段的配对/工作区/HTTP 失败、屏障搭建失败及打包缓存解压失败，均不替代本轮正式结果。原始尝试保留在本工作树忽略的 `artifacts/issue-108/timeout/`；归档摘要不将失败改写为成功。第一次打包遇到 WinCodeSign 缓存解压的符号链接权限错误，复用已有完整缓存后成功，失败与成功日志都保留。

当前结论限于 #108 的现代 Windows 自动及 UI 验证。它不替代人工发布审批、#109/#111 的新验收，也不宣称所有旧环境故障均来自这次状态竞争。真实 Win7 仍为 `unexecuted`，由 Neowyh 在 [#131](https://github.com/Orbit-Crew/iDeer/issues/131) 承接。
