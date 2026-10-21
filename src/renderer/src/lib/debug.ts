// 开发验证钩子：由截图驱动脚本（main 的 --shots 模式）经 executeJavaScript 调用
// 仅暴露显式界面动作与状态读取，不含任何敏感操作
import { useUi } from '../stores/ui'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import type { AgentConfig } from '@shared/types'

export function installDebugHooks() {
  const w = window as unknown as Record<string, unknown>
  w.__ahub_debug = {
    // 场景跳转（验证专用：不写 lastMode，避免污染用户"恢复上次工作区"的偏好）
    brand: () => useUi.getState().setScreen('brand'),
    workbench: () => {
      useUi.getState().setScreen('workbench')
    },
    workflow: () => {
      useUi.getState().setScreen('workflow')
    },
    settings: () => useUi.getState().openSettings(),
    // 启动一次演示任务（使用当前配置；默认为种子演示 Agent）
    startDemoTask: async (goal = '构建一个登录页面：包含邮箱密码校验、错误提示与设计规范') => {
      const wf = useWorkflow.getState()
      wf.setDraft(goal)
      await wf.start()
    },
    // 真实 CLI 闭环验证：添加 arkcli Agent 并绑定三角色，启动一个真实工作流任务
    // reviewMode=human + confirmEveryRound=true：第 1 轮审核后必停人工确认门，便于验证脚本驱动 passGate；
    // start() fire-and-forget：状态经 state() 轮询（await 会阻塞到整个运行结束）
    startArkcliTask: async (goal = '用一两句话说明什么是工作流模式，并给一条验收标准') => {
      const store = useAgents.getState()
      let agent = store.agents.find((a) => a.kind === 'cli' && a.cliConfig?.cli === 'arkcli')
      if (!agent) {
        const r = await store.addCliAgent('arkcli')
        if (!r.ok || !r.agent) throw new Error(`arkcli Agent 添加失败：${r.message}`)
        agent = r.agent
      }
      const mk = () => ({ agentId: agent!.id, agentName: agent!.name, model: agent!.model })
      useWorkflow.getState().patchConfig({ planner: mk(), executor: mk(), reviewer: mk(), reviewMode: 'human', confirmEveryRound: true })
      const wf = useWorkflow.getState()
      wf.setDraft(goal)
      void wf.start()
    },
    // 人工确认门：通过并交付
    passGate: () => void useWorkflow.getState().confirmGate('deliver'),
    stopTask: () => useWorkflow.getState().stop('user'),
    // 添加指向本地 mock OpenAI 兼容服务的模型 Agent 并授予工具权限（端到端工具验证专用）
    addMockToolAgent: async (baseUrl: string, dir: string, allowCommands: boolean) => {
      const store = useAgents.getState()
      const r = await store.addCustomModelAgent(
        { provider: 'Mock', baseUrl, modelId: 'mock-model' },
        'mock-key'
      )
      if (!r.ok || !r.agent) throw new Error(`mock Agent 添加失败：${r.message}`)
      store.updateAgent(r.agent.id, { name: 'Mock 工具验证', tools: { dir, allowCommands } })
      store.select(r.agent.id)
      return r.agent.id
    },
    // 按名称删除 Agent（验证清理用）
    removeAgentByName: (name: string) => {
      const a = useAgents.getState().agents.find((x) => x.name === name)
      if (!a) return false
      void useAgents.getState().removeAgent(a.id, { deleteHistory: true })
      return true
    },
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
