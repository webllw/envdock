import { useEffect, useState } from 'react'
import { Minus, LogOut, X } from 'lucide-react'
import { useAppStore } from '@renderer/store/useAppStore'
import { api } from '@renderer/data/host'
import { Button } from '@renderer/components/ui/ui'
import './close-prompt.css'

type Choice = 'tray' | 'quit'

export function ClosePrompt() {
  const { setConfig } = useAppStore()
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    const off = api.onCloseRequest(() => {
      setRemember(false)
      setOpen(true)
    })
    return off
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const choose = async (action: Choice): Promise<void> => {
    if (remember) await setConfig({ closeBehavior: action })
    setOpen(false)
    if (action === 'tray') {
      if (api.hasHost) void api.windowHide()
    } else {
      if (api.hasHost) void api.windowQuit()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="close-modal" role="dialog" aria-modal="true" aria-labelledby="close-prompt-title">
        <div className="close-modal-head">
          <div>
            <div className="close-kicker">关闭 EnvDock</div>
            <h2 id="close-prompt-title">希望如何关闭窗口？</h2>
          </div>
          <button type="button" className="close-modal-x" onClick={() => setOpen(false)} aria-label="取消">
            <X size={16} />
          </button>
        </div>

        <div className="close-options">
          <button type="button" className="close-option" onClick={() => void choose('tray')}>
            <span className="close-option-icon"><Minus size={18} strokeWidth={1.8} /></span>
            <span className="close-option-text">
              <span className="close-option-title">最小化到托盘</span>
              <span className="close-option-desc">窗口隐藏，程序继续运行，可随时从托盘恢复</span>
            </span>
          </button>
          <button type="button" className="close-option close-option-quit" onClick={() => void choose('quit')}>
            <span className="close-option-icon"><LogOut size={17} strokeWidth={1.8} /></span>
            <span className="close-option-text">
              <span className="close-option-title">直接退出</span>
              <span className="close-option-desc">结束程序运行，下次需重新启动</span>
            </span>
          </button>
        </div>

        <label className="close-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>记住此选择，以后关闭时不再询问</span>
        </label>

        <div className="close-modal-foot">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>取消</Button>
        </div>
      </div>
    </div>
  )
}
