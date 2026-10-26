// 中继「代理通道失效 → 自动回退直连」验证（2026-10-26）
// 背景：用户开了代理软件但中继仍连不上——实测是系统代理注册表残留死端口（ProxyEnable=1、端口无人监听），
//      或代理软件只有界面进程、核心服务没起来。旧逻辑"固定走代理不轮换"会永久卡死在这个死代理上。
// 本脚本用**假代理**（端口活着但拒绝 CONNECT）复现该场景，断言中继会自动丢弃代理、改走直连并连上。
//
// 拓扑：
//   假代理 127.0.0.1:18099（对 CONNECT 一律回 403）
//   本地网关 127.0.0.1:18090
//   AgentHub 出站目标 ws://relay.127.0.0.1.nip.io:18090（nip.io 解析回 127.0.0.1，
//   但主机名不是 IP，所以 isPrivateHost=false → 初始会走代理，正是要测的路径）
//
// 用法：node verify/relay-proxy-check.mjs。前置：构建 + 部署便携版 + 应用未在运行。
import { spawn } from 'node:child_process'
import net from 'node:net'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9254
const GW_PORT = 18090
const PROXY_PORT = 18099
const GW_URL = `ws://relay.127.0.0.1.nip.io:${GW_PORT}`

let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

// ---- 假代理：接受 TCP 连接，但对 CONNECT 回 403（模拟"代理软件在跑但拒绝转发"） ----
let proxyHits = 0
const fakeProxy = net.createServer((s) => {
  s.on('data', (d) => {
    if (!d.toString('utf8').startsWith('CONNECT ')) return
    proxyHits++
    s.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
  })
  s.on('error', () => { /* 忽略 */ })
})
await new Promise((res) => fakeProxy.listen(PROXY_PORT, '127.0.0.1', res))

// ---- 本地网关 ----
const gw = spawn('node', ['D:/dsh/agenthub/relay/server.mjs', `--port=${GW_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
gw.stdout?.on('data', (d) => console.log('[gw-out]', d.toString().trim().slice(0, 160)))
gw.stderr?.on('data', (d) => console.log('[gw-err]', d.toString().trim().slice(0, 200)))
gw.on('error', (e) => console.log('[gw-spawn-error]', e.message))

const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify', '--user-data-dir=D:/dsh/agenthub/.tmp/profile-relay-proxy'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...launchEnv(),
    AGENTHUB_RELAY_URL_OVERRIDE: GW_URL,
    // 显式钉死假代理（launchEnv 已剥离宿主会话代理变量）
    HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
    HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`
  }
})
proc.stderr.on('data', (d) => console.log('[app-err]', d.toString().trim().slice(0, 220)))

let cdp = null
let restore = { relay: null, enabled: null }
try {
  // 网关就绪
  let gwInfo = null
  for (let i = 0; i < 24; i++) {
    try { gwInfo = await (await fetch(`http://127.0.0.1:${GW_PORT}/relay-info`)).json(); if (gwInfo?.ok) break } catch { /* 重试 */ }
    await sleep(500)
  }
  check('网关启动且 /relay-info 健康', gwInfo?.ok === true, JSON.stringify(gwInfo))

  const page = await waitHttp(PORT, 25000)
  cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 25000)
  await waitJs(cdp, '!!window.__ahub_debug', 25000)
  await sleep(500)

  // 隔离 profile 与用户实例并存：本地服务固定用 8749（8748 可能被用户实例占着）
  await js(cdp, `window.agenthub.config.get().then((c) => window.agenthub.config.setPrefs({ ...c.prefs, mobileService: { ...c.prefs.mobileService, port: 8749 } }))`)

  // 记录并复位状态
  const st0 = await js(cdp, `window.agenthub.mobile.status()`)
  const rel0 = await js(cdp, `window.agenthub.mobile.relayStatus()`)
  restore = { relay: rel0?.enabled === true, enabled: st0?.enabled === true }
  await js(cdp, `window.agenthub.mobile.setRelayEnabled(false)`)
  await js(cdp, `window.agenthub.mobile.setEnabled(false)`)
  await sleep(400)

  /* ---- 1) 开服务 + 中继：首轮应走代理，并被假代理拒绝 ---- */
  await js(cdp, `window.agenthub.mobile.setEnabled(true)`)
  await sleep(600)
  await js(cdp, `window.agenthub.mobile.setRelayEnabled(true)`)

  // 抓一次"失败瞬间"的状态（错误里应体现走的是代理 + 代理拒绝）
  let sawProxyError = null
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    const s = await js(cdp, `window.agenthub.mobile.relayStatus()`)
    if (s?.error && /代理/.test(s.error) && /(拒绝|403|不可达|失败)/.test(s.error)) { sawProxyError = s; break }
    if (s?.connected) break
    await sleep(300)
  }
  check('首轮失败信息明确指出「代理通道」与其原因', !!sawProxyError, sawProxyError?.error ?? '未捕获到代理失败态')
  check('假代理确实收到过 CONNECT（证明先走了代理）', proxyHits > 0, `proxyHits=${proxyHits}`)

  /* ---- 2) 自动回退直连：冷却后改走直连并连上 ---- */
  let connected = null
  const t1 = Date.now()
  while (Date.now() - t1 < 25000) {
    const s = await js(cdp, `window.agenthub.mobile.relayStatus()`)
    if (s?.connected) { connected = s; break }
    await sleep(500)
  }
  check('代理被拒后自动回退直连并成功连上中继', connected?.connected === true, JSON.stringify({ connected: connected?.connected, channel: connected?.channel, error: connected?.error }))
  check('回退后通道如实显示为「直连」', connected?.channel === '直连', String(connected?.channel))

  /* ---- 3) 诊断端点如实报告代理状态 ---- */
  const diag = await js(cdp, `window.agenthub.mobile.relayDiag()`)
  const p0 = diag?.proxies?.find((x) => x.addr === `127.0.0.1:${PROXY_PORT}`)
  check('诊断：假代理端口被判为存活（TCP 通）', p0?.alive === true, JSON.stringify(diag?.proxies))
  check('诊断：经该代理到网关被拒（403）', typeof p0?.via === 'string' && /拒绝|403/.test(p0.via), String(p0?.via))
  check('诊断：结论给出人话提示（代理不可用/被阻断）', typeof diag?.hint === 'string' && diag.hint.length > 6, String(diag?.hint))

  /* ---- 4) 数据面仍通（网关侧路由已注册） ---- */
  const info = await (await fetch(`http://127.0.0.1:${GW_PORT}/relay-info`)).json()
  check('网关侧实例在线（token 路由已注册）', Number(info?.online) >= 1, JSON.stringify(info))
} catch (e) {
  failed++
  console.log('  ✗ 脚本异常 — ' + (e?.stack ?? e))
} finally {
  // 还原用户状态（有 CDP 才可还原）
  try {
    if (cdp) {
      await js(cdp, `window.agenthub.mobile.setRelayEnabled(false)`)
      await js(cdp, `window.agenthub.mobile.setEnabled(false)`)
      if (restore.enabled) await js(cdp, `window.agenthub.mobile.setEnabled(true)`)
      if (restore.relay) await js(cdp, `window.agenthub.mobile.setRelayEnabled(true)`)
    }
  } catch { /* 忽略 */ }
  try { cdp?.socket?.end() } catch { /* 忽略 */ }
  try { proc.kill() } catch { /* 忽略 */ }
  try { gw.kill() } catch { /* 忽略 */ }
  try { fakeProxy.close() } catch { /* 忽略 */ }
  await sleep(800)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
