// 工作台侧栏：Agent 列表（状态/未读/选中高亮，顺序固定不自动置顶）、底部功能入口、折叠
import React, { useEffect, useRef, useState } from 'react'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useNotifications, unreadCount } from '../stores/notifications'
import { Icon } from '../components/Icons'
import { AgentManageCard } from '../components/AgentManageCard'
import { Modal } from '../components/Modal'
import { NotificationCenter } from '../components/NotificationCenter'
import { LogoMark } from '../components/Logo'
import { SkillCenter } from './SkillCenter'
import { AgentEditModal } from './AgentEditModal'
import { MobileAccessModal } from './MobileAccessModal'
import { Avatar, StatusDot, statusText, IconButton } from '../components/primitives'
import { cls, fmtTokens } from '../lib/utils'
import { WfTaskList } from './WfChips'
import { AccountBadge } from './AccountBadge'

// 卡片宽度：190 → 230（2026-10-25 用户要求稍宽——技能名 + 来源徽章 + 版本号一行放得更开）
const MENU_W = 230
// 卡片高度**不再是常量**：绑定的 Skill 数量、提示词长度、窗口宽度（换行）都会改它。
// 原先写死一个估算值做上下翻转判定，估偏就会裁掉一截（计划缺口 #3 要求实测回填），
// 现在改成打开后量真实高度来定位，内容变化时由 ResizeObserver 再校正。

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
  // 技能中心开关：纯本弹窗的局部状态，不进 ui store（无跨组件打开需求，少一条全局状态）
  const [skillCenterOpen, setSkillCenterOpen] = useState(false)
  // 手机查看弹窗：同上局部状态
  const [mobileOpen, setMobileOpen] = useState(false)
  // 通知中心面板：开关 + 打开瞬间量好的 fixed 坐标（底边贴触发按钮上方）
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifAnchor, setNotifAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const notifBtnRef = useRef<HTMLButtonElement | null>(null)
  const unreadNtf = useNotifications((s) => unreadCount(s.items))
  const openNotif = () => {
    if (notifOpen) { setNotifOpen(false); return }
    const btn = notifBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    // 底边贴按钮上方 6px；面板实际高度由 max-height + overflow 消化，不量实测高度
    setNotifAnchor({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 6 })
    setNotifOpen(true)
  }
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 菜单 fixed 坐标：按触发按钮位置 + 剩余空间计算，避免被窗口/滚动容器裁切 */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  // 编辑配置弹窗的目标 Agent（仅自定义模型类会从管理卡片触发）
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const menuBtnRefs = useRef<Record<string, HTMLElement | null>>({})
  const menuRef = useRef<HTMLDivElement | null>(null)

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
      // 先按"放在按钮下方"起个位置让元素能挂载，真实高度由下面的 effect 量完再校正
      setMenuPos({ top: r.bottom + 4, left })
      setMenuFor(id)
    }
  }

  /** 按**实测高度**决定往上翻还是往下放；技能清单是异步拉的，高度变了要重算 */
  useEffect(() => {
    const el = menuRef.current
    if (!menuFor || !el) return
    const place = () => {
      const btn = menuBtnRefs.current[menuFor]
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const h = el.getBoundingClientRect().height
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8))
      const fitsBelow = r.bottom + h + 6 <= window.innerHeight - 8
      const top = fitsBelow ? r.bottom + 4 : Math.max(8, r.top - h - 4)
      // 同位置不回写：否则 ResizeObserver → setState → 重渲染 → observer 再触发，会自己转起来
      setMenuPos((cur) => (cur && Math.abs(cur.top - top) < 1 && Math.abs(cur.left - left) < 1 ? cur : { top, left }))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [menuFor])

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
          ref={menuRef}
          className={cls('wf-detail', 'agent-menu')}
          // maxHeight/overflow 是第二层兜底：卡片高度会随绑定的 Skill 数量长
          // （0–120px），窗口又可能很矮；量完高度定位之后仍然装不进视口时，让它自己滚动而不是被裁掉。
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: MENU_W, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', zIndex: 70 }}
        >
          <AgentManageCard
            // 卡片里是 defaultValue 的非受控 textarea：不换 key 时从 A 切到 B 会复用同一个实例，
            // A 的草稿留在框里显示成 B 的内容，下一次 blur 就把它写进 B 那条记录里。
            key={menuFor}
            agentId={menuFor}
            onRename={() => {
              setRenaming(menuFor)
              setMenuFor(null)
            }}
            onRemove={() => {
              setRemoveTarget(menuFor)
              setMenuFor(null)
            }}
            onEdit={() => {
              setEditTarget(menuFor)
              setMenuFor(null)
            }}
            // 卡内"打开技能中心"直接开本侧栏挂的弹层（Modal 已 portal，从哪触发都一样）
            onOpenSkillCenter={() => setSkillCenterOpen(true)}
          />
        </div>
      )}

      {removeTarget && (
        // 复用 Modal：手工 overlay 没有 Esc、焦点陷阱与焦点归还（可访问性三件套全缺）
        <Modal
          open
          warning
          title={`移除「${agents.find((a) => a.id === removeTarget)?.name}」`}
          onClose={() => setRemoveTarget(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setRemoveTarget(null)}>取消</button>
          }
        >
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
        </Modal>
      )}

      {/* 编辑配置弹窗：Modal 自身 portal，挂哪都行；key=agentId 保证换目标时表单重置 */}
      {editTarget && (() => {
        const target = agents.find((a) => a.id === editTarget)
        return target?.modelConfig ? (
          <AgentEditModal key={target.id} agent={target} onClose={() => setEditTarget(null)} />
        ) : null
      })()}

      <WfTaskList collapsed={collapsed} />

      {/* 账号区：头像+档案名，点开切换/管理（2026-10-26 二批） */}
      <AccountBadge collapsed={collapsed} />

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
        <button
          ref={notifBtnRef}
          className="foot-btn notif-trigger"
          onClick={openNotif}
          title="通知中心"
        >
          <Icon name="bell" size={15} /> <span>通知</span>
          {unreadNtf > 0 && <span className="notif-badge">{unreadNtf > 9 ? '9+' : unreadNtf}</span>}
        </button>
        <button className="foot-btn" onClick={() => setSkillCenterOpen(true)} title="技能中心">
          <Icon name="download" size={15} /> <span>技能中心</span>
        </button>
        <button className="foot-btn" onClick={() => setMobileOpen(true)} title="手机查看">
          <Icon name="phone" size={15} /> <span>手机查看</span>
        </button>
        <button className="foot-btn" onClick={() => openSettings()} title="设置">
          <Icon name="settings" size={15} /> <span>设置</span>
        </button>
      </div>

      {/* 技能中心：Modal 组件自身 portal 到 body（aside 的入场动画 fill-mode:both 会让
          fixed 后代被困在侧栏里——真实事故，Modal 层统一修掉了），这里挂哪都行 */}
      <SkillCenter open={skillCenterOpen} onClose={() => setSkillCenterOpen(false)} />
      <MobileAccessModal open={mobileOpen} onClose={() => setMobileOpen(false)} />

      {/* 通知中心：不是 Modal，走不到 Modal 的 portal，必须自己 createPortal——
          本面板是 fixed 定位，直接挂在 aside 里会被侧栏入场动画的 transform 裹挟
          （fixed 包含块问题，同上面技能中心注释里那场事故；详见 NotificationCenter.tsx 头注释） */}
      {notifOpen && notifAnchor && (
        <NotificationCenter anchor={notifAnchor} onClose={() => setNotifOpen(false)} />
      )}
    </aside>
  )
}
