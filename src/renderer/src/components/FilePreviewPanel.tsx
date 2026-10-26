// 文件预览面板：右侧常驻，工作区文件树 + 多标签页 + 智能刷新。
// 权限面与 @文件引用完全同一条通道（fs:listDir / fs:readTextFile / fs:readDataUrl，
// 主进程 guardRel 闸门：相对路径、沙箱校验、大小上限）；AI 产物走 artifact:readPreview
// （绝对路径，范围硬闸=Agent 工作根或工作流产物目录）——这里不新开任何读取面。
// 刷新策略（2026-10-26 重做，治"卡手"）：
//  - 内容字符串没变就不 setState（轮询读到了一样的文件不再触发重渲染）
//  - 文件树只在打开面板/手动刷新/写盘事件时重载，轮询不再每 2.5s 重载整棵树
//  - 事件订阅用 ref 取 tabs（依赖 tabs 的 effect 反复重挂订阅是原卡顿源之一）
// 样式全部走 components.css 的 .fp-* 类（设计系统 tokens），不再堆内联样式。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentConfig } from '@shared/types'
import { Icon } from './Icons'
import { fileRef, bridge } from '../lib/ipc'
import { usePreview } from '../stores/preview'
import { useUi } from '../stores/ui'

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i
const POLL_MS = 2500

/** 文件类型徽标（对标 WorkBuddy 的文件面板：扩展名色块，一眼识别文件类型） */
const EXT_GROUPS: { re: RegExp; label: string; color: string }[] = [
  { re: /\.(tsx?|jsx)$/i, label: 'TS', color: '#3b82f6' },
  { re: /\.js|mjs|cjs$/i, label: 'JS', color: '#eab308' },
  { re: /\.json$/i, label: '{}', color: '#f59e0b' },
  { re: /\.(md|markdown|txt)$/i, label: 'MD', color: '#64748b' },
  { re: /\.(css|scss|less)$/i, label: 'CSS', color: '#06b6d4' },
  { re: /\.(html?|vue)$/i, label: '<>', color: '#e06456' },
  { re: /\.(py|sh|bat|ps1)$/i, label: 'SH', color: '#3fbf7f' },
  { re: /\.(png|jpe?g|gif|webp|bmp|svg)$/i, label: 'IMG', color: '#8b5cf6' },
  { re: /\.(zip|gz|rar|7z|exe|dll)$/i, label: 'BIN', color: '#9aa0ad' },
  { re: /\.(log|csv|ya?ml|toml|ini|env)$/i, label: 'TXT', color: '#94a3b8' }
]
function extBadge(name: string): { label: string; color: string } {
  for (const g of EXT_GROUPS) if (g.re.test(name)) return { label: g.label, color: g.color }
  return { label: '·', color: 'var(--text-3)' }
}

interface Tab {
  /** rel=Agent 工作根相对路径；abs=绝对路径（AI 产物通道） */
  rel: string
  abs?: string
  kind: 'text' | 'image'
  content?: string
  dataUrl?: string
  err?: string
  truncated?: boolean
}

export function FilePreviewPanel({ agent, cmds, onClose }: { agent: AgentConfig; cmds?: { cmd: string; out: string; err: boolean }[]; onClose: () => void }) {
  const [tree, setTree] = useState<Record<string, { name: string; isDir: boolean; size: number }[]>>({})
  const [treeErr, setTreeErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string[]>([''])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState(0)
  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const agentId = agent.id
  const pending = usePreview((s) => s.pending)
  const clearPending = usePreview((s) => s.clearPending)

  const loadDir = useCallback(async (dir: string) => {
    const r = await fileRef.listDir(agentId, dir)
    if (r.ok && r.entries) {
      const es: { name: string; isDir: boolean; size: number }[] = r.entries
      setTree((t) => (JSON.stringify(t[dir]) === JSON.stringify(es) ? t : { ...t, [dir]: es }))
      if (dir === '') setTreeErr(null)
    } else if (dir === '') {
      setTreeErr(r.message ?? '读取失败')
    }
  }, [agentId])

  // 切 Agent 整体重置（预览随会话 UI 态，不做持久化）
  useEffect(() => {
    setTree({})
    setTreeErr(null)
    setExpanded([''])
    setTabs([])
    setActive(0)
    void loadDir('')
  }, [agentId, loadDir])

  const refreshTab = useCallback(async (idx: number, tabOverride?: Tab) => {
    const tab = tabOverride ?? tabsRef.current[idx]
    if (!tab) return
    if (tab.abs) {
      const r = await bridge.artifacts.readPreview(agentId, tab.abs)
      setTabs((ts) => {
        const cur = ts[idx]
        if (!cur || cur.rel !== tab.rel) return ts
        const next = r.ok
          ? { ...cur, content: r.content, dataUrl: r.dataUrl, err: undefined, truncated: r.truncated }
          : { ...cur, err: r.message ?? '读取失败' }
        return JSON.stringify(cur) === JSON.stringify(next) ? ts : ts.map((t, i) => (i === idx ? next : t))
      })
      return
    }
    if (tab.kind === 'image') {
      const r = await fileRef.readDataUrl(agentId, tab.rel)
      setTabs((ts) => ts.map((t, i) => (i === idx ? { ...t, dataUrl: r.ok ? r.dataUrl : undefined, err: r.ok ? undefined : r.message } : t)))
    } else {
      const r = await fileRef.readTextFile(agentId, tab.rel)
      setTabs((ts) => ts.map((t, i) => {
        if (i !== idx) return t
        const next = { ...t, content: r.ok ? (r.content ?? '') : undefined, err: r.ok ? undefined : r.message }
        return t.content === next.content && t.err === next.err ? t : next
      }))
    }
  }, [agentId])

  const openFile = (rel: string) => {
    const kind: 'text' | 'image' = IMG_RE.test(rel) ? 'image' : 'text'
    const exists = tabs.findIndex((t) => !t.abs && t.rel === rel)
    if (exists >= 0) {
      setActive(exists)
      void refreshTab(exists)
      return
    }
    const t: Tab = { rel, kind }
    setTabs([...tabs, t])
    setActive(tabs.length)
    // 打开即读（不等 2.5s 轮询）：新标签立刻有内容
    void refreshTab(tabs.length, t)
  }

  const openAbs = (abs: string) => {
    const kind: 'text' | 'image' = IMG_RE.test(abs) ? 'image' : 'text'
    const exists = tabs.findIndex((t) => t.abs === abs)
    if (exists >= 0) {
      setActive(exists)
      void refreshTab(exists)
      return
    }
    const t: Tab = { rel: abs.replace(/\\/g, '/').split('/').pop() ?? abs, abs, kind }
    setTabs([...tabs, t])
    setActive(tabs.length)
    void refreshTab(tabs.length, t)
  }

  // 外部唤起（聊天工具卡「预览」/任务产物 chip）：定位到指定文件
  useEffect(() => {
    if (!pending) return
    if (pending.abs) openAbs(pending.abs)
    else if (pending.rel) openFile(pending.rel)
    clearPending()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // 切标签退出编辑态（编辑器草稿只属于当时那个文件）
  useEffect(() => { setEditing(false) }, [active])

  const closeTab = (idx: number) => {
    setTabs((cur) => cur.filter((_, i) => i !== idx))
    setActive((a) => (a >= idx && a > 0 ? a - 1 : a))
  }

  // 自动刷新①：模型工具写盘事件（writtenPath）命中已打开的标签 → 即时重读 + 节流刷树
  const lastTreeLoad = useRef(0)
  useEffect(() => {
    const hit = (writtenPath?: string) => {
      if (!writtenPath) return
      const norm = writtenPath.replace(/\\/g, '/').toLowerCase()
      tabsRef.current.forEach((t, idx) => {
        const low = (t.abs ? t.abs.replace(/\\/g, '/').toLowerCase() : t.rel.toLowerCase())
        if (low === norm || low.endsWith('/' + norm.split('/').pop())) void refreshTab(idx)
      })
      const now = Date.now()
      if (now - lastTreeLoad.current > 2000) {
        lastTreeLoad.current = now
        void loadDir('')
      }
    }
    const off = bridge.models.onEvent((e) => {
      if (e.type === 'tool') hit(e.writtenPath)
    })
    return () => { off() }
  }, [refreshTab, loadDir])

  // 自动刷新②：轮询只刷活跃标签（内容没变不 setState），不再重载文件树
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return
      void refreshTab(active)
    }, POLL_MS)
    return () => clearInterval(iv)
  }, [active, refreshTab])

  const toggleDir = (rel: string) => {
    if (expanded.includes(rel)) {
      setExpanded(expanded.filter((x) => x !== rel))
      return
    }
    setExpanded([...expanded, rel])
    void loadDir(rel)
  }

  // ---- 实时改删（2026-10-26 三批：WorkBuddy 式文件侧栏） ----
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const tab = tabs[active]

  const startEdit = () => {
    if (!tab || tab.kind !== 'text' || tab.abs) return // 绝对路径产物只读；图片不可编辑
    setDraft(tab.content ?? '')
    setEditing(true)
  }
  const cancelEdit = () => setEditing(false)
  const saveEdit = async () => {
    if (!tab || !editing) return
    setSaving(true)
    try {
      const r = await fileRef.writeTextFile(agentId, tab.rel, draft)
      if (r.ok) {
        setEditing(false)
        setTabs((ts) => ts.map((t, i) => (i === active ? { ...t, content: draft, err: undefined } : t)))
        void loadDir('') // 大小可能变了
      } else useUi.getState().toast(r.message ?? '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }
  // 编辑中 Ctrl+S 保存
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveEdit() }
      if (e.key === 'Escape') setEditing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft, active])

  const deleteFile = async (rel: string) => {
    if (!window.confirm(`删除文件 ${rel}？此操作不可恢复`)) return
    const r = await fileRef.deleteFile(agentId, rel)
    if (!r.ok) { useUi.getState().toast(r.message ?? '删除失败', 'error'); return }
    // 关掉指向它的标签
    setTabs((cur) => {
      const idx = cur.findIndex((t) => !t.abs && t.rel === rel)
      if (idx < 0) return cur
      setActive((a) => (a >= idx && a > 0 ? a - 1 : a))
      return cur.filter((_, i) => i !== idx)
    })
    if (editing && tabs[active]?.rel === rel) setEditing(false)
    void loadDir('')
    useUi.getState().toast('已删除', 'ok')
  }

  const createFile = async () => {
    const name = newName.trim()
    if (!name) return
    const rel = name.replace(/\\/g, '/').replace(/^\/+/, '')
    const r = await fileRef.createFile(agentId, rel)
    if (!r.ok) { useUi.getState().toast(r.message ?? '创建失败', 'error'); return }
    setNewName(''); setCreating(false)
    setExpanded((ex) => (rel.includes('/') ? [...new Set([...ex, rel.split('/').slice(0, -1).join('/')])] : ex))
    void loadDir('')
    openFile(rel)
    useUi.getState().toast('已创建', 'ok')
  }

  const renderDir = (dir: string, depth: number): React.ReactNode =>
    (tree[dir] ?? []).map((e) => {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDir) {
        const isOpen = expanded.includes(rel)
        return (
          <div key={rel}>
            <button
              className={`fp-node${isOpen ? ' open' : ''}`}
              style={{ paddingLeft: depth * 14 + 8 }}
              onClick={() => toggleDir(rel)}
              title={rel}
            >
              <span className="fp-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="fp-badge" style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)' }}>DIR</span>
              <span className="fp-node-name">{e.name}</span>
            </button>
            {isOpen && renderDir(rel, depth + 1)}
          </div>
        )
      }
      const isActive = tabs[active]?.rel === rel && !tabs[active]?.abs
      const badge = extBadge(e.name)
      return (
        <button
          key={rel}
          className={`fp-node${isActive ? ' on' : ''}`}
          style={{ paddingLeft: depth * 14 + 8 }}
          onClick={() => openFile(rel)}
          title={rel}
        >
          <span className="fp-badge" style={{ background: `color-mix(in srgb, ${badge.color} 20%, transparent)`, color: badge.color }}>{badge.label}</span>
          <span className="fp-node-name">{e.name}</span>
          <span className="fp-node-size">{e.size < 1024 ? `${e.size}B` : `${Math.round(e.size / 1024)}KB`}</span>
        </button>
      )
    })

  // 面板双视图：文件（树+标签+内容）/ 终端（命令执行实时流）
  const [mode, setMode] = useState<'files' | 'term'>('files')
  const termRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (mode === 'term' && termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight }, [mode, cmds])

  return (
    <div className="fp-panel" data-testid="file-preview-panel">
      <div className="fp-head">
        <span className="fp-title-icon"><Icon name="folder" size={13} /></span>
        <div className="fp-title">
          <b>{mode === 'files' ? '文件预览' : '终端'}</b>
          <span className="fp-title-sub">{agent.name}</span>
        </div>
        <div className="fp-mode">
          <button className={`fp-mode-btn${mode === 'files' ? ' on' : ''}`} onClick={() => setMode('files')}>文件</button>
          <button className={`fp-mode-btn${mode === 'term' ? ' on' : ''}`} onClick={() => setMode('term')} data-testid="fp-mode-term">终端{cmds?.length ? ` (${cmds.length})` : ''}</button>
        </div>
        {mode === 'files' && (
          <button className="icon-btn" title="刷新当前标签与文件树" onClick={() => { void refreshTab(active); void loadDir('') }}>
            <Icon name="scan" size={13} />
          </button>
        )}
        <button className="icon-btn" title="关闭预览面板" onClick={onClose}>✕</button>
      </div>
      {mode === 'term' ? (
        <div className="fp-term" ref={termRef} data-testid="fp-term">
          {!cmds?.length && <div className="fp-empty">还没有命令执行记录。<br />AI 每次运行命令，输出会实时出现在这里。</div>}
          {cmds?.map((c, i) => (
            <div key={i} className="fp-term-block">
              <div className="fp-term-cmd"><span className="fp-term-prompt">$</span> {c.cmd}</div>
              {c.out && <pre className={`fp-term-out${c.err ? ' err' : ''}`}>{c.out}</pre>}
            </div>
          ))}
        </div>
      ) : (
        <>
      {tabs.length > 0 && (
        <div className="fp-tabs" data-testid="file-preview-tabs">
          {tabs.map((t, i) => {
            const b = extBadge(t.rel)
            return (
              <span key={t.rel + i} className={`fp-tab${i === active ? ' on' : ''}`} onClick={() => setActive(i)} title={t.abs ?? t.rel} data-preview-tab={t.rel}>
                <span className="fp-badge" style={{ background: `color-mix(in srgb, ${b.color} 20%, transparent)`, color: b.color }}>{b.label}</span>
                <span className="fp-tab-name">{t.rel.split('/').pop()}</span>
                <span className="fp-tab-close" onClick={(ev) => { ev.stopPropagation(); closeTab(i) }} title="关闭此标签">×</span>
              </span>
            )
          })}
        </div>
      )}
      <div className="fp-tree" data-testid="file-preview-tree">
        <div className="fp-tree-bar">
          <button className="fp-tree-new" onClick={() => setCreating((v) => !v)} title="新建文件">＋ 新建</button>
        </div>
        {creating && (
          <div className="fp-new-row">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFile(); if (e.key === 'Escape') setCreating(false) }}
              placeholder="文件名，可含子目录（如 src/a.ts）"
            />
            <button className="fp-act primary" onClick={() => void createFile()}>创建</button>
          </div>
        )}
        {treeErr
          ? <div className="fp-empty">{treeErr}（模型 Agent 要先在「工具」里启用并设目录；CLI Agent 要设工作目录）</div>
          : renderDir('', 0)}
      </div>
      <div className="fp-content" data-preview-content={tab?.rel ?? ''}>
        {tab && (
          <div className="fp-cbar">
            <span className="fp-cbar-name" title={tab.abs ?? tab.rel}>{tab.rel.split('/').pop()}</span>
            <div className="fp-cbar-acts">
              {tab.kind === 'text' && !tab.abs && !editing && (
                <button className="fp-act" onClick={startEdit} title="编辑此文件" data-testid="fp-edit">编辑</button>
              )}
              {editing && (
                <>
                  <button className="fp-act primary" disabled={saving} onClick={() => void saveEdit()} title="保存（Ctrl+S）" data-testid="fp-save">{saving ? '保存中…' : '保存'}</button>
                  <button className="fp-act" onClick={cancelEdit}>取消</button>
                </>
              )}
              {!tab.abs && (
                <button className="fp-act danger" onClick={() => void deleteFile(tab.rel)} title="删除此文件" data-testid="fp-delete">删除</button>
              )}
            </div>
          </div>
        )}
        {!tab && (
          <div className="fp-welcome">
            <div className="fp-welcome-icon">🗂</div>
            <div className="fp-welcome-title">选择文件开始预览</div>
            <div className="fp-welcome-sub">文本与代码带行号显示（64KB 截断），图片内嵌（5MB 上限）<br />AI 改动文件会自动刷新，工具卡片上的「预览文件」也能直达</div>
          </div>
        )}
        {tab?.err && <div className="fp-err">{tab.err}</div>}
        {tab?.kind === 'image' && tab.dataUrl && (
          <div className="fp-img-wrap"><img src={tab.dataUrl} alt={tab.rel} className="fp-img" /></div>
        )}
        {tab?.kind === 'text' && !editing && (
          <>
            {tab.truncated && <div className="fp-truncated">内容较长，仅显示前 64KB</div>}
            <div className="fp-code">
              <div className="fp-gutter" aria-hidden>
                {(tab.content ?? '').split('\n').map((_, i) => <span key={i}>{i + 1}</span>)}
              </div>
              <pre className="fp-text">{tab.content ?? '（读取中…）'}</pre>
            </div>
          </>
        )}
        {tab?.kind === 'text' && editing && (
          <textarea
            className="fp-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            data-testid="fp-editor"
          />
        )}
      </div>
        </>
      )}
    </div>
  )
}
