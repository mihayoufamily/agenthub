// 工具 Hook 的纯规则层（main / renderer / 验证脚本共用；不碰 node 与磁盘）
//
// 语义固定，不给界面另编一套：
// - pre：退出码非 0 = 否决这次调用，脚本的 stdout/stderr 原样回传给模型；
// - post：只观察与后处理，失败不撤销已发生的改动，但如实报告；
// - 数据只通过环境变量传入：命令是人写的、参数是模型给的，
//   把参数拼进命令串等于把注入面留在自己的脚本里。超长参数（超过 HOOK_ARGS_FILE_THRESHOLD）
//   时执行层改走临时文件载体（AHUB_HOOK_ARGS_FILE 指路径、AHUB_HOOK_ARGS 置空），
//   同样不经命令行拼接——只是换了载体，注入面没有变大。
import type { HookRule, RejectedEntry } from './types'

export const HOOK_DEFAULT_TIMEOUT = 15_000

/**
 * 单条 Hook 命令的长度上限（字符）。界要定在**进入的数据**上，不是定在渲染上：
 * 轮 2 把界定在显示那一半（脱敏前先把命令截到 512 字符），结果把脱敏规则赖以判断的
 * 前后瞻上下文一起截掉了——口令段一长就变成"该遮的没遮"。
 * 取 4096：① 显示脱敏与设置页渲染的成本因此有上界（脱敏器本身本轮已改成线性，两条都有界）；
 * ② Windows 命令行有 ~32K 的 CreateProcess 上限，几百 KB 的"命令"根本跑不起来，
 *   与其在执行时炸一条看不懂的重启错误，不如在保存这一步说清楚。
 * 超了是**拒绝保存**（带数字的消息），不静默截断——截断等于悄悄改掉你要执行的命令。
 * 已经存在的超长规则（手搓的 config.json）不在此管的范围内：它们仍能被显示出来，
 * 靠的是脱敏器线性 + 显示只取 REDACT_VISIBLE_LIMIT 这一半，不会把设置页拖住。
 */
export const HOOK_COMMAND_MAX_LENGTH = 4096

/** 规则是否命中这次工具调用：match 是用户写的正则，非法就不命中（坏规则不该拦下所有工具） */
export function matchHook(rule: HookRule, tool: string): boolean {
  if (rule.enabled === false) return false
  const pat = rule.match?.trim()
  if (!pat) return true
  try {
    return new RegExp(pat, 'i').test(tool)
  } catch {
    return false
  }
}

/**
 * AHUB_HOOK_ARGS 换用临时文件载体的阈值（字符）。Windows 单个环境变量约 32767 字符上限，
 * 而 write_file 的内容可达 1MB：整包塞进环境变量时 spawn 直接失败，pre Hook 会被误判成
 * "否决"（退出码 null 的误导提示）。超过阈值时 main/hooks.ts（执行层）把 argsJson 写进
 * 临时文件，环境变量改给 AHUB_HOOK_ARGS_FILE（文件路径）并把 AHUB_HOOK_ARGS 置空，
 * Hook 进程退出后删除该文件。取 30000 是给 32767 留余量。本层是纯规则层不碰磁盘，
 * 只定契约；hookEnv 本身仍按原样构建，换载体由执行层在其结果上覆盖。
 */
export const HOOK_ARGS_FILE_THRESHOLD = 30000

export interface HookEnvInput {
  tool: string
  argsJson: string
  dir?: string
  result?: { ok: boolean; output: string; writtenPath?: string }
  agentId?: string
  agentName?: string
  runId?: string
  reqId?: string
}

/** 传给脚本的环境变量（一律字符串化，缺省给空串而不是省略：脚本读起来不用防 undefined）。
 *  AHUB_HOOK_ARGS 过长时不在这层换载体（纯规则层不碰磁盘）：执行层会置空它并补一个
 *  AHUB_HOOK_ARGS_FILE 指向临时文件，见 HOOK_ARGS_FILE_THRESHOLD。 */
export function hookEnv(event: 'pre' | 'post', ctx: HookEnvInput): Record<string, string> {
  return {
    AHUB_HOOK_EVENT: event,
    AHUB_HOOK_TOOL: ctx.tool,
    AHUB_HOOK_ARGS: ctx.argsJson,
    AHUB_HOOK_DIR: ctx.dir ?? '',
    AHUB_HOOK_RESULT: event === 'post' ? ctx.result?.output ?? '' : '',
    AHUB_HOOK_OK: event === 'post' ? (ctx.result?.ok ? '1' : '0') : '',
    AHUB_HOOK_FILE: event === 'post' ? ctx.result?.writtenPath ?? '' : '',
    AHUB_AGENT_ID: ctx.agentId ?? '',
    AHUB_AGENT_NAME: ctx.agentName ?? '',
    AHUB_RUN_ID: ctx.runId ?? '',
    AHUB_REQ_ID: ctx.reqId ?? ''
  }
}

/** 校验一条规则：命令不能空、长度要有界、正则要能编译、超时要有界 */
export function validateHook(rule: { event?: string; command?: string; match?: string; timeoutMs?: number }): { ok: boolean; message?: string } {
  if (rule.event !== 'pre' && rule.event !== 'post') return { ok: false, message: '事件只能是 pre 或 post' }
  if (!rule.command?.trim()) return { ok: false, message: '命令不能为空' }
  if (rule.command.length > HOOK_COMMAND_MAX_LENGTH) {
    return {
      ok: false,
      message: `命令最长 ${HOOK_COMMAND_MAX_LENGTH} 个字符（当前 ${rule.command.length} 个）；这里不替你截断，请把它挪进脚本或配置文件，Hook 只留调用那一行`
    }
  }
  if (rule.match?.trim()) {
    try {
      new RegExp(rule.match, 'i')
    } catch (e) {
      return { ok: false, message: `匹配正则不合法：${(e as Error).message}` }
    }
  }
  if (rule.timeoutMs != null && (Number(rule.timeoutMs) < 0 || Number(rule.timeoutMs) > 300_000)) {
    return { ok: false, message: '超时请填 0～300000 毫秒' }
  }
  return { ok: true }
}

/**
 * 一张 hooks 表"界面上"最多加多少条。**只作用于新增那一关**（设置页的添加按钮到上限就禁用），
 * 不再作用于落盘：保存整表时按条数截断等于替用户删数据，而这正是本闸门要消灭的那类静默。
 * 手改/导入进来 50 条的配置会原样保住，只是界面不再让你继续加。
 */
export const HOOK_RULES_MAX = 40

/**
 * `hooks:set` 的落盘闸门（修复波 A · 项 3）。返回「该存什么」与「哪些条目没被接受、为什么」。
 *
 * 旧写法是 `list.filter((h) => validateHook(h).ok).slice(0, 40)`，两个静默：
 * ① 对**整表**重校验并按 ok 过滤，而界面那次 save 提交的正是整表
 *   （SettingsPage 的 patch → save(rules.map(...))）——用户拨一下任意一个 Hook 开关，
 *   一条 >4096 字符的旧规则（导入来的 / 手改的 / v0.3.0 写的）就地消失；
 * ② 第 41 条被 .slice 丢掉，同样没人说。
 *
 * 现在的口径按仓库既有先例：**不删用户数据**（Task 4「重填不得销毁旧记录」、Ruling I「迁移从不删」）。
 * 校验不通过的条目**原样留在配置里**，只把原因回给界面显示，由用户自己决定改短还是删掉——
 * 程序替他删还不告诉他，是不可恢复的那一类。这里能保留是因为 hooks:list 原样返回整表、
 * 设置页看得见也改得动；MCP 那一侧的读路径（sanitizeMcpList）本来就不返回形状不合格的记录，
 * 保留只会造成"存了但看不见"，所以那边是点名回界面而不保留（见 shared/mcp-list.partitionMcpServers）。
 *
 * 上限只挡**界面新增**，不在落盘时截断（复审 finding 3 的残口）：旧实现在这里
 * `if (valid >= HOOK_RULES_MAX) { rejected.push('最多 40 条，这一条没有保存'); continue }`
 * ——那仍然是把用户表尾的条目删掉、只是顺带说了一声。现在合法条目**一律保留**，
 * 上限交给设置页的添加按钮（到上限禁用并说明），"不删用户数据"才对校验与条数两类都成立。
 * 残片（null / 字符串 / 数字）不保留：那不是用户数据，而 hooks:list 现在也会滤掉非对象
 * （读路径的形状闸门见 src/main/ipc.ts），留着只会变成"存了但看不见又改不动"。
 */
/**
 * `hooks:list` 的读路径形状闸门（与 mcp-list.sanitizeMcpList 同一口径）：
 * 手改 config.json 塞进来的 null / 字符串 / 数字不进渲染层——否则设置页 `rules.map` 当场解引用炸掉，
 * 而且炸在读取阶段，用户连"哪一条坏了"都看不到。非数组一律当空表。
 */
export function sanitizeHookList(list: unknown): HookRule[] {
  return Array.isArray(list) ? (list.filter((h) => !!h && typeof h === 'object') as HookRule[]) : []
}

export function partitionHookRules(list: unknown): { kept: HookRule[]; rejected: RejectedEntry[] } {
  const incoming: unknown[] = Array.isArray(list) ? list : []
  const kept: HookRule[] = []
  const rejected: RejectedEntry[] = []
  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i]
    const isRule = !!raw && typeof raw === 'object'
    const id = String((isRule ? (raw as { id?: unknown }).id : undefined) ?? `#${i + 1}`)
    // 残片按"空规则"过一遍 validateHook，为的是拿它**既有的**那句措辞，不另编一套
    const v = validateHook((isRule ? raw : {}) as { event?: string; command?: string; match?: string; timeoutMs?: number })
    if (!v.ok) {
      rejected.push({ id, message: v.message ?? '事件只能是 pre 或 post' })
      if (isRule) kept.push(raw as HookRule)
      continue
    }
    kept.push(raw as HookRule)
  }
  return { kept, rejected }
}
