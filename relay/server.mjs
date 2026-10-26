#!/usr/bin/env node
// AgentHub 中继网关（2026-10-26）：让所有下载者**零配置**获得公网访问。
// 原理：下载者的 AgentHub 主动出站连 WebSocket（免端口/免防火墙/免域名），按配对 token 注册；
//       手机请求带 token 到网关，网关按 token 找到对应实例的连接，把 HTTP 请求打包转发过去，
//       由 AgentHub 本地 fetch 自己的 8748 服务（复用全部既有鉴权/裁剪/写校验）再原路返回。
//
// 职责边界（重要）：
//  - 网关是**哑管道**：不解析业务、不落盘、不缓存，只按 token 路由字节
//  - 每个 token 只能看到自己的 AgentHub；同 token 后连者踢前者
//  - 隐私提示（如实写进 README）：HTTPS 覆盖公网段，但网关进程内存里能观察到转发内容——
//    自架网关 = 自担信任。端到端加密（token 派生密钥）是协议预留的二期项
//
// 零依赖：WS 服务器为 RFC6455 最小子集自实现（text/close/ping/pong，客户端帧必 mask），
// 部署只需 node >= 18：node server.mjs [--port 8090]
import http from 'node:http'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2]?.match(/^--port=(\d+)$/)?.[1] ?? process.env.RELAY_PORT ?? 8090)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 512 * 1024 // 单包上限：请求/响应 JSON 都远小于此

/** token → 连接（同 token 后连踢前连） */
const routes = new Map()
/** 请求 id → 挂起的手机响应回调（网关侧等待 AgentHub 回包） */
const pending = new Map()

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------- RFC6455 最小实现 ----------

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 解析客户端帧（必 mask）。返回 {opcode, payload, consumed} 或 null（数据不全）；坏帧抛错 */
function decodeFrame(buf) {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  if (len > MAX_PAYLOAD) throw new Error('frame too large')
  if (!masked) throw new Error('client frame must be masked')
  const mask = buf.subarray(off, off + 4); off += 4
  if (buf.length < off + len) return null
  const data = Buffer.from(buf.subarray(off, off + len))
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
  if (!fin) throw new Error('fragmented frames not supported') // 协议保证单帧 JSON，不处理分片
  return { opcode, payload: data, consumed: off + len }
}

function encodeFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) { head = Buffer.from([0x80 | opcode, len]) }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([head, payload])
}

class WsConn {
  constructor(socket) {
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.alive = true
    this.onmessage = null
    this.onclose = null
    socket.on('data', (d) => this.#feed(d))
    socket.on('error', () => this.#dead())
    socket.on('close', () => this.#dead())
    // 心跳：30s 无 pong 判死
    this.pingTimer = setInterval(() => {
      if (!this.alive) return
      if (this.awaitingPong) { this.#dead(); return }
      this.awaitingPong = true
      this.#send(0x9, Buffer.alloc(0))
    }, 30000)
  }
  #feed(d) {
    this.buf = Buffer.concat([this.buf, d])
    let off = 0
    for (;;) {
      let frame
      try { frame = decodeFrame(this.buf.subarray(off)) } catch { this.#dead(); return }
      if (!frame) break
      off += frame.consumed
      if (frame.opcode === 0x1) this.onmessage?.(frame.payload.toString('utf8'))
      else if (frame.opcode === 0x9) this.#send(0xA, frame.payload) // ping → pong
      else if (frame.opcode === 0xA) this.awaitingPong = false
      else if (frame.opcode === 0x8) { this.#dead(); return }
    }
    this.buf = off > 0 ? this.buf.subarray(off) : this.buf
  }
  #send(opcode, payload) {
    if (!this.alive) return
    try { this.socket.write(encodeFrame(opcode, payload)) } catch { this.#dead() }
  }
  sendText(s) { this.#send(0x1, Buffer.from(s, 'utf8')) }
  close() { this.#send(0x8, Buffer.alloc(0)); this.#dead() }
  #dead() {
    if (!this.alive) return
    this.alive = false
    clearInterval(this.pingTimer)
    try { this.socket.destroy() } catch { /* noop */ }
    this.onclose?.()
  }
}

// ---------- HTTP + 升级 ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gw')
  // 网关自身页面：/relay-info 给运维看健康状态；其余一律尝试按 token 转发
  if (url.pathname === '/relay-info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, online: routes.size, tokens: [...routes.keys()].map((t) => t.slice(0, 6) + '…'), ts: Date.now() }))
    return
  }
  void handlePhone(req, res, url)
})

/** 手机/页面请求 → 按 t 找实例 → 转发 → 回包 */
async function handlePhone(req, res, url) {
  const t = url.searchParams.get('t') ?? ''
  const conn = t && routes.get(t)
  if (!conn || !conn.ws.alive) {
    // 没有可用实例：可读引导页（与 AgentHub 401 页同口径的提示语）。
    // 502 自动重试：桌面端心跳恢复后手机几秒内自动进入；上限 40 次（约 2 分钟）后停，防真离线时无限刷。
    const retry = t ? '<script>try{var n=(+sessionStorage.ahR||0)+1;sessionStorage.ahR=n;if(n<40){setTimeout(function(){location.reload()},3000)}else{var h=document.querySelector(".hint");if(h)h.textContent="桌面端仍未上线：请到电脑端 AgentHub「手机查看」确认服务与中继开关都开着（或点「检测连通性」看原因）"}}catch(e){setTimeout(function(){location.reload()},3000)}</script>' : ''
    res.writeHead(t ? 502 : 401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>📡 ' + (t ? '桌面端不在线' : '缺少配对凭据') + '</p><p class="hint" style="opacity:.6;font-size:14px">请打开电脑端 AgentHub「手机查看」，确认服务与中继已开启后重新扫码</p></div>' + retry + '</body>')
    return
  }
  const id = crypto.randomBytes(8).toString('hex')
  const reqPack = {
    type: 'req', id,
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: { 'content-type': req.headers['content-type'] ?? '' },
    body: null
  }
  if (req.method === 'POST') {
    const chunks = []
    let size = 0
    for await (const c of req) { size += c.length; if (size > 256 * 1024) { res.writeHead(413); res.end('too large'); return } chunks.push(c) }
    reqPack.body = Buffer.concat(chunks).toString('utf8')
  }
  const resp = await new Promise((resolve) => {
    pending.set(id, resolve)
    conn.ws.sendText(JSON.stringify(reqPack))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ status: 504, headers: {}, body: '{"ok":false,"message":"桌面端响应超时"}' }) } }, 20000)
  })
  const headers = { 'Content-Type': resp.headers?.['content-type'] ?? 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  res.writeHead(resp.status ?? 502, headers)
  res.end(resp.body ?? '')
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n')
  const conn = new WsConn(socket)
  let token = null
  conn.onmessage = (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'hello' && typeof msg.token === 'string' && /^[0-9a-f]{16,64}$/.test(msg.token)) {
      // 同 token 后连踢前连（重开应用/重连场景，最新连接为准）
      const prev = routes.get(msg.token)
      if (prev && prev !== conn) { try { prev.ws.close() } catch { /* noop */ } }
      token = msg.token
      routes.set(token, { ws: conn, ua: String(msg.ua ?? ''), connectedAt: Date.now() })
      log(`[relay] 实例上线 token=${token.slice(0, 6)}… 在线数=${routes.size}`)
      conn.sendText(JSON.stringify({ type: 'hello-ok' }))
      return
    }
    if (msg.type === 'resp' && msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve({ status: msg.status, headers: msg.headers, body: msg.body })
    }
  }
  conn.onclose = () => {
    if (token && routes.get(token)?.ws === conn) {
      routes.delete(token)
      log(`[relay] 实例离线 token=${token.slice(0, 6)}… 在线数=${routes.size}`)
    }
  }
})

server.listen(PORT, () => log(`[relay] 中继网关已启动 :${PORT}（WS / + HTTP 转发；健康检查 /relay-info）`))
