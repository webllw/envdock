/**
 * Provider 注册表。
 *
 * 工具列表只由这里的注册表决定，引擎与界面都不硬编码工具 id。
 * 新增语言 = 实现一个 ToolProvider 并在 createProviders 里登记。
 */
import type { AppConfig, ToolId, ToolProvider } from '@shared/domain'
import { JavaProvider } from './java'
import { PhpProvider } from './php'
import { PythonProvider } from './python'
import { GoProvider } from './go'
import { NodeProvider } from './node'

/**
 * 构造已启用的 provider。
 * 配置对象注入到 provider，使镜像选择成为 provider 内部行为。
 */
export function createProviders(config: AppConfig): Map<ToolId, ToolProvider> {
  const providers = new Map<ToolId, ToolProvider>()
  providers.set('java', new JavaProvider(config))
  providers.set('php', new PhpProvider(config))
  providers.set('python', new PythonProvider(config))
  providers.set('go', new GoProvider(config))
  providers.set('node', new NodeProvider(config))
  return providers
}

/** 全部工具元数据，由已登记的 provider 提供 */
export function allToolMetadata(config: AppConfig): { id: ToolId; displayName: string; accent: string }[] {
  return [...createProviders(config).values()].map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    accent: provider.accent
  }))
}
