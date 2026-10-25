// 工作流引擎与状态：三角色循环（规划→执行→审核→规划判断）、返工上限、停止条件、人工确认门
// 执行状态与页面动画状态完全解耦；重绘/切换不重复提交任务（提交只经 start() 一次）
// 真实运行：角色为自定义模型 Agent 时经 model:chat 真实流式调用（结构化输出解析失败则降级纯文本）；
// 演示 Agent 的卡片走脚本内容并逐卡标注"演示"，绝不把脚本内容包装成真实执行。
import { create } from 'zustand'
import type {
  WorkflowRun, WorkflowConfig, WorkflowRoleConfig, RoleCard, Stage, ReviewGate,
  Attachment, ChecklistItem, ProcessEvent, AgentConfig, WorkflowPreset, PresetRole, Skill, RunSkillEntry
} from '@shared/types'
import { unionSkillIds, partitionSkillsForInjection } from '@shared/skills-union'
import { dirDelta } from '@shared/dir-delta'
import {
  BUSY_STATUSES, clearGateForRun, restoreSnapshot, isTerminal, pickNextResumeRole,
  enqueue, takeNext, withPlanStartFiles, withPlanCliDelta, planAuditOf, PLAN_DELTA_CAP,
  type QueuedTask, type RunSnapshot
} from '@shared/engine-transitions'
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

  /**
   * 开始任务。queued 缺省 = 从草稿起（UI 入口）；传入队列条目 = 终态后自动接队的内部路径
   * （不经 draft：目标、附件正文、计划态单次档都已在入队那一刻定格）。
   */
  start: (queued?: QueuedTask) => Promise<void>
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

  /**
   * 任务队列（内存态，不持久化）：引擎同时只跑一条链（单执行循环不变），
   * 排队只是"当前任务到达终态后自动开始下一条"，省得人盯着等。
   */
  queue: QueuedTask[]
  /** 把当前草稿 + 文本附件 + 计划态单次档打包入队；入队成功清空草稿与单次档 */
  queueCurrent: () => void
  /** 从队列移除一条（首页队列条的逐条删除） */
  removeQueued: (index: number) => void
}

/** 当前进行中的真实模型请求（stop 时取消） */
let activeModelReqId: string | null = null

/**
 * 是否"正在执行"：引擎只有一个执行循环，所以跑着的时候不许切任务/新建。
 * 停在人工确认门（gate 已挂出）不算执行中——那时是空转等人点。
 * 忙状态列表抽到 shared/engine-transitions（BUSY_STATUSES）：快照测试拿它核对
 * "终态与忙态互斥"，两处各写一份没有测试拦得住漂移。
 */
export function runBusy(run: WorkflowRun | null): boolean {
  return !!run && !run.gate && BUSY_STATUSES.includes(run.status)
}

/**
 * 带 runId 归属的 run 写入器：只写"链所属的那条 run"。引擎链是异步长链，中途用户可能切换任务
 * （或链挂在门上时入口被点）——原先那类 `set((s) => (s.run ? ... : {}))` 一律写"当前 run"，
 * 迟到的流式写会把 A 任务的卡片/状态写进 B 任务并落盘。runId 不匹配时安全空操作。
 */
const setRunOf =
  (set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void, runId: string | null) =>
  (fn: (r: WorkflowRun) => WorkflowRun) =>
    set((s: WorkflowState) => (runId !== null && s.run?.id === runId ? { run: fn(s.run) } : {}))

/**
 * 引擎链兜底：链上任一 IPC reject（账本核对、产物目录解析、清单读取、文本落盘…）都不许把任务
 * 卡死在 running——runBusy 恒真会占死"切换/新建/删除"，且没有任何提示。这里统一置 failed、
 * 把原因写进 notes（事后回看可知）、落盘、toast。setRun 由调用方传入（带 runId 归属判断）：
 * 写入没落到当前 run 时（链还没建出 run，或所属 run 已被切走）不保存别人的 run，只剩 toast 告知。
 */
function failRun(
  setRun: (fn: (r: WorkflowRun) => WorkflowRun) => void,
  get: () => WorkflowState,
  where: string,
  err: unknown
) {
  const message = err instanceof Error ? err.message : String(err)
  const prev = get().run
  setRun((r) => ({
    ...r,
    status: 'failed',
    stage: null,
    endedAt: Date.now(),
    notes: [...(r.notes ?? []), `引擎异常（${where}）：${message}`]
  }))
  // run 引用变了 = 写入落到了当前 run，才落盘；否则保存的是与本次异常无关的任务
  if (get().run !== prev) get().saveRun()
  useUi.getState().toast(`引擎异常（${where}）：${message}`, 'error')
}

/**
 * 超时看门狗（start 与 resumeRework 共用）：链上请求挂起（模型/CLI 通道无响应）时由它把任务
 * 停成 timeout。原先只在 start() 注册——返工/续跑/批准后续跑/单角色重跑同样是在跑的链，
 * 挂起时同样只能永远干等手动 stop。回调条件与原先一致：占用位在、未被取消、且 run 还在执行态。
 */
function makeWatchdog(get: () => WorkflowState, timeoutMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const s = get()
    // 忙态判定与 runBusy 同源（BUSY_STATUSES）：看门狗只在"链确实还在跑"时才该开火
    if (s._started && !s._cancelled && !!s.run && BUSY_STATUSES.includes(s.run.status)) {
      s.stop('timeout')
    }
  }, timeoutMs)
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
  // 终态口径来自 shared/engine-transitions（isTerminal）：通知、队列自动开始、出口卡
  // 三处必须认同一份终态列表，不能各背一份
  const terminal = isTerminal(run.status)
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

/**
 * 队列自动开始的防重入开关：终态后自动开始只允许成功一次。
 * 触发点不止一处（saveRun 的终态检查、start/resumeRework 释放占用位的 finally、
 * 门上停止后的 saveRun），没有这把开关的话同一次终态可能被检查两次；真正起链的那次
 * 占住它直到 start 返回，其余检查在 _started / 这把开关面前自然退避。
 */
let autoStartInFlight = false

/**
 * 终态收尾后的队列检查：当前 run 是真终态（不含挂门的 waiting_user 与重启的
 * interrupted）且队列非空时，取队头直接起链。触发点见各调用处注释。
 */
async function pumpQueue(
  set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void,
  get: () => WorkflowState
) {
  if (autoStartInFlight || get()._started) return
  const run = get().run
  if (!run || !isTerminal(run.status)) return
  const head = takeNext(get().queue)
  if (!head) return
  set({ queue: head.queue })
  autoStartInFlight = true
  try {
    useUi.getState().toast(`队列：开始「${head.item.goal.slice(0, 30)}」`, 'info')
    // 走 start 的 queued 入口：目标/附件正文/计划态档都在入队时定格，不经 draft
    await get().start(head.item)
  } finally {
    autoStartInFlight = false
    // 开关释放后再查一遍：刚跑完的这条链自己的收尾检查（saveRun / start 的 finally）
    // 当时都被这把开关挡住（它还占着），队列里剩下的任务靠这里继续排空
    void pumpQueue(set, get)
  }
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

/**
 * 文本附件正文的组装（start 与 queueCurrent 共用一段逻辑，抽成一个小函数）：
 * 只收读取成功（status ok）的**文本**附件；读取失败/超限的附件不发送。
 * 图片附件不走这里（模型走 base64、CLI 只给路径，且队列不保存图片）。
 */
function attachmentTextOf(attachments: Attachment[]): string {
  return attachments
    .filter((a) => a.status === 'ok' && a.kind === 'text' && a.content !== undefined)
    .map((a) => `\n[附件：${a.name}]\n${a.content}`)
    .join('')
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

/**
 * 开工技能快照（run.skillPlan）的拼装：把此刻三角色的技能解析事实定格下来。
 * 口径与 runStage 的注入链一致——角色级 ∪ Agent 级（unionSkillIds 去重）− 停用
 * （enabled === false 的即使绑了也不会被注入，照 partitionSkillsForInjection 同一条规矩剔除）；
 * via 标注注入层来源：角色 skillIds 绑了记 'role'、Agent skillIds 绑了记 'agent'、两边都绑记 'both'。
 * 什么都没绑时也返回全空快照（三角色各空表）：空表与"没有快照"是两件事——
 * 前者说明开工时确实没绑技能，后者说明任务创建于技能面板上线前，任务页要区分这两种话。
 * 只在 start() 的开工路径调用一次：续跑/返工/单角色重跑复用同一个 run，不重拍——
 * 引擎那半边（runStage）每次阶段调用都会按**当时**的 config 重新解析注入清单，这是既有行为；
 * 快照的职责是把"开工那一刻解析出了什么"钉住，供事后回看对账，而不是跟着引擎重算。
 */
async function buildSkillPlan(cfg: WorkflowConfig): Promise<NonNullable<WorkflowRun['skillPlan']>> {
  const roles = ['planner', 'executor', 'reviewer'] as const
  const agents = useAgents.getState().agents
  // 没有任何绑定（角色级与三个 Agent 级都空）时不必拉技能清单：直接返回全空快照
  const hasAny = roles.some((k) => {
    const a = agents.find((x) => x.id === cfg[k].agentId)
    return (cfg[k].skillIds?.length ?? 0) > 0 || (a?.skillIds?.length ?? 0) > 0
  })
  if (!hasAny) return { planner: { skills: [] }, executor: { skills: [] }, reviewer: { skills: [] } }
  const all = await bridge.skills.list().catch(() => [] as Skill[])
  const byId = new Map(all.map((s) => [s.id, s]))
  const plan = {} as NonNullable<WorkflowRun['skillPlan']>
  for (const k of roles) {
    const roleIds = cfg[k].skillIds ?? []
    const agent = agents.find((x) => x.id === cfg[k].agentId)
    const agentIds = agent?.skillIds ?? []
    plan[k] = {
      skills: unionSkillIds(roleIds, agentIds)
        .filter((id) => byId.get(id)?.enabled !== false) // 停用的剔除；清单里查无此 id 的保留（见下）
        .map((id) => {
          const s = byId.get(id)
          const inRole = roleIds.includes(id)
          const inAgent = agentIds.includes(id)
          const entry: RunSkillEntry = {
            id,
            // name 取不到时兜底用 id：快照是事实记录，宁可显示裸 id 也不显示 undefined
            name: s?.name ?? id,
            via: inRole && inAgent ? 'both' : inRole ? 'role' : 'agent',
            ...(s?.source ? { source: s.source } : {}),
            ...(s?.version ? { version: s.version } : {})
          }
          return entry
        })
    }
  }
  return plan
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
 * `_started`（单执行循环的占用位）与异常兜底都由调用方负责：start() 的 try/catch 与
 * confirmGate 重出计划那条的 .catch（→ failRun）各管各的；重出计划那条还自带看门狗。
 */
async function runPlanRound(
  get: () => WorkflowState,
  set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void,
  opts: { feedback?: string; attachmentText?: string; carryOver?: string } = {}
) {
  const run = get().run
  const cfg = get().config
  if (!run) return
  // 只写"这条链的 run"（入口捕获 id）：计划轮也是长链，迟到的写不许落进切换后的别的任务
  const setRun = setRunOf(set, run.id)
  const isCancelled = () => get()._cancelled
  // 计划态对 CLI 角色的补偿（拦不住就透明）：三个角色里有 CLI 角色时，起跑前拍一份目录
  // 清单存进 run。模型 Agent 的写类工具主进程真拦，CLI 角色的写盘由它自己的子进程执行、
  // 这里拦不到——只能事后把路径差集如实列给人看。基线只在计划阶段第一次起跑时拍：
  // 「按意见重出计划」每轮重拍基线会把上一轮计划期间 CLI 写出的路径从差集里洗掉，
  // 等于替它藏证据；批准前的所有计划轮共用同一条基线。
  const hasCliRole = (['planner', 'executor', 'reviewer'] as const).some((k) => {
    const a = useAgents.getState().agents.find((x) => x.id === cfg[k].agentId)
    return a?.kind === 'cli'
  })
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
  // 启动清单存 run（上限 2000 条，超了截断并记标记）：计划门挂出时拿它与当前清单求差集。
  // 清单没取到（ok=false）也照存空表——"看不见"与"没改动"必须分开，下面差集处会说清。
  if (hasCliRole && !planAuditOf(get().run ?? run).planStartFiles) {
    setRun((r) => withPlanStartFiles(r, before.files, before.truncated))
  }
  setRun((r) => ({ ...r, status: 'running', stage: 'planning' }))
  const out = await runStage('planner', run.round, cfg, ctx, setRun, isCancelled, get, { planMode: true })
  // 失败 / Token 与预算上限都由 runStage 落到 run 上，这里不另写一套、也不粉饰成"已出计划"
  if (isCancelled() || !out) return
  const after = await planSnapshot(outputDir)
  // 门挂出时算一次路径差集（新增/消失，各上限 200 条）：基线是起跑前存的那份，
  // 没有基线（无 CLI 角色）就不算也不存——没有 CLI 角色时本来就拦得住，无需这套补偿
  const baseline = planAuditOf(get().run ?? run)
  let planDelta: { added: string[]; removed: string[] } | null = null
  let planDeltaTruncated = false
  if (baseline.planStartFiles) {
    const d = dirDelta(baseline.planStartFiles, after.files)
    planDelta = { added: d.added, removed: d.removed }
    planDeltaTruncated =
      before.truncated || after.truncated || baseline.planStartFilesTruncated === true ||
      d.added.length > PLAN_DELTA_CAP || d.removed.length > PLAN_DELTA_CAP
  }
  setRun((r) => withPlanCliDelta(
    {
      ...r,
      planText: out.conclusion.trim(),
      stage: 'awaiting_plan_approval',
      status: 'waiting_user',
      gate: { id: uid('gate'), round: r.round, passed: [], issues: [], kind: 'plan', cliChanges: planChanges(before, after) }
    },
    planDelta,
    planDeltaTruncated
  ))
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
  // 停止指令到达时就此收手：stop 已把任务置 cancelled、卡片标 error，这里再走完收尾会把
  // 用户的停止覆盖成"已完成"，还多发一条完成通知——所以产物索引也不写，直接停手
  if (isCancelled()) return
  // 多文件交付才生成索引；写完把它登记成本次产物，交付卡片与导出记录都看得到
  const indexPath = run.demo || !run.outputDir ? null : await writeArtifactIndex(run, lastReview?.checklist ?? [], setRun)
  setRun((r) => ({
    ...r,
    status: 'completed',
    stage: null,
    endedAt: Date.now(),
    // usage.elapsedMs 是孤儿字段（类型里即将删掉）：原样带回已有的 tokens 累计，不再写耗时
    usage: r.usage,
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
  queue: [],
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
    // _started 与 runBusy 双查：start() 同步占位后还有两个 IPC 的窗口（run 未建出/旧的空 run），
    // 只查 runBusy 会在那个窗口里把 run 与 _started 一起换掉，双提交的门又被打开
    if (runBusy(s.run) || s._started) {
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
      // _started 与 runBusy 双查（同 openTask）：否则删除动作会在链刚起、run 还没挂上的窗口里清掉占用位
      if (runBusy(s.run) || s._started) {
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
    // 队列检查点：每个终态分支写完 saveRun 都经过这里（announce 旁边），不必每个分支各写一遍。
    // 链还在跑时占用位 _started 未释放，这次检查自然退避，释放那一拍由 finally 再触发；
    // pumpQueue 自己会再核对终态与队列——waiting_user 挂门与 interrupted 不是终态，不接队
    void pumpQueue(set, get)
  },

  start: async (queued) => {
    if (get()._started) return // 防重复提交
    const goal = (queued?.goal ?? get().draft).trim()
    if (!goal) {
      useUi.getState().toast('请先描述任务目标', 'warn')
      return
    }
    const problem = get().validate()
    if (problem) {
      // 队列任务起不来要点名是哪一条：自动开始的失败静默掉，人永远不知道有条任务没跑
      useUi.getState().toast(queued ? `队列：任务「${goal.slice(0, 30)}」未能开始：${problem}` : `无法开始：${problem}`, 'error')
      return
    }

    // 提交位在两个异步 IPC（产物目录解析、目录上下文）之前就占住：校验一过同步置位，
    // 双击"开始"的第二击在这之后的任何时刻都被入口那道闸拒掉——置位太晚会出两条并发链、双份计费。
    // 从这里到收尾是一整条引擎链：异常统一由本函数的 catch（→ failRun）兜底，不再把任务卡死在 running。
    set({ _started: true })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    // 链所属 run 在下面才创建：创建前发生异常时 setRun 判 id 自然空操作（failRun 只剩 toast 告知），不误伤旧任务
    let chainRunId: string | null = null
    const setRun = (fn: (r: WorkflowRun) => WorkflowRun) =>
      set((s: WorkflowState) => (chainRunId !== null && s.run?.id === chainRunId ? { run: fn(s.run) } : {}))
    try {
      const demo = get().isDemoRun()
      const cfg = { ...get().config }
      // 开工技能快照：在建 run 前按当前配置拍一次（含 planFirst 的计划轮——run 与快照都在
      // start() 里建，计划轮只是这条链的第一段）。「按意见重出计划」走的是 confirmGate 的
      // 同一 run 续路，不经过这里，天然不重拍；续跑/返工/单角色重跑同理——快照只定格开工那一刻。
      const skillPlan = await buildSkillPlan(cfg)
      // 这一次要不要先出计划：全局开关按当前配置生效；单次档——草稿路径看 planNextTask
      // （勾一次即清），队列路径看入队那一刻定格的那份（出队不再看当前开关）。
      // 全局 planFirst 对队列任务按出队时刻的配置走：队列条目只定格了单次档这一项（类型如此）。
      const usePlan = !!cfg.planFirst || (queued ? queued.planNextTask === true : get().planNextTask)
      if (!queued && get().planNextTask) set({ planNextTask: false })
      // 生效的产物目录由主进程裁决（配置留空 = 文档目录下的 AgentHub-artifacts）
      const outputDir = await bridge.artifacts.dir()
      // 「以此为目标开新任务」的上下文属于草稿路径；队列任务不带它（入队时没打包这一项）
      const carryOver = queued ? null : get()._carryOver
      // 文本附件内容（真实调用首轮注入规划角色；读取失败/超限的附件不发送）。
      // 队列任务直接用入队时拼好的那份，不再读当前附件栏——那已经是下一条任务的草稿了
      const attachmentText = queued ? (queued.attachmentText ?? '') : attachmentTextOf(get().attachments)
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
        // 开工技能快照（三角色全空也是合法快照：说明开工时确实没绑技能）
        skillPlan,
        // 计划态跟着这条任务走（不是"当前配置里有没有开"），续跑判定才有依据
        ...(usePlan ? { planFirst: true } : {})
      }
      chainRunId = run.id
      // _started 已在函数开头同步占住，这里只挂 run；草稿路径顺手清掉已消费的 carryOver，
      // 队列路径不动它——那是用户草稿流的上下文，不归这条自动链消费
      set({ run, _cancelled: false, ...(queued ? {} : { _carryOver: null }) })
      useSettings.getState().addMemory('goal', `任务目标：${goal}`, false)
      get().saveRun()

      const isCancelled = () => get()._cancelled

      // 超时看门狗
      watchdog = makeWatchdog(get, cfg.timeoutMin * 60 * 1000)

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
    } catch (err) {
      failRun(setRun, get, 'start 主链', err)
    } finally {
      if (watchdog) clearTimeout(watchdog)
      set({ _started: false })
      // 占用位释放后的那一拍接队：终态分支里的 saveRun 检查时占用位还在（退避了），
      // 这里是链式队列的推进点之一；非终态收尾（挂门/中断）pumpQueue 自己会跳过
      void pumpQueue(set, get)
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
    if (runBusy(run) || get()._started) {
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
    // 快照重跑前的状态与门：单角色重跑只是"借引擎位补一张卡"，收尾要把任务放回原样——
    // waiting_user 带门 → 门重新挂上让人拿最新结论再决定；completed → 仍 completed、引擎位释放。
    // 不还原的话 run 永停 running，runBusy 恒真，切换/新建/删除全被空占，只能手动 stop。
    const snap = { status: run.status, stage: run.stage, gate: run.gate }
    // 置 running 的同一次 set 清门 + 带 runId 归属：门还挂着却在跑是矛盾态（runBusy 把带门当空闲），
    // 切换/新建的守卫会失效；引擎写也只许落进这条 run（清门+置 running+设 stage 的形状在
    // clearGateForRun，与续跑/批准分支同一份）
    setRunOf(set, run.id)((r) =>
      clearGateForRun(r, 'running', role === 'planner' ? 'planning' : role === 'executor' ? 'executing' : 'reviewing')
    )
    void resumeRework(get, set, { startRole: role, only: true, snap })
  },

  resumeInterrupted: async () => {
    const run = get().run
    if (!run) {
      useUi.getState().toast('当前没有可续跑的任务', 'warn')
      return
    }
    // 只认 interrupted：正在跑的 run status 是 running/preparing/waiting_review，天然进不来；
    // 挂着门的 waiting_user 也不是中断。原先 `!runBusy(run) && ...` 在**正在跑**时反而放行
    // （runBusy 为真让整个条件为假、不拦截），等于给并发续跑开了门——原分支的语义已全部被
    // "status 必须 === 'interrupted'"覆盖，直接按状态判死。
    if (run.status !== 'interrupted') {
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
    // "该从谁接"的推断抽到 shared/engine-transitions（pickNextResumeRole）：按最后一张
    // 三角色卡判定——真产出过结论（done 且结论非空）从下一环接着跑；还 streaming/error
    // 或结论为空的那一步等于没发生，重跑它，而不是拿更早的旧结论往下跳（旧口径会拿
    // 上一轮的审核卡重挂门，门里摊给人看的结论是旧的）。审核已产出 → 重挂门，绝不
    // 自作主张交付或返工；一张相关卡都没有 → 从规划起跑。
    const pick = pickNextResumeRole(run.cards)
    if (pick?.produced && pick.producedRole === 'reviewer' && pick.card) {
      // 审核已经跑完：把当时那份结论重新摊在人面前决定，而不是自作主张交付或返工
      const verdicts = pick.card.checklist ?? []
      const issues = verdicts.filter((v) => v.verdict === 'issue')
      setRunOf(set, run.id)((r) => ({
        ...r,
        status: 'waiting_user',
        stage: null,
        gate: { id: uid('gate'), round: r.round, passed: verdicts.filter((v) => v.verdict === 'pass'), issues: issues.length ? issues : [{ text: '审核未给出逐项结论，请人工核对', done: false, verdict: 'issue' as const }], ...(verdicts.length ? {} : { reworkFeedback: pick.card!.conclusion.slice(0, 200) }) }
      }))
      get().saveRun()
      useUi.getState().toast('这一轮的审核已完成：请在确认门决定交付还是返工', 'info')
      return
    }
    const startRole: WorkflowRole = pick?.role ?? 'planner'
    setRunOf(set, run.id)((r) =>
      clearGateForRun(r, 'running', startRole === 'planner' ? 'planning' : startRole === 'executor' ? 'executing' : 'reviewing')
    )
    void resumeRework(get, set, { startRole })
  },

  confirmGate: async (action, feedback) => {
    const run = get().run
    const cfg = get().config
    if (!run || run.status !== 'waiting_user' || !run.gate) return
    // 门所在的这条 run 独占本函数的所有写入（入口捕获 id）：交付/返工起链后，迟到的写不许落进切换后的别的任务
    const setRun = setRunOf(set, run.id)

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
        setRun((r) => ({ ...r, gate: undefined, notes: [...(r.notes ?? []), `按意见重出计划：${feedback || '（未填写）'}`] }))
        // 占用位由这一段拿、这一段还：重出计划同样是一条在跑的链；它的异常与超时也归这一段管
        // （runPlanRound 自己不兜底）——不接住就会把任务卡死在半路、占用位也还不了
        set({ _cancelled: false, _started: true })
        const watchdog = makeWatchdog(get, get().config.timeoutMin * 60 * 1000)
        void runPlanRound(get, set, { feedback: feedback || undefined })
          .catch((err) => { failRun(setRun, get, '重出计划', err) })
          .finally(() => {
            clearTimeout(watchdog)
            set({ _started: false })
          })
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
      // 置 running 的同一次 set 清门（clearGateForRun，与续跑/重跑同一形状）：起链后 runBusy
      // 必须为真（runBusy 把带门当空闲），切换/新建的守卫才拦得住
      setRun((r) => clearGateForRun({ ...r, planApproved: true, notes: [...(r.notes ?? []), '计划已获批准，从执行角色继续（同一任务，不重跑计划轮）'] }, 'running', 'executing'))
      get().saveRun()
      void resumeRework(get, set, { startRole: 'executor' })
      return
    }
    if (action === 'rework') {
      useSettings.getState().addMemory('confirm', `用户返工意见：${feedback || '（未填写）'}`, false)
      const nextRound = clamp(run.round + 1, 1, cfg.maxRounds)
      // 同一次 set 清门置 running（clearGateForRun，理由同上）：引擎不能悬在"门还挂着但已在跑"的矛盾态
      setRun((r) => clearGateForRun({ ...r, round: nextRound, notes: [...(r.notes ?? []), `第 ${run.round} 轮返工意见：${feedback || '（未填写）'}`] }, 'running', 'executing'))
      get().saveRun()
      // v1 由独立协程续跑（执行→审核），返工意见注入真实角色上下文
      void resumeRework(get, set, { feedback })
      return
    }
    // deliver
    useSettings.getState().addMemory('confirm', '用户确认通过并交付', false)
    // 起交付链前清门置 running（clearGateForRun；stage 保持原样不动，交付卡自己会设 delivering）
    setRun((r) => clearGateForRun(r, 'running', r.stage))
    // 传真实的取消探针：确认交付的流式期间点"停止"必须被尊重——原先刻意恒 false，
    // 用户的停止会被交付收尾覆盖成 completed、还多发一条"已完成"通知
    await deliver(setRun, () => get()._cancelled, get)
  },

  supplement: (text) => {
    const run = get().run
    if (!run) return
    // 补充要求在"下一轮"生效，不悄悄修改已执行步骤（写入带 runId 归属，只落进打开的那条任务）
    setRunOf(set, run.id)((r) => ({ ...r, notes: [...(r.notes ?? []), `补充要求（下一轮生效）：${text}`] }))
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
    // 新建不会打断已在跑的任务（真跑着的时候必须先停止，否则新任务会抢同一个执行循环）；
    // _started 一并查：链刚起的窗口里 run 可能还没挂上，只查 runBusy 拦不住
    if (runBusy(get().run) || get()._started) {
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

  queueCurrent: () => {
    const goal = get().draft.trim()
    if (!goal) {
      useUi.getState().toast('请先描述任务目标', 'warn')
      return
    }
    // 入队那一刻定格：目标、文本附件正文（与 start 同一段组装逻辑）、计划态单次档。
    // 图片附件不入队（队列在内存里、不保存图片数据）；队列不持久化，重启即清空。
    const attachmentText = attachmentTextOf(get().attachments)
    const item: QueuedTask = {
      goal,
      queuedAt: Date.now(),
      ...(attachmentText ? { attachmentText } : {}),
      ...(get().planNextTask ? { planNextTask: true } : {})
    }
    const r = enqueue(get().queue, item)
    if (r.rejected) {
      useUi.getState().toast(r.rejected, 'warn')
      return
    }
    // 入队成功清空草稿、附件与单次档：文本已拼进队列条目，图片留在这里只会
    // 悄悄混进用户接下来写的另一个任务。花钱的事在入队时就说明白，不等开跑才说
    set({ queue: r.queue, draft: '', attachments: [], planNextTask: false })
    useUi.getState().toast(`已排入队列（第 ${r.queue.length} 个）：当前任务结束后自动开始，将消耗一次真实调用`, 'ok')
  },

  removeQueued: (index) => set((s) => ({ queue: s.queue.filter((_, i) => i !== index) })),

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
      if (!Array.isArray(runs) || runs.length === 0) {
        set({ tasks: [] })
        return
      }
      // 运行中状态无法核对 → 标记 interrupted，绝不盲目重放；停在确认门的可以接着等。
      // 崩溃残留可能不止一条"看起来在跑"的记录（多次崩溃会积累），每条点开都空占引擎位：
      // 在设当前 run 之前全部核销并逐条落盘，不只归零最新那条；"设为当前"仍只挑最新一条（原行为）
      const latestWasBusy = runBusy(runs[0])
      const settled = runs.map((r) => (runBusy(r) ? { ...r, status: 'interrupted' as const, stage: null } : r))
      for (let i = 0; i < runs.length; i++) {
        if (runBusy(runs[i])) await bridge.runs.save(settled[i])
      }
      set({ tasks: settled })
      if (latestWasBusy) {
        set({ run: settled[0] })
        useUi.getState().toast('已恢复上次任务记录；应用重启后执行状态未核对，不会自动继续执行', 'warn')
      } else if (settled[0].gate) {
        set({ run: settled[0] })
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
  /** 单角色重跑前任务状态快照（rerunRole 捕获；resumeChain 收尾时把状态与门还原回它） */
  snap?: RunSnapshot
}

/**
 * 从当前轮次的某个角色起跑完剩余链条：人工返工、中断续跑、单角色重跑共用这一条路。
 * 重跑一律"新增一张卡片"而不是原地改写——已经发生过一次真实调用，
 * 把那张卡抹掉等于把那次消耗藏起来。
 */
async function resumeRework(get: () => WorkflowState, set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void, opts: RoundOpts = {}) {
  const { feedback, startRole = 'executor', only, snap } = opts
  // 续跑与 start() 共用同一把"单执行循环"占用位，且由这一处统一置位与清位。
  // 入口先查再置（原先从不检查：链正在跑时 rerunRole/续跑照样能再起一条，两条链并发写同一个 run）。
  // 调用点推演（置位时 _started 必为 false，不存在"start 已置位又调这里"的路径）：
  // - rerunRole：入口已拦 runBusy(run) || _started，且拦完到调用之间无 await；
  // - resumeInterrupted：入口要求 status === 'interrupted'，链正跑时 status 是
  //   running/preparing/waiting_review，根本进不来；
  // - confirmGate 批准/返工两分支：入口要求 waiting_user + gate 挂出（有链在跑时不可能处于
  //   该态），分支置 running 与调用之间同样无 await。
  if (get()._started) return
  set({ _cancelled: false, _started: true })
  const runId = get().run?.id ?? null
  const setRun = setRunOf(set, runId)
  // 看门狗与 start() 同源同语义：返工/续跑/批准后续跑/单角色重跑中请求挂起，原先只能手动 stop
  const watchdog = makeWatchdog(get, get().config.timeoutMin * 60 * 1000)
  try {
    await resumeChain(get, set, { feedback, startRole, only, snap })
  } catch (err) {
    // 链上任一 IPC reject（账本核对、产物目录解析、清单读取、文本落盘…）不许把任务卡死在 running
    failRun(setRun, get, '续跑/返工链', err)
  } finally {
    clearTimeout(watchdog)
    set({ _started: false })
    // 与 start() 的 finally 同理：占用位释放后接队，队列里排着的任务在终态后自动开始
    void pumpQueue(set, get)
  }
}

async function resumeChain(get: () => WorkflowState, set: (partial: Partial<WorkflowState> | ((s: WorkflowState) => Partial<WorkflowState>)) => void, opts: RoundOpts) {
  const { feedback, startRole = 'executor', only, snap } = opts
  const state = get()
  const run = state.run
  const cfg = state.config
  if (!run) return
  // 只写"这条链的 run"（入口捕获 id）：返工/续跑也是长链，迟到的流式写不许落进切换后的别的任务
  const setRun = setRunOf(set, run.id)
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

  // 只重跑单个角色：到这里就收，判定与确认门都留给原来的卡片（不改写历史——新增卡片保留）。
  // 状态与门还原到重跑前（快照来自 rerunRole，restoreSnapshot 是统一形状）：
  // waiting_user 带门 → 门重新挂上让人拿最新结论再决定；completed → 仍 completed、引擎位释放。
  // 不还原则 run 永停 running，runBusy 恒真，切换/新建/删除全被空占，只能手动 stop
  if (only || !review) {
    if (snap) {
      setRun((r) => restoreSnapshot(r, snap))
    }
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
