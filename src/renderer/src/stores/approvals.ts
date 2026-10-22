// 命令审批的前端状态：待裁决队列 + 点选落地。
// 判定与历史都在主进程，这里只负责"把要问的东西摆到人面前"。
import { create } from 'zustand'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { bridge } from '../lib/ipc'
import { useUi } from './ui'

interface ApprovalState {
  pending: ApprovalRequest[]
  push: (req: ApprovalRequest) => void
  drop: (id: string) => void
  /** 界面点选：主进程会写历史（always 还会补白名单），这里只管把卡片撤掉 */
  decide: (id: string, decision: ApprovalDecision) => Promise<void>
  refreshPending: () => Promise<void>
}

export const useApprovals = create<ApprovalState>()((set, get) => ({
  pending: [],

  push: (req) => {
    if (get().pending.some((p) => p.id === req.id)) return
    set((s) => ({ pending: [...s.pending, req] }))
    // 人可能不在窗口前（工作流在后台跑）：窗口聚焦时主进程自己会跳过这条通知
    void bridge.app.notify('有命令等待确认', `${req.command.slice(0, 80)}\n${req.reason}`)
  },

  drop: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),

  decide: async (id, decision) => {
    const r = await bridge.approval.decide(id, decision)
    get().drop(id)
    if (!r.ok) useUi.getState().toast(r.message ?? '该审批已超时或已结束', 'warn')
    else if (decision === 'always') useUi.getState().toast('已写入该 Agent 的命令白名单', 'ok')
  },

  refreshPending: async () => {
    const list = await bridge.approval.pending()
    set({ pending: list })
  }
}))

/** 订阅主进程审批事件（App 启动时挂一次） */
export function watchApprovals(): () => void {
  const off = bridge.models.onApproval((req) => useApprovals.getState().push(req))
  void useApprovals.getState().refreshPending()
  return off
}
