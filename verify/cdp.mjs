// 共用：最小 CDP 客户端 + 启动/等待工具（verify/ 下的脚本复用）
import http from 'node:http'
import crypto from 'node:crypto'

export class CdpClient {
  constructor(wsUrl) { this.wsUrl = new URL(wsUrl); this.pending = new Map(); this.msgId = 0; this.buf = Buffer.alloc(0) }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64')
      const req = http.get({
        hostname: this.wsUrl.hostname, port: this.wsUrl.port, path: this.wsUrl.pathname,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      })
      req.on('upgrade', (_r, socket) => {
        this.socket = socket
        socket.on('data', (d) => this._onData(d))
        socket.on('error', (e) => { if (e.code !== 'ECONNRESET') console.error('[socket]', e.message) })
        res()
      })
      req.on('response', (r) => rej(new Error('handshake failed: ' + r.statusCode)))
      req.on('error', rej)
      setTimeout(() => rej(new Error('handshake timeout')), 8000)
    })
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      if (this.buf.length < 2) return
      const len0 = this.buf[1] & 0x7f
      let offset = 2, len = len0
      if (len0 === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4 }
      else if (len0 === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10 }
      if (this.buf.length < offset + len) return
      const opcode = this.buf[0] & 0x0f
      const payload = this.buf.subarray(offset, offset + len)
      this.buf = this.buf.subarray(offset + len)
      if (opcode === 1) { try { this._onMessage(JSON.parse(payload.toString('utf8'))) } catch { /* ignore */ } }
      else if (opcode === 8) { try { this.socket.end() } catch { /* noop */ } }
    }
  }
  _send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8')
    const mask = crypto.randomBytes(4)
    let header
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length])
    else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2) }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2) }
    const masked = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }
  _onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  send(method, params = {}) {
    return new Promise((resolve_, reject) => {
      const id = ++this.msgId
      this.pending.set(id, { resolve: resolve_, reject })
      this._send({ id, method, params })
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)) } }, 60000)
    })
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 启动便携版用的环境：必须清掉 ELECTRON_RUN_AS_NODE。
 * 从 Electron 应用（如 DSH 桌面版）派生的终端里，该变量会传给子进程，
 * 导致 AgentHub.exe 以 node 模式启动并报 "bad option: --remote-debugging-port"。
 */
export function launchEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

export function waitHttp(port, timeoutMs) {
  const t0 = Date.now()
  return new Promise((res, rej) => {
    const tick = () => {
      http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let body = ''
        r.on('data', (d) => (body += d))
        r.on('end', () => {
          try {
            const page = JSON.parse(body).find((t) => t.type === 'page')
            if (page) return res(page)
          } catch { /* not ready */ }
          retry()
        })
      }).on('error', retry)
    }
    const retry = () => (Date.now() - t0 > timeoutMs ? rej(new Error('devtools not ready')) : setTimeout(tick, 400))
    tick()
  })
}

export async function js(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}

export async function waitJs(cdp, expr, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await js(cdp, expr); if (v) return v } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(500)
  }
}
