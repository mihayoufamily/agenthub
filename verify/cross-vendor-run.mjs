// 跨厂商三角色真实跑一轮：deepseek(规划) → CodeBuddy(执行) → Codex(审核)，人工确认门
// 用法：node verify/cross-vendor-run.mjs [--exe=...] [--port=9230] [--goal="..."]
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
const PORT = Number(args.port ?? 9230)
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'shots-run')
const GOAL = args.goal ?? '在工作目录下创建 agent-report.md：用中文写三节，分别说明（1）这个工作流的规划/执行/审核三类角色各做什么（2）本次任务的执行步骤（3）一条给新用户的使用建议。每节不超过三行。'

const state = async (cdp) => JSON.parse(await js(cdp, 'JSON.stringify(window.__ahub_debug.state())'))
const shot = async (cdp, name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const p = resolve(OUT, `${name}.png`)
  writeFileSync(p, Buffer.from(s.data, 'base64'))
  console.log('    截图 →', p)
}

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
  let cdp
  let failed = 0
  let passed = 0
  // 修复波 B · 项 1c 同类：只 ++failed 的套件在 run-all 里是 `-/-`。补一个同口径的计数行，
  // 语义一字未改（原来 failed++ 的两处现在还是失败，throw 那道前置闸门也原样保留）。
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name) }
    else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
  }
  try {
    const page = await waitHttp(PORT, 25000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    if (!(await waitJs(cdp, '!!window.__ahub_debug', 25000))) throw new Error('页面未就绪')

    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(600)
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(1000)

    // 确认三角色
    const chips = await js(cdp, `[...document.querySelectorAll('.cfg-chip')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`)
    console.log('配置条：', JSON.stringify(chips))
    if (!/deepseek/.test(chips?.[0] ?? '') || !/CodeBuddy/.test(chips?.[1] ?? '') || !/Codex/.test(chips?.[2] ?? '')) {
      check('三角色配置与预期相符（跑真任务前的闸门）', false, JSON.stringify(chips)?.slice(0, 200))
      throw new Error('三角色配置与预期不符，先不要跑')
    }
    check('三角色配置与预期相符（跑真任务前的闸门）', true)

    console.log('\n启动任务：', GOAL)
    await js(cdp, `void window.__ahub_debug.startDemoTask(${JSON.stringify(GOAL)})`)

    const t0 = Date.now()
    let lastStage = ''
    let sawGate = false
    let shotRunning = false
    for (;;) {
      await sleep(2000)
      const st = await state(cdp)
      const run = st.run
      if (!run) { if (Date.now() - t0 > 20000) throw new Error('任务未启动'); continue }
      const key = `${run.status}/${run.stage}/${run.round}`
      if (key !== lastStage) {
        console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 状态=${run.status} 阶段=${run.stage ?? '-'} 轮次=${run.round} 卡片=${run.cards}`)
        lastStage = key
      }
      if (!shotRunning && run.stage === 'executing') { shotRunning = true; await shot(cdp, '01-executing') }

      if (run.status === 'waiting_user') {
        sawGate = true
        await sleep(600)
        await shot(cdp, '02-review-gate')
        const detail = await js(cdp, `[...document.querySelectorAll('.gate-card, .role-card')].map((e) => e.innerText.replace(/\\s+/g, ' ').slice(0, 300))`)
        console.log('\n确认门内容：')
        for (const d of detail ?? []) console.log('  ·', d.slice(0, 220))
        console.log('\n通过并交付…')
        await js(cdp, 'void window.__ahub_debug.passGate()')
        lastStage = ''
        continue
      }
      if (['completed', 'failed', 'cancelled', 'timeout', 'rework_limit', 'token_limit', 'interrupted'].includes(run.status)) {
        await sleep(1200)
        await shot(cdp, '03-delivery')
        const final = await state(cdp)
        console.log('\n最终状态：', final.run.status, '| 轮次', final.run.round, '| 卡片', final.run.cards)
        const texts = await js(cdp, `[...document.querySelectorAll('.role-card, .delivery-card')].map((e) => e.innerText.replace(/\\s+/g, ' ').slice(0, 260))`)
        console.log('\n卡片内容：')
        for (const t of texts ?? []) console.log('  ·', t.slice(0, 240))
        console.log('\n卡片明细：', JSON.stringify(final.run.cardDetails, null, 1))
        check('跑到 completed（终态不是 failed/cancelled/timeout/…）', final.run.status === 'completed', final.run.status)
        check('出现过人工确认门（reviewMode=human 的那一半）', sawGate, '（未出现人工确认门）')
        break
      }
      if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('超时（15 分钟）')
    }
  } catch (e) {
    failed++
    console.error('失败：' + e.message)
    try { await shot(cdp, '99-error') } catch { /* noop */ }
  } finally {
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
  console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
  console.log(failed === 0 ? '\n==== 跑通 ====' : '\n==== 未跑通 ====')
  process.exit(failed === 0 ? 0 : 1)
}

void main()
