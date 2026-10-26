// 通知入口铃铛图标（2026-10-26）：侧栏底栏「通知」按钮左侧应有 SVG 铃铛（此前是纯文字占位）
// 用法：node verify/notif-icon-check.mjs。前置：构建 + 部署便携版后，应用未在运行。
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9247
let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
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
  await sleep(800)

  const ui = await js(cdp, `(() => {
    const btn = document.querySelector('.notif-trigger')
    if (!btn) return { found: false }
    const svg = btn.querySelector('svg')
    return {
      found: true,
      hasSvg: !!svg,
      // 铃铛特征：M18 8a6 6 0 1 0-12 0（钟体弧线，tsc/rollup 不改 path 数据）
      bellPath: svg?.querySelector('path')?.getAttribute('d')?.startsWith('M18 8a6') ?? false,
      hasText: (btn.textContent ?? '').includes('通知'),
      // 徽章结构未被破坏（未读时才渲染，这里只验证按钮内 DOM 合法）
      badgeOk: btn.querySelectorAll('.notif-badge').length <= 1,
      // 与相邻底栏按钮同款结构：svg + 文字 span
      siblingPattern: [...document.querySelectorAll('.sidebar-foot .foot-btn svg')].length >= 3
    }
  })()`)
  check('「通知」按钮存在', ui?.found === true, JSON.stringify(ui))
  check('按钮内有 SVG 图标', ui?.hasSvg === true)
  check('SVG 是铃铛路径（M18 8a6 开头）', ui?.bellPath === true)
  check('「通知」文字保留（图标 + 文字并存，与底栏其他按钮一致）', ui?.hasText === true)
  check('未读徽章结构未被破坏', ui?.badgeOk === true)
  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
}
console.log(`\\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
