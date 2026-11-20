/**
 * 完整发版打包：清空 release → 构建 → electron-builder → 组装绿色目录 → 打两个 zip 与校验值。
 *
 * 每次都从空的 release 开始，避免旧 win-unpacked 里的 app.asar 被系统进程独占，
 * 也避免历史构建目录（build107、pkg-108-final 等）不断堆积。
 *
 * 产物：
 *   release/EnvDock-<version>-app.zip       就地升级包，根目录为 app/
 *   release/EnvDock-<version>-portable.zip  全新安装全量包，根目录为 EnvDock/
 *   以及各自的 .sha256 文件。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'

const root = resolve(process.cwd())
const releaseDir = join(root, 'release')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = pkg.version

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

// 1. 清空 release。此时若有进程占用其中的文件，删除会失败——直接报错，
// 不静默改用其他目录，否则又会出现多份构建产物并存。
if (existsSync(releaseDir)) {
  try {
    await rm(releaseDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
  } catch (error) {
    console.error(`[build-release] 无法清空 release：${error instanceof Error ? error.message : error}`)
    console.error('[build-release] 请关闭占用 release 目录的程序后重试')
    process.exit(1)
  }
}
await mkdir(releaseDir, { recursive: true })

// 2. 构建与 electron-builder。输出到空的 release/win-unpacked。
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--dir', '--win', '--config', 'electron-builder.yml'])

const unpackedDir = join(releaseDir, 'win-unpacked')
if (!existsSync(join(unpackedDir, 'EnvDock.exe'))) {
  console.error('[build-release] electron-builder 未产出 win-unpacked/EnvDock.exe')
  process.exit(1)
}

// 3. 组装绿色目录到 release/EnvDock。
run('node', ['scripts/assemble-portable.mjs'])
const portableDir = join(releaseDir, 'EnvDock')
if (!existsSync(join(portableDir, 'app', 'EnvDock.exe'))) {
  console.error('[build-release] 绿色目录缺少 app/EnvDock.exe')
  process.exit(1)
}

/** 收集目录内容为 zip；prefix 决定包内顶层目录名 */
function buildZip(srcRoot, prefix, outName) {
  const zip = new AdmZip()
  let count = 0
  const walk = (dir, relPrefix) => {
    // readdirSync 保证条目顺序稳定，包内容可复现
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      const target = `${prefix}${relPrefix}${entry.name}`
      if (entry.isDirectory()) {
        walk(full, `${relPrefix}${entry.name}/`)
      } else {
        zip.addFile(target, readFileSync(full))
        count += 1
      }
    }
  }
  walk(srcRoot, '')
  const out = join(releaseDir, outName)
  zip.writeZip(out)
  const data = readFileSync(out)
  const sha = createHash('sha256').update(data).digest('hex')
  writeFileSync(`${out}.sha256`, `${sha}  ${outName}\n`, 'ascii')
  console.log(`[build-release] ${outName}  文件数=${count}  大小=${(data.length / 1024 / 1024).toFixed(1)}MB  sha256=${sha}`)
}

buildZip(unpackedDir, 'app/', `EnvDock-${version}-app.zip`)
buildZip(portableDir, 'EnvDock/', `EnvDock-${version}-portable.zip`)

// 4. 清理中间产物，release 只留两个 zip 与校验值
for (const name of ['win-unpacked', 'EnvDock']) {
  await rm(join(releaseDir, name), { recursive: true, force: true }).catch(() => undefined)
}

console.log(`[build-release] v${version} 打包完成`)
