// 工具 Hook 的纯规则层（main / renderer / 验证脚本共用；不碰 node 与磁盘）
//
// 语义固定，不给界面另编一套：
// - pre：退出码非 0 = 否决这次调用，脚本的 stdout/stderr 原样回传给模型；
// - post：只观察与后处理，失败不撤销已发生的改动，但如实报告；
// - 数据只通过环境变量传入：命令是人写的、参数是模型给的，
//   把参数拼进命令串等于把注入面留在自己的脚本里。
import type { HookRule } from './types'

export const HOOK_DEFAULT_TIMEOUT = 15_000

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

/** 传给脚本的环境变量（一律字符串化，缺省给空串而不是省略：脚本读起来不用防 undefined） */
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

/** 校验一条规则：命令不能空、正则要能编译、超时要有界 */
export function validateHook(rule: { event?: string; command?: string; match?: string; timeoutMs?: number }): { ok: boolean; message?: string } {
  if (rule.event !== 'pre' && rule.event !== 'post') return { ok: false, message: '事件只能是 pre 或 post' }
  if (!rule.command?.trim()) return { ok: false, message: '命令不能为空' }
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
