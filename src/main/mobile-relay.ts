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
import { ipcMain, session } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from './store'

const DEFAULT_RELAY_URL = 'wss://relay.zdymodel.de5.net'
const RECONNECT_MAX_MS = 30000
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 512 * 1024
/**
 * 客户端心跳：出站 WS 穿 NAT/代理时，空闲连接会被中间盒静默掐掉（半开）——
 * 本端 socket 看起来还活着，网关侧早已收不到数据，手机访问就报"桌面端不在线"。
 * 25s 一次 ping 保活 NAT 映射；50s 没收到任何入站帧（pong/消息）就判死重连。
 * 服务端（Worker 边缘）会代答 ping 的 pong，不会唤醒 DO，两不耽误。
 */
const PING_INTERVAL_MS = 25000
const DEAD_AFTER_MS = 50000

export interface RelayStatus {
  /** 用户意图（prefs.mobileService.relay） */
  enabled: boolean
  /** WebSocket 已连接且 hello-ok */
  connected: boolean
  /** 网关固定公网入口（https 形式，手机直接访问） */
  publicUrl?: string
  /** 出站网关地址 */
  relayUrl: string
  /** 当前出站通道描述（如"代理 127.0.0.1:12450" / "直连"），供 UI 如实展示 */
  channel?: string
  /** 用户手动指定的出站代理（空=自动检测） */
  proxyUrl?: string
  error?: string
}

/**
 * 代理通道失败后的冷却窗口：代理端口死了（软件没开/核心服务没起）就先走直连，
 * 冷却结束再试一次代理——避免死代理把中继永久卡死，也不至于永远放弃代理。
 */
const PROXY_DEAD_MS = 60000
let sock: WsClient | null = null
let reconnectAttempt = 0
let reconnectTimer: NodeJS.Timeout | null = null
let closedByUs = false
let curError: string | undefined
/** 当前出站通道的可读描述（"代理 127.0.0.1:12450" / "直连"），UI 如实展示 */
let curChannel = ''
let helloOk = false
let proxyDeadUntil = 0
let proxyDeadReason = ''
let getStoreRef: () => Store | null = () => null
let getWinRef: () => BrowserWindow | null = () => null

// ---------- RFC6455 客户端（最小子集：text/close/ping/pong；客户端帧必 mask） ----------

/** HTTP CONNECT 代理参数（校园网/公司网对 CF 直连被阻断时，经代理出站绕行） */
interface ProxyConf {
  host: string
  port: number
  /** 来源，仅供诊断展示 */
  source: 'manual' | 'env' | 'system' | 'scan'
}

/** 解析代理 URL（只认 http(s):// 的 CONNECT 代理；socks:// 不支持） */
function parseProxyUrl(raw: string | undefined, source: ProxyConf['source']): ProxyConf | undefined {
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) {
      return { host: u.hostname, port: Number(u.port) || 8080, source }
    }
  } catch { /* 格式不对当没有 */ }
  return undefined
}

/** 从环境变量读代理（HTTPS_PROXY > HTTP_PROXY） */
function proxyFromEnv(): ProxyConf | undefined {
  return parseProxyUrl(
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy,
    'env'
  )
}

/** 从 url 里安全取 hostname（解析失败返回空串，按"非私有"处理） */
function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

/** 回环/私有网段：这些地址经代理通常被拒（no_proxy 语义），必须直连 */
function isPrivateHost(h: string): boolean {
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  return /^(127\.|10\.|192\.168\.|169\.254\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

/** TCP 存活探测（给代理端口用） */
function probeTcp(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const s = net.connect({ host, port })
    const fin = (v: boolean) => {
      if (done) return
      done = true
      try { s.destroy() } catch { /* noop */ }
      resolve(v)
    }
    s.setTimeout(timeoutMs)
    s.on('connect', () => fin(true))
    s.on('timeout', () => fin(false))
    s.on('error', () => fin(false))
  })
}

/** 系统代理（Electron session.resolveProxy，与浏览器同源判定） */
async function systemProxy(): Promise<ProxyConf | undefined> {
  try {
    const info = await session.defaultSession.resolveProxy(DEFAULT_RELAY_URL)
    for (const part of info.split(';')) {
      const t = part.trim()
      if (t.toUpperCase().startsWith('PROXY ')) {
        const [host, port] = t.slice(6).trim().split(':')
        if (host && port) return { host, port: Number(port) || 80, source: 'system' }
      }
    }
  } catch { /* 无会话或失败当无代理 */ }
  return undefined
}

/** 候选代理列表（按优先级）：手动配置 > 环境变量 > 系统代理 */
async function collectProxies(): Promise<ProxyConf[]> {
  const manual = parseProxyUrl(getStoreRef()?.getConfig().prefs.mobileService?.proxyUrl, 'manual')
  const env = proxyFromEnv()
  const sys = await systemProxy()
  const out: ProxyConf[] = []
  for (const c of [manual, env, sys]) {
    if (c && !out.some((x) => x.host === c.host && x.port === c.port)) out.push(c)
  }
  return out
}

/**
 * 选一个**真正活着**的代理。
 * 顺序：配置来的候选（手动 > env > 系统代理，逐个探活）→ 都不行则扫常见代理端口。
 * 为什么要探活：Windows 系统代理注册表常在代理软件退出后残留（ProxyEnable=1、端口无人监听），
 * 此时照配置去 CONNECT 会立刻被拒——不探活就会一直往死端口上撞。
 * 为什么还要扫端口：很多代理软件默认不开系统代理（或用户没点"设为系统代理"），
 * 配置里根本没有它，但端口在监听——扫出来能省掉用户手动填代理地址。
 */
async function detectProxy(): Promise<ProxyConf | undefined> {
  for (const c of await collectProxies()) {
    if (await probeTcp(c.host, c.port)) return c
  }
  return scanCommonProxies()
}

/** 常见代理端口（Clash/Clash Verge/v2rayN/Shadowsocks/SakuraCat 等的默认 HTTP 混合端口） */
const COMMON_PROXY_PORTS = [7890, 7891, 7897, 1080, 10808, 10809, 2080, 8889, 12450]
/** 端口扫描节流：30s 内不重复扫（重连退避会频繁调 detectProxy） */
const SCAN_TTL_MS = 30000
let scanAt = 0
let scanHit: ProxyConf | undefined

/**
 * 扫常见端口并**实测能否经它到网关**（只探 TCP 活不够——本地任何服务都可能占着 7890）。
 * 逐个 CONNECT + TLS 太重，先用 300ms TCP 快筛，再对活着的做一次到网关的真连测试。
 */
async function scanCommonProxies(): Promise<ProxyConf | undefined> {
  if (Date.now() - scanAt < SCAN_TTL_MS) return scanHit
  scanAt = Date.now()
  scanHit = undefined
  const p = readPref()
  const host = safeHost(p.relayUrl)
  if (!host || isPrivateHost(host)) return undefined // 内网/本地网关不需要代理，别白扫
  let port = 443
  try { port = Number(new URL(p.relayUrl).port) || (p.relayUrl.startsWith('wss') ? 443 : 80) } catch { /* 保持 443 */ }

  const alive = (await Promise.all(
    COMMON_PROXY_PORTS.map(async (pt) => ((await probeTcp('127.0.0.1', pt, 300)) ? pt : 0))
  )).filter((pt) => pt > 0)
  for (const pt of alive) {
    const cand: ProxyConf = { host: '127.0.0.1', port: pt, source: 'scan' }
    if ((await probeThroughProxy(cand, host, port, 4000)) === 'ok') { scanHit = cand; break }
  }
  return scanHit
}

/** 诊断用：经代理 CONNECT + TLS 到网关（返回 'ok' 或失败原因） */
function probeThroughProxy(proxy: ProxyConf, host: string, port: number, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    let done = false
    const fin = (v: string, s?: net.Socket) => {
      if (done) return
      done = true
      try { s?.destroy() } catch { /* noop */ }
      resolve(v)
    }
    const raw = net.connect(proxy.port, proxy.host)
    const timer = setTimeout(() => fin('超时', raw), timeoutMs)
    raw.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); fin(`代理连接失败 ${e.code ?? ''}`, raw) })
    raw.on('connect', () => raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`))
    let buf = Buffer.alloc(0)
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      raw.off('data', onData)
      const head = buf.subarray(0, idx).toString('utf8')
      const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0)
      if (code !== 200) { clearTimeout(timer); fin(code ? `代理拒绝 CONNECT（HTTP ${code}）` : '代理返回异常', raw); return }
      const t = tls.connect({ socket: raw, servername: host }, () => { clearTimeout(timer); fin('ok', t) })
      t.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); fin(`TLS 失败 ${e.code ?? ''}`, t) })
    }
    raw.on('data', onData)
  })
}

class WsClient {
  // 异步路径赋值（直连/代理隧道/TLS 升级三态），! 断言构造后必然就位
  private socket!: net.Socket
  private buf = Buffer.alloc(0)
  private handshakeDone = false
  /** 最近一次收到入站帧的时刻（心跳判活依据：ping/pong/消息都算） */
  private lastSeenAt = 0
  private pingTimer: NodeJS.Timeout | null = null
  alive = true
  /** 失败原因（诊断/提示用；首次失败即固定，避免被后续 close 覆盖成笼统信息） */
  failReason = ''
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
          if (!/HTTP\/1\.1 101/.test(head) || !head.includes(expected)) { this.#dead('网关握手被拒（非 101 响应）'); return }
          this.handshakeDone = true
          const rest = this.buf.subarray(idx + 4)
          this.buf = Buffer.alloc(0)
          if (rest.length) this.#feed(rest)
          this.#startHeartbeat()
          this.onopen?.()
          return
        }
        this.#feed(d)
      })
      wire.on('error', (e: NodeJS.ErrnoException) => this.#dead(`连接错误 ${e.code ?? e.message ?? ''}`.trim()))
      wire.on('close', () => this.#dead('连接被对端关闭'))
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
        const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0)
        if (code !== 200) {
          this.#dead(code === 407 ? '代理要求认证（HTTP 407）' : code ? `代理拒绝 CONNECT（HTTP ${code}）` : '代理返回异常')
          return
        }
        startWs(raw) // 隧道内的剩余字节应为空（TLS 从头开始）
      }
      raw.on('connect', () => raw.write(`CONNECT ${u.hostname}:${targetPort} HTTP/1.1\r\nHost: ${u.hostname}:${targetPort}\r\n\r\n`))
      raw.on('data', onConnectData)
      raw.on('error', (e: NodeJS.ErrnoException) => this.#dead(`代理不可达 ${e.code ?? ''}`.trim()))
      raw.on('close', () => { if (!wire) this.#dead('代理连接被关闭') })
    } else {
      const raw = net.connect(targetPort, u.hostname)
      raw.on('connect', () => startWs(raw))
      raw.on('error', (e: NodeJS.ErrnoException) => this.#dead(`直连失败 ${e.code ?? ''}`.trim()))
      raw.on('close', () => { if (!wire) this.#dead('直连被关闭') })
    }
  }
  #feed(d: Buffer) {
    this.lastSeenAt = Date.now()
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
  /** 心跳：定期 ping；超过 DEAD_AFTER_MS 没有任何入站帧 → 判死（触发上层重连） */
  #startHeartbeat() {
    this.lastSeenAt = Date.now()
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (!this.alive) { if (this.pingTimer) clearInterval(this.pingTimer); return }
      if (Date.now() - this.lastSeenAt > DEAD_AFTER_MS) { this.#dead('心跳超时（连接已被网络静默掐断）'); return }
      this.#send(0x9, Buffer.alloc(0))
    }, PING_INTERVAL_MS)
  }
  #dead(reason = '连接中断') {
    if (!this.alive) return
    this.alive = false
    if (!this.failReason) this.failReason = reason
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    try { this.socket?.destroy() } catch { /* noop */ }
    this.onclose?.()
  }
}

// ---------- 配置（relay/relayUrl 归本模块；enabled/port/token 归 mobile.ts） ----------

function readPref(): { enabled: boolean; port: number; token: string; relay: boolean; relayUrl: string; proxyUrl: string } {
  const st = getStoreRef()
  const p = st?.getConfig().prefs.mobileService
  return {
    enabled: p?.enabled ?? false,
    port: p?.port ?? 8748,
    token: p?.token ?? '',
    relay: p?.relay ?? false,
    // AGENTHUB_RELAY_URL_OVERRIDE：verify 注入本地网关地址（ws://127.0.0.1:18090），生产不设
    relayUrl: process.env.AGENTHUB_RELAY_URL_OVERRIDE ?? p?.relayUrl ?? DEFAULT_RELAY_URL,
    proxyUrl: p?.proxyUrl ?? ''
  }
}

function writeRelayPref(patch: { relay?: boolean; relayUrl?: string; proxyUrl?: string }) {
  const st = getStoreRef()
  if (!st) return
  const cfg = st.getConfig()
  const cur = { enabled: false, port: 8748, token: '', ...cfg.prefs.mobileService }
  st.setPrefs({ ...cfg.prefs, mobileService: { ...cur, ...patch } })
}

function publicUrlFrom(relayUrl: string, token: string): string {
  // wss→https、ws→http：公网段 TLS 由网关侧反代/CF 终结；
  // 自架网关没配 TLS（ws://IP:端口）时手机走 http 明文——不然二维码用 https 打不开
  const httpUrl = relayUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/+$/, '')
  return `${httpUrl}/?t=${token}`
}

function status(): RelayStatus {
  const p = readPref()
  return {
    enabled: p.relay,
    connected: !!sock && sock.alive && helloOk,
    publicUrl: p.relay && p.token ? publicUrlFrom(p.relayUrl, p.token) : undefined,
    relayUrl: p.relayUrl,
    channel: curChannel || undefined,
    proxyUrl: p.proxyUrl || undefined,
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

// ---------- 连通性诊断（用户自助排查：到底死在哪一步） ----------

/** 直连 TLS 探测（不认证证书内容，只看握手能否完成——校园网阻断的典型表现是 ECONNRESET） */
function probeTlsDirect(host: string, port: number, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    let done = false
    const s = tls.connect({ host, port, servername: host })
    const fin = (v: string) => {
      if (done) return
      done = true
      try { s.destroy() } catch { /* noop */ }
      resolve(v)
    }
    const timer = setTimeout(() => fin('超时'), timeoutMs)
    s.on('secureConnect', () => { clearTimeout(timer); fin('ok') })
    s.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); fin(e.code ?? e.message ?? 'TLS 失败') })
  })
}

export interface RelayDiag {
  relayUrl: string
  gatewayHost: string
  /** 运行态：当前通道 / 是否已连上 / 最近错误 */
  connected: boolean
  channel: string
  error?: string
  /** 到网关的直连探测 */
  direct: { tcp: boolean; tls: string }
  /** 检测到的代理配置及其存活性 / 经其到网关的实测结果 */
  proxies: { addr: string; source: string; alive: boolean; via?: string }[]
  /** 人话结论 */
  hint: string
}

export async function diagnoseRelay(): Promise<RelayDiag> {
  const p = readPref()
  const host = safeHost(p.relayUrl)
  let port = 443
  try { port = Number(new URL(p.relayUrl).port) || (p.relayUrl.startsWith('wss') ? 443 : 80) } catch { /* 保持 443 */ }

  const tcp = host ? await probeTcp(host, port, 2500) : false
  const tlsRes = tcp ? await probeTlsDirect(host, port) : '未测试（TCP 不通）'

  const proxies: RelayDiag['proxies'] = []
  for (const c of await collectProxies()) {
    const alive = await probeTcp(c.host, c.port, 1200)
    proxies.push({ addr: `${c.host}:${c.port}`, source: c.source, alive, via: alive ? await probeThroughProxy(c, host, port) : undefined })
  }
  // 配置里没有可用代理时，把"自动扫端口"的结果也摆出来（用户能知道系统里到底有没有能干活的代理）
  scanAt = 0 // 诊断要的是当下事实，不吃缓存
  const scanned = await scanCommonProxies()
  if (scanned && !proxies.some((x) => x.addr === `${scanned.host}:${scanned.port}`)) {
    proxies.push({ addr: `${scanned.host}:${scanned.port}`, source: 'scan', alive: true, via: 'ok' })
  }

  const liveProxyOk = proxies.some((x) => x.via === 'ok')
  const anyAlive = proxies.some((x) => x.alive)
  let hint: string
  if (tlsRes === 'ok') hint = '到网关直连可用，中继应能连上；若开关仍显示失败，试重点一次中继开关'
  else if (liveProxyOk) hint = `直连被阻断（${tlsRes}），但代理可用——保持代理软件开启且已连接节点即可连上中继`
  else if (anyAlive) hint = '代理端口活着但经它到网关不通：代理软件可能没连上节点，或分流规则没代理这个域名'
  else if (proxies.length) hint = `检测到代理配置（${proxies.map((x) => x.addr).join('、')}）但端口没有监听；已顺手扫过常见代理端口也没找到能用的——代理软件的核心服务没起来（只开了界面窗口），或它没把自己设为系统代理`
  else if (!tcp) hint = '到网关的 TCP 直连都不通，且没检测到任何代理：先确认本机网络能正常上网'
  else hint = `直连被阻断（${tlsRes}）且没有可用代理——本机网络到 Cloudflare 被封，必须开一个能用的代理`

  return {
    relayUrl: p.relayUrl,
    gatewayHost: host,
    connected: !!sock && sock.alive && helloOk,
    channel: curChannel,
    error: curError,
    direct: { tcp, tls: tlsRes },
    proxies,
    hint
  }
}

// ---------- 连接生命周期 ----------

async function connect(attempt = 0) {
  const p = readPref()
  if (!p.enabled || !p.relay || sock) return
  if (!p.token) { curError = '手机端服务尚未生成 token（先开关一次服务）'; push(); return }
  closedByUs = false
  curError = undefined
  push()

  // 出站通道（2026-10-26 用户拍板"固定走代理不轮换" + 代理失效回退）：
  //   检测到**活着**的代理（手动 > env > 系统代理）→ 走代理 wss
  //   无代理 / 代理端口没人监听 / 代理刚失败过（冷却 60s）→ 直连 wss（网关侧 CF 终结 TLS，443）
  // 为什么必须回退：Windows 系统代理注册表常在代理软件退出后残留（ProxyEnable=1 但端口无监听），
  // 或代理软件只有界面进程、核心服务没起来——此时照配置 CONNECT 会立刻被拒，
  // 若死守代理通道，中继就会永久卡在"无法连接"（2026-10-26 实测：SakuraCat core-service 未运行）。
  // 例外：回环/内网网关（verify 的 127.0.0.1、用户自建局域网网关）一律直连——
  // 代理对私有地址通常拒绝 CONNECT（no_proxy 语义，与浏览器一致）
  const proxy = await detectProxy()
  const gwHost = safeHost(p.relayUrl)
  const proxyUsable = !!proxy && !isPrivateHost(gwHost) && Date.now() >= proxyDeadUntil
  const pick: { url: string; proxy?: ProxyConf } = proxyUsable ? { url: p.relayUrl, proxy } : { url: p.relayUrl }
  curChannel = pick.proxy
    ? `代理 ${pick.proxy.host}:${pick.proxy.port}${pick.proxy.source === 'scan' ? '（自动发现）' : ''}`
    : '直连'

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
  let roundHelloOk = false
  client.onopen = () => { client.sendText(JSON.stringify({ type: 'hello', token: p.token, ua: 'agenthub' })) }
  client.onmessage = (raw) => {
    let msg: { type?: string; id?: string; [k: string]: unknown }
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'hello-ok') {
      helloOk = true
      roundHelloOk = true
      reconnectAttempt = 0
      curError = undefined
      proxyDeadUntil = 0 // 代理通道通了：清掉冷却，后续重连继续用它
      proxyDeadReason = ''
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
    const detail = client.failReason || '连接中断'
    // 代理通道在握手成功前就断了：判定代理不可用，冷却期内改走直连（不无限重试死代理）
    if (pick.proxy && !roundHelloOk) {
      proxyDeadUntil = Date.now() + PROXY_DEAD_MS
      proxyDeadReason = detail
      curError = `无法连接中继网关（经代理 ${pick.proxy.host}:${pick.proxy.port} 失败：${detail}）——已临时改用直连重试；请确认代理软件已连接节点（不只是打开窗口）`
    } else if (pick.proxy) {
      curError = `中继连接已断开（代理通道：${detail}），正在重连`
    } else {
      const proxyNote = proxyDeadReason ? `；检测到代理 ${proxy?.host}:${proxy?.port} 但不可用（${proxyDeadReason}）` : ''
      curError = `无法连接中继网关（直连失败：${detail}${proxyNote}）——本机网络多半对 Cloudflare 有阻断，请开启代理软件并确保其核心服务在运行`
    }
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
  // 服务刚开：给代理一次机会（用户可能刚把代理软件修好）
  proxyDeadUntil = 0
  proxyDeadReason = ''
  if (readPref().relay) void connect()
}

export function initMobileRelay(opts: { getStore: () => Store; getWin: () => BrowserWindow | null }) {
  getStoreRef = opts.getStore
  getWinRef = opts.getWin

  ipcMain.handle('mobile:relayStatus', () => status())
  ipcMain.handle('mobile:relayDiag', () => diagnoseRelay())
  /**
   * 自建网关地址（wss://域名 或 ws://IP:端口；空串=回官方网关）。
   * 存了立即生效（断开重连），不必重启应用。校园网等对 Cloudflare 阻断的环境，
   * 自架一台 VPS 网关（relay/server.mjs）是官方中继之外最稳的路。
   */
  ipcMain.handle('mobile:setRelayUrl', (_e, raw: string) => {
    const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
    if (trimmed) {
      const v = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`
      let parsed: URL
      try {
        parsed = new URL(v)
      } catch {
        return { ok: false, message: '网关地址格式不对，示例：wss://relay.example.com 或 ws://1.2.3.4:8090' }
      }
      if (!/^wss?:$/.test(parsed.protocol) || !parsed.hostname) {
        return { ok: false, message: '网关地址要以 wss:// 或 ws:// 开头，示例：wss://relay.example.com' }
      }
      writeRelayPref({ relayUrl: v })
    } else {
      writeRelayPref({ relayUrl: '' }) // 回官方网关
    }
    // 地址变了：清代理冷却并重连
    proxyDeadUntil = 0
    proxyDeadReason = ''
    reconnectAttempt = 0
    if (readPref().enabled && readPref().relay) {
      const cur = sock
      sock = null
      if (cur) { closedByUs = true; try { cur.close() } catch { /* noop */ } }
      void connect()
    }
    return { ok: true, relayUrl: readPref().relayUrl }
  })
  /**
   * 手动指定出站代理（http://host:port；也接受裸 host:port）。
   * 空串 = 清空回自动检测。存了立即生效（清冷却 + 重连），不必重启应用。
   */
  ipcMain.handle('mobile:setProxyUrl', (_e, raw: string) => {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (trimmed) {
      const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
      if (!parseProxyUrl(normalized, 'manual')) return { ok: false, message: '代理地址格式不对，示例：http://127.0.0.1:7890' }
      writeRelayPref({ proxyUrl: normalized })
    } else {
      writeRelayPref({ proxyUrl: '' })
    }
    proxyDeadUntil = 0
    proxyDeadReason = ''
    reconnectAttempt = 0
    if (readPref().enabled && readPref().relay) {
      const cur = sock
      sock = null
      if (cur) { closedByUs = true; try { cur.close() } catch { /* noop */ } }
      void connect()
    }
    return { ok: true, proxyUrl: readPref().proxyUrl }
  })
  ipcMain.handle('mobile:setRelayEnabled', (_e, on: boolean) => {
    if (typeof on !== 'boolean') return { ok: false, ...status(), error: '参数必须是布尔值' }
    writeRelayPref({ relay: on })
    if (!readPref().enabled) {
      // 服务本体没开：意图已记住，不连接（公网入口跟随服务）
      return { ok: true, ...status(), error: status().error ?? '请先开启手机端访问' }
    }
    // 用户刚动过开关：代理冷却清零，立即按「代理优先」重试一次（可能刚把代理修好）
    if (on) { reconnectAttempt = 0; proxyDeadUntil = 0; proxyDeadReason = ''; void connect() } else disconnect()
    return { ok: true, ...status() }
  })

  // 随应用启动恢复：服务开 + relay 开 → 出站连接（延后 1.5s 避开启动高峰；网络慢时后台自动重连）
  if (readPref().enabled && readPref().relay) setTimeout(() => { void connect() }, 1500)
}
