// 模态框：焦点捕获、Esc 关闭、关闭后焦点回触发元素、关键操作不受误点遮罩影响
import React, { useEffect, useRef } from 'react'
import { cls } from '../lib/utils'
import { IconButton } from './primitives'
import { Icon } from './Icons'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  warning = false,
  critical = false,
  hideClose = false,
  width,
  children,
  footer
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  /** 红色警告样式（模式切换/删除等） */
  warning?: boolean
  /** 关键操作：遮罩点击不关闭（仍可 Esc 或显式按钮） */
  critical?: boolean
  /** 隐藏右上角关闭按钮（关键警告弹窗要求默认焦点落在安全项上） */
  hideClose?: boolean
  width?: number
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement
    const box = boxRef.current
    if (!box) return
    const first = box.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => !(el as HTMLButtonElement).disabled
        )
        if (items.length === 0) return
        const idx = items.indexOf(document.activeElement as HTMLElement)
        e.preventDefault()
        const next = e.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : idx === items.length - 1 ? 0 : idx + 1
        items[next].focus()
      }
    }
    box.addEventListener('keydown', onKey)
    return () => {
      box.removeEventListener('keydown', onKey)
      restoreRef.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !critical) onClose()
      }}
    >
      <div className={cls('modal', warning && 'warning')} style={width ? { width } : undefined} ref={boxRef} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          {warning && (
            <span className="warn-icon" style={{ color: 'var(--danger-strong)', display: 'flex' }}>
              <Icon name="warn" size={22} />
            </span>
          )}
          {title}
          {!hideClose && (
            <IconButton title="关闭" onClick={onClose}>
              <Icon name="close" size={15} />
            </IconButton>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
