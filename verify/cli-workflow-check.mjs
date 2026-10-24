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
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs, ensureWfHome, restoreWfHome, waitHydrated } from './cdp.mjs'

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
const GOAL = '在工作目录里新建一个文件 cli-note.md，正文用两句话说明什么是"工作流模式"，并给一条可验收标准；除这个文件外不要改目录里的其它东西。'

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
let homePrev = ''
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
    // 等水合再读基线：agents 载入前 state() 是空表，那时读到的"产物目录=(默认)"是瞬态，不是用户配置
    if (!(await waitHydrated(cdp))) throw new Error('渲染层 store 20s 内没水合（agents 为空），不当作产品缺陷报红')
    // 起真任务前把视图切回首页：否则 startCliTask 撞在用户正打开着的那个任务上（会改写它的运行记录）
    homePrev = (await ensureWfHome(cdp)).prev

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

    // 需求 1/6：执行结论落成真实文件。卡片上的产物**只有 AgentHub 自己登记的那些（by=app 兜底）**：
    // CLI 角色在目录里写的文件进不了卡片产物（那一步发生在子进程里，AgentHub 没有工具事件可记），
    // 它只在交付时被目录对照如实列进"产物索引"（标"来源未记入工具清单"）。下面那段就是验这件事。
    const artAt = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const c = s.run?.cardDetails?.find((x) => (x.artifacts ?? []).length > 0)
      return c ? { role: c.role, arts: c.artifacts, outDir: s.run?.outputDir } : null
    })()`, 300000)
    // 红要能自己说出原因：等不到产物时把现场打出来。2026-10-24 这一条红了、detail 只有 "null"，
    // 真因（任务停在计划批准门上，执行轮压根没跑）只能靠猜——现在它自己报 stage/gateKind/runPlanFirst。
    if (!artAt) {
      const stuck = await js(cdp, `(() => {
        const r = window.__ahub_debug.state().run
        return r ? { status: r.status, stage: r.stage, gateKind: r.gateKind ?? null, runPlanFirst: r.runPlanFirst, planTextLen: r.planTextLen, cards: r.cards, notes: (r.notes || []).slice(-3) } : null
      })()`)
      console.log('  [cliwf 诊断] 300s 内没有任何卡片带产物 · 现场 =', JSON.stringify(stuck))
    }
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

    // ---- 交付如实交代目录：CLI 角色自己写的文件进不了卡片产物（那一步发生在子进程里，没有工具事件可记），
    // 唯一可见通道是交付时的目录对照 → "产物索引"里那行「目录里存在（来源未记入工具清单）」。
    // 这一段验的就是"盘上真有的文件，一个都没被悄悄漏掉"——按盘上实况判，不按 CLI 是否配合写文件判。
    // 交付前先往产物目录里放一个"卡片上没登记过"的文件：这样"盘上真有的文件都被交代过"这条判据
    // 不依赖 CLI 是否配合写文件（第三方写不写由下面那行观察报出来，不当门禁）。
    const strayDir = String(artAt?.outDir || SANDBOX)
    const STRAY = join(strayDir, 'stray-before-delivery.md')
    try { writeFileSync(STRAY, '交付前就在目录里、卡片没登记的文件。\n', 'utf-8') } catch (e) { console.log('  [cliwf] 前置文件没放进去（这条判据退化为只靠 CLI 写盘）：' + String(e).slice(0, 80)) }
    let fin = null
    for (let i = 0; i < 5; i++) {
      // 必须等"门真的挂出来了"或终态：waiting_review 是审核跑完的中间态，那一刻 gate 还是 null，
      // 在它上面点批准是空操作（实测就这么把循环 4 次烧光、任务根本没交付，红的是测的写法）
      fin = await waitJs(cdp, `(() => {
        const r = window.__ahub_debug.state().run
        if (!r) return null
        const done = ['completed', 'failed', 'cancelled', 'timeout'].includes(r.status)
        if (done) return { status: r.status, outDir: r.outputDir, cards: r.cards, gateKind: r.gateKind ?? null, gated: false }
        if (r.gate) return { status: r.status, outDir: r.outputDir, cards: r.cards, gateKind: r.gateKind ?? null, gated: true }
        return null
      })()`, 240000)
      if (!fin || !fin.gated) break
      await js(cdp, 'window.__ahub_debug.passGate()')
      await sleep(4000)
    }
    const effDir = String(fin?.outDir || SANDBOX)
    const diskFiles = (existsSync(effDir) ? readdirSync(effDir, { withFileTypes: true }) : [])
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
    const arts = await js(cdp, `(() => (window.__ahub_debug.state().run?.cardDetails || []).flatMap((c) => c.artifacts || []))()`)
    const idxPath = join(effDir, '产物索引.md')
    const idx = existsSync(idxPath) ? readFileSync(idxPath, 'utf-8') : ''
    const unexplained = diskFiles.filter((f) => !arts.some((a) => String(a).includes(f)) && !idx.includes('`' + f + '`'))
    console.log('  [cliwf] 终态 =', JSON.stringify(fin), '· 目录文件 =', JSON.stringify(diskFiles),
      '· CLI 真写了 cli-note.md =', diskFiles.includes('cli-note.md'), '· 索引条目 =', (idx.match(/^- /gm) || []).length,
      '· 卡片登记的产物 =', JSON.stringify(arts).slice(0, 260))
    ok('交付把产物目录里每个真实存在的文件都交代过（卡片登记过 或 产物索引如实列出），没有一个被悄悄漏掉',
      fin?.status === 'completed' && diskFiles.length > 0 && unexplained.length === 0,
      JSON.stringify({ status: fin?.status, diskFiles, unexplained }))
    // 上一条会被"目录里本来就只有登记过的文件"混过去，这条按构造钉死：文件是套件自己放的，
    // 卡片一定没登记过它，产品要么在索引里列出，要么红。
    ok('交付按目录实况如实列出"卡片没登记过"的那个文件（不是只列 AgentHub 自己写的那几个）',
      idx.includes('`stray-before-delivery.md`') || arts.some((a) => String(a).includes('stray-before-delivery.md')),
      JSON.stringify({ inIndex: idx.includes('`stray-before-delivery.md`'), 索引条目: (idx.match(/^- /gm) || []).length, 卡片产物: arts.length }))
  } catch (e) {
    console.error('[cliwf] 失败：' + (e?.stack || e?.message || e))
    fail++
  } finally {
    await restoreWfHome(cdp, homePrev)
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
