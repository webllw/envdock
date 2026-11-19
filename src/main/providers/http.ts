/**
 * 带超时与重试的 JSON 请求工具。
 * 版本源都走这里，避免每个 provider 重复实现网络容错。
 */

import { requestFetch } from '@main/core/net'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 3

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 请求文本，失败重试；返回 null 表示超时或错误后仍未成功 */
export async function fetchText(url: string, headers?: Record<string, string>): Promise<string | null> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      const response = await requestFetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'EnvDock/0.1', ...headers }
      })
      if (!response.ok) throw new HttpError(`HTTP ${response.status} ${url}`, response.status)
      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt < MAX_ATTEMPTS) await delay(400 * attempt)
    } finally {
      clearTimeout(timer)
    }
  }

  console.warn('[envdock] 请求失败', url, lastError)
  return null
}

/** 请求 JSON，失败重试；返回 null 表示超时或错误后仍未成功 */
export async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  const text = await fetchText(url, headers)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch (error) {
    console.warn('[envdock] JSON 解析失败', url, error)
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
