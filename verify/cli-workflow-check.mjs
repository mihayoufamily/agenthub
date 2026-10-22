/**
 * 真实 CLI 工作流闭环核验（需求 3 + 需求 1/6 在 CLI 形态下的复验）
 * 用法：node verify/cli-workflow-check.mjs [--cli=codebuddy] [--port=9233]
 * 会真实调用本机 CLI（消耗额度）；产物目录指向临时沙箱；结束后还原配置、删除本次新增的
 * Agent 与任务记录——用户原有 Agent 一律不删。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const EXE = resolve(args.exe ?? 'd:/AgentHub/AgentHub.exe')
const PORT = Number(args.port ?? 9233)
const CLI = String(args.cli ?? 'codebuddy')
// --default-dir：保持用户配置的产物目录（默认=文档/AgentHub-artifacts，此前不存在，
// 正是"WorkBuddy 进程打不开"的复现条件）
const USE_DEFAULT_DIR = args['default-dir'] === true
const DEFAULT_DIR = join(process.env.USERPROFILE ?? '', 'Documents', 'AgentHub-artifacts')
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(HERE, 'shots-cliwf')
const SANDBOX = mkdtempSync(join(tmpdir(), 'ahub-cliwf-'))
const GOAL = '用两句话说明什么是"工作流模式"，并给一条可验收标准。'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

const shot = async (cdp, name) => {
  mkdirSync(SHOTS, { recursive: true })
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const p = join(SHOTS, name + '.png')
  writeFileSync(p, Buffer.from(s.data, 'base64'))
  console.log('  截图  ' + p)
}

let cdp
let proc
const cleanup = []

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  const RUNS = join(process.env.APPDATA ?? '', 'agenthub', 'runs')
  const runsBefore = new Set(existsSync(RUNS) ? readdirSync(RUNS) : [])
  // 用默认产物目录跑时先记下现场：新增文件与"本来不存在的目录"都要还原
  const dirExisted = existsSync(DEFAULT_DIR)
  const filesBefore = new Set(dirExisted ? readdirSync(DEFAULT_DIR) : [])

  proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
  try {
    const page = await waitHttp(PORT, 30000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    if (!(await waitJs(cdp, '!!window.__ahub_debug', 30000))) throw new Error('页面未就绪')

    const before = await js(cdp, 'window.__ahub_debug.state()')
    const prevCfg = before.config
    console.log(`[cliwf] 基线：Agent ${before.agents.length} 个，任务记录 ${runsBefore.size} 个，产物目录=${prevCfg.outputDir || '(默认)'}`)
    cleanup.push(async () => {
      await js(cdp, `window.__ahub_debug.restoreWorkflowConfig(${JSON.stringify(prevCfg)})`)
      console.log('  清理  已还原工作流配置')
    })

    // 产物目录：默认指向临时沙箱；--default-dir 时保持用户配置（复现 cwd 不存在的场景）
    if (!USE_DEFAULT_DIR) {
      await js(cdp, `window.__ahub_debug.setWorkflowOutputDir(${JSON.stringify(SANDBOX)})`)
      await sleep(1200)
    } else {
      console.log('[cliwf] 使用默认产物目录：' + DEFAULT_DIR + '（跑完会还原现场）')
    }

    const started = await js(cdp, `window.__ahub_debug.startCliTask(${JSON.stringify(CLI)}, ${JSON.stringify(GOAL)})`)
    ok(`${CLI} 已绑定为工作流三角色并启动任务`, !!started?.agentId, JSON.stringify(started))
    if (started?.added) cleanup.push(async () => {
      await js(cdp, `window.__ahub_debug.removeAgentByName(${JSON.stringify(started.name)})`)
      console.log('  清理  已删除本次新增 Agent：' + started.name)
    })
    await sleep(1500)
    // 切到工作流界面：卡片 DOM 断言要求任务真的在屏上渲染
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(1200)
    // 先确认任务真的建起来了：validate() 拒绝时 start() 会静默返回，别让脚本白等 5 分钟
    const live = await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); return s.run ? { status: s.run.status, round: s.run.round } : null })()`, 20000)
    ok('工作流任务已创建（run 非空）', !!live, JSON.stringify(live))
    if (!live) throw new Error('run 未创建：start() 被 validate() 拦下，先查 Agent 状态')

    // 需求 3 核心：CLI 角色的卡片过程区要出现真实思考内容；同时盯住"进程启动失败"类失败原因
    const BAD = /进程启动失败|工作目录不存在|ENOENT|未能发起/
    const think = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const bad = (s.run?.notes ?? []).find((n) => ${String(BAD)}.test(n))
      if (bad) return { err: bad }
      const c = s.run?.cardDetails?.find((x) => x.process.some((p) => p.startsWith('thinking:') && p.length > 14))
      if (!c) return null
      return { role: c.role, sample: c.process.find((p) => p.startsWith('thinking:') && p.length > 14) }
    })()`, 300000)
    ok('CLI 进程正常启动（无"进程启动失败 / 工作目录不存在"）', !think?.err, String(think?.err ?? ''))
    ok('CLI 角色卡片出现真实思考过程（kind=thinking）', !!think && !think.err && !!think.sample, JSON.stringify(think?.sample ?? '').slice(0, 120))
    if (think?.err) throw new Error('CLI 进程启动失败：' + think.err)
    if (think) await shot(cdp, '01-cli-thinking-card')

    // 需求 1/6：执行结论落成真实文件（CLI 写盘 by=tool 或 AgentHub 兜底 by=app）
    const artAt = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const c = s.run?.cardDetails?.find((x) => (x.artifacts ?? []).length > 0)
      return c ? { role: c.role, arts: c.artifacts, outDir: s.run?.outputDir } : null
    })()`, 300000)
    ok('真实 CLI 任务产出被登记为文件产物', !!artAt, JSON.stringify(artAt ?? null))
    if (artAt) {
      const p = (artAt.arts ?? []).map((a) => a.match(/\(([^)]+)\)\[/)?.[1]).filter(Boolean)[0]
      const want = USE_DEFAULT_DIR ? artAt.outDir : SANDBOX
      ok('运行记录携带生效的产物目录', !!artAt.outDir && artAt.outDir === want, String(artAt.outDir))
      ok('产物文件就在该目录内且真实存在于磁盘', !!p && p.startsWith(artAt.outDir) && existsSync(p), String(p))
      if (p && existsSync(p)) {
        const body = readFileSync(p, 'utf-8')
        ok('产物内容非空', body.trim().length > 20, body.slice(0, 60).replace(/\n/g, ' '))
      }
      await shot(cdp, '02-cli-artifact')
    }

    // 卡片里的思考正文在界面上可见（不只是 store 里有）：先展开全部过程区再取文本
    await js(cdp, `(() => { [...document.querySelectorAll('.collapse-toggle[data-open="false"]')].forEach((t) => t.click()); return true })()`)
    await sleep(900)
    const thinkDom = await js(cdp, `(() => {
      const el = document.querySelector('.collapse-body .ev.thinking')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { text: el.textContent.slice(0, 90), hasView: !!el.querySelector('.thinking-view'), visible: r.height > 8 }
    })()`)
    ok('界面过程区渲染出思考条目（DOM 可见，走 ThinkingText 分段）', !!thinkDom?.hasView && thinkDom?.visible, JSON.stringify(thinkDom))
    await shot(cdp, '03-cli-card-dom')
  } catch (e) {
    console.error('[cliwf] 失败：' + (e?.stack || e?.message || e))
    fail++
  } finally {
    try {
      await js(cdp, 'window.__ahub_debug.stopTask()')
      await sleep(2500)
    } catch { /* 页面可能已关 */ }
    for (const fn of cleanup.reverse()) {
      try { await fn() } catch (e) { console.log('  清理失败: ' + String(e).slice(0, 120)) }
    }
    await sleep(1500)
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc?.kill() } catch { /* noop */ }
    await sleep(1200)
    let removed = 0
    for (const f of existsSync(RUNS) ? readdirSync(RUNS) : []) {
      if (!runsBefore.has(f)) { rmSync(join(RUNS, f), { force: true }); removed++ }
    }
    console.log(`  清理  删除本次新增任务记录 ${removed} 个`)
    if (USE_DEFAULT_DIR) {
      let n = 0
      for (const f of existsSync(DEFAULT_DIR) ? readdirSync(DEFAULT_DIR) : []) {
        if (filesBefore.has(f)) continue
        rmSync(join(DEFAULT_DIR, f), { recursive: true, force: true })
        n++
      }
      if (!dirExisted && existsSync(DEFAULT_DIR)) rmSync(DEFAULT_DIR, { recursive: true, force: true })
      console.log(`  清理  默认产物目录还原：删除本次新增 ${n} 项${dirExisted ? '' : '，并移除原本不存在的目录'}`)
    }
    try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) } catch (e) {
      console.log('  清理沙箱失败（需手工删除）: ' + SANDBOX + ' ' + String(e).slice(0, 80))
    }
  }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
