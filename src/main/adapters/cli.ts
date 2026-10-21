import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ChatChunkEvent } from './openai'

/**
 * 本机 Agent CLI 执行适配层（接入"现成 Agent"而非"模型 API"，规格 §10）。
 * 由 CLI 自身完成执行与凭据管理：AgentHub 不读取其配置、不保存其密钥。
 *
 * 实现状态（如实声明）：
 *  - arkcli：本机已安装并实测（流式 NDJSON、用量、错误、取消、dry-run 全链路）
 *  - claude / codex：按官方 CLI 的非交互模式规范实现，本机未安装、未实测——
 *    界面仅在真实发现对应可执行文件时才允许添加，失败如实报错，绝不假装可用。
 *
 * 安全约定：所有参数以数组直接 spawn（不经 shell），用户输入不会被解释为命令行元字符。
 */

export type CliName = 'arkcli' | 'claude' | 'codex'

export interface CliChatOptions {
  /** 覆盖模型（不填用 CLI 自身默认，如 arkcli 当前 profile 的默认模型） */
  model?: string
  /** 添加 Agent 时解析到的可执行路径（展示用；执行时失效会重新解析） */
  exePath?: string
}

/** Windows 命令行长度硬上限（UTF-16 code units）附近的安全值 */
const MAX_PROMPT_CHARS = 28000

interface CliSpec {
  name: CliName
  /** 展示名 */
  display: string
  /** 解析可执行文件真实路径；返回 null 表示未安装 */
  resolveExe(): Promise<string | null>
  /** 本地连接测试参数（不联网、无副作用） */
  testArgs(): string[]
  /** 构造一次对话的完整参数 */
  buildArgs(prompt: string, system: string | undefined, opts: CliChatOptions): string[]
  /** 解析 stdout 的一行 JSON 事件（NDJSON），映射为适配事件 */
  parseLine(obj: Record<string, unknown>, emit: (e: Omit<ChatChunkEvent, 'reqId'>) => void): void
  /** 进程正常退出即视为完成（某些 CLI 以显式 result 事件为准，则 false） */
  doneOnExit: boolean
}

function runWhere(name: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      const proc = spawn('where.exe', [name], { windowsHide: true })
      let out = ''
      proc.stdout.on('data', (d) => (out += d.toString()))
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

const SPECS: Record<CliName, CliSpec> = {
  // 实测：Responses API NDJSON 事件流（--include-events --stream）
  arkcli: {
    name: 'arkcli',
    display: 'arkcli（火山方舟）',
    async resolveExe() {
      // 1) npm 全局包内原生 exe（.cmd shim 无法无 shell 安全执行）
      const p = npmGlobalPackageBin('@volcengine/ark-cli', 'arkcli-windows-amd64.exe')
      if (p) return p
      // 2) where 直接命中 .exe（非 npm 安装形态）
      const found = await runWhere('arkcli')
      if (found && found.toLowerCase().endsWith('.exe')) return found
      // 3) where 命中 npm .cmd shim -> 推导同包内 exe
      if (found && found.toLowerCase().endsWith('.cmd')) {
        const derived = npmGlobalPackageBin('@volcengine/ark-cli', 'arkcli-windows-amd64.exe')
        if (derived) return derived
      }
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      const args = ['+chat', prompt.slice(0, MAX_PROMPT_CHARS), '--stream', '--include-events']
      if (system) args.push('--instructions', system)
      if (opts.model) args.push('--model', opts.model)
      return args
    },
    parseLine(obj, emit) {
      const type = obj.type as string
      if (type === 'response_output_text_delta' && typeof obj.delta === 'string' && obj.delta) {
        emit({ type: 'delta', text: obj.delta })
      } else if (type === 'response_completed') {
        const usage = (obj.response as { usage?: { total_tokens?: number } })?.usage
        if (usage?.total_tokens) emit({ type: 'usage', usage: { tokens: usage.total_tokens } })
        emit({ type: 'done' })
      }
      // 思考增量（response_reasoning_summary_text_delta）不计入正文；
      // 失败路径由退出码 + stderr 处理（incomplete 等退出码非 0）
    },
    doneOnExit: true
  },

  // 未实测（本机未安装）：按 Claude Code CLI 官方非交互模式规范实现
  // claude -p <prompt> --output-format stream-json [--system-prompt <s>] [--model <m>]
  claude: {
    name: 'claude',
    display: 'Claude Code CLI',
    async resolveExe() {
      const found = await runWhere('claude')
      if (found && found.toLowerCase().endsWith('.exe')) return found
      // npm 安装形态：shim .cmd -> 包内 cli.js 由 node 执行；取 .cmd 本身不可无 shell spawn，
      // 此时探测常见原生安装位置（%LOCALAPPDATA%\Programs\claude-code\claude.exe）
      const local = join(homedir(), 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe')
      if (existsSync(local)) return local
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      const args = ['-p', prompt.slice(0, MAX_PROMPT_CHARS), '--output-format', 'stream-json']
      if (system) args.push('--system-prompt', system)
      if (opts.model) args.push('--model', opts.model)
      return args
    },
    parseLine(obj, emit) {
      const type = obj.type as string
      if (type === 'assistant') {
        const msg = obj.message as { content?: { type?: string; text?: string }[] } | undefined
        for (const block of msg?.content ?? []) {
          if (block?.type === 'text' && block.text) emit({ type: 'delta', text: block.text })
        }
      } else if (type === 'result') {
        const usage = obj.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined
        const tokens = usage?.total_tokens ?? (usage?.input_tokens != null && usage?.output_tokens != null ? usage.input_tokens + usage.output_tokens : undefined)
        if (tokens) emit({ type: 'usage', usage: { tokens } })
        if (obj.is_error === true) {
          emit({ type: 'error', message: String(obj.result ?? 'CLI 返回错误') })
        } else {
          emit({ type: 'done' })
        }
      }
    },
    doneOnExit: false // 以 result 事件为准；无 result 的正常退出也兜底 done
  },

  // 未实测（本机未安装）：按 Codex CLI 官方 exec --json JSONL 规范实现
  // codex exec <prompt> --json [-m <model>]；system 以指令前缀并入 prompt（无独立 flag）
  codex: {
    name: 'codex',
    display: 'Codex CLI',
    async resolveExe() {
      const found = await runWhere('codex')
      if (found && found.toLowerCase().endsWith('.exe')) return found
      return null
    },
    testArgs: () => ['--version'],
    buildArgs(prompt, system, opts) {
      const full = system ? `【系统指令】${system}\n\n【任务】${prompt}` : prompt
      const args = ['exec', '--json', full.slice(0, MAX_PROMPT_CHARS)]
      if (opts.model) args.push('-m', opts.model)
      return args
    },
    parseLine(obj, emit) {
      const type = obj.type as string
      if (type === 'item.completed') {
        const item = obj.item as { type?: string; text?: string } | undefined
        if (item?.type === 'agent_message' && item.text) emit({ type: 'delta', text: item.text })
      } else if (type === 'turn.completed') {
        const usage = obj.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined
        const tokens = usage?.total_tokens ?? (usage?.input_tokens != null && usage?.output_tokens != null ? usage.input_tokens + usage.output_tokens : undefined)
        if (tokens) emit({ type: 'usage', usage: { tokens } })
        emit({ type: 'done' })
      }
    },
    doneOnExit: false
  }
}

export function isKnownCli(name: string): name is CliName {
  return name === 'arkcli' || name === 'claude' || name === 'codex'
}

export interface CliTestResult {
  ok: boolean
  message: string
  version?: string
  exePath?: string
}

/** 本地连接测试：解析可执行文件 + 版本命令（不发起网络请求） */
export async function testConnection(name: CliName): Promise<CliTestResult> {
  const spec = SPECS[name]
  const exe = await spec.resolveExe()
  if (!exe) {
    return { ok: false, message: '未找到可执行文件（仅支持原生 .exe 安装形态；npm .cmd shim 无法安全执行）' }
  }
  return new Promise((resolvePromise) => {
    try {
      const proc = spawn(exe, spec.testArgs(), { windowsHide: true })
      let out = ''
      proc.stdout.on('data', (d) => (out += d.toString()))
      proc.on('error', (e) => resolvePromise({ ok: false, message: `执行失败：${e.message}` }))
      proc.on('close', (code) => {
        if (code === 0) {
          resolvePromise({ ok: true, message: '可用', version: out.trim().slice(0, 80), exePath: exe })
        } else {
          resolvePromise({ ok: false, message: `版本命令退出码 ${code}`, exePath: exe })
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
  const exe = (opts.exePath && existsSync(opts.exePath) ? opts.exePath : null) ?? (await spec.resolveExe())
  if (!exe) {
    return { ok: false, message: '可执行文件不存在（可能已卸载或移动）' }
  }
  const { system, prompt } = mergeMessages(messages)
  if (!prompt.trim()) {
    return { ok: false, message: '提示词为空' }
  }
  const args = spec.buildArgs(prompt, system, opts)
  try {
    const proc = spawn(exe, args, { windowsHide: true })
    activeChats.set(reqId, proc)
    let stdoutBuf = ''
    let stderrTail = ''
    let doneEmitted = false
    let errored = false
    const emit = (e: Omit<ChatChunkEvent, 'reqId'>) => {
      if (e.type === 'done') doneEmitted = true
      if (e.type === 'error') errored = true
      onEvent({ ...e, reqId })
    }
    proc.stdout?.on('data', (d) => {
      stdoutBuf += d.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          spec.parseLine(JSON.parse(t), emit)
        } catch { /* 忽略不完整/非 JSON 行 */ }
      }
    })
    proc.stderr?.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-600)
    })
    proc.on('error', (e) => {
      activeChats.delete(reqId)
      emit({ type: 'error', message: `进程启动失败：${e.message}` })
    })
    proc.on('close', (code) => {
      // 冲刷残留缓冲（无换行结尾的最后一行）
      const t = stdoutBuf.trim()
      if (t.startsWith('{')) {
        try {
          spec.parseLine(JSON.parse(t), emit)
        } catch { /* 忽略 */ }
      }
      activeChats.delete(reqId)
      if (errored) return
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
  const proc = activeChats.get(reqId)
  if (proc) {
    try { proc.kill() } catch { /* noop */ }
    activeChats.delete(reqId)
  }
}
