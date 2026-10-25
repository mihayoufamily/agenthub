/**
 * 命令审批的有状态部分：待裁决队列 + 白名单落盘 + 审批历史。
 * 纯规则判定在 shared/approvals.ts（那条链不碰 electron，验证脚本能直接跑）。
 *
 * 为什么要有它：allowCommands 是一刀切——勾上之后 agent 能在目录里跑任何命令，
 * 用户既看不到"刚才到底跑了什么"，也没有"这条以后不用再问"的粒度。
 *
 * 白名单落在主进程 approvals.json（不在 agent config 里）：渲染层写不动它，
 * 免得"自我提权"顺着配置通道回来。
 */
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import type { ApprovalDecision, ApprovalRecord, ApprovalRequest } from '../shared/types'
import { dangerousHit, rulesToAdd } from '../shared/approvals'

export type { ApprovalDecision, ApprovalRecord, ApprovalRequest }
export { normalizeCommand, splitSegments, ruleMatches, dangerousHit, checkCommand, rulesToAdd } from '../shared/approvals'

const MAX_RECORDS = 500
/** 待裁决超时：超时按拒绝收场，绝不因为界面没反应就把命令放了 */
export const APPROVAL_TIMEOUT_MS = 180_000

let dataPath = ''

/** 由主进程启动时注入落盘位置（不注入就不碰磁盘，逻辑层可直接测队列与判定） */
export function init(filePath: string) {
  dataPath = filePath
}

interface ApprovalFile {
  /** agentId -> 白名单规则 */
  rules: Record<string, string[]>
  /** 已确认信任的 MCP server id（首次连接确认后整组放行） */
  mcpTrusted: string[]
  records: ApprovalRecord[]
}

function read(): ApprovalFile {
  try {
    if (!dataPath || !existsSync(dataPath)) return { rules: {}, mcpTrusted: [], records: [] }
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8')) as Partial<ApprovalFile>
    return { rules: raw.rules ?? {}, mcpTrusted: raw.mcpTrusted ?? [], records: raw.records ?? [] }
  } catch {
    // fail-safe 返回空（读不到/读不懂就当空起步，不把判定打死）；写侧已原子化（write 的 tmp+rename），
    // 正常不该再读到写一半的残缺 JSON——走到这里多半是外部把文件改坏了
    return { rules: {}, mcpTrusted: [], records: [] }
  }
}

function write(data: ApprovalFile) {
  if (!dataPath) return
  try {
    const dir = join(dataPath, '..')
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 原子写：先写同目录 .tmp 再 rename 替换。直接 writeFileSync 覆盖时进程写一半崩溃，
    // approvals.json 会变成残缺 JSON，read 的 fail-safe 返回空——白名单/MCP 信任/审批历史全静默丢。
    // 同目录 renameSync 在 NTFS 上是原子替换：防的是进程写盘中断，不承诺断电级持久
    // （NTFS 日志下 rename 替换已是本层能做的最强手段）。
    const tmp = `${dataPath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, dataPath)
  } catch {
    // 审批文件写不进不能把真实调用打死；下一次判定会重新读
  }
}

export function rulesFor(agentId?: string): string[] {
  if (!agentId) return []
  return read().rules[agentId] ?? []
}

export function allRules(): Record<string, string[]> {
  return read().rules
}

export function setRules(agentId: string, rules: string[]): string[] {
  const data = read()
  const cleaned = Array.from(new Set(rules.map((r) => r.trim().toLowerCase()).filter(Boolean))).slice(0, 200)
  data.rules = { ...data.rules, [agentId]: cleaned }
  write(data)
  return cleaned
}

export function addRules(agentId: string, rules: string[]): string[] {
  const data = read()
  const cur = data.rules[agentId] ?? []
  const next = Array.from(new Set([...cur, ...rules.map((r) => r.trim().toLowerCase()).filter(Boolean)])).slice(0, 200)
  data.rules = { ...data.rules, [agentId]: next }
  write(data)
  return next
}

/** MCP 信任：首次连接确认后整组放行；撤销信任下次就要重新确认 */
export function mcpTrusted(): string[] {
  return read().mcpTrusted
}

export function isMcpTrusted(id: string): boolean {
  return read().mcpTrusted.includes(id)
}

export function setMcpTrust(id: string, trusted: boolean): string[] {
  const data = read()
  data.mcpTrusted = trusted ? Array.from(new Set([...data.mcpTrusted, id])) : data.mcpTrusted.filter((x) => x !== id)
  write(data)
  return data.mcpTrusted
}

export function listRecords(limit = 200): ApprovalRecord[] {  return read().records.slice(-limit).reverse()
}

export function clearRecords() {
  const data = read()
  data.records = []
  write(data)
}

function pushRecord(rec: ApprovalRecord) {
  const data = read()
  data.records = [...data.records, rec].slice(-MAX_RECORDS)
  write(data)
}

// ---------- 待裁决队列（主进程持有 Promise，界面点完再落地） ----------

interface Pending {
  req: ApprovalRequest
  resolve: (d: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

function toRecord(req: ApprovalRequest, decision: ApprovalDecision): ApprovalRecord {
  return {
    id: req.id,
    ts: req.ts,
    tool: req.tool,
    command: req.command,
    dir: req.dir,
    agentName: req.agentName,
    decision,
    // 预览请求把改动规模带进历史：事后审计时能想起当时在写什么
    reason: req.kind === 'diff' && !req.reason.includes('行差异') ? `${req.reason}（约 ${Math.max(1, (req.diff ?? '').split('\n').filter((l) => /^[+-]/.test(l)).length)} 行差异）` : req.reason
  }
}

/**
 * 发起一次审批：把请求 send 给渲染层，等裁决结果。
 * 超时 / 该流被取消 / 界面没接住——一律按拒绝，并留下如实的历史。
 */
export function requestApproval(
  req: ApprovalRequest,
  send: (req: ApprovalRequest) => void,
  timeoutMs = APPROVAL_TIMEOUT_MS
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let done = false
    const settle = (d: ApprovalDecision) => {
      if (done) return
      done = true
      clearTimeout(timer)
      pending.delete(req.id)
      resolve(d)
    }
    const timer = setTimeout(() => {
      settle('deny')
      pushRecord({ ...toRecord(req, 'deny'), reason: `${req.reason}（${Math.round(timeoutMs / 1000)}s 内无人确认，按拒绝处理）` })
    }, timeoutMs)
    pending.set(req.id, { req, resolve: settle, timer })
    send(req)
  })
}

/** 界面点完：落地裁决 + 写历史（always 时把未覆盖的片段补进白名单） */
export function resolveApproval(id: string, decision: ApprovalDecision): { ok: boolean; message?: string } {
  const p = pending.get(id)
  if (!p) return { ok: false, message: '该审批已超时或已结束（不在这里重复放行）' }
  const { req } = p
  const hit = req.kind === 'mcp' || req.kind === 'diff' ? null : dangerousHit(req.command)
  // 三种请求各有不同的"始终允许"含义：
  // 命令 = 把片段写进该 Agent 白名单；MCP = 信任这个 server（整组放行）；
  // 写前预览 = 不适用，一次覆盖一次问，真收到 always 也只当本次允许
  let ruleNote: string | undefined
  if (decision === 'always' && req.kind === 'mcp' && req.mcpServerId) {
    setMcpTrust(req.mcpServerId, true)
    ruleNote = `已信任 MCP server ${req.command}`
  } else if (decision === 'always' && req.kind === 'diff') {
    ruleNote = '写前预览不适用白名单，本次仅放行这一次覆盖'
  } else if (decision === 'always' && hit) {
    ruleNote = `危险形态不写白名单（${hit}）`
  } else if (decision === 'always') {
    const rule = rulesToAdd(req.uncovered?.length ? req.uncovered : [req.command])
    if (rule.length && req.agentId) {
      addRules(req.agentId, rule)
      ruleNote = rule.join(' ｜ ')
    }
  }
  pushRecord({ ...toRecord(req, decision), ...(ruleNote ? { rule: ruleNote } : {}) })
  p.resolve(decision)
  return { ok: true }
}

/** 某条流被取消：它挂着的审批全部按拒绝收掉，别让界面留一张死弹窗 */
export function denyPendingFor(reqId: string): number {
  let n = 0
  for (const [id, p] of pending) {
    if (p.req.reqId !== reqId) continue
    pushRecord({ ...toRecord(p.req, 'deny'), reason: `${p.req.reason}（该请求已被取消）` })
    p.resolve('deny')
    pending.delete(id)
    n++
  }
  // 挂着的提问同样收掉（null = 未回答），模型那边如实拿到"用户没有回答"
  for (const [id, q] of pendingQ) {
    if (q.req.reqId !== reqId) continue
    clearTimeout(q.timer)
    pendingQ.delete(id)
    q.resolve(null)
    n++
  }
  return n
}

export function pendingList(): ApprovalRequest[] {
  return [...pending.values(), ...pendingQ.values()].map((p) => p.req)
}

// ---------- ask_user 的提问队列（与审批同一条推送通道，但不写审批历史：提问不是安全裁决） ----------

interface PendingQ {
  req: ApprovalRequest
  resolve: (answer: string | null) => void
  timer: NodeJS.Timeout
}

const pendingQ = new Map<string, PendingQ>()

/**
 * 发起一次提问：把问题 send 给渲染层，等用户的回答文本。
 * 超时 / 该流被取消 / 界面没接住——一律按 null（未回答）收场并如实告知模型。
 */
export function requestQuestion(
  req: ApprovalRequest,
  send: (req: ApprovalRequest) => void,
  timeoutMs = APPROVAL_TIMEOUT_MS
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let done = false
    const settle = (answer: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      pendingQ.delete(req.id)
      resolve(answer)
    }
    const timer = setTimeout(() => settle(null), timeoutMs)
    pendingQ.set(req.id, { req, resolve: settle, timer })
    send(req)
  })
}

/** 界面提交回答：空文本按"跳过"处理（null），主调用拿到的是如实的未回答 */
export function resolveQuestion(id: string, answer: string): { ok: boolean; message?: string } {
  const p = pendingQ.get(id)
  if (!p) return { ok: false, message: '该提问已超时或已结束' }
  const text = typeof answer === 'string' ? answer.trim() : ''
  clearTimeout(p.timer)
  pendingQ.delete(id)
  p.resolve(text || null)
  return { ok: true }
}
