// 文件预览面板：右侧常驻，工作区文件树 + 多标签页 + 自动刷新。
// 权限面与 @文件引用完全同一条通道（fs:listDir / fs:readTextFile / fs:readDataUrl，
// 主进程 guardRel 闸门：相对路径、沙箱校验、大小上限）——这里不新开任何读取面。
// 自动刷新两条腿：模型工具写盘事件（writtenPath 命中打开的文件）即时重读；
// 2.5s 轮询活跃标签兜底（CLI 写盘没有事件可订阅）。
import React, { useCallback, useEffect, useState } from 'react'
import type { AgentConfig } from '@shared/types'
import { Icon } from './Icons'
import { fileRef, bridge } from '../lib/ipc'

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i
const POLL_MS = 2500

interface Tab {
  rel: string
  kind: 'text' | 'image'
  content?: string
  dataUrl?: string
  err?: string
}

export function FilePreviewPanel({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const [tree, setTree] = useState<Record<string, { name: string; isDir: boolean; size: number }[]>>({})
  const [treeErr, setTreeErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string[]>([''])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState(0)
  const agentId = agent.id

  const loadDir = useCallback(async (dir: string) => {
    const r = await fileRef.listDir(agentId, dir)
    if (r.ok && r.entries) {
      const es: { name: string; isDir: boolean; size: number }[] = r.entries
      setTree((t) => ({ ...t, [dir]: es }))
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

  const refreshTab = useCallback(async (idx: number) => {
    setTabs((cur) => {
      const tab = cur[idx]
      if (!tab) return cur
      void (async () => {
        if (tab.kind === 'image') {
          const r = await fileRef.readDataUrl(agentId, tab.rel)
          setTabs((ts) => ts.map((t, i) => (i === idx ? { ...t, dataUrl: r.ok ? r.dataUrl : undefined, err: r.ok ? undefined : r.message } : t)))
        } else {
          const r = await fileRef.readTextFile(agentId, tab.rel)
          setTabs((ts) => ts.map((t, i) => (i === idx ? { ...t, content: r.ok ? (r.content ?? '') : undefined, err: r.ok ? undefined : r.message } : t)))
        }
      })()
      return cur
    })
  }, [agentId])

  const openFile = (rel: string) => {
    const kind: 'text' | 'image' = IMG_RE.test(rel) ? 'image' : 'text'
    const exists = tabs.findIndex((t) => t.rel === rel)
    if (exists >= 0) {
      setActive(exists)
      void refreshTab(exists)
      return
    }
    setTabs([...tabs, { rel, kind }])
    setActive(tabs.length)
  }

  const closeTab = (idx: number) => {
    setTabs((cur) => cur.filter((_, i) => i !== idx))
    setActive((a) => (a >= idx && a > 0 ? a - 1 : a))
  }

  // 自动刷新①：模型工具写盘事件（writtenPath）命中已打开的标签 → 即时重读；顺带刷文件树
  useEffect(() => {
    const hit = (writtenPath?: string) => {
      if (!writtenPath) return
      const name = writtenPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
      if (!name) return
      const idx = tabs.findIndex((t) => {
        const low = t.rel.toLowerCase()
        return low === name || low.endsWith('/' + name)
      })
      if (idx >= 0) void refreshTab(idx)
      void loadDir('')
    }
    const off = bridge.models.onEvent((e) => {
      if (e.type === 'tool') hit(e.writtenPath)
    })
    return () => { off() }
  }, [tabs, refreshTab, loadDir])

  // 自动刷新②：轮询兜底（CLI 写盘无事件；窗口隐藏时 document.hidden 跳过一轮省事）
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return
      void refreshTab(active)
      void loadDir('')
    }, POLL_MS)
    return () => clearInterval(iv)
  }, [active, refreshTab, loadDir])

  const toggleDir = (rel: string) => {
    if (expanded.includes(rel)) {
      setExpanded(expanded.filter((x) => x !== rel))
      return
    }
    setExpanded([...expanded, rel])
    void loadDir(rel)
  }

  const renderDir = (dir: string, depth: number): React.ReactNode =>
    (tree[dir] ?? []).map((e) => {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDir) {
        return (
          <div key={rel}>
            <button
              className="fp-node"
              style={{ paddingLeft: depth * 12 + 6 }}
              onClick={() => toggleDir(rel)}
              title={rel}
            >
              <Icon name="folder" size={11} /> {expanded.includes(rel) ? '▾' : '▸'} {e.name}
            </button>
            {expanded.includes(rel) && renderDir(rel, depth + 1)}
          </div>
        )
      }
      const isActive = tabs[active]?.rel === rel
      return (
        <button
          key={rel}
          className={`fp-node${isActive ? ' on' : ''}`}
          style={{ paddingLeft: depth * 12 + 22 }}
          onClick={() => openFile(rel)}
          title={`${rel}（${Math.round(e.size / 1024)}KB）`}
        >
          {e.name} <span style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{Math.round(e.size / 1024)}KB</span>
        </button>
      )
    })

  const tab = tabs[active]

  return (
    <div
      style={{ width: 340, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-1, var(--bg, #fff))' }}
      data-testid="file-preview-panel"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="folder" size={13} />
        <b style={{ fontSize: 12.5, flex: 1 }}>文件预览{tabs.length ? `（${tabs.length} 个标签）` : ''}</b>
        <button className="icon-btn" title="刷新当前标签与文件树" onClick={() => { void refreshTab(active); void loadDir('') }}>
          <Icon name="scan" size={13} />
        </button>
        <button className="icon-btn" title="关闭预览面板" onClick={onClose}>✕</button>
      </div>
      {/* 标签页 */}
      {tabs.length > 0 && (
        <div style={{ display: 'flex', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--border)', overflowX: 'auto', flexWrap: 'nowrap' }} data-testid="file-preview-tabs">
          {tabs.map((t, i) => (
            <button
              key={t.rel}
              className={`model-chip${i === active ? ' open' : ''}`}
              style={{ height: 22, fontSize: 11, flexShrink: 0 }}
              onClick={() => setActive(i)}
              title={t.rel}
              data-preview-tab={t.rel}
            >
              {t.rel.split('/').pop()}
              <span
                style={{ marginLeft: 4, opacity: 0.7 }}
                onClick={(ev) => { ev.stopPropagation(); closeTab(i) }}
                title="关闭此标签"
              >×</span>
            </button>
          ))}
        </div>
      )}
      {/* 文件树 */}
      <div style={{ overflow: 'auto', borderBottom: '1px solid var(--border)', padding: '4px 0', maxHeight: '38%' }} data-testid="file-preview-tree">
        {treeErr
          ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 10px', lineHeight: 1.6 }}>{treeErr}（模型 Agent 要先在「工具」里启用并设目录；CLI Agent 要设工作目录）</div>
          : renderDir('', 0)}
      </div>
      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 10px' }} data-preview-content={tab?.rel ?? ''}>
        {!tab && <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>点击左侧文件预览。文本/代码直接显示（64KB 截断），图片内嵌显示（5MB 上限）。文件被工具改动会自动刷新。</div>}
        {tab?.err && <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.6 }}>{tab.err}</div>}
        {tab?.kind === 'image' && tab.dataUrl && <img src={tab.dataUrl} alt={tab.rel} style={{ maxWidth: '100%', borderRadius: 'var(--r-sm)' }} />}
        {tab?.kind === 'text' && <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, monospace' }}>{tab.content ?? '（读取中…）'}</pre>}
      </div>
    </div>
  )
}
