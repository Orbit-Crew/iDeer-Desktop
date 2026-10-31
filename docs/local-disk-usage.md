# 本地开发文件存放位置

项目的 npm 命令会通过 `scripts/project-env.cjs` 设置缓存和临时目录。
路径根据脚本所在的项目位置计算，不写死盘符。从别的目录调用脚本也会回到该项目执行。

## Windows 开发和验收

在 PowerShell 中先运行一次：

```powershell
. .\scripts\project-env.ps1
```

这会设置当前终端和它启动的子进程。之后直接运行 `npm ci`、Python、uv、
`scripts/acceptance` 下的验收脚本，都会继承这些路径。每个新终端需要重新加载。
从编辑器、别的终端或 WSL 启动的进程不会继承当前 PowerShell 的环境。
WSL 应在 Linux 项目内设置自己的缓存和临时目录，不直接使用 Windows 路径变量。

`npm run dev`、`build`、`typecheck`、`test`、`test:desktop`、`pack`、`dist:win`
及 Runtime 命令会自动设置环境。`npm ci` 的依赖安装阶段仍应先加载上述 PowerShell 环境，
以覆盖 Electron 安装脚本的下载位置。`.npmrc` 另外将 npm 缓存设为项目内的 `.cache/npm`。

查看所有路径：

```powershell
node scripts/project-env.cjs --print-env
```

如果 `python` 没有指向开发环境，可在当前终端指定解释器的绝对路径：

```powershell
$env:IDEER_PYTHON = '解释器的完整路径\python.exe'
```

## 目录清单

| 目录 | 内容 |
| --- | --- |
| 项目旁的 `<项目目录名>.tmp` | 当前项目命令的临时安装、更新测试现场、Python 临时文件 |
| `.cache/npm` | npm 下载缓存 |
| `.cache/electron` | Electron 下载缓存 |
| `.cache/electron-builder` | Windows 打包工具缓存 |
| `.cache/uv`、`.cache/pip` | Python 包缓存 |
| `.cache/uv-python` | uv 管理的 Python 解释器 |
| `.cache/ms-playwright` | Playwright 浏览器 |
| `.cache/huggingface`、`.cache/torch` | 支持相应环境变量的模型库缓存 |
| `node_modules`、`.venv` | 项目依赖环境，仍在项目根目录 |
| `out`、`dist`、`.runtime` | 编译、安装包和 Runtime 产物，仍在项目根目录 |
| `artifacts` | 验收报告、截图、原始证据和归档 |

项目内的上述生成目录已被 Git 忽略。临时目录在仓库外，避免把发布测试的签名密钥放入仓库。
例如源码在 `G:\code\iDeer-Desktop`，临时目录就在 `G:\code\iDeer-Desktop.tmp`。
模型缓存只调整下载位置，不调整 Hugging Face 的凭据目录。
不支持这些环境变量的第三方库，例如自行写死 `~/.cache` 的程序，仍需单独配置。

临时文件集中后仍可能增长。验收完成后先确认进程已退出，再保存必要的报告、JSON
和截图，清理对应测试目录。不要在运行中清空 `<项目目录名>.tmp`。本次路径配置不自动删除证据。

## 这台机器的工具默认缓存

执行下面命令，会把工具缓存位置保存到 Windows 当前用户环境变量中：

```powershell
. .\scripts\project-env.ps1 -PersistCaches
```

它只持久保存 npm、Electron、打包工具、Python 包、浏览器和模型下载目录。
Windows 用户和系统的 `TEMP`、`TMP` 不会被修改。
旧环境变量值保存在 `artifacts/disk-audit/user-cache-env-before-*.json`。
已运行的 Codex、编辑器和终端可能仍带着旧环境，需要重启相关应用。

用户环境变量保存的是运行配置时的项目绝对路径，供项目外的工具使用。
搬迁或重命名项目后，应在新位置重新执行 `-PersistCaches`；项目 npm 命令会自动跟随新位置。
这会影响该用户后续启动的其他项目的相同工具，它们会共用这份下载缓存。
原 C 盘缓存不会自动移动或删除。旧模型、浏览器等如仍需要使用，应另行迁移并校验，
避免在新目录重新下载一份。

恢复之前的用户缓存设置时，选择对应备份文件，再逐项恢复：

```powershell
$previousCaches = Get-Content -LiteralPath '备份文件的完整路径.json' -Raw | ConvertFrom-Json
foreach ($cacheSetting in $previousCaches.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($cacheSetting.Name, $cacheSetting.Value, 'User')
}
```

恢复后重启相关应用，或重新开启终端。

## Codex 工作副本

Codex 在项目之外管理工作副本，仅修改源码目录不会改变它们的位置。
在 Codex 的 **Settings > Worktrees > Worktree root** 中，将位置设为项目所在盘的
专用目录，例如 `G:\code\iDeer-Desktop\.worktree\codex`。
这只控制之后创建的副本，不代表现有 C 盘副本已经迁移。
每个新副本仍有自己的依赖、构建和缓存；上述环境脚本会跟随副本的位置。

依据：[OpenAI 官方工作副本文档](https://learn.chatgpt.com/docs/environments/git-worktrees)。
不要为了移动工作副本而重设整个 `CODEX_HOME`，它还包含登录、配置和聊天状态。

应用正式安装后的 `%APPDATA%/iDeer Desktop`、Windows 系统目录、密钥与登录目录
不属于开发缓存，本配置保留其位置。
