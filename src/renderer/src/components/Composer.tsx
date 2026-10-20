// 输入组件：自适应增高、IME 安全、附件、发送状态
import React, { useEffect, useRef } from 'react'
import type { Attachment } from '@shared/types'
import { Icon } from './Icons'
import { IconButton } from './primitives'
import { isSendEnter, fmtSize } from '../lib/utils'
import { bridge } from '../lib/ipc'
import { uid, cls } from '../lib/utils'

export function Composer({
  value,
  onChange,
  onSend,
  placeholder = '描述你想构建的内容……',
  attachments = [],
  onAttachmentsChange,
  enterToSend = true,
  disabled = false,
  autoFocusOnMount = false,
  hint,
  maxHeightVh = 40
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  placeholder?: string
  attachments?: Attachment[]
  onAttachmentsChange?: (a: Attachment[]) => void
  enterToSend?: boolean
  disabled?: boolean
  autoFocusOnMount?: boolean
  hint?: React.ReactNode
  maxHeightVh?: number
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = window.innerHeight * (maxHeightVh / 100)
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, maxHeightVh])

  useEffect(() => {
    if (autoFocusOnMount) taRef.current?.focus()
  }, [autoFocusOnMount])

  const canSend = value.trim().length > 0 && !disabled

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent
    if (native.isComposing || native.keyCode === 229) return // IME 组合中：绝不误发送
    if (e.key === 'Enter' && !e.shiftKey) {
      if (enterToSend) {
        e.preventDefault()
        if (canSend) onSend()
      }
      // enterToSend=false 时 Enter 保持默认换行，Ctrl+Enter 发送
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (canSend) onSend()
    }
  }

  const pickFiles = async () => {
    if (!onAttachmentsChange) return
    const paths = await bridge.dialogs.pickFiles()
    if (!paths.length) return
    // 只登记本地文件引用；演示模式与未接入工具的 Agent 不会读取内容
    const next: Attachment[] = paths.map((p) => ({
      id: uid('att'),
      name: p.split(/[\\/]/).pop() ?? p,
      path: p,
      size: 0,
      status: 'ok'
    }))
    onAttachmentsChange([...attachments, ...next])
  }

  const removeAttachment = (id: string) => {
    onAttachmentsChange?.(attachments.filter((a) => a.id !== id))
  }

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <span key={a.id} className={cls('attach-chip', a.status === 'error' && 'error')} title={a.path}>
              <Icon name="file" size={12} />
              <span className="name">{a.name}</span>
              {a.size > 0 && <span>{fmtSize(a.size)}</span>}
              <button className="rm" onClick={() => removeAttachment(a.id)} aria-label={`移除附件 ${a.name}`}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => (composingRef.current = false)}
        aria-label="输入框"
      />
      <div className="composer-bar">
        {onAttachmentsChange && (
          <IconButton title="添加附件" onClick={pickFiles} disabled={disabled}>
            <Icon name="attach" size={16} />
          </IconButton>
        )}
        <span className="composer-hint">
          {hint ?? (enterToSend ? <span>Enter 发送 · Shift+Enter 换行</span> : <span>Ctrl+Enter 发送</span>)}
        </span>
        <button
          className={cls('btn', 'btn-primary')}
          style={{ height: 30, padding: '0 12px', fontSize: 12.5, gap: 4 }}
          disabled={!canSend}
          onClick={onSend}
          aria-label="发送"
        >
          <Icon name="send" size={13} />
          发送
        </button>
      </div>
    </div>
  )
}
