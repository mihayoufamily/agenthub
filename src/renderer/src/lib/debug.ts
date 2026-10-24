// 开发验证钩子：由截图驱动脚本（main 的 --shots 模式）经 executeJavaScript 调用
// 仅暴露显式界面动作与状态读取，不含任何敏感操作
import { useUi } from '../stores/ui'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { useSessions } from '../stores/sessions'
import { useSettings } from '../stores/settings'
import { useApprovals } from '../stores/approvals'
import { bridge } from '../lib/ipc'
import type { AgentConfig, McpServer } from '@shared/types'

export function installDebugHooks() {
  const w = window as unknown as Record<string, unknown>
  /**
   * mock 模型 Agent 绑三角色并起一个真实工作流任务（走本地 mock 服务，不烧真实额度）。
   * startMockToolTask 与 startPlanTask 共用这一条路，只差 planFirst 一个开关——
   * 复制一份就会有两处"怎么起一个 mock 任务"的口径，改一边忘一边。
   */
  const startMockTask = async (baseUrl: string, dir: string, goal: string, planFirst: boolean) => {
    const store = useAgents.getState()
    const r = await store.addCustomModelAgent(
      { provider: 'Mock', baseUrl, modelId: 'mock-model' },
      'mock-key'
    )
    if (!r.ok || !r.agent) throw new Error(`mock Agent 添加失败：${r.message}`)
    store.updateAgent(r.agent.id, { name: 'Mock 工具验证', tools: { dir, allowCommands: false } })
    const agent = useAgents.getState().agents.find((a) => a.id === r.agent!.id)!
    const mk = () => ({ agentId: agent.id, agentName: agent.name, model: agent.model })
    useWorkflow.getState().patchConfig({
      planner: mk(),
      executor: mk(),
      reviewer: mk(),
      reviewMode: 'human',
      confirmEveryRound: true,
      planFirst
    })
    const wf = useWorkflow.getState()
    wf.setDraft(goal)
    void wf.start()
    return { agentId: agent.id }
  }
  w.__ahub_debug = {
    // 场景跳转（验证专用：不写 lastMode，避免污染用户"恢复上次工作区"的偏好）
    brand: () => useUi.getState().setScreen('brand'),
    workbench: () => {
      useUi.getState().setScreen('workbench')
    },
    workflow: () => {
      useUi.getState().setScreen('workflow')
    },
    // 设置页入口只有一个名字：openSettings(section?)。
    // （评审 Minor ㉘：这里原本还并存一个 `settings: () => openSettings()` 别名，语义完全相同，
    //   让"打开设置"在验证脚本里看起来有两种动作。修复波 B 已把 4 处调用统一到 openSettings 并删掉别名。）
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
      // planFirst 显式关掉：这条入口要的是"完整跑一条 CLI 执行链"，而计划态会把任务停在批准门上，
      // 于是"产物真实落盘"那半永远等不到（2026-10-24 实测红在这里，红的是用户当时开着全局计划态）。
      useWorkflow.getState().patchConfig({ planner: mk(), executor: mk(), reviewer: mk(), reviewMode: 'human', confirmEveryRound: true, planFirst: false })
      const wf = useWorkflow.getState()
      wf.setDraft(goal)
      void wf.start()
      return { agentId: agent.id, name: agent.name, added }
    },
    // 人工确认门：通过并交付
    passGate: () => void useWorkflow.getState().confirmGate('deliver'),
    /** 应用菜单加速键清单（验证 Ctrl+R 刷新 / Ctrl+Shift+I 这类默认键已不再注册） */
    menuSummary: async () => await bridge.app.menuSummary(),
    /** 兼容模式事实（真机断言徽章正反两向用）：读的是主进程的实际状态，不是配置 */
    compat: async () => await bridge.app.compat(),
    /**
     * 显式置位/清除「发现新版本」横幅（真机断言用：徽章必须不被它盖住）。
     * 与 App.tsx 启动时那次静默更新检查走的是**同一个** store 动作，不是另造一条状态——
     * 断言要验的就是真实那条路径下的层叠结果。传 null 清除。
     */
    setUpdateBanner: (b: { version: string; url: string } | null) => {
      useUi.getState().setUpdateBanner(b)
      return useUi.getState().updateBanner
    },
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
    /**
     * 验证脚本用：把视图从"已打开的任务"切回工作流首页。应用一启动会恢复上次打开的任务，
     * 那时首页的 composer 根本不在 DOM 里——首页布局断言于是量不到东西（量的不是产品问题）。
     * 只改视图，不动 runs/ 落盘记录；返回之前打开的任务 id，套件收尾时用它把视图还原回去。
     */
    closeTask: () => {
      const prev = useWorkflow.getState().run?.id ?? ''
      useWorkflow.getState().newTask()
      return { prev, now: useWorkflow.getState().run?.id ?? '' }
    },
    stopTask: () => useWorkflow.getState().stop('user'),
    /** 「以此为目标开新任务」（修订入口）：真机断言用它带出 _carryOver，验计划轮真的看得到上一任务结论 */
    continueModify: () => {
      useWorkflow.getState().continueModify()
      return { draft: useWorkflow.getState().draft.slice(0, 24), runCleared: useWorkflow.getState().run === null }
    },
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
    // 设置页直达（验证脚本用；section 传 'mcp' 等分区名）
    openSettings: (section?: string) => useUi.getState().openSettings(section),
    closeSettings: () => useUi.getState().closeSettings(),
    // MCP 真机断言用薄封装：直接转 bridge.mcp.set / bridge.mcp.probe（走真实 IPC，不碰主进程内部）
    // set 之后关一次再开设置页：McpSection 只在挂载时拉 mcp:list，设置页开着改完必须重挂才看得到新列表
    setMcpServers: async (list: McpServer[]) => {
      const r = await bridge.mcp.set(list)
      const ui = useUi.getState()
      ui.closeSettings()
      await new Promise((res) => setTimeout(res, 80))
      useUi.getState().openSettings('mcp')
      return r.list
    },
    probeMcp: (server: McpServer) => bridge.mcp.probe(server),
    // 导入往返：读当前配置 → 合入 patch → 走真导入路径（store.importConfig）→ 回读整份配置。
    // 写的是开发机上真实的 config.json，验证脚本必须先快照、并在 finally 按字节还原
    configRoundTrip: async (patch: Record<string, unknown>) => {
      const cur = await bridge.config.get()
      const merged = { ...cur, ...patch }
      const r = await bridge.config.importJson(JSON.stringify(merged))
      const after = await bridge.config.get()
      return { import: r, config: after }
    },
    // 工作流产物目录（验证用：设置与还原，避免验证后把用户配置留在测试目录）
    setWorkflowOutputDir: (dir: string) => {
      useWorkflow.getState().patchConfig({ outputDir: dir })
      return dir
    },
    /**
     * 验证脚本用：把三角色**显式绑到指定 Agent**（跨厂商真跑要用它，而不是断言"用户当前正好这么绑"）。
     * 用户点一下角色条就会换绑定，靠现状当基线的套件会恒红、且红的不是被测代码。
     */
    setRoles: (ids: { planner: string; executor: string; reviewer: string }) => {
      const mk = (id: string) => {
        const a = useAgents.getState().agents.find((x) => x.id === id)
        return a ? { agentId: a.id, agentName: a.name, model: a.model } : null
      }
      const p = mk(ids.planner)
      const e = mk(ids.executor)
      const r = mk(ids.reviewer)
      if (!p || !e || !r) return { ok: false, message: '有角色 id 在当前 agents 里找不到（可能已被删除）' }
      useWorkflow.getState().patchConfig({ planner: p, executor: e, reviewer: r, reviewMode: 'human' })
      return { ok: true, planner: p, executor: e, reviewer: r }
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
    startMockToolTask: (baseUrl: string, dir: string, goal: string) => startMockTask(baseUrl, dir, goal, false),
    /**
     * 计划态真机验证（批次 F）：同上，但 config.planFirst = true——
     * 开工先跑一轮只读规划、挂计划批准门，批准后同一个 run 从执行角色续跑。
     */
    startPlanTask: (baseUrl: string, dir: string, goal: string) => startMockTask(baseUrl, dir, goal, true),
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
      agents: useAgents.getState().agents.map((a: AgentConfig) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        status: a.status,
        // 套件按"哪个厂商的 CLI"挑角色时要能看出来（原先只有 name，等于逼脚本猜用户自填的显示名）
        cli: a.cliConfig?.cli ?? '',
        model: a.model ?? ''
      })),
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
            // 确认门要能被验证脚本看见：以前只暴露 status，脚本只能猜"waiting_user 大概是到门了"
            gate: !!useWorkflow.getState().run!.gate,
            // 门的种类与计划正文：计划批准门与审核门都是 waiting_user + gate=true，
            // 布尔值分不出这两种，断言"挂出来的是计划门"就必须读这个
            gateKind: useWorkflow.getState().run!.gate?.kind ?? null,
            // 这条任务是不是按 planFirst 起的（批准门旁路的判定就看它，排查时也要能直接读）
            runPlanFirst: useWorkflow.getState().run!.planFirst ?? false,
            planTextLen: (useWorkflow.getState().run!.planText ?? '').length,
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
