/**
 * 出网请求的统一入口。
 *
 * Node 内置 fetch 使用 undici 的默认 dispatcher，不读取 HTTP_PROXY 环境变量，
 * 因此应用内的请求始终直连。这里按用户配置的代理构造 ProxyAgent，并注入到
 * 请求的 dispatcher 选项；关闭代理或地址为空时回落到内置 fetch。
 *
 * 配置读取以 setter 注入，避免网络层反向依赖 Store 造成初始化环。
 */
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import type { ProxyConfig } from '@shared/domain'
import type { ProxyTestResult } from '@shared/ipc'

type ConfigProvider = () => ProxyConfig

let readProxy: ConfigProvider = () => ({ enabled: false, url: '' })
let cachedUrl = ''
let cachedAgent: Dispatcher | null = null

/** 由引擎在初始化后注入配置读取函数 */
export function setProxyProvider(provider: ConfigProvider): void {
  readProxy = provider
  releaseAgent()
}

/**
 * 返回当前应使用的 dispatcher；代理地址变化才重建实例。
 * 地址非法时视为未配置，避免把一个无效 dispatcher 注入所有请求。
 */
function currentDispatcher(): Dispatcher | undefined {
  const config = readProxy()
  const url = config.url.trim()
  if (!config.enabled || url.length === 0) {
    releaseAgent()
    return undefined
  }
  if (!/^https?:\/\//i.test(url)) return undefined

  if (!cachedAgent || cachedUrl !== url) {
    cachedAgent?.close().catch(() => undefined)
    cachedAgent = new ProxyAgent(url)
    cachedUrl = url
  }
  return cachedAgent
}

function releaseAgent(): void {
  if (cachedAgent) {
    cachedAgent.close().catch(() => undefined)
    cachedAgent = null
    cachedUrl = ''
  }
}

/** 标准 fetch 的兼容签名；代理开启时内部改用 undici.fetch 并注入 dispatcher */
export function requestFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = currentDispatcher()
  if (!dispatcher) return fetch(url, init)
  // undici 的 Response 与 DOM Response 结构一致，此处按标准 Response 返回
  return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}

/**
 * 用临时 dispatcher 实测代理连通性，不改动全局缓存。
 * 探测地址选 Adoptium 列表接口：响应小、能代表真实出网链路。
 */
/** 把 undici 的连接类错误转成可操作提示 */
function describeProxyError(error: unknown): string {
  // undici 常把底层原因放在 cause 里，外层只有泛化的 fetch failed
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined
  const text = [error instanceof Error ? error.message : String(error), cause instanceof Error ? cause.message : '']
    .filter(Boolean)
    .join(' ')
  if (/ECONNREFUSED|connect|fetch failed/i.test(text)) return '无法连接代理，请确认地址与端口正确且代理已启动'
  if (/timeout|abort/i.test(text)) return '连接超时，请检查代理是否可用'
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '代理地址无法解析'
  if (/HTTP \d+/.test(text)) return `代理返回错误：${text.match(/HTTP \d+/)?.[0]}`
  return text || '连接失败'
}

export async function testProxyConnection(config: ProxyConfig): Promise<ProxyTestResult> {
  const url = config.url.trim()
  if (config.enabled && !/^https?:\/\//i.test(url)) {
    throw new Error('代理地址需以 http:// 或 https:// 开头')
  }

  const probe = 'https://api.adoptium.net/v3/assets/feature_releases/25/ga?page_size=1'
  const agent = config.enabled && url ? new ProxyAgent(url) : undefined
  const started = Date.now()
  try {
    const response = await undiciFetch(probe, {
      dispatcher: agent,
      signal: AbortSignal.timeout(12_000)
    } as Parameters<typeof undiciFetch>[1])
    await response.body?.cancel()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { ok: true, latencyMs: Date.now() - started, message: config.enabled ? '代理可用' : '当前为直连，网络可用' }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: describeProxyError(error) }
  } finally {
    await agent?.close()
  }
}
