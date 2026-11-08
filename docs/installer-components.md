# 安装向导按需勾选与离线组件包（#119）

桌面安装器（NSIS assisted installer）提供三档依赖与工程组件勾选；装后可
随时用离线组件包补装；全部内容版本锁定，安装过程不联网下载任何额外内容。

## 三档依赖（安装向导）

| 档位 | NSIS InstallType | 内容 |
| --- | --- | --- |
| 最小安装 | InstType 1 | 主程序 + 内置 Python Runtime。Runtime 是核心依赖（应用离开它无法工作），因此它不作为可选组件，而是必装项。 |
| 常用安装 | InstType 2 | 最小安装 + 常用工程组件（CAD 查看器）。 |
| 自定义 | InstType 3 | 从常用配置开始，逐个勾选工程组件。 |

数据源是 `resources/components/catalog.json`（单一事实来源）；
`resources/nsis/components.nsh` 由 `npm run components:generate` 从目录生成
并签入仓库，测试逐字节锁定两者一致。选择即装、未选不装：未勾选的组件
section 完全不执行（`test/nsis-components.test.ts` 用真实 makensis 编译并
静默运行两种选择组合验证）。静默安装（`/S`，CI 冒烟路径）遵循 section 的
默认勾选，等价于常用档。

## 工程组件现状（如实）

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| CAD 查看器 | available | 真实的可选制品：`resources/occt`（OpenCASCADE WASM，来源哈希固定在 `resources/provenance/linz-source.json`）。安装器 section 负责装入 `<安装目录>/resources/occt`；未勾选时目录不存在，查看器如实报告引擎不可用。 |
| Tecplot 面板 | bundled | 纯渲染层代码（#116），随主程序 asar 内置。它不是可分离的安装期制品，向导中以只读条目如实展示（“随主程序内置，无需单独安装”），不提供虚假的勾选。 |
| CATIA/Abaqus 配套组件 | pending | #87 尚未合入 develop。向导中以只读、未勾选条目展示原因（“需待 #87 落地后随离线组件包补装”），绝不静默装或假装可装。 |

## 版本锁定

- 构建时 `scripts/release/issue-107/after-pack.cjs` 写出
  `<安装目录>/resources/components/components-lock.json`：应用版本 + 每个制品
  文件的 SHA-256；制品字节与 provenance 固定哈希不一致时构建直接失败。
- OCCT 源哈希的最终裁决权仍在 `resources/provenance/linz-source.json`。
- 卸载会移除各 section 自己安装的文件（自定义 `customUnInstall` + NSIS
  卸载器对安装目录的整体清理）。

## 离线组件包（装后补装）

`scripts/component-pack.cjs` 只读本地路径，完全没有联网路径（静态扫描由
`test/component-pack.test.ts` 固定）：

```powershell
# 从构建树打一个组件包（清单：应用版本 + 组件 id + 文件 SHA-256/大小）
npm run components:pack -- build --out <空目录> [--components cad-viewer]

# 装后补装：校验应用版本与每个文件哈希后写入安装目录
npm run components:pack -- install --pack <组件包目录> --to <安装目录>
```

- 版本不一致（组件包 x.y.z ≠ 安装锁 a.b.c）→ `VERSION_LOCK_MISMATCH`，
  一个字节都不写。
- 包内文件与清单哈希不一致 → `PACK_HASH_MISMATCH`。
- 包内哈希与安装目录版本锁固定哈希不一致 → `VERSION_LOCK_MISMATCH`。
- 每次成功补装在 `<安装目录>/resources/components/installed-packs.json`
  留下回执（版本、组件、文件哈希、时间）。
- pending/bundled 组件不可打包：`COMPONENT_NOT_AVAILABLE`。

## 测试与如实边界

- `test/component-catalog.test.ts`：目录形状校验、档位展开、锁哈希与
  provenance 一致、NSIS 生成物逐字节锁定、afterPack 落锁、provenance 漂移
  拒绝。
- `test/component-pack.test.ts`：打包/补装全流程、版本锁定与哈希漂移各拒绝
  路径、离线静态扫描。
- `test/nsis-components.test.ts`（仅 Windows）：真实 makensis 编译生成的
  components.nsh，静默运行「默认（常用）/取消 CAD（最小）」两种组合并验证
  卸载清理。
- GUI 安装向导的人工矩阵（三档下拉、勾选交互、中文文案截图）无法在无头
  环境自动执行：上述测试覆盖的是 section 逻辑与数据，不冒充 GUI 验证；
  Windows CI 的 `windows-install-smoke.ps1` 会固定静默默认组合并断言 CAD
  组件在位、卸载后消失。
