/**
 * 把 electron-builder 的 dir 产物组装成完整绿色目录。
 *
 * 输出结构：release/EnvDock/ 即一个可迁移的环境根目录，包含：
 *   app/                 应用本体（exe 与 asar）
 *   state.json           初始状态
 *   manifest.json        初始清单，resolveInstallRoot 靠它定位根目录
 *   version.json         应用版本
 *   runtimes/ cache/ scripts/ current/ updates/   运行时数据骨架
 *
 * 用户把 EnvDock 目录整体复制到任意磁盘即可使用，删除该目录即为卸载。
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const releaseDir = resolve(root, process.env.ASSEMBLE_RELEASE_DIR ?? 'release')
const unpackedDir = join(releaseDir, process.env.ASSEMBLE_UNPACKED_DIR ?? 'win-unpacked')
let outputDir = join(releaseDir, process.env.ASSEMBLE_OUTPUT_DIR ?? 'EnvDock')

if (!existsSync(join(unpackedDir, 'EnvDock.exe'))) {
  console.error('[assemble] 未找到 win-unpacked/EnvDock.exe，请先执行 electron-builder --dir')
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const now = new Date().toISOString()

// 旧产物若被资源管理器或预览器占用，删除会失败；此时退到带时间戳的目录，
// 避免整次打包因为一个被锁住的 asar 而中断。
try {
  await rm(outputDir, { recursive: true, force: true })
} catch {
  outputDir = join(releaseDir, `EnvDock-${Date.now()}`)
  console.warn(`[assemble] 默认目录被占用，改输出到 ${outputDir}`)
}
await mkdir(outputDir, { recursive: true })

await cp(unpackedDir, join(outputDir, 'app'), { recursive: true })

for (const dir of ['runtimes', join('cache', 'downloads'), 'scripts', join('current', 'bin'), join('updates', 'download')]) {
  await mkdir(join(outputDir, dir), { recursive: true })
}

const state = {
  schemaVersion: 2,
  activeVersions: {},
  config: {
    mirror: 'official',
    pathIntegration: false,
    update: { sourceUrl: '', autoCheck: true },
    proxy: { enabled: false, url: '' }
  },
  updatedAt: now
}
const manifest = {
  schemaVersion: 1,
  installRoot: '__INSTALL_ROOT__',
  installedAt: now,
  updatedAt: now,
  mutations: []
}
const version = {
  schemaVersion: 1,
  currentVersion: pkg.version,
  pendingVersion: null,
  previousVersion: null,
  lastMessage: '',
  updatedAt: now
}

await writeFile(join(outputDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8')
await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
await writeFile(join(outputDir, 'version.json'), JSON.stringify(version, null, 2) + '\n', 'utf8')

console.log(`[assemble] 绿色目录已生成：${outputDir}`)
console.log('[assemble] manifest.json 的 installRoot 在首次启动时按实际路径回填')
