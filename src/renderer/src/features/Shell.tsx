// 两种模式共用的外壳：左侧栏（Agent 列表 / 工作流任务 / 切换模式 / 设置）固定在同一处，
// 切模式时界面骨架不动，只有右侧内容区换。
import React from 'react'
import { Sidebar } from './Sidebar'
import { AgentModals } from './AgentModals'
import { CompatBadge } from '../components/CompatBadge'
import { useUi } from '../stores/ui'

export function Shell({ children }: { children: React.ReactNode }) {
  const agentModal = useUi((s) => s.agentModal)
  const setAgentModal = useUi((s) => s.setAgentModal)
  return (
    <div className="workbench screen">
      <Sidebar onOrder={() => setAgentModal('order')} onAdd={() => setAgentModal('add')} />
      {children}
      {/* 兼容模式徽章唯一的挂载点（Task 6 评审 finding 3）：Shell 是工作站/工作流两种模式都路过的
          共用外壳，挂这里一处就两边都有——原来挂在 Workbench 空状态与 ChatView 两处顶栏，
          Ctrl+M 切进工作流（TaskView/WorkflowHome）就看不见"沙箱已关"这件事了 */}
      <CompatBadge />
      <AgentModals kind={agentModal} onClose={() => setAgentModal(null)} />
    </div>
  )
}
