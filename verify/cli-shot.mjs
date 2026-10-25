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
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--ahub-verify'], { stdio: 'ignore', env: launchEnv() })
  let cdp
  // 修复波 B · 项 1c：纯截图套件此前一条计数都不打印，run-all 只能报 `-/-`——
  // "跑没跑过、跑到第几步"在汇总里完全隐形（项 2 要开"没打印计数即 FAIL"，所以先把口径补齐）。
  // 下面把它本来就用 throw 表达的四道里程碑改成**记账**：throw 一条都没去掉，条件不成立照样中断，
  // 只是现在每过一道会在汇总行里数进去。
  let passed = 0
  let failed = 0
  const step = (name) => { passed++; console.log('  ✓ ' + name) }
  try {
    const page = await waitHttp(PORT, 25000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    if (!(await waitJs(cdp, '!!window.__ahub_debug', 25000))) throw new Error('页面未就绪')
    step('页面就绪（__ahub_debug 可用）')
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
    step('「添加 Agent」按钮存在并可点')
    await sleep(800)
    const switched = await js(cdp, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '本机 CLI')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!switched) throw new Error('未找到「本机 CLI」页签')
    step('「本机 CLI」页签存在并可切到')
    await sleep(2000) // 等连接测试结果回填

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(OUT, 'cli-tab.png'), Buffer.from(shot.data, 'base64'))
    console.log('已保存：' + resolve(OUT, 'cli-tab.png'))
    step('cli-tab.png 已落盘')
  } catch (e) {
    failed++
    console.error('失败：' + e.message)
    process.exitCode = 1
  } finally {
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
  console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
}

void main()
