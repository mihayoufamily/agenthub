/**
 * MCP 客户端（tools-only 子集）：把外部 MCP server 的工具并进 AgentHub 现有的工具循环。
 * 只接 tools——不接 prompts/resources，也不让 server 往上下文里塞系统提示。
 *
 * 传输只做 stdio：本机拉起一条命令，按换行分隔的 JSON-RPC 通信。
 * 远程 HTTP/SSE 这一版刻意不做——它要多一套鉴权与网络风险，等 stdio 这条路走顺了再说。
 *
 * 信任模型（用户 2026-10-23 拍定）：首次连接要确认，确认后这一组工具整组放行；
 * 信任标记存在主进程 approvals.json，渲染层改不动，免得配置通道变成"自我授权"。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { McpServer, McpProbe } from '../shared/types'
import { needsComspec } from '../shared/argv'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT = 15_000
const MAX_BODY = 512 * 1024

/** 旧版单命令配置的拒收码：界面按这个码渲染，不靠文案匹配 */
export const MCP_LEGACY_CODE = 'invalid_legacy_command'

/**
 * 把配置换算成一次 spawn 的入参（纯裁决，逻辑层可直接断言）。
 * 三种结果：
 * ① 有 launch → 数组直传，shell:false；
 * ② 只有旧 command → 抛 legacy 错误码，等用户重填（不猜拆，也不删记录）；
 * ③ .cmd/.bat 家族 → 用 comspec 包一层。②是用户 2026-10-23 拍定的，③是 Windows 的现实。
 */
export function planSpawn(server: McpServer): { file: string; args: string[]; shell: boolean } {
  const bin = (server.launch?.bin ?? '').trim()
  const args = Array.isArray(server.launch?.args) ? server.launch.args.filter((a) => typeof a === 'string') : []
  if (!bin) {
    // 没 launch 只有 command：旧格式。v0.4.0 明确不作废式兼容——不自动拆分
    if ((server.command ?? '').trim()) throw new Error(`${MCP_LEGACY_CODE}：该 server 是旧版单命令配置，已停用，请在设置里重填`)
    throw new Error('MCP server 没有启动命令')
  }
  if (needsComspec(bin)) {
    // 重新拼成一条 cmd 能吃的串：路径含空格必须带引号，否则 cmd 会在空格处断开
    const quote = (s: string) => (/(^".*"$)|^\S+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`)
    const line = [bin, ...args].map(quote).join(' ')
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    return { file: comspec, args: ['/d', '/c', line], shell: true }
  }
  return { file: bin, args, shell: false }
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * 一条 stdio 连接。调用方负责 close()；每次模型请求都新建、请求结束即关，
 * 不留跨请求的活进程——挂了更好恢复，也不会出现"上一个任务的 server 还在跑"的隐形状态。
 */
export class McpClient {
  private seq = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  private proc?: ChildProcess
  private closed = false

  private constructor(readonly server: McpServer, private timeoutMs: number) {}

  static async connect(server: McpServer): Promise<{ client: McpClient; info: { title?: string; version?: string } }> {
    const c = new McpClient(server, server.timeoutMs && server.timeoutMs > 0 ? server.timeoutMs : DEFAULT_TIMEOUT)
    c.start()
    const info = await c.initialize()
    c.notify('notifications/initialized', {})
    return { client: c, info }
  }

  private start() {
    const plan = planSpawn(this.server)
    const child = spawn(plan.file, plan.args, {
      shell: plan.shell,
      windowsHide: true,
      ...(this.server.env ? { env: { ...process.env, ...this.server.env } } : {})
    })
    this.proc = child
    child.stdout?.on('data', (b: Buffer) => this.onData(b.toString('utf8')))
    child.stderr?.on('data', () => { /* server 的日志不该混进协议流 */ })
    child.once('error', (e) => this.failAll(`进程启动失败：${e.message}`))
    child.once('close', (code) => this.failAll(`server 进程已退出（退出码 ${code}）`))
  }

  private failAll(reason: string) {
    for (const [, p] of this.pending) p.reject(new Error(reason))
    this.pending.clear()
  }

  /** stdio 是换行分隔的 JSON-RPC：一次 chunk 可能带多条，也可能切断一条 */
  private onData(text: string) {
    this.buf += text
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string) {
    let msg: RpcMessage
    try {
      msg = JSON.parse(line) as RpcMessage
    } catch {
      return // 非协议行（有些 server 会往 stdout 打日志）：丢掉而不是打挂连接
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP 返回错误'))
    else p.resolve(msg.result)
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.seq++
    const payload: RpcMessage = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    const stdin = this.proc?.stdin
    if (!stdin) return Promise.reject(new Error('MCP server 未启动'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${this.timeoutMs / 1000}s）`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      stdin.write(JSON.stringify(payload) + '\n')
    })
  }

  /** 通知不等响应；写失败就算了，不该阻断已经拿到 initialize 结果的流程 */
  private notify(method: string, params?: unknown) {
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n')
    } catch { /* noop */ }
  }

  async initialize(): Promise<{ title?: string; version?: string }> {
    const r = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'AgentHub', version: '0.2' }
    })) as { serverInfo?: { title?: string; name?: string; version?: string } }
    return { title: r?.serverInfo?.title ?? r?.serverInfo?.name, ...(r?.serverInfo?.version ? { version: r.serverInfo.version } : {}) }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const r = (await this.request('tools/list')) as { tools?: McpToolInfo[] }
    return Array.isArray(r?.tools) ? r.tools : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type?: string; text?: string }[]
      isError?: boolean
    }
    const parts = (r?.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type ?? '内容'}]`)).filter(Boolean)
    const output = parts.join('\n') || '（该工具没有返回文本内容）'
    return { ok: !r?.isError, output: output.slice(0, MAX_BODY) }
  }

  /** 子进程是否还在（close 之后应当变 false：验证不泄漏后台 server 进程） */
  get running() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.failAll('连接已关闭')
    try { this.proc?.stdin?.end() } catch { /* noop */ }
    const proc = this.proc
    this.proc = undefined
    if (proc?.pid) {
      // 与 shell.ts 同一个教训：先 proc.kill() 会让 taskkill 找不到进程树，孙子进程带着管道继续活
      const fallback = () => { try { proc.kill() } catch { /* noop */ } }
      try {
        const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        tk.once('error', fallback)
        tk.once('close', (code) => { if (code !== 0) fallback() })
      } catch {
        fallback()
      }
    }
  }
}

/** 工具名进 OpenAI 函数表要符合 ^[a-zA-Z0-9_-]{1,64}，还要能反查回 server+工具；撞名就加序号而不是静默覆盖 */
export function mcpToolName(serverId: string, tool: string, used: Set<string>): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 28)
  let base = `mcp__${slug(serverId)}__${slug(tool)}`.slice(0, 64)
  const seen = new Set(used)
  if (seen.has(base)) {
    let n = 2
    while (seen.has(`${base}_${n}`)) n++
    base = `${base}_${n}`.slice(0, 64)
  }
  return base
}

/** 把一批 server 的工具摊平成 OpenAI 函数表 + 路由表 */
export function mcpToolDefs(entries: { client: McpClient; tools: McpToolInfo[] }[]) {
  const used = new Set<string>()
  const routes: Record<string, { client: McpClient; tool: string }> = {}
  const defs: unknown[] = []
  for (const { client, tools } of entries) {
    for (const t of tools) {
      if (!t?.name) continue
      const name = mcpToolName(client.server.id, t.name, used)
      used.add(name)
      routes[name] = { client, tool: t.name }
      defs.push({
        type: 'function',
        function: {
          name,
          description: (t.description ?? '').slice(0, 500) || `MCP 工具 ${t.name}（来自 ${client.server.name}）`,
          // schema 缺省给空对象：不传 parameters 会被严格的接口当成非法函数定义
          parameters: t.inputSchema ?? { type: 'object', properties: {} }
        }
      })
    }
  }
  return { defs, routes }
}

/** 探一次：连接、列工具、马上关。设置页"连接并查看工具"与首次信任确认都用它取清单 */
export async function probeServer(server: McpServer): Promise<McpProbe> {
  let client: McpClient | undefined
  try {
    const r = await McpClient.connect(server)
    client = r.client
    const tools = await client.listTools()
    return {
      ok: true,
      message: tools.length ? `拿到 ${tools.length} 个工具` : '连接成功，但这个 server 没有提供工具',
      tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description.slice(0, 160) } : {}) })),
      ...(r.info.title ? { serverTitle: r.info.title } : {}),
      ...(r.info.version ? { serverVersion: r.info.version } : {})
    }
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message}` }
  } finally {
    client?.close()
  }
}
