// 截图：添加 Agent → 本机 CLI 面板（验证 5 个 CLI 条目与实测状态）
// 用法：node verify/cli-shot.mjs [--exe=d:\AgentHub\AgentHub.exe] [--port=9227]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const EXE = resolve(args.exe ?? 'd:/AgentHub/AgentHub.exe')
const PORT = Number(args.port ?? 9227)
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'shots-cli')

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
  let cdp
  try {
    const page = await waitHttp(PORT, 25000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    if (!(await waitJs(cdp, '!!window.__ahub_debug', 25000))) throw new Error('页面未就绪')
    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(800)
    await js(cdp, 'window.__ahub_debug.workbench()')
    await sleep(1200)

    // 打开「添加 Agent」并切到「本机 CLI」
    const opened = await js(cdp, `(() => {
      const btn = document.querySelector('button[title="添加 Agent"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!opened) throw new Error('未找到「添加 Agent」按钮')
    await sleep(800)
    const switched = await js(cdp, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '本机 CLI')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!switched) throw new Error('未找到「本机 CLI」页签')
    await sleep(2000) // 等连接测试结果回填

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(OUT, 'cli-tab.png'), Buffer.from(shot.data, 'base64'))
    console.log('已保存：' + resolve(OUT, 'cli-tab.png'))
  } catch (e) {
    console.error('失败：' + e.message)
    process.exitCode = 1
  } finally {
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
}

void main()
