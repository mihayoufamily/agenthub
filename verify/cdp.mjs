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
  // NODE_OPTIONS 是宿主会话注入的 shim require（打包应用不支持且与主进程启动竞态），一律剥离
  delete env.NODE_OPTIONS
  // 代理变量同理剥离：宿主会话的代理指向本机随机端口（多半已失效），会让中继/网络类测试踩空
  delete env.HTTPS_PROXY
  delete env.https_proxy
  delete env.HTTP_PROXY
  delete env.http_proxy
  return env
}

export function waitHttp(port, timeoutMs) {
  const t0 = Date.now()
  return new Promise((res, rej) => {
    const tick = () => {
      const rq = http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, (r) => {
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

// 渲染进程在导航/重载中间会销毁执行上下文，此时 evaluate 的 Promise 被回收，
// CDP 抛 "Promise was collected"。这不是产品缺陷也不是断言失败，重试即可
// （ui-shot 曾偶发撞上：7 次跑里 2 次，且每次都会把整套件截断、把后面两轮带歪）。
const TRANSIENT_EVAL = /Promise was collected|Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed/i

export async function js(cdp, expr) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) {
        const text = JSON.stringify(r.exceptionDetails)
        if (attempt < 5 && TRANSIENT_EVAL.test(text)) { await sleep(300); continue }
        throw new Error('page error: ' + text.slice(0, 300))
      }
      return r.result?.value
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (attempt < 5 && TRANSIENT_EVAL.test(msg)) { await sleep(300); continue }
      throw e
    }
  }
}

export async function waitJs(cdp, expr, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await js(cdp, expr); if (v) return v } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(500)
  }
}

/**
 * 把工作流视图从"已打开的任务"切回首页，返回 { prev }（之前打开的任务 id）。
 * 为什么需要：应用一启动会恢复上次打开的任务，那时首页 composer 根本不在 DOM 里，
 * 首页布局/配置条断言于是量到 null 而报红——量的不是产品，是套件假设了"没有已打开的任务"。
 * 只切视图，不动 runs/ 落盘记录；套件收尾用 restoreWfHome 把视图还给用户。
 */
export async function ensureWfHome(cdp) {
  const r = await js(cdp, 'window.__ahub_debug.closeTask()')
  await sleep(900)
  return { prev: String(r?.prev ?? ''), now: String(r?.now ?? '') }
}

/** 还回原视图：之前没有打开的任务就保持首页 */
export async function restoreWfHome(cdp, prevId) {
  if (!prevId) return
  try {
    await js(cdp, `window.__ahub_debug.openWfTask(${JSON.stringify(prevId)})`)
    await sleep(600)
  } catch { /* 页面已关就算了：任务记录本身没动，用户下次从列表点进去即可 */ }
}

/** 等渲染层 store 水合完成（agents 载入前 state() 会返回空表，套件别把"没水合"读成"没装 Agent"） */
export async function waitHydrated(cdp, timeoutMs = 20000) {
  const ok = await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); return (s.agents || []).length > 0 })()`, timeoutMs)
  return ok ? await js(cdp, 'window.__ahub_debug.state()') : null
}
