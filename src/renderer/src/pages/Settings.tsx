import { useEffect, useState } from 'react'
import { HardDrive, ShieldCheck, MoveRight, Link2, RotateCcw, Info, RefreshCw, Download, ArrowUpCircle, FolderOpen, Globe } from 'lucide-react'
import { useAppStore } from '@renderer/store/useAppStore'
import { Button, Card, StatusDot, Tag, ProgressBar } from '@renderer/components/ui/ui'
import './settings.css'

const kindLabel = { path: 'PATH 项', registry: '注册表', shortcut: '快捷方式' } as const

/** 迁移目标必须是 Windows 绝对路径，相对路径会被解析到不可预期的位置 */
function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export function Settings() {
  const {
    manifest, config, update, migrate, chooseDirectory, setPathIntegration, uninstallAll, showToast,
    checkUpdate, applyUpdate, rollbackUpdate, discardOldVersion, setUpdSource, setConfig, checkProxy
  } = useAppStore()
  const [migrating, setMigrating] = useState(false)
  const [target, setTarget] = useState('')
  const [sourceDraft, setSourceDraft] = useState(config.update.sourceUrl)
  const [checking, setChecking] = useState(false)
  const [proxyEnabled, setProxyEnabled] = useState(config.proxy.enabled)
  const [proxyUrl, setProxyUrl] = useState(config.proxy.url)
  const [testingProxy, setTestingProxy] = useState(false)

  // 引导完成后 config 由后端回填，同步草稿，避免界面停留在初始占位值
  useEffect(() => {
    setProxyEnabled(config.proxy.enabled)
    setProxyUrl(config.proxy.url)
  }, [config.proxy.enabled, config.proxy.url])

  const proxyDirty = proxyEnabled !== config.proxy.enabled || proxyUrl !== config.proxy.url

  const saveProxy = async () => {
    const url = proxyUrl.trim()
    if (proxyEnabled && !/^https?:\/\//i.test(url)) {
      showToast('代理地址需以 http:// 或 https:// 开头', 'warning')
      return
    }
    await setConfig({ proxy: { enabled: proxyEnabled, url } })
    showToast(proxyEnabled ? '代理已启用，后续下载将走代理' : '代理已关闭，恢复直连', 'success')
  }

  const runProxyTest = async () => {
    const url = proxyUrl.trim()
    if (proxyEnabled && !/^https?:\/\//i.test(url)) {
      showToast('代理地址需以 http:// 或 https:// 开头', 'warning')
      return
    }
    setTestingProxy(true)
    try {
      const result = await checkProxy(url, proxyEnabled)
      showToast(
        result.ok ? `${result.message}（${result.latencyMs} ms）` : result.message,
        result.ok ? 'success' : 'warning'
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : '测试失败', 'warning')
    } finally {
      setTestingProxy(false)
    }
  }

  const runCheck = async () => {
    setChecking(true)
    try {
      await checkUpdate()
    } finally {
      setChecking(false)
    }
  }

  const busy = update.phase === 'downloading' || update.phase === 'verifying' ||
    update.phase === 'extracting' || update.phase === 'restarting'

  const runMigration = async () => {
    const value = target.trim()
    if (!value || !isAbsolutePath(value)) {
      showToast('请选择或填写一个完整的磁盘目录路径', 'warning')
      return
    }
    if (value.replace(/[\\/]+$/, '').toLowerCase() === manifest.installRoot.replace(/[\\/]+$/, '').toLowerCase()) {
      showToast('目标目录与当前安装目录相同', 'warning')
      return
    }
    setMigrating(true)
    try {
      await migrate(value)
    } finally {
      setMigrating(false)
    }
  }

  const handleChooseTarget = async () => {
    const picked = await chooseDirectory('选择迁移目标目录')
    if (picked) setTarget(picked)
  }

  const handleUninstall = () => {
    if (!window.confirm('将回滚全部系统变更并删除环境目录，此操作不可撤销。确认继续？')) return
    void uninstallAll()
  }

  return (
    <div className="settings">
      <section className="settings-section">
        <div className="settings-section-head">
          <ArrowUpCircle size={16} className="section-icon" />
          <div>
            <h2>应用更新</h2>
            <p>更新只替换 app/ 目录，运行时、版本与配置保持不变</p>
          </div>
        </div>
        <Card className="settings-card">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">当前版本</div>
              <div className="setting-hint">{update.message || '应用内建版本'}</div>
            </div>
            <div className="setting-control">
              <Tag tone="accent">v{update.currentVersion || '—'}</Tag>
              <Button variant="ghost" size="sm" onClick={() => void runCheck()} disabled={checking || busy}>
                <RefreshCw size={13} className={checking ? 'spin' : ''} /> {checking ? '检查中' : '检查更新'}
              </Button>
            </div>
          </div>

          {update.available && (
            <div className="setting-row">
              <div className="setting-label">
                <div className="setting-title">新版本 v{update.available.version}</div>
                <div className="setting-hint">{update.available.notes || `发布于 ${update.available.releasedAt.slice(0, 10) || '未注明'}`}</div>
              </div>
              <div className="setting-control">
                <Button variant="primary" size="sm" onClick={() => void applyUpdate()} disabled={busy}>
                  <Download size={13} /> {update.readyToApply ? '重启并升级' : '下载并升级'}
                </Button>
              </div>
            </div>
          )}

          {busy && (
            <div className="migration-progress">
              <ProgressBar value={update.percent >= 0 ? update.percent : 0} />
              <span>{update.message}</span>
            </div>
          )}

          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">更新源</div>
              <div className="setting-hint">填写存放 update.json 与升级包的对象存储目录地址</div>
            </div>
            <div className="setting-control">
              <input
                className="path-input mono"
                value={sourceDraft}
                onChange={(e) => setSourceDraft(e.target.value)}
                placeholder="https://oss.example.com/envdock"
                aria-label="更新源地址"
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={sourceDraft === config.update.sourceUrl}
                onClick={() => void setUpdSource(sourceDraft.trim(), config.update.autoCheck)}
              >
                保存
              </Button>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">启动时自动检查</div>
              <div className="setting-hint">启动应用时静默检查是否有新版本</div>
            </div>
            <div className="setting-control">
              <button
                type="button"
                role="switch"
                aria-checked={config.update.autoCheck}
                className={`switch ${config.update.autoCheck ? 'switch-on' : ''}`}
                onClick={() => void setUpdSource(config.update.sourceUrl, !config.update.autoCheck)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          </div>

          {update.canRollback && (
            <div className="setting-row">
              <div className="setting-label">
                <div className="setting-title">保留的上一版本</div>
                <div className="setting-hint">app.old/ 仍存在，可回滚或清理以释放空间</div>
              </div>
              <div className="setting-control">
                <Button variant="ghost" size="sm" onClick={() => void rollbackUpdate()}>
                  <RotateCcw size={13} /> 回滚
                </Button>
                <Button variant="danger" size="sm" onClick={() => void discardOldVersion()}>
                  清理
                </Button>
              </div>
            </div>
          )}
        </Card>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <Globe size={16} className="section-icon" />
          <div>
            <h2>网络代理</h2>
            <p>用于版本列表与安装包下载，关闭时直连官方源</p>
          </div>
        </div>
        <Card className="settings-card">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">启用代理</div>
              <div className="setting-hint">HTTP 代理，例如 http://127.0.0.1:7890</div>
            </div>
            <div className="setting-control">
              <button
                type="button"
                role="switch"
                aria-checked={proxyEnabled}
                className={`switch ${proxyEnabled ? 'switch-on' : ''}`}
                onClick={() => setProxyEnabled(!proxyEnabled)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">代理地址</div>
              <div className="setting-hint">{proxyDirty ? '有未保存的更改' : '保存后对后续所有下载生效'}</div>
            </div>
            <div className="setting-control">
              <input
                className="path-input mono"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://127.0.0.1:7890"
                aria-label="代理地址"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void runProxyTest()}
                disabled={testingProxy || !proxyUrl.trim()}
              >
                <RefreshCw size={13} className={testingProxy ? 'spin' : ''} /> {testingProxy ? '测试中' : '测试'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void saveProxy()}
                disabled={!proxyDirty || testingProxy}
              >
                保存
              </Button>
            </div>
          </div>
        </Card>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <HardDrive size={16} className="section-icon" />
          <div>
            <h2>安装目录</h2>
            <p>所有运行时、缓存、配置与状态都集中在此目录</p>
          </div>
        </div>
        <Card className="settings-card">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">当前位置</div>
              <div className="setting-hint">迁移后目录内所有版本与配置原样保留</div>
            </div>
            <div className="setting-control">
              <span className="path-display mono">{manifest.installRoot || '正在读取…'}</span>
              <Tag>可写</Tag>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">迁移目录</div>
              <div className="setting-hint">按清单撤销旧路径引用，移动后在新位置重建</div>
            </div>
            <div className="setting-control">
              <input
                className="path-input mono"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="选择或输入目标目录"
                aria-label="迁移目标目录"
              />
              <Button variant="ghost" size="sm" onClick={() => void handleChooseTarget()} disabled={migrating} title="选择目录">
                <FolderOpen size={14} />
              </Button>
              <Button variant="primary" size="sm" onClick={() => void runMigration()} disabled={migrating || !target.trim()}>
                <MoveRight size={14} /> {migrating ? '迁移中' : '迁移'}
              </Button>
            </div>
          </div>
          {migrating && (
            <div className="migration-progress">
              <span>正在迁移环境目录并重写 {manifest.mutations.length} 项路径引用，请稍候…</span>
            </div>
          )}
        </Card>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <Link2 size={16} className="section-icon" />
          <div>
            <h2>环境集成</h2>
            <p>每项变更都记录在安装清单中，卸载时精确回滚</p>
          </div>
        </div>
        <Card className="settings-card">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">加入用户 PATH</div>
              <div className="setting-hint">写入 HKCU\\Environment\\Path，卸载时恢复原值</div>
            </div>
            <div className="setting-control">
              <button
                type="button"
                role="switch"
                aria-checked={config.pathIntegration}
                className={`switch ${config.pathIntegration ? 'switch-on' : ''}`}
                onClick={() => void setPathIntegration(!config.pathIntegration)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-title">激活脚本</div>
              <div className="setting-hint">进程内切换版本，不影响系统环境</div>
            </div>
            <div className="setting-control">
              <span className="script-path mono">scripts/activate.ps1 · scripts/activate.bat</span>
            </div>
          </div>
        </Card>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <ShieldCheck size={16} className="section-icon" />
          <div>
            <h2>系统变更清单</h2>
            <p>记录工具对环境目录之外做过的全部改动</p>
          </div>
        </div>
        <Card className="settings-card manifest-card">
          <div className="manifest-head">
            <span>类型</span><span>位置</span><span>写入值</span><span>可回滚</span>
          </div>
          {manifest.mutations.map((m) => (
            <div className="manifest-row" key={m.id}>
              <span><Tag>{kindLabel[m.kind]}</Tag></span>
              <span className="mono manifest-target">{m.target}</span>
              <span className="mono manifest-value">{m.currentValue}</span>
              <span><StatusDot tone="ok" /></span>
            </div>
          ))}
          <div className="manifest-footer">
            <Info size={13} />
            <span>卸载时按清单逐项恢复原值，再删除安装目录</span>
            <Button variant="danger" size="sm" className="uninstall-btn" onClick={handleUninstall}>
              <RotateCcw size={13} /> 卸载
            </Button>
          </div>
        </Card>
      </section>
    </div>
  )
}
