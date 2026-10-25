/**
 * 工具 Hook 的执行层：把用户配置的命令在工具调用前后跑一遍。
 * 纯规则（匹配、环境变量、校验）在 shared/hooks.ts，界面与主进程用同一套。
 *
 * 风险如实说明：配了 Hook 就是让 AgentHub 在每次工具调用时替你执行这些命令，
 * 与命令审批不同，Hook 不再逐条问你。工作目录固定为该 Agent 的沙箱根，
 * 超时与输出都有上限，执行记录随工具结果回传，界面与模型看到的是同一份。
 */
import type { HookRule, HookRun } from '../shared/types'
import { HOOK_DEFAULT_TIMEOUT, matchHook, hookEnv, HOOK_ARGS_FILE_THRESHOLD, type HookEnvInput } from '../shared/hooks'
import { runShell } from './shell'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { HOOK_DEFAULT_TIMEOUT, matchHook, hookEnv, validateHook } from '../shared/hooks'
export type { HookEnvInput }

const MAX_NOTE = 1200

export interface HookContext extends HookEnvInput {}

export interface HookOutcome {
  /** pre 阶段被脚本否决 */
  blocked: boolean
  runs: HookRun[]
  /** 要拼进工具结果给模型看的说明 */
  notes: string[]
}

const empty = (): HookOutcome => ({ blocked: false, runs: [], notes: [] })

/**
 * 跑一批 Hook（串行：并行跑会互相抢工作目录里的文件，脚本作者通常也默认自己是顺序的）。
 * 没有规则时不产生任何副作用。
 */
export async function runHooks(
  event: 'pre' | 'post',
  rules: HookRule[] | undefined,
  ctx: HookContext,
  signal?: AbortSignal
): Promise<HookOutcome> {
  const active = (rules ?? []).filter((r) => r.event === event && matchHook(r, ctx.tool))
  if (!active.length) return empty()
  const out = empty()
  // argsJson 整包塞 AHUB_HOOK_ARGS 会撞 Windows 单环境变量约 32767 字符的上限（write_file 的
  // 内容可达 1MB）：spawn 直接失败，pre Hook 被误判成"否决"（退出码 null 的误导提示）。
  // 超阈值（留了余量的 30000，契约在 shared/hooks.ts）改走临时文件：AHUB_HOOK_ARGS_FILE 给
  // 路径、AHUB_HOOK_ARGS 置空。参数仍然不经字符串拼接进命令行——只是超长时换个载体。
  // 临时文件写不进（tmp 不可用之类）就退回原通道，让失败如实发生，不假装参数已传到。
  let env = hookEnv(event, ctx)
  let argsFile = ''
  if (ctx.argsJson.length > HOOK_ARGS_FILE_THRESHOLD) {
    const f = join(tmpdir(), `ahub-hook-args-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    try {
      await fs.writeFile(f, ctx.argsJson, 'utf-8')
      argsFile = f
      env = { ...env, AHUB_HOOK_ARGS: '', AHUB_HOOK_ARGS_FILE: f }
    } catch { /* 退回整包 env：行为与旧版一致 */ }
  }
  try {
    for (const rule of active) {
      const timeoutMs = rule.timeoutMs && rule.timeoutMs > 0 ? rule.timeoutMs : HOOK_DEFAULT_TIMEOUT
      const sh = await runShell(rule.command, {
        ...(ctx.dir ? { cwd: ctx.dir } : {}),
        timeoutMs,
        env,
        ...(signal ? { signal } : {})
      })
      const exit = sh.code
      const blocked = event === 'pre' && (!sh.ok || exit !== 0 || sh.timedOut)
      const body = (sh.output || sh.error || '').trim().slice(0, MAX_NOTE)
      const run: HookRun = {
        id: rule.id,
        command: rule.command,
        exit,
        ok: !blocked,
        blocked,
        ...(sh.timedOut ? { timedOut: true } : {}),
        ...(body ? { output: body } : {})
      }
      out.runs.push(run)
      if (sh.timedOut) out.notes.push(`[hook ${event} ${rule.id}] 超时（${timeoutMs / 1000}s）已终止`)
      if (blocked) {
        out.blocked = true
        out.notes.push(`[hook pre ${rule.id}] 否决本次调用：${body || `退出码 ${exit ?? 'null'}`}`)
        // 已经否决就不用再跑后面的 pre 脚本
        break
      }
      if (body) out.notes.push(`[hook ${event} ${rule.id}] ${body}`)
    }
  } finally {
    // Hook 进程跑完（无论成败、包括中途 break）都清掉临时文件：
    // 里面是工具参数原文，不该在 tmp 里留副本（best-effort，清不掉不影响结果上报）
    if (argsFile) await fs.rm(argsFile, { force: true }).catch(() => { /* best-effort */ })
  }
  return out
}
