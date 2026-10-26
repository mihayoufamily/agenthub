// 右侧文件预览面板的全局开关（2026-10-26 二批）：
// 之前 previewOpen 是 ChatView 局部 state，产物预览按钮（聊天工具卡/任务产物 chip）够不着它。
// 提升为 store 后任何地方都能 openPreview(agentId, {rel|abs}) 唤起右侧面板并直接定位文件。
import { create } from 'zustand'

export interface PreviewTarget {
  /** Agent 工作根内的相对路径（文件树通道） */
  rel?: string
  /** 绝对路径（AI 产物：工作根内或工作流产物目录内，主进程 artifact:readPreview 守卫） */
  abs?: string
}

interface PreviewState {
  open: boolean
  agentId: string | null
  /** 打开时想直接定位的文件（面板消费后 clearPending） */
  pending: PreviewTarget | null
  openPreview: (agentId: string, target?: PreviewTarget) => void
  close: () => void
  clearPending: () => void
}

export const usePreview = create<PreviewState>()((set) => ({
  open: false,
  agentId: null,
  pending: null,
  openPreview: (agentId, target) => set({ open: true, agentId, pending: target ?? null }),
  close: () => set({ open: false, pending: null }),
  clearPending: () => set({ pending: null })
}))
