// 输入组件：自适应增高、IME 安全、附件、Skill 引用、@ 文件引用、发送状态
import React, { useEffect, useRef, useState } from 'react'
import type { Attachment, Skill } from '@shared/types'
import { Icon } from './Icons'
import { IconButton } from './primitives'
import { fmtSize } from '../lib/utils'
import { bridge, fileRef } from '../lib/ipc'
import type { DirEntry } from '../lib/ipc'
import { useUi } from '../stores/ui'
import { uid, cls } from '../lib/utils'

/** 把 @ 后的片段按 '/' 拆成"已定向的子路径 + 正在打的文件名过滤词"：
 *  'src/ut' → { subPath: 'src/', filter: 'ut' }；'readme' → { subPath: '', filter: 'readme' }。
 *  子路径直接作为 listDir 的 rel 参数（目录导航），过滤词在返回的 entries 上做名称包含匹配，不打接口。 */
function splitFragment(frag: string) {
  const i = frag.lastIndexOf('/')
  return i < 0 ? { subPath: '', filter: frag } : { subPath: frag.slice(0, i + 1), filter: frag.slice(i + 1) }
}

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
  onRemoveSkill,
  fileRefAgentId
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
  /** @ 文件引用的 Agent id：传入即启用（演示 Agent 也传，主进程侧会如实拒绝）。
   *  边界（如实）：@ 引用只对"主进程侧配置了文件目录的模型 Agent"真正可用；CLI Agent 与
   *  未配置目录的 Agent 会在浮层里看到主进程返回的说明文字（ok=false + message）。
   *  注入的是 64KB 以内的文本快照（上限由主进程 readTextFile 把守），不是实时链接——
   *  文件后续变化不会同步，这点在浮层文案里也有明示。 */
  fileRefAgentId?: string
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

  // ---- @ 文件引用浮层 ----
  // atRef 记录输入框里未闭合的 @ 片段：at = '@' 字符下标，end = 检测时的光标位置（片段终点），
  // path = '@' 后的片段文本。单一事实来源是输入框里的片段本身：点目录会把它改写进输入框。
  const [atRef, setAtRef] = useState<{ at: number; end: number; path: string } | null>(null)
  const [dirEntries, setDirEntries] = useState<DirEntry[] | null>(null)
  const [refErr, setRefErr] = useState<string | null>(null)
  const [refLoading, setRefLoading] = useState(false)
  const [refPos, setRefPos] = useState<{ left: number; bottom: number } | null>(null)
  const [hi, setHi] = useState(0)
  const refPopRef = useRef<HTMLDivElement>(null)
  // 用户按 Esc / 点外部明确关掉浮层后，记录被关掉的 '@' 位置：同一个 @ 不再自动弹出，
  // 新输入的 @（位置不同）仍会触发；片段被删掉（无匹配）时清零
  const refClosedAt = useRef<number | null>(null)
  // listDir 竞态序号：防抖窗口内片段连续变化时，过期响应直接丢弃，只认最后一次
  const listDirSeq = useRef(0)

  const refOpen = !!(atRef && fileRefAgentId)
  const fragParts = atRef ? splitFragment(atRef.path) : { subPath: '', filter: '' }
  const matched = (dirEntries ?? []).filter((en) => {
    const f = fragParts.filter.trim().toLowerCase()
    return !f || en.name.toLowerCase().includes(f)
  })
  const hiIdx = Math.min(hi, Math.max(0, matched.length - 1))

  // @ 片段检测：对光标前的文本匹配 /(^|\s)@([^\s@]*)$/ —— @ 前必须是行首或空白、
  // 片段本身不含空白和 @，即为"未闭合引用"
  const runDetect = (v: string, caret?: number) => {
    if (!fileRefAgentId) return
    const c = caret ?? taRef.current?.selectionStart ?? v.length
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, c))
    if (!m) {
      setAtRef(null)
      refClosedAt.current = null
      return
    }
    const at = m.index + m[1].length
    if (refClosedAt.current === at) return // 这个 @ 已被用户明确关掉，不反复弹出
    refClosedAt.current = null
    setAtRef({ at, end: c, path: m[2] })
  }

  // 浮层定位：fixed 在输入框上方（与 Skill 引用弹层同款思路，避免被 composer 溢出裁切）。
  // value 进依赖：输入触发自适应增高，输入框顶边移动后浮层要跟着重算
  useEffect(() => {
    if (!refOpen) {
      setRefPos(null)
      return
    }
    const el = taRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRefPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - 320)), bottom: window.innerHeight - r.top + 8 })
  }, [refOpen, value])

  // 打开/子路径变化时（防抖 150ms）列目录；过滤词只做本地匹配
  useEffect(() => {
    if (!refOpen || !fileRefAgentId || !atRef) return
    const { subPath } = splitFragment(atRef.path)
    const seq = ++listDirSeq.current
    setRefLoading(true)
    const t = window.setTimeout(() => {
      fileRef
        .listDir(fileRefAgentId, subPath)
        .then((r) => {
          if (seq !== listDirSeq.current) return
          setRefLoading(false)
          if (r.ok && r.entries) {
            setDirEntries(r.entries)
            setRefErr(null)
          } else {
            setDirEntries(null)
            setRefErr(r.message ?? '读取目录失败')
          }
        })
        .catch((err) => {
          if (seq !== listDirSeq.current) return
          setRefLoading(false)
          setDirEntries(null)
          setRefErr(err instanceof Error ? err.message : String(err))
        })
    }, 150)
    return () => window.clearTimeout(t)
  }, [refOpen, fileRefAgentId, atRef?.path])

  // 片段变化（进目录、改过滤词）后高亮回到第一项
  useEffect(() => {
    setHi(0)
  }, [atRef?.path])

  const closeRefPopup = () => {
    if (atRef) refClosedAt.current = atRef.at
    setAtRef(null)
  }

  // Esc / 点击浮层与输入框之外关闭（与 Skill 弹层同款；输入框算"内部"，点回去继续打字不关）
  useEffect(() => {
    if (!refOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRefPopup() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (refPopRef.current?.contains(t) || taRef.current?.contains(t)) return
      closeRefPopup()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
    // closeRefPopup 依赖本渲染的 atRef，片段每次变化重挂监听（代价是两个 add/remove）
  }, [refOpen, atRef])

  const chooseEntry = (en: DirEntry) => {
    if (!atRef || !fileRefAgentId) return
    const { subPath } = splitFragment(atRef.path)
    if (en.isDir) {
      // 进目录：把输入框里的 @ 片段改写成新路径（保持"输入框片段 = 导航位置"的单一事实来源），浮层保持打开
      const nextPath = subPath + en.name + '/'
      const v = value.slice(0, atRef.at) + '@' + nextPath + value.slice(atRef.end)
      const caret = atRef.at + 1 + nextPath.length
      onChange(v)
      runDetect(v, caret)
      requestAnimationFrame(() => taRef.current?.setSelectionRange(caret, caret))
      return
    }
    const rel = subPath + en.name
    fileRef
      .readTextFile(fileRefAgentId, rel)
      .then((r) => {
        if (!r.ok || r.content === undefined) {
          // 失败（超 64KB / 无目录 / CLI Agent / 未配置目录）如实显示在浮层里，不悄悄吞掉
          setRefErr(r.message ?? '读取文件失败')
          return
        }
        // 进现有文本附件流：与手动附件同列表、同发送处理（主进程对文本附件的既有逻辑自动生效）
        onAttachmentsChange?.([
          ...attachments,
          { id: uid('att'), name: rel, path: rel, size: en.size, kind: 'text', status: 'ok', content: r.content }
        ])
        // 删掉输入框里的 @… 片段（替换为空），浮层关闭
        const v = value.slice(0, atRef.at) + value.slice(atRef.end)
        const caret = atRef.at
        onChange(v)
        setAtRef(null)
        refClosedAt.current = null
        requestAnimationFrame(() => taRef.current?.setSelectionRange(caret, caret))
      })
      .catch((err) => setRefErr(err instanceof Error ? err.message : String(err)))
  }

  const canSend = value.trim().length > 0 && !disabled

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent
    // IME 防线只有这一道：native.isComposing / keyCode 229（不再另设 composingRef——
    // 那个 ref 只写不读，会让人误以为还有第二道闸）
    if (native.isComposing || native.keyCode === 229) return
    // @ 浮层打开时方向键/Enter/Escape 优先用于选择（与 Skill 弹层同款体验）
    if (refOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRefPopup()
        return
      }
      if (matched.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setHi((h) => Math.min(h + 1, matched.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setHi((h) => Math.max(h - 1, 0))
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          chooseEntry(matched[hiIdx])
          return
        }
      }
    }
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
        onChange={(e) => {
          onChange(e.target.value)
          // 组合中的 @ 不触发判定：拼音候选里的临时文本不是最终输入，等 compositionend 后再检测
          // （React 把 input 的 nativeEvent 类型标成宽泛的 Event，实际运行时是 InputEvent）
          if ((e.nativeEvent as InputEvent).isComposing) return
          runDetect(e.target.value)
        }}
        onCompositionEnd={(e) => runDetect(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        aria-label="输入框"
      />
      {/* @ 文件引用浮层：fixed 定位在输入框上方，样式沿用 Skill 引用弹层（ses-panel/skill-picker） */}
      {refOpen && refPos && (
        <div ref={refPopRef} className="ses-panel skill-picker" style={refPos} role="menu" aria-label="文件引用">
          <div className="ses-head">
            <span>引用文件{fragParts.subPath ? ` · ${fragParts.subPath}` : ''}（注入快照）</span>
          </div>
          <div className="ses-list" style={{ maxHeight: 240 }}>
            {refLoading && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-3)' }}>加载中…</div>}
            {!refLoading && refErr && (
              <div style={{ padding: 12, fontSize: 12.5, color: 'var(--danger)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{refErr}</div>
            )}
            {!refLoading && !refErr && matched.length === 0 && (
              <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-3)' }}>没有匹配的文件或目录</div>
            )}
            {matched.map((en, i) => (
              <div
                key={`${en.name}-${i}`}
                className={`ses-item ${i === hiIdx ? 'active' : ''}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => chooseEntry(en)}
              >
                <div className="ses-meta">
                  <div className="ses-title">
                    <Icon name={en.isDir ? 'folder' : 'file'} size={12} /> {en.name}{en.isDir ? '/' : ''}
                  </div>
                  <div className="ses-sub">{en.isDir ? '目录 · 点击进入' : `${fmtSize(en.size)} · 点击注入文本快照`}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5, borderTop: '1px solid var(--border)' }}>
            引入的是文件内容快照（≤64KB 文本），不是实时链接——文件后续变化不会同步进对话。
          </div>
        </div>
      )}
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
