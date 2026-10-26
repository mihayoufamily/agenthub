// 中继网关客户端（2026-10-26）：AgentHub 主动出站 WebSocket 连到中继网关，
// 让下载者零配置获得公网手机访问（免端口/免防火墙/免域名/免 cloudflared）。
// 职责：
//  - 连接 wss://<网关>，hello 注册 token（网关按 token 路由，同 token 后连踢前连）
//  - 收 req → 本地 fetch 自己的 8748 HTTP 服务（**复用全部既有鉴权/裁剪/写校验，本模块零业务逻辑**）
//  - 断线指数退避重连（1s→30s cap）；服务关→连接必断（公网入口跟随服务，与 quick tunnel 同口径）
//  - WS 传输：RFC6455 客户端自实现（**Electron 主进程没有 Node 的全局 WebSocket**——实测
//    new WebSocket 抛 ReferenceError 会崩掉主进程，见 relay-check 首轮排查），零新增依赖。
//    wss:// 经 node:tls 出站（端到端 TLS 到网关侧），ws:// 仅用于本地/测试
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from './store'

const DEFAULT_RELAY_URL = 'wss://relay.zdymodel.de5.net'
const RECONNECT_MAX_MS = 30000
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 512 * 1024

export interface RelayStatus {
  /** 用户意图（prefs.mobileService.relay） */
  enabled: boolean
  /** WebSocket 已连接且 hello-ok */
  connected: boolean
  /** 网关固定公网入口（https 形式，手机直接访问） */
  publicUrl?: string
  /** 出站网关地址 */
  relayUrl: string
  error?: string
}

let sock: WsClient | null = null
let reconnectAttempt = 0
let reconnectTimer: NodeJS.Timeout | null = null
let closedByUs = false
let curError: string | undefined
let helloOk = false
let getStoreRef: () => Store | null = () => null
let getWinRef: () => BrowserWindow | null = () => null

// ---------- RFC6455 客户端（最小子集：text/close/ping/pong；客户端帧必 mask） ----------

/** HTTP CONNECT 代理参数（校园网/公司网对 CF 直连被阻断时，经代理出站绕行） */
interface ProxyConf { host: string; port: number }

/** 从环境变量读代理（HTTPS_PROXY > HTTP_PROXY；多数代理软件会自动设置或用户手动设置） */
function proxyFromEnv(): ProxyConf | undefined {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return { host: u.hostname, port: Number(u.port) || 8080 }
  } catch { /* 格式不对当没有 */ }
  return undefined
}

class WsClient {
  // 异步路径赋值（直连/代理隧道/TLS 升级三态），! 断言构造后必然就位
  private socket!: net.Socket
  private buf = Buffer.alloc(0)
  private handshakeDone = false
  alive = true
  onmessage: ((s: string) => void) | null = null
  onclose: (() => void) | null = null
  onopen: (() => void) | null = null

  constructor(url: string, proxy?: ProxyConf) {
    const u = new URL(url)
    const targetPort = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80)
    const secure = u.protocol === 'wss:'
    const key = crypto.randomBytes(16).toString('base64')
    // query 必须带上（Worker 版靠 ?t=token 路由 DO；只发 pathname 会 401）
    const reqPath = (u.pathname === '/' ? '/' : u.pathname) + u.search

    let wire: net.Socket | null = null // 到目标的原始字节通道（直连 socket 或 CONNECT 隧道）
    const startWs = (raw: net.Socket) => {
      wire = secure
        ? tls.connect({ socket: raw, servername: u.hostname })
        : raw
      this.socket = wire
      wire.on('data', (d) => {
        if (!this.handshakeDone) {
          this.buf = Buffer.concat([this.buf, d])
          const idx = this.buf.indexOf('\r\n\r\n')
          if (idx < 0) return
          const head = this.buf.subarray(0, idx).toString('utf8')
          const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
          if (!/HTTP\/1\.1 101/.test(head) || !head.includes(expected)) { this.#dead(); return }
          this.handshakeDone = true
          const rest = this.buf.subarray(idx + 4)
          this.buf = Buffer.alloc(0)
          if (rest.length) this.#feed(rest)
          this.onopen?.()
          return
        }
        this.#feed(d)
      })
      wire.on('error', () => this.#dead())
      wire.on('close', () => this.#dead())
      wire.write(
        `GET ${reqPath} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    }

    if (proxy) {
      // 经代理：TCP 到代理 → CONNECT 建隧道 → 隧道上做（TLS +）WS 握手
      const raw = net.connect(proxy.port, proxy.host)
      let cbuf = Buffer.alloc(0)
      const onConnectData = (d: Buffer) => {
        cbuf = Buffer.concat([cbuf, d])
        const idx = cbuf.indexOf('\r\n\r\n')
        if (idx < 0) return
        raw.off('data', onConnectData)
        const head = cbuf.subarray(0, idx).toString('utf8')
        if (!/HTTP\/1\.1 200/.test(head)) { this.#dead(); return } // 代理拒绝（403/407 等）
        startWs(raw) // 隧道内的剩余字节应为空（TLS 从头开始）
      }
      raw.on('connect', () => raw.write(`CONNECT ${u.hostname}:${targetPort} HTTP/1.1\r\nHost: ${u.hostname}:${targetPort}\r\n\r\n`))
      raw.on('data', onConnectData)
      raw.on('error', () => this.#dead())
      raw.on('close', () => { if (!wire) this.#dead() })
    } else {
      const raw = net.connect(targetPort, u.hostname)
      raw.on('connect', () => startWs(raw))
      raw.on('error', () => this.#dead())
      raw.on('close', () => { if (!wire) this.#dead() })
    }
  }
  #feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d])
    let off = 0
    for (;;) {
      let frame: { opcode: number; payload: Buffer; consumed: number } | null = null
      try { frame = this.#decode(this.buf.subarray(off)) } catch { this.#dead(); return }
      if (!frame) break
      off += frame.consumed
      if (frame.opcode === 0x1) this.onmessage?.(frame.payload.toString('utf8'))
      else if (frame.opcode === 0x9) this.#send(0xA, frame.payload)
      else if (frame.opcode === 0xA) { /* pong：keepalive 由上层定时器管 */ }
      else if (frame.opcode === 0x8) { this.#dead(); return }
    }
    this.buf = off > 0 ? this.buf.subarray(off) : this.buf
  }
  /** 服务器帧不 mask（RFC6455） */
  #decode(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
    if (buf.length < 2) return null
    const opcode = buf[0] & 0x0f
    let len = buf[1] & 0x7f
    let off = 2
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
    else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
    if (len > MAX_PAYLOAD) throw new Error('frame too large')
    if (buf.length < off + len) return null
    return { opcode, payload: Buffer.from(buf.subarray(off, off + len)), consumed: off + len }
  }
  #send(opcode: number, payload: Buffer) {
    if (!this.alive) return
    const mask = crypto.randomBytes(4)
    const len = payload.length
    let head: Buffer
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len])
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2) }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2) }
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]
    try { this.socket.write(Buffer.concat([head, mask, masked])) } catch { this.#dead() }
  }
  sendText(s: string) { this.#send(0x1, Buffer.from(s, 'utf8')) }
  close() { try { this.#send(0x8, Buffer.alloc(0)) } catch { /* noop */ } }
  #dead() {
    if (!this.alive) return
    this.alive = false
    try { this.socket.destroy() } catch { /* noop */ }
    this.onclose?.()
  }
}

// ---------- 配置（relay/relayUrl 归本模块；enabled/port/token 归 mobile.ts） ----------

function readPref(): { enabled: boolean; port: number; token: string; relay: boolean; relayUrl: string } {
  const st = getStoreRef()
  const p = st?.getConfig().prefs.mobileService
  return {
    enabled: p?.enabled ?? false,
    port: p?.port ?? 8748,
    token: p?.token ?? '',
    relay: p?.relay ?? false,
    // AGENTHUB_RELAY_URL_OVERRIDE：verify 注入本地网关地址（ws://127.0.0.1:18090），生产不设
    relayUrl: process.env.AGENTHUB_RELAY_URL_OVERRIDE ?? p?.relayUrl ?? DEFAULT_RELAY_URL
  }
}

function writeRelayPref(patch: { relay?: boolean; relayUrl?: string }) {
  const st = getStoreRef()
  if (!st) return
  const cfg = st.getConfig()
  const cur = { enabled: false, port: 8748, token: '', ...cfg.prefs.mobileService }
  st.setPrefs({ ...cfg.prefs, mobileService: { ...cur, ...patch } })
}

function publicUrlFrom(relayUrl: string, token: string): string {
  // wss/ws 一律映射 https（公网段 TLS 由网关侧反代/CF 终结）
  const httpsUrl = relayUrl.replace(/^(wss|ws):\/\//, 'https://').replace(/\/+$/, '')
  return `${httpsUrl}/?t=${token}`
}

function status(): RelayStatus {
  const p = readPref()
  return {
    enabled: p.relay,
    connected: !!sock && sock.alive && helloOk,
    publicUrl: p.relay && p.token ? publicUrlFrom(p.relayUrl, p.token) : undefined,
    relayUrl: p.relayUrl,
    error: curError
  }
}

function push() {
  const w = getWinRef()
  if (w && !w.isDestroyed()) w.webContents.send('mobile:relay-status', status())
}

// ---------- 请求处理：网关 req → 本地 HTTP → resp ----------

async function handleReq(pack: { id: string; method?: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string | null }) {
  const p = readPref()
  const qs = new URLSearchParams({ t: p.token, ...(pack.query ?? {}) }).toString()
  const url = `http://127.0.0.1:${p.port}${pack.path}?${qs}`
  const method = pack.method ?? 'GET'
  const init: RequestInit = { method }
  if (method === 'POST' && typeof pack.body === 'string') {
    init.headers = { 'Content-Type': pack.headers?.['content-type'] || 'application/json' }
    init.body = pack.body
  }
  try {
    const r = await fetch(url, init)
    const body = await r.text()
    return { type: 'resp', id: pack.id, status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json; charset=utf-8' }, body }
  } catch {
    return { type: 'resp', id: pack.id, status: 502, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: false, message: '桌面端本地服务不可达' }) }
  }
}

// ---------- 连接生命周期 ----------

function connect(attempt = 0) {
  const p = readPref()
  if (!p.enabled || !p.relay || sock) return
  if (!p.token) { curError = '手机端服务尚未生成 token（先开关一次服务）'; push(); return }
  closedByUs = false
  curError = undefined
  push()

  // 三通道轮换（每次重连换一条，总有一条能活）：
  //   代理-wss（env 代理存在时）→ 直连-wss:443 → 直连-ws:80
  // 校园网/公司网对 CF 直连被阻断时，代理通道兜底；无代理环境自动退化为双端口轮换
  const proxy = proxyFromEnv()
  const seq: { url: string; proxy?: ProxyConf }[] = []
  if (proxy) seq.push({ url: p.relayUrl, proxy })
  seq.push({ url: p.relayUrl })
  seq.push({ url: p.relayUrl.replace(/^wss:/, 'ws:').replace(/:443$/, '') })
  const pick = seq[attempt % seq.length]

  let client: WsClient
  try {
    // URL 携带 token：Worker 版网关靠它路由 DO（Node 版在 hello 里兼容）
    client = new WsClient(pick.url + '/?t=' + p.token, pick.proxy)
  } catch (e) {
    curError = `网关地址无效：${e instanceof Error ? e.message : String(e)}`
    scheduleReconnect(attempt)
    return
  }
  sock = client
  client.onopen = () => { client.sendText(JSON.stringify({ type: 'hello', token: p.token, ua: 'agenthub' })) }
  client.onmessage = (raw) => {
    let msg: { type?: string; id?: string; [k: string]: unknown }
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'hello-ok') {
      helloOk = true
      reconnectAttempt = 0
      curError = undefined
      push()
      return
    }
    if (msg.type === 'req' && typeof msg.id === 'string') {
      void handleReq(msg as never).then((resp) => {
        if (sock === client && client.alive) client.sendText(JSON.stringify(resp))
      })
    }
  }
  client.onclose = () => {
    if (sock !== client) return
    sock = null
    helloOk = false
    if (closedByUs) { push(); return } // 主动关闭：不重连、不报错
    if (!curError) curError = '无法连接中继网关（自动在 代理/直连/备用端口 间轮换重试；局域网入口不受影响）'
    scheduleReconnect(attempt)
  }
}

function scheduleReconnect(attempt: number) {
  push()
  const p = readPref()
  if (closedByUs || !p.enabled || !p.relay) return
  const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), RECONNECT_MAX_MS)
  reconnectAttempt = attempt + 1
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(attempt + 1) }, delay)
}

function disconnect() {
  closedByUs = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectAttempt = 0
  helloOk = false
  curError = undefined
  const s = sock
  sock = null
  try { s?.close() } catch { /* noop */ }
  push()
}

/**
 * 手机端服务开关联动（mobile.ts 调用）：服务开→按 relay 意图连接；服务关→连接必断。
 * 与 quick tunnel（syncTunnelForService）同一口径。
 */
export function syncRelayForService(serviceOn: boolean): void {
  if (!serviceOn) { disconnect(); return }
  if (readPref().relay) connect()
}

export function initMobileRelay(opts: { getStore: () => Store; getWin: () => BrowserWindow | null }) {
  getStoreRef = opts.getStore
  getWinRef = opts.getWin

  ipcMain.handle('mobile:relayStatus', () => status())
  ipcMain.handle('mobile:setRelayEnabled', (_e, on: boolean) => {
    if (typeof on !== 'boolean') return { ok: false, ...status(), error: '参数必须是布尔值' }
    writeRelayPref({ relay: on })
    if (!readPref().enabled) {
      // 服务本体没开：意图已记住，不连接（公网入口跟随服务）
      return { ok: true, ...status(), error: status().error ?? '请先开启手机端访问' }
    }
    if (on) { reconnectAttempt = 0; connect() } else disconnect()
    return { ok: true, ...status() }
  })

  // 随应用启动恢复：服务开 + relay 开 → 出站连接（延后 1.5s 避开启动高峰；网络慢时后台自动重连）
  if (readPref().enabled && readPref().relay) setTimeout(connect, 1500)
}
