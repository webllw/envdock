# EnvDock

Windows 上集中管理多版本开发环境的桌面工具。Java、PHP、Python、Go、Node 的运行时和全部状态都放在一个由用户选定的目录里，目录可以整体搬迁，卸载时按记录回滚对系统环境的改动。

版本列表和安装包只从各语言的官方接口获取，不使用第三方镜像。

## 环境要求

开发需要 Windows x64、Node.js 22 及以上版本。打包产物是绿色目录，运行时不需要额外安装 Node.js 或其他依赖。

## 本地运行

```bash
npm install
npm run dev
```

`start.bat` 是同一操作的批处理入口，会先清除 `ELECTRON_RUN_AS_NODE` 再启动开发服务。

```bat
# cmd
start.bat
```

```powershell
# PowerShell
.\start.bat
```

开发态的环境根目录默认在项目内的 `.envdock-data`。指向另一个已存在的目录时设置 `ENVDOCK_ROOT`（必须是绝对路径）。

```bat
# cmd
set ENVDOCK_ROOT=D:\envdock-dev
npm run dev
```

```powershell
# PowerShell
$env:ENVDOCK_ROOT = "D:\envdock-dev"
npm run dev
```

## 使用

把绿色目录复制到目标磁盘即可运行。首次启动选定安装目录。运行时页用于安装版本、设为全局、取消全局和卸载。同一工具可以同时存在多个版本，全局版本只有一个。

设置页包含五部分：

- 应用更新：检查 GitHub Releases 上的新版本，升级只替换 `app/`；可更换更新仓库、开关启动检查、回滚或清理上一版本。
- 网络代理：填写 HTTP 代理地址，开启后版本列表与安装包下载都走代理，关闭则直连。
- 安装目录：迁移到新位置，旧路径引用按清单撤销，文件与配置原样搬到新目录。
- 环境集成：是否把 `current/bin` 写入用户级 PATH。关闭时用激活脚本按需启用。
- 系统变更清单：记录 EnvDock 写过的 PATH 项与注册表值，卸载时逐项恢复原值。

激活脚本只影响运行它的终端会话，不修改系统环境。

```bat
# cmd
call <安装目录>\scripts\activate.bat
```

```powershell
# PowerShell
. <安装目录>\scripts\activate.ps1
```

## 项目结构

```
src/
  main/        主进程：引擎、Provider、存储、更新器、网络层
    core/      环境布局、状态持久化、激活垫片、下载、GitHub 更新
    providers/ 各语言的版本解析、下载与激活实现
    verify/    验证脚本使用的引擎入口
  preload/     IPC 桥接
  renderer/    React 界面
  shared/      领域类型、IPC 契约、官方源与仓库地址定义
scripts/       打包组装与验证脚本
out/           构建产物（生成，不入库）
release/       打包产物（生成，不入库）
```

Provider 是可插拔的。接入新工具时实现 `src/shared/domain.ts` 中的 `ToolProvider`，在 `src/main/providers/registry.ts` 注册，在 `src/shared/tools.ts` 补充展示元数据；如果工具需要展示官方地址，再在 `src/shared/sources.ts` 的 `OFFICIAL_SOURCES` 增加一项。引擎与界面不需要改动。

## 开发

```bash
npm run typecheck
npm run build
npm run verify:engine
npm run verify:update
```

`verify:engine` 覆盖状态读写、解压、版本元数据、垫片与激活脚本生成、目录统计。`verify:update` 在本地起一个 HTTP 服务模拟 GitHub Releases API，覆盖版本比较、下载、校验、解压、挂起状态与启动确认。两个脚本都不启动 Electron，不改动系统 PATH。

出网请求统一走 `src/main/core/net.ts` 的 `requestFetch`，它按设置里的代理配置注入 dispatcher。新增网络请求时使用它而不是直接调用 `fetch`，否则代理设置对该请求无效。

### 打包

```bash
npm run package
```

命令依次执行 `electron-vite build`、`electron-builder --dir` 和 `scripts/assemble-portable.mjs`。产物在 `release/EnvDock`，是完整的绿色目录：

```
release/EnvDock/
  app/               应用本体（exe 与 asar）
  runtimes/          各工具的已安装版本
  cache/downloads/   下载缓存
  current/bin/       全局激活版本的可执行文件垫片
  scripts/           会话激活脚本
  updates/           自升级暂存
  state.json         激活版本与配置
  manifest.json      系统变更记录
  version.json       当前应用版本
```

`manifest.json` 的 `installRoot` 在首次启动时按实际位置回填。整个目录可以复制到任意磁盘。

国内网络下载 Electron 二进制较慢时，可设置 `ELECTRON_MIRROR` 后再打包。

## 限制

- 仅支持 Windows x64。
- 版本列表和安装包都来自官方源，不提供镜像切换。网络受限时需要配置 HTTP 代理。
- 应用更新从 GitHub Releases 获取，默认仓库为 `webllw/envdock`，可在设置中改为自己的仓库。
- 全局垫片只包含可执行文件。`npm`、`npx` 这类脚本命令需要在激活脚本启动的终端会话中使用。
