# EnvDock

Windows 上集中管理多版本开发环境的桌面工具。Java、PHP、Python、Go、Node 的运行时和全部状态都放在一个由用户选定的目录里，目录可以整体搬迁，卸载时按记录回滚对系统环境的改动。

版本列表和安装包只从各语言的官方接口获取，不使用第三方镜像。

## 本地运行

需要 Windows x64 和 Node.js 22 及以上版本。

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

## 打包

```bash
npm run package
```

产物在 `release/EnvDock`。这是完整的绿色目录：`app/` 是应用本体，其余是运行时与状态数据。升级时用新版本的 `app/` 覆盖旧目录的 `app/` 即可，`runtimes/`、`state.json`、`manifest.json` 等数据保持不变。

## 使用

首次启动需要选定安装目录。目录结构：

```
runtimes/          各工具的已安装版本
cache/downloads/   下载缓存
current/bin/       全局激活版本的可执行文件垫片
scripts/           会话激活脚本
app/               应用本体
state.json         激活版本与配置
manifest.json      系统变更记录
version.json       当前应用版本
updates/           自升级暂存
```

运行时页用于安装版本、设为全局、取消全局和卸载。同一工具可以同时存在多个版本，全局版本只有一个。

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
  preload/     IPC 桥接
  renderer/    React 界面
  shared/      领域类型、IPC 契约、官方源定义
scripts/       打包组装与验证脚本
```

Provider 是可插拔的。接入新工具时实现 `src/shared/domain.ts` 中的 `ToolProvider`，在 `src/main/providers/registry.ts` 注册，并在 `src/shared/tools.ts` 补充展示元数据。

## 开发

```bash
npm run typecheck
npm run build
npm run verify:engine
npm run verify:update
```

开发态的环境根目录默认在项目内的 `.envdock-data`，可通过 `ENVDOCK_ROOT` 环境变量指向另一个已存在的目录。

## 限制

- 仅支持 Windows x64。
- 版本列表和安装包都来自官方源，不提供镜像切换。网络受限时需要配置 HTTP 代理。
- 应用更新从 GitHub Releases 获取，默认仓库为 `webllw/envdock`，可在设置中改为自己的仓库。发布时需要附带 zip 升级包（文件名含 `app`）及其 SHA-256 校验值。
- 全局垫片只包含可执行文件。`npm`、`npx` 这类脚本命令需要在激活脚本启动的终端会话中使用。
