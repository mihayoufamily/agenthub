// 基础组件：按钮（全状态）、图标按钮、开关、状态点、徽章、头像、空状态
import React, { useState } from 'react'
import { cls } from '../lib/utils'
import { Icon } from './Icons'

export function Button({
  variant = 'secondary',
  loading = false,
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  loading?: boolean
}) {
  return (
    <button className={cls('btn', `btn-${variant}`, loading && 'loading', className)} {...rest}>
      {children}
    </button>
  )
}

export function IconButton({
  title,
  danger,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      className={cls('icon-btn', danger && 'danger', className)}
      title={title}
      aria-label={title}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch"
      data-on={on}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!on) }}
    />
  )
}

export function StatusDot({ status }: { status: string }) {
  const known = ['available', 'disconnected', 'running', 'awaiting', 'failed']
  const clsName = known.includes(status) ? status : 'disconnected'
  return <span className={cls('status-dot', clsName)} title={statusText(status)} />
}

export function statusText(s: string): string {
  switch (s) {
    case 'available': return '可用'
    case 'running': return '执行中'
    case 'awaiting': return '待确认'
    case 'failed': return '失败'
    default: return '未连接'
  }
}

export function Badge({ tone = 'default', children }: { tone?: 'default' | 'ok' | 'warn' | 'danger' | 'info'; children: React.ReactNode }) {
  return <span className={cls('badge', tone !== 'default' && tone)}>{children}</span>
}

export function Avatar({ name, color, size = 30 }: { name: string; color: string; size?: number }) {
  const ch = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <span className="avatar" style={{ background: color, width: size, height: size }}>
      {ch}
    </span>
  )
}

export function EmptyState({
  title,
  desc,
  action
}: {
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="title">{title}</div>
      {desc && <div className="desc word-break">{desc}</div>}
      {action}
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />
}

/** 复制按钮（带短暂成功反馈） */export function CopyButton({ getText, label }: { getText: () => string; label?: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      className={cls('btn', ok ? 'ok' : 'secondary')}
      style={{ height: 28, padding: '0 10px', fontSize: 12 }}
      onClick={() => {
        void navigator.clipboard.writeText(getText()).then(() => {
          setOk(true)
          setTimeout(() => setOk(false), 1300)
        })
      }}
    >
      <Icon name="copy" size={13} />
      {ok ? '已复制' : label || '复制'}
    </button>
  )
}
