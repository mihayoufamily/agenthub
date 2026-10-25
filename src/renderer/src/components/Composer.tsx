// 输入组件：自适应增高、IME 安全、附件、Skill 引用、发送状态
import React, { useEffect, useRef } from 'react'
import type { Attachment, Skill } from '@shared/types'
import { Icon } from './Icons'
import { IconButton } from './primitives'
import { fmtSize } from '../lib/utils'
import { bridge } from '../lib/ipc'
import { useUi } from '../stores/ui'
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
  maxHeightVh = 40,
  pickedSkills = [],
  onOpenSkills,
  onSkillButtonRef,
  onRemoveSkill
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
  /** 已引用的 Skill（发送时注入对话） */
  pickedSkills?: Skill[]
  onOpenSkills?: () => void
  onSkillButtonRef?: React.RefObject<HTMLButtonElement>
  onRemoveSkill?: (id: string) => void
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)

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
    // IME 防线只有这一道：native.isComposing / keyCode 229（不再另设 composingRef——
    // 那个 ref 只写不读，会让人误以为还有第二道闸）
    if (native.isComposing || native.keyCode === 229) return
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
    const files = await bridge.dialogs.pickFiles()
    if (!files.length) return
    // 文本附件带内容、图片附件带 data URL（真实调用才发送）；其余只记录引用
    const next: Attachment[] = files.map((f) => ({
      id: uid('att'),
      name: f.name,
      path: f.path,
      size: f.size,
      kind: f.image ? 'image' : f.content !== undefined ? 'text' : 'binary',
      status: f.error ? 'error' : 'ok',
      ...(f.content !== undefined ? { content: f.content } : {}),
      ...(f.dataUrl !== undefined ? { dataUrl: f.dataUrl } : {})
    }))
    const bad = next.filter((a) => a.status === 'error')
    if (bad.length) useUi.getState().toast(`${bad.map((a) => a.name).join('、')} 未能添加（超出大小上限或读取失败）`, 'warn')
    onAttachmentsChange([...attachments, ...next.filter((a) => a.status === 'ok')])
  }

  const removeAttachment = (id: string) => {
    onAttachmentsChange?.(attachments.filter((a) => a.id !== id))
  }

  return (
    <div className="composer">
      {(attachments.length > 0 || pickedSkills.length > 0) && (
        <div className="attach-row">
          {pickedSkills.map((sk) => (
            <span key={`sk-${sk.id}`} className="attach-chip skill-chip" title={`Skill：${sk.desc || sk.name}\n引用后随本条消息注入对话`}>
              <Icon name="file" size={12} />
              <span className="name">{sk.name}</span>
              <button className="rm" onClick={() => onRemoveSkill?.(sk.id)} aria-label={`移除 Skill ${sk.name}`}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <span key={a.id} className={cls('attach-chip', a.kind === 'image' && 'image', a.status === 'error' && 'error')} title={a.status === 'error' ? `${a.path}\n读取失败或超过大小上限，内容不会发送` : a.kind === 'image' ? `${a.path}\n图片会随本次请求发送给支持视觉的模型；CLI 只拿到文件路径` : a.path}>
              {a.kind === 'image' && a.dataUrl
                ? <img className="att-thumb" src={a.dataUrl} alt="" />
                : <Icon name="file" size={12} />}
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
        aria-label="输入框"
      />
      <div className="composer-bar">
        {onAttachmentsChange && (
          <IconButton title="添加附件（引用文件）" onClick={pickFiles} disabled={disabled}>
            <Icon name="attach" size={16} />
          </IconButton>
        )}
        {onOpenSkills && (
          <button
            ref={onSkillButtonRef}
            className="icon-btn"
            title="引用 Skill（提示包，随消息注入）"
            onClick={onOpenSkills}
            disabled={disabled}
            aria-label="引用 Skill"
          >
            <Icon name="file" size={16} />
          </button>
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
