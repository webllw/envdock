/** 验证脚本用的引擎调用入口，不参与应用构建 */
import { join } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createLayout } from '@main/core/paths'
import {
  ensureGlobalBuckets,
  globalBucketDir,
  globalStoreDir,
  npmBucketName,
  pruneGlobalBuckets,
  pythonBucketName
} from '@main/core/npm-globals'
import { computeEnvPlan, envVarNamesForTool, pathRefsForTool, toPowerShellRef } from '@main/core/env'
import { Store } from '@main/core/store'
import {
  detectInstalled,
  extractZip,
  installSingleFile,
  writeVersionMetadata
} from '@main/providers/runtime'
import { writeActivationScripts } from '@main/core/activations'
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

  // 环境变量方案：每个工具有 HOME 变量，PATH 只写变量引用，不含版本号
  const active = {
    java: version.id,
    maven: '3.9.16',
    node: 'v22.11.0',
    python: '3.13.2'
  }
  const plan = computeEnvPlan(root, active)
  const javaHome = plan.variables.find((item) => item.name === 'JAVA_HOME')?.value ?? ''
  const javaHomePointsVersion = javaHome === join(root, 'runtimes', 'java', version.id)
  const pathRefsStable = plan.pathRefs.includes('%JAVA_HOME%\\bin') &&
    plan.pathRefs.includes('%NODE_HOME%') &&
    plan.pathRefs.includes('%PYTHONHOME%\\Scripts') &&
    !plan.pathRefs.some((ref) => ref.includes('22.11') || ref.includes('3.13'))

  await writeActivationScripts(layout, active)
  const psScript = await readFile(join(layout.scriptsDir, 'activate.ps1'), 'utf8')
  const cmdScript = await readFile(join(layout.scriptsDir, 'activate.bat'), 'utf8')
  const scriptSetsJavaHome = psScript.includes(`$env:JAVA_HOME = '${javaHome}'`) &&
    cmdScript.includes(`set "JAVA_HOME=${javaHome}"`)
  const scriptUsesVarRef = psScript.includes('$env:JAVA_HOME\\bin') &&
    cmdScript.includes('%JAVA_HOME%\\bin;%PATH%') &&
    toPowerShellRef('%JAVA_HOME%\\bin') === '$env:JAVA_HOME\\bin'

  // Composer：单文件 phar 安装、launcher 以 php 执行、内部工具不进用户列表
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
  const launcher = '@php "%~dp0composer.phar" %*\r\n'
  await writeFile(join(composerDir, 'composer.cmd'), launcher, 'utf8')
  const launcherUsesPhp = (await readFile(join(composerDir, 'composer.cmd'), 'utf8')).includes('@php "')
  await writeVersionMetadata(composerDir, composerVersion)
  const composerDetected = (await detectInstalled(root, 'composer')).length
  const composerHidden = !isUserVisibleTool('composer') &&
    INTERNAL_TOOL_META.id === 'composer' &&
    !allToolMetadata((await store.getState()).config).some((item) => item.id === 'composer')

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

  // 取消激活时能按工具精确列出要撤销的变量与引用，且与具体版本无关
  const nodeVarNames = envVarNamesForTool('node')
  const nodeRefs = pathRefsForTool('node')
  const toolScoped =
    nodeVarNames.includes('NODE_HOME') &&
    nodeVarNames.includes('npm_config_prefix') &&
    nodeVarNames.includes('npm_config_cache') &&
    !nodeVarNames.includes('JAVA_HOME') &&
    nodeRefs.includes('%NODE_HOME%') &&
    nodeRefs.includes('%npm_config_prefix%') &&
    !nodeRefs.some((ref) => ref.includes('22.11'))

  // npm/pip 全局目录按主版本隔离，切换版本即改写前缀变量的值
  await ensureGlobalBuckets(root, { node: 'v22.11.0', python: '3.13.2' })
  const npmPrefix22 = globalBucketDir(root, 'node', 'v22.11.0')
  const npmPrefix20 = globalBucketDir(root, 'node', 'v20.20.2')
  const pyBase313 = globalBucketDir(root, 'python', '3.13.2')
  const bucketNames = npmBucketName('v22.11.0') === 'node22' &&
    npmBucketName('v20.20.2') === 'node20' &&
    pythonBucketName('3.13.2') === 'py313'
  const globalPrefixesStable = npmPrefix22.endsWith('npm-store\\node22') &&
    npmPrefix20.endsWith('npm-store\\node20') &&
    pyBase313.endsWith('python-user\\py313')
  const nodePlanVars = computeEnvPlan(root, { node: 'v22.11.0' }).variables
  const nodePrefixVar = nodePlanVars.find((item) => item.name === 'npm_config_prefix')?.value ?? ''
  const nodeCacheVar = nodePlanVars.find((item) => item.name === 'npm_config_cache')?.value ?? ''
  const npmVariablesFollowVersion = nodePrefixVar === npmPrefix22 &&
    nodeCacheVar === join(npmPrefix22, 'cache')
  const pythonVariables = computeEnvPlan(root, { python: '3.13.2' }).variables
  const pipUserEnabled = pythonVariables.some((item) => item.name === 'PIP_USER' && item.value === '1') &&
    pythonVariables.some((item) => item.name === 'PYTHONUSERBASE' && item.value === pyBase313)

  // 删除最后一个某主版本时清理对应 bucket，仍被引用的 bucket 保留
  await mkdir(join(globalStoreDir(root, 'node'), 'node20'), { recursive: true })
  const pruned = await pruneGlobalBuckets(root, {
    node: ['v22.11.0'],
    python: ['3.13.2']
  })
  const node20BucketRemoved = pruned.includes('node:node20') &&
    !(await stat(join(globalStoreDir(root, 'node'), 'node20')).then(() => true).catch(() => false))
  const node22BucketKept = await stat(npmPrefix22).then(() => true).catch(() => false)

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

  return {
    stateInitialized,
    stateRoundTrip,
    extractedFlattened,
    metadataWritten,
    detected,
    javaHomePointsVersion,
    pathRefsStable,
    scriptSetsJavaHome,
    scriptUsesVarRef,
    pharInstalled,
    launcherUsesPhp,
    composerDetected,
    composerHidden,
    pickedNew,
    pickedOld,
    pickedUnknown,
    phpVersionParsed,
    toolScoped,
    bucketNames,
    globalPrefixesStable,
    npmVariablesFollowVersion,
    pipUserEnabled,
    node20BucketRemoved,
    node22BucketKept,
    installedSortedNewestFirst,
    diskUsage
  }
}
