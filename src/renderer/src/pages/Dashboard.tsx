import { Layers, HardDrive, ShieldCheck, ArrowRight, AlertCircle } from 'lucide-react'
import { useAppStore } from '@renderer/store/useAppStore'
import { Card, StatusDot, Button } from '@renderer/components/ui/ui'
import './dashboard.css'

function formatGB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function Dashboard() {
  const { tools, health, manifest, setPage } = useAppStore()

  const installedCount = tools.reduce((sum, tool) => sum + tool.installed.length, 0)
  const totalBytes = tools.reduce(
    (sum, tool) => sum + tool.installed.reduce((s, v) => s + v.sizeBytes, 0),
    0
  )
  const warningCount = health.filter((item) => item.status !== 'ok').length

  const stats = [
    { label: '已装版本', value: String(installedCount), suffix: '个', icon: Layers, tone: 'accent' },
    { label: '运行时占用', value: formatGB(totalBytes).split(' ')[0], suffix: 'GB', icon: HardDrive, tone: 'plain' },
    { label: '系统变更', value: String(manifest.mutations.length), suffix: '项可回滚', icon: ShieldCheck, tone: 'plain' }
  ]

  return (
    <div className="dashboard">
      <section className="stat-grid">
        {stats.map(({ label, value, suffix, icon: Icon, tone }) => (
          <Card key={label} className="stat-card">
            <div className="stat-top">
              <span className="stat-label">{label}</span>
              <Icon size={16} className={tone === 'accent' ? 'stat-icon-accent' : 'stat-icon'} strokeWidth={1.7} />
            </div>
            <div className="stat-value">
              {value}<span className="stat-suffix">{suffix}</span>
            </div>
          </Card>
        ))}
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>运行时状态</h2>
          <Button variant="ghost" size="sm" onClick={() => setPage('runtimes')}>
            管理 <ArrowRight size={13} />
          </Button>
        </div>
        <div className="tool-grid">
          {tools.map((tool) => (
            <Card key={tool.id} accent={tool.accent} onClick={() => setPage('runtimes')} className="tool-mini-card">
              <div className="tool-mini-head">
                <span className="tool-mini-name">{tool.displayName}</span>
                <StatusDot tone={tool.activeVersionId ? 'ok' : 'idle'} />
              </div>
              <div className="tool-mini-version mono">
                {tool.activeVersionId ? tool.installed.find(v => v.versionId === tool.activeVersionId)?.display : '未安装'}
              </div>
              <div className="tool-mini-meta">
                <span>{tool.installed.length} 个版本</span>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>环境体检</h2>
          <span className="section-note">
            {health.length === 0
              ? '等待读取数据'
              : warningCount > 0
                ? `${warningCount} 项需要关注`
                : '全部正常'}
          </span>
        </div>
        <Card className="health-card">
          {health.length === 0 && <div className="health-empty">暂无体检结果</div>}
          {health.map((item, index) => (
            <div className="health-row" key={item.id}>
              <StatusDot tone={item.status} />
              <div className="health-text">
                <div className="health-title">{item.title}</div>
                <div className="health-detail">{item.detail}</div>
              </div>
              {item.status !== 'ok' && <AlertCircle size={14} className="health-warn-icon" />}
              {index < health.length - 1 && <div className="health-divider" />}
            </div>
          ))}
        </Card>
      </section>
    </div>
  )
}
