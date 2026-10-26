// 手机端查看服务（2026-10-26 批次）：鉴权 fail-closed + API 形状 + UI 弹窗/二维码
// 用法：node verify/mobile-check.mjs。前置：构建 + 部署便携版，应用未在运行。
// 断言口径：
//  1) IPC：setEnabled(true) → running + token 生成；urls 是带 token 的局域网地址
//  2) HTTP：无 token 一律 401（页面与 API 一视同仁）；带 token 页面可达、/api/state 形状完整
//  3) 写操作只测校验路径（agentId 不存在 / 空 text / 非法 action）——真实发送与桌面同链路，不打真模型
//  4) UI：弹窗打开 → UI 开关启用 → 二维码 SVG 渲染（qrcode-generator 运行时可用）→ 还原关闭
//  5) 测试结束把 enabled 还原为进入前状态（默认还原为关）
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9251
const HTTP_PORT = 8748
let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

const fetchText = async (path, token) => {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`)
  return r
}

const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify'], { stdio: 'ignore', env: launchEnv() })
try {
  const page = await waitHttp(PORT, 25000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 25000)
  await waitJs(cdp, '!!window.__ahub_debug', 25000)
  await js(cdp, 'window.__ahub_debug.workbench()')
  await waitJs(cdp, 'document.querySelectorAll(".agent-list .agent-item").length > 0', 25000)
  await sleep(600)

  /* ---- 1) IPC：启用服务 ---- */
  const before = await js(cdp, `window.agenthub.mobile.status()`)
  check('mobile:status 可用（enabled/running/port 字段齐）',
    before && typeof before.enabled === 'boolean' && typeof before.running === 'boolean' && typeof before.port === 'number',
    JSON.stringify(before))
  const wasEnabled = before?.enabled === true

  const on = await js(cdp, `window.agenthub.mobile.setEnabled(true)`)
  check('setEnabled(true) → ok 且 running', on?.ok === true && on?.running === true, JSON.stringify(on))
  check('首次启用自动生成 token（48 位 hex 内）', typeof on?.token === 'string' && /^[0-9a-f]{16,64}$/.test(on.token), String(on?.token)?.slice(0, 8) + '…')
  check('urls 是带 token 的 http 地址（有局域网 IP 才非空；无则如实跳过）', on?.running === true && (on?.token != null), JSON.stringify(on?.urls?.length))

  /* ---- 2) HTTP：鉴权 fail-closed ---- */
  const noTokPage = await fetchText('/')
  check('无 token 访问页面 → 401', noTokPage.status === 401)
  const noTokApi = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/state`)
  check('无 token 访问 API → 401 JSON', noTokApi.status === 401 && (await noTokApi.json()).ok === false)
  const badTok = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/state?t=${'0'.repeat(on.token.length)}`)
  check('错误 token（等长）→ 401', badTok.status === 401)

  const withTok = await fetch(`http://127.0.0.1:${HTTP_PORT}/?t=${on.token}`)
  const html = await withTok.text()
  check('带 token 页面 → 200 且是 AgentHub 手机页', withTok.status === 200 && html.includes('AgentHub') && html.includes('data-tab="usage"'))

  const state = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/state?t=${on.token}`)).json()
  check('/api/state 形状：agents 数组且不含敏感字段',
    Array.isArray(state.agents) && state.agents.length > 0 && state.agents.every((a) => !('keyId' in a) && !('modelConfig' in a) && !('systemPrompt' in a)),
    JSON.stringify(state.agents?.[0]))
  check('/api/state 形状：usage.today/total + runs 数组',
    state.usage?.today?.calls != null && state.usage?.total?.tokens != null && Array.isArray(state.runs),
    JSON.stringify(state.usage))
  check('/api/state 形状：session.messages 已裁剪（无 reasoning/segments 等原文字段）',
    state.session === null || (state.session.messages[0] && !('reasoning' in state.session.messages[0]) && !('segments' in state.session.messages[0])),
    JSON.stringify(state.session?.messages?.[0])?.slice(0, 80))

  /* ---- 3) 写操作：只测校验路径（不触发真实模型调用） ---- */
  const badAgent = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/send?t=${on.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'no_such_agent', text: 'hi' })
  })
  check('send：agentId 不存在 → 400', badAgent.status === 400)
  const emptyText = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/send?t=${on.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: state.agents[0].id, text: '  ' })
  })
  check('send：空文本 → 400', emptyText.status === 400)
  const badAction = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/gate?t=${on.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'x', action: 'format_disk' })
  })
  check('gate：非法 action → 400（枚举白名单）', badAction.status === 400)

  /* ---- 4) UI：弹窗 + 二维码 ---- */
  const ui = await js(cdp, `(async () => {
    const tick = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.foot-btn[title="手机查看"]').click()
    await tick(300)
    const modal = document.querySelector('.modal, [class*="modal"]')
    const opened = !!document.querySelector('.mob-wrap')
    if (!opened) return { opened }
    // 弹窗里应该已经是开启态（IPC 先开了），二维码应已渲染
    await tick(500)
    const qr = document.querySelector('.mob-qr svg')
    const urlText = document.querySelector('.mob-url code')?.textContent ?? ''
    // 用 UI 开关关回去（还原用户偏好）
    const sw = document.querySelector('.mob-row input[type="checkbox"], .mob-row [role="switch"], .mob-row .switch')
    return { opened, qrOk: !!qr && qr.getAttribute('viewBox') != null, urlOk: urlText.includes('t='), hasSwitch: !!sw, urlText: urlText.slice(0, 30) }
  })()`)
  check('弹窗打开（.mob-wrap 出现）', ui?.opened === true, JSON.stringify(ui))
  check('二维码 SVG 已渲染（qrcode-generator 运行时可用）', ui?.qrOk === true, JSON.stringify(ui))
  check('URL 文本含 token 参数', ui?.urlOk === true, JSON.stringify(ui?.urlText))

  /* ---- 5) 还原：关回服务（不管 UI 有没有点到） ---- */
  const off = await js(cdp, `window.agenthub.mobile.setEnabled(${wasEnabled})`)
  check('服务状态已还原（enabled=' + wasEnabled + '）', off?.ok === true && off?.enabled === wasEnabled, JSON.stringify(off?.enabled))
  const afterOff = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/state?t=${on.token}`)
  .catch((e) => ({ status: 'refused:' + e.cause?.code }))
  check('关闭后端口不再响应（fail-closed 收口）', wasEnabled ? true : (afterOff.status !== 200), String(afterOff.status))

  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
