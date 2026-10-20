// 工作台侧栏：Agent 列表（状态/未读/选中高亮，顺序固定不自动置顶）、底部功能入口、折叠
import React, { useState } from 'react'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useSessions } from '../stores/sessions'
import { Icon } from '../components/Icons'
import { LogoMark } from '../components/Logo'
import { Avatar, StatusDot, statusText, IconButton } from '../components/primitives'
import { cls } from '../lib/utils'

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
  const [renaming, setRenaming] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  const onItemSelect = (id: string) => {
    select(id)
    clearUnread(id)
    setMenuFor(null)
  }

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
          <div key={a.id} style={{ position: 'relative' }}>
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
                  </div>
                </div>
              )}
              {!collapsed && unread[a.id] > 0 && <span className="unread-dot">{Math.min(unread[a.id], 9)}</span>}
              {!collapsed && (
                <span
                  className="more"
                  role="button"
                  tabIndex={0}
                  aria-label={`${a.name} 的更多操作`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuFor(menuFor === a.id ? null : a.id)
                  }}
                >
                  <Icon name="chevron" size={14} />
                </span>
              )}
            </button>

            {menuFor === a.id && (
              <div
                className="wf-detail"
                style={{ top: 'auto', bottom: 'auto', marginTop: 40, width: 190, right: 10, position: 'absolute', zIndex: 70 }}
              >
                <button className="foot-btn" onClick={() => { setRenaming(a.id); setMenuFor(null) }}>
                  <Icon name="reorder" size={13} /> 重命名
                </button>
                <button className="foot-btn" onClick={() => { setRemoveTarget(a.id); setMenuFor(null) }}>
                  <Icon name="close" size={13} /> 移除…
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

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
        <button className="foot-btn" onClick={openSettings} title="设置">
          <Icon name="settings" size={15} /> <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
