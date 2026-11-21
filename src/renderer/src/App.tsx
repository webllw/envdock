import { useEffect } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { AppShell } from '@renderer/components/layout/AppShell'
import { InstallWizard } from '@renderer/components/wizard/InstallWizard'
import { ClosePrompt } from '@renderer/components/dialog/ClosePrompt'
import { Toast } from '@renderer/components/ui/ui'
import { Dashboard } from '@renderer/pages/Dashboard'
import { Runtimes } from '@renderer/pages/Runtimes'
import { Settings } from '@renderer/pages/Settings'
import { handleProgressEvent, handleUpdateProgress, useAppStore } from '@renderer/store/useAppStore'
import { api } from '@renderer/data/host'

const pages = {
  dashboard: Dashboard,
  runtimes: Runtimes,
  settings: Settings
}

export default function App() {
  const { page, theme, ready, backendError, toast, clearToast, initialize, loadUpdateState, checkUpdate } = useAppStore()
  const PageComponent = pages[page]

  useEffect(() => {
    void initialize().then(() => {
      void loadUpdateState().then(() => {
        if (useAppStore.getState().config.update.autoCheck) void checkUpdate(true)
      })
    })
    const offProgress = api.onProgress(handleProgressEvent)
    const offUpdate = api.onUpdateProgress(handleUpdateProgress)
    return () => {
      offProgress()
      offUpdate()
    }
  }, [initialize, loadUpdateState, checkUpdate])

  // 托盘切换版本走引擎而非界面 IPC，靠主进程广播即时同步；焦点事件作为兜底
  useEffect(() => {
    const sync = () => {
      if (useAppStore.getState().ready) void useAppStore.getState().refreshTools()
    }
    const offStateChanged = api.onStateChanged(sync)
    window.addEventListener('focus', sync)
    return () => {
      offStateChanged()
      window.removeEventListener('focus', sync)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(clearToast, 2800)
    return () => window.clearTimeout(timer)
  }, [toast, clearToast])

  return (
    <AppShell>
      {backendError && (
        <div className="backend-error">
          <AlertCircle size={14} /> 后端接口不可用：{backendError}
        </div>
      )}
      {ready ? <PageComponent /> : (
        <div className="app-loading">
          <Loader2 size={22} className="spin" />
          <span>正在读取环境状态…</span>
        </div>
      )}
      <InstallWizard />
      <ClosePrompt />
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={clearToast} />}
    </AppShell>
  )
}
