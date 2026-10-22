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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
  records: ApprovalRecord[]
}

function read(): ApprovalFile {
  try {
    if (!dataPath || !existsSync(dataPath)) return { rules: {}, records: [] }
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8')) as Partial<ApprovalFile>
    return { rules: raw.rules ?? {}, records: raw.records ?? [] }
  } catch {
    return { rules: {}, records: [] }
  }
}

function write(data: ApprovalFile) {
  if (!dataPath) return
  try {
    const dir = join(dataPath, '..')
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8')
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

export function listRecords(limit = 200): ApprovalRecord[] {
  return read().records.slice(-limit).reverse()
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
  const hit = dangerousHit(req.command)
  // 写前预览（kind='diff'）不存在"始终允许"：每次覆盖要单独看，
  // 真收到 always 也只当本次允许，不往白名单里塞路径
  const whitelistable = req.kind !== 'diff' && !hit
  const rule = decision === 'always' && whitelistable ? rulesToAdd(req.uncovered?.length ? req.uncovered : [req.command]) : undefined
  if (rule?.length && req.agentId) addRules(req.agentId, rule)
  pushRecord({
    ...toRecord(req, decision),
    ...(rule?.length ? { rule: rule.join(' ｜ ') } : hit && decision === 'always' ? { rule: `危险形态不写白名单（${hit}）` } : decision === 'always' && req.kind === 'diff' ? { rule: '写前预览不适用白名单，本次仅放行这一次覆盖' } : {})
  })
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
  return n
}

export function pendingList(): ApprovalRequest[] {
  return Array.from(pending.values()).map((p) => p.req)
}
