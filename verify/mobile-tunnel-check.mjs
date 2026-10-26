// 公网接入（2026-10-26 批次）：cloudflared quick tunnel 的开停与 fail-closed 联动
// 用法：node verify/mobile-tunnel-check.mjs。前置：构建 + 部署便携版，应用未在运行。
// 需要真实公网（起 quick tunnel 连 Cloudflare 边缘）；本机直连 CF 的 443 可能被网络环境
// 干扰——所以「curl 公网 URL」是软断言（失败记 skip 不算 fail），核心断言是隧道进程与 URL 生命周期。
// 环境变量：本工作区对原生二进制执行受限（铁律），测试用 AGENTHUB_CLOUDFLARED_PATH 指向工作区外的副本。
// 断言口径：
//  1) binaryFound 定位可用（env 指路）
//  2) 服务未开时开隧道 → 不启动且提示先开服务（公网入口跟随服务）
//  3) 服务开 → 开隧道 → 拿到 https://xxx.trycloudflare.com（15s 连接窗 + 轮询余量）
//  4) 软断言：公网 URL 无 token → 期望 401（网络不通时 skip）
//  5) 关服务 → 隧道必停（running=false）；重开服务 + 隧道 pref 记忆恢复
//  6) UI：公网区块渲染、局域网/公网切换按钮出现
//  7) 还原：tunnel=false、服务回原状态
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9252
const HTTP_PORT = 8749
let failed = 0
let passed = 0
let skipped = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const skip = (name, detail) => { skipped++; console.log('  - ' + name + (detail ? ' — ' + detail : '')) }

/** 轮询直到 cond 为真或超时（返回最后一次 tunnelStatus） */
const pollTunnel = async (cdp, want, timeoutMs) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await js(cdp, `window.agenthub.mobile.tunnelStatus()`)
    if (want(last)) return last
    await sleep(800)
  }
  return last
}

const env = launchEnv()
env.AGENTHUB_CLOUDFLARED_PATH = 'D:\\local-llm\\cloudflared.exe'

const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify', '--user-data-dir=D:/dsh/agenthub/.tmp/profile-mobile-tunnel'], { stdio: 'ignore', env })
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

  // 隔离 profile 与用户实例并存：本地服务固定用 8749（8748 可能被用户实例占用）
  await js(cdp, `window.agenthub.config.get().then((c) => window.agenthub.config.setPrefs({ ...c.prefs, mobileService: { ...c.prefs.mobileService, port: ${HTTP_PORT} } }))`)

  /* ---- 1) 状态与二进制定位 ---- */
  const t0 = await js(cdp, `window.agenthub.mobile.tunnelStatus()`)
  check('tunnelStatus 可用（enabled/running/connecting/binaryFound 字段齐）',
    t0 && typeof t0.enabled === 'boolean' && typeof t0.running === 'boolean' && typeof t0.connecting === 'boolean' && typeof t0.binaryFound === 'boolean',
    JSON.stringify(t0))
  check('binaryFound=true（AGENTHUB_CLOUDFLARED_PATH 指路成功）', t0?.binaryFound === true)
  const wasEnabled = (await js(cdp, `window.agenthub.mobile.status()`))?.enabled === true
  const wasTunnel = t0?.enabled === true

  /* ---- 2) 服务未开：隧道不启动 ---- */
  // 用户 prefs 里服务可能本来就开着——先关掉再测门禁（顺带验证"关服务→隧道停"），测完在步骤 3 重开
  if (wasEnabled) await js(cdp, `window.agenthub.mobile.setEnabled(false)`)
  const gate = await js(cdp, `window.agenthub.mobile.setTunnelEnabled(true)`)
  check('服务未开时开隧道 → ok 但不启动并提示先开服务',
    gate?.ok === true && gate?.running === false && typeof gate?.error === 'string' && gate.error.includes('先开启'),
    JSON.stringify(gate))

  /* ---- 3) 服务开 → 隧道起 → 拿公网地址 ---- */
  const on = await js(cdp, `window.agenthub.mobile.setEnabled(true)`)
  check('手机服务已开启', on?.ok === true && on?.running === true, JSON.stringify(on?.running))
  const up = await js(cdp, `window.agenthub.mobile.setTunnelEnabled(true)`)
  const tun = await pollTunnel(cdp, (s) => s.running || (!s.connecting && !!s.error), 45000)
  check('隧道运行中（进程存活 + 拿到 trycloudflare 地址）', tun?.running === true, JSON.stringify({ running: tun?.running, connecting: tun?.connecting, error: tun?.error }))
  check('公网地址形如 https://xxx.trycloudflare.com', typeof tun?.url === 'string' && /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/.test(tun.url), String(tun?.url))

  /* ---- 4) 软断言：公网可达性与 token 门（网络被干扰时 skip） ---- */
  if (tun?.url) {
    let r
    try { r = await fetch(`${tun.url}/?probe=${Date.now()}`, { signal: AbortSignal.timeout(20000) }) }
    catch (e) { r = null; console.log(`    (公网探测网络异常：${e.cause?.code ?? e.message})`) }
    if (r) check('公网无 token → 401（配对门在公网同样生效）', r.status === 401, String(r.status))
    else skip('公网无 token → 401', '本机到 Cloudflare 边缘当前不通（间歇性网络干扰），公网行为留给手机实测')
  } else {
    skip('公网无 token → 401', '隧道未起来，同上')
  }

  /* ---- 5) 关服务 → 隧道必停；重开 → 隧道 pref 记忆自动恢复 ---- */
  await js(cdp, `window.agenthub.mobile.setEnabled(false)`)
  const afterStop = await pollTunnel(cdp, (s) => !s.running && !s.connecting, 8000)
  check('关闭服务 → 隧道同步停止', afterStop?.running === false && afterStop?.connecting === false, JSON.stringify(afterStop))
  await js(cdp, `window.agenthub.mobile.setEnabled(true)`)
  const resumed = await pollTunnel(cdp, (s) => s.running || (!s.connecting && !!s.error), 45000)
  check('重开服务 → 隧道按 pref 记忆自动重连', resumed?.running === true, JSON.stringify({ running: resumed?.running, error: resumed?.error }))

  /* ---- 6) UI：公网区块 + 切换按钮 ---- */
  const ui = await js(cdp, `(async () => {
    const tick = (ms) => new Promise(r => setTimeout(r, ms))
    const footBtn = document.querySelector('.foot-btn[title="手机查看"]')
    if (!footBtn) return { opened: false, reason: 'foot-btn 手机查看 not found' }
    footBtn.click()
    await tick(400)
    if (!document.querySelector('.mob-wrap')) return { opened: false }
    const panel = document.querySelector('.mob-tunnel')
    const switches = document.querySelectorAll('.mob-wrap [role="switch"]')
    // 点公网二维码切换按钮（隧道在跑才显示）
    const pubBtn = [...document.querySelectorAll('.mob-qr-switch button')].find(b => b.textContent === '公网')
    let pubSwitched = false
    if (pubBtn) { pubBtn.click(); await tick(300); pubSwitched = (document.querySelector('.mob-url code')?.textContent ?? '').includes('trycloudflare.com') }
    return { opened: true, hasPanel: !!panel, switchCount: switches.length, hasQrSwitch: !!pubBtn, pubSwitched }
  })()`)
  check('弹窗内公网区块（.mob-tunnel）渲染', ui?.hasPanel === true, JSON.stringify(ui))
  check('两个开关（主服务 + 公网）都在', ui?.switchCount === 2, String(ui?.switchCount))
  check('局域网/公网切换按钮出现且公网 URL 正确显示', ui?.hasQrSwitch === true && ui?.pubSwitched === true, JSON.stringify(ui))

  /* ---- 7) 还原：隧道关、服务回原状态 ---- */
  const off = await js(cdp, `window.agenthub.mobile.setTunnelEnabled(false)`)
  check('隧道 pref 还原为关', off?.ok === true && off?.enabled === false, JSON.stringify(off?.enabled))
  const offSvc = await js(cdp, `window.agenthub.mobile.setEnabled(${wasEnabled})`)
  check('服务状态还原（enabled=' + wasEnabled + '）', offSvc?.ok === true && offSvc?.enabled === wasEnabled, JSON.stringify(offSvc?.enabled))
  // 开服务是为了联动测试——若用户原本没开服务，此刻隧道应随服务关闭；若原本开着，pref 已还原为关不会再起
  const fin = await pollTunnel(cdp, (s) => !s.running, 8000)
  check('收口：隧道进程已全部停止', fin?.running === false, JSON.stringify(fin))

  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed > 0 ? 1 : 0)
