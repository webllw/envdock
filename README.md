# EnvDock

Windows 上集中管理多版本开发环境的桌面工具。Java、Maven、PHP、Python、Go、Node 的运行时和状态集中放在用户选定的目录，目录可整体迁移，卸载时按记录回滚对系统环境的改动。版本列表和安装包只取自各语言的官方接口。

安装 Java 时会自动附带安装最新的稳定版 Maven，并配置 `JAVA_HOME` 与 `MAVEN_HOME`，装完即可执行 `mvn`。Maven 作为独立工具管理，可单独安装和切换多个版本。

基于 Electron、React、TypeScript。

## 环境要求

- Windows x64
- Node.js 22 及以上

## 快速开始

```bash
npm install
npm run dev
```

`start.bat` 是等价的批处理入口，会先清除 `ELECTRON_RUN_AS_NODE`。

```bat
# cmd
start.bat
```

```powershell
# PowerShell
.\start.bat
```

开发态的环境根目录默认是项目内的 `.envdock-data`。指向其它已存在的目录时设置 `ENVDOCK_ROOT`（绝对路径）：

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

## 项目结构

```
src/
  main/        主进程：引擎、Provider、存储、更新器、网络层
  preload/     IPC 桥接
  renderer/    React 界面
  shared/      领域类型、IPC 契约、官方源定义
scripts/       打包组装与验证脚本
```

## 开发

```bash
npm run typecheck
npm run build
npm run verify:engine
npm run verify:update
```

`verify:engine` 验证状态读写、解压、垫片与激活脚本生成等引擎逻辑，`verify:update` 用本地 HTTP 服务模拟 GitHub Releases API 验证完整升级流程。两个脚本都不启动 Electron，也不改动系统 PATH。

打包：

```bash
npm run package
```

产物在 `release/EnvDock`，是可整体复制的绿色目录；升级只替换其中的 `app/`。国内网络下载 Electron 二进制较慢时可设置 `ELECTRON_MIRROR`。

接入新工具时实现 `src/shared/domain.ts` 的 `ToolProvider`，在 `src/main/providers/registry.ts` 注册，在 `src/shared/tools.ts` 补展示元数据，需要展示官方地址时在 `src/shared/sources.ts` 的 `OFFICIAL_SOURCES` 增加一项。

出网请求统一走 `src/main/core/net.ts` 的 `requestFetch`，直接调用 `fetch` 不会应用设置里的代理。

## License

[MIT](LICENSE)
