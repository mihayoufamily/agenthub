/**
 * 调用账本：每次真实调用（模型 / CLI）落一条脱敏记录，供设置页的「用量统计」与「最近调用」使用。
 *
 * 为什么需要：出问题时界面只有一句"进程启动失败"，谁都不知道当时到底发生了什么
 * （上一轮 WorkBuddy 的排查就是靠临时写 CDP 脚本才定位到工作目录不存在）。
 *
 * 隐私边界（硬要求）：只记元数据——耗时、事件数、token、错误信息。
 * 不记请求正文、不记响应正文、不记任何凭据；导出文件同样只含这些字段。
 */
import { app } from 'electron'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { estimateCost } from '../shared/pricing'
import type { LedgerEntry, LedgerUsageRow } from '../shared/types'

export type { LedgerEntry, LedgerUsageRow }

const MAX_ENTRIES = 2000

let cached = ''
const file = () => {
  if (!cached) cached = join(app.getPath('userData'), 'ledger.jsonl')
  return cached
}

function readLines(): string[] {
  const p = file()
  return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean) : []
}

export function record(e: LedgerEntry) {
  try {
    const p = file()
    const dir = dirname(p)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const lines = readLines()
    lines.push(JSON.stringify(e))
    writeFileSync(p, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf-8')
  } catch {
    // 账本写不进绝不能影响真实调用
  }
}

/** 补算费用：账本里没有 cost 的条目按当前单价现算（无单价保持不显示，不编造） */
function withCost(e: LedgerEntry): LedgerEntry {
  if (e.cost !== undefined) return e
  const usage = e.tokens || e.prompt || e.completion ? { tokens: e.tokens, prompt: e.prompt, completion: e.completion } : undefined
  const cost = estimateCost(e.model, usage)
  return cost == null ? e : { ...e, cost }
}

export function list(limit = 500): LedgerEntry[] {
  try {
    return readLines()
      .map((l) => {
        try {
          return withCost(JSON.parse(l) as LedgerEntry)
        } catch {
          return null
        }
      })
      .filter((x): x is LedgerEntry => !!x)
      .slice(-limit)
  } catch {
    return []
  }
}

export function clear() {
  try {
    writeFileSync(file(), '', 'utf-8')
  } catch {
    // 忽略
  }
}

/** 导出全文（字段本身就是元数据，不含正文与凭据） */
export function dump(): string {
  try {
    return readLines().join('\n') + '\n'
  } catch {
    return ''
  }
}

/** 按 harness × 模型 聚合用量 */
export function aggregate(entries: LedgerEntry[]): LedgerUsageRow[] {
  const map = new Map<string, LedgerUsageRow>()
  for (const e of entries) {
    const model = e.model || '（未上报模型名）'
    const key = `${e.harness}|${model}`
    const row = map.get(key) ?? {
      harness: e.harness, model, calls: 0, ok: 0, failed: 0,
      tokens: 0, prompt: 0, completion: 0, cost: 0, noUsage: 0, ms: 0
    }
    row.calls++
    if (e.ok) row.ok++
    else row.failed++
    const reported = (e.tokens ?? 0) + (e.prompt ?? 0) + (e.completion ?? 0)
    if (!reported) row.noUsage++
    row.tokens += e.tokens ?? 0
    row.prompt += e.prompt ?? 0
    row.completion += e.completion ?? 0
    row.cost += e.cost ?? 0
    row.ms += e.ms ?? 0
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || b.calls - a.calls)
}
