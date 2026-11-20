/**
 * 环境根目录下的 JSON 状态持久化。
 *
 * 写入采用临时文件加原子重命名，避免进程中断时留下半截 JSON。
 * 每个文件独立的写队列保证并发 IPC 调用不会互相覆盖。
 *
 * 版本迁移策略：schemaVersion 不匹配时按字段补齐默认值，保留磁盘上的
 * 已知配置，不做整体覆盖。应用升级后旧配置必须原样可用。
 */
import { mkdir, readFile, rename, writeFile, stat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppConfig, AppStateData, Manifest, VersionState } from '@shared/domain'
import { DEFAULT_UPDATE_REPO, parseRepoSlug } from '@shared/sources'
import type { Layout } from './paths'

const STATE_SCHEMA_VERSION = 3
const MANIFEST_SCHEMA_VERSION = 1
const VERSION_SCHEMA_VERSION = 1

const writeQueues = new Map<string, Promise<void>>()

/** 把写操作串到同一个文件的队列尾部 */
function enqueueWrite(file: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  writeQueues.set(
    file,
    next.catch(() => undefined)
  )
  return next
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await enqueueWrite(file, async () => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await rename(temp, file)
  })
}

export function defaultUpdateConfig() {
  return { sourceUrl: DEFAULT_UPDATE_REPO, autoCheck: true }
}

export function defaultProxyConfig() {
  return { enabled: false, url: '' }
}

export function defaultConfig(): AppConfig {
  return {
    mirror: 'official',
    pathIntegration: false,
    update: defaultUpdateConfig(),
    proxy: defaultProxyConfig(),
    closeBehavior: 'ask'
  }
}

/** 把 record 中类型正确的字符串字段取出，避免脏数据进入状态 */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 把磁盘上的旧状态迁移到当前结构。
 *
 * 未知字段被丢弃，缺失字段用默认值补齐；已知的配置值逐项保留。
 * raw 不是对象时返回 null，由调用方写入全新默认状态。
 */
export function migrateState(raw: unknown, now = new Date().toISOString()): AppStateData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const config = (source.config && typeof source.config === 'object' ? source.config : {}) as Record<string, unknown>
  const update = (config.update && typeof config.update === 'object' ? config.update : {}) as Record<string, unknown>
  const proxy = (config.proxy && typeof config.proxy === 'object' ? config.proxy : {}) as Record<string, unknown>

  const activeVersions: Record<string, string> = {}
  const rawActive = source.activeVersions && typeof source.activeVersions === 'object' ? source.activeVersions : {}
  for (const [key, value] of Object.entries(rawActive as Record<string, unknown>)) {
    if (typeof value === 'string') activeVersions[key] = value
  }

  const mirror = str(config.mirror, 'official')
  // 旧配置可能存着对象存储地址，无法解析为 GitHub 仓库时回退到默认仓库
  const storedRepo = str(update.sourceUrl, '')
  const sourceUrl = parseRepoSlug(storedRepo) ? storedRepo : DEFAULT_UPDATE_REPO
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeVersions,
    config: {
      mirror: mirror === 'official' || mirror === 'tsinghua' || mirror === 'aliyun' || mirror === 'huawei'
        ? mirror
        : 'official',
      pathIntegration: bool(config.pathIntegration, false),
      update: {
        sourceUrl,
        autoCheck: bool(update.autoCheck, true)
      },
      proxy: {
        enabled: bool(proxy.enabled, false),
        url: str(proxy.url, '')
      },
      closeBehavior: config.closeBehavior === 'tray' || config.closeBehavior === 'quit' || config.closeBehavior === 'ask'
        ? config.closeBehavior
        : 'ask'
    },
    updatedAt: str(source.updatedAt, now)
  }
}

export function defaultState(now = new Date().toISOString()): AppStateData {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeVersions: {},
    config: defaultConfig(),
    updatedAt: now
  }
}

export function defaultManifest(root: string, now = new Date().toISOString()): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    installRoot: root,
    installedAt: now,
    updatedAt: now,
    mutations: []
  }
}

export function defaultVersionState(currentVersion: string, now = new Date().toISOString()): VersionState {
  return {
    schemaVersion: VERSION_SCHEMA_VERSION,
    currentVersion,
    pendingVersion: null,
    previousVersion: null,
    lastMessage: '',
    updatedAt: now
  }
}

/** 版本状态迁移：保留挂起升级信息，补齐缺失字段 */
export function migrateVersionState(raw: unknown, currentVersion: string, now = new Date().toISOString()): VersionState {
  const base = defaultVersionState(currentVersion, now)
  if (!raw || typeof raw !== 'object') return base
  const source = raw as Record<string, unknown>
  const pending = typeof source.pendingVersion === 'string' ? source.pendingVersion : null
  return {
    schemaVersion: VERSION_SCHEMA_VERSION,
    currentVersion: str(source.currentVersion, currentVersion),
    pendingVersion: pending,
    previousVersion: typeof source.previousVersion === 'string' ? source.previousVersion : null,
    lastMessage: str(source.lastMessage, ''),
    updatedAt: str(source.updatedAt, now)
  }
}

/** 状态与清单的读写门面，业务层只通过它访问持久化数据 */
export class Store {
  private state: AppStateData | null = null
  private manifest: Manifest | null = null
  private version: VersionState | null = null

  constructor(private layout: Layout, private readonly appVersion: string = '0.1.0') {}

  /** 目录迁移后切换根目录并重新加载磁盘上的状态与清单 */
  async adoptLayout(layout: Layout): Promise<void> {
    this.layout = layout
    this.state = null
    this.manifest = null
    this.version = null
    await this.init()
  }

  /** 首次调用时从磁盘加载，不存在则创建默认文件 */
  async init(): Promise<void> {
    await mkdir(this.layout.root, { recursive: true })
    await mkdir(this.layout.runtimesDir, { recursive: true })
    await mkdir(this.layout.cacheDir, { recursive: true })
    await mkdir(this.layout.downloadsDir, { recursive: true })
    await mkdir(this.layout.scriptsDir, { recursive: true })
    await mkdir(this.layout.currentBinDir, { recursive: true })
    await mkdir(this.layout.updatesDir, { recursive: true })
    await mkdir(this.layout.updateDownloadDir, { recursive: true })
    await mkdir(this.layout.updateHistoryDir, { recursive: true })

    const loadedState = await readJson<unknown>(this.layout.stateFile)
    const migratedState = migrateState(loadedState)
    this.state = migratedState ?? defaultState()
    if (!loadedState || !migratedState || (loadedState as Record<string, unknown>).schemaVersion !== STATE_SCHEMA_VERSION) {
      await writeJsonAtomic(this.layout.stateFile, this.state)
    }

    const loadedManifest = await readJson<Manifest>(this.layout.manifestFile)
    if (loadedManifest && loadedManifest.schemaVersion === MANIFEST_SCHEMA_VERSION) {
      this.manifest = loadedManifest
      // 绿色目录被整体复制或搬移后，清单里的根路径会失效，按实际位置回填
      if (loadedManifest.installRoot !== this.layout.root) {
        this.manifest = await this.updateManifest((draft) => {
          draft.installRoot = this.layout.root
        })
      }
    } else {
      this.manifest = defaultManifest(this.layout.root)
      await writeJsonAtomic(this.layout.manifestFile, this.manifest)
    }

    const loadedVersion = await readJson<unknown>(this.layout.versionFile)
    this.version = migrateVersionState(loadedVersion, this.appVersion)
    if (!loadedVersion || (loadedVersion as Record<string, unknown>).schemaVersion !== VERSION_SCHEMA_VERSION) {
      await writeJsonAtomic(this.layout.versionFile, this.version)
    }
  }

  getState(): AppStateData {
    if (!this.state) throw new Error('Store 尚未初始化')
    return this.state
  }

  async updateState(mutate: (draft: AppStateData) => void): Promise<AppStateData> {
    const current = this.getState()
    const draft: AppStateData = {
      ...current,
      activeVersions: { ...current.activeVersions },
      config: { ...current.config, update: { ...current.config.update }, proxy: { ...current.config.proxy } }
    }
    mutate(draft)
    draft.updatedAt = new Date().toISOString()
    await writeJsonAtomic(this.layout.stateFile, draft)
    this.state = draft
    return draft
  }

  getManifest(): Manifest {
    if (!this.manifest) throw new Error('Store 尚未初始化')
    return this.manifest
  }

  async updateManifest(mutate: (draft: Manifest) => void): Promise<Manifest> {
    const current = this.getManifest()
    const draft: Manifest = {
      ...current,
      mutations: current.mutations.map((item) => ({ ...item }))
    }
    mutate(draft)
    draft.updatedAt = new Date().toISOString()
    await writeJsonAtomic(this.layout.manifestFile, draft)
    this.manifest = draft
    return draft
  }

  getVersion(): VersionState {
    if (!this.version) throw new Error('Store 尚未初始化')
    return this.version
  }

  async updateVersion(mutate: (draft: VersionState) => void): Promise<VersionState> {
    const current = this.getVersion()
    const draft: VersionState = { ...current }
    mutate(draft)
    draft.updatedAt = new Date().toISOString()
    await writeJsonAtomic(this.layout.versionFile, draft)
    this.version = draft
    return draft
  }

  /** 统计环境根目录占用，失败时返回 0，不让体检因统计失败而中断 */
  async diskUsage(): Promise<number> {
    let total = 0
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          try {
            const info = await stat(full)
            total += info.size
          } catch {
            /* 文件可能在遍历期间被删除，忽略 */
          }
        }
      }
    }
    await walk(this.layout.root)
    return total
  }
}
