/** 升级逻辑验证入口，不参与应用构建 */
import { join } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createLayout } from '@main/core/paths'
import { Store, migrateState, migrateVersionState } from '@main/core/store'
import { Updater, compareVersions, buildReplaceScript, buildSilentLauncher, isValidVersionDir, APP_EXE_NAME } from '@main/core/updater'

export async function runUpdateHarness(root: string, sourceUrl: string, packageFileName: string, webBase: string) {
  const layout = createLayout(root)
  const store = new Store(layout, '0.1.0')
  await store.init()

  // 1. 旧配置迁移：schemaVersion=1 的旧 state 不能丢配置，且补齐 update 字段
  const migrated = migrateState({
    schemaVersion: 1,
    activeVersions: { java: 'temurin-17' },
    config: { mirror: 'tsinghua', pathIntegration: true },
    updatedAt: '2026-01-01'
  })
  const migrationKeepsConfig = migrated?.config.mirror === 'tsinghua' &&
    migrated?.config.pathIntegration === true &&
    migrated?.activeVersions.java === 'temurin-17'
  const migrationFillsUpdate = migrated?.config.update.autoCheck === true &&
    typeof migrated?.config.update.sourceUrl === 'string'
  const migrationFillsProxy = migrated?.config.proxy.enabled === false &&
    migrated?.config.proxy.url === ''
  const migrationFillsCloseBehavior = migrated?.config.closeBehavior === 'ask'

  // 2. 版本状态迁移：挂起版本被保留
  const versionMigrated = migrateVersionState({
    schemaVersion: 1,
    currentVersion: '0.1.0',
    pendingVersion: '0.2.0',
    previousVersion: '0.1.0'
  }, '0.1.0')
  const versionMigrationKeepsPending = versionMigrated.pendingVersion === '0.2.0'

  // 3. 版本比较
  const compareOk = compareVersions('0.2.0', '0.1.0') === 1 &&
    compareVersions('0.1.0', '0.1.0') === 0 &&
    compareVersions('0.1.0', '0.2.0') === -1

  // 4. 替换脚本：升级归档当前版本并等待确认；回退到指定版本就位后立即启动
  const upgradeScript = buildReplaceScript({ root, mode: 'upgrade', fromVersion: '0.1.0' })
  const switchScript = buildReplaceScript({
    root, mode: 'switch', fromVersion: '0.1.0', targetVersion: '0.0.9'
  })
  // 按进程名强制结束残留实例，不能再用 PID + findstr 轮询（会死循环弹窗）
  const killsByName = upgradeScript.includes(`taskkill /F /IM ${appName()}`) &&
    !upgradeScript.includes('findstr') && !upgradeScript.includes(':wait_exit')
  const silentLauncher = buildSilentLauncher('C:\\tmp\\replace.bat').includes('WScript.Shell') &&
    buildSilentLauncher('C:\\tmp\\replace.bat').includes(', 0, False')
  const history = join(root, 'updates', 'history')
  // 归档：删除同名目标后 move 到 history/<version>，保证原子改名而不嵌套
  const archiveByMove = upgradeScript.includes(`move "${root}\\app" "${history}\\0.1.0"`) &&
    upgradeScript.includes(`if exist "${history}\\0.1.0" rmdir /S /Q`) &&
    upgradeScript.includes(':recover')
  const verifyBeforeLaunch = upgradeScript.includes(`if not exist "${root}\\app\\${appName()}" goto recover`) &&
    upgradeScript.includes(`if not exist "${history}\\0.1.0\\${appName()}" goto recover`)
  // 升级必须等待确认并带超时回滚；回退脚本就位后直接 :switched，绝不进入确认轮询自杀
  const scriptUpgradeOk = upgradeScript.includes(':launch') && upgradeScript.includes(':confirm') &&
    upgradeScript.includes(':timeout') && archiveByMove && verifyBeforeLaunch && killsByName
  const scriptRollbackOk = switchScript.includes(`move "${history}\\0.0.9" "${root}\\app"`) &&
    switchScript.includes(':switched') && !switchScript.includes(':confirm') &&
    !switchScript.includes(':timeout') && switchScript.includes(':recover') && killsByName
  const versionDirGuard = isValidVersionDir('1.0.6') && isValidVersionDir('2.2.32-LTS') &&
    !isValidVersionDir('../evil') && !isValidVersionDir('a\\b') && !isValidVersionDir('..')

  // 5. 配置更新源并跑真实 HTTP 检查 + 下载 + 校验 + 解压
  await store.updateState((draft) => {
    draft.config.update.sourceUrl = sourceUrl
  })
  const events: string[] = []
  const updater = new Updater({
    layout,
    store,
    appVersion: '0.1.0',
    emit: (state) => events.push(state.phase),
    restart: () => undefined,
    webBase
  })

  const manifest = await updater.check()
  const checkOk = manifest?.version === '0.2.0' &&
    manifest.downloadUrl.includes(packageFileName)
  const prepared = await updater.prepare()
  const prepareOk = prepared.readyToApply && prepared.phase === 'available'
  const stagedExe = join(layout.updateStagingDir, appName())
  const stagedOk = await stat(stagedExe).then(() => true, () => false)
  const downloadOk = await stat(join(layout.updateDownloadDir, packageFileName)).then(() => true, () => false)

  // 6. 写入挂起状态（模拟 apply 的版本写入部分，不真正 spawn 脚本）
  await store.updateVersion((draft) => {
    draft.previousVersion = '0.1.0'
    draft.pendingVersion = '0.2.0'
  })
  const newStore = new Store(layout, '0.1.0')
  await newStore.init()
  const pendingPersisted = newStore.getVersion().pendingVersion === '0.2.0'

  // 7. 确认逻辑：版本一致时写确认文件并清空挂起
  const confirming = new Updater({
    layout,
    store: newStore,
    appVersion: '0.2.0',
    emit: () => undefined,
    restart: () => undefined
  })
  await confirming.confirmOnStartup()
  const confirmOk = await stat(layout.updateConfirmFile).then(() => true, () => false)
  const pendingCleared = newStore.getVersion().pendingVersion === null

  // 8. manifest 根路径回填
  const fakeManifestPath = layout.manifestFile
  const rawManifest = JSON.parse(await readFile(fakeManifestPath, 'utf8'))
  const manifestRootOk = rawManifest.installRoot === root

  // 9. 历史归档：造两个版本，验证列表按版本降序、launchable 判定与嵌套目录清理
  const mkHistory = async (version: string): Promise<string> => {
    const dir = join(layout.updateHistoryDir, version)
    await mkdir(join(dir, 'resources'), { recursive: true })
    await writeFile(join(dir, 'resources', 'app.asar'), 'fake-asar')
    await writeFile(join(dir, APP_EXE_NAME), 'fake-exe')
    return dir
  }
  const v009 = await mkHistory('0.0.9')
  const v010 = await mkHistory('0.1.0')
  const vBroken = join(layout.updateHistoryDir, '0.1.1')
  await mkdir(vBroken, { recursive: true })

  let lastHistory = newStore.getVersion().currentVersion
  let historyCanRollback: boolean | undefined
  const listing = new Updater({
    layout,
    store: newStore,
    appVersion: '0.2.0',
    emit: (state) => {
      historyCanRollback = state.canRollback
      lastHistory = state.history.map((h) => h.version).join(',')
    },
    restart: () => undefined
  })
  // 下载目录里已有 prepare 缓存的 EnvDock-0.2.0-app.zip，应作为 package 来源并入
  const entries = await listing.loadHistory()
  const packageEntry = entries.find((e) => e.version === '0.2.0')
  const historyListOk = entries.length === 4 &&
    entries[0].version === '0.2.0' && entries[1].version === '0.1.1' &&
    entries[2].version === '0.1.0' && entries[3].version === '0.0.9' &&
    entries.find((e) => e.version === '0.1.1')?.launchable === false &&
    entries.find((e) => e.version === '0.1.0')?.launchable === true &&
    packageEntry?.source === 'package' && packageEntry.launchable &&
    packageEntry.sizeBytes > 0 &&
    entries[2].sizeBytes > 0 && historyCanRollback === true &&
    lastHistory === '0.2.0,0.1.1,0.1.0,0.0.9'

  // 10. 回退到指定版本：损坏版本被拒，合法版本清空挂起并记录目标版本
  let rollbackRejected = false
  try {
    await listing.rollbackTo('0.1.1')
  } catch {
    rollbackRejected = true
  }
  let rollbackStarted = false
  const switcher = new Updater({
    layout,
    store: newStore,
    appVersion: '0.2.0',
    emit: () => undefined,
    restart: () => { rollbackStarted = true }
  })
  await switcher.rollbackTo('0.1.0')
  const afterRollback = newStore.getVersion()
  const rollbackToVersionOk = rollbackRejected && rollbackStarted &&
    afterRollback.currentVersion === '0.1.0' && afterRollback.pendingVersion === null

  // 11. 删除指定历史版本：嵌套目录删净，标志复位，当前运行版本拒绝删除
  let currentRejected = false
  try {
    await listing.discardVersion('0.2.0')
  } catch {
    currentRejected = true
  }
  let discardEmittedCanRollback: boolean | undefined
  const discarding = new Updater({
    layout,
    store: newStore,
    appVersion: '0.2.0',
    emit: (state) => { discardEmittedCanRollback = state.canRollback },
    restart: () => undefined
  })
  await discarding.discardVersion('0.0.9')
  const discardOk = await stat(v009).then(() => false, () => true) &&
    await stat(v010).then(() => true, () => false) &&
    discardEmittedCanRollback === true && currentRejected

  // 13. 仅有升级包、没有归档目录的版本：可回退（先还原归档），删除时两处都清
  const v016Package = join(layout.updateDownloadDir, 'EnvDock-0.1.6-app.zip')
  const AdmZip = (await import('adm-zip')).default
  const pkgZip = new AdmZip()
  pkgZip.addFile(APP_EXE_NAME, Buffer.from('fake-exe'))
  pkgZip.writeZip(v016Package)
  let packageRollbackStarted = false
  const packageRollback = new Updater({
    layout,
    store: newStore,
    appVersion: '0.2.0',
    emit: () => undefined,
    restart: () => { packageRollbackStarted = true }
  })
  await packageRollback.rollbackTo('0.1.6')
  const restoredExe = join(layout.updateHistoryDir, '0.1.6', APP_EXE_NAME)
  const packageRollbackOk = packageRollbackStarted &&
    await stat(restoredExe).then(() => true, () => false)

  await discarding.discardVersion('0.1.6')
  const packageDiscardOk = await stat(v016Package).then(() => false, () => true) &&
    await stat(join(layout.updateHistoryDir, '0.1.6')).then(() => false, () => true)

  // 12. 旧 app.old 迁移为历史归档，避免升级到新机制后旧版本失联
  const legacy = layout.appBackupDir
  await mkdir(join(legacy, 'resources'), { recursive: true })
  await writeFile(join(legacy, APP_EXE_NAME), 'fake-exe')
  await newStore.updateVersion((draft) => { draft.previousVersion = '0.0.8' })
  await discarding.init()
  const legacyMigrated = await stat(join(layout.updateHistoryDir, '0.0.8', APP_EXE_NAME))
    .then(() => true, () => false) && await stat(legacy).then(() => false, () => true)

  return {
    migrationKeepsConfig,
    migrationFillsUpdate,
    migrationFillsProxy,
    migrationFillsCloseBehavior,
    versionMigrationKeepsPending,
    compareOk,
    scriptUpgradeOk,
    scriptRollbackOk,
    versionDirGuard,
    silentLauncher,
    checkOk,
    prepareOk,
    stagedOk,
    downloadOk,
    pendingPersisted,
    confirmOk,
    pendingCleared,
    manifestRootOk,
    historyListOk,
    rollbackToVersionOk,
    discardOk,
    packageRollbackOk,
    packageDiscardOk,
    legacyMigrated,
    phases: events
  }
}

function appName(): string {
  return 'EnvDock.exe'
}
