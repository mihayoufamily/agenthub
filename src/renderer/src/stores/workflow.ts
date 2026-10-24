// 工作流引擎与状态：三角色循环（规划→执行→审核→规划判断）、返工上限、停止条件、人工确认门
// 执行状态与页面动画状态完全解耦；重绘/切换不重复提交任务（提交只经 start() 一次）
// 真实运行：角色为自定义模型 Agent 时经 model:chat 真实流式调用（结构化输出解析失败则降级纯文本）；
// 演示 Agent 的卡片走脚本内容并逐卡标注"演示"，绝不把脚本内容包装成真实执行。
import { create } from 'zustand'
import type {
  WorkflowRun, WorkflowConfig, WorkflowRoleConfig, RoleCard, Stage, ReviewGate,
  Attachment, ChecklistItem, ProcessEvent, AgentConfig, WorkflowPreset, PresetRole, Skill
} from '@shared/types'
import { unionSkillIds, partitionSkillsForInjection } from '@shared/skills-union'
import { dirDelta } from '@shared/dir-delta'
import { bridge } from '../lib/ipc'
import { renderConventionsBlock } from '@shared/conventions'
import { matchFileRef } from '@shared/acceptance'
import { memoryBlockFor } from '@shared/retrieval'
import { uid, chunkText, sleep, clamp, safeName } from '../lib/utils'
import { useUi } from './ui'
import { useSettings } from './settings'
import { useAgents } from './agents'
import {
  demoPlanConclusion, demoPlanChecklist, demoExecuteConclusion, demoExecuteProcess,
  demoArtifacts, demoReviewConclusion, demoReviewChecklist, demoDeliveryConclusion
} from '../lib/demo'
import { type RunContext, type WorkflowRole, type ExecutorCapability, buildRoleMessages, parseRoleOutput } from '../lib/rolePrompts'

/**
 * 工作目录的上下文块：项目约定原文 + 代码库概览。
 * 两个都是"关于这个目录的事实"，读不到就缺省，绝不为了凑内容编一段概览出来。
 */
async function dirContextBlock(dir?: string): Promise<string> {
  if (!dir) return ''
  const blocks: string[] = []
  try {
    const conv = renderConventionsBlock(await bridge.conv.read(dir))
    if (conv) blocks.push(conv)
  } catch { /* 约定文件读不到不干扰流程（多数目录本来就没有） */ }
  try {
    const map = await bridge.repomap.get(dir)
    if (map.text) blocks.push(map.text)
  } catch { /* 没地图不影响干活 */ }
  return blocks.join('\n\n')
}

interface WorkflowState {
  draft: string
  attachments: Attachment[]
  config: WorkflowConfig
  run: WorkflowRun | null
  /**
   * 全部工作流任务（含已完成/已停止的历史）：数据源就是 runs/ 落盘记录，
   * 所以"不限个数 + 退出保留进度 + 历史可回看"是同一件事，不需要另建一套存储。
   */
  tasks: WorkflowRun[]
  /** 预设：三角色用哪个 Agent / 哪个模型，一键套用 */
  presets: WorkflowPreset[]
  /** 引擎内部控制（不参与渲染） */
  _cancelled: boolean
  _started: boolean
  /** "继续修改"携带的上一任务上下文（start 时注入规划角色后清除） */
  _carryOver: string | null
  /**
   * 只对本次提交生效的计划态开关（不落盘）：全局开关在"工作流设置"里，
   * 但"这一次先出个计划"不该改动用户的全局配置——那是改完就忘了的隐性提权/降权。
   */
  planNextTask: boolean
  setPlanNextTask: (v: boolean) => void

  setDraft: (t: string) => void
  setAttachments: (a: Attachment[]) => void
  patchConfig: (p: Partial<WorkflowConfig>) => void
  resolveRoles: () => void
  validate: () => string | null
  /** 把当前三角色（含模型覆盖）存为一个预设；同名即覆盖更新 */
  savePreset: (name: string) => WorkflowPreset | null
  /** 套用预设：只改角色与模型，不动目标、产物目录与审核方式 */
  applyPreset: (id: string) => void
  deletePreset: (id: string) => void
  loadPresets: (list: WorkflowPreset[]) => void
  /** 重新拉取任务列表（落盘后与启动时） */
  refreshTasks: () => Promise<void>
  /** 打开某个任务回看/继续；正在执行时不许切 */
  openTask: (id: string) => void
  /** 删除任务（连同其落盘记录）；打开中的任务被删则回到新建态 */
  removeTask: (id: string) => Promise<void>

  start: () => Promise<void>
  stop: (reason: 'user' | 'timeout') => void
  /** 中断续跑：按已有卡片推断停在哪一步，从那一步之后继续（不重放已经发生过的调用） */
  resumeInterrupted: () => Promise<void>
  /** 单角色重跑：只重跑那一个角色，新增一张卡片，不动确认门与交付 */
  rerunRole: (role: WorkflowRole) => void
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

/**
 * 是否"正在执行"：引擎只有一个执行循环，所以跑着的时候不许切任务/新建。
 * 停在人工确认门（gate 已挂出）不算执行中——那时是空转等人点。
 */
export function runBusy(run: WorkflowRun | null): boolean {
  return !!run && !run.gate && ['preparing', 'running', 'waiting_review'].includes(run.status)
}

/** 同一次终态只提醒一次（saveRun 会被反复调用） */
let lastAnnounce = ''

/**
 * 后台跑完/停下/到确认门时发系统通知：用户可能已经切去别的应用，
 * 界面内的 toast 看不见。窗口聚焦时主进程自己跳过，不重复打扰。
 */
function announce(run: WorkflowRun) {
  // 门挂出时 status 是 `waiting_user`（`waiting_review` 是审核角色**正在跑**的那个状态），
  // 所以原先那句 `waiting_review && gate` 基本永远为假——不是"计划门不发通知"，是所有确认门都不发。
  const atGate = !!run.gate && (run.status === 'waiting_user' || run.status === 'waiting_review')
  const isPlanGate = run.gate?.kind === 'plan'
  const terminal = ['completed', 'failed', 'cancelled', 'timeout', 'rework_limit', 'token_limit', 'budget_limit'].includes(run.status)
  if (!atGate && !terminal) return
  const key = `${run.id}:${run.status}`
  if (key === lastAnnounce) return
  lastAnnounce = key
  const goal = run.goal.length > 18 ? run.goal.slice(0, 18) + '…' : run.goal
  const title = isPlanGate
    ? `等你批准计划：${goal}`
    : atGate
      ? `等你确认：${goal}`
      : run.status === 'completed'
        ? `已完成：${goal}`
        : run.status === 'failed'
          ? `失败：${goal}`
          : `已停止：${goal}`
  const body = isPlanGate
    ? '批准后任务才开始执行；不批准可以填意见重出一版计划'
    : atGate
      ? '回到 AgentHub 通过确认门，或填返工意见'
      : '在左侧「工作流」里点开查看结果与产物'
  void bridge.app.notify(title, body)
}

function makeCard(role: RoleCard['role'], round: number, cfg: WorkflowConfig, demo: boolean): RoleCard {
  const roleName = role === 'planner' ? cfg.planner : role === 'executor' ? cfg.executor : role === 'reviewer' ? cfg.reviewer : cfg.planner
  return {
    id: uid('card'),
    role,
    agentName: roleName.agentName,
    // 角色级模型覆盖优先展示：否则改了覆盖后卡片仍显示 Agent 默认模型，会误导（覆盖才是真实生效值）
    model: roleName.modelOverride ?? roleName.model,
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

/** 登记真实文件产物（同一路径只登记一次：write 后再 replace 不算新产物） */
function withFileArtifact(card: RoleCard, path: string, by: 'tool' | 'app'): RoleCard['artifacts'] {
  const list = card.artifacts ?? []
  if (list.some((a) => a.path === path)) return list
  return [...list, { id: uid('art'), name: path.split(/[\\/]/).pop() ?? path, kind: 'file', path, by }]
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
 * 真实 Agent 调用（自定义模型 / 本机 CLI）：流式写入指定卡片，返回完整文本。
 * 错误：置卡片 error + 任务 failed；取消：返回已收到的部分文本，由调用方检查 isCancelled。
 * Token 上限：opts.maxTokens > 0 且累计用量达到上限时，取消请求并标记 tokenLimit。
 */
function agentChatToCard(
  agent: AgentConfig,
  system: string,
  user: string,
  cardId: string,
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  opts?: { maxTokens?: number; modelOverride?: string; cliTimeoutMs?: number; workflow?: boolean; cliWorkDir?: string; checkpointId?: string; runId?: string; planMode?: boolean }
): Promise<{ ok: true; text: string } | { ok: false; message: string; tokenLimit?: boolean }> {
  const reqId = uid('req')
  activeModelReqId = reqId
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = (r: { ok: true; text: string } | { ok: false; message: string; tokenLimit?: boolean }) => {
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
      } else if (ev.type === 'reasoning' && ev.text) {
        // 思考增量进入当前角色卡片的过程区：连续增量并入同一条"思考"，
        // 一旦中间插入工具/日志（= 换了模型轮次）就另起一条，避免多轮思考黏成一段无法分段
        setRun((r) => {
          const cur = r.cards.find((c) => c.id === cardId)
          if (!cur) return r
          const process = [...cur.process]
          const last = process[process.length - 1]
          const entry: ProcessEvent = { kind: 'thinking', text: (last?.kind === 'thinking' ? last.text : '') + ev.text, ts: Date.now() }
          if (last?.kind === 'thinking') process[process.length - 1] = entry
          else process.push(entry)
          return { ...r, cards: updateCard(r.cards, cardId, { process }) }
        })
      } else if (ev.type === 'tool' && ev.toolCall) {
        // 工具调用如实进入卡片过程（同 id 替换：running→done 只留一条）；write_file 成功的真实产物登记为 artifacts
        const tc = ev.toolCall
        const argText = Object.entries(tc.args).map(([k, v]) => `${k}=${v.length > 80 ? v.slice(0, 80) + '…' : v}`).join(' ')
        const stateText = tc.status === 'running' ? '执行中' : tc.status === 'error' ? '失败' : '完成'
        setRun((r) => {
          const cur = r.cards.find((c) => c.id === cardId)
          if (!cur) return r
          const process = [...cur.process]
          const entry = { kind: 'tool' as const, id: tc.id, text: `[${tc.tool}] ${argText} → ${stateText}`, ts: Date.now() }
          const i = process.findIndex((p) => p.id === tc.id)
          if (i >= 0) process[i] = entry
          else process.push(entry)
          return {
            ...r,
            cards: updateCard(r.cards, cardId, {
              process,
              ...(ev.writtenPath ? { artifacts: withFileArtifact(cur, ev.writtenPath, 'tool') } : {})
            })
          }
        })
      } else if (ev.type === 'notice' && ev.text) {
        // CLI 心跳提示（如 90 秒无输出可能卡在权限审批）：进入卡片过程，不打断任务
        setRun((r) => ({
          ...r,
          cards: updateCard(r.cards, cardId, {
            process: [...(r.cards.find((c) => c.id === cardId)?.process ?? []), { kind: 'log' as const, text: ev.text!, ts: Date.now() }]
          })
        }))
      } else if (ev.type === 'usage' && ev.usage?.tokens) {
        let exceeded = false
        setRun((r) => {
          const tokens = (r.usage?.tokens ?? 0) + (ev.usage?.tokens ?? 0)
          if ((opts?.maxTokens ?? 0) > 0 && tokens >= (opts!.maxTokens as number)) exceeded = true
          return { ...r, usage: { ...r.usage, tokens } }
        })
        // 用量同时累计到该 Agent（侧栏/设置的 Agent 级累计；演示 Agent 不计）
        useAgents.getState().addTokens(agent.id, ev.usage.tokens ?? 0)
        if (exceeded) {
          // 达到 Token 上限：取消仍在进行的流式请求，交由调用方置 token_limit 状态
          bridge.models.cancel(reqId)
          bridge.cli.cancel(reqId)
          finish({ ok: false, message: `累计 Token 已达上限（${opts?.maxTokens}）`, tokenLimit: true })
        }
      } else if (ev.type === 'error') {
        finish({ ok: false, message: ev.message ?? '未知错误' })
      } else if (ev.type === 'done') {
        finish({ ok: true, text })
      }
    })
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
    const launched =
      agent.kind === 'cli' && agent.cliConfig
        ? bridge.cli.chat(
            agent.cliConfig.cli,
            {
              model: opts?.modelOverride ?? agent.cliConfig.model,
              exePath: agent.cliConfig.exePath,
              workDir: opts?.cliWorkDir ?? agent.cliConfig.workDir,
              timeoutMs: opts?.cliTimeoutMs,
              // 思考强度沿用该 Agent 的配置（工作站已传、工作流此前漏传：漏传时 codex/claude 不产出思考增量）
              thinkingLevel: agent.cliConfig.thinkingLevel
            },
            reqId,
            messages
          )
        : agent.modelConfig
          ? bridge.models.chat(
              opts?.modelOverride ? { ...agent.modelConfig, modelId: opts.modelOverride } : agent.modelConfig,
              reqId,
              messages,
              {
                agentId: agent.id,
                workflow: opts?.workflow,
                ...(opts?.checkpointId ? { checkpointId: opts.checkpointId } : {}),
                // 账本按 runId 归本：预算闸只算这次任务的钱，同时发生的工作站对话不算进来
                ...(opts?.runId ? { runId: opts.runId } : {}),
                // 计划轮：渲染层只能给自己**加**这道闸（写类工具在执行前与 schema 两处都拦），
                // 动不了 access/命令/联网——那些仍以主进程存储配置为唯一来源
                ...(opts?.planMode ? { planMode: true } : {})
              }
            )
          : Promise.resolve({ ok: false })
    void launched.then((r: { ok: boolean }) => {
      // 主进程会通过 model:event 发送错误；此处兜底通道异常（无事件到达）的场景
      if (!r.ok) setTimeout(() => finish({ ok: false, message: '请求未能发起（详见主进程日志）' }), 400)
    }).catch(() => finish({ ok: false, message: 'IPC 调用失败' }))
  })
}

/**
 * 角色级 + Agent 级 Skill 的拼接。`auto` 注入正文，`reference` 只给一行可引用清单；
 * 停用的 Skill 即使被绑也不注入（`partitionSkillsForInjection` 那一条口径，两处共用）。
 * `all` 由调用方传（一次 `bridge.skills.list()` 就够，别每层各拉一遍）。
 */
async function skillsBlockFor(ids?: string[], mode: 'auto' | 'reference' = 'auto', all?: Skill[]): Promise<string> {
  if (!ids?.length) return ''
  try {
    const list = all ?? (await bridge.skills.list())
    const { injected, listed } = partitionSkillsForInjection(list, ids, mode)
    if (mode === 'reference') {
      return listed.length ? `【以下 Skill 可被引用，本次未注入正文】\n${listed.map((s) => `- ${s.name}：${s.desc || '（无描述）'}`).join('\n')}` : ''
    }
    if (!injected.length) return ''
    return `【以下 Skill 已绑定到本角色，请遵循其指令】\n\n${injected
      .map(
        (s) =>
          `### ${s.name}\n${s.content}` +
          (s.dir && s.files?.length ? `\n（该技能目录 ${s.dir} 下附带文件，需要时用文件工具读取，不要凭空引用其内容）：${s.files.join('、')}` : '')
      )
      .join('\n\n')}`
  } catch {
    return ''
  }
}

/** 执行一个角色阶段（演示 Agent 走脚本；真实模型走流式调用） */
/** 计划轮的目录清单快照（Task 11）：取不到、被截断都带出来，不许把"看不见"说成"没发生" */
interface DirSnapshot {
  ok: boolean
  truncated: boolean
  files: string[]
}

async function planSnapshot(dir: string): Promise<DirSnapshot> {
  const r = await bridge.artifacts.ls(dir).catch(() => null)
  return { ok: r?.ok === true, truncated: r?.truncated === true, files: (r?.files ?? []).map((f) => f.rel) }
}

/** 开工前与结束后两次清单折成门上要列出的差集（来源是真实目录，不是角色自述） */
function planChanges(before: DirSnapshot, after: DirSnapshot): string[] {
  const delta = dirDelta(before.files, after.files)
  const out = [...delta.added.map((p) => `新增 ${p}`), ...delta.removed.map((p) => `消失 ${p}`)]
  // 清单没取到不等于"没改动"：这时必须明说无法对照，否则一次 IPC 失败会被显示成
  // 一句安慰人的"目录里没有新文件"
  if (!before.ok || !after.ok) out.push('目录清单没取到，本轮无法对照（这不等于没改动）')
  // 清单触顶被截断时明说列表不完整：这时"没有新增"可能只是没列出来
  if (before.truncated || after.truncated) out.push('目录清单触到上限被截断，上面的列表不完整')
  return out
}

/**
 * 跑一轮**计划态**规划并把批准门挂上（或重挂）。start() 第一次用它，
 * 「按意见重出计划」也用它——两处各写一遍就会出现"批准门有两种挂法"的漂移。
 * `_started`（单执行循环的占用位）由调用方负责：start() 自己收尾，重出计划那条用完清掉。
 */
async function runPlanRound(
  get: () => WorkflowState,
  set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void,
  opts: { feedback?: string; attachmentText?: string; carryOver?: string } = {}
) {
  const run = get().run
  const cfg = get().config
  if (!run) return
  const setRun = (fn: (r: WorkflowRun) => WorkflowRun) => set((s: WorkflowState) => (s.run ? { run: fn(s.run) } : {}))
  const isCancelled = () => get()._cancelled
  // 产物目录沿用任务记录上那一个（旧记录没记时按当前配置解析一次并回填）
  const outputDir = run.outputDir || (await bridge.artifacts.dir())
  if (!run.outputDir) setRun((r) => ({ ...r, outputDir }))
  const conventions = await dirContextBlock(outputDir)
  const supplements = extractSupplements(get().run)
  const ctx: RunContext = {
    goal: run.goal,
    round: run.round,
    maxRounds: cfg.maxRounds,
    outputDir,
    ...(conventions ? { conventions } : {}),
    ...(opts.attachmentText ? { attachmentText: opts.attachmentText } : {}),
    // 「以此为目标开新任务」带过来的上一任务结论：正常三角色链一直有这一项，
    // 计划轮少了它就会在**不知道上一版做了什么**的情况下写第一版计划
    ...(opts.carryOver ? { carryOver: opts.carryOver } : {}),
    ...(supplements.length ? { supplements } : {}),
    ...(opts.feedback ? { reworkFeedback: opts.feedback } : {})
  }
  const before = await planSnapshot(outputDir)
  setRun((r) => ({ ...r, status: 'running', stage: 'planning' }))
  const out = await runStage('planner', run.round, cfg, ctx, setRun, isCancelled, get, { planMode: true })
  // 失败 / Token 与预算上限都由 runStage 落到 run 上，这里不另写一套、也不粉饰成"已出计划"
  if (isCancelled() || !out) return
  const after = await planSnapshot(outputDir)
  setRun((r) => ({
    ...r,
    planText: out.conclusion.trim(),
    stage: 'awaiting_plan_approval',
    status: 'waiting_user',
    gate: { id: uid('gate'), round: r.round, passed: [], issues: [], kind: 'plan', cliChanges: planChanges(before, after) }
  }))
  get().saveRun()
}

async function runStage(
  role: WorkflowRole,
  round: number,
  cfg: WorkflowConfig,
  ctx: RunContext,
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  isCancelled: () => boolean,
  get: () => WorkflowState,
  opts?: { planMode?: boolean }
): Promise<StageOutcome | null> {
  // 计划轮（批次 F）：这一轮只读地看、产出计划。写类工具由主进程真拦（Task 9 那道闸），
  // CLI 角色拦不到，只能靠下面的提示词请求 + 事后列改动。
  const planMode = opts?.planMode === true
  const roleCfg = role === 'planner' ? cfg.planner : role === 'executor' ? cfg.executor : cfg.reviewer
  const agent = useAgents.getState().agents.find((a) => a.id === roleCfg.agentId)
  const isDemoAgent = agent?.isDemo === true
  const stage: Stage = role === 'planner' ? 'planning' : role === 'executor' ? 'executing' : 'reviewing'
  const runId = get().run?.id
  // 预算硬闸：每个阶段开始前先核对本次任务已经花掉多少（账本按 runId 归本，
  // 同时发生的工作站对话不算进来），到线就停在这里，而不是"跑完这一轮再说"
  if (cfg.budgetYuan && cfg.budgetYuan > 0) {
    const startedAt = get().run?.startedAt ?? Date.now()
    const spent = await bridge.ledger.costSince(startedAt, runId)
    if (spent >= cfg.budgetYuan) {
      setRun((r) => ({
        ...r,
        status: 'budget_limit' as const,
        stage: null,
        endedAt: Date.now(),
        notes: [...(r.notes ?? []), `折算费用已达预算上限（¥${cfg.budgetYuan}，本次已 ¥${spent.toFixed(4)}），任务在「${role}」阶段前自动停止`]
      }))
      get().saveRun()
      useSettings.getState().addMemory('progress', `任务因预算上限（¥${cfg.budgetYuan}）自动停止`, false)
      useUi.getState().toast(`已达预算上限 ¥${cfg.budgetYuan}（本次折算 ¥${spent.toFixed(4)}），任务自动停止`, 'warn')
      return null
    }
  }
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

  // ---- 真实 Agent（自定义模型 / 本机 CLI）：流式调用 + 结构化解析 ----
  if (!(agent?.modelConfig || agent?.cliConfig)) {
    // 失败原因持久化到运行记录：事后回看也能知道当时为什么失败（不只依赖转瞬的 toast）
    setRun((r) => ({ ...r, status: 'failed', stage: null, endedAt: Date.now(), notes: [...(r.notes ?? []), `任务失败（${roleCfg.agentName || '未配置'}）：缺少接入配置（模型或 CLI），无法执行`] }))
    get().saveRun()
    useUi.getState().toast(`Agent「${roleCfg.agentName}」缺少接入配置（模型或 CLI），无法执行`, 'error')
    return null
  }
  // 执行/审核角色：本次任务的产物目录即其工作根（只换目录，不提升访问级别；主进程按 workflow 标志裁决）
  const execCap: ExecutorCapability | undefined =
    role !== 'executor' || !agent
      ? undefined
      : agent.kind === 'cli'
        ? { kind: 'cli', dir: ctx.outputDir ?? '', hasTools: true }
        : { kind: 'model', dir: agent.tools ? (ctx.outputDir ?? '') : '', hasTools: !!agent.tools, allowCommands: agent.tools?.allowCommands, allowWeb: agent.tools?.allowWeb }
  // Skill 绑定：角色级 + Agent 级是**并集去重**（用户明确否掉了优先级开关）。
  // 角色级绑定视为 auto（本来就指望它注入正文）；Agent 级按它自己的 skillMode 走。
  const allSkills = await bridge.skills.list().catch(() => [] as Skill[])
  const mergedSkillIds = unionSkillIds(roleCfg.skillIds, agent?.skillIds)
  const autoIds = mergedSkillIds.filter((id) => (roleCfg.skillIds ?? []).includes(id) || agent?.skillMode === 'auto')
  const skillBlock = [
    await skillsBlockFor(autoIds, 'auto', allSkills),
    await skillsBlockFor(mergedSkillIds.filter((id) => !autoIds.includes(id)), 'reference', allSkills)
  ]
    .filter(Boolean)
    .join('\n\n')
  // 历史记忆按本次目标检索：全量塞既贵又把模型带偏，无关的宁可不给
  const memoryBlock = memoryBlockFor(ctx.goal, useSettings.getState().memory)
  const promptCtx: RunContext = {
    ...ctx,
    ...(skillBlock ? { skills: skillBlock } : {}),
    ...(memoryBlock ? { memories: memoryBlock } : {})
  }
  const { system, user } = buildRoleMessages(role, promptCtx, execCap, agent.systemPrompt)
  // 计划轮的措辞按角色分两类，两边都只说真话（spec 批次 F：承诺强度按角色分区）。
  // 模型 Agent 的写类工具已被主进程真拦（schema 里也没有）；CLI 角色的写盘由它自己的
  // 子进程执行，这里拦不到，只能请求它只读工作、并在计划轮结束后列出目录改动。
  // 这句话里不出现"一定没改文件"——那是拦不住的东西，不能承诺。
  const planNote = planMode
    ? '\n\n【计划态 · 本轮】本轮交付物是一份计划，不是改动。请只读地把该看清的看清：目标、步骤、影响面、风险、验收标准。\n' +
      (agent.kind === 'cli'
        ? '你的写盘与命令由你自己的 CLI 执行，AgentHub 拦不到，所以这一轮请按只读方式工作；目录里多出或少了什么，会在计划轮结束后如实列给用户。'
        : '你的写类工具（写文件、替换、删除、移动、执行命令）本轮已被关闭，MCP 工具本轮不可用，只读与联网工具照常可用。')
    : ''
  const useOutDir = (role === 'executor' || role === 'reviewer') && !!ctx.outputDir
  // CLI 超时按角色区分：规划 3 分钟 / 审核 5 分钟 / 执行 10 分钟（把无限挂起变有界失败）
  const cliTimeoutMs = role === 'planner' ? 3 * 60_000 : role === 'reviewer' ? 5 * 60_000 : 10 * 60_000
  const res = await agentChatToCard(agent, system + planNote, user, card.id, setRun, {
    maxTokens: cfg.maxTokens,
    modelOverride: roleCfg.modelOverride,
    cliTimeoutMs,
    workflow: useOutDir,
    // 整个任务共用一个检查点：回滚回到任务开始前，而不是某一轮开始前
    ...(runId ? { checkpointId: runId, runId } : {}),
    ...(useOutDir ? { cliWorkDir: ctx.outputDir } : {}),
    ...(planMode ? { planMode: true } : {})
  })
  if (isCancelled()) return null
  if (!res.ok) {
    if (res.tokenLimit) {
      // Token 上限自动停止（非失败）：保留已产出的卡片与记录，等待用户决定
      setRun((r) => ({
        ...r,
        status: 'token_limit',
        stage: null,
        endedAt: Date.now(),
        notes: [...(r.notes ?? []), `累计 Token 已达上限（${cfg.maxTokens}），任务自动停止；已完成卡片与记录保留`],
        cards: updateCard(r.cards, card.id, { status: 'error' })
      }))
      get().saveRun()
      useSettings.getState().addMemory('progress', `任务因 Token 上限（${cfg.maxTokens}）自动停止`, false)
      useUi.getState().toast(`累计 Token 已达上限（${cfg.maxTokens}），任务自动停止`, 'warn')
      return null
    }
    setRun((r) => ({
      ...r,
      status: 'failed',
      stage: null,
      endedAt: Date.now(),
      // 失败原因持久化到运行记录：事后回看也能知道当时为什么失败（不只依赖转瞬的 toast）
      notes: [...(r.notes ?? []), `任务失败（${agent.name}）：${res.message}`],
      cards: updateCard(r.cards, card.id, { status: 'error' })
    }))
    get().saveRun()
    useUi.getState().toast(`「${agent.name}」请求失败：${res.message}`, 'error')
    useSettings.getState().addMemory('progress', `任务失败（${agent.name}）：${res.message}`, false)
    return null
  }
  const parsed = parseRoleOutput(res.text)
  const conclusion = parsed?.conclusion ?? res.text
  setRun((r) => ({
    ...r,
    cards: updateCard(r.cards, card.id, {
      conclusion,
      ...(parsed?.checklist ? { checklist: parsed.checklist } : {}),
      status: 'done'
    })
  }))
  // 计划态下不兜底落盘（spec 推论 B17）：否则"计划正文"自己就成了产物，
  // 与"本轮不产生文件改动"自相矛盾。批准之后执行角色那一轮照常落盘。
  if (role === 'executor' && !planMode) await writeTextArtifactIfNone(ctx, card.id, conclusion, agent, setRun, get)
  get().saveRun()
  return { conclusion, ...(parsed?.checklist ? { checklist: parsed.checklist } : {}) }
}

/**
 * 执行角色本轮没有产出任何真实文件时，由 AgentHub 把执行结论落盘为一篇文本产物。
 * 如实标注 by:'app'（模型未写盘，是应用保存的文本），不冒充"模型已执行"。
 */
async function writeTextArtifactIfNone(
  ctx: RunContext,
  cardId: string,
  conclusion: string,
  agent: AgentConfig,
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  get: () => WorkflowState
) {
  const dir = ctx.outputDir
  if (!dir || !conclusion.trim()) return
  const card = get().run?.cards.find((c) => c.id === cardId)
  if (!card) return
  if ((card.artifacts ?? []).some((a) => a.kind === 'file' && a.path)) return
  const fileName = `${safeName(ctx.goal)}_第${ctx.round}轮.md`
  const body =
    `# ${ctx.goal}（第 ${ctx.round} 轮执行成果）\n\n` +
    `> 由 AgentHub 落盘：执行 Agent「${agent.name}」的文本成果原文，该 Agent 本次未直接写盘。\n\n${conclusion}\n`
  const r = await bridge.artifacts.write(fileName, body, get().run?.id)
  if (!r.ok || !r.path) {
    setRun((r2) => ({
      ...r2,
      notes: [...(r2.notes ?? []), `文本产物落盘失败（${r.message ?? '未知原因'}）：成果仅保存在任务记录中`]
    }))
    useUi.getState().toast(`文本产物落盘失败：${r.message ?? '未知原因'}`, 'warn')
    return
  }
  setRun((r2) => {
    const cur = r2.cards.find((c) => c.id === cardId)
    if (!cur || !r.path) return r2
    return { ...r2, cards: updateCard(r2.cards, cardId, { artifacts: withFileArtifact(cur, r.path, 'app') }) }
  })
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
  // 落盘产物如实报告：区分"执行方经工具真实写盘"与"由 AgentHub 保存的文本成果"，来源不混
  const files = run.cards
    .filter((c) => c.role === 'executor' && !c.demo)
    .flatMap((c) => (c.artifacts ?? []).filter((a) => a.kind === 'file' && !a.demo && a.path))
  const byTool = files.filter((a) => a.by === 'tool')
  const byApp = files.filter((a) => a.by !== 'tool')
  if (byTool.length > 0) lines.push(`\n执行方写盘文件 ${byTool.length} 个：${byTool.map((a) => a.path).join('、')}。`)
  if (byApp.length > 0) lines.push(`\n由 AgentHub 保存的文本成果 ${byApp.length} 篇：${byApp.map((a) => a.path).join('、')}。`)
  if (files.length === 0) {
    lines.push(`\n说明：本次未产生文件产物${run.outputDir ? `（产物目录：${run.outputDir}）` : ''}；如任务需要真实文件，请为执行角色选择带文件能力的 Agent 或检查产物目录设置。`)
  } else if (run.outputDir) {
    lines.push(`\n产物目录：${run.outputDir}`)
  }
  return lines.join('')
}

/**
 * 多文件交付时生成一篇"产物索引"：目标、文件清单（大小与来源）、验收项↔文件对照。
 * 只在目录里确实有 2 个以上文件时才写——一篇产物不需要目录页，多写一篇废文件反而是噪音。
 */
async function writeArtifactIndex(
  run: WorkflowRun,
  checklist: ChecklistItem[],
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void
): Promise<string | null> {
  const ls = await bridge.artifacts.ls()
  if (!ls.ok || ls.files.length < 2) return null
  const known = ls.files.map((f) => f.rel)
  const lines: string[] = [
    `# 产物索引：${run.goal}`,
    '',
    `> 任务 ${run.id} · 第 ${run.round} 轮 · 由 AgentHub 在交付时生成`,
    '',
    `产物目录：${ls.dir ?? run.outputDir ?? '（未记录）'}`,
    '',
    '## 文件清单',
    ''
  ]
  for (const f of ls.files) {
    const byTool = run.cards.some((c) => (c.artifacts ?? []).some((a) => a.path && a.path.replace(/\\/g, '/').toLowerCase().endsWith(f.rel.toLowerCase())))
    lines.push(`- \`${f.rel}\`（${(f.bytes / 1024).toFixed(1)} KB）${byTool ? ' · 执行方写盘' : ' · 目录里存在（来源未记入工具清单）'}`)
  }
  if (ls.truncated) lines.push('', `（目录文件过多，清单只列了前 5000 个）`)
  const withFiles = checklist.filter((c) => c.files?.length)
  if (withFiles.length) {
    lines.push('', '## 验收项 ↔ 文件', '')
    for (const c of withFiles) {
      const refs = (c.files ?? []).map((ref) => {
        const m = matchFileRef(ref, known)
        return m.found ? `\`${m.rel}\`${m.by === 'name' ? '（按文件名匹配）' : ''}` : `~~${ref}~~（目录里找不到）`
      })
      lines.push(`- ${c.text} → ${refs.join('、')}｜判定：${c.verdict === 'issue' ? '未通过' : c.verdict === 'pass' ? '通过' : c.done ? '完成' : '未完成'}`)
    }
  }
  const name = '产物索引.md'
  const r = await bridge.artifacts.write(name, lines.join('\n'), run.id)
  if (!r.ok || !r.path) {
    setRun((x) => ({ ...x, notes: [...(x.notes ?? []), `产物索引生成失败（${r.message ?? '未知原因'}）`] }))
    return null
  }
  return r.path
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
  // 多文件交付才生成索引；写完把它登记成本次产物，交付卡片与导出记录都看得到
  const indexPath = run.demo || !run.outputDir ? null : await writeArtifactIndex(run, lastReview?.checklist ?? [], setRun)
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
      ...(run.demo ? { artifacts: demoArtifacts(999) } : indexPath ? { artifacts: withFileArtifact(dCard, indexPath, 'app') } : {})
    })
  }))
  get().saveRun()
  // 自动沉淀：交付时留一条能被以后检索到的成果摘要，未通过项单独留一条"踩坑"
  const done = (lastReview?.checklist ?? []).filter((c) => c.verdict === 'pass').length
  const open = (lastReview?.checklist ?? []).filter((c) => c.verdict === 'issue')
  const fileCount = new Set(run.cards.flatMap((c) => (c.artifacts ?? []).filter((a) => a.kind === 'file' && !a.demo && a.path).map((a) => a.path))).size
  useSettings.getState().addMemory('summary', `《${run.goal}》第 ${run.round} 轮交付：审核 ${done} 项通过、${open.length} 项未过；产物 ${fileCount} 个${run.outputDir ? `（目录 ${run.outputDir}）` : ''}`, false)
  if (open.length) {
    useSettings.getState().addMemory('decision', `《${run.goal}》交付时仍有未通过项：${open.map((o) => o.text).join('；').slice(0, 300)}`, false)
  }
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
    confirmEveryRound: false,
    maxTokens: 0,
    budgetYuan: 0
  },
  run: null,
  tasks: [],
  presets: [],
  _cancelled: false,
  _started: false,
  _carryOver: null,
  planNextTask: false,

  setDraft: (t) => set({ draft: t }),
  setPlanNextTask: (v) => set({ planNextTask: v }),
  setAttachments: (a) => set({ attachments: a }),
  patchConfig: (p) => {
    set((s) => ({ config: { ...s.config, ...p } }))
    void bridge.config.setWorkflowDefaults({
      plannerAgentId: get().config.planner.agentId,
      executorAgentId: get().config.executor.agentId,
      reviewerAgentId: get().config.reviewer.agentId,
      // 角色级模型覆盖同样要落盘：不落盘时重启后模型悄悄变回 Agent 自带的那个
      plannerModel: get().config.planner.modelOverride,
      executorModel: get().config.executor.modelOverride,
      reviewerModel: get().config.reviewer.modelOverride,
      // 角色级技能绑定同样落盘，不落就是"重启后悄悄忘掉绑了哪些技能"
      plannerSkillIds: get().config.planner.skillIds ?? [],
      executorSkillIds: get().config.executor.skillIds ?? [],
      reviewerSkillIds: get().config.reviewer.skillIds ?? [],
      reviewMode: get().config.reviewMode,
      maxRounds: get().config.maxRounds,
      timeoutMin: get().config.timeoutMin,
      confirmEveryRound: get().config.confirmEveryRound,
      // 计划态必须落盘：不落就是"重启后悄悄忘掉我开了计划态"，
      // 而它改变的是整个任务的执行方式（批准前不写盘），忘掉一次等于换了种跑法还不吭声
      planFirst: get().config.planFirst ?? false,
      maxTokens: get().config.maxTokens,
      budgetYuan: get().config.budgetYuan ?? 0,
      outputDir: get().config.outputDir
    })
  },

  savePreset: (name) => {
    const nm = name.trim().slice(0, 24)
    if (!nm) {
      useUi.getState().toast('给预设起个名字（最多 24 字）', 'warn')
      return null
    }
    const c = get().config
    if (!c.planner.agentId || !c.executor.agentId || !c.reviewer.agentId) {
      useUi.getState().toast('三角色还没配齐，存不了预设', 'warn')
      return null
    }
    const role = (r: WorkflowRoleConfig): PresetRole => ({ agentId: r.agentId, ...(r.modelOverride ? { model: r.modelOverride } : {}) })
    const now = Date.now()
    // 同名 = 更新：预设是"方案"，改方案不该堆一堆重复条目
    const prev = get().presets.find((p) => p.name === nm)
    const next: WorkflowPreset = {
      id: prev?.id ?? uid('pre'),
      name: nm,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      planner: role(c.planner),
      executor: role(c.executor),
      reviewer: role(c.reviewer)
    }
    const list = [next, ...get().presets.filter((p) => p.name !== nm)]
    set({ presets: list })
    void bridge.config.setPresets(list)
    useUi.getState().toast(prev ? `预设已更新：${nm}` : `已存为预设：${nm}（共 ${list.length} 个）`, 'ok')
    return next
  },

  applyPreset: (id) => {
    const p = get().presets.find((x) => x.id === id)
    if (!p) return
    const agents = useAgents.getState().agents
    let dropped = false
    const mk = (r: PresetRole): WorkflowRoleConfig => {
      const a = agents.find((x) => x.id === r.agentId)
      if (!a) {
        dropped = true
        return { agentId: '', agentName: '未配置', model: '—' }
      }
      return { agentId: a.id, agentName: a.name, model: r.model ?? a.model, ...(r.model ? { modelOverride: r.model } : {}) }
    }
    // 只套角色与模型：目标、产物目录、审核方式与轮次属于"这次怎么跑"，不该被预设覆盖
    get().patchConfig({ planner: mk(p.planner), executor: mk(p.executor), reviewer: mk(p.reviewer) })
    useUi.getState().toast(dropped ? `预设「${p.name}」里有 Agent 已被删除，请重新选择` : `已套用预设：${p.name}`, dropped ? 'warn' : 'ok')
  },

  deletePreset: (id) => {
    const list = get().presets.filter((p) => p.id !== id)
    set({ presets: list })
    void bridge.config.setPresets(list)
  },

  loadPresets: (list) => set({ presets: list }),

  refreshTasks: async () => {
    try {
      const runs = await bridge.runs.list()
      set({ tasks: Array.isArray(runs) ? runs : [] })
    } catch { /* 列表拉不到不打断当前任务；下次落盘会再刷 */ }
  },

  openTask: (id) => {
    const s = get()
    if (runBusy(s.run)) {
      useUi.getState().toast('当前工作流正在执行，请先停止再切换任务（只有一个执行循环）', 'warn')
      return
    }
    const t = s.tasks.find((r) => r.id === id)
    if (!t) return
    // 打开即回看/继续：附件正文不随任务落盘，需要时重新添加
    set({ run: t, draft: t.goal, attachments: [], _started: false, _cancelled: false, _carryOver: null })
    useUi.getState().setScreen('workflow')
  },

  removeTask: async (id) => {
    const s = get()
    if (s.run?.id === id) {
      if (runBusy(s.run)) {
        useUi.getState().toast('该任务正在执行，请先停止再删除', 'warn')
        return
      }
      set({ run: null, draft: '', attachments: [], _started: false, _cancelled: false })
    }
    await bridge.runs.remove(id)
    // 任务记录删了就把它的原件副本一起清掉（副本只用于回滚，留着只会涨盘）
    void bridge.checkpoint.prune(id)
    await get().refreshTasks()
  },

  resolveRoles: () => {
    const agents = useAgents.getState().agents
    const pick = (id: string) => agents.find((a) => a.id === id)
    const s = get().config
    // 只刷新 Agent 侧信息，保留工作流侧的模型覆盖与技能绑定：整对象重建会抹掉这些字段，
    // 表现为"在工作流里选好模型/技能，点开始又变回 Agent 默认"（validate() 每次都会调这里）
    const re = (r: WorkflowRoleConfig): WorkflowRoleConfig => {
      const a = r.agentId ? pick(r.agentId) : undefined
      if (!a) return r
      return {
        agentId: a.id,
        agentName: a.name,
        model: r.modelOverride ?? a.model,
        ...(r.modelOverride ? { modelOverride: r.modelOverride } : {}),
        ...(r.skillIds?.length ? { skillIds: r.skillIds } : {})
      }
    }
    set({ config: { ...s, planner: re(s.planner), executor: re(s.executor), reviewer: re(s.reviewer) } })
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
      if (a.kind === 'cli' && a.status !== 'available') return `CLI Agent「${a.name}」不可用（可能已卸载），请重新添加`
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
    if (!run) return
    void bridge.runs.save(run).then(() => { void get().refreshTasks() })
    // 后台跑完/停下/到确认门时发通知（界面内 toast 用户可能根本看不见）
    announce(run)
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
    // 这一次要不要先出计划：全局开关开着，或用户勾了"本任务先出计划"（勾一次即清，不落盘）
    const usePlan = !!cfg.planFirst || get().planNextTask
    if (get().planNextTask) set({ planNextTask: false })
    // 生效的产物目录由主进程裁决（配置留空 = 文档目录下的 AgentHub-artifacts）
    const outputDir = await bridge.artifacts.dir()
    const carryOver = get()._carryOver
    // 文本附件内容（真实调用首轮注入规划角色；读取失败/超限的附件不发送）
    const attachmentText = get().attachments
      .filter((a) => a.status === 'ok' && a.kind === 'text' && a.content !== undefined)
      .map((a) => `\n[附件：${a.name}]\n${a.content}`)
      .join('')
    // 产物目录里若放着项目约定文件，整轮任务自动带上（三个角色都带：规划要按约定定验收标准）
    const conventions = await dirContextBlock(outputDir)
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
      demo,
      outputDir,
      // 计划态跟着这条任务走（不是"当前配置里有没有开"），续跑判定才有依据
      ...(usePlan ? { planFirst: true } : {})
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

      // ---------- 计划轮（planFirst，批次 F）----------
      // 只跑规划角色、这次调用的 grant 带 planMode：批准前不产生文件改动，交付物是 run.planText。
      // 跑完就停在这里等人批准；批准后由 confirmGate('deliver') 从**执行角色**续跑同一个 run——
      // 不重放计划轮（重放等于重复烧额度、重复写文件）。_started 由 start() 自己收尾。
      if (usePlan) {
        await runPlanRound(get, set, { attachmentText, carryOver: carryOver ?? undefined })
        return
      }

      let round = 1
      let prevReviewIssues: string[] = []
      while (round <= cfg.maxRounds) {
        if (isCancelled()) return
        const supplements = extractSupplements(get().run)
        const ctx: RunContext = {
          goal,
          round,
          maxRounds: cfg.maxRounds,
          outputDir,
          ...(conventions ? { conventions } : {}),
          ...(round === 1 && attachmentText ? { attachmentText } : {}),
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

        // 疑似无进展检测：连续 2 轮审核问题项完全相同 → 不再自动返工，转人工处理
        const normIssues = (list: string[]) => list.map((s) => s.trim().replace(/\s+/g, ' ')).sort().join('\n')
        const curIssues = verdicts.filter((v) => v.verdict === 'issue').map((v) => v.text)
        if (prevReviewIssues.length > 0 && curIssues.length > 0 && normIssues(curIssues) === normIssues(prevReviewIssues)) {
          setRun((r) => ({
            ...r,
            status: 'waiting_user',
            gate: {
              id: uid('gate'),
              round,
              passed: verdicts.filter((v) => v.verdict === 'pass'),
              issues: verdicts.filter((v) => v.verdict === 'issue'),
              reworkFeedback: '连续 2 轮审核指出的问题项完全相同，疑似无进展，已转人工处理。可补充针对性返工意见后继续，或停止任务。'
            },
            notes: [...(r.notes ?? []), `连续 2 轮（第 ${round - 1}、${round} 轮）审核问题项完全相同，疑似无进展，转人工处理`]
          }))
          get().saveRun()
          useSettings.getState().addMemory('review', `疑似无进展：第 ${round - 1}、${round} 轮审核问题项相同，转人工`, false)
          useUi.getState().toast('连续 2 轮审核问题项相同，疑似无进展，已转人工', 'warn')
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
      bridge.cli.cancel(activeModelReqId) // 两类通道对未知 reqId 均为无操作，双发无害
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

  rerunRole: (role) => {
    const run = get().run
    if (!run) {
      useUi.getState().toast('当前没有可重跑的任务', 'warn')
      return
    }
    if (runBusy(run)) {
      useUi.getState().toast('任务正在执行，请先停止再重跑单个角色', 'warn')
      return
    }
    if (run.demo) {
      useUi.getState().toast('演示任务是脚本内容，重跑没有意义', 'warn')
      return
    }
    // 同 resumeInterrupted：计划还没批准时，单角色重跑能绕过批准门（尤其重跑"执行"——
    // 那就是在未批准的计划上真写盘）。本轮没有"带反馈重跑计划轮"的入口，所以这里一律不放行，
    // 并把可走的路说清楚，不让人对着一个没反应的按钮猜。
    if (run.planFirst && !run.planApproved) {
      useUi.getState().toast('计划还没批准，单角色重跑会绕过批准门。填意见「按意见重出计划」，或批准它继续，或停止任务。', 'warn')
      return
    }
    set((s) => (s.run ? { run: { ...s.run, status: 'running', stage: role === 'planner' ? 'planning' : role === 'executor' ? 'executing' : 'reviewing' } } : {}))
    void resumeRework(get, set, { startRole: role, only: true })
  },

  resumeInterrupted: async () => {
    const run = get().run
    if (!run) {
      useUi.getState().toast('当前没有可续跑的任务', 'warn')
      return
    }
    if (!runBusy(run) && run.status !== 'interrupted') {
      useUi.getState().toast('这个任务不在中断状态', 'warn')
      return
    }
    if (run.demo) {
      useUi.getState().toast('演示任务不续跑', 'warn')
      return
    }
    // 计划态任务还没被批准过，就不许从"续跑"这条路进到执行角色——
    // 下面那套"按最后一张卡推断该从谁接"的启发式不认识计划门，会把未批准的规划卡当成
    // "规划已完成"，直接起执行。批准是这一轮唯一的门，没按过就当没跑完。
    // 刻意不自动重跑计划轮：那是再花一次额度，得由人决定（要接着做就新建任务）。
    if (run.planFirst && !run.planApproved) {
      useUi.getState().toast('这个任务的计划还没批准，续跑会绕过批准门，所以不放行。要接着做请新建任务。', 'warn')
      return
    }
    // 只按卡片推断"该从谁接着跑"：已经产出过结论的角色不重放，避免重复扣额度与重复写文件
    const last = [...run.cards].reverse().find((c) => c.role === 'planner' || c.role === 'executor' || c.role === 'reviewer')
    if (!last) {
      set((s) => (s.run ? { run: { ...s.run, status: 'running', stage: 'planning' } } : {}))
      void resumeRework(get, set, { startRole: 'planner' })
      return
    }
    if (last.role === 'reviewer') {
      // 审核已经跑完：把当时那份结论重新摊在人面前决定，而不是自作主张交付或返工
      const verdicts = last.checklist ?? []
      const issues = verdicts.filter((v) => v.verdict === 'issue')
      set((s) => (s.run ? { run: {
        ...s.run,
        status: 'waiting_user',
        stage: null,
        gate: { id: uid('gate'), round: s.run.round, passed: verdicts.filter((v) => v.verdict === 'pass'), issues: issues.length ? issues : [{ text: '审核未给出逐项结论，请人工核对', done: false, verdict: 'issue' as const }], ...(verdicts.length ? {} : { reworkFeedback: last.conclusion.slice(0, 200) }) }
      } } : {}))
      get().saveRun()
      useUi.getState().toast('这一轮的审核已完成：请在确认门决定交付还是返工', 'info')
      return
    }
    const startRole: WorkflowRole = last.role === 'planner' ? 'executor' : 'reviewer'
    set((s) => (s.run ? { run: { ...s.run, status: 'running', stage: startRole === 'executor' ? 'executing' : 'reviewing' } } : {}))
    void resumeRework(get, set, { startRole })
  },

  confirmGate: async (action, feedback) => {
    const run = get().run
    const cfg = get().config
    if (!run || run.status !== 'waiting_user' || !run.gate) return

    if (action === 'stop') {
      get().stop('user')
      return
    }
    // 计划批准门（批次 F）：批准 = 同一个 run 从执行角色继续，带计划上下文，不重放计划轮。
    // 这道分支也是边界：没批准（既不是 deliver 也不是 stop）就什么都不许跑，
    // 否则计划态"批准前不改动"这句话在门这里漏掉。
    if (run.gate.kind === 'plan') {
      if (action === 'rework') {
        // 「按意见重出计划」：再跑一轮**计划态**规划（新增一张规划卡，不改写上一版计划），
        // 跑完仍停在批准门。这是计划不满意时唯一的续法——不能放执行角色进来。
        useSettings.getState().addMemory('confirm', `计划返工意见：${feedback || '（未填写）'}`, false)
        set((s) => ({
          run: s.run ? { ...s.run, gate: undefined, notes: [...(s.run.notes ?? []), `按意见重出计划：${feedback || '（未填写）'}`] } : null
        }))
        // 占用位由这一段拿、这一段还：重出计划同样是一条在跑的链
        set({ _cancelled: false, _started: true })
        void runPlanRound(get, set, { feedback: feedback || undefined }).finally(() => set({ _started: false }))
        return
      }
      if (action !== 'deliver') {
        useUi.getState().toast('计划还没批准，任务不会开始执行。点「批准并继续」，或先停止任务。', 'warn')
        return
      }
      // 没有正文就没有可批准的东西：放行的话执行角色是在"计划"这个词上跑，比不批准更糟
      if (!run.planText?.trim()) {
        useUi.getState().toast('这一版计划是空的，没有可批准的内容。填意见重出一版，或停止任务。', 'warn')
        return
      }
      useSettings.getState().addMemory('confirm', '用户批准了计划，任务从执行角色继续（同一 run，不重放计划轮）', false)
      set((s) => ({
        run: s.run ? { ...s.run, gate: undefined, status: 'running', stage: 'executing', planApproved: true, notes: [...(s.run.notes ?? []), '计划已获批准，从执行角色继续（同一任务，不重跑计划轮）'] } : null
      }))
      get().saveRun()
      void resumeRework(get, set, { startRole: 'executor' })
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
      void resumeRework(get, set, { feedback })
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
    // 新建不会打断已在跑的任务（真跑着的时候必须先停止，否则新任务会抢同一个执行循环）
    if (runBusy(get().run)) {
      useUi.getState().toast('当前工作流正在执行，请先停止再新建', 'warn')
      return
    }
    // 本来就是空的新任务：只清状态等于"按了没反应"（实测踩坑），要说一句去哪开始
    const fresh = !get().run && !get().draft.trim() && get().attachments.length === 0
    set({ draft: '', attachments: [], run: null, _cancelled: false, _carryOver: null })
    // 侧栏的加号在工作站里也能点：不切界面的话点了确实什么都不会发生
    useUi.getState().setScreen('workflow')
    if (fresh) useUi.getState().toast('已经是新任务：在输入框里描述目标即可开始', 'info')
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
    // 默认落在本次任务的产物目录（用户仍可在对话框里改）：产物与任务记录同一处，不用事后找
    const r = await bridge.dialogs.saveFile(name, lines.filter(Boolean).join('\n'), run.outputDir)
    useUi.getState().toast(r.ok ? `已导出到 ${r.message}` : '已取消导出', r.ok ? 'ok' : 'info')
  },

  restore: async () => {
    try {
      const runs = await bridge.runs.list()
      set({ tasks: Array.isArray(runs) ? runs : [] })
      if (runs.length === 0) return
      const latest = runs[0]
      // 运行中状态无法核对 → 标记 interrupted，绝不盲目重放；停在确认门的可以接着等
      if (runBusy(latest)) {
        set({ run: { ...latest, status: 'interrupted' as const, stage: null } })
        useUi.getState().toast('已恢复上次任务记录；应用重启后执行状态未核对，不会自动继续执行', 'warn')
      } else if (latest.gate) {
        set({ run: latest })
      }
    } catch { /* 恢复失败不阻塞 */ }
  }
}))

/** 角色链（重跑与续跑都按这个顺序往下走） */
const ROLE_CHAIN: WorkflowRole[] = ['planner', 'executor', 'reviewer']
const ROLE_LABEL: Record<WorkflowRole, string> = { planner: '规划', executor: '执行', reviewer: '审核' }

interface RoundOpts {
  /** 返工意见（注入执行角色上下文） */
  feedback?: string
  /** 从哪个角色开始（默认执行） */
  startRole?: WorkflowRole
  /** 只跑这一个角色，不往下走审核、也不动确认门 */
  only?: boolean
}

/**
 * 从当前轮次的某个角色起跑完剩余链条：人工返工、中断续跑、单角色重跑共用这一条路。
 * 重跑一律"新增一张卡片"而不是原地改写——已经发生过一次真实调用，
 * 把那张卡抹掉等于把那次消耗藏起来。
 */
async function resumeRework(get: () => WorkflowState, set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void, opts: RoundOpts = {}) {
  const { feedback, startRole = 'executor', only } = opts
  // 续跑与 start() 共用同一把"单执行循环"占用位，且**由这一处统一置位与清位**：
  // 原先三个调用点各自 set({_started:true}) 却没人清位——清不掉是"之后再也提交不了新任务"，
  // 而不置位（返工与计划批准这两条路就没置）才是真危险：链正在写这个 run 的时候提交第二个任务，
  // start() 里的 set({run}) 会把两条链正在写的同一个 run 顶掉。
  set({ _cancelled: false, _started: true })
  try {
    await resumeChain(get, set, { feedback, startRole, only })
  } finally {
    set({ _started: false })
  }
}

async function resumeChain(get: () => WorkflowState, set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void, opts: RoundOpts) {
  const { feedback, startRole = 'executor', only } = opts
  const state = get()
  const run = state.run
  const cfg = state.config
  if (!run) return
  const setRun = (fn: (r: WorkflowRun) => WorkflowRun) => set((s: WorkflowState) => (s.run ? { run: fn(s.run) } : {}))
  const isCancelled = () => get()._cancelled
  const round = run.round

  const lastPlan = [...run.cards].reverse().find((c) => c.role === 'planner')
  const lastExec = [...run.cards].reverse().find((c) => c.role === 'executor')
  // 返工沿用本次任务的产物目录（旧记录未记录时按当前配置解析一次并回填）
  const outputDir = run.outputDir || (await bridge.artifacts.dir())
  if (!run.outputDir) setRun((r) => ({ ...r, outputDir }))
  const reworkConventions = await dirContextBlock(outputDir)
  const ctx: RunContext = {
    goal: run.goal,
    round,
    maxRounds: cfg.maxRounds,
    outputDir,
    ...(reworkConventions ? { conventions: reworkConventions } : {}),
    ...(feedback ? { reworkFeedback: feedback } : {}),
    supplements: extractSupplements(run),
    ...(lastPlan?.conclusion ? { planConclusion: lastPlan.conclusion } : {}),
    ...(lastPlan?.checklist?.length ? { planChecklist: lastPlan.checklist } : {}),
    ...(lastExec?.conclusion ? { execConclusion: lastExec.conclusion } : {})
  }

  const chain = only ? [startRole] : ROLE_CHAIN.slice(ROLE_CHAIN.indexOf(startRole))
  let review: StageOutcome | null = null
  for (const role of chain) {
    const out = await runStage(role, round, cfg, ctx, setRun, isCancelled, get)
    if (!out) return
    if (role === 'planner') {
      ctx.planConclusion = out.conclusion
      ctx.planChecklist = out.checklist
    } else if (role === 'executor') {
      ctx.execConclusion = out.conclusion
    } else {
      review = out
    }
  }

  // 只重跑单个角色：到这里就收，判定与确认门都留给原来的卡片（不改写历史）
  if (only || !review) {
    get().saveRun()
    useUi.getState().toast(`已重跑「${ROLE_LABEL[startRole]}」角色：新增一张卡片，后续结论按最新一张算`, 'ok')
    return
  }
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
