// 工作台侧栏：Agent 列表（状态/未读/选中高亮，顺序固定不自动置顶）、底部功能入口、折叠
import React, { useEffect, useRef, useState } from 'react'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { Icon } from '../components/Icons'
import { AgentManageCard } from '../components/AgentManageCard'
import { LogoMark } from '../components/Logo'
import { Avatar, StatusDot, statusText, IconButton } from '../components/primitives'
import { cls, fmtTokens } from '../lib/utils'
import { WfTaskList } from './WfChips'

const MENU_W = 190
const MENU_H = 336 // Agent 管理卡片的实测高度（翻转判定用；跑完 ui-shot 的"菜单完整落在视口内"断言后按实测校准）

export function Sidebar({ onOrder, onAdd }: { onOrder: () => void; onAdd: () => void }) {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const select = useAgents((s) => s.select)
  const unread = useAgents((s) => s.unread)
  const clearUnread = useAgents((s) => s.clearUnread)
  const updateAgent = useAgents((s) => s.updateAgent)
  const removeAgent = useAgents((s) => s.removeAgent)
  const colorOf = useAgents((s) => s.colorOf)
  const collapsed = useSettings((s) => s.prefs?.sidebarCollapsed ?? false)
  const patchPrefs = useSettings((s) => s.patchPrefs)
  const openSettings = useUi((s) => s.openSettings)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 菜单 fixed 坐标：按触发按钮位置 + 剩余空间计算，避免被窗口/滚动容器裁切 */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const menuBtnRefs = useRef<Record<string, HTMLElement | null>>({})

  const onItemSelect = (id: string) => {
    select(id)
    clearUnread(id)
    setMenuFor(null)
  }

  const openMenu = (id: string) => {
    if (menuFor === id) { // 已打开：再次点击关闭
      setMenuFor(null)
      setMenuPos(null)
      return
    }
    const btn = menuBtnRefs.current[id]
    if (btn) {
      const r = btn.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8))
      const top = r.bottom + MENU_H + 6 > window.innerHeight - 8 ? r.top - MENU_H - 4 : r.bottom + 4
      setMenuPos({ top, left })
      setMenuFor(id)
    }
  }

  // 点击外部 / Escape 关闭菜单（.more 按钮自身由 openMenu 处理 toggle）
  useEffect(() => {
    if (!menuFor) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.agent-menu') && !t.closest('.more')) setMenuFor(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  return (
    <aside className={cls('sidebar', collapsed && 'collapsed')}>
      <div className="sidebar-head">
        <div className="brand-mini">
          <LogoMark size={20} />
          <span>AgentHub</span>
        </div>
        <IconButton
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
          onClick={() => patchPrefs({ sidebarCollapsed: !collapsed })}
        >
          <Icon name="reorder" size={15} />
        </IconButton>
      </div>

      <div className="agent-list">
        {agents.map((a) => (
          <div key={a.id}>
            <button
              className={cls('agent-item', selectedId === a.id && 'selected')}
              onClick={() => onItemSelect(a.id)}
              onDoubleClick={() => setRenaming(a.id)}
              title={`${a.name} · ${statusText(a.status)}`}
            >
              <Avatar name={a.name} color={colorOf(a.id)} />
              {!collapsed && (
                <div className="meta">
                  <div className="name">
                    {renaming === a.id ? (
                      <input
                        autoFocus
                        defaultValue={a.name}
                        style={{
                          fontSize: 13, fontWeight: 600, border: '1px solid var(--border-strong)',
                          borderRadius: 4, padding: '1px 4px', width: 110, background: 'var(--surface)'
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            updateAgent(a.id, { name: (e.target as HTMLInputElement).value || a.name })
                            setRenaming(null)
                          }
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={(e) => {
                          updateAgent(a.id, { name: e.target.value || a.name })
                          setRenaming(null)
                        }}
                      />
                    ) : (
                      <>
                        <span className="txt-ellipsis">{a.name}</span>
                        {a.isDemo && <span className="demo-badge">演示</span>}
                      </>
                    )}
                  </div>
                  <div className="sub">
                    <StatusDot status={a.status} />
                    <span className="txt-ellipsis">{a.model}</span>
                    {!a.isDemo && (a.totalTokens ?? 0) > 0 && (
                      <span style={{ color: 'var(--text-3)', flexShrink: 0 }} title={`累计 ${a.totalTokens} tokens${a.cliConfig?.cli === 'codebuddy' ? '（CodeBuddy 实际按积分计费，明细见 codebuddy.ai 个人主页）' : ''}`}>
                        · {fmtTokens(a.totalTokens!)}tk
                      </span>
                    )}
                  </div>
                </div>
              )}
              {!collapsed && unread[a.id] > 0 && <span className="unread-dot">{Math.min(unread[a.id], 9)}</span>}
              {!collapsed && (
                <span
                  ref={(el) => { menuBtnRefs.current[a.id] = el }}
                  className="more"
                  role="button"
                  tabIndex={0}
                  aria-label={`${a.name} 的更多操作`}
                  onClick={(e) => {
                    e.stopPropagation()
                    openMenu(a.id)
                  }}
                >
                  <Icon name="chevron" size={14} />
                </span>
              )}
            </button>
          </div>
        ))}
      </div>

      {/* Agent 管理卡片：fixed 定位（脱离滚动容器），按剩余空间向上/向下翻转 */}
      {menuFor && menuPos && (
        <div
          className={cls('wf-detail', 'agent-menu')}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: MENU_W, zIndex: 70 }}
        >
          <AgentManageCard
            agentId={menuFor}
            onRename={() => {
              setRenaming(menuFor)
              setMenuFor(null)
            }}
            onRemove={() => {
              setRemoveTarget(menuFor)
              setMenuFor(null)
            }}
          />
        </div>
      )}

      {removeTarget && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setRemoveTarget(null) }}>
          <div className="modal warning" style={{ width: 420 }} role="dialog">
            <div className="modal-head">移除「{agents.find((a) => a.id === removeTarget)?.name}」</div>
            <div className="modal-body">
              <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)', paddingBottom: 8 }}>
                请选择操作（两者互不影响对方）：
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  className="btn btn-secondary"
                  onClick={async () => {
                    await removeAgent(removeTarget, { deleteHistory: false })
                    setRemoveTarget(null)
                    useUi.getState().toast('已移除连接（会话历史保留，可重新添加后查看）', 'ok')
                  }}
                >
                  仅移除连接，保留历史记录
                </button>
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    await removeAgent(removeTarget, { deleteHistory: true })
                    setRemoveTarget(null)
                    useUi.getState().toast('已移除连接并删除历史记录', 'ok')
                  }}
                >
                  移除连接并删除历史记录
                </button>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-primary" onClick={() => setRemoveTarget(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      <WfTaskList collapsed={collapsed} />

      <div className="sidebar-foot">
        <button className="foot-btn" onClick={onAdd} title="添加 Agent">
          <Icon name="plus" size={15} /> <span>添加 Agent</span>
        </button>
        <button className="foot-btn" onClick={onOrder} title="管理顺序">
          <Icon name="reorder" size={15} /> <span>管理顺序</span>
        </button>
        <button className="foot-btn" onClick={() => useUi.getState().setSwitchHud('__switch_ask')} title="切换模式">
          <Icon name="swap" size={15} /> <span>切换模式</span>
        </button>
        <button className="foot-btn" onClick={() => openSettings()} title="设置">
          <Icon name="settings" size={15} /> <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
