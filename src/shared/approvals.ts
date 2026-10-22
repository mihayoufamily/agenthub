// 命令审批的纯规则层（main / renderer / 验证脚本共用；不碰 electron 与磁盘）
//
// 三层判定，顺序固定：
// ① 危险形态（rm -rf / del /s / format / curl|sh 这类）——**白名单不能覆盖**，一律要人确认；
// ② 命令按 && || ; | 拆段，每一段都要被白名单规则单独覆盖，`npm test && del C:\*` 不能因为
//    "npm test 在白名单里"就整条放行；
// ③ 规则默认整段相等才放行，只有以 `*` 结尾才是前缀放行——想放宽必须显式写通配，不靠猜。
import type { ApprovalDecision, ApprovalRecord, ApprovalRequest } from './types'

export type { ApprovalDecision, ApprovalRecord, ApprovalRequest }

/** 规范化：折叠空白 + 小写（Windows 大小写不敏感，命令与规则同口径才比得准） */
export function normalizeCommand(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 引号感知的命令分段：Windows 上 && || ; | 才是"另一条命令"的边界 */
export function splitSegments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (q) {
      cur += ch
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    if (ch === ';' || ch === '|') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 规则匹配：以 * 结尾 = 前缀放行，否则整段相等 */
export function ruleMatches(rule: string, segment: string): boolean {
  const r = normalizeCommand(rule)
  const s = normalizeCommand(segment)
  if (!r || !s) return false
  if (r.endsWith('*')) {
    const head = r.slice(0, -1).trimEnd()
    return !!head && (s === head || s.startsWith(head + ' '))
  }
  return s === r
}

/** 危险形态：这些不论白名单里写了什么都必须人工确认 */
const DANGEROUS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+(?:-[a-z]+\s+)*-[a-z]*[rf][a-z]*\b/i, label: '递归/强制删除（rm -rf）' },
  { re: /\bdel\s+\/s/i, label: '递归删除（del /s）' },
  { re: /\berase\s+\/s/i, label: '递归删除（erase /s）' },
  { re: /\bformat(?:\s+\/[a-z])*\s+[a-z]:/i, label: '格式化磁盘（format）' },
  { re: /\bmkfs\b/i, label: '重建文件系统（mkfs）' },
  { re: /\b(shutdown|reboot|logoff)\b/i, label: '关机/重启' },
  { re: /\bnet\s+user\b/i, label: '改动系统账户（net user）' },
  { re: /\breg\s+(delete|add)\b/i, label: '改动注册表（reg）' },
  { re: /\bset-mppreference\b/i, label: '改动 Defender 策略' },
  { re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, label: '网络脚本直接执行（curl | sh）' },
  { re: /\bgit\s+push\b[^&|;]*--force(?:-with-lease)?\b/i, label: '强制推送（git push --force）' },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)\b/i, label: '丢弃工作区（git reset --hard / clean -f）' }
]

/** 命中的危险形态名称（没命中返回 null） */
export function dangerousHit(command: string): string | null {
  for (const d of DANGEROUS) if (d.re.test(command)) return d.label
  return null
}

export interface CommandVerdict {
  allowed: boolean
  /** 为什么要问（界面与历史都用它，不另编一套话术） */
  reason: string
  /** 未被覆盖的片段 */
  uncovered: string[]
}

/** 白名单判定：危险形态优先，其次逐段核对 */
export function checkCommand(command: string, rules: string[]): CommandVerdict {
  const hit = dangerousHit(command)
  if (hit) return { allowed: false, reason: `命中危险形态，白名单不放行：${hit}`, uncovered: [command.trim()] }
  const segs = splitSegments(command)
  if (!segs.length) return { allowed: false, reason: '命令为空', uncovered: [] }
  if (!rules.length) return { allowed: false, reason: '尚未配置命令白名单（每条命令都要确认）', uncovered: segs }
  const uncovered = segs.filter((s) => !rules.some((r) => ruleMatches(r, s)))
  if (!uncovered.length) return { allowed: true, reason: '白名单已覆盖', uncovered: [] }
  return { allowed: false, reason: '不在命令白名单内', uncovered }
}

/** 点「始终允许」时该写入哪些规则：只补真正没被覆盖的那几段 */
export function rulesToAdd(uncovered: string[]): string[] {
  return Array.from(new Set(uncovered.map((s) => normalizeCommand(s)).filter(Boolean)))
}
