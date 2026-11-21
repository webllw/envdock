/** 验证脚本用的引擎调用入口，不参与应用构建 */
import { join } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createLayout, NPM_GLOBAL_DIR, npmGlobalDir } from '@main/core/paths'
import { npmGlobalStoreDir, pruneNpmGlobalBuckets, syncNpmGlobalTarget } from '@main/core/npm-globals'
import { defaultConfig, migrateState, Store } from '@main/core/store'
import { NodeProvider } from '@main/providers/node'
import { detectInstalled, extractZip, installSingleFile, writeVersionMetadata } from '@main/providers/runtime'
import { writeActivationScripts, writeCurrentShims, type ActiveTool } from '@main/core/activations'
import { pickCompatibleVersion, parsePhpVersionNumber } from '@main/providers/composer'
import { isUserVisibleTool, INTERNAL_TOOL_META } from '@shared/tools'
import { allToolMetadata } from '@main/providers/registry'
import type { VersionInfo } from '@shared/domain'

export async function runHarness(root: string, archive: string) {
  const layout = createLayout(root)
  const store = new Store(layout)
  await store.init()

  const stateInitialized = await stat(layout.stateFile).then(() => true, () => false)
  await store.updateState((draft) => {
    draft.config.mirror = 'tsinghua'
  })
  const reloaded = new Store(layout)
  await reloaded.init()
  const stateRoundTrip = reloaded.getState().config.mirror === 'tsinghua'

  const version: VersionInfo = {
    id: '17.0.13+11',
    display: '17.0.13',
    channel: 'lts',
    releasedAt: '2024-10-17T00:00:00Z'
  }
  const targetDir = join(layout.runtimesDir, 'java', version.id)
  await extractZip(archive, targetDir, true)
  const extractedFlattened = await stat(join(targetDir, 'bin', 'java.exe')).then(() => true, () => false)

  await writeVersionMetadata(targetDir, version)
  const metadataWritten = await stat(join(targetDir, '.envdock-version.json')).then(() => true, () => false)
  const detected = (await detectInstalled(root, 'java')).length

  const mergedEnv = { JAVA_HOME: `runtimes/java/${version.id}` }
  const active: ActiveTool[] = [
    {
      toolId: 'java',
      relativeBinDir: `runtimes/java/${version.id}/bin`,
      envVars: { ...mergedEnv }
    },
    {
      toolId: 'maven',
      relativeBinDir: 'runtimes/maven/3.9.16/bin',
      envVars: { ...mergedEnv, MAVEN_HOME: 'runtimes/maven/3.9.16' }
    }
  ]
  await writeActivationScripts(layout, active)
  await writeCurrentShims(layout, active)

  const psScript = (await readFile(join(layout.scriptsDir, 'activate.ps1'), 'utf8')).includes('$env:JAVA_HOME')
  const cmdScript = (await readFile(join(layout.scriptsDir, 'activate.bat'), 'utf8')).includes('set "JAVA_HOME=')
  const shimGenerated = (await readFile(join(layout.currentBinDir, 'java.cmd'), 'utf8')).includes('java.exe')

  // Maven 的 mvn 是 .cmd 脚本，垫片必须指向 mvn.cmd，并带上 JAVA_HOME
  const mvnShim = await readFile(join(layout.currentBinDir, 'mvn.cmd'), 'utf8')
  const mavenShimTargetsCmd = mvnShim.includes('mvn.cmd') && !mvnShim.includes('mvn.exe')
  const mavenShimCarriesJavaHome = mvnShim.includes('JAVA_HOME')

  // Composer：单文件 phar 安装、launcher 以 php 执行、垫片指向 composer.cmd、隐藏工具不进用户列表
  const phar = join(root, 'composer.phar')
  await writeFile(phar, Buffer.from('fake-php-archive'))
  const composerVersion: VersionInfo = {
    id: '2.11.2',
    display: '2.11.2',
    channel: 'stable',
    releasedAt: ''
  }
  const composerDir = join(layout.runtimesDir, 'composer', composerVersion.id)
  await installSingleFile(phar, composerDir, 'composer.phar')
  const pharInstalled = await stat(join(composerDir, 'composer.phar')).then(() => true, () => false)
  // launcher 由 provider.install 写入；此处复现同一份内容验证调用方式
  const launcher = '@php "%~dp0composer.phar" %*\r\n'
  await writeFile(join(composerDir, 'composer.cmd'), launcher, 'utf8')
  const launcherUsesPhp = (await readFile(join(composerDir, 'composer.cmd'), 'utf8')).includes('@php "')
  await writeVersionMetadata(composerDir, composerVersion)
  const composerDetected = (await detectInstalled(root, 'composer')).length

  const activeWithComposer: ActiveTool[] = [
    ...active,
    {
      toolId: 'composer',
      relativeBinDir: 'runtimes/composer/2.11.2',
      envVars: {}
    }
  ]
  await writeCurrentShims(layout, activeWithComposer)
  await writeActivationScripts(layout, activeWithComposer)
  const composerShim = await readFile(join(layout.currentBinDir, 'composer.cmd'), 'utf8')
  const composerShimTargetsCmd = composerShim.includes('composer.cmd') && !composerShim.includes('composer.exe')

  // min-php 选版：新 PHP 取最新，老 PHP 回退到 LTS，无法解析时取最新
  const candidates: VersionInfo[] = [
    { id: '2.11.2', display: '2.11.2', channel: 'stable', releasedAt: '' },
    { id: '2.2.32', display: '2.2.32', channel: 'lts', releasedAt: '' }
  ]
  const minPhp = new Map([['2.11.2', 70205], ['2.2.32', 50300]])
  const pickedNew = pickCompatibleVersion(candidates, minPhp, '8.3.12')?.id
  const pickedOld = pickCompatibleVersion(candidates, minPhp, '5.6.40')?.id
  const pickedUnknown = pickCompatibleVersion(candidates, minPhp, 'dev-master')?.id
  const phpVersionParsed = parsePhpVersionNumber('7.2.5') === 70205

  const composerHidden = !isUserVisibleTool('composer') &&
    INTERNAL_TOOL_META.id === 'composer' &&
    !allToolMetadata((await store.getState()).config).some((item) => item.id === 'composer')

  // npm 全局目录固定为 global/npm，且不再出现在可配置项中
  const npmFixed = NPM_GLOBAL_DIR === 'global/npm' &&
    !('npmGlobalDir' in defaultConfig()) &&
    !('npmGlobalDir' in (migrateState({ config: { mirror: 'official' } })?.config ?? {}))

  // Node 激活计划注入的全局前缀与缓存都不含版本号，切换版本时保持不变
  const nodeConfig = defaultConfig()
  const nodePlan = new NodeProvider(nodeConfig).activate({
    id: 'v22.11.0', display: '22.11.0', channel: 'lts', releasedAt: ''
  })
  const npmPrefixStable = nodePlan.envVars.npm_config_prefix === 'global/npm' &&
    nodePlan.envVars.npm_config_cache === 'global/npm/cache' &&
    !nodePlan.envVars.npm_config_prefix.includes('22.11')

  // 垫片与激活脚本把相对前缀写进环境变量，脚本按根目录展开
  const activeWithNode: ActiveTool[] = [{
    toolId: 'node',
    relativeBinDir: 'runtimes/node/v22.11.0',
    envVars: { ...nodePlan.envVars }
  }]
  await writeCurrentShims(layout, activeWithNode)
  await writeActivationScripts(layout, activeWithNode)
  const nodeShim = await readFile(join(layout.currentBinDir, 'node.cmd'), 'utf8')
  const npmCmdShim = await readFile(join(layout.currentBinDir, 'npm.cmd'), 'utf8')
  const npxCmdShim = await readFile(join(layout.currentBinDir, 'npx.cmd'), 'utf8')
  const nodeShimCarriesPrefix = nodeShim.includes('npm_config_prefix=') && nodeShim.includes('global\\npm')
  // PATH 集成只暴露 current/bin，npm/npx 必须由垫片转发到版本目录里的 .cmd
  const npmCmdShimTargetsCmd = npmCmdShim.includes('npm.cmd') && !npmCmdShim.includes('npm.exe')
  const npxCmdShimTargetsCmd = npxCmdShim.includes('npx.cmd') && !npxCmdShim.includes('npx.exe')
  const npmCmdShimCarriesPrefix = npmCmdShim.includes('npm_config_prefix=') && npmCmdShim.includes('global\\npm')
  const npmScriptCarriesPrefix = (await readFile(join(layout.scriptsDir, 'activate.ps1'), 'utf8'))
    .includes("$env:npm_config_prefix = Join-Path $envdockRoot 'global/npm'")

  // 切换 Node 主版本时只重建全局入口指针，各版本的全局命令互不覆盖
  const npmEntry = npmGlobalDir(root)
  const npmStore = npmGlobalStoreDir(root)
  const npmStore22 = join(npmStore, 'node22')
  const npmStore20 = join(npmStore, 'node20')
  await mkdir(npmStore22, { recursive: true })
  await mkdir(npmStore20, { recursive: true })
  await writeFile(join(npmStore22, 'pnpm.cmd'), 'node22', 'utf8')
  await writeFile(join(npmStore20, 'pnpm.cmd'), 'node20', 'utf8')
  const npmSwitched22 = await syncNpmGlobalTarget(root, 'v22.11.0')
  const pnpmOn22 = await readFile(join(npmEntry, 'pnpm.cmd'), 'utf8')
  const npmSwitched20 = await syncNpmGlobalTarget(root, 'v20.20.2')
  const pnpmOn20 = await readFile(join(npmEntry, 'pnpm.cmd'), 'utf8')
  const globalDirFollowsNode = npmSwitched22.changed && npmSwitched20.changed &&
    pnpmOn22 === 'node22' && pnpmOn20 === 'node20'

  // 已安装列表按版本号降序；故意让旧版本的安装时间更新，确保排序不依赖安装时间
  const nodeRuntimes = join(layout.runtimesDir, 'node')
  const installedFixtures = [
    { id: 'v20.20.2', installedAt: '2026-03-04T00:00:00.000Z' },
    { id: 'v26.13.1', installedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'v24.22.3', installedAt: '2026-01-01T00:00:00.000Z' }
  ]
  for (const item of installedFixtures) {
    const dir = join(nodeRuntimes, item.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.envdock-version.json'), JSON.stringify({
      versionId: item.id,
      display: item.id.slice(1),
      installedAt: item.installedAt
    }), 'utf8')
  }
  const installedOrder = (await detectInstalled(root, 'node')).map((item) => item.versionId).join(',')
  const installedSortedNewestFirst = installedOrder === 'v26.13.1,v24.22.3,v20.20.2'

  const diskUsage = await store.diskUsage()

  // 删除最后一个某主版本 Node 时清理对应全局 bucket，仍被引用的 bucket 保留
  const prunedBuckets = await pruneNpmGlobalBuckets(root, ['v22.11.0'])
  const node20BucketRemoved = prunedBuckets.includes('node20') &&
    !(await stat(join(npmStore, 'node20')).then(() => true).catch(() => false))
  const node22BucketKept = (await readFile(join(npmStore22, 'pnpm.cmd'), 'utf8')) === 'node22'

  return {
    stateInitialized,
    stateRoundTrip,
    extractedFlattened,
    metadataWritten,
    detected,
    psScript,
    cmdScript,
    shimGenerated,
    mavenShimTargetsCmd,
    mavenShimCarriesJavaHome,
    pharInstalled,
    launcherUsesPhp,
    composerDetected,
    composerShimTargetsCmd,
    pickedNew,
    pickedOld,
    pickedUnknown,
    phpVersionParsed,
    composerHidden,
    npmFixed,
    npmPrefixStable,
    nodeShimCarriesPrefix,
    npmCmdShimTargetsCmd,
    npxCmdShimTargetsCmd,
    npmCmdShimCarriesPrefix,
    npmScriptCarriesPrefix,
    globalDirFollowsNode,
    node20BucketRemoved,
    node22BucketKept,
    installedSortedNewestFirst,
    diskUsage
  }
}
