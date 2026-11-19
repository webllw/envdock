import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import type { VersionChannel } from '@renderer/types/domain'
import './ui.css'

type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

export function Button({
  variant = 'subtle',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {children}
    </button>
  )
}

interface CardProps {
  children: ReactNode
  className?: string
  accent?: string
  onClick?: () => void
}

export function Card({ children, className = '', accent, onClick }: CardProps) {
  const style = accent ? ({ '--card-accent': accent } as CSSProperties) : undefined
  if (onClick) {
    return (
      <button
        type="button"
        className={`card card-clickable ${className}`}
        style={style}
        onClick={onClick}
      >
        {children}
      </button>
    )
  }
  return (
    <div className={`card ${className}`} style={style}>
      {children}
    </div>
  )
}

export function StatusDot({ tone }: { tone: 'ok' | 'warning' | 'error' | 'idle' }) {
  return <span className={`status-dot dot-${tone}`} aria-hidden="true" />
}

const channelLabel: Record<VersionChannel, string> = {
  stable: '稳定',
  lts: 'LTS',
  preview: '预览'
}

export function ChannelBadge({ channel }: { channel: VersionChannel }) {
  return <span className={`channel-badge channel-${channel}`}>{channelLabel[channel]}</span>
}

export type TagTone = 'neutral' | 'accent' | 'ok' | 'warning' | 'error'

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: TagTone }) {
  return <span className={`tag tag-${tone}`}>{children}</span>
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={value}>
      <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

interface ToastProps {
  message: string
  tone: 'success' | 'info' | 'warning'
  onClose: () => void
}

export function Toast({ message, tone, onClose }: ToastProps) {
  const Icon = tone === 'success' ? Check : X
  return (
    <div className={`toast toast-${tone}`} role="status">
      <span className="toast-icon"><Icon size={14} strokeWidth={2.5} /></span>
      <span>{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label="关闭提示">
        <X size={13} />
      </button>
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty-state">
      <div className="empty-mark" />
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
    </div>
  )
}
