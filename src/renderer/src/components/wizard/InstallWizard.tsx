import { X, Check, Download, Loader2, ShieldCheck, ShieldAlert, Globe2 } from 'lucide-react'
import { useAppStore } from '@renderer/store/useAppStore'
import { officialSource, sourceReliability } from '@shared/sources'
import { Button, ChannelBadge, ProgressBar, StatusDot, Tag } from '@renderer/components/ui/ui'
import './wizard.css'

/** 默认展示的版本数；超出部分由用户主动展开，避免列表突然变长 */
const COLLAPSED_LIMIT = 10

function httpsSafe(url: string): boolean {
  return /^https:\/\//i.test(url)
}

export function InstallWizard() {
  const {
    wizard,
    tools,
    remote,
    selectWizardVersion,
    toggleShowAll,
    closeWizard,
    runInstall
  } = useAppStore()

  const { open, toolId, selectedVersionId, stage, progress, progressMessage, error, loading, showAll } = wizard
  const tool = tools.find((item) => item.id === toolId)
  const allRemote = toolId ? (remote[toolId] ?? []) : []
  const selected = allRemote.find((v) => v.id === selectedVersionId)
  const installedIds = new Set(tool?.installed.map((item) => item.versionId) ?? [])
  const source = toolId ? officialSource(toolId) : null
  const displayUrl = source?.url ?? '（该工具尚未接入官方源）'
  const trust = sourceReliability(displayUrl)
  const visibleRemote = showAll ? allRemote : allRemote.slice(0, COLLAPSED_LIMIT)
  const hiddenCount = allRemote.length - visibleRemote.length

  if (!open) return null

  const stepIndex = stage === 'select' ? 1 : stage === 'installing' ? 2 : 3

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeWizard()}>
      <div className="wizard-modal" role="dialog" aria-modal="true">
        <div className="wizard-header">
          <div>
            <div className="wizard-kicker">安装向导</div>
            <div className="wizard-title">{tool?.displayName ?? '运行时'} · 新版本</div>
          </div>
          <button type="button" className="wizard-close" onClick={closeWizard} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="stepper">
          {['选择版本', '安装', '完成'].map((label, index) => (
            <div key={label} className="stepper-item">
              <span className={`step-dot ${index + 1 <= stepIndex ? 'step-active' : ''}`}>
                {index + 1 < stepIndex ? <Check size={11} strokeWidth={3} /> : index + 1}
              </span>
              <span className={index + 1 === stepIndex ? 'step-label-active' : 'step-label'}>{label}</span>
              {index < 2 && <span className="step-line" />}
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {stage === 'select' && (
            <>
              {error && <div className="wizard-error">{error}</div>}

              <div className="source-panel">
                <div className="source-panel-head">
                  <Globe2 size={13} />
                  <span>版本拉取地址</span>
                  <Tag tone={trust.tone}>{trust.label}</Tag>
                  {!httpsSafe(displayUrl) && <ShieldAlert size={13} className="source-risk-icon" />}
                  {trust.tone === 'ok' && <ShieldCheck size={13} className="source-safe-icon" />}
                </div>
                <div className="source-url mono" title={displayUrl}>{displayUrl}</div>
                <div className={`source-detail source-detail-${trust.tone}`}>{trust.detail}</div>
              </div>

              <div className="version-list-label">
                <span>可选版本</span>
                <span className="version-list-count mono">
                  {loading ? '加载中' : `${allRemote.length} 个`}
                </span>
              </div>
              {loading ? (
                <div className="version-loading">
                  <Loader2 size={18} className="spin" />
                  <span>正在从官方源获取版本列表…</span>
                </div>
              ) : allRemote.length === 0 ? (
                <div className="wizard-empty">未获取到版本列表，请检查拉取地址或网络连接</div>
              ) : (
                <>
                  <div className="version-options">
                    {visibleRemote.map((version) => {
                      const isInstalled = installedIds.has(version.id)
                      return (
                        <button
                          type="button"
                          key={version.id}
                          className={`version-option ${selectedVersionId === version.id ? 'option-selected' : ''} ${isInstalled ? 'option-installed' : ''}`}
                          onClick={() => selectWizardVersion(version.id)}
                        >
                          <span className="option-radio" />
                          <span className="option-version mono">{version.display}</span>
                          <ChannelBadge channel={version.channel} />
                          {isInstalled ? (
                            <Tag tone="accent">已安装</Tag>
                          ) : (
                            <StatusDot tone="idle" />
                          )}
                          <span className="option-date mono">{version.releasedAt ? version.releasedAt.slice(0, 10) : '—'}</span>
                        </button>
                      )
                    })}
                  </div>
                  {(hiddenCount > 0 || showAll) && (
                    <button type="button" className="version-more" onClick={toggleShowAll}>
                      {showAll ? '收起' : `显示更多（还有 ${hiddenCount} 个）`}
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {stage === 'installing' && (
            <div className="install-progress-view">
              <div className="install-spinner"><Loader2 size={26} className="spin" /></div>
              <div className="install-title">正在安装 {selected?.display}</div>
              <div className="install-sub mono">{progressMessage || `${toolId}/runtimes/${selected?.display}`}</div>
              <ProgressBar value={progress} />
              <div className="install-percent mono">{progress < 0 ? '计算中' : `${progress}%`}</div>
            </div>
          )}

          {stage === 'done' && (
            <div className="install-done-view">
              <div className="done-mark"><Check size={22} strokeWidth={2.5} /></div>
              <div className="install-title">安装完成</div>
              <div className="install-sub">{tool?.displayName} {selected?.display} 已加入运行时目录</div>
              <div className="done-note mono">activate.ps1 已更新，可在终端或 IDE 中切换使用</div>
            </div>
          )}
        </div>

        <div className="wizard-footer">
          {stage === 'select' && (
            <>
              <Button variant="ghost" onClick={closeWizard}>取消</Button>
              <Button variant="primary" disabled={!selectedVersionId} onClick={() => void runInstall()}>
                <Download size={14} /> 开始安装
              </Button>
            </>
          )}
          {stage === 'installing' && <Button variant="ghost" disabled>安装中…</Button>}
          {stage === 'done' && <Button variant="primary" onClick={closeWizard}>完成</Button>}
        </div>
      </div>
    </div>
  )
}
