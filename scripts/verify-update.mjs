/**
 * 升级引擎端到端验证。
 *
 * 在本地临时目录起一个 HTTP 服务模拟 GitHub Releases Atom feed 与资产下载直链，
 * 用 esbuild 现场打包升级 harness 后执行：覆盖配置迁移、版本比较、检查、
 * 下载校验解压、挂起状态持久化、启动确认、manifest 路径回填。
 * 不启动 Electron，不改系统 PATH。
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { createRequire } from 'node:module'

const root = await mkdtemp(join(tmpdir(), 'envdock-update-'))
const sourceDir = join(root, 'release-assets')
await mkdir(sourceDir, { recursive: true })

// 造一个升级包：包内直接是 app 目录的内容（含 EnvDock.exe）
const zip = new AdmZip()
zip.addFile('EnvDock.exe', Buffer.from('fake-envdock-v02'))
zip.addFile('resources/app.asar', Buffer.from('fake-asar'))
const packageName = 'EnvDock-0.2.0-app.zip'
const packagePath = join(sourceDir, packageName)
zip.writeZip(packagePath)
const sha256 = createHash('sha256').update(await readFile(packagePath)).digest('hex')
await writeFile(`${packagePath}.sha256`, `${sha256}  ${packageName}\n`, 'ascii')

let port = 0
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from envdock</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.2.0</id>
    <updated>2026-11-18T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/webllw/envdock/releases/tag/v0.2.0"/>
    <title>EnvDock 0.2.0</title>
    <content type="html">&lt;p&gt;验证用新版本&lt;/p&gt;</content>
  </entry>
</feed>`

const server = createServer(async (req, res) => {
  const path = req.url ?? ''
  if (path.endsWith('/releases.atom')) {
    res.writeHead(200, { 'content-type': 'application/atom+xml', 'content-length': String(Buffer.byteLength(feed)) })
    res.end(feed)
    return
  }
  const name = path.replace(/^.*\//, '')
  const file = join(sourceDir, name)
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-length': String(data.length) })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
port = typeof address === 'object' && address ? address.port : 0
const sourceUrl = 'https://github.com/webllw/envdock'
const webBase = `http://127.0.0.1:${port}`

const bundlePath = join(root, 'harness.cjs')
await build({
  entryPoints: ['src/main/verify/update-harness.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  alias: {
    '@shared': join(process.cwd(), 'src/shared'),
    '@main': join(process.cwd(), 'src/main'),
    electron: join(process.cwd(), 'src/main/verify/electron-stub.ts')
  },
  logLevel: 'silent'
})

const { runUpdateHarness } = createRequire(import.meta.url)(bundlePath)
const envRoot = join(root, 'envdock-data')
const result = await runUpdateHarness(envRoot, sourceUrl, packageName, webBase)
server.close()

const checks = [
  ['旧配置迁移不丢失', result.migrationKeepsConfig],
  ['迁移补齐 update 字段', result.migrationFillsUpdate],
  ['迁移补齐 proxy 字段', result.migrationFillsProxy],
  ['迁移补齐 closeBehavior 字段', result.migrationFillsCloseBehavior],
  ['版本状态迁移保留挂起', result.versionMigrationKeepsPending],
  ['语义版本比较', result.compareOk],
  ['升级脚本归档当前版本并等待确认', result.scriptUpgradeOk],
  ['回退脚本就位后立即启动不轮询确认', result.scriptRollbackOk],
  ['归档就位恢复均带退避重试', result.retryGuarded],
  ['就位后核对版本标记并清理旧错误标志', result.versionMarked],
  ['版本目录名拒绝路径穿越', result.versionDirGuard],
  ['静默启动器隐藏窗口', result.silentLauncher],
  ['Atom feed 检查发现新版本', result.checkOk],
  ['下载校验解压完成', result.prepareOk],
  ['升级包落盘缓存', result.downloadOk],
  ['staging 含应用本体', result.stagedOk],
  ['staging 写入目标版本标记', result.markerOk],
  ['已校验缓存复用不重复下载', result.cacheReuseOk],
  ['staging 残留嵌套目录时可清理覆盖', result.stagingCleanOk],
  ['prepare 失败复位到 error 可重试', result.errorResetOk],
  ['挂起版本持久化', result.pendingPersisted],
  ['启动确认写入标记', result.confirmOk],
  ['确认后清空挂起', result.pendingCleared],
  ['manifest 根路径回填', result.manifestRootOk],
  ['历史版本降序列表与可启动判定', result.historyListOk],
  ['回退到指定版本且损坏版本被拒', result.rollbackToVersionOk],
  ['删除指定历史版本且保护当前版本', result.discardOk],
  ['仅升级包版本可还原后回退', result.packageRollbackOk],
  ['删除同时清理归档与升级包', result.packageDiscardOk],
  ['旧 app.old 迁移为历史归档', result.legacyMigrated]
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}`)
  if (!ok) failed += 1
}
console.log(`\n进度阶段：${result.phases.join(' → ')}`)

await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
if (failed > 0) {
  console.error(`\n${failed} 项验证失败`)
  process.exit(1)
}
console.log('\n升级引擎验证全部通过')
