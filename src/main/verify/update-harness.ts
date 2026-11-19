/** 升级逻辑验证入口，不参与应用构建 */
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createLayout } from '@main/core/paths'
import { Store, migrateState, migrateVersionState } from '@main/core/store'
import { Updater, compareVersions, buildReplaceScript } from '@main/core/updater'

export async function runUpdateHarness(root: string, sourceUrl: string, packageFileName: string) {
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
  const migrationFillsUpdate = migrated?.schemaVersion === 2 &&
    migrated?.config.update.autoCheck === true
  const migrationFillsProxy = migrated?.config.proxy.enabled === false &&
    migrated?.config.proxy.url === ''

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

  // 4. 替换脚本内容：升级分支含备份与就位，回滚分支含旧版本恢复
  const upgradeScript = buildReplaceScript({ root, pid: 12345, mode: 'upgrade' })
  const rollbackScript = buildReplaceScript({ root, pid: 12345, mode: 'rollback' })
  const scriptUpgradeOk = upgradeScript.includes('move') &&
    upgradeScript.includes(appName()) && upgradeScript.includes(':rollback')
  const scriptRollbackOk = rollbackScript.includes('app.old') && rollbackScript.includes(':launch')

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
    restart: () => undefined
  })

  const manifest = await updater.check()
  const checkOk = manifest?.version === '0.2.0'
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

  return {
    migrationKeepsConfig,
    migrationFillsUpdate,
    migrationFillsProxy,
    versionMigrationKeepsPending,
    compareOk,
    scriptUpgradeOk,
    scriptRollbackOk,
    checkOk,
    prepareOk,
    stagedOk,
    downloadOk,
    pendingPersisted,
    confirmOk,
    pendingCleared,
    manifestRootOk,
    phases: events
  }
}

function appName(): string {
  return 'EnvDock.exe'
}
