// 本地 E2E（CDP 驱动便携版）：多会话 / 更新检查与开机自启入口 / 演示对话核心链路
// 用法：node tests/e2e/local.mjs [--exe=d:\AgentHub\AgentHub.exe] [--port=9223]
// 前置：先构建并同步便携版（npm run build && npm run pack:portable 后同步），应用未在运行。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const EXE = resolve(args.exe ?? 'd:/AgentHub/AgentHub.exe')
const PORT = Number(args.port ?? 9223)

/* ---------- 最小 CDP 客户端（raw WebSocket over http.upgrade） ---------- */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl)
    this.pending = new Map()
    this.msgId = 0
    this.buf = Buffer.alloc(0)
  }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64')
      const req = http.get({
        hostname: this.wsUrl.hostname, port: this.wsUrl.port, path: this.wsUrl.pathname,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      })
      req.on('upgrade', (_res, socket) => {
        this.socket = socket
        socket.on('data', (d) => this._onData(d))
        socket.on('error', (e) => console.error('[socket error]', e.message))
        res()
      })
      req.on('response', (res) => rej(new Error('handshake failed: ' + res.statusCode)))
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
      if (opcode === 1) {
        try { this._onMessage(JSON.parse(payload.toString('utf8'))) } catch { /* ignore */ }
      } else if (opcode === 8) {
        try { this.socket.end() } catch { /* noop */ }
      }
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
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  send(method, params = {}) {
    return new Promise((resolve_, reject) => {
      const id = ++this.msgId
      this.pending.set(id, { resolve: resolve_, reject })
      this._send({ id, method, params })
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)) } }, 20000)
    })
  }
}

/* ---------- 断言与流程 ---------- */
let passed = 0, failed = 0
const fail = (name, detail) => { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
const ok = (name) => { passed++; console.log(`  ✓ ${name}`) }
const eq = (name, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(name) : fail(name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
const truthy = (name, v, detail) => (v ? ok(name) : fail(name, detail ?? `got ${JSON.stringify(v)}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitJs(cdp, expr, timeoutMs = 15000, interval = 300) {
  const t0 = Date.now()
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.value) return r.result.value
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(interval)
  }
}

/** 页面内执行（返回值经 JSON 往返） */
async function js(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page js error: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
  return r.result?.value
}

/** React 受控输入注入（原型 setter + input 事件） */
async function typeInto(cdp, sel, text) {
  return js(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`[e2e] 未找到便携版：${EXE}（先 npm run build && npm run pack:portable 并同步）`)
    process.exit(2)
  }
  // 从 Electron 应用派生的终端里，ELECTRON_RUN_AS_NODE 会被继承，导致被驱动的 exe
  // 以 node 模式启动并报 "bad option: --remote-debugging-port"，因此启动前必须清掉
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: false, env })
  let cdp
  try {
    // 等 DevTools 端点
    const target = await waitHttp(PORT, 20000)
    cdp = new CdpClient(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // ---- 启动序列：欢迎页 -> 开始（品牌页）-> 工作站 ----
    // 开屏动画期间 React 已挂载但 hooks 安装有延迟：等待式而非立即断言
    truthy('启动后 debug hooks 可用', await waitJs(cdp, '!!window.__ahub_debug', 20000, 500))
    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(600)
    await js(cdp, 'window.__ahub_debug.workbench()')
    truthy('进入工作站', await waitJs(cdp, 'window.__ahub_debug.state().screen === "workbench"'))

    // 选一个演示 Agent（本地历史数据可能无演示 Agent：缺失时经 debug hook 补种一个）
    const st0 = await js(cdp, 'window.__ahub_debug.state()')
    let demo = st0.agents.find((a) => a.kind === 'demo')
    if (!demo) {
      await js(cdp, 'window.__ahub_debug.addDemoAgents(1)')
      await sleep(800)
      const st0b = await js(cdp, 'window.__ahub_debug.state()')
      demo = st0b.agents.find((a) => a.kind === 'demo')
    }
    truthy('存在演示 Agent（缺失时自动补种）', !!demo)
    await js(cdp, `(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(demo.name)})); if (el) { el.click(); return true } return false })()`)
    await sleep(600)
    const stSel = await js(cdp, 'window.__ahub_debug.state()')
    truthy('选中演示 Agent', stSel.selectedId === demo.id)
    const K = demo.id // 会话断言统一用该 agent 的 key

    // ---- 用例 1：演示对话（发送 -> 流式回复 -> 演示标注）----
    const ta = '.wb-composer-wrap textarea, .composer textarea'
    /** 点击发送（等待 React 状态同步按钮启用后再点；精确匹配 Composer 的"发送"按钮，排除欢迎面板示例按钮） */
    const SEND_SEL = `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发送' && !b.disabled); if (!b) return false; b.click(); return true })()`
    const clickSend = async () => {
      await sleep(350)
      return js(cdp, SEND_SEL)
    }
    /** 打开会话面板（幂等：已开则不重复点击，避免 toggle 残留） */
    const openPanel = async () => {
      if (!(await js(cdp, '!!document.querySelector(".ses-panel")'))) {
        await js(cdp, `(() => { const chip = [...document.querySelectorAll('.model-chip')][0]; chip.click(); return true })()`)
        await sleep(300)
      }
      return js(cdp, '!!document.querySelector(".ses-panel")')
    }
    truthy('输入框存在', await js(cdp, `!!document.querySelector(${JSON.stringify(ta)})`))
    truthy('注入输入', await typeInto(cdp, ta, '你好，这是一条 E2E 验证消息'))
    const btn = await js(cdp, `(() => { const bs = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '发送'); return bs.length })()`)
    truthy('发送按钮可用', btn >= 1, '发送按钮数 ' + btn)
    truthy('点击发送', await clickSend())
    // 消息数 >=2 且流式已结束（streaming 消息已入列即可使 counts>=2，须另等流收尾，
    // 否则后续新建/切换会话被"回复进行中"保护拒绝）
    const replyDone = await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); const k = ${JSON.stringify(K)}; return s.sessions[k] && s.sessions[k].counts[0] >= 2 && s.streamKeys.length === 0 })()`, 15000)
    if (!replyDone) {
      const dbg = await js(cdp, 'window.__ahub_debug.state()')
      console.log('  [diag] 用例1失败时状态:', JSON.stringify({ sel: dbg.selectedId, K, ses: dbg.sessions[K], streams: dbg.streamKeys }))
    }
    truthy('演示回复完成（消息数 >= 2 且流结束）', !!replyDone)

    // ---- 用例 2：多会话（新建 -> 独立 -> 自动命名 -> 切换恢复 -> 重命名 -> 删除）----
    truthy('打开会话面板', await openPanel())
    const before = await js(cdp, 'window.__ahub_debug.state()')
    const k0 = K
    await js(cdp, `(() => { const b = document.querySelector('.ses-new'); b.click(); return true })()`)
    await sleep(300)
    const st1 = await js(cdp, 'window.__ahub_debug.state()')
    eq('新建后会话数 +1', st1.sessions[k0].count, before.sessions[k0].count + 1)
    eq('新会话为活跃', st1.sessions[k0].titles[0], '新会话')
    eq('新会话消息数为 0', st1.sessions[k0].counts[0], 0)

    // 在新会话发送一条（自动命名），等流结束
    await typeInto(cdp, ta, '第二条：验证自动命名')
    truthy('新会话点击发送', await clickSend())
    await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); const k = ${JSON.stringify(K)}; return s.sessions[k].counts[0] >= 2 && s.streamKeys.length === 0 })()`, 15000)
    const st2 = await js(cdp, 'window.__ahub_debug.state()')
    truthy('首条消息后自动命名', st2.sessions[k0].titles[0] !== '新会话', `title=${st2.sessions[k0].titles[0]}`)

    // 切回旧会话（面板点第二项：用例 1 的会话）
    truthy('切换前打开面板', await openPanel())
    const preSwitchId = st2.sessions[k0].activeId
    await js(cdp, `(() => { const items = [...document.querySelectorAll('.ses-item')]; items[1].click(); return true })()`)
    await sleep(300)
    const st3 = await js(cdp, 'window.__ahub_debug.state()')
    truthy('切换后活跃会话改变', st3.sessions[k0].activeId !== preSwitchId, `activeId 未变化: ${st3.sessions[k0].activeId}`)
    eq('切换后旧会话消息数恢复（>= 2）', st3.sessions[k0].counts[0] >= 2, true)

    // 重命名（编辑 input）
    truthy('重命名前打开面板', await openPanel())
    await js(cdp, `(() => { [...document.querySelectorAll('.ses-act')].find(b => b.title === '重命名').click(); return true })()`)
    await sleep(200)
    truthy('重命名输入框出现', await js(cdp, '!!document.querySelector(".ses-edit")'))
    await typeInto(cdp, '.ses-edit', 'E2E 重命名验证')
    await js(cdp, `(() => { const i = document.querySelector('.ses-edit'); const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }); i.dispatchEvent(ev); return true })()`)
    await sleep(300)
    const st4 = await js(cdp, 'window.__ahub_debug.state()')
    truthy('重命名生效', st4.sessions[k0].titles.includes('E2E 重命名验证'), JSON.stringify(st4.sessions[k0].titles))

    // 删除当前活跃会话（列表第一项是活跃项）
    const cntBefore = st4.sessions[k0].count
    truthy('删除前打开面板', await openPanel())
    await js(cdp, `(() => { const b = [...document.querySelectorAll('.ses-act.danger')][0]; if (!b) return false; b.click(); return true })()`)
    await sleep(300)
    const st5 = await js(cdp, 'window.__ahub_debug.state()')
    eq('删除后会话数 -1', st5.sessions[k0].count, cntBefore - 1)

    // ---- 用例 3：设置-关于区（检查更新 / 开机自启入口）----
    await js(cdp, `(() => { window.__ahub_debug.settings(); return true })()`)
    await sleep(400)
    await js(cdp, `(() => { [...document.querySelectorAll('.settings-nav .nav-item')].find(b => b.textContent.includes('关于')).click(); return true })()`)
    await sleep(300)
    truthy('检查更新按钮存在', await js(cdp, `!![...document.querySelectorAll('.settings-main button')].find(b => b.textContent.includes('检查更新'))`))
    truthy('开机自启开关存在', await js(cdp, `!![...document.querySelectorAll('.set-row')].find(r => r.textContent.includes('开机自启'))`))

    // ---- 汇总 ----
    console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
    process.exitCode = failed > 0 ? 1 : 0
  } catch (e) {
    console.error('[e2e] 异常：', e.message)
    process.exitCode = 1
  } finally {
    try { proc.kill() } catch { /* noop */ }
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  }
}

async function waitHttp(port, timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    try {
      const body = await new Promise((res, rej) => {
        http.get(`http://127.0.0.1:${port}/json/list`, (r) => {
          let d = ''
          r.on('data', (c) => (d += c))
          r.on('end', () => res(d))
        }).on('error', rej)
      })
      const pages = JSON.parse(body).filter((t) => t.type === 'page')
      if (pages.length > 0) return pages[0]
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('DevTools 端点等待超时')
    await sleep(400)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
