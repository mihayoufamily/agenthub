// 工作流引擎与状态：三角色循环（规划→执行→审核→规划判断）、返工上限、停止条件、人工确认门
// 执行状态与页面动画状态完全解耦；重绘/切换不重复提交任务（提交只经 start() 一次）
// 真实运行：角色为自定义模型 Agent 时经 model:chat 真实流式调用（结构化输出解析失败则降级纯文本）；
// 演示 Agent 的卡片走脚本内容并逐卡标注"演示"，绝不把脚本内容包装成真实执行。
import { create } from 'zustand'
import type {
  WorkflowRun, WorkflowConfig, RoleCard, Stage, ReviewGate,
  Attachment, ChecklistItem, ProcessEvent, AgentConfig
} from '@shared/types'
import { bridge } from '../lib/ipc'
import { uid, chunkText, sleep, clamp } from '../lib/utils'
import { useUi } from './ui'
import { useSettings } from './settings'
import { useAgents } from './agents'
import {
  demoPlanConclusion, demoPlanChecklist, demoExecuteConclusion, demoExecuteProcess,
  demoArtifacts, demoReviewConclusion, demoReviewChecklist, demoDeliveryConclusion
} from '../lib/demo'
import { type RunContext, type WorkflowRole, buildRoleMessages, parseRoleOutput } from '../lib/rolePrompts'

interface WorkflowState {
  draft: string
  attachments: Attachment[]
  config: WorkflowConfig
  run: WorkflowRun | null
  /** 引擎内部控制（不参与渲染） */
  _cancelled: boolean
  _started: boolean
  /** "继续修改"携带的上一任务上下文（start 时注入规划角色后清除） */
  _carryOver: string | null

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

/** 当前进行中的真实模型请求（stop 时取消） */
let activeModelReqId: string | null = null

function makeCard(role: RoleCard['role'], round: number, cfg: WorkflowConfig, demo: boolean): RoleCard {
  const roleName = role === 'planner' ? cfg.planner : role === 'executor' ? cfg.executor : role === 'reviewer' ? cfg.reviewer : cfg.planner
  return {
    id: uid('card'),
    role,
    agentName: roleName.agentName,
    model: roleName.model,
    round,
    status: 'streaming',
    title: role === 'planner' ? '规划' : role === 'executor' ? '执行' : role === 'reviewer' ? '审核' : '交付',
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

/** 流式追加文本到卡片结论（演示脚本用；真实流由模型事件直接驱动） */
async function streamToCard(
  run: WorkflowRun,
  cardId: string,
  text: string,
  set: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  isCancelled: () => boolean
) {
  for (const chunk of chunkText(text, 2)) {
    if (isCancelled()) return
    await sleep(30)
    set((r) => ({ ...r, cards: updateCard(r.cards, cardId, { conclusion: r.cards.find((c) => c.id === cardId)!.conclusion + chunk }) }))
  }
}

/** 从任务 notes 提取"补充要求（下一轮生效）" */
function extractSupplements(run: WorkflowRun | null): string[] {
  if (!run) return []
  const prefix = '补充要求（下一轮生效）：'
  return (run.notes ?? []).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length))
}

/** 单个角色阶段结果；null = 已取消或已失败（状态已更新，调用方直接返回） */
interface StageOutcome {
  conclusion: string
  checklist?: ChecklistItem[]
}

/**
 * 真实模型调用：流式写入指定卡片，返回完整文本。
 * 错误：置卡片 error + 任务 failed；取消：返回已收到的部分文本，由调用方检查 isCancelled。
 */
function modelChatToCard(
  agent: AgentConfig,
  system: string,
  user: string,
  cardId: string,
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const reqId = uid('req')
  activeModelReqId = reqId
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = (r: { ok: true; text: string } | { ok: false; message: string }) => {
      if (settled) return
      settled = true
      off()
      if (activeModelReqId === reqId) activeModelReqId = null
      resolve(r)
    }
    const off = bridge.models.onEvent((ev) => {
      if (ev.reqId !== reqId) return
      if (ev.type === 'delta' && ev.text) {
        text += ev.text
        setRun((r) => ({ ...r, cards: updateCard(r.cards, cardId, { conclusion: text }) }))
      } else if (ev.type === 'usage' && ev.usage?.tokens) {
        setRun((r) => ({ ...r, usage: { ...r.usage, tokens: (r.usage?.tokens ?? 0) + (ev.usage?.tokens ?? 0) } }))
      } else if (ev.type === 'error') {
        finish({ ok: false, message: ev.message ?? '未知错误' })
      } else if (ev.type === 'done') {
        finish({ ok: true, text })
      }
    })
    void bridge.models.chat(agent.modelConfig!, reqId, [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]).then((r: { ok: boolean }) => {
      // 主进程会通过 model:event 发送错误；此处兜底通道异常（无事件到达）的场景
      if (!r.ok) setTimeout(() => finish({ ok: false, message: '请求未能发起（详见主进程日志）' }), 400)
    }).catch(() => finish({ ok: false, message: 'IPC 调用失败' }))
  })
}

/** 执行一个角色阶段（演示 Agent 走脚本；真实模型走流式调用） */
async function runStage(
  role: WorkflowRole,
  round: number,
  cfg: WorkflowConfig,
  ctx: RunContext,
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  isCancelled: () => boolean,
  get: () => WorkflowState
): Promise<StageOutcome | null> {
  const roleCfg = role === 'planner' ? cfg.planner : role === 'executor' ? cfg.executor : cfg.reviewer
  const agent = useAgents.getState().agents.find((a) => a.id === roleCfg.agentId)
  const isDemoAgent = agent?.isDemo === true
  const stage: Stage = role === 'planner' ? 'planning' : role === 'executor' ? 'executing' : 'reviewing'
  setRun((r) => ({ ...r, stage, ...(role === 'reviewer' ? { status: 'waiting_review' as const } : {}) }))

  const card = makeCard(role, round, cfg, isDemoAgent)
  setRun((r) => ({ ...r, cards: [...r.cards, card] }))

  // ---- 演示 Agent：脚本化内容（卡片逐张标注"演示"） ----
  if (isDemoAgent) {
    if (role === 'planner') {
      const text = demoPlanConclusion(ctx.goal, round)
      await streamToCard(get().run!, card.id, text, setRun, isCancelled)
      if (isCancelled()) return null
      const checklist = demoPlanChecklist(ctx.goal, round)
      setRun((r) => ({ ...r, cards: updateCard(r.cards, card.id, { checklist, status: 'done' }) }))
      get().saveRun()
      return { conclusion: text, checklist }
    }
    if (role === 'executor') {
      for (const ev of demoExecuteProcess(round)) {
        if (isCancelled()) return null
        await sleep(250)
        setRun((r) => ({ ...r, cards: appendProcess(r.cards, card.id, ev) }))
      }
      const text = demoExecuteConclusion(round)
      await streamToCard(get().run!, card.id, text, setRun, isCancelled)
      if (isCancelled()) return null
      setRun((r) => ({ ...r, cards: updateCard(r.cards, card.id, { artifacts: demoArtifacts(round), status: 'done' }) }))
      get().saveRun()
      return { conclusion: text }
    }
    // reviewer
    const text = demoReviewConclusion(round, cfg.maxRounds)
    await streamToCard(get().run!, card.id, text, setRun, isCancelled)
    if (isCancelled()) return null
    const checklist = demoReviewChecklist(round)
    setRun((r) => ({ ...r, cards: updateCard(r.cards, card.id, { checklist, status: 'done' }) }))
    get().saveRun()
    return { conclusion: text, checklist }
  }

  // ---- 真实模型 Agent：流式调用 + 结构化解析 ----
  if (!agent?.modelConfig) {
    setRun((r) => ({ ...r, status: 'failed', stage: null, endedAt: Date.now() }))
    get().saveRun()
    useUi.getState().toast(`Agent「${roleCfg.agentName}」缺少模型配置，无法执行`, 'error')
    return null
  }
  const { system, user } = buildRoleMessages(role, ctx)
  const res = await modelChatToCard(agent, system, user, card.id, setRun)
  if (isCancelled()) return null
  if (!res.ok) {
    setRun((r) => ({
      ...r,
      status: 'failed',
      stage: null,
      endedAt: Date.now(),
      cards: updateCard(r.cards, card.id, { status: 'error' })
    }))
    get().saveRun()
    useUi.getState().toast(`「${agent.name}」请求失败：${res.message}`, 'error')
    useSettings.getState().addMemory('progress', `任务失败（${agent.name}）：${res.message}`, false)
    return null
  }
  const parsed = parseRoleOutput(res.text)
  if (parsed) {
    setRun((r) => ({ ...r, cards: updateCard(r.cards, card.id, { conclusion: parsed.conclusion, ...(parsed.checklist ? { checklist: parsed.checklist } : {}), status: 'done' }) }))
    get().saveRun()
    return { conclusion: parsed.conclusion, checklist: parsed.checklist }
  }
  // 解析失败：降级为纯文本结论（不伪造结构化清单）
  setRun((r) => ({ ...r, cards: updateCard(r.cards, card.id, { status: 'done' }) }))
  get().saveRun()
  return { conclusion: res.text }
}

/** 真实运行的交付结论（基于任务数据生成，不虚构） */
function buildDeliveryConclusion(run: WorkflowRun, verdicts: ChecklistItem[], execWasDemo: boolean): string {
  const pass = verdicts.filter((v) => v.verdict === 'pass').length
  const lines = [
    `任务"${run.goal}"在第 ${run.round} 轮完成。`,
    `\n验收：${pass}/${verdicts.length} 项通过（对照最后一轮审核结论）。`,
    `\n执行成果见上方执行卡片结论。`
  ]
  if (execWasDemo) lines.push('\n注意：执行角色为演示 Agent，其卡片内容为脚本数据。')
  lines.push('\n说明：当前工作流接入的模型为纯文本对话（无本机工具执行权限），未产生落盘产物；如需真实文件操作，请接入支持工具执行的 Agent。')
  return lines.join('')
}

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
  const lastReview = [...run.cards].reverse().find((c) => c.role === 'reviewer')
  const lastExec = [...run.cards].reverse().find((c) => c.role === 'executor')
  const conclusion = run.demo
    ? demoDeliveryConclusion(run.goal)
    : buildDeliveryConclusion(run, lastReview?.checklist ?? [], !!lastExec?.demo)
  await streamToCard(run, dCard.id, conclusion, setRun, isCancelled)
  const elapsed = Date.now() - run.startedAt
  setRun((r) => ({
    ...r,
    status: 'completed',
    stage: null,
    endedAt: Date.now(),
    usage: { ...r.usage, elapsedMs: elapsed },
    cards: updateCard(r.cards, dCard.id, {
      status: 'done',
      checklist: run.demo ? demoReviewChecklist(999) : (lastReview?.checklist ?? []),
      ...(run.demo ? { artifacts: demoArtifacts(999) } : {})
    })
  }))
  get().saveRun()
  useSettings.getState().addMemory('progress', `任务完成：${run.goal}`, false)
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
  _carryOver: null,

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
    const carryOver = get()._carryOver
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
    set({ run, _cancelled: false, _started: true, _carryOver: null })
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
      let prevReviewIssues: string[] = []
      while (round <= cfg.maxRounds) {
        if (isCancelled()) return
        const supplements = extractSupplements(get().run)
        const ctx: RunContext = {
          goal,
          round,
          maxRounds: cfg.maxRounds,
          ...(supplements.length ? { supplements } : {}),
          ...(carryOver ? { carryOver } : {}),
          ...(round > 1 && prevReviewIssues.length ? { prevReviewIssues } : {})
        }

        // ---------- 规划 ----------
        const plan = await runStage('planner', round, cfg, ctx, setRun, isCancelled, get)
        if (!plan) return
        ctx.planConclusion = plan.conclusion
        ctx.planChecklist = plan.checklist

        // ---------- 执行 ----------
        const exec = await runStage('executor', round, cfg, ctx, setRun, isCancelled, get)
        if (!exec) return
        ctx.execConclusion = exec.conclusion

        // ---------- 审核 ----------
        const review = await runStage('reviewer', round, cfg, ctx, setRun, isCancelled, get)
        if (!review) return
        const verdicts = review.checklist ?? []
        const passed = verdicts.length > 0 && verdicts.every((v) => v.verdict === 'pass')
        useSettings.getState().addMemory('review', `第 ${round} 轮审核：${verdicts.length === 0 ? '输出未结构化，转人工确认' : passed ? '通过' : '存在返工项'}`, false)
        get().saveRun()

        if (verdicts.length === 0) {
          // 审核输出无法逐项判定：不放行也不盲目返工，转人工确认
          setRun((r) => ({
            ...r,
            status: 'waiting_user',
            gate: {
              id: uid('gate'),
              round,
              passed: [],
              issues: [{ text: '审核输出未包含可解析的逐项结论，请人工核对后决定', done: false, verdict: 'issue' }],
              reworkFeedback: review.conclusion.slice(0, 200)
            }
          }))
          get().saveRun()
          return
        }

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
            reworkFeedback: review.conclusion.slice(0, 200) || '请参考审核卡片中的问题项'
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
        prevReviewIssues = verdicts.filter((v) => v.verdict === 'issue').map((v) => v.text)
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
    if (activeModelReqId) {
      bridge.models.cancel(activeModelReqId)
      activeModelReqId = null
    }
    const status = reason === 'timeout' ? 'timeout' : 'cancelled'
    set((s) => ({
      run: s.run ? {
        ...s.run,
        status,
        stage: null,
        endedAt: Date.now(),
        ...(reason === 'timeout' ? { notes: [...(s.run.notes ?? []), `任务超时（${get().config.timeoutMin} 分钟）已停止；已保存记录与成果引用`] } : {}),
        cards: s.run.cards.map((c) => (c.status === 'streaming' ? { ...c, status: 'error' } : c))
      } : null
    }))
    get().saveRun()
    useUi.getState().toast(
      reason === 'timeout' ? `任务超时（${get().config.timeoutMin} 分钟），已停止` : '任务已停止：已保存的记录与产物引用会保留',
      reason === 'timeout' ? 'warn' : 'info'
    )
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
      // v1 由独立协程续跑（执行→审核），返工意见注入真实角色上下文
      void resumeRework(get, set, feedback)
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
    const lastExec = [...run.cards].reverse().find((c) => c.role === 'executor')
    const lastReview = [...run.cards].reverse().find((c) => c.role === 'reviewer')
    const parts: string[] = []
    if (lastExec) parts.push(`上一任务最终执行结论：\n${lastExec.conclusion.slice(0, 800)}`)
    if (lastReview) parts.push(`最后一轮审核结论：\n${lastReview.conclusion.slice(0, 400)}`)
    set({ draft: `继续修改：${run.goal}`, run: null, _cancelled: false, _carryOver: parts.join('\n\n') })
    useUi.getState().toast('已进入新的修订（沿用上下文），原交付记录保留', 'ok')
  },

  newTask: () => {
    set({ draft: '', attachments: [], run: null, _cancelled: false, _carryOver: null })
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
      ...run.cards.map((c) => `## [${c.title} · 第 ${c.round} 轮] ${c.agentName}${c.demo ? '（演示数据）' : ''}\n\n${c.conclusion}\n`)
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

/** 人工返工后续跑引擎（从当前轮次驱动执行→审核；返工意见注入真实角色上下文） */
async function resumeRework(
  get: () => WorkflowState,
  set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void,
  feedback?: string
) {
  const state = get()
  const run = state.run
  const cfg = state.config
  if (!run) return
  const setRun = (fn: (r: WorkflowRun) => WorkflowRun) => set((s: WorkflowState) => (s.run ? { run: fn(s.run) } : {}))
  const isCancelled = () => get()._cancelled
  const round = run.round

  const lastPlan = [...run.cards].reverse().find((c) => c.role === 'planner')
  const lastExec = [...run.cards].reverse().find((c) => c.role === 'executor')
  const ctx: RunContext = {
    goal: run.goal,
    round,
    maxRounds: cfg.maxRounds,
    ...(feedback ? { reworkFeedback: feedback } : {}),
    supplements: extractSupplements(run),
    ...(lastPlan?.conclusion ? { planConclusion: lastPlan.conclusion } : {}),
    ...(lastPlan?.checklist?.length ? { planChecklist: lastPlan.checklist } : {}),
    ...(lastExec?.conclusion ? { execConclusion: lastExec.conclusion } : {})
  }

  // 执行（返工）
  const exec = await runStage('executor', round, cfg, ctx, setRun, isCancelled, get)
  if (!exec) return
  ctx.execConclusion = exec.conclusion

  // 审核（复核）
  const review = await runStage('reviewer', round, cfg, ctx, setRun, isCancelled, get)
  if (!review) return
  const verdicts = review.checklist ?? []
  const passed = verdicts.length > 0 && verdicts.every((v) => v.verdict === 'pass')
  get().saveRun()
  useSettings.getState().addMemory('review', `第 ${round} 轮返工后复核：${verdicts.length === 0 ? '输出未结构化，转人工确认' : passed ? '通过' : '存在返工项'}`, false)

  if (verdicts.length === 0) {
    setRun((r) => ({
      ...r,
      status: 'waiting_user',
      gate: {
        id: uid('gate'),
        round,
        passed: [],
        issues: [{ text: '审核输出未包含可解析的逐项结论，请人工核对后决定', done: false, verdict: 'issue' }],
        reworkFeedback: review.conclusion.slice(0, 200)
      }
    }))
    get().saveRun()
    return
  }

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
