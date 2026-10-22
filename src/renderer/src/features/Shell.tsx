// 两种模式共用的外壳：左侧栏（Agent 列表 / 工作流任务 / 切换模式 / 设置）固定在同一处，
// 切模式时界面骨架不动，只有右侧内容区换。
import React from 'react'
import { Sidebar } from './Sidebar'
import { AgentModals } from './AgentModals'
import { useUi } from '../stores/ui'

export function Shell({ children }: { children: React.ReactNode }) {
  const agentModal = useUi((s) => s.agentModal)
  const setAgentModal = useUi((s) => s.setAgentModal)
  return (
    <div className="workbench screen">
      <Sidebar onOrder={() => setAgentModal('order')} onAdd={() => setAgentModal('add')} />
      {children}
      <AgentModals kind={agentModal} onClose={() => setAgentModal(null)} />
    </div>
  )
}
