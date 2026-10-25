// 模态框：焦点捕获、Esc 关闭、关闭后焦点回触发元素、关键操作不受误点遮罩影响
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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
  // onClose 不能进 effect 依赖：调用方几乎全是内联箭头函数（每次父组件渲染都是新引用），
  // 进依赖后 effect 每次渲染都重跑——cleanup 先把焦点拽回触发元素、再 focus 弹窗首元素，
  // 流式期间父组件每个 delta 重渲染一次，弹窗里就打不了字。改走 ref，依赖只剩 [open]。
  // 渲染期间同步写 ref 是 React 官方认可的 escape hatch。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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
        onCloseRef.current()
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
  }, [open])

  if (!open) return null
  // 必须走 portal 挂到 body：position:fixed 的"视口定位"会被带 transform 的祖先劫持成
  // 相对那个祖先定位——.sidebar 的入场动画 sidebar-in 带 fill-mode:both，动画结束后
  // transform 效果仍算"在生效"，aside 从此永久是 fixed 后代的包含块。真实事故：
  // 技能中心弹窗挂进侧栏后被塞进 310px 宽的侧栏里。portal 之后弹窗与挂载点无关，
  // 将来谁再从带动画的容器里开 Modal 也不会复发。
  return createPortal(
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
    </div>,
    document.body
  )
}
