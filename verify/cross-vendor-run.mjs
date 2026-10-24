// 跨厂商三角色真实跑一轮：deepseek(规划) → CodeBuddy(执行) → Codex(审核)，人工确认门
// 用法：node verify/cross-vendor-run.mjs [--exe=...] [--port=9230] [--goal="..."]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs, ensureWfHome, restoreWfHome, waitHydrated } from './cdp.mjs'

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
  let prevCfg = null
  let homePrev = ''
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
    // 起真任务前先把视图切回首页：否则 startDemoTask 会撞在用户正打开着的那个任务上
    homePrev = (await ensureWfHome(cdp)).prev

    // 确认三角色：**由套件自己绑**，不再断言"用户当前正好这么绑"（用户点一下角色条就会换，
    // 靠现状当基线的套件会恒红、且红的不是被测代码）。缺哪个 Agent 就点名缺哪个。
    if (!(await waitHydrated(cdp))) throw new Error('渲染层 store 20s 内没水合（agents 为空），不当作产品缺陷报红')
    const st0 = await state(cdp)
    prevCfg = st0.config
    const agents = st0.agents || []
    const modelAgent = agents.find((a) => a.kind !== 'cli')
    const clis = agents.filter((a) => a.kind === 'cli' && a.cli)
    const execCli = clis.find((a) => /codex/i.test(a.cli)) || clis[0]
    const revCli = clis.find((a) => /codebuddy/i.test(a.cli) && a.id !== execCli?.id) ||
      clis.find((a) => a.id !== execCli?.id)
    const missing = [['规划用的模型 Agent', modelAgent], ['执行用的 CLI Agent', execCli], ['审核用的另一个厂商 CLI', revCli]]
      .filter(([, a]) => !a)
      .map(([n]) => n)
    check('本机具备跨厂商真跑所需的三类 Agent（缺哪个点名哪个）', missing.length === 0, missing.length ? '缺：' + missing.join('、') : '')
    if (missing.length) throw new Error('前置 Agent 缺失：' + missing.join('、'))
    const bound = await js(cdp, `window.__ahub_debug.setRoles(${JSON.stringify({ planner: modelAgent.id, executor: execCli.id, reviewer: revCli.id })})`)
    check('三角色由套件显式绑定成功（setRoles 回 ok）', !!bound?.ok, JSON.stringify(bound)?.slice(0, 200))
    console.log('  绑定：规划=' + modelAgent.name + ' 执行=' + execCli.name + ' 审核=' + revCli.name)
    const chips = await js(cdp, `[...document.querySelectorAll('.cfg-chip')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`)
    console.log('配置条：', JSON.stringify(chips))

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
        // 红的时候必须能一眼看出是"哪一家没通"，否则下一棒只能重跑一遍去猜
        console.log('任务记录里的说明：', JSON.stringify(final.run.notes ?? []).slice(0, 400))
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
    await restoreWfHome(cdp, homePrev)
    // 绑过角色就要还原：不留残在用户配置里（跑前拿的是整份 config 快照）
    try {
      if (prevCfg) await js(cdp, `window.__ahub_debug.restoreWorkflowConfig(${JSON.stringify(prevCfg)})`)
    } catch { /* 页面已关就认了：快照是本机配置，用户下次改设置会覆盖 */ }
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
  console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
  console.log(failed === 0 ? '\n==== 跑通 ====' : '\n==== 未跑通 ====')
  process.exit(failed === 0 ? 0 : 1)
}

void main()
