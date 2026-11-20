/**
 * 流式下载与校验。
 *
 * 下载先写入 .part 临时文件，校验通过后才改名为正式缓存文件。
 * 多个候选地址按序尝试，镜像失败自动回退官方源；校验和不匹配的包
 * 直接删除，不进入安装流程。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DownloadPlan, ProgressEvent, ToolId } from '@shared/domain'
import { requestFetch } from './net'

export interface DownloadOptions {
  toolId: ToolId
  versionId: string
  destFile: string
  plan: DownloadPlan
  onProgress: (event: ProgressEvent) => void
}

export interface DownloadResult {
  file: string
  bytes: number
}

/** 校验本地文件哈希，算法来自下载计划 */
export async function verifyChecksum(file: string, expected: string, algorithm: string): Promise<boolean> {
  if (!expected) return true
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex').toLowerCase() === expected.toLowerCase()
}

/** 连续多少毫秒收不到任何字节才判定链路失效；持续传输的慢速下载不受总时长限制 */
const DOWNLOAD_IDLE_MS = 30_000

export async function downloadBytes(
  url: string,
  dest: string,
  onBytes: (received: number, total: number) => void
): Promise<void> {
  // 升级包约 60MB，代理链路上耗时可能远超固定总时长。用空闲超时替代总时长超时：
  // 每收到一批字节就重置计时器，只有长时间完全没有数据才中止，慢速下载不会被误杀。
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error('下载长时间无响应')), DOWNLOAD_IDLE_MS)
  }
  armIdle()

  let writer: ReturnType<typeof createWriteStream> | undefined
  try {
    const response = await requestFetch(url, {
      headers: { 'user-agent': 'EnvDock/0.1' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
    if (!response.body) throw new Error(`响应无内容 ${url}`)

    const total = Number(response.headers.get('content-length') ?? 0)
    await mkdir(dirname(dest), { recursive: true })
    const output = createWriteStream(dest)
    writer = output
    let received = 0

    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armIdle()
      received += value.byteLength
      if (!output.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => output.once('drain', resolve))
      }
      onBytes(received, total)
    }
    await new Promise<void>((resolve, reject) => {
      output.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    writer?.destroy()
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

/** 下载并校验，返回缓存文件路径；全部候选失败时抛错 */
export async function downloadAndVerify(options: DownloadOptions): Promise<DownloadResult> {
  const { plan, destFile } = options
  const candidates = [plan.url, ...(plan.fallbackUrls ?? [])]
  let lastError: unknown

  options.onProgress({
    toolId: options.toolId,
    versionId: options.versionId,
    phase: 'downloading',
    percent: 0,
    message: '准备下载'
  })

  for (let index = 0; index < candidates.length; index += 1) {
    const url = candidates[index]
    const partFile = `${destFile}.part`
    await rm(partFile, { force: true })

    try {
      await downloadBytes(url, partFile, (received, total) => {
        const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1
        options.onProgress({
          toolId: options.toolId,
          versionId: options.versionId,
          phase: 'downloading',
          percent,
          message: `下载中 ${(received / 1024 / 1024).toFixed(1)} MB`
        })
      })

      options.onProgress({
        toolId: options.toolId,
        versionId: options.versionId,
        phase: 'verifying',
        percent: 99,
        message: '校验文件'
      })
      if (!(await verifyChecksum(partFile, plan.checksum, plan.checksumAlgorithm))) {
        throw new Error(`校验和不匹配：${plan.fileName}`)
      }

      await rename(partFile, destFile)
      const info = await stat(destFile)
      return { file: destFile, bytes: info.size }
    } catch (error) {
      lastError = error
      await rm(partFile, { force: true })
      console.warn('[envdock] 下载地址失败', url, error)
    }
  }

  throw new Error(`全部下载地址失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/** 缓存命中时直接返回，避免重复下载 */
export async function cachedFile(destFile: string): Promise<string | null> {
  try {
    await stat(destFile)
    return destFile
  } catch {
    return null
  }
}
