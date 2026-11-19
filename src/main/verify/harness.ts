/** 验证脚本用的引擎调用入口，不参与应用构建 */
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createLayout } from '@main/core/paths'
import { Store } from '@main/core/store'
import { detectInstalled, extractZip, writeVersionMetadata } from '@main/providers/runtime'
import { writeActivationScripts, writeCurrentShims, type ActiveTool } from '@main/core/activations'
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

  const active: ActiveTool[] = [{
    toolId: 'java',
    relativeBinDir: `runtimes/java/${version.id}/bin`,
    envVars: { JAVA_HOME: `runtimes/java/${version.id}` }
  }]
  await writeActivationScripts(layout, active)
  await writeCurrentShims(layout, active)

  const psScript = (await readFile(join(layout.scriptsDir, 'activate.ps1'), 'utf8')).includes('$env:JAVA_HOME')
  const cmdScript = (await readFile(join(layout.scriptsDir, 'activate.bat'), 'utf8')).includes('set "JAVA_HOME=')
  const shimGenerated = (await readFile(join(layout.currentBinDir, 'java.cmd'), 'utf8')).includes('java.exe')

  const diskUsage = await store.diskUsage()

  return {
    stateInitialized,
    stateRoundTrip,
    extractedFlattened,
    metadataWritten,
    detected,
    psScript,
    cmdScript,
    shimGenerated,
    diskUsage
  }
}
