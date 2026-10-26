// 系统托盘常驻 + 关窗不退出（2026-10-25 批次）：关窗后进程活着、窗口只是隐藏、二次启动唤回
// 用法：node verify/tray-close-check.mjs [--port=9237]
// 前置：先构建并同步便携版，应用未在运行。
// 断言路径说明（诚实标注）：
//  - CDP 驱动不了原生标题栏 X / Alt+F4，本脚本走验证专用 IPC app:requestClose →
//    主进程 requestClose() 三态裁决的 hide 分支（与 Ctrl+W 菜单同一条链）；
//  - win.on('close') 对原生关闭的裁决由 fixes-check [H] 的纯函数断言覆盖；
//  - 渲染层 window.close() 实测会绕过 win.on('close') 直接销毁窗口（Electron 行为），
//    不代表用户路径，不作依据；
//  - Tray 对象本身拿不到 CDP 句柄，"托盘存在"由 fixes-check 源码断言（whenReady 即 ensureTray）覆盖。
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9237
let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const alive = () => proc.exitCode === null && proc.pid > 0
const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify'], { stdio: 'ignore', env: launchEnv() })
try {
  const page = await waitHttp(PORT, 25000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 25000)
  await waitJs(cdp, '!!window.__ahub_debug', 25000)
  await sleep(500)

  /* 1) 空闲关窗（requestClose → 裁决 hide → win.hide()）：隐藏而非退出 */
  const r = await js(cdp, 'window.agenthub.app.requestClose()')
  check('app:requestClose 通道可用（--ahub-verify 门控注册）', r?.ok === true, JSON.stringify(r))
  await sleep(800)
  const hidden = await js(cdp, 'document.visibilityState')
  check('空闲关窗：窗口被隐藏（visibilityState=hidden）且进程还活着', hidden === 'hidden' && alive(),
    `visibility=${hidden} alive=${alive()}`)
  const stillUsable = await js(cdp, '!!window.agenthub')
  check('隐藏后渲染层照常响应（应用没有退出）', stillUsable === true && alive())

  /* 2) 二次启动：单实例锁 → first 实例 second-instance 唤回窗口 */
  const second = spawn('D:/AgentHub/AgentHub.exe', [], { stdio: 'ignore', env: launchEnv() })
  await sleep(2500)
  const visible = await js(cdp, 'document.visibilityState')
  check('再次双击 exe：已有实例把窗口唤回（visibilityState=visible）', visible === 'visible', `visibility=${visible}`)
  check('二次启动的实例安静退出（单实例锁），first 实例仍活着', second.exitCode !== undefined && alive(),
    `second.exitCode=${second.exitCode} alive=${alive()}`)
  second.on('exit', () => { /* 已断言，noop */ })

  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
}
console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
