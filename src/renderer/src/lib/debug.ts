// 开发验证钩子：由截图驱动脚本（main 的 --shots 模式）经 executeJavaScript 调用
// 仅暴露显式界面动作与状态读取，不含任何敏感操作
import { useUi } from '../stores/ui'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useApprovals } from '../stores/approvals'
import { bridge } from '../lib/ipc'
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
    // 真实 CLI 闭环验证：添加指定 CLI Agent 并绑定三角色，启动一个真实工作流任务
    // reviewMode=human + confirmEveryRound=true：第 1 轮审核后必停人工确认门，便于验证脚本驱动 passGate；
    // start() fire-and-forget：状态经 state() 轮询（await 会阻塞到整个运行结束）
    // 返回 agentId + 是否本次新增（脚本据此决定清理时能不能删——用户原有的 Agent 绝不能删）
    startCliTask: async (cliName = 'arkcli', goal = '用一两句话说明什么是工作流模式，并给一条验收标准') => {
      const store = useAgents.getState()
      let agent = store.agents.find((a) => a.kind === 'cli' && a.cliConfig?.cli === cliName)
      const added = !agent
      if (!agent) {
        const r = await store.addCliAgent(cliName as 'arkcli')
        if (!r.ok || !r.agent) throw new Error(`${cliName} Agent 添加失败：${r.message}`)
        agent = r.agent
      }
      const mk = () => ({ agentId: agent!.id, agentName: agent!.name, model: agent!.model })
      useWorkflow.getState().patchConfig({ planner: mk(), executor: mk(), reviewer: mk(), reviewMode: 'human', confirmEveryRound: true })
      const wf = useWorkflow.getState()
      wf.setDraft(goal)
      void wf.start()
      return { agentId: agent.id, name: agent.name, added }
    },
    // 人工确认门：通过并交付
    passGate: () => void useWorkflow.getState().confirmGate('deliver'),
    /** 应用菜单加速键清单（验证 Ctrl+R 刷新 / Ctrl+Shift+I 这类默认键已不再注册） */
    menuSummary: async () => await bridge.app.menuSummary(),
    // 预设与槽位（本轮需求 3/4 验证用）
    savePreset: (name: string) => {
      const p = useWorkflow.getState().savePreset(name)
      return p ? p.id : null
    },
    applyPreset: (id: string) => {
      useWorkflow.getState().applyPreset(id)
      return useWorkflow.getState().config.planner.agentId
    },
    deletePreset: (id: string) => useWorkflow.getState().deletePreset(id),
    openWfTask: (id: string) => {
      useWorkflow.getState().openTask(id)
      return useWorkflow.getState().run?.id ?? null
    },
    stopTask: () => useWorkflow.getState().stop('user'),
    /** 中断续跑 / 单角色重跑（编排能力验证用） */
    resumeInterrupted: () => {
      void useWorkflow.getState().resumeInterrupted()
      return true
    },
    rerunRole: (role: 'planner' | 'executor' | 'reviewer') => {
      useWorkflow.getState().rerunRole(role)
      return true
    },
    /** 卡片摘要（角色级技能与卡片张数断言用） */
    cardRoles: () => (useWorkflow.getState().run?.cards ?? []).map((c) => c.role),
    // 命令审批：待裁决队列 + 由脚本代替人点选（验证确认框真能拦住命令）
    approvals: () => useApprovals.getState().pending.map((p) => ({ id: p.id, command: p.command, reason: p.reason })),
    decideApproval: (id: string, decision: 'once' | 'always' | 'deny') => {
      void useApprovals.getState().decide(id, decision)
      return true
    },
    // 直接走一次沙箱工具（含命令审批链路），验证"没批准就不执行"
    execTool: (grant: Record<string, unknown>, tool: string, argsJson: string, checkpointId?: string) =>
      bridge.tools.exec(grant as never, tool, argsJson, checkpointId),
    checkpoint: async (id: string) => bridge.checkpoint.manifest(id),
    rollbackCheckpoint: (id: string) => bridge.checkpoint.rollback(id),
    approvalHistory: () => bridge.approval.history(50),
    approvalRules: (agentId?: string) => bridge.approval.rules(agentId),
    // 工作流产物目录（验证用：设置与还原，避免验证后把用户配置留在测试目录）
    setWorkflowOutputDir: (dir: string) => {
      useWorkflow.getState().patchConfig({ outputDir: dir })
      return dir
    },
    // 验证脚本清理用：把快照的整份配置原样写回，角色绑定/审核方式不留残留
    restoreWorkflowConfig: (cfg: Record<string, unknown>) => {
      useWorkflow.getState().patchConfig(cfg as never)
      return true
    },
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
    // 工作流工具 E2E：mock 模型 Agent（含文件工具授权）绑定三角色，跑一轮真实工作流（人工确认停门）
    startMockToolTask: async (baseUrl: string, dir: string, goal: string) => {
      const store = useAgents.getState()
      const r = await store.addCustomModelAgent(
        { provider: 'Mock', baseUrl, modelId: 'mock-model' },
        'mock-key'
      )
      if (!r.ok || !r.agent) throw new Error(`mock Agent 添加失败：${r.message}`)
      store.updateAgent(r.agent.id, { name: 'Mock 工具验证', tools: { dir, allowCommands: false } })
      const agent = useAgents.getState().agents.find((a) => a.id === r.agent!.id)!
      const mk = () => ({ agentId: agent.id, agentName: agent.name, model: agent.model })
      useWorkflow.getState().patchConfig({ planner: mk(), executor: mk(), reviewer: mk(), reviewMode: 'human', confirmEveryRound: true })
      const wf = useWorkflow.getState()
      wf.setDraft(goal)
      void wf.start()
    },
    // 批量添加演示 Agent（布局压力验证用：1/5/20 个 Agent 场景）
    addDemoAgents: (n: number) => {
      const store = useAgents.getState()
      for (let i = 0; i < Math.max(0, Math.min(n, 50)); i++) store.addDemoAgent()
      return useAgents.getState().agents.length
    },
    // 添加 arkcli Agent 并改名（CLI 工作目录 E2E 验证用；真实测试连接）
    addArkcliAgent: async () => {
      const store = useAgents.getState()
      const r = await store.addCliAgent('arkcli')
      if (!r.ok || !r.agent) throw new Error(`arkcli Agent 添加失败：${r.message}`)
      store.updateAgent(r.agent.id, { name: 'CLI 目录验证' })
      store.select(r.agent.id)
      return r.agent.id
    },
    // 按名称删除 Agent（验证清理用；等待持久化完成避免进程退出丢失）
    removeAgentByName: async (name: string) => {
      let n = 0
      for (;;) {
        const a = useAgents.getState().agents.find((x) => x.name === name)
        if (!a) break
        await useAgents.getState().removeAgent(a.id, { deleteHistory: true })
        n++
        if (n > 20) break
      }
      return n > 0
    },
    // 状态读取（校验用）
    state: () => ({
      screen: useUi.getState().screen,
      // 当前生效的自定义键位（验证脚本据此合成按键事件，不硬编码 Ctrl+M）
      keybindings: useSettings.getState().prefs?.keybindings ?? {},
      selectedId: useAgents.getState().selectedId,
      configOutputDir: useWorkflow.getState().config.outputDir ?? '',
      // 完整工作流配置快照（验证脚本据此还原用户原有绑定，不留残留）
      config: { ...useWorkflow.getState().config },
      // 任务列表与预设摘要（不限个数 + 历史回看）
      wf: {
        openRunId: useWorkflow.getState().run?.id ?? null,
        tasks: useWorkflow.getState().tasks.map((r) => ({ id: r.id, goal: r.goal.slice(0, 20), status: r.status, gate: !!r.gate })),
        presets: useWorkflow.getState().presets.map((p) => ({ id: p.id, name: p.name, executor: p.executor.agentId, executorModel: p.executor.model ?? null }))
      },
      // 运行中的流（E2E 等待流式结束用）：chat:<agentId> 键列表
      streamKeys: Object.keys(useSessions.getState().activeStreams),
      agents: useAgents.getState().agents.map((a: AgentConfig) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status })),
      // 多会话摘要（E2E 断言用）：agentId -> { sessions, activeId, titles, counts }
      sessions: Object.fromEntries(
        Object.entries(useSessions.getState().sessions).map(([agentId, list]) => [
          agentId,
          {
            count: list.length,
            activeId: useSessions.getState().activeOf[agentId] ?? null,
            titles: list.map((s) => s.title),
            counts: list.map((s) => s.messages.length),
            drafts: list.map((s) => s.draft)
          }
        ])
      ),
      run: useWorkflow.getState().run
        ? {
            id: useWorkflow.getState().run!.id,
            status: useWorkflow.getState().run!.status,
            stage: useWorkflow.getState().run!.stage,
            round: useWorkflow.getState().run!.round,
            cards: useWorkflow.getState().run!.cards.length,
            demo: useWorkflow.getState().run!.demo,
            outputDir: useWorkflow.getState().run!.outputDir ?? null,
            // 失败原因（含 CLI 进程启动失败）落在 notes，断言时要用
            notes: useWorkflow.getState().run!.notes ?? [],
            // 卡片级摘要（工具过程与产物断言用；产物带来源 tool/app）
            cardDetails: useWorkflow.getState().run!.cards.map((c) => ({
              role: c.role,
              process: c.process.map((p) => `${p.kind}:${p.text.slice(0, 60)}`),
              artifacts: c.artifacts?.map((a) => `${a.kind}:${a.name}${a.path ? `(${a.path})` : ''}[${a.by ?? '-'}]`)
            }))
          }
        : null
    })
  }
}
