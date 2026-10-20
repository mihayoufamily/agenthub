// 工作流引擎与状态：三角色循环（规划→执行→审核→规划判断）、返工上限、停止条件、人工确认门
// 执行状态与页面动画状态完全解耦；重绘/切换不重复提交任务（提交只经 start() 一次）
import { create } from 'zustand'
import type {
  WorkflowRun, WorkflowConfig, RoleCard, Stage, ReviewGate,
  Attachment, ChecklistItem, ProcessEvent, MemoryEntry
} from '@shared/types'
import { bridge } from '../lib/ipc'
import { uid, chunkText, sleep, clamp } from '../lib/utils'
import { useUi } from './ui'
import { useSettings } from './settings'
import { useAgents } from './agents'
import {
  demoPlanConclusion, demoPlanChecklist, demoExecuteConclusion, demoExecuteProcess,
  demoArtifacts, demoReviewConclusion, demoReviewChecklist, demoDeliveryConclusion, demoFailureNote
} from '../lib/demo'

interface WorkflowState {
  draft: string
  attachments: Attachment[]
  config: WorkflowConfig
  run: WorkflowRun | null
  /** 引擎内部控制（不参与渲染） */
  _cancelled: boolean
  _started: boolean

  setDraft: (t: string) => void
  setAttachments: (a: Attachment[]) => void
  patchConfig: (p: Partial<WorkflowConfig>) => void
  resolveRoles: () => void
  validate: () => string | null

  start: () => Promise<void>
  stop: (reason: 'user' | 'timeout') => void
  confirmGate: (action: 'deliver' | 'rework' | 'stop', feedback?: string) => Promise<void>
  supplement: (text: string) => void
  continueModify: () => void
  newTask: () => void
  exportRun: () => Promise<void>
  restore: () => Promise<void>
  saveRun: () => void
  isDemoRun: () => boolean
}

function makeCard(role: RoleCard['role'], round: number, cfg: WorkflowConfig, demo: boolean): RoleCard {
  const roleName = role === 'planner' ? cfg.planner : role === 'executor' ? cfg.executor : cfg.reviewer
  return {
    id: uid('card'),
    role,
    agentName: roleName.agentName,
    model: roleName.model,
    round,
    status: 'streaming',
    title: role === 'planner' ? '规划' : role === 'executor' ? '执行' : '审核',
    conclusion: '',
    process: [],
    demo,
    ts: Date.now()
  }
}

function updateCard(cards: RoleCard[], cardId: string, patch: Partial<RoleCard>): RoleCard[] {
  return cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c))
}

function appendProcess(cards: RoleCard[], cardId: string, ev: ProcessEvent): RoleCard[] {
  return cards.map((c) => (c.id === cardId ? { ...c, process: [...c.process, ev] } : c))
}

/** 流式追加文本到卡片结论 */
async function streamToCard(
  run: WorkflowRun,
  cardId: string,
  text: string,
  set: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  isCancelled: () => boolean
) {
  for (const chunk of chunkText(text, 6)) {
    if (isCancelled()) return
    await sleep(20)
    set((r) => ({ ...r, cards: updateCard(r.cards, cardId, { conclusion: r.cards.find((c) => c.id === cardId)!.conclusion + chunk }) }))
  }
}

export const useWorkflow = create<WorkflowState>()((set, get) => ({
  draft: '',
  attachments: [],
  config: {
    planner: { agentId: '', agentName: '未配置', model: '—' },
    executor: { agentId: '', agentName: '未配置', model: '—' },
    reviewer: { agentId: '', agentName: '未配置', model: '—' },
    reviewMode: 'human',
    maxRounds: 3,
    timeoutMin: 30,
    confirmEveryRound: false
  },
  run: null,
  _cancelled: false,
  _started: false,

  setDraft: (t) => set({ draft: t }),
  setAttachments: (a) => set({ attachments: a }),
  patchConfig: (p) => {
    set((s) => ({ config: { ...s.config, ...p } }))
    void bridge.config.setWorkflowDefaults({
      plannerAgentId: get().config.planner.agentId,
      executorAgentId: get().config.executor.agentId,
      reviewerAgentId: get().config.reviewer.agentId,
      reviewMode: get().config.reviewMode,
      maxRounds: get().config.maxRounds,
      timeoutMin: get().config.timeoutMin,
      confirmEveryRound: get().config.confirmEveryRound
    })
  },

  resolveRoles: () => {
    const agents = useAgents.getState().agents
    const pick = (id: string) => agents.find((a) => a.id === id)
    const s = get().config
    const resolved: WorkflowConfig = {
      ...s,
      planner: s.planner.agentId && pick(s.planner.agentId)
        ? { agentId: s.planner.agentId, agentName: pick(s.planner.agentId)!.name, model: pick(s.planner.agentId)!.model }
        : s.planner,
      executor: s.executor.agentId && pick(s.executor.agentId)
        ? { agentId: s.executor.agentId, agentName: pick(s.executor.agentId)!.name, model: pick(s.executor.agentId)!.model }
        : s.executor,
      reviewer: s.reviewer.agentId && pick(s.reviewer.agentId)
        ? { agentId: s.reviewer.agentId, agentName: pick(s.reviewer.agentId)!.name, model: pick(s.reviewer.agentId)!.model }
        : s.reviewer
    }
    set({ config: resolved })
  },

  validate: () => {
    get().resolveRoles()
    const c = get().config
    if (!c.planner.agentId) return '规划角色未选择 Agent'
    if (!c.executor.agentId) return '执行角色未选择 Agent'
    if (!c.reviewer.agentId) return '审核角色未选择 Agent'
    const agents = useAgents.getState().agents
    for (const roleId of [c.planner.agentId, c.executor.agentId, c.reviewer.agentId]) {
      const a = agents.find((x) => x.id === roleId)
      if (!a) return '配置引用了不存在的 Agent，请重新选择'
      if (a.kind === 'demo' && !a.isDemo) return `Agent「${a.name}」尚未完成连接（仅发现未接入），不能参与执行`
      if (a.kind === 'model' && a.status !== 'available') return `模型 Agent「${a.name}」连接不可用，请先完成连接测试`
    }
    return null
  },

  isDemoRun: () => {
    const agents = useAgents.getState().agents
    const c = get().config
    return [c.planner.agentId, c.executor.agentId, c.reviewer.agentId].every((id) => {
      const a = agents.find((x) => x.id === id)
      return a?.isDemo === true
    })
  },

  saveRun: () => {
    const run = get().run
    if (run) void bridge.runs.save(run)
  },

  start: async () => {
    if (get()._started) return // 防重复提交
    const goal = get().draft.trim()
    if (!goal) {
      useUi.getState().toast('请先描述任务目标', 'warn')
      return
    }
    const problem = get().validate()
    if (problem) {
      useUi.getState().toast(`无法开始：${problem}`, 'error')
      return
    }

    const demo = get().isDemoRun()
    const cfg = { ...get().config }
    const run: WorkflowRun = {
      id: uid('run'),
      goal,
      status: 'preparing',
      stage: 'planning',
      round: 1,
      maxRounds: cfg.maxRounds,
      reviewMode: cfg.reviewMode,
      startedAt: Date.now(),
      cards: [],
      demo
    }
    set({ run, _cancelled: false, _started: true })
    useSettings.getState().addMemory('goal', `任务目标：${goal}`, false)
    get().saveRun()

    const setRun = (fn: (r: WorkflowRun) => WorkflowRun) => set((s) => (s.run ? { run: fn(s.run) } : {}))
    const isCancelled = () => get()._cancelled

    // 超时看门狗
    const timeoutMs = cfg.timeoutMin * 60 * 1000
    const watchdog = setTimeout(() => {
      if (get()._started && !isCancelled() && ['preparing', 'running', 'waiting_review'].includes(get().run?.status ?? '')) {
        get().stop('timeout')
      }
    }, timeoutMs)

    try {
      setRun((r) => ({ ...r, status: 'running' }))
      let round = 1
      while (round <= cfg.maxRounds) {
        if (isCancelled()) return
        // ---------- 规划 ----------
        setRun((r) => ({ ...r, stage: 'planning', round }))
        const pCard = makeCard('planner', round, cfg, demo)
        setRun((r) => ({ ...r, cards: [...r.cards, pCard] }))
        await streamToCard(get().run!, pCard.id, demoPlanConclusion(goal, round), setRun, isCancelled)
        if (isCancelled()) return
        setRun((r) => ({ ...r, cards: updateCard(r.cards, pCard.id, { checklist: demoPlanChecklist(goal, round), status: 'done' }) }))
        get().saveRun()

        // ---------- 执行 ----------
        setRun((r) => ({ ...r, stage: 'executing' }))
        const eCard = makeCard('executor', round, cfg, demo)
        setRun((r) => ({ ...r, cards: [...r.cards, eCard] }))
        const evs = demoExecuteProcess(round)
        for (const ev of evs) {
          if (isCancelled()) return
          await sleep(160)
          setRun((r) => ({ ...r, cards: appendProcess(r.cards, eCard.id, ev) }))
        }
        await streamToCard(get().run!, eCard.id, demoExecuteConclusion(round), setRun, isCancelled)
        if (isCancelled()) return
        setRun((r) => ({ ...r, cards: updateCard(r.cards, eCard.id, { artifacts: demoArtifacts(round), status: 'done' }) }))
        get().saveRun()

        // ---------- 审核 ----------
        setRun((r) => ({ ...r, stage: 'reviewing', status: 'waiting_review' }))
        const rCard = makeCard('reviewer', round, cfg, demo)
        setRun((r) => ({ ...r, cards: [...r.cards, rCard] }))
        await streamToCard(get().run!, rCard.id, demoReviewConclusion(round, cfg.maxRounds), setRun, isCancelled)
        if (isCancelled()) return
        const verdicts = demoReviewChecklist(round)
        const passed = verdicts.every((v) => v.verdict === 'pass')
        setRun((r) => ({ ...r, cards: updateCard(r.cards, rCard.id, { checklist: verdicts, status: 'done' }) }))
        get().saveRun()
        useSettings.getState().addMemory('review', `第 ${round} 轮审核：${passed ? '通过' : '存在返工项'}`, false)

        // ---------- 规划判断 ----------
        if (passed) {
          // 人工确认门：默认最终交付前确认；confirmEveryRound 在每轮审核后都停
          if (cfg.reviewMode === 'human') {
            const gate: ReviewGate = {
              id: uid('gate'),
              round,
              passed: verdicts.filter((v) => v.verdict === 'pass'),
              issues: verdicts.filter((v) => v.verdict === 'issue')
            }
            setRun((r) => ({ ...r, status: 'waiting_user', gate }))
            get().saveRun()
            return // 等待用户决定
          }
          // 自动审核：直接交付
          await deliver(setRun, isCancelled, get)
          return
        }

        // 不通过 → 每轮确认模式下先等用户
        if (cfg.reviewMode === 'human' && cfg.confirmEveryRound && round < cfg.maxRounds) {
          const gate: ReviewGate = {
            id: uid('gate'),
            round,
            passed: verdicts.filter((v) => v.verdict === 'pass'),
            issues: verdicts.filter((v) => v.verdict === 'issue'),
            reworkFeedback: '审核建议：修正样式细节后进入下一轮'
          }
          setRun((r) => ({ ...r, status: 'waiting_user', gate }))
          get().saveRun()
          return
        }

        if (round >= cfg.maxRounds) {
          // 返工上限：保留成果，说明未完成项，等待用户决定
          setRun((r) => ({
            ...r,
            status: 'rework_limit',
            stage: null,
            notes: [...(r.notes ?? []), `已达最大返工轮数（${cfg.maxRounds}），保留现有成果；未完成项：${verdicts.filter((v) => v.verdict === 'issue').map((v) => v.text).join('；')}`]
          }))
          get().saveRun()
          useUi.getState().toast('已达最大返工轮数，保留成果等待你的决定', 'warn')
          return
        }
        round += 1
        setRun((r) => ({ ...r, round }))
      }
    } finally {
      clearTimeout(watchdog)
      set({ _started: false })
    }
  },

  stop: (reason) => {
    const run = get().run
    if (!run) return
    set({ _cancelled: true })
    const status = reason === 'timeout' ? 'failed' : 'cancelled'
    set((s) => ({
      run: s.run ? { ...s.run, status, stage: null, endedAt: Date.now(), cards: s.run.cards.map((c) => (c.status === 'streaming' ? { ...c, status: 'error' } : c)) } : null
    }))
    get().saveRun()
    useUi.getState().toast(reason === 'timeout' ? `任务超时（${get().config.timeoutMin} 分钟），已停止` : '任务已停止：已保存的记录与产物引用会保留', reason === 'timeout' ? 'error' : 'info')
  },

  confirmGate: async (action, feedback) => {
    const run = get().run
    const cfg = get().config
    if (!run || run.status !== 'waiting_user' || !run.gate) return

    if (action === 'stop') {
      get().stop('user')
      return
    }
    if (action === 'rework') {
      useSettings.getState().addMemory('confirm', `用户返工意见：${feedback || '（未填写）'}`, false)
      const nextRound = clamp(run.round + 1, 1, cfg.maxRounds)
      set((s) => ({
        run: s.run ? { ...s.run, gate: undefined, status: 'running', round: nextRound, notes: [...(s.run.notes ?? []), `第 ${run.round} 轮返工意见：${feedback || '（未填写）'}`] } : null
      }))
      get().saveRun()
      // 简化：v1 由引擎的 while 循环无法从外部续跑，返工通过重新驱动完成
      void resumeRework(get, set)
      return
    }
    // deliver
    useSettings.getState().addMemory('confirm', '用户确认通过并交付', false)
    const setRun = (fn: (r: WorkflowRun) => WorkflowRun) => set((s) => (s.run ? { run: fn(s.run) } : {}))
    await deliver(setRun, () => false, get)
  },

  supplement: (text) => {
    const run = get().run
    if (!run) return
    // 补充要求在"下一轮"生效，不悄悄修改已执行步骤
    set((s) => ({
      run: s.run ? { ...s.run, notes: [...(s.run.notes ?? []), `补充要求（下一轮生效）：${text}`] } : null
    }))
    useSettings.getState().addMemory('decision', `补充要求：${text}`, false)
    get().saveRun()
    useUi.getState().toast('补充要求已记录，将在下一轮生效', 'ok')
  },

  continueModify: () => {
    const run = get().run
    if (!run) return
    // 沿用现有上下文创建下一次修订，不覆盖原交付记录
    set({ draft: `继续修改：${run.goal}`, run: null, _cancelled: false })
    useUi.getState().toast('已进入新的修订（沿用上下文），原交付记录保留', 'ok')
  },

  newTask: () => {
    set({ draft: '', attachments: [], run: null, _cancelled: false })
  },

  exportRun: async () => {
    const run = get().run
    if (!run) return
    const lines: string[] = [
      `# AgentHub 任务记录`,
      ``,
      `- 目标：${run.goal}`,
      `- 状态：${run.status}`,
      `- 轮次：${run.round}/${run.maxRounds}`,
      `- 审核方式：${run.reviewMode === 'human' ? '人工确认' : '自动审核'}`,
      run.demo ? `- ⚠ 本任务为演示数据，不代表真实执行` : '',
      ``,
      ...run.cards.map((c) => `## [${c.title} · 第 ${c.round} 轮] ${c.agentName}\n\n${c.conclusion}\n`)
    ]
    const name = `agenthub-run-${run.id}.md`
    const r = await bridge.dialogs.saveFile(name, lines.filter(Boolean).join('\n'))
    useUi.getState().toast(r.ok ? `已导出到 ${r.message}` : '已取消导出', r.ok ? 'ok' : 'info')
  },

  restore: async () => {
    try {
      const runs = await bridge.runs.list()
      if (runs.length === 0) return
      const latest = runs[0]
      // 重启后恢复展示；运行中状态无法核对 → 标记 interrupted，绝不盲目重放
      if (['running', 'preparing', 'waiting_review'].includes(latest.status)) {
        const restored: WorkflowRun = { ...latest, status: 'interrupted', stage: null }
        set({ run: restored })
        useUi.getState().toast('已恢复上次任务记录；应用重启后执行状态未核对，不会自动继续执行', 'warn')
      }
    } catch { /* 恢复失败不阻塞 */ }
  }
}))

/** 交付卡片生成 */
async function deliver(
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  isCancelled: () => boolean,
  get: () => WorkflowState
) {
  const run = get().run
  if (!run) return
  setRun((r) => ({ ...r, stage: 'delivering', status: 'running' }))
  const dCard = makeCard('delivery', run.round, get().config, !!run.demo)
  dCard.title = '交付'
  dCard.status = 'streaming'
  setRun((r) => ({ ...r, cards: [...r.cards, dCard] }))
  await streamToCard(run, dCard.id, demoDeliveryConclusion(run.goal), setRun, isCancelled)
  const elapsed = Date.now() - run.startedAt
  setRun((r) => ({
    ...r,
    status: 'completed',
    stage: null,
    endedAt: Date.now(),
    usage: { elapsedMs: elapsed },
    cards: updateCard(r.cards, dCard.id, {
      status: 'done',
      checklist: demoReviewChecklist(999),
      artifacts: demoArtifacts(999)
    })
  }))
  get().saveRun()
  useSettings.getState().addMemory('progress', `任务完成：${run.goal}`, false)
}

/** 人工返工后续跑引擎（从当前轮次驱动执行→审核） */
async function resumeRework(
  get: () => WorkflowState,
  set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void
) {
  const state = get()
  const run = state.run
  const cfg = state.config
  if (!run) return
  const setRun = (fn: (r: WorkflowRun) => WorkflowRun) => set((s: WorkflowState) => (s.run ? { run: fn(s.run) } : {}))
  const isCancelled = () => get()._cancelled
  const round = run.round
  const demo = !!run.demo

  // 执行（返工）
  setRun((r) => ({ ...r, stage: 'executing', status: 'running' }))
  const eCard = makeCard('executor', round, cfg, demo)
  setRun((r) => ({ ...r, cards: [...r.cards, eCard] }))
  for (const ev of demoExecuteProcess(round)) {
    if (isCancelled()) return
    await sleep(140)
    setRun((r) => ({ ...r, cards: appendProcess(r.cards, eCard.id, ev) }))
  }
  await streamToCard(get().run!, eCard.id, demoExecuteConclusion(round), setRun, isCancelled)
  if (isCancelled()) return
  setRun((r) => ({ ...r, cards: updateCard(r.cards, eCard.id, { artifacts: demoArtifacts(round), status: 'done' }) }))
  get().saveRun()

  // 审核（复核）
  setRun((r) => ({ ...r, stage: 'reviewing', status: 'waiting_review' }))
  const rCard = makeCard('reviewer', round, cfg, demo)
  setRun((r) => ({ ...r, cards: [...r.cards, rCard] }))
  await streamToCard(get().run!, rCard.id, demoReviewConclusion(round, cfg.maxRounds), setRun, isCancelled)
  if (isCancelled()) return
  const verdicts = demoReviewChecklist(round)
  const passed = verdicts.every((v) => v.verdict === 'pass')
  setRun((r) => ({ ...r, cards: updateCard(r.cards, rCard.id, { checklist: verdicts, status: 'done' }) }))
  get().saveRun()

  if (passed) {
    if (cfg.reviewMode === 'human') {
      setRun((r) => ({
        ...r,
        status: 'waiting_user',
        gate: { id: uid('gate'), round, passed: verdicts, issues: [] }
      }))
      get().saveRun()
    } else {
      await deliver(setRun, isCancelled, get)
    }
  } else {
    if (round >= cfg.maxRounds) {
      setRun((r) => ({
        ...r,
        status: 'rework_limit',
        stage: null,
        notes: [...(r.notes ?? []), `已达最大返工轮数（${cfg.maxRounds}），保留现有成果等待用户决定`]
      }))
      get().saveRun()
    } else {
      useUi.getState().toast('返工后仍有问题项，详见审核卡片', 'warn')
      setRun((r) => ({ ...r, status: 'waiting_user', gate: { id: uid('gate'), round, passed: verdicts.filter((v) => v.verdict === 'pass'), issues: verdicts.filter((v) => v.verdict === 'issue'), reworkFeedback: '继续返工或停止任务' } }))
      get().saveRun()
    }
  }
}
