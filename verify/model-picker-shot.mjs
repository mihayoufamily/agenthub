// 截图：CLI 模型清单（CodeBuddy 的 21 个模型出现在模型切换弹窗里）
// 用法：node verify/model-picker-shot.mjs [--exe=d:\AgentHub\AgentHub.exe] [--port=9229]
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
const PORT = Number(args.port ?? 9229)
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'shots-cli')

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
  let cdp
  let failed = 0
  let passed = 0
  // 修复波 B · 项 1c 同类：✓/✗ 之外要有 `结果：N PASS / M FAIL`，run-all 才拿得到计数
  // （实测基线 3 条 check；本文件 check() 调用点共 3 处）。
  const check = (n, ok, d) => { if (ok) { passed++; console.log('  ✓ ' + n) } else { failed++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) } }
  try {
    const page = await waitHttp(PORT, 25000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    if (!(await waitJs(cdp, '!!window.__ahub_debug', 25000))) throw new Error('页面未就绪')

    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(600)
    await js(cdp, 'window.__ahub_debug.workbench()')
    await sleep(1200)

    // 选中 CodeBuddy Agent（侧栏）
    const picked = await js(cdp, `(() => {
      const rows = [...document.querySelectorAll('.agent-item, button')]
      const row = rows.find((e) => e.textContent.includes('CodeBuddy Code'))
      if (!row) return false
      row.click()
      return true
    })()`)
    check('选中 CodeBuddy Agent', picked)
    await sleep(900)

    // 点开模型管理：入口在对话栏底部条（上一轮从顶栏搬过去了，脚本要跟着改）
    const opened = await js(cdp, `(() => {
      const btn = document.querySelector('button.model-chip[title^="模型管理"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    check('打开模型切换弹窗（对话栏底部条入口）', opened)
    await sleep(6000) // 首次要跑一次 --help 拿清单

    const chips = await js(cdp, `[...document.querySelectorAll('.cli-model-chip')].map((b) => b.textContent.trim())`)
    const modalText = await js(cdp, `(() => document.querySelector('.modal-body')?.innerText.slice(0, 160) ?? '(无弹窗)')()`)
    console.log('    弹窗内可选模型：', JSON.stringify(chips?.slice(0, 8)))
    console.log('    弹窗文案：', JSON.stringify(modalText))
    // 按结构数而不是硬编码模型名：清单会随 CLI 版本变，写死名字会假失败
    check('弹窗里出现模型选项', Array.isArray(chips) && chips.length >= 5, `count=${chips?.length}`)

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(OUT, 'model-picker.png'), Buffer.from(shot.data, 'base64'))
    console.log('已保存：' + resolve(OUT, 'model-picker.png'))
  } catch (e) {
    failed++
    console.error('失败：' + e.message)
  } finally {
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
  console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
