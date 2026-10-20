// 开发验证钩子：由截图驱动脚本（main 的 --shots 模式）经 executeJavaScript 调用
// 仅暴露显式界面动作与状态读取，不含任何敏感操作
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import type { AgentConfig } from '@shared/types'

export function installDebugHooks() {
  const w = window as unknown as Record<string, unknown>
  w.__ahub_debug = {
    // 场景跳转
    brand: () => useUi.getState().setScreen('brand'),
    workbench: () => {
      useSettings.getState().patchPrefs({ lastMode: 'workbench' })
      useUi.getState().setScreen('workbench')
    },
    workflow: () => {
      useSettings.getState().patchPrefs({ lastMode: 'workflow' })
      useUi.getState().setScreen('workflow')
    },
    settings: () => useUi.getState().openSettings(),
    // 启动一次演示任务（使用当前配置；默认为种子演示 Agent）
    startDemoTask: async (goal = '构建一个登录页面：包含邮箱密码校验、错误提示与设计规范') => {
      const wf = useWorkflow.getState()
      wf.setDraft(goal)
      await wf.start()
    },
    // 人工确认门：通过并交付
    passGate: () => void useWorkflow.getState().confirmGate('deliver'),
    stopTask: () => useWorkflow.getState().stop('user'),
    // 状态读取（校验用）
    state: () => ({
      screen: useUi.getState().screen,
      agents: useAgents.getState().agents.map((a: AgentConfig) => ({ name: a.name, kind: a.kind, status: a.status })),
      run: useWorkflow.getState().run
        ? {
            status: useWorkflow.getState().run!.status,
            stage: useWorkflow.getState().run!.stage,
            round: useWorkflow.getState().run!.round,
            cards: useWorkflow.getState().run!.cards.length,
            demo: useWorkflow.getState().run!.demo
          }
        : null
    })
  }
}
