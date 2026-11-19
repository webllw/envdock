/**
 * 引擎核心逻辑验证。
 *
 * 在临时目录里跑真实的状态持久化、zip 解压、版本探测与激活脚本生成，
 * 不触碰用户 PATH 与真实环境根目录。用 esbuild 现场打包 TS 后执行。
 */
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { createRequire } from 'node:module'

const root = await mkdtemp(join(tmpdir(), 'envdock-verify-'))
const bundlePath = join(root, 'harness.cjs')

await build({
  entryPoints: ['src/main/verify/harness.ts'],
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

const { runHarness } = createRequire(import.meta.url)(bundlePath)

// 构造一个模拟的 Temurin zip：顶层 jdk-17/ 目录 + bin/java.exe
const zip = new AdmZip()
zip.addFile('jdk-17/bin/java.exe', Buffer.from('fake-java-binary'))
zip.addFile('jdk-17/lib/modules', Buffer.from('fake-modules'))
const archive = join(root, 'jdk.zip')
zip.writeZip(archive)

const result = await runHarness(root, archive)

const checks = [
  ['状态初始化并落盘', result.stateInitialized],
  ['状态更新后可回读', result.stateRoundTrip],
  ['zip 解压去掉顶层目录', result.extractedFlattened],
  ['版本元数据写入', result.metadataWritten],
  ['已安装版本探测', result.detected === 1],
  ['PowerShell 激活脚本生成', result.psScript],
  ['CMD 激活脚本生成', result.cmdScript],
  ['current/bin 垫片生成', result.shimGenerated],
  ['Maven 垫片指向 mvn.cmd', result.mavenShimTargetsCmd],
  ['Maven 垫片携带 JAVA_HOME', result.mavenShimCarriesJavaHome],
  ['目录占用统计为正数', result.diskUsage > 0]
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '通过' : '失败'}  ${name}`)
  if (!ok) failed += 1
}

await rm(root, { recursive: true, force: true })
if (failed > 0) {
  console.error(`\n${failed} 项验证失败`)
  process.exit(1)
}
console.log('\n引擎核心逻辑验证全部通过')
