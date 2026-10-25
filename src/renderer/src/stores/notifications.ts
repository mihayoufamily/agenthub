// 通知中心（渲染层内存态）：任务到确认门/终态、后续可扩展定时触发等来源的站内通知列表。
// 刻意不落盘、不建 IPC：通知是"回来的路上翻一眼"的临时记录，重启清零是可接受语义，
// 而来源（workflow.ts 的 announce 等）本来就在渲染层，自己 push 自己，零通道开销。
import { create } from 'zustand'
import { uid } from '../lib/utils'

export interface NotificationItem {
  id: string
  kind: 'task' | 'schedule' | 'system'
  title: string
  body?: string
  /** kind 'task' 时可带：点这条通知跳回对应任务（useWorkflow.openTask） */
  runId?: string
  ts: number
  read: boolean
}

/** 上限 50 条滚动淘汰：通知列表只服务"最近发生了什么"，不承担历史归档（那是任务记录页的职责） */
const MAX_ITEMS = 50

interface NotificationsState {
  items: NotificationItem[]
  /** 新通知插到头部（列表按新→旧展示），超上限从尾部（最旧）淘汰 */
  push: (n: { kind: NotificationItem['kind']; title: string; body?: string; runId?: string; ts?: number }) => void
  markAllRead: () => void
  clear: () => void
}

export const useNotifications = create<NotificationsState>()((set) => ({
  items: [],
  push: (n) =>
    set((s) => ({
      items: [
        { id: uid('ntf'), ts: n.ts ?? Date.now(), read: false, kind: n.kind, title: n.title, ...(n.body ? { body: n.body } : {}), ...(n.runId ? { runId: n.runId } : {}) },
        ...s.items
      ].slice(0, MAX_ITEMS)
    })),
  markAllRead: () => set((s) => ({ items: s.items.map((i) => (i.read ? i : { ...i, read: true })) })),
  clear: () => set({ items: [] })
}))

/** 未读数（派生）：组件里用 useNotifications(unreadCount) 取，数字相等时 zustand 不触发重渲染 */
export function unreadCount(items: NotificationItem[]): number {
  return items.reduce((n, i) => n + (i.read ? 0 : 1), 0)
}
