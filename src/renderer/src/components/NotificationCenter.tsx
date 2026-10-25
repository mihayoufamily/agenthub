// 通知中心面板：侧栏底栏铃铛的 popover 列表（新→旧）。
// 定位由调用方（Sidebar）在打开瞬间按触发按钮量好，通过 anchor 传入 fixed 坐标——
// 面板高度交给 max-height + overflow 消化，不重复 agent-menu 那套实测高度翻转（列表方向固定朝上）。
import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNotifications, unreadCount } from '../stores/notifications'
import { useWorkflow } from '../stores/workflow'
import { cls, fmtTime } from '../lib/utils'
import type { NotificationItem as Notification } from '../stores/notifications'

/** kind 的中文标签（列表里区分来源；当前只有任务通知，schedule/system 留给后续推送来源） */
const KIND_LABEL: Record<Notification['kind'], string> = { task: '任务', schedule: '定时', system: '系统' }

/**
 * 为什么这里是 createPortal 而不是像 agent-menu 那样直接渲染在侧栏 JSX 里：
 * 本面板用 position: fixed，而侧栏 aside 带入场动画（transform + fill-mode），transform 元素
 * 会成为 fixed 后代的**包含块**——fixed 坐标系被困在侧栏里，"贴底栏上方"会算到侧栏局部坐标去。
 * 这正是今天 Modal 组件修掉的那场事故（Modal 层统一 portal 到 body），但本面板不是 Modal，
 * 走不到 Modal 的 portal，只能自己 createPortal 到 body——同一事故的第二个入口，注释在此防止第三个。
 */
export function NotificationCenter({ anchor, onClose }: { anchor: { left: number; bottom: number }; onClose: () => void }) {
  const items = useNotifications((s) => s.items)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const clear = useNotifications((s) => s.clear)
  const unread = useNotifications((s) => unreadCount(s.items))

  // 打开面板即全部已读：打开本身就是"处理通知"这个动作，不存在"看过了但仍算未读"的语义
  useEffect(() => {
    markAllRead()
  }, [markAllRead])

  // 点击面板外 / Escape 关闭；触发按钮自己处理 toggle（再次点击是关，不算"面板外"）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.notif-panel') && !t.closest('.notif-trigger')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const openItem = (n: Notification) => {
    if (n.kind === 'task' && n.runId) {
      // 正在执行别的任务时 openTask 会以 toast 拒绝切换（单执行循环），这里不做二次判断：
      // 拒绝理由由那里如实给出，面板照常关闭
      useWorkflow.getState().openTask(n.runId)
      onClose()
    }
  }

  return createPortal(
    <div className="notif-panel" style={{ left: anchor.left, bottom: anchor.bottom }}>
      <div className="notif-head">
        <span>通知中心{unread > 0 ? `（未读 ${unread}）` : ''}</span>
      </div>
      {items.length === 0 && <div className="notif-empty">暂无通知。任务到确认门或结束时都会出现在这里。</div>}
      <div className="notif-list">
        {items.map((n) => (
          <button
            key={n.id}
            className={cls('notif-item', n.kind === 'task' && n.runId && 'clickable')}
            onClick={() => openItem(n)}
            title={n.kind === 'task' && n.runId ? '点击打开这条任务' : undefined}
          >
            <span className="notif-kind">{KIND_LABEL[n.kind]}</span>
            <span className="notif-time">{fmtTime(n.ts)}</span>
            <span className="notif-title">{n.title}</span>
            {n.body && <span className="notif-body">{n.body}</span>}
          </button>
        ))}
      </div>
      <div className="notif-foot">
        <button className="notif-btn" onClick={markAllRead}>全部已读</button>
        <button className="notif-btn" onClick={clear}>清空</button>
      </div>
    </div>,
    document.body
  )
}
