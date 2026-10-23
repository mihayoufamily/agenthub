import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type { ChatChunkEvent } from './openai'
import { humanizeError } from './openai'
import { killTree } from '../shell'
import type { ThinkingLevel } from '../../shared/types'

/**
 * 本机 Agent CLI 执行适配层（接入"现成 Agent"而非"模型 API"，规格 §10）。
 * 由 CLI 自身完成执行与凭据管理：AgentHub 不读取其配置、不保存其密钥。
 *
 * 实现状态（如实声明，均为本机实测）：
 *  - arkcli：已安装，真实流式 NDJSON 全链路实测
 *  - codex：真实调用实测（JSONL 事件流）；失败路径（429/配置告警）如实上抛
 *  - codebuddy：WorkBuddy 内置的 CodeBuddy Code CLI，真实调用实测；
 *    未登录时 CLI 自己返回 "Authentication required"，本层原样透出，绝不伪装成可用
 *  - dsh：DeepSeek Harness 的 headless 模式；CLI 可启动，但当前安装缺少模型凭据时
 *    会返回 MISSING_CREDENTIAL，本层如实透出
 *  - claude：按官方 CLI 非交互模式规范实现，本机未安装、未实测
 *
 * 安全约定：
 *  1) 所有参数以数组直接 spawn（不经 shell），用户输入不会被解释为命令行元字符；
 *  2) stdin 一律关闭（ignore），避免 CLI 等待 stdin 导致挂起；
 *  3) 非 PATH 安装（WorkBuddy 内置 CLI / DSH / Codex 应用）按"已知位置 + 盘符浅扫描"
 *     定位，找不到就如实返回 null，绝不猜测执行。
 */

export type CliName = 'arkcli' | 'claude' | 'codex' | 'codebuddy' | 'dsh'

export interface CliChatOptions {
  /** 覆盖模型（不填用 CLI 自身默认） */
  model?: string
  /** 添加 Agent 时解析到的路径（展示用；执行时失效会重新解析） */
  exePath?: string
  /** 工作目录：CLI 进程 cwd，文件读写/命令执行都发生在此目录内 */
  workDir?: string
  /** 单次调用超时（毫秒）：超时 kill 进程并 emit error，已产出内容保留；不填默认 10 分钟 */
  timeoutMs?: number
  /** 思考强度（仅对官方支持的 CLI 生效：codex=reasoning effort，claude=MAX_THINKING_TOKENS） */
  thinkingLevel?: ThinkingLevel
}

/** Windows 命令行长度硬上限（UTF-16 code units）附近的安全值 */
const MAX_PROMPT_CHARS = 28000

/** Claude Code 思考预算（MAX_THINKING_TOKENS，官方文档档位） */
const THINKING_BUDGET: Record<string, number> = { low: 4000, medium: 16000, high: 31999 }

/** 各 CLI 是否官方支持思考强度（UI"支持才显示"的依据） */
export function cliSupportsThinking(name: CliName): boolean {
  return name === 'codex' || name === 'claude'
}

/** 一个可启动目标：真正的可执行文件 + 固定前置参数 + 需要的环境变量 */
export interface CliTarget {
  /** 真正被 spawn 的可执行文件（.exe） */
  exe: string
  /** 固定前置参数（如 node 跑 .mjs、Electron 跑 cli.js） */
  prefixArgs: string[]
  /** 追加环境变量（在父进程环境之上叠加） */
  env?: Record<string, string>
  /** 展示/持久化用的路径（用户可辨认的入口文件） */
  label: string
}

interface CliSpec {
  name: CliName
  display: string
  /** 解析启动目标；hint 为上次保存的路径，命中则优先使用。返回 null 表示未安装 */
  resolveTarget(hint?: string): Promise<CliTarget | null>
  /** 本地连接测试参数（不联网、无副作用） */
  testArgs(): string[]
  /** 构造一次对话的完整参数 */
  buildArgs(prompt: string, system: string | undefined, opts: CliChatOptions): string[]
  /** stdout 形态：ndjson = 逐行 JSON 事件；text = 纯文本整段输出 */
  format: 'ndjson' | 'text'
  /**
   * 行解析器工厂（每次会话创建一个实例，内部可维护跨行状态，如 tool_use → tool_result 配对）。
   * format === 'ndjson' 时必需。cwd 为本次 spawn 的工作目录，用于把 CLI 报出的相对路径
   * 还原成绝对路径（产物登记 artifacts 必须是可打开的真实路径）。
   */
  makeParser?(cwd: string): (obj: Record<string, unknown>, emit: (e: Omit<ChatChunkEvent, 'reqId'>) => void) => void
  /** 进程正常退出即视为完成 */
  doneOnExit: boolean
  /** 思考强度的环境变量映射（可选；codex 用 -c 参数在 buildArgs 内处理，不需要此字段） */
  thinkingEnv?: (level: ThinkingLevel | undefined) => Record<string, string>
}

// ---------------------------------------------------------------- 工具事件（执行卡片透传）

/** 工具调用参数摘要（截断防膨胀；与 openai 适配层展示口径一致） */
function summarizeArgs(input: unknown): Record<string, string> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      out[k] = s.length > 200 ? s.slice(0, 200) + '…' : s
    }
    return out
  }
  return { input: String(input ?? '').slice(0, 200) }
}

/** 工具结果内容（字符串 或 [{type:'text',text}] 数组）→ 纯文本 */
function toolResultToText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : ''))
      .join('')
  }
  if (c === undefined || c === null) return ''
  try { return JSON.stringify(c).slice(0, 500) } catch { return String(c).slice(0, 500) }
}

/**
 * 把 CLI 报出的文件路径还原为可打开的绝对路径：相对路径按本次 spawn 的 cwd 解析，
 * 并且只在文件真实存在时才返回（CLI 自称写了但没落盘的情况不能登记为产物）。
 */
function realOutPath(cwd: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const p = resolvePath(cwd, raw)
  try {
    return existsSync(p) ? p : undefined
  } catch {
    return undefined
  }
}

/** 会产出/修改文件的工具名（Claude Code 与 CodeBuddy 同构），其参数中的路径字段 */
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}

/**
 * Claude Code / CodeBuddy 同构的 stream-json 解析器（带会话级状态）：
 * - assistant.content[].text → 正文增量
 * - assistant.content[].thinking → 思考过程增量（默认只在 UI 折叠展示，不计入正文）
 * - assistant.content[].tool_use → 工具调用开始（running）
 * - user.content[].tool_result → 工具调用结束（done/error + 结果摘要；写文件成功时带产物绝对路径）
 * - result → 用量 + done/error
 */
function makeStreamJsonParser(cwd: string): (obj: Record<string, unknown>, emit: (e: Omit<ChatChunkEvent, 'reqId'>) => void) => void {
  const toolUses = new Map<string, { tool: string; args: unknown }>()
  // 已上报过的思考块：stream-json 会在每个 assistant 快照里重复带完整 content，需去重避免刷屏
  const seenThinking = new Set<string>()
  // 思考块整块上报：多块之间补空行，否则在界面里黏成一段、"只显重点"的分段筛选失效
  let sawThinking = false
  return (obj, emit) => {
    const type = obj.type as string
    if (type === 'assistant') {
      const msg = obj.message as { content?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[] } | undefined
      for (const block of msg?.content ?? []) {
        if (block?.type === 'text' && block.text) emit({ type: 'delta', text: block.text })
        if (block?.type === 'thinking' && block.thinking) {
          if (!seenThinking.has(block.thinking)) {
            seenThinking.add(block.thinking)
            emit({ type: 'reasoning', text: (sawThinking ? '\n\n' : '') + block.thinking })
            sawThinking = true
          }
        }
        if (block?.type === 'tool_use' && block.id) {
          const tool = block.name ?? 'unknown'
          toolUses.set(block.id, { tool, args: block.input })
          emit({
            type: 'tool',
            toolCall: { id: block.id, tool, args: summarizeArgs(block.input), status: 'running', ts: Date.now() }
          })
        }
      }
    } else if (type === 'user') {
      // stream-json 中工具结果以 user 事件的 content 数组回传
      const msg = obj.message as { content?: unknown } | undefined
      const blocks = Array.isArray(msg?.content) ? (msg!.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) : []
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue
        const use = toolUses.get(block.tool_use_id)
        const resultText = toolResultToText(block.content)
        const ok = !block.is_error
        // 写文件成功 → 登记真实产物路径（供工作流交付卡片展示与打开）
        const pathField = use ? WRITE_TOOLS[use.tool] : undefined
        const writtenPath = ok && pathField
          ? realOutPath(cwd, (use!.args as Record<string, unknown> | undefined)?.[pathField])
          : undefined
        emit({
          type: 'tool',
          toolCall: {
            id: block.tool_use_id,
            tool: use?.tool ?? 'unknown',
            args: use ? summarizeArgs(use.args) : {},
            status: ok ? 'done' : 'error',
            result: resultText.length > 5000 ? resultText.slice(0, 5000) + '…（已截断）' : resultText,
            ts: Date.now()
          },
          ...(writtenPath ? { writtenPath } : {})
        })
        toolUses.delete(block.tool_use_id)
      }
    } else if (type === 'result') {
      const usage = obj.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined
      const tokens = usage?.total_tokens ?? (usage?.input_tokens != null && usage?.output_tokens != null ? usage.input_tokens + usage.output_tokens : undefined)
      if (tokens) emit({ type: 'usage', usage: { tokens, prompt: usage?.input_tokens, completion: usage?.output_tokens } })
      if (obj.is_error === true) {
        const errs = Array.isArray(obj.errors) ? obj.errors.map(String) : []
        emit({ type: 'error', message: (errs[0] ?? String(obj.result ?? 'CLI 返回错误')).slice(0, 300) })
      } else {
        emit({ type: 'done' })
      }
    }
  }
}

// ---------------------------------------------------------------- 基础探测

function runWhere(name: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      const proc = spawn('where.exe', [name], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      proc.stdout?.on('data', (d) => (out += d.toString()))
      proc.on('error', () => resolvePromise(null))
      proc.on('close', (code) => resolvePromise(code === 0 ? out.split('\r\n')[0].trim() || null : null))
      setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        resolvePromise(null)
      }, 4000)
    } catch {
      resolvePromise(null)
    }
  })
}

/** npm 全局包内原生二进制的常见位置（npm shim 是 .cmd，无法安全 spawn） */
function npmGlobalPackageBin(pkgDir: string, exe: string): string | null {
  const base = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', pkgDir, 'bin')
  const p = join(base, exe)
  return existsSync(p) ? p : null
}

/** 在 dir 的各子目录里找名为 fileName 的文件（按最近修改排序，命中即返回）——异步，避免阻塞主进程 */
async function findInSubdirs(dir: string, fileName: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const subdirs = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const p = join(dir, e.name)
          let mtime = 0
          try { mtime = (await fsp.stat(p)).mtimeMs } catch { /* noop */ }
          return { p, mtime }
        })
    )
    subdirs.sort((a, b) => b.mtime - a.mtime)
    for (const s of subdirs) {
      const candidate = join(s.p, fileName)
      try { if (await fsp.stat(candidate).then(() => true, () => false)) return candidate } catch { /* noop */ }
    }
    return null
  } catch {
    return null
  }
}

/** 固定盘符列表（A..Z 中真实存在的根目录），用于浅扫描非 PATH 安装 */
async function fixedDriveRoots(): Promise<string[]> {
  const roots: string[] = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      if (await fsp.stat(root).then(() => true, () => false)) roots.push(root)
    } catch { /* noop */ }
  }
  return roots
}

/** 在若干固定盘符的浅层目录里找一个相对路径（depth 限 2）——全异步，不阻塞主进程事件循环 */
async function scanDrives(relCandidates: string[], extraRoots: string[]): Promise<string | null> {
  const exists = (p: string) => fsp.stat(p).then(() => true, () => false)
  const roots = [...extraRoots, ...(await fixedDriveRoots())]
  for (const root of roots) {
    for (const rel of relCandidates) {
      if (await exists(join(root, rel))) return join(root, rel)
    }
    // 盘符根下的一级目录（如 D:\workbuddy、D:\dsh-zhuomian）
    let names: string[] = []
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true })
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 400)
    } catch { continue }
    for (const sub of names) {
      for (const rel of relCandidates) {
        const p = join(root, sub, rel)
        if (await exists(p)) return p
      }
    }
  }
  return null
}

/** 找一个可用 node：优先系统 node，回退到 Electron 自身的 node 模式 */
async function resolveNode(): Promise<{ exe: string; env?: Record<string, string> } | null> {
  const found = await runWhere('node')
  if (found && found.toLowerCase().endsWith('.exe')) return { exe: found }
  if (found) {
    const derived = join(dirname(found), 'node.exe')
    if (existsSync(derived)) return { exe: derived }
  }
  // 回退：Electron 以 node 模式运行脚本（AgentHub 自身就是 Electron）
  if (process.versions.electron) return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  return null
}

// ---------------------------------------------------------------- 各 CLI 规格

const SPECS: Record<CliName, CliSpec> = {
  // 实测：Responses API NDJSON 事件流（--include-events --stream）
  arkcli: {
    name: 'arkcli',
    display: 'arkcli（火山方舟）',
    async resolveTarget(hint) {
      if (hint && hint.toLowerCase().endsWith('.exe') && existsSync(hint)) {
        return { exe: hint, prefixArgs: [], label: hint }
      }
      // 1) npm 全局包内原生 exe（.cmd shim 无法无 shell 安全执行）
      const p = npmGlobalPackageBin('@volcengine/ark-cli', 'arkcli-windows-amd64.exe')
      if (p) return { exe: p, prefixArgs: [], label: p }
      // 2) where 直接命中 .exe（非 npm 安装形态）
      const found = await runWhere('arkcli')
      if (found && found.toLowerCase().endsWith('.exe')) return { exe: found, prefixArgs: [], label: found }
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      const args = ['+chat', prompt.slice(0, MAX_PROMPT_CHARS), '--stream', '--include-events']
      if (system) args.push('--instructions', system)
      if (opts.model) args.push('--model', opts.model)
      return args
    },
    format: 'ndjson',
    makeParser() {
      return (obj, emit) => {
        const type = obj.type as string
        if (type === 'response_output_text_delta' && typeof obj.delta === 'string' && obj.delta) {
          emit({ type: 'delta', text: obj.delta })
        } else if (type === 'response_reasoning_summary_text_delta' && typeof obj.delta === 'string' && obj.delta) {
          // 思考摘要增量：只进思考区，不计入正文
          emit({ type: 'reasoning', text: obj.delta })
        } else if (type === 'response_completed') {
          const usage = (obj.response as { usage?: { total_tokens?: number } })?.usage
          if (usage?.total_tokens) emit({ type: 'usage', usage: { tokens: usage.total_tokens } })
          emit({ type: 'done' })
        }
        // 失败路径由退出码 + stderr 处理（incomplete 等退出码非 0）
      }
    },
    doneOnExit: true
  },

  // 未实测（本机未安装）：按 Claude Code CLI 官方非交互模式规范实现
  claude: {
    name: 'claude',
    display: 'Claude Code CLI',
    async resolveTarget(hint) {
      if (hint && hint.toLowerCase().endsWith('.exe') && existsSync(hint)) return { exe: hint, prefixArgs: [], label: hint }
      const found = await runWhere('claude')
      if (found && found.toLowerCase().endsWith('.exe')) return { exe: found, prefixArgs: [], label: found }
      const local = join(homedir(), 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe')
      if (existsSync(local)) return { exe: local, prefixArgs: [], label: local }
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      const args = ['-p', prompt.slice(0, MAX_PROMPT_CHARS), '--output-format', 'stream-json']
      if (system) args.push('--system-prompt', system)
      if (opts.model) args.push('--model', opts.model)
      return args
    },
    format: 'ndjson',
    makeParser: makeStreamJsonParser,
    doneOnExit: false, // 以 result 事件为准；无 result 的正常退出也兜底 done
    /** 思考强度：Claude Code 官方用 MAX_THINKING_TOKENS 环境变量控制思考预算 */
    thinkingEnv: (level) => (level && level !== 'off' ? { MAX_THINKING_TOKENS: String(THINKING_BUDGET[level] ?? 0) } : {} as Record<string, string>)
  },

  // 实测：codex exec --json JSONL（thread.started / item.completed / turn.completed / turn.failed）
  codex: {
    name: 'codex',
    display: 'Codex CLI',
    async resolveTarget(hint) {
      if (hint && hint.toLowerCase().endsWith('.exe') && existsSync(hint)) return { exe: hint, prefixArgs: [], label: hint }
      const found = await runWhere('codex')
      if (found && found.toLowerCase().endsWith('.exe')) return { exe: found, prefixArgs: [], label: found }
      // 官方应用安装形态：%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
      const codexBin = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
      const hashed = await findInSubdirs(codexBin, 'codex.exe')
      if (hashed) return { exe: hashed, prefixArgs: [], label: hashed }
      // cargo / npm 安装形态
      const cargo = join(homedir(), '.cargo', 'bin', 'codex.exe')
      if (existsSync(cargo)) return { exe: cargo, prefixArgs: [], label: cargo }
      const npmPkg = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.exe')
      if (existsSync(npmPkg)) return { exe: npmPkg, prefixArgs: [], label: npmPkg }
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      // system 无独立 flag：以指令前缀并入 prompt
      const full = system ? `【系统指令】${system}\n\n【任务】${prompt}` : prompt
      const args = ['exec', '--json', '--skip-git-repo-check', full.slice(0, MAX_PROMPT_CHARS)]
      if (opts.model) args.push('-m', opts.model)
      // 思考强度：codex 官方用 model_reasoning_effort 配置项（-c 覆盖）
      if (opts.thinkingLevel && opts.thinkingLevel !== 'off') {
        args.push('-c', `model_reasoning_effort=${opts.thinkingLevel}`)
      }
      return args
    },
    format: 'ndjson',
    makeParser(cwd) {
      // codex 的 item.completed 在完成时才发（无 running 态），计数器生成稳定卡片 id
      let n = 0
      const seenReasoning = new Set<string>()
      let sawReasoning = false
      return (obj, emit) => {
        const type = obj.type as string
        if (type === 'item.completed') {
          const item = obj.item as { type?: string; text?: string; message?: string; command?: string; exit_code?: number; output?: string; change_type?: string; path?: string; summary?: unknown } | undefined
          if (item?.type === 'agent_message' && item.text) emit({ type: 'delta', text: item.text })
          if (item?.type === 'reasoning') {
            // 思考过程：summary 数组（新版）或 text 字段（旧版），逐条去重后进入思考区，不计入正文
            const parts: string[] = []
            if (Array.isArray(item.summary)) {
              for (const s of item.summary) {
                const t = typeof s === 'string' ? s : String((s as { text?: unknown } | null)?.text ?? '')
                if (t.trim()) parts.push(t.trim())
              }
            }
            if (item.text?.trim()) parts.push(item.text.trim())
            for (const p of parts) {
              if (seenReasoning.has(p)) continue
              seenReasoning.add(p)
              // 整块上报的思考之间补空行（同 stream-json 解析器），保证界面能按段筛选重点
              emit({ type: 'reasoning', text: (sawReasoning ? '\n\n' : '') + p })
              sawReasoning = true
            }
          }
          if (item?.type === 'command_execution') {
            // 工具事件透传：命令执行（完成态，含退出码与输出）
            const out = item.output ?? ''
            emit({
              type: 'tool',
              toolCall: {
                id: `codex-cmd-${++n}`,
                tool: 'run_command',
                args: { command: item.command ?? '' },
                status: item.exit_code === 0 ? 'done' : 'error',
                result: out.length > 5000 ? out.slice(0, 5000) + '…（已截断）' : out,
                ts: Date.now()
              }
            })
          }
          if (item?.type === 'file_change') {
            // 工具事件透传：文件变更；创建/修改且文件确实落盘时登记为真实产物（相对路径按 cwd 还原）
            const written = item.change_type === 'delete' ? undefined : realOutPath(cwd, item.path)
            emit({
              type: 'tool',
              toolCall: {
                id: `codex-file-${++n}`,
                tool: 'file_change',
                args: { type: item.change_type ?? '', path: item.path ?? '' },
                status: 'done',
                ts: Date.now()
              },
              ...(written ? { writtenPath: written } : {})
            })
          }
          // item.type === 'error' 多为配置告警（如未知配置项），不打断主流程
        } else if (type === 'turn.completed') {
          const usage = obj.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined
          const tokens = usage?.total_tokens ?? (usage?.input_tokens != null && usage?.output_tokens != null ? usage.input_tokens + usage.output_tokens : undefined)
          if (tokens) emit({ type: 'usage', usage: { tokens, prompt: usage?.input_tokens, completion: usage?.output_tokens } })
          emit({ type: 'done' })
        } else if (type === 'error') {
          // 顶层错误（如 429）：直接作为错误事件，避免只看到"退出码 1"
          emit({ type: 'error', message: String(obj.message ?? 'Codex 返回错误').slice(0, 300) })
        } else if (type === 'turn.failed') {
          const err = obj.error as { message?: string } | undefined
          if (err?.message) emit({ type: 'error', message: err.message.slice(0, 300) })
        }
      }
    },
    doneOnExit: false
  },

  // 实测：CodeBuddy Code CLI（官方 npm 包优先，WorkBuddy 内置版兜底）
  codebuddy: {
    name: 'codebuddy',
    display: 'CodeBuddy Code',
    async resolveTarget(hint) {
      const node = await resolveNode()
      if (!node) return null
      // 0) 显式覆盖（排在最前，保证环境变量真的能覆盖默认探测结果）
      const override = process.env.AGENTHUB_CODEBUDDY_CLI
      if (override && existsSync(override)) return { exe: node.exe, prefixArgs: [override], env: node.env, label: override }
      // 1) 已保存的路径（hint）：添加 Agent 时确认可用的入口，优先于自动发现——
      //    避免后来新装官方版后已保存的 Agent 被静默切换
      if (hint && (hint.toLowerCase().endsWith('.mjs') || hint.toLowerCase() === 'codebuddy') && existsSync(hint)) {
        return { exe: node.exe, prefixArgs: [hint], env: node.env, label: hint }
      }
      // 2) 官方 npm 全局安装（独立 CLI，带完整交互模式，凭据落在 ~/.codebuddy）
      //    bin/codebuddy 是无扩展名的 node 启动器，必须用 node 执行（.cmd shim 无法安全 spawn）
      const npmBin = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')
      if (existsSync(npmBin)) return { exe: node.exe, prefixArgs: [npmBin], env: node.env, label: npmBin }
      const candidates = [
        join(homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs'),
        join('C:\\Program Files', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs')
      ].filter((x): x is string => !!x)
      for (const c of candidates) {
        if (existsSync(c)) return { exe: node.exe, prefixArgs: [c], env: node.env, label: c }
      }
      // 非默认安装位置：浅扫描各盘符下的 WorkBuddy 目录
      const found = await scanDrives(
        [join('WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs'),
          join('resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs')],
        []
      )
      if (found) return { exe: node.exe, prefixArgs: [found], env: node.env, label: found }
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      // 非交互（-p）模式下没有审批界面：不显式授权时 Write/Edit/命令会被一律拒绝。
      // 默认 acceptEdits（文件编辑自动放行、命令仍需审批），需要连命令一起放行时用
      // AGENTHUB_CODEBUDDY_PERMISSION=bypassPermissions 显式提升（等价于 -y，风险自负）。
      const perm = process.env.AGENTHUB_CODEBUDDY_PERMISSION ?? 'acceptEdits'
      const args = ['-p', '--output-format', 'stream-json', '--permission-mode', perm]
      if (opts.model) args.push('--model', opts.model)
      // system 无独立 flag：以指令前缀并入 prompt
      args.push((system ? `【系统指令】${system}\n\n【任务】${prompt}` : prompt).slice(0, MAX_PROMPT_CHARS))
      return args
    },
    format: 'ndjson',
    makeParser: makeStreamJsonParser,
    doneOnExit: false
  },

  // 实测：DeepSeek Harness 的 headless 模式（纯文本输出，非流式）
  dsh: {
    name: 'dsh',
    display: 'DeepSeek Harness（headless）',
    async resolveTarget(hint) {
      const candidates = [
        process.env.AGENTHUB_DSH_CLI,
        join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      ].filter((x): x is string => !!x)
      for (const c of candidates) {
        if (existsSync(c)) {
          const t = parseDshCmd(c)
          if (t) return t
        }
      }
      if (hint && hint.toLowerCase().endsWith('.cmd') && existsSync(hint)) {
        const t = parseDshCmd(hint)
        if (t) return t
      }
      const found = await scanDrives([
        join('DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        // 安装目录名可能与产品名不同（如 D:\dsh-zhuomian），因此同时尝试"相对安装根"的路径
        // （不再扫描无 resources 前缀的 runtime\cli\bin——过宽，可能误中无关安装）
        join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      ], [])
      return found ? parseDshCmd(found) : null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, _system, opts) {
      // headless 一次性任务：system 以指令前缀并入 prompt
      const full = _system ? `【系统指令】${_system}\n\n【任务】${prompt}` : prompt
      const args = ['headless', full.slice(0, MAX_PROMPT_CHARS)]
      if (opts.model) args.push('--model', opts.model)
      return args
    },
    format: 'text',
    doneOnExit: true
  }
}

/**
 * 解析 dsh.cmd：它只是一个 Electron-as-node 启动器，没有它的内容就无法无 shell 启动。
 * 形如：set ELECTRON_RUN_AS_NODE=1
 *       "…\DeepSeek Harness.exe" --expose-internals "…\app.asar\dsh\node_modules\…\cli.js" %*
 */
function parseDshCmd(cmdPath: string): CliTarget | null {
  try {
    const text = readFileSync(cmdPath, 'utf-8')
    const exeMatch = text.match(/"([^"]+?\.exe)"/i)
    const cliMatch = text.match(/"([^"]+?cli\.js)"/i)
    if (!exeMatch || !cliMatch) return null
    const dir = dirname(cmdPath)
    const fix = (p: string) => resolvePath(dir, p.replace(/%~dp0/gi, dir + '\\'))
    const exe = fix(exeMatch[1])
    const cli = fix(cliMatch[1])
    // 注意：cli.js 位于 app.asar 归档内，普通 fs 无法 stat（Electron 才能读），因此只校验 exe
    if (!existsSync(exe)) return null
    return { exe, prefixArgs: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' }, label: cmdPath }
  } catch {
    return null
  }
}

/** 某个 CLI 可枚举的模型清单（不可枚举时 ok=false，界面回退到手填） */
export interface CliModelList {
  ok: boolean
  models?: string[]
  message?: string
  /** 清单来源，用于界面标注（help / catalog / config） */
  source?: string
}

/** 模型清单缓存（带 TTL：中途改 CLI 配置/换 provider 后最多 5 分钟自动刷新，无需重启应用） */
const MODEL_CACHE = new Map<CliName, { at: number; list: CliModelList }>()
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000

/** 运行一次命令并收集 stdout+stderr（带超时；用于读取 --help 这类元信息） */
function runCapture(exe: string, args: string[], env: Record<string, string> | undefined, timeoutMs = 15000): Promise<string> {
  return new Promise((resolvePromise) => {
    let out = ''
    let done = false
    const finish = (text: string) => {
      if (done) return
      done = true
      resolvePromise(text)
    }
    try {
      const proc = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env: { ...process.env, ...env } } : {})
      })
      proc.stdout?.on('data', (d) => (out += d.toString()))
      proc.stderr?.on('data', (d) => (out += d.toString()))
      proc.on('error', () => finish(out))
      proc.on('close', () => finish(out))
      setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        finish(out)
      }, timeoutMs)
    } catch {
      finish(out)
    }
  })
}

/** 读取 codex 当前配置（base_url / token / model / catalog 文件名） */
function readCodexConfig(): { baseUrl?: string; token?: string; model?: string; catalogName: string } {
  const cfgPath = join(homedir(), '.codex', 'config.toml')
  const out: { baseUrl?: string; token?: string; model?: string; catalogName: string } = {
    catalogName: 'cc-switch-model-catalog.json'
  }
  try {
    if (!existsSync(cfgPath)) return out
    const toml = readFileSync(cfgPath, 'utf-8')
    out.model = toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
    out.baseUrl = toml.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1]
    out.token = toml.match(/^\s*experimental_bearer_token\s*=\s*"([^"]+)"/m)?.[1]
    const c = toml.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m)
    if (c) out.catalogName = c[1]
  } catch { /* 读不到就用默认值 */ }
  return out
}

/**
 * Codex 的模型清单：**优先问 codex 实际连接的那个端点**（兼容 OpenAI 的 /models），
 * 因为中转站/代理的可用模型会变，本地 catalog 文件可能是旧的；问不到再退回 catalog 文件。
 */
async function codexModelsFromEndpoint(): Promise<{ models: string[]; source: string } | null> {
  const cfg = readCodexConfig()
  if (!cfg.baseUrl) return null
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/models'
  try {
    const res = await fetch(url, {
      headers: {
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        'User-Agent': 'AgentHub-ModelList'
      },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: unknown[]; models?: unknown[] }
    const arr = (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []) as Record<string, unknown>[]
    const models: string[] = []
    for (const item of arr) {
      const id = (typeof item.id === 'string' && item.id) || (typeof item.slug === 'string' && item.slug) || (typeof item.model === 'string' && item.model) || null
      if (id) models.push(id)
    }
    return models.length ? { models, source: 'endpoint' } : null
  } catch {
    return null
  }
}

/** Codex 的模型清单兜底：本地 catalog 文件的 slug + config.toml 里当前生效的 model */
function codexModelsFromCatalog(): { models: string[]; source: string } | null {
  const home = join(homedir(), '.codex')
  const cfg = readCodexConfig()
  const catalogPath = join(home, cfg.catalogName)
  const models: string[] = []
  try {
    if (existsSync(catalogPath)) {
      const raw = JSON.parse(readFileSync(catalogPath, 'utf-8')) as { models?: Record<string, unknown>[] }
      for (const item of raw.models ?? []) {
        const slug = typeof item.slug === 'string' ? item.slug : typeof item.id === 'string' ? item.id : null
        if (slug) models.push(slug)
      }
    }
  } catch { /* 解析失败忽略 */ }
  // 当前生效的模型排在最前（可能不在 catalog 里，如换过 provider）
  if (cfg.model && !models.includes(cfg.model)) models.unshift(cfg.model)
  if (models.length === 0 && cfg.model) return { models: [cfg.model], source: 'config' }
  return models.length ? { models, source: 'catalog' } : null
}

/** 读取某个 CLI 可枚举的模型清单（结果按进程缓存） */
export async function listModels(name: CliName): Promise<CliModelList> {
  const cached = MODEL_CACHE.get(name)
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.list
  let result: CliModelList = { ok: false, message: '该 CLI 不提供可枚举的模型清单，请手动填写模型 ID' }
  try {
    if (name === 'codex') {
      // 先问端点（中转站/代理的真实清单），问不到再退回本地 catalog
      const fromEndpoint = await codexModelsFromEndpoint()
      const r = fromEndpoint ?? codexModelsFromCatalog()
      if (r) result = { ok: true, models: r.models, source: r.source }
      else result = { ok: false, message: '未找到 ~/.codex 的模型信息，请手动填写模型 ID' }
    } else if (name === 'codebuddy') {
      const target = await SPECS.codebuddy.resolveTarget()
      if (target) {
        // CodeBuddy 把支持列表印在 --help 的 --model 说明里：Currently supported: (a, b, c)
        const help = await runCapture(target.exe, [...target.prefixArgs, '--help'], target.env)
        const m = help.match(/Currently supported:\s*\(([^)]+)\)/i)
        if (m) {
          const models = m[1].split(',').map((s) => s.trim()).filter(Boolean)
          if (models.length) result = { ok: true, models, source: 'help' }
        } else {
          result = { ok: false, message: '未能从 codebuddy --help 解析出模型清单，请手动填写' }
        }
      }
    } else if (name === 'dsh') {
      // DSH 的模型由 profile 配置决定，不提供枚举接口
      result = { ok: false, message: 'DSH 的模型由它的 profile 配置决定，请在 profile 里切换' }
    }
  } catch {
    result = { ok: false, message: '读取模型清单失败，请手动填写模型 ID' }
  }
  MODEL_CACHE.set(name, { at: Date.now(), list: result })
  return result
}

export function isKnownCli(name: string): name is CliName {
  return name === 'arkcli' || name === 'claude' || name === 'codex' || name === 'codebuddy' || name === 'dsh'
}

export interface CliTestResult {
  ok: boolean
  message: string
  version?: string
  exePath?: string
}

/** 解析某个 CLI 的启动目标（供扫描与诊断复用） */
export async function resolveCliTarget(name: CliName, hint?: string): Promise<CliTarget | null> {
  return SPECS[name].resolveTarget(hint)
}

/** 本地连接测试：解析可执行文件 + 版本命令（不发起网络请求） */
export async function testConnection(name: CliName): Promise<CliTestResult> {
  const spec = SPECS[name]
  const target = await spec.resolveTarget()
  if (!target) {
    return { ok: false, message: '未找到可执行文件（已检查 PATH、已知安装位置与各盘符浅层目录）' }
  }
  return new Promise((resolvePromise) => {
    try {
      const proc = spawn(target.exe, [...target.prefixArgs, ...spec.testArgs()], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(target.env ? { env: { ...process.env, ...target.env } } : {})
      })
      let out = ''
      let err = ''
      proc.stdout?.on('data', (d) => (out += d.toString()))
      proc.stderr?.on('data', (d) => (err += d.toString()))
      proc.on('error', (e) => resolvePromise({ ok: false, message: `执行失败：${e.message}` }))
      proc.on('close', (code) => {
        if (code === 0) {
          resolvePromise({ ok: true, message: '可用', version: (out || err).trim().split('\n')[0].slice(0, 80), exePath: target.label })
        } else {
          resolvePromise({ ok: false, message: `版本命令退出码 ${code}：${(err || out).trim().slice(0, 200)}`, exePath: target.label })
        }
      })
      setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        resolvePromise({ ok: false, message: '版本命令超时（10 秒）' })
      }, 10000)
    } catch (e) {
      resolvePromise({ ok: false, message: `启动失败：${(e as Error).message}` })
    }
  })
}

/** 把消息列表合并为 CLI 单提示词：单轮 user 直出；多轮转写为对话记录 */
function mergeMessages(messages: { role: string; content: string }[]): {
  system: string | undefined
  prompt: string
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n') || undefined
  const rest = messages.filter((m) => m.role !== 'system')
  if (rest.length === 1 && rest[0].role === 'user') {
    return { system, prompt: rest[0].content }
  }
  const prompt = rest
    .map((m) => (m.role === 'user' ? `【用户】\n${m.content}` : `【助手】\n${m.content}`))
    .join('\n\n')
  return { system, prompt }
}

const activeChats = new Map<string, ChildProcess>()
/** 用户主动取消的 reqId：close 时据此走"已取消"而非"错误"分支 */
const pendingCancels = new Set<string>()

/**
 * 发起一次 CLI 流式对话。事件经 onEvent 回调（reqId 路由），与 openai 适配器同构。
 * 返回 { ok: false } 表示未能启动（exe 缺失等），运行期错误走 error 事件。
 */
export async function cliChatStream(
  name: CliName,
  opts: CliChatOptions,
  reqId: string,
  messages: { role: string; content: string }[],
  onEvent: (e: ChatChunkEvent) => void
): Promise<{ ok: boolean; message?: string }> {
  const spec = SPECS[name]
  const target = await spec.resolveTarget(opts.exePath)
  if (!target) {
    return { ok: false, message: '可执行文件不存在（可能已卸载或移动）' }
  }
  const { system, prompt } = mergeMessages(messages)
  if (!prompt.trim()) {
    return { ok: false, message: '提示词为空' }
  }
  const args = [...target.prefixArgs, ...spec.buildArgs(prompt, system, opts)]
  try {
    // workDir（方案1 边界）：CLI 进程的 cwd；目录不存在时 spawn 报错如实上抛（不悄悄创建）。
    // 未显式设置时的最后防线：默认文档工作区（绝不以应用安装目录为 cwd——CLI 写文件会污染程序文件）
    let cwdDir = opts.workDir?.trim() || ''
    if (!cwdDir) {
      const { app } = require('electron') as typeof import('electron')
      const { mkdirSync } = require('node:fs') as typeof import('node:fs')
      cwdDir = join(app.getPath('documents'), 'AgentHub-workspaces', name)
      try { mkdirSync(cwdDir, { recursive: true }) } catch { /* 创建失败时 spawn 会如实报错 */ }
    }
    const proc = spawn(target.exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 思考强度环境变量（claude 的 MAX_THINKING_TOKENS 等）叠加在目标 env 之上
      ...(spec.thinkingEnv ? { env: { ...process.env, ...(target.env ?? {}), ...spec.thinkingEnv(opts.thinkingLevel) } } : (target.env ? { env: { ...process.env, ...target.env } } : {})),
      ...(cwdDir ? { cwd: cwdDir } : {})
    })
    activeChats.set(reqId, proc)
    let stdoutBuf = ''
    let stderrTail = ''
    let doneEmitted = false
    let errored = false
    // 行解析器：每次会话一个实例（内部维护 tool_use → tool_result 的跨行配对状态）
    const parser = spec.format === 'ndjson' ? spec.makeParser?.(cwdDir) : undefined
    const emit = (e: Omit<ChatChunkEvent, 'reqId'>) => {
      if (e.type === 'done') doneEmitted = true
      // 错误信息中文化（人话 + 原文折叠）：统一在出口处包装，覆盖所有来源
      if (e.type === 'error') {
        errored = true
        if (e.message) e = { ...e, message: humanizeError(e.message) }
      }
      onEvent({ ...e, reqId })
    }
    // 超时（把"无限挂起"变"有界失败"）：kill 进程树并 emit error，已产出内容保留在消息里
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 10 * 60 * 1000
    const killTimer = setTimeout(() => {
      killTree(proc)
      if (!doneEmitted && !errored) {
        emit({ type: 'error', message: `CLI 超时被终止（${Math.round(timeoutMs / 60000)} 分钟，可按需放宽）。超时前已产出的内容已保留。` })
      }
    }, timeoutMs)
    // 心跳：超过 90 秒没有任何 stdout 就提示一次（常见原因：CLI 卡在权限审批或等待输入）
    let lastDataAt = Date.now()
    let noticed = false
    const beatTimer = setInterval(() => {
      if (doneEmitted || errored || noticed) return
      if (Date.now() - lastDataAt > 90_000) {
        noticed = true
        emit({ type: 'notice', text: '该 CLI 已超过 90 秒没有输出——可能卡在权限审批或等待输入，请留意是否需要手动处理' })
      }
    }, 10_000)
    const touch = () => { lastDataAt = Date.now() }
    proc.once('close', () => {
      clearTimeout(killTimer)
      clearInterval(beatTimer)
    })
    proc.stdout?.on('data', touch)
    proc.stderr?.on('data', touch)
    if (spec.format === 'text') {
      // 纯文本 CLI：直接作为增量透出（如 dsh headless 的最终答案）
      proc.stdout?.on('data', (d) => {
        const text = d.toString()
        stdoutBuf += text
        if (text) emit({ type: 'delta', text })
      })
    } else {
      proc.stdout?.on('data', (d) => {
        stdoutBuf += d.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('{')) continue
          try {
            parser?.(JSON.parse(t), emit)
          } catch { /* 忽略不完整/非 JSON 行 */ }
        }
      })
    }
    proc.stderr?.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-600)
    })
    proc.on('error', (e) => {
      activeChats.delete(reqId)
      pendingCancels.delete(reqId)
      // cwd 不存在时 Node 也只报 ENOENT，和"CLI 可执行文件没了"长得一模一样——分开说
      const cwdMissing = (e as NodeJS.ErrnoException).code === 'ENOENT' && !!cwdDir && !existsSync(cwdDir)
      emit({
        type: 'error',
        message: cwdMissing
          ? `工作目录不存在，进程无法启动：${cwdDir}（请先建好该目录，或在顶栏"目录"/工作流产物目录里重新选择）`
          : `进程启动失败：${e.message}`
      })
    })
    proc.on('close', (code) => {
      // 冲刷残留缓冲（无换行结尾的最后一行）
      const t = stdoutBuf.trim()
      if (spec.format === 'ndjson' && t.startsWith('{')) {
        try {
          parser?.(JSON.parse(t), emit)
        } catch { /* 忽略 */ }
      }
      activeChats.delete(reqId)
      if (errored) return
      // 用户主动取消：优雅完成（与 openai 适配器行为一致），不再走"退出码 null"错误分支
      if (pendingCancels.has(reqId)) {
        pendingCancels.delete(reqId)
        emit({ type: 'done', message: '已取消' })
        return
      }
      if (code === 0) {
        if (!doneEmitted) emit({ type: 'done' })
      } else {
        // CLI 失败输出 JSON 错误体（如 arkcli {"ok":false,"error":{...}}），尽力提取 message
        let message = stderrTail.trim() || `进程退出码 ${code}`
        try {
          const j = JSON.parse(stderrTail.slice(stderrTail.indexOf('{')))
          if (j?.error?.message) message = String(j.error.message).slice(0, 300)
        } catch { /* 保留原始 stderr */ }
        emit({ type: 'error', message })
      }
    })
    return { ok: true }
  } catch (e) {
    activeChats.delete(reqId)
    return { ok: false, message: `启动失败：${(e as Error).message}` }
  }
}

export function cancelChat(reqId: string) {
  // 先标记：close 事件据此走"已取消"分支，避免用户看到"退出码 null"之类的错误
  pendingCancels.add(reqId)
  const proc = activeChats.get(reqId)
  if (proc) {
    killTree(proc)
    activeChats.delete(reqId)
  }
}
