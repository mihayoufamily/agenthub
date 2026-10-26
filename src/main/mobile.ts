// 手机端查看服务（2026-10-26 批次）：主进程内建 HTTP 服务，手机浏览器/PWA 访问。
// 安全口径（fail-closed）：
//  - 默认关闭，prefs.mobileService.enabled 显式开启；token 配对，所有路由（含页面本身）先过 token
//  - 只读数据从 Store/ledger 直读，绝不含 API Key（safeStorage 里的东西本层就摸不到）；
//    agent 列表只给 id/name/kind/model，不给 keyId/hasKey/连接参数
//  - 写操作（发消息/审批）不自己执行——转发给渲染层既有 store 动作（sendMessage/confirmGate），
//    主进程不复制任何业务逻辑，桌面端 UI 同步可见"这条消息来自手机"
//  - 导出剥离：token 在 store.exportConfig 里置空（与 MCP env 同口径）
import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from './store'
import * as ledger from './ledger'
import { MOBILE_PAGE_HTML } from './mobile-page'
import { initMobileTunnel, syncTunnelForService } from './mobile-tunnel'
import { initMobileRelay, syncRelayForService } from './mobile-relay'
import type { ChatMessage, WorkflowRun } from '../shared/types'

const DEFAULT_PORT = 8748
const MAX_TEXT = 8000

export interface MobileStatus {
  enabled: boolean
  running: boolean
  port: number
  hasToken: boolean
  token?: string
  urls: string[]
  /** 自定义固定公网域名（用户自己的隧道入口，弹窗出独立二维码） */
  customDomain?: string
}

let server: http.Server | null = null
let currentPort = DEFAULT_PORT
let getStoreRef: () => Store | null = () => null
let getWinRef: () => BrowserWindow | null = () => null

// ---------- 配置存取 ----------

function readPref(): { enabled: boolean; port: number; token: string; customDomain?: string } {
  const st = getStoreRef()
  const p = st?.getConfig().prefs.mobileService
  return { enabled: p?.enabled ?? false, port: p?.port ?? DEFAULT_PORT, token: p?.token ?? '', customDomain: p?.customDomain }
}

function writePref(patch: Partial<{ enabled: boolean; port: number; token: string; customDomain: string }>) {
  const st = getStoreRef()
  if (!st) return
  const cfg = st.getConfig()
  const cur = { enabled: false, port: DEFAULT_PORT, token: '', ...cfg.prefs.mobileService }
  st.setPrefs({ ...cfg.prefs, mobileService: { ...cur, ...patch } })
}

// ---------- token 校验（常数时间比较；hex 两侧长度不同直接 false） ----------

function tokenOk(t: string | undefined): boolean {
  const want = readPref().token
  if (!want || !t || t.length !== want.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(t, 'utf8'), Buffer.from(want, 'utf8'))
  } catch {
    return false
  }
}

// ---------- 数据裁剪（只读面：给页面的都是"展示必需的最小字段"） ----------

function trimMessage(m: ChatMessage) {
  const text = (m.text ?? '').slice(0, 6000)
  return {
    id: m.id,
    role: m.role,
    ts: m.ts,
    text,
    truncated: (m.text ?? '').length > 6000,
    streaming: m.streaming,
    error: m.error,
    model: m.model,
    cost: m.cost,
    handoffFrom: m.handoff?.fromAgentName,
    toolNames: (m.toolCalls ?? []).map((t) => (t as { name?: string }).name ?? '').filter(Boolean).slice(-8)
  }
}

function runSummary(r: WorkflowRun) {
  return {
    id: r.id,
    goal: (r.goal ?? '').slice(0, 100),
    status: r.status,
    stage: r.stage,
    round: r.round,
    maxRounds: r.maxRounds,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    tokens: r.usage?.tokens,
    demo: r.demo,
    gate: r.status === 'waiting_user' && r.gate ? { kind: r.gate.kind ?? 'review', round: r.gate.round } : null
  }
}

function buildState(agentId: string | null) {
  const st = getStoreRef()
  if (!st) return { error: 'store unavailable' }
  const cfg = st.getConfig()
  const agents = cfg.agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind, model: a.model }))
  const active = agents.find((a) => a.id === agentId) ?? agents[0] ?? null

  let session: { agentId: string; title: string; messages: unknown[] } | null = null
  if (active) {
    const loaded = st.loadSessions(active.id)
    const list = loaded?.sessions ?? []
    const cur = list.find((s) => s.id === loaded?.activeId) ?? list[list.length - 1] ?? null
    if (cur) {
      session = { agentId: active.id, title: cur.title, messages: cur.messages.slice(-60).map(trimMessage) }
    }
  }

  const runs = [...st.listRuns()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(runSummary)

  // 用量：今日 + 累计（ledger 聚合口径与设置页一致，不另造算法）
  const entries = ledger.list(100000)
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const sum = (rows: ReturnType<typeof ledger.aggregate>) => ({
    calls: rows.reduce((n, r) => n + r.calls, 0),
    tokens: rows.reduce((n, r) => n + r.tokens, 0),
    cost: Math.round(rows.reduce((n, r) => n + r.cost, 0) * 100) / 100
  })
  const usage = {
    today: sum(ledger.aggregate(entries.filter((e) => e.ts >= dayStart.getTime()))),
    total: sum(ledger.aggregate(entries))
  }

  return { agents, activeAgentId: active?.id ?? null, session, runs, usage, serverTs: Date.now() }
}

// ---------- HTTP 服务 ----------

function json(res: http.ServerResponse, code: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  })
  res.end(buf)
}

function readBody(req: http.IncomingMessage, cap = 16384): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function lanUrls(port: number, token: string): string[] {
  const out: string[] = []
  const ifs = os.networkInterfaces()
  for (const list of Object.values(ifs)) {
    for (const ni of list ?? []) {
      // Node 22 family 是字符串 'IPv4'；防御式兼容数字枚举
      const v4 = ni.family === 'IPv4' || (ni.family as unknown) === 4
      if (v4 && !ni.internal) out.push(`http://${ni.address}:${port}/?t=${token}`)
    }
  }
  return out
}

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://local')
    // 访问日志（不带 token 值，只记有无）：手机"一直加载"时用它判定请求到没到服务端
    try { getStoreRef()?.log(`[mobile] ${req.socket.remoteAddress} ${req.method} ${url.pathname} t=${url.searchParams.get('t') ? 'yes' : 'no'}`) } catch { /* 日志失败不阻塞 */ }
    const t = url.searchParams.get('t') ?? undefined
    // 页面和 API 一视同仁：没带对 token 一律 401（页面给可读提示，不给任何数据）
    if (!tokenOk(t)) {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
        res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>🔗 配对无效或已更换</p><p style="opacity:.6;font-size:14px">请回桌面端 AgentHub「手机查看」弹窗重新扫码</p></div></body>')
        return
      }
      json(res, 401, { ok: false, message: '配对无效，请重新扫码' })
      return
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const buf = Buffer.from(MOBILE_PAGE_HTML)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff' })
      res.end(buf)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, buildState(url.searchParams.get('agent')))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const win = getWinRef()
      if (!win || win.isDestroyed()) { json(res, 503, { ok: false, message: '桌面端窗口不可用' }); return }
      let body: { agentId?: string; text?: string }
      try { body = JSON.parse(await readBody(req)) } catch { json(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      const text = (body.text ?? '').trim()
      const st = getStoreRef()
      if (!st || !body.agentId || !st.getConfig().agents.some((a) => a.id === body.agentId)) {
        json(res, 400, { ok: false, message: 'agentId 不存在' }); return
      }
      if (!text || text.length > MAX_TEXT) { json(res, 400, { ok: false, message: `消息需为 1-${MAX_TEXT} 字` }); return }
      win.webContents.send('mobile:send-message', { agentId: body.agentId, text })
      json(res, 200, { ok: true, forwarded: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/gate') {
      const win = getWinRef()
      if (!win || win.isDestroyed()) { json(res, 503, { ok: false, message: '桌面端窗口不可用' }); return }
      let body: { runId?: string; action?: string; feedback?: string }
      try { body = JSON.parse(await readBody(req)) } catch { json(res, 400, { ok: false, message: '请求体不是合法 JSON' }); return }
      const action = body.action
      if (action !== 'deliver' && action !== 'rework' && action !== 'stop') {
        json(res, 400, { ok: false, message: 'action 只接受 deliver/rework/stop' }); return
      }
      if (!body.runId || typeof body.runId !== 'string') { json(res, 400, { ok: false, message: '缺少 runId' }); return }
      const feedback = (body.feedback ?? '').slice(0, 2000)
      win.webContents.send('mobile:gate-decision', { runId: body.runId, action, feedback })
      json(res, 200, { ok: true, forwarded: true })
      return
    }

    json(res, 404, { ok: false, message: 'not found' })
  })().catch(() => {
    try { json(res, 500, { ok: false, message: 'internal error' }) } catch { /* 已写头就算了 */ }
  })
}

function startServer(): Promise<void> {
  if (server) return Promise.resolve()
  const pref = readPref()
  if (!pref.token) writePref({ token: crypto.randomBytes(18).toString('hex') })
  currentPort = pref.port
  // listen 是异步的：等 listening/error 落定再返回，调用方的 status() 才能如实报告 running/urls
  return new Promise((resolve) => {
    const s = http.createServer(handle)
    s.on('error', () => { if (server === s) server = null; resolve() }) // 端口被占等：状态如实显示未运行
    s.once('listening', resolve)
    server = s
    s.listen(currentPort, '0.0.0.0')
  })
}

function stopServer() {
  if (!server) return
  const s = server
  server = null
  try { s.close() } catch { /* noop */ }
}

// ---------- 状态与 IPC ----------

function status(): MobileStatus {
  const pref = readPref()
  const running = !!server && server.listening
  return {
    enabled: pref.enabled,
    running,
    port: currentPort,
    hasToken: !!pref.token,
    // token 只在已启用时给（弹窗要拿它画二维码）；关闭状态不外借
    token: pref.enabled && pref.token ? pref.token : undefined,
    urls: pref.enabled && running && pref.token ? lanUrls(currentPort, pref.token) : [],
    customDomain: pref.customDomain || undefined
  }
}

export function initMobile(opts: { getStore: () => Store; getWin: () => BrowserWindow | null }) {
  getStoreRef = opts.getStore
  getWinRef = opts.getWin

  ipcMain.handle('mobile:status', () => status())
  ipcMain.handle('mobile:setEnabled', async (_e, on: boolean) => {
    if (typeof on !== 'boolean') return { ok: false, message: 'setEnabled 只接受布尔值' }
    writePref({ enabled: on })
    if (on) await startServer(); else stopServer()
    // 公网隧道跟随服务：服务开→按 tunnel 意图拉起；服务关→隧道必停
    syncTunnelForService(on)
    // 中继网关同一口径（出站 WS，下载者零配置公网）
    syncRelayForService(on)
    return { ok: true, ...status() }
  })

  // 随应用启动恢复：上次开着就接着开（与托盘/定时任务同一"跟随配置"口径）
  if (readPref().enabled) startServer()
  // 自定义固定公网域名（用户自己的隧道入口，弹窗独立二维码）
  ipcMain.handle('mobile:setCustomDomain', (_e, d: unknown) => {
    if (typeof d !== 'string') return { ok: false, message: '参数必须是字符串' }
    // 归一化：剥协议/路径/末尾斜杠，只留 hostname（端口保留）
    const clean = d.trim().replace(/^https?:\/\//i, '').replace(/\/+.*$/, '')
    if (clean && !/^[a-z0-9.-]+(:\d+)?$/i.test(clean)) return { ok: false, message: '域名格式不对（示例：mobile.example.com）' }
    writePref({ customDomain: clean })
    return { ok: true, customDomain: clean || undefined }
  })
  // 公网隧道的 IPC + 恢复（自己判断 enabled && tunnel，服务端口的 listen 异步落定前它已能连边缘）
  initMobileTunnel({ getStore: opts.getStore, getWin: opts.getWin })
  // 中继网关的 IPC + 恢复（自己判断 enabled && relay）
  initMobileRelay({ getStore: opts.getStore, getWin: opts.getWin })
}
