import { useEffect } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/ui'
import './confirm-dialog.css'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 应用内确认弹窗。原生 window.confirm 在无边框窗口下不弹出或抢不到焦点，
 * 仍需用户二次确认的操作统一走这里。 */
export function ConfirmDialog({
  open, title, description, confirmLabel, tone = 'danger', busy = false, onConfirm, onCancel
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="confirm-modal-head">
          <span className={`confirm-icon confirm-icon-${tone}`}><AlertTriangle size={18} strokeWidth={1.9} /></span>
          <button type="button" className="confirm-modal-x" onClick={onCancel} disabled={busy} aria-label="取消">
            <X size={16} />
          </button>
        </div>
        <h2 id="confirm-title">{title}</h2>
        <p className="confirm-desc">{description}</p>
        <div className="confirm-modal-foot">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>取消</Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
