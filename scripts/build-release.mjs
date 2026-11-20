/**
 * 完整发版打包：隔离构建 → electron-builder → 组装绿色目录 → 打两个 zip 与校验值。
 *
 * 全部中间产物写进带时间戳的 .build-<ts>/ 目录，不在 release 内就地删除或改名。
 * Windows 上 release/win-unpacked 里的 asar 常被资源管理器或杀毒软件锁定，
 * 就地清空会触发删除保护；隔离目录从一开始就是空的，构建稳定且与历史产物隔离。
 *
 * 最终只把两个 zip 与各自的 .sha256 覆盖写回 release/，覆盖不触发删除保护。
 * 产物：
 *   release/EnvDock-<version>-app.zip       就地升级包，根目录为 app/
 *   release/EnvDock-<version>-portable.zip  全新安装全量包，根目录为 EnvDock/
 *   以及各自的 .sha256 文件。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'

const root = resolve(process.cwd())
const releaseDir = join(root, 'release')
const buildDir = join(root, `.build-${Date.now()}`)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = pkg.version

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env })
}

await mkdir(buildDir, { recursive: true })
await mkdir(releaseDir, { recursive: true })

// 1. 构建与 electron-builder。用 -c.directories.output 把产物指向隔离目录，
// 覆盖 yml 中的 release，使历史产物不参与本次构建。
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--dir', '--win', '--config', 'electron-builder.yml', '-c.directories.output=' + buildDir])

const unpackedDir = join(buildDir, 'win-unpacked')
if (!existsSync(join(unpackedDir, 'EnvDock.exe'))) {
  console.error('[build-release] electron-builder 未产出 win-unpacked/EnvDock.exe')
  process.exit(1)
}

// 2. 组装绿色目录到隔离目录。
run('node', ['scripts/assemble-portable.mjs'], {
  ...process.env,
  ASSEMBLE_RELEASE_DIR: buildDir,
  ASSEMBLE_UNPACKED_DIR: 'win-unpacked',
  ASSEMBLE_OUTPUT_DIR: 'EnvDock'
})
const portableDir = join(buildDir, 'EnvDock')
if (!existsSync(join(portableDir, 'app', 'EnvDock.exe'))) {
  console.error('[build-release] 绿色目录缺少 app/EnvDock.exe')
  process.exit(1)
}

/** 收集目录内容为 zip；prefix 决定包内顶层目录名，out 写到 release/ */
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

console.log(`[build-release] v${version} 打包完成，中间产物位于 ${buildDir}`)
