import type { ReactNode } from 'react'
import {
  LayoutDashboard,
  Boxes,
  Settings as SettingsIcon,
  HardDrive,
  ChevronDown,
  Sun,
  Moon
} from 'lucide-react'
import { useAppStore, type PageKey } from '@renderer/store/useAppStore'
import { StatusDot } from '@renderer/components/ui/ui'
import './app-shell.css'

const navItems: { key: PageKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'dashboard', label: '概览', icon: LayoutDashboard },
  { key: 'runtimes', label: '运行时', icon: Boxes },
  { key: 'settings', label: '设置', icon: SettingsIcon }
]

const pageMeta: Record<PageKey, { title: string; subtitle: string }> = {
  dashboard: { title: '环境概览', subtitle: '本机开发环境的状态与健康状况' },
  runtimes: { title: '运行时管理', subtitle: '安装、切换与卸载各语言版本' },
  settings: { title: '设置', subtitle: '安装目录、系统变更与迁移' }
}

export function AppShell({ children }: { children: ReactNode }) {
  const { page, theme, toggleTheme, setPage, manifest, update, backendError } = useAppStore()
  const meta = pageMeta[page]

  return (
    <div className="app-shell">
      <div className="body-row">
        <nav className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark">E</div>
            <span className="brand-name">EnvDock</span>
            <span className="brand-version">0.1.0</span>
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
              aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
            >
              {theme === 'light' ? <Moon size={15} strokeWidth={1.8} /> : <Sun size={15} strokeWidth={1.8} />}
            </button>
          </div>

          <div className="nav-group">
            {navItems.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                className={`nav-item ${page === key ? 'nav-active' : ''}`}
                onClick={() => setPage(key)}
              >
                <Icon size={16} strokeWidth={1.8} />
                <span>{label}</span>
                {page === key && <span className="nav-indicator" />}
              </button>
            ))}
          </div>

          <div className="sidebar-footer">
            <button type="button" className="root-chip" onClick={() => setPage('settings')}>
              <HardDrive size={14} strokeWidth={1.8} />
              <div className="root-chip-text">
                <span className="root-chip-label">安装目录</span>
                <span className="root-chip-path mono">{manifest.installRoot || '尚未读取'}</span>
              </div>
              <ChevronDown size={13} className="root-chip-chevron" />
            </button>
            <div className="status-line">
              <StatusDot tone={backendError ? 'error' : 'ok'} />
              <span>{backendError ? '后端不可用' : '运行正常'}</span>
              <span className="status-spacer" />
              <span className="mono">v{update.currentVersion || '—'}</span>
            </div>
          </div>
        </nav>

        <main className="main-area">
          <div className="page-header">
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <div className="page-content">{children}</div>
        </main>
      </div>
    </div>
  )
}
