import { useState } from 'react'
import { Plus, Check, Trash2, Globe2, Loader2, Info } from 'lucide-react'
import { useAppStore } from '@renderer/store/useAppStore'
import { Button, Card, StatusDot, Tag, EmptyState } from '@renderer/components/ui/ui'
import type { InstalledVersion, ToolId } from '@renderer/types/domain'
import './runtimes.css'

export function Runtimes() {
  const { tools, setActiveVersion, deactivateVersion, uninstallToolVersion, openWizard } = useAppStore()
  const [selectedId, setSelectedId] = useState<string>(tools[0]?.id ?? 'java')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** 待卸载行的快照：真实删除期间 tools 尚未刷新，用它把该行保留在原位并标为 busy */
  const [pendingUninstall, setPendingUninstall] = useState<{
    toolId: string
    version: InstalledVersion
    index: number
  } | null>(null)
  /** 删除成功后播放退场动画的行 key */
  const [removingKey, setRemovingKey] = useState<string | null>(null)
  const selected = tools.find((tool) => tool.id === selectedId) ?? tools[0]

  if (!selected) return null

  // 删除期间真实数据可能已被 refreshTools 刷新掉，用快照把这行按原位留在列表，
  // 直到退场动画播完，避免“点一下立刻没了、后台却还在删”的割裂感
  const displayInstalled = [...selected.installed]
  if (pendingUninstall && pendingUninstall.toolId === selected.id) {
    const stillPresent = displayInstalled.some(
      (item) => item.versionId === pendingUninstall.version.versionId
    )
    if (!stillPresent) {
      const at = Math.min(pendingUninstall.index, displayInstalled.length)
      displayInstalled.splice(at, 0, pendingUninstall.version)
    }
  }

  const handleSetActive = async (toolId: string, versionId: string) => {
    const key = `${toolId}:${versionId}:activate`
    if (busyKey) return
    setBusyKey(key)
    try {
      await setActiveVersion(toolId as ToolId, versionId)
    } finally {
      setBusyKey(null)
    }
  }

  const handleDeactivate = async (toolId: string) => {
    const key = `${toolId}:deactivate`
    if (busyKey) return
    setBusyKey(key)
    try {
      await deactivateVersion(toolId as ToolId)
    } finally {
      setBusyKey(null)
    }
  }

  const handleUninstall = async (toolId: string, version: InstalledVersion) => {
    if (busyKey) return
    if (!window.confirm(`确认卸载 ${selected.displayName} ${version.display}？此操作会删除该版本目录。`)) return
    const key = `${toolId}:${version.versionId}:uninstall`
    const index = selected.installed.findIndex((item) => item.versionId === version.versionId)
    setBusyKey(key)
    // 删除真实耗时全在服务端，用快照把这行固定在原位，避免数据刷新后先消失
    setPendingUninstall({ toolId, version, index })
    try {
      const ok = await uninstallToolVersion(toolId as ToolId, version.versionId)
      if (!ok) return
      // 成功后才播退场动画，动画走完界面与数据同步移除该行
      setRemovingKey(key)
      await new Promise((resolve) => setTimeout(resolve, 320))
    } finally {
      setBusyKey(null)
      setPendingUninstall(null)
      setRemovingKey(null)
    }
  }

  return (
    <div className="runtimes">
      <div className="runtime-tabs">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`runtime-tab ${selected.id === tool.id ? 'runtime-tab-active' : ''}`}
            onClick={() => setSelectedId(tool.id)}
          >
            <span className="runtime-tab-dot" style={{ background: tool.accent }} />
            {tool.displayName}
            <span className="runtime-tab-count">{tool.installed.length}</span>
          </button>
        ))}
      </div>

      <div className="runtime-toolbar">
        <div className="runtime-toolbar-info">
          <strong>{selected.displayName}</strong>
          <span className="dot-sep">·</span>
          <span>{selected.installed.length} 个已安装</span>
          <span className="dot-sep">·</span>
          <span>{selected.remoteCount} 个远程可用</span>
        </div>
        <Button variant="primary" size="sm" onClick={() => openWizard(selected.id)}>
          <Plus size={14} /> 安装版本
        </Button>
      </div>

      {selected.id === 'node' && (
        <div className="runtime-notice">
          <Info size={14} className="runtime-notice-icon" />
          <span>
            npm 全局目录固定在 <code>global/npm</code>，按 Node 主版本隔离，由 EnvDock 自动管理。
            请勿手动改动该目录或另行设置 npm prefix / cache，否则切换版本后全局命令可能失效。
          </span>
        </div>
      )}

      <div className="section-head">
        <h2>已安装版本</h2>
      </div>

      {displayInstalled.length === 0 ? (
        <Card><EmptyState title="尚未安装任何版本" hint="点击右上角「安装版本」开始" /></Card>
      ) : (
        <div className="version-list">
          {displayInstalled.map((version) => {
            const isGlobal = selected.activeVersionId === version.versionId
            const uninstallKey = `${selected.id}:${version.versionId}:uninstall`
            const activateKey = `${selected.id}:${version.versionId}:activate`
            const deactivateKey = `${selected.id}:deactivate`
            const isRemoving = removingKey === uninstallKey
            const isUninstalling = busyKey === uninstallKey
            const isActivating = busyKey === activateKey || (isGlobal && busyKey === deactivateKey)
            return (
              <Card
                key={version.versionId}
                className={`version-row ${isRemoving ? 'version-row-removing' : ''} ${isUninstalling && !isRemoving ? 'version-row-uninstalling' : ''} ${isActivating && !isRemoving ? 'version-row-activating' : ''}`}
              >
                <div className="version-main">
                  <StatusDot tone={isGlobal ? 'ok' : 'idle'} />
                  <div className="version-identity">
                    <span className="version-display mono">{version.display}</span>
                    <span className="version-path mono">{version.relativePath}</span>
                  </div>
                </div>
                <div className="version-badges">
                  {isGlobal && <Tag tone="accent"><Globe2 size={11} /> 全局</Tag>}
                </div>
                <div className="version-actions">
                  {isGlobal ? (
                    <Button
                      variant="subtle"
                      size="sm"
                      disabled={Boolean(busyKey)}
                      title="取消该工具的全局激活"
                      onClick={() => void handleDeactivate(selected.id)}
                    >
                      {busyKey === deactivateKey
                        ? <><Loader2 size={13} className="spin" /> 取消中</>
                        : <><Check size={13} /> 取消全局</>}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busyKey)}
                      onClick={() => void handleSetActive(selected.id, version.versionId)}
                    >
                      {busyKey === activateKey
                        ? <><Loader2 size={13} className="spin" /> 设置中</>
                        : '设为全局'}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={isGlobal || Boolean(busyKey)}
                    title={isGlobal ? '激活中的版本不可卸载' : '卸载'}
                    onClick={() => void handleUninstall(selected.id, version)}
                  >
                    {isUninstalling ? <><Loader2 size={13} className="spin" /> 卸载中</> : <Trash2 size={13} />}
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
