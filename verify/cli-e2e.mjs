// 应用内验证：通过 CDP 驱动便携版，走真实 IPC 通道验证新增 CLI 适配器
// 用法：node verify/cli-e2e.mjs [--exe=d:\AgentHub\AgentHub.exe] [--port=9224]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const EXE = resolve(args.exe ?? 'd:/AgentHub/AgentHub.exe')
const PORT = Number(args.port ?? 9224)

class CdpClient {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 启动便携版用的环境：必须清掉 ELECTRON_RUN_AS_NODE。
 * 从 Electron 应用（如 DSH 桌面版）派生的终端里，该变量会传给子进程，
 * 导致 AgentHub.exe 以 node 模式启动并报 "bad option: --remote-debugging-port"。
 */
function launchEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}
let passed = 0, failed = 0
const ok = (n) => { passed++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { failed++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`) }

function waitHttp(port, timeoutMs) {
  const t0 = Date.now()
  return new Promise((res, rej) => {
    const tick = () => {
      http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let body = ''
        r.on('data', (d) => (body += d))
        r.on('end', () => {
          try {
            const list = JSON.parse(body)
            const page = list.find((t) => t.type === 'page')
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

async function js(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}

async function waitJs(cdp, expr, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await js(cdp, expr); if (v) return v } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(500)
  }
}

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--ahub-verify'], { stdio: 'ignore', env: launchEnv() })
  let cdp
  try {
    const page = await waitHttp(PORT, 25000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    console.log('\n[1] 应用启动与桥接')
    if (await waitJs(cdp, '!!window.agenthub && !!window.__ahub_debug')) ok('bridge + debug hooks 可用')
    else { bad('bridge + debug hooks 可用'); throw new Error('页面未就绪') }

    console.log('\n[2] agents:scan 通过真实 IPC（非 PATH 安装也应被发现）')
    const scan = await js(cdp, 'window.agenthub.agents.scan()')
    const names = (scan ?? []).map((x) => x.name)
    console.log('    scan =', JSON.stringify(scan))
    for (const n of ['arkcli', 'codex', 'codebuddy', 'dsh']) {
      if (names.includes(n)) ok(`扫描发现 ${n}`)
      else bad(`扫描发现 ${n}`, '未在结果中')
    }

    console.log('\n[3] cli:test 连接测试（真实解析 + --version）')
    for (const n of ['codex', 'codebuddy', 'dsh']) {
      const r = await js(cdp, `window.agenthub.cli.test(${JSON.stringify(n)})`)
      if (r?.ok) ok(`${n} 连接测试：${r.version ?? ''}`)
      else bad(`${n} 连接测试`, r?.message)
    }

    console.log('\n[4] cli:chat 事件通道（真实回复或明确错误，都必须到达渲染层）')
    // 模型取该 CLI Agent 在应用里已绑的那一个：留空等于让 codebuddy 用它自己的全局默认，
    // 而那个默认值在换 provider 后可能已经不可用——套件于是恒红，红的却不是被测的事件通道。
    const cbModel = await js(cdp, `(() => { const s = window.__ahub_debug.state(); const a = (s.agents || []).find((x) => x.kind === 'cli' && x.cliConfig && x.cliConfig.cli === 'codebuddy'); return (a && a.cliConfig.model) || '' })()`)
    const chatOpts = JSON.stringify(cbModel ? { model: cbModel } : {})
    console.log('    模型 =', cbModel || '(应用里该 Agent 没填模型，按现状传空)')
    const ev = await js(cdp, `(async () => {
      const reqId = 'e2e-' + Date.now()
      return await new Promise((resolve) => {
        let last = null
        const off = window.agenthub.models.onEvent((e) => {
          if (e.reqId !== reqId) return
          last = e
          if (e.type === 'done' || e.type === 'error') { off(); resolve(e) }
        })
        window.agenthub.cli.chat('codebuddy', ${chatOpts}, reqId, [{ role: 'user', content: '只回复两个字：好的' }]).then((r) => {
          if (r && r.ok === false) { off(); resolve({ type: 'startFailed', message: r.message }) }
        })
        setTimeout(() => { off(); resolve(last ?? { type: 'timeout' }) }, 60000)
      })
    })()`)
    console.log('    event =', JSON.stringify(ev).slice(0, 300))
    if (ev?.type === 'done') ok(`事件通道到达（真实回复已透出）`)
    else if (ev?.type === 'error' || ev?.type === 'startFailed') ok('事件通道到达（错误已如实透出）')
    else bad('事件通道到达', JSON.stringify(ev).slice(0, 120))

    console.log('\n[5] 无回归：演示 Agent 仍在')
    const st = await js(cdp, 'JSON.stringify(window.__ahub_debug.state())')
    const state = JSON.parse(st ?? '{}')
    if ((state.agents ?? []).length >= 1) ok(`既有 Agent 完好（${state.agents.length} 个）`)
    else bad('既有 Agent 完好', st?.slice(0, 120))
  } catch (e) {
    bad('执行中断', e.message)
  } finally {
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
  // 修复波 B · 项 1c 同类：本套件原来打的是「N 通过 / M 失败」，run-all 的 PASS_RE
  // （`结果：N PASS / M FAIL`）匹配不上 → 计数显示 `-/-`，只按退出码判。措辞对齐成同一口径，
  // 计数与判定逻辑一字未改（红还是红，只是现在看得见几条过几条败）。
  console.log(`\n==== 结果：${passed} PASS / ${failed} FAIL ====`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
