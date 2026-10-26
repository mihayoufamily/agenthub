// 中继网关全链路验证（2026-10-26）：
//   AgentHub(中继客户端,出站WS) → 本地网关(:18090) → 模拟手机请求(带token) → 响应回传
// 用法：node verify/relay-check.mjs。前置：构建 + 部署便携版，应用未在运行。
// 断言口径：
//  1) 网关健康：/relay-info 返回在线状态
//  2) relayStatus/setRelayEnabled IPC 形状 + 意图持久化
//  3) 出站连接：relay enabled → connected=true（Node 内置 WS 客户端连本地网关）
//  4) 公网全链路：curl http://127.0.0.1:18090/?t=<token> → 页面 200（含 AgentHub 标记）+ /api/state 200 且 agents 数组
//  5) 鉴权穿透：无 token → 401 引导页（网关口径）；错 token → 502 桌面端不在线（token 不存在路由）
//  6) 服务关 → 中继断开（connected=false）+ 网关路由清空（relay-info online 减一）
//  7) 还原：relay pref 回原值、服务回原状态
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9253
const GW_PORT = 18090
/** RELAY_CHECK_GW_URL：外部网关模式（如 wrangler dev 的 ws://127.0.0.1:8787）——不 spawn 本地网关，跳过 online 计数断言 */
const EXTERNAL_GW = process.env.RELAY_CHECK_GW_URL ?? null
let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

/** 等待 relay connected（轮询 IPC 状态） */
const waitRelay = async (cdp, want, timeoutMs) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await js(cdp, `window.agenthub.mobile.relayStatus()`)
    if (want(last)) return last
    await sleep(500)
  }
  return last
}

// 本地网关（独立进程，测完杀掉）。用 PATH 里的 'node' 而非 process.execPath——
// 宿主沙箱对 execPath 指向的 node 有执行限制（Permission denied），spawn error 必须监听
// 外部网关模式（RELAY_CHECK_GW_URL）下不 spawn
const gw = EXTERNAL_GW ? null : spawn('node', ['D:/dsh/agenthub/relay/server.mjs', `--port=${GW_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
if (gw) {
  gw.stdout?.on('data', (d) => console.log('[gw-out]', d.toString().trim().slice(0, 200)))
  gw.stderr?.on('data', (d) => console.log('[gw-err]', d.toString().trim().slice(0, 300)))
  gw.on('error', (e) => console.log('[gw-spawn-error]', e.message))
  gw.on('exit', (code) => console.log(`[gw-exit] code=${code}`))
}
const gwBase = (EXTERNAL_GW ?? `http://127.0.0.1:${GW_PORT}`).replace(/^ws/, 'http') // ws→http 供 fetch/relay-info 用

const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...launchEnv(), AGENTHUB_RELAY_URL_OVERRIDE: EXTERNAL_GW ?? `ws://127.0.0.1:${GW_PORT}` }
})
proc.stderr.on('data', (d) => console.log('[app-err]', d.toString().trim().slice(0, 300)))
proc.on('exit', (code) => console.log(`[app-exit] code=${code}`))
try {
  const t0 = Date.now()
  // 网关就绪：/relay-info 重试（waitHttp 是 CDP 专用口径 /json/list，对网关永远 401 HTML 不适用）
  let gwInfo = null
  for (let i = 0; i < 20; i++) {
    try { gwInfo = await (await fetch(`${gwBase}/relay-info`)).json(); if (gwInfo?.ok) break } catch { /* 重试 */ }
    await sleep(500)
  }
  console.log(`[t] 网关就绪 ${Date.now() - t0}ms`, JSON.stringify(gwInfo))
  check('网关启动且 /relay-info 健康', gwInfo?.ok === true, JSON.stringify(gwInfo))
  const gwOnline0 = gwInfo.online // external 模式（Worker）无 online 字段 → 相关断言跳过

  const page = await waitHttp(PORT, 25000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 25000)
  await waitJs(cdp, '!!window.__ahub_debug', 25000)
  await js(cdp, 'window.__ahub_debug.workbench()')
  await waitJs(cdp, 'document.querySelectorAll(".agent-list .agent-item").length > 0', 25000)
  await sleep(600)

  /* ---- 1) IPC 形状 + 意图持久化 ---- */
  const r0 = await js(cdp, `window.agenthub.mobile.relayStatus()`)
  check('relayStatus 可用（enabled/connected/relayUrl 字段齐）',
    r0 && typeof r0.enabled === 'boolean' && typeof r0.connected === 'boolean' && typeof r0.relayUrl === 'string', JSON.stringify(r0))
  const wasRelay = r0?.enabled === true
  const wasEnabled = (await js(cdp, `window.agenthub.mobile.status()`))?.enabled === true
  if (wasEnabled) await js(cdp, `window.agenthub.mobile.setEnabled(false)`) // 服务关态下先测门禁

  const gate = await js(cdp, `window.agenthub.mobile.setRelayEnabled(true)`)
  check('服务未开时开中继 → 记住意图但不连接并提示',
    gate?.ok === true && gate?.connected === false && typeof gate?.error === 'string' && gate.error.includes('先开启'), JSON.stringify(gate))

  /* ---- 2) 服务开 → 中继连接 → 网关注册 ---- */
  await js(cdp, `window.agenthub.mobile.setEnabled(true)`)
  const r1 = await waitRelay(cdp, (s) => s.connected, 15000)
  check('中继已连接（出站 WS + hello-ok）', r1?.connected === true, JSON.stringify({ connected: r1?.connected, error: r1?.error }))
  check('固定公网入口已生成（publicUrl 带 token）', typeof r1?.publicUrl === 'string' && r1.publicUrl.includes('?t='), String(r1?.publicUrl)?.replace(/t=[0-9a-f]+/, 't=***'))
  if (!EXTERNAL_GW) {
    const gwOnline1 = (await (await fetch(`${gwBase}/relay-info`)).json()).online
    check('网关在线实例数 +1（token 路由已注册）', gwOnline1 === gwOnline0 + 1, `${gwOnline0} → ${gwOnline1}`)
  }

  /* ---- 3) 公网全链路：网关 → 实例 → 本地服务 → 回包 ---- */
  const token = r1?.publicUrl?.match(/t=([0-9a-f]+)/)?.[1]
  const page1 = await fetch(`${gwBase}/?t=${token}`)
  const html = await page1.text()
  check('经网关取手机页 → 200 且含 AgentHub 标记', page1.status === 200 && html.includes('AgentHub') && html.includes('data-tab="usage"'), String(page1.status))
  const state = await (await fetch(`${gwBase}/api/state?t=${token}`)).json()
  check('经网关取 /api/state → agents 数组（数据穿透成功）', Array.isArray(state?.agents) && state.agents.length > 0, JSON.stringify(state?.agents?.[0] ?? state)?.slice(0, 80))
  const noTok = await fetch(`${gwBase}/`)
  check('无 token → 网关 401 引导页（口径同 AgentHub）', noTok.status === 401 && (await noTok.text()).includes('配对'), String(noTok.status))
  const badTok = await fetch(`${gwBase}/?t=${'0'.repeat(36)}`)
  check('token 无路由 → 502 桌面端不在线', badTok.status === 502, String(badTok.status))
  const post = await fetch(`${gwBase}/api/send?t=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'no_such', text: 'hi' })
  })
  check('POST 经网关转发 → 业务校验生效（agentId 不存在 → 400）', post.status === 400, String(post.status))

  /* ---- 4) 服务关 → 中继断开 + 路由清空 ---- */
  await js(cdp, `window.agenthub.mobile.setEnabled(false)`)
  const r2 = await waitRelay(cdp, (s) => !s.connected, 8000)
  check('关闭服务 → 中继同步断开', r2?.connected === false, JSON.stringify(r2?.connected))
  if (!EXTERNAL_GW) {
    const gwOnline2 = (await (await fetch(`${gwBase}/relay-info`)).json()).online
    check('网关路由已清空（在线数回落）', gwOnline2 === gwOnline0, `${gwOnline0} → ${gwOnline2}`)
  }

  /* ---- 5) 还原 ---- */
  const offRelay = await js(cdp, `window.agenthub.mobile.setRelayEnabled(${wasRelay})`)
  check('relay 意图还原（enabled=' + wasRelay + '）', offRelay?.ok === true && offRelay?.enabled === wasRelay, String(offRelay?.enabled))
  const offSvc = await js(cdp, `window.agenthub.mobile.setEnabled(${wasEnabled})`)
  check('服务状态还原（enabled=' + wasEnabled + '）', offSvc?.ok === true && offSvc?.enabled === wasEnabled, String(offSvc?.enabled))

  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
  try { gw.kill() } catch { /* noop */ }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
