/**
 * MCP 客户端（tools-only 子集）：把外部 MCP server 的工具并进 AgentHub 现有的工具循环。
 * 只接 tools——不接 prompts/resources，也不让 server 往上下文里塞系统提示。
 *
 * 传输两种：stdio（本机拉起一条命令，按换行分隔的 JSON-RPC 通信）与 http（远程 Streamable HTTP
 * 网关：每个请求一次 POST，响应可能是 JSON 或 SSE 流，按 Content-Type 分流）。
 * http 不经 shell、不经 cmd——URL 直连；SSRF 面见 HttpMcpClient 的注释，不在这里假装已解决。
 *
 * 信任模型（用户 2026-10-23 拍定）：首次连接要确认，确认后这一组工具整组放行；
 * 信任标记存在主进程 approvals.json，渲染层改不动，免得配置通道变成"自我授权"。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { McpServer, McpProbe, MemoryEntry } from '../shared/types'
import { cmdUnsafeReason, needsComspec } from '../shared/argv'
import { validHttpUrl } from '../shared/mcp-list'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT = 15_000
const MAX_BODY = 512 * 1024

/**
 * http 路径的三段超时，各段定死（与 stdio 的 timeoutMs 配置不同口径：http 连接/列表/调用
 * 各有明确上限，不读那条配置）。连接 15s、tools/list 30s；tools/call 是**空闲**超时——
 * 工具可能跑很久，只罚"停发"，不设总上限（与模型侧空闲超时同口径）。
 */
const HTTP_CONNECT_TIMEOUT = 15_000
const HTTP_LIST_TIMEOUT = 30_000
const HTTP_CALL_IDLE_TIMEOUT = 120_000

/** 单行缓冲上限（字符）：stdio 是换行分隔的 JSON-RPC，server 持续输出不含换行的数据会让行缓冲无界增长 */
const MAX_LINE_BUFFER = 1 << 20

/** 旧版单命令配置的拒收码：界面按这个码渲染，不靠文案匹配 */
export const MCP_LEGACY_CODE = 'invalid_legacy_command'

/** spawn 真正要带的选项。comspec 分支带 windowsVerbatimArguments，任何分支都不带 shell:true */
export interface SpawnPlanOptions {
  windowsHide: boolean
  shell?: boolean
  windowsVerbatimArguments?: boolean
}

export interface SpawnPlan {
  file: string
  args: string[]
  options: SpawnPlanOptions
  /** 这条确实经 cmd.exe（npm 家族）。披露用这个标记，不要用 shell 标志——本方案里不再有 shell:true */
  comspec: boolean
}

/**
 * comspec 分支的命令行构造：拒绝式，不做任何转义。
 * cmd 的引号规则里没有"转义引号"这东西——`\"` 不是转义（cmd 只把 `\` 当普通字符），
 * 所以 `"a\"b & type nul > f"` 会在 `\` 后面那个 `"` 处把引号区关掉，`&` 立刻变成真分隔符；
 * 而 `%` 即使在引号内也照样展开。含这两种字符的 token 在这一分支无法安全表示，只能拒收。
 * 规则（顺序即优先级）：
 * ① 含 `"` 或 `%` → 抛错，消息点名这个 token；
 * ② 含 `& | ^ < >` → 抛错，**与有没有空格无关**：本机实测（verify/fixes-check.mjs [X] 段有哨兵断言）
 *   引号并挡不住它们——`cmd /d /c "x & type nul > f"` 照样写出 f；`/d /s /c` 同样挡不住；
 *   而 `^` 转义要连写两层、极易出错。既然证明不了引号能中和，就按拒绝处理（不猜）。
 * ③ 含空白（或本身就是空串）→ 包一层双引号：①②已过，剩下的只是空格/普通字符，
 *   引号是 cmd 唯一认可的空格保序写法，`"C:\Program Files\nodejs\npm.cmd" --version` 实测可用；
 *   空串包成 `""` 是为了不把参数位静默吃掉（cmd 会合并裸的空格）。
 * ④ 其余原样直出。`npx -y @scope/pkg`、`npm.cmd --version` 这类常规配置不命中任何拒绝条件。
 * 已知限制（旧实现同样如此，不是这次引入的）：整条命令行里出现第 2 对引号时 cmd 的 /c
 * 会把首尾引号剥掉，`"a b" "c d"` 这种两个带空格参数会起不来（失败是响的，不是注入）。
 * ①②两条拒收规则抽到了 shared/argv 的 cmdUnsafeReason（设置页要在保存前预演同一条规则），
 * 这里只是把它转成抛错；改判定必须改那边，别在两边各写一份。
 */
function comspecToken(tok: string): string {
  const unsafe = cmdUnsafeReason(tok)
  if (unsafe) throw new Error(`MCP comspec 分支无法安全表示该参数，已拒收：${tok}（${unsafe}）`)
  if (!tok || /\s/.test(tok)) return `"${tok}"`
  return tok
}

/**
 * 把配置换算成一次 spawn 的入参与选项（裁决是纯的：不起进程、不碰文件系统，逻辑层可直接断言。
 * 唯一的环境读取是下面那行的 `process.env.ComSpec`——cmd.exe 的路径本来就由 Windows 决定，
 * 写死 C:\Windows\System32 反而在改过 ComSpec 的机器上起错进程；所以"纯"指的是**决策**纯，
 * 不是"一个 env 都不读"（评审 Task 3 ⑮：措辞原先说满了，行为是有意的，这里只把话讲准）。
 * 三种结果：
 * ① 有 launch 且不属 cmd 家族 → argv 数组直传，完全不经 cmd；
 * ② 只有旧 command → 抛 legacy 错误码，等用户重填（不猜拆，也不删记录）；
 * ③ `.cmd`/`.bat` 家族与 npm 系裸启动器（npx / npm / pnpm / yarn）→ 仍然经 cmd.exe 起
 *   （PATH 上它们没有同名 .exe，硬走 argv 只会 ENOENT），但参数经 comspecToken 拒绝式校验，
 *   配置值成不了 cmd 语法；再用 windowsVerbatimArguments 让 Node 把这条命令行原样交出去，
 *   不再叠 shell:true——那会让 Node 二次包一层 cmd 并打 DEP0190。
 * ②是用户 2026-10-23 拍定的，③是 Windows 的现实。
 */
export function planSpawn(server: McpServer): SpawnPlan {
  // http 记录没有"本机命令行"这回事：调到这里说明调用方分流失效，如实抛错，
  // 绝不硬编一个 spawn 计划出来（那等于把远程 server 当本机进程起）
  if (server.transport === 'http') {
    throw new Error('MCP server 是 HTTP 传输，不经本机进程启动（planSpawn 只负责 stdio）')
  }
  const bin = (server.launch?.bin ?? '').trim()
  if (!bin) {
    // 没 launch 只有 command：旧格式。v0.4.0 明确不作废式兼容——不自动拆分
    if ((server.command ?? '').trim()) throw new Error(`${MCP_LEGACY_CODE}：该 server 是旧版单命令配置，已停用，请在设置里重填`)
    throw new Error('MCP server 没有启动命令')
  }
  // 参数一律要真是字符串：手改成 [1, '--x'] 这种不能静默过滤掉（配置会悄悄变形）
  // 容器本身也一样（修复波 A · 项 5）：`Array.isArray(declared) ? declared : []` 会把
  // launch.args = '--x' 静默当**空数组**，而下面两行对数组里的非字符串元素是抛错的——
  // 判定不对称的后果是 mcp:probe（渲染层原样传来的对象，不过 sanitizeMcpList）悄悄丢光参数，
  // 去探测一条与用户配置**不同**的命令，"连接并查看工具"看到的结果因此不可信。
  // 键不存在（undefined）才算"没声明参数"；写了值却不是数组，与元素不是字符串同一口径：拒收。
  const declared = server.launch?.args
  if (declared !== undefined && !Array.isArray(declared)) {
    throw new Error(`MCP launch.args 不是数组（${typeof declared}：${String(declared).slice(0, 60)}），已拒收：参数必须是字符串数组，不替你猜着拆`)
  }
  const rawArgs: unknown[] = Array.isArray(declared) ? declared : []
  const badIdx = rawArgs.findIndex((a) => typeof a !== 'string')
  if (badIdx >= 0) throw new Error(`MCP launch.args 第 ${badIdx} 个是非字符串项（${String(rawArgs[badIdx])}），已拒收：参数必须全是字符串`)
  const args = rawArgs as string[]
  if (needsComspec(bin)) {
    // 拒绝式拼命令行：路径含空格必须带引号，否则 cmd 会在空格处断开
    const line = [bin, ...args].map(comspecToken).join(' ')
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    // shell 不带（默认 false）+ windowsVerbatimArguments：cmd.exe 自己就是我们要起的进程，
    // 再让 Node 包一层 shell 就成了 double-wrap（两层 cmd），还会招出 DEP0190 告警
    return { file: comspec, args: ['/d', '/c', line], options: { windowsHide: true, windowsVerbatimArguments: true }, comspec: true }
  }
  return { file: bin, args, options: { windowsHide: true }, comspec: false }
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
 * HttpMcpClient 以它为基类借用同一个接口形状（protected 的构造器/request/closed 供子类覆写），
 * 调用方（ipc.ts / probeServer / mcpToolDefs）因此对两种传输零区别。
 */
export class McpClient {
  /** 请求序号（JSON-RPC id）。protected：http 子类共用同一个计数器，避免同名私有字段让两类型不兼容 */
  protected seq = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  /** 丢弃过超长未完结行：一条连接只报一次，避免 server 疯狂输出时刷屏 */
  private droppedLine = false
  private proc?: ChildProcess
  protected closed = false

  protected constructor(readonly server: McpServer, private timeoutMs: number) {}

  static async connect(server: McpServer): Promise<{ client: McpClient; info: { title?: string; version?: string } }> {
    // 分流点一：内置组交给 BuiltinMcpClient（进程内实现，零子进程，免信任弹窗）
    if (server.builtin === 'basic') return BuiltinMcpClient.connect(server)
    // 分流点二：http 记录交给 HttpMcpClient（返回类型是 McpClient 的子类，调用方类型零改动）
    if (server.transport === 'http') return HttpMcpClient.connect(server)
    const c = new McpClient(server, server.timeoutMs && server.timeoutMs > 0 ? server.timeoutMs : DEFAULT_TIMEOUT)
    c.start()
    const info = await c.initialize()
    c.notify('notifications/initialized', {})
    return { client: c, info }
  }

  private start() {
    const plan = planSpawn(this.server)
    const child = spawn(plan.file, plan.args, {
      ...plan.options,
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
    // 单行上限：while 已把完整行全部消费，剩下的 this.buf 是未完结行。JSON-RPC 一行一条
    // 消息，1MB 还等不到换行只能是 server 违例或异常输出——整个丢掉（buffer 清空）保住
    // 主进程内存；残余字节会在下一个换行处拼成一行坏数据，走上面"非协议行丢掉"的既有容错。
    // 这里没有逐请求的事件通道可发 notice，console 镜像一行（本文件日志口径），一条连接只报一次。
    if (this.buf.length > MAX_LINE_BUFFER) {
      this.buf = ''
      if (!this.droppedLine) {
        this.droppedLine = true
        console.log(`[mcp] ${this.server.name} 输出单行超过 1MB，已丢弃（协议违例或异常输出）`)
      }
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

  /** stdio 是换行分隔的 JSON-RPC：一次 chunk 可能带多条，也可能切断一条。http 子类覆写为一次 POST */
  protected request(method: string, params?: unknown): Promise<unknown> {
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

  /**
   * signal 参数只为与 HttpMcpClient 的签名对齐（ipc.ts 的路由对两种传输调同一个形状）：
   * stdio 的取消口径是整条连接 close()（ipc.ts 的 closeMcp 就这么做的），不做逐调用中止。
   */
  async callTool(name: string, args: Record<string, unknown>, _signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type?: string; text?: string }[]
      isError?: boolean
    }
    return toolOutputFrom(r)
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

/** tools/call 的 result → 对外输出（stdio 与 http 两个路径共用同一份解析，别再各抄一份） */
function toolOutputFrom(r: { content?: { type?: string; text?: string }[]; isError?: boolean }): { ok: boolean; output: string } {
  const parts = (r?.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type ?? '内容'}]`)).filter(Boolean)
  const output = parts.join('\n') || '（该工具没有返回文本内容）'
  return { ok: !r?.isError, output: output.slice(0, MAX_BODY) }
}

/**
 * HTTP 传输的 MCP 客户端（Streamable HTTP 风格）：每个带 id 的 JSON-RPC 请求一次 POST，
 * 响应可能是 JSON 或 SSE 流（按 Content-Type 分流；SSE 按 data: 行解析，行缓冲上限 1MB，
 * 与 openai.ts 既有做法同一口径）。server 在响应头给 `mcp-session-id` 就保存下来，
 * 后续请求（含关闭时的 DELETE）都带上。与 McpClient 同一个接口形状，
 * 调用方（ipc.ts / probeServer / mcpToolDefs）对两种传输零区别。
 *
 * SSRF 面（如实注释，不假装解决）：URL 由用户配置并经"首次连接信任确认"，但程序不限制
 * 目标网段——配置指到内网地址照样会发，这和把命令配成访问内网的工具没有本质区别；
 * DNS rebinding 的残留风险与 web 工具同口径，后续统一收口。
 */
export class HttpMcpClient extends McpClient {
  private sessionId = ''
  private controllers = new Set<AbortController>()

  protected constructor(server: McpServer) {
    // 第二个参数是 stdio 的默认超时，http 路径三段各有定死口径，用不上
    super(server, 0)
  }

  static async connect(server: McpServer): Promise<{ client: HttpMcpClient; info: { title?: string; version?: string } }> {
    // mcp:list/mcp:set 两条路有 shared/mcp-list 的闸门，但 mcp:probe 与对话路径传来的对象
    // 不过闸门——使用点必须再验一次，判定函数是同一份（validHttpUrl）
    if (!validHttpUrl(server.url)) {
      throw new Error(`MCP HTTP server 的地址缺失或不是合法的 http(s) URL（收到：${String(server.url ?? '').slice(0, 120)}）`)
    }
    const c = new HttpMcpClient(server)
    try {
      const info = await c.initialize()
      c.notifyInitialized()
      return { client: c, info }
    } catch (e) {
      // 连不上就当场收掉（此时还没有 session，close 只会中止挂起请求，不会发 DELETE）
      c.close()
      throw e
    }
  }

  /** 公共请求头；有会话就带上（MCP Streamable HTTP 的会话口径） */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // JSON 与 SSE 都声明接受：用哪种响应由 server 决定，客户端按 Content-Type 分流
      Accept: 'application/json, text/event-stream'
    }
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    return h
  }

  /**
   * 发一个带 id 的 JSON-RPC 请求并等它的 result。响应 JSON 或 SSE 都收：
   * SSE 按 data: 行找与本请求 id 匹配的那条最终消息，error/result 的处理与 stdio 同一口径。
   * 错误如实透出：HTTP 状态 + 截断的响应体、超时/取消分开说清，包装是中文但保留原文。
   */
  private async postRpc(payload: RpcMessage, opts: { timeoutMs: number; idle?: boolean; signal?: AbortSignal }): Promise<unknown> {
    const url = String(this.server.url ?? '').trim()
    const ctrl = new AbortController()
    this.controllers.add(ctrl)
    const onOuterAbort = () => ctrl.abort()
    if (opts.signal) {
      if (opts.signal.aborted) onOuterAbort()
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    let timedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number) => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { timedOut = true; ctrl.abort() }, ms)
    }
    // 非 idle：总超时，从头到尾就这一个计时器；idle：每收到一段数据就重置（只罚"停发"）
    arm(opts.timeoutMs)
    const timeoutText = () =>
      `${opts.idle ? `工具调用 ${opts.timeoutMs / 1000}s 内没有任何数据到达` : `${payload.method ?? '请求'} 超时`}（${opts.timeoutMs / 1000}s）`
    try {
      let res: Response
      try {
        res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: ctrl.signal })
      } catch (e) {
        if (opts.signal?.aborted) throw new Error('已取消：请求被用户停止')
        if (timedOut) throw new Error(timeoutText())
        if (this.closed) throw new Error('连接已关闭')
        const err = e as Error & { cause?: Error }
        throw new Error(`无法连接 MCP HTTP server：${err.message}${err.cause?.message ? `（${err.cause.message}）` : ''}`)
      }
      if (opts.idle) arm(opts.timeoutMs)
      // 响应头带了会话就存下来，后续请求都带上
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      try {
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '')
          throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 300)}`)
        }
        const ct = (res.headers.get('content-type') ?? '').toLowerCase()
        if (ct.includes('text/event-stream')) {
          return await this.readSse(res, payload.id, opts.idle ? () => arm(opts.timeoutMs) : undefined)
        }
        const text = await res.text()
        let json: RpcMessage
        try {
          json = JSON.parse(text) as RpcMessage
        } catch {
          throw new Error(`MCP HTTP 响应不是合法 JSON：${text.slice(0, 120)}`)
        }
        if (json.error) throw new Error(json.error.message ?? 'MCP 返回错误')
        return json.result
      } catch (e) {
        if (opts.signal?.aborted) throw new Error('已取消：请求被用户停止')
        if (timedOut) throw new Error(timeoutText())
        // close() 也会 abort 内部控制器：没有外部 signal、也没超时，就按"连接已关"如实说（stdio failAll 同一句话）
        if (this.closed) throw new Error('连接已关闭')
        throw e
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      this.controllers.delete(ctrl)
    }
  }

  /** SSE 响应：按 data: 行解析；行缓冲超 1MB 整行丢掉（与 openai.ts / stdio 同一口径），一条连接只报一次 */
  private async readSse(res: Response, id: number | string | undefined, onData?: () => void): Promise<unknown> {
    const body = res.body
    if (!body) throw new Error('MCP HTTP 响应没有可读的正文') // 调用方已挡过一次，这里兜 TS 的 null 判断
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let droppedLine = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onData?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (buffer.length > MAX_LINE_BUFFER) {
        buffer = ''
        if (!droppedLine) {
          droppedLine = true
          console.log(`[mcp] ${this.server.name} SSE 单行超过 1MB，已丢弃（协议违例或异常输出）`)
        }
      }
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        let msg: RpcMessage
        try {
          msg = JSON.parse(line.slice(5).trim()) as RpcMessage
        } catch {
          continue // 非协议行：丢掉，与 stdio 路径的容错一致
        }
        if (msg.id !== undefined && id !== undefined && msg.id !== id) continue // 别的请求的响应
        if (msg.error) throw new Error(msg.error.message ?? 'MCP 返回错误')
        if ('result' in msg) return msg.result
      }
    }
    throw new Error('MCP SSE 流在返回结果之前就结束了')
  }

  /** 超时各段定死：initialize 15s、tools/list 30s（不读 stdio 那条 timeoutMs 配置） */
  protected override request(method: string, params?: unknown): Promise<unknown> {
    const id = this.seq++
    const payload: RpcMessage = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    return this.postRpc(payload, { timeoutMs: method === 'initialize' ? HTTP_CONNECT_TIMEOUT : HTTP_LIST_TIMEOUT })
  }

  /** 通知不等响应：POST 发出去就算数，失败只记日志，不阻断已拿到 initialize 结果的流程（stdio notify 同一口径） */
  private notifyInitialized(): void {
    const url = String(this.server.url ?? '').trim()
    if (!url) return
    fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      signal: AbortSignal.timeout(5000)
    }).catch((e) => console.log(`[mcp] ${this.server.name} notifications/initialized 发送失败（不等响应，不阻断）：${(e as Error).message}`))
  }

  /** tools/call：空闲超时 120s（工具可能跑很久，不设总上限），SSE 流式或 JSON 响应都收 */
  override async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const id = this.seq++
    const r = (await this.postRpc(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      { timeoutMs: HTTP_CALL_IDLE_TIMEOUT, idle: true, signal }
    )) as { content?: { type?: string; text?: string }[]; isError?: boolean }
    return toolOutputFrom(r)
  }

  /** close 之后为 false：http 没有子进程，"还活着"的口径就是没被 close（验证不泄漏后台资源的断言用） */
  override get running() {
    return !this.closed
  }

  override close() {
    if (this.closed) return
    this.closed = true
    // 先中止一切挂起请求，再 best-effort 清会话
    for (const c of this.controllers) {
      try { c.abort() } catch { /* noop */ }
    }
    this.controllers.clear()
    const url = String(this.server.url ?? '').trim()
    const sid = this.sessionId
    if (!sid || !url) return
    // 有会话才 DELETE（协议的会话销毁口径）。失败只记日志：调用结果已经拿到，关闭失败不该把它变成错误
    fetch(url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000) })
      .then((res) => {
        if (!res.ok) console.log(`[mcp] ${this.server.name} 关闭会话返回 HTTP ${res.status}（best-effort，忽略）`)
      })
      .catch((e) => console.log(`[mcp] ${this.server.name} 关闭会话失败（best-effort，忽略）：${(e as Error).message}`))
  }
}

/**
 * http server 的"实际连接对象"（等价于 stdio 的命令行）：显示 origin——数据与工具调用
 * 真正要发往的地方。URL 非法就原样亮出来，让用户自己看见配置有多糟，不替他粉饰。
 */
function httpDisplay(s: McpServer): string {
  const u = String(s.url ?? '').trim()
  let origin = u || '（URL 未填）'
  try { origin = new URL(u).origin } catch { /* 保底显示原文 */ }
  return `远程 HTTP server：数据与工具调用将发往 ${origin}`
}

/**
 * 信任弹窗要显示的"实际执行对象"。stdio 是实际执行的 argv（JSON 数组形态，与设置页
 * 「实际执行」预览同口径）；http 没有命令行，等价物是目标地址（httpDisplay）。
 */
export function trustCommand(s: McpServer): string {
  if (s.builtin === 'basic') return '（内置：随应用发布的进程内实现，不经外部进程，无需信任确认）'
  if (s.transport === 'http') return httpDisplay(s)
  return s.launch?.bin
    ? JSON.stringify([s.launch.bin, ...(Array.isArray(s.launch.args) ? s.launch.args : [])])
    : `${(s.command ?? '').trim()}${s.legacyInvalid ? '（已停用，v0.4.0 不再用旧单命令启动）' : ''}`
}

// ---------- 内置基础组（builtin-basic）：进程内实现，零子进程，随应用发布 ----------
//
// 信任口径：与内置工具（execTool）同级——代码随应用发布、不经外部进程、不需要首次连接确认。
// 这份"免信任"只认主进程合成的 BUILTIN_MCP_BASIC 常量：配置/提交里出现 builtin 字段的
// 条目会被 shared/mcp-list 的闸门剥掉或点名拒收，渲染层伪造不出这个身份。
// 工具循环、Hook、计划态整组禁用等既有管线对它照常生效（走 McpClient 同一形状）。

/** 内置基础组的虚拟配置：mcp:list 合成清单用。command 字段是只读说明，不参与任何启动逻辑 */
export const BUILTIN_MCP_BASIC: McpServer = {
  id: 'builtin-basic',
  name: '内置基础（时间 · 记忆）',
  builtin: 'basic',
  command: '（内置：随应用提供，无需配置）',
  enabled: true
}

/** 长期记忆存取注入：ipc 装配时绑定 store，逻辑层测试注入内存 fake。读写都是同步小操作 */
let memoryAccess: { get: () => MemoryEntry[]; add: (text: string, kind: MemoryEntry['kind']) => MemoryEntry } | null = null
export function bindBuiltinMemory(access: { get: () => MemoryEntry[]; add: (text: string, kind: MemoryEntry['kind']) => MemoryEntry }) {
  memoryAccess = access
}

const BUILTIN_BASIC_TOOLS: McpToolInfo[] = [
  {
    name: 'now',
    description: '获取当前日期与时间（模型自己不知道现在几点——凡涉时效性、日程、时间计算的问题先调它）。可选传 IANA 时区名换算（如 Asia/Shanghai、America/New_York），format 可选 date/time/datetime',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区名；缺省用本机时区' },
        format: { type: 'string', enum: ['datetime', 'date', 'time'], description: '缺省 datetime' }
      }
    }
  },
  {
    name: 'memory_save',
    description: '把跨会话需要记住的要点存入长期记忆：用户的目标、偏好、约束、关键决定、重要事实。每条一句话，宁短勿长',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的要点，一句话' },
        kind: { type: 'string', enum: ['goal', 'constraint', 'decision', 'summary'], description: '缺省 summary' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_list',
    description: '检索跨会话积累的长期记忆（用户目标/偏好/约定/决定）。回答涉及用户背景的问题前先查一次',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词过滤（不区分大小写）；缺省返回全部' },
        limit: { type: 'number', description: '返回条数上限，缺省 10，最大 50' }
      }
    }
  }
]

const MEMORY_KINDS: MemoryEntry['kind'][] = ['goal', 'constraint', 'decision', 'progress', 'review', 'confirm', 'summary']

/** tools/call 的进程内分发。返回 MCP result 形状，走与 stdio/http 同一份 toolOutputFrom 解析 */
function builtinCall(params: { name?: string; arguments?: Record<string, unknown> }): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const name = String(params?.name ?? '')
  const args = params?.arguments ?? {}
  const reply = (text: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })
  try {
    if (name === 'now') {
      const tz = typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : undefined
      const fmt = args.format === 'date' || args.format === 'time' ? args.format : 'datetime'
      const opts: Intl.DateTimeFormatOptions =
        fmt === 'date'
          ? { year: 'numeric', month: '2-digit', day: '2-digit', ...(tz ? { timeZone: tz } : {}) }
          : fmt === 'time'
            ? { hour: '2-digit', minute: '2-digit', second: '2-digit', ...(tz ? { timeZone: tz } : {}) }
            : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', ...(tz ? { timeZone: tz } : {}) }
      // 非法时区名会让 Intl 抛 RangeError——被外层 catch 如实报给模型，不猜着纠正
      const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      return reply(`当前时间（${zone}）：${new Intl.DateTimeFormat('zh-CN', opts).format(new Date())}\nUTC：${new Date().toISOString()}`)
    }
    if (name === 'memory_save') {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) return reply('text 不能为空：要记住的要点（一句话）', true)
      if (text.length > 500) return reply('单条记忆太长（上限 500 字），请拆成要点再存', true)
      const kind = MEMORY_KINDS.includes(args.kind as MemoryEntry['kind']) ? (args.kind as MemoryEntry['kind']) : 'summary'
      if (!memoryAccess) return reply('长期记忆存储尚未初始化（应用装配未完成）', true)
      const entry = memoryAccess.add(text, kind)
      return reply(`已记住（${entry.kind} · ${entry.id}）：${text}`)
    }
    if (name === 'memory_list') {
      if (!memoryAccess) return reply('长期记忆存储尚未初始化（应用装配未完成）', true)
      const kw = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : ''
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
      const all = memoryAccess.get()
      const hits = (kw ? all.filter((m) => (m.text ?? '').toLowerCase().includes(kw)) : [...all]).slice(-limit).reverse()
      return reply(hits.length ? hits.map((m) => `[${m.kind}] ${m.text}`).join('\n') : kw ? `（没有包含「${kw}」的长期记忆）` : '（长期记忆还是空的）')
    }
    return reply(`内置基础组没有这个工具：${name}`, true)
  } catch (e) {
    return reply(`内置工具执行失败：${(e as Error).message}`, true)
  }
}

/** 内置基础组客户端：request 直接进程内分发，initialize/tools/list/tools/call 全部同步即可完成 */
export class BuiltinMcpClient extends McpClient {
  private constructor(server: McpServer) {
    // 第二个参数是 stdio 的默认超时，内置路径没有网络与进程等待，用不上
    super(server, 0)
  }

  static async connect(server: McpServer): Promise<{ client: BuiltinMcpClient; info: { title?: string; version?: string } }> {
    return { client: new BuiltinMcpClient(server), info: { title: 'AgentHub 内置基础组', version: '1.0' } }
  }

  protected override request(method: string, params?: unknown): Promise<unknown> {
    if (method === 'initialize') {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { title: 'AgentHub 内置基础组', name: 'builtin-basic', version: '1.0' }
      })
    }
    if (method === 'tools/list') return Promise.resolve({ tools: BUILTIN_BASIC_TOOLS })
    if (method === 'tools/call') return Promise.resolve(builtinCall(params as { name?: string; arguments?: Record<string, unknown> }))
    // 与 mock server 同口径：未实现的方法如实报错（tools-only 子集，不接 prompts/resources）
    return Promise.reject(new Error(`内置基础组未实现方法：${method}`))
  }

  /** 进程内没有可泄漏的后台资源：close 只翻状态位（running 断言用同一口径） */
  override get running() {
    return !this.closed
  }

  override close() {
    this.closed = true
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
      // http 没有命令行可展示，回执带上"实际连接对象"（origin），设置页按这个口径显示数据去向
      ...(server.transport === 'http' ? { display: httpDisplay(server) } : {}),
      ...(r.info.title ? { serverTitle: r.info.title } : {}),
      ...(r.info.version ? { serverVersion: r.info.version } : {})
    }
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message}` }
  } finally {
    client?.close()
  }
}
