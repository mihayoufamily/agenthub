// UI 布局与新功能真机核验（CDP 驱动便携版）
// 用法：node verify/ui-shot.mjs [--exe=d:/AgentHub/AgentHub.exe] [--port=9231]
// 会写入真实 %APPDATA%/agenthub：整份 config.json 在动任何配置**之前**按字节快照，
// 收尾等实例退净后按字节还原（修复波 B · 项 1b；此前只删本次新增的 Mock Agent 与任务记录，
// 角色绑定 workflowDefaults 不回滚，见文件内注释），审批历史不进这个套件。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs, ensureWfHome, restoreWfHome, waitHydrated } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const EXE = resolve(args.exe ?? 'd:/AgentHub/AgentHub.exe')
const PORT = Number(args.port ?? 9231)
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, 'shots-ui')
const SANDBOX = mkdtempSync(join(tmpdir(), 'ahub-ui-'))
const AGENT_NAME = 'Mock 工具验证'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

// ---------- mock OpenAI 兼容服务：第 1 轮要工具调用，第 2 轮出正文 + 用量明细 ----------
writeFileSync(join(SANDBOX, 'note.md'), '# 说明\nTODO 待补\n')
mkdirSync(join(SANDBOX, 'src'), { recursive: true })
writeFileSync(join(SANDBOX, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(SANDBOX, 'src', 'b.md'), 'TODO src\n')

const seen = { requests: [], bodies: [] }
const mock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'deepseek-chat' }] }))
    return
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', async () => {
      seen.requests.push(req.url)
      try { seen.bodies.push(JSON.parse(raw)) } catch { seen.bodies.push({}) }
      const n = seen.requests.length
      const body = seen.bodies[n - 1] ?? {}
      // 第二个任务的执行角色改为真实写文件：核验 by='tool' 产物登记 + 沙箱根确实切到了产物目录
      const execWrite = n % 2 === 1 &&
        JSON.stringify(body.messages?.[0] ?? '').includes('执行 Agent') &&
        JSON.stringify(body).includes('交付一个文件产物')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      // 每轮都先给思考增量（工作台折叠块与工作流卡片过程区都要能收到）
      // 四段：两段过场（应被折叠）+ 两段高信号（应保留）——同时核验"默认只显重点"
      for (const t of ['让我先看看目录里有什么。\n\n', '我先读一下 README 确认结构。\n\n', '因此需要先 glob 出所有 markdown 文件，再决定改哪个。\n\n', '风险：没有验证就没有交付物。']) {
        send({ choices: [{ index: 0, delta: { reasoning_content: t } }] })
        await sleep(80)
      }
      if (n % 2 === 1) {
        const tool = execWrite
          ? { name: 'write_file', arguments: JSON.stringify({ path: '交付说明.md', content: '# 交付说明\n由执行角色真实写入产物目录的文件。\n' }) }
          : { name: 'glob_files', arguments: JSON.stringify({ pattern: '**/*.md' }) }
        send({
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_' + n, function: tool }] },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 800, completion_tokens: 40, total_tokens: 840 }
        })
      } else if (JSON.stringify(body).includes('SENTINEL-EMPTY-PLAN')) {
        // 计划正文为空的那一档：本轮什么都不返回，只给 stop。
        // 用来验"空计划不许批准"——这个形状在正常 mock 输出下永远造不出来，只能服务侧配合
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } })
      } else {
        for (const t of ['找到了 ', '两个 markdown 文件：', 'note.md 与 src/b.md。']) {
          send({ choices: [{ index: 0, delta: { content: t } }] })
          await sleep(80)
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404).end('{}')
})

/** 布局客观审计：视口溢出 + 可见横向溢出元素 */
const layoutAudit = () => js(cdp, `(() => {
  const vw = document.documentElement.clientWidth
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 48)
    if (r.right > vw + 1) out.push({ kind: 'viewport-overflow', cls, right: Math.round(r.right), vw })
    const cs = getComputedStyle(el)
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'visible' && el.clientWidth > 40) {
      out.push({ kind: 'scroll-overflow', cls, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })
    }
  }
  return { vw, vh: document.documentElement.clientHeight, issues: out.slice(0, 12), total: out.length }
})()`)

const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const p = join(OUT, name + '.png')
  writeFileSync(p, Buffer.from(s.data, 'base64'))
  console.log('  截图  ' + p)
}

const typeInto = (sel, text) => js(cdp, `(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

const clickText = (text, sel = 'button') => js(cdp, `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}))
  if (!el) return false
  el.click(); return true
})()`)

let cdp
let proc
// 用户原本的产物目录：必须在动它之前记下，并且无论本轮是否跑完都要还原
// （此前只在正常走完时还原，中途被打断就把配置留在测试沙箱路径上了）
let prevOutDir = null
// ---- 修复波 B · 项 1b：整份 config.json 的字节快照 + 还原（照 approval-shot 已有的模式，别自创）----
// 根因（A 波 concern 4 / 报告 §11.6、§12）：src/renderer/src/lib/debug.ts 的 startMockToolTask 走
// patchConfig 改的是用户**全局角色绑定 workflowDefaults**，而收尾只按名字删 Mock Agent（removeAgentByName），
// 绑定不回滚 → 一轮 ui-shot 之后 workflowDefaults 三个 id 指向已删的 Mock Agent，水合时审核角色
// 回落成「本地 · 自动」。真机层写的是用户真实 %APPDATA%\agenthub，这是脚手架在写用户的真配置，
// A 波那三次还原是人肉补的，不该指望人肉。快照按文件字节取，workflowDefaults 三个 id 天然在范围内；
// 还原后再显式核对那三个 id，作为"还原真的跑了"的断言。
let cfgFile = null
let configSnapshot = null
let snapshotDefaults = null
// 残留实例在场时禁止回写（同 approval-shot 的闸门）：往活实例正在用的 config.json 里写字节，
// 它退出时又会把内存里的测试态盖回来，用户配置就留在测试中间态了。
let snapshotWriteAllowed = true
// 套件起跑前用户正打开着哪个任务（收尾把视图还回去；记录本身从不删）
let homePrev = ''

/** 等 AgentHub.exe 退干净：回写快照前必须确认没有活实例（与 approval-shot 同一实现口径） */
function waitAppGone(timeoutMs = 30000) {
  const t0 = Date.now()
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (;;) {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq AgentHub.exe', '/NH'], { encoding: 'utf-8' })
    if (!/AgentHub\.exe/i.test(r.stdout ?? '')) return true
    if (Date.now() - t0 > timeoutMs) return false
    sleepMs(400)
  }
}

/** 从 config.json 字节里取 workflowDefaults 的三个角色 id（快照与还原后各取一次做对照） */
const defaultsOf = (buf) => {
  try {
    const wd = JSON.parse(String(buf ?? '').toString())?.workflowDefaults ?? {}
    return { planner: wd.plannerAgentId ?? null, executor: wd.executorAgentId ?? null, reviewer: wd.reviewerAgentId ?? null }
  } catch {
    return null
  }
}

const setViewport = async (w, h) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
}

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  let baseUrl = null
  // 修复波 B · 项 1 的同类（评审 Minor ㉛ 在 approval-shot 那条）：listen 与 try 之间原来还夹着
  // baseUrl、起跑前清扫、spawn 三步，任一抛异常就没有 finally 去 close 那个监听中的 socket，
  // 进程因活跃 handle 永不退出——表现是"套件挂住"而不是"套件失败"（比红更糟）。现在收进同一个 try/finally。
  try {
    await new Promise((r) => mock.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${mock.address().port}/v1`
    console.log('[ui] mock 服务：' + baseUrl + '，沙箱：' + SANDBOX)

    // 起跑前先把"上一轮本套件自己留下的、没跑完的任务记录"扫掉（必须在 spawn 之前：应用一启动就会把
    // runs/*.json 里 status 还是 preparing/running 的记录恢复成任务视图，工作流首页于是根本不在 DOM 里，
    // 第 6/6c 步那几条断言会连带红——实测踩过：一次中途崩溃的 ui-shot 把后面两轮都带歪）。
    // 判据只认"产物目录落在本套件的临时沙箱名下"（ahub-ui-*），用户自己跑的任务的 outputDir 不可能是这个
    // 形态，所以这条清理不会碰用户数据；本轮自己新增的记录仍由收尾处按 runsBefore 差集删除。
    {
      const runsDir0 = join(process.env.APPDATA ?? '', 'agenthub', 'runs')
      let swept = 0
      for (const f of existsSync(runsDir0) ? readdirSync(runsDir0) : []) {
        if (!f.endsWith('.json')) continue
        try {
          const rec = JSON.parse(readFileSync(join(runsDir0, f), 'utf-8'))
          if (typeof rec?.outputDir === 'string' && /[\\/]ahub-ui-/.test(rec.outputDir)) {
            rmSync(join(runsDir0, f), { force: true })
            swept++
          }
        } catch { /* 读不动的记录不动它：宁可少删，不可误删 */ }
      }
      if (swept) console.log(`  清理  起跑前扫掉上一轮遗留的套件任务记录 ${swept} 个`)
    }

    proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
    const page = await waitHttp(PORT, 30000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    if (!(await waitJs(cdp, '!!window.__ahub_debug', 30000))) throw new Error('页面未就绪')

    // 等水合完成再取基线：__ahub_debug 比 store 水合早几十毫秒就绪，读太早会拿到 0 个 Agent
    await waitJs(cdp, 'window.__ahub_debug.state().agents.length > 0 || !!window.__ahub_debug.state().selectedId', 15000)
    // 起跑前先扫掉本套件专用名的残留（批次 F 复核定位到的偶发根因）：
    // 一次中途崩掉的运行会把「Mock 工具验证」留在用户配置里，而收尾的按字节还原又把快照里
    // 那份脏基线写回去 → 下一轮基线=用户 5 + 残留 3，清理（正确地）删干净后得到 5，
    // "清理后 Agent 数回到基线"于是红，而红的不是被测代码。
    // 扫在取基线与快照**之前**：这样基线与快照都只含用户自己的 Agent，红才是真红。
    const staleMocks = await js(cdp, `(() => window.__ahub_debug.state().agents.filter((a) => a.name === ${JSON.stringify(AGENT_NAME)}).length)()`)
    if (staleMocks > 0) {
      await js(cdp, `window.__ahub_debug.removeAgentByName(${JSON.stringify(AGENT_NAME)})`)
      await sleep(1500) // 等持久化落盘：快照要在"干净"之后取
      console.log(`  清理  起跑前扫掉上一轮遗留的 ${staleMocks} 个「${AGENT_NAME}」Agent（不扫就会污染基线与快照）`)
    }
    const before = await js(cdp, 'window.__ahub_debug.state()')
    console.log('[ui] 启动前 Agent 数：' + before.agents.length)
    prevOutDir = before.configOutputDir ?? ''
    console.log('[ui] 用户产物目录（结束时要还原成这个）：' + JSON.stringify(prevOutDir))
    const RUNS_DIR = join(process.env.APPDATA ?? '', 'agenthub', 'runs')
    const runsBefore = new Set(existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : [])
    // 快照必须在**动任何配置之前**取（addMockToolAgent / startMockToolTask / setWorkflowOutputDir 都在它后面）。
    // 落点问应用自己要（与 approval-shot 同一取法），不猜路径；猜错会把字节写进另一个文件，比不写更糟。
    const appUserData = String((await js(cdp, 'window.agenthub.app.info()'))?.userDataPath ?? '')
    cfgFile = join(appUserData || join(process.env.APPDATA ?? '', 'agenthub'), 'config.json')
    // 落点核对按**文件身份**比，不按字面字符串比（收尾 C1 实测修的红）：
    // Windows 上 app.getPath('userData') 拼出来是包名大小写 `…\Roaming\AgentHub`，磁盘上的目录名却是
    // `agenthub`，而 NTFS 大小写不敏感 → 两个路径 stat 出来的 dev/ino 完全相同，是同一个目录里的同一份文件
    // （实测 statSync 两边 dev=2461287389 ino=4785074604607996 size 都是 3588）。
    // 原来的 `resolve(a) === resolve(b)` 把这条真断言判成永久假红。现在：两边都存在就比 dev+ino（比字符串比较更强，
    // 换目录/换文件一定红），任一不存在就退回忽略大小写的路径比较（大小写差异在 Windows 上不可能表示两个目录）。
    const scriptCfgFile = join(process.env.APPDATA ?? '', 'agenthub', 'config.json')
    const sameConfigFile = (() => {
      try {
        const a = statSync(cfgFile), b = statSync(scriptCfgFile)
        return a.dev === b.dev && a.ino === b.ino
      } catch {
        return resolve(cfgFile).toLowerCase() === resolve(scriptCfgFile).toLowerCase()
      }
    })()
    ok('快照落点核对：应用报的 userDataPath 就是本套件会写的那份配置目录（写错文件比不写更糟）',
      sameConfigFile,
      `应用=${appUserData || '(拿不到，退回 APPDATA)'} 脚本按 APPDATA=${join(process.env.APPDATA ?? '', 'agenthub')} 同一份文件=${sameConfigFile}`)
    configSnapshot = existsSync(cfgFile) ? readFileSync(cfgFile) : null
    snapshotDefaults = defaultsOf(configSnapshot)
    console.log(`[ui] config.json 快照：${cfgFile} · ${configSnapshot?.length ?? 0} 字节 · workflowDefaults=${JSON.stringify(snapshotDefaults)}`)
    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(700)

    // ---- 1. 添加带工具授权的 mock 模型 Agent（顺带验证连接测试 + 模型白名单）----
    const agentId = await js(cdp, `window.__ahub_debug.addMockToolAgent(${JSON.stringify(baseUrl)}, ${JSON.stringify(SANDBOX)}, false)`)
    ok('添加 mock 模型 Agent（连接测试 + 白名单校验通过）', typeof agentId === 'string' && agentId.length > 0, String(agentId))
    await js(cdp, 'window.__ahub_debug.workbench()')
    await sleep(1500)
    await shot('01-workbench-model-agent')

    // ---- 2. 真实流式对话：思考增量 -> 工具调用（glob_files）-> 正文 -> 用量 ----
    ok('注入输入', await typeInto('.wb-composer-wrap textarea, .composer textarea', '列出沙箱里的 markdown 文件'))
    await sleep(400)
    ok('点击发送', await js(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发送' && !b.disabled); if (!b) return false; b.click(); return true })()`))
    const mid = await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); return s.streamKeys.length > 0 && !!document.querySelector('.reasoning-block') })()`, 20000)
    ok('思考过程块出现（reasoning_content 流式渲染）', !!mid)
    if (mid) await shot('02-reasoning-streaming')
    const done = await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); const k = ${JSON.stringify(agentId)}; return s.sessions[k] && s.sessions[k].counts[0] >= 2 && s.streamKeys.length === 0 })()`, 40000)
    ok('对话完成（消息 >=2 且流结束）', !!done)
    await sleep(600)
    await shot('03-reply-tool-usage')

    // 工具真实执行 + 用量明细断言（读 DOM 与 mock 收到的请求体）
    const toolCard = await js(cdp, `(() => { const el = document.querySelector('.tool-call-card'); return el ? el.textContent.slice(0, 160) : null })()`)
    ok('工具调用卡片渲染（glob_files，UI 显示中文名）', !!toolCard && /(glob_files|查找文件)/.test(toolCard), String(toolCard))
    const meta = await js(cdp, `(() => { const el = [...document.querySelectorAll('.msg-time')].pop(); return el ? el.textContent : null })()`)
    // mock-model 无公开单价：按设计只显示 token 不折算金额（pricing.ts 不编造价格）
    ok('消息元信息含入/出明细（mock-model 不显示 ¥ 为设计行为）', !!meta && /入\s*[\d.]/.test(meta) && /出\s*[\d.]/.test(meta), String(meta))
    ok('mock 收到两轮请求（工具循环真实回传）', seen.requests.length === 2, 'requests=' + seen.requests.length)
    const toolMsg = seen.bodies[1]?.messages?.some((m) => m.role === 'tool')
    ok('第二轮请求体带 tool 结果', !!toolMsg)
    ok('工具结果含真实文件名', JSON.stringify(seen.bodies[1]?.messages ?? '').includes('note.md'))

    // ---- 2a. 对话栏底部条：模型选择与费用离输入框最近（本轮需求 2）----
    const bar = await js(cdp, `(() => {
      const b = document.querySelector('.wb-composer-wrap .ctx-bar')
      if (!b) return null
      const chip = b.querySelector('button.model-chip')
      return { chip: chip ? chip.textContent.trim() : null, text: b.textContent, topbarModel: !!document.querySelector('.wb-topbar button[title^="模型管理"]') }
    })()`)
    ok('对话栏底部条含模型选择 chip', !!bar && !!bar.chip, JSON.stringify(bar))
    ok('模型管理入口已从顶栏移入对话栏', !!bar && bar.topbarModel === false)
    ok('对话栏显示本会话消耗（token/费用）', !!bar && /本会话/.test(bar.text) && /(¥|tokens)/.test(bar.text), String(bar && bar.text).slice(0, 140))

    // ---- 2b. 思考摘要：默认只显重点段，其余一键展开（本轮需求 4）----
    ok('展开思考块', await js(cdp, `(() => { const b = document.querySelector('.reasoning-block .rb-head'); if (!b) return false; b.click(); return true })()`))
    await sleep(500)
    const th = await js(cdp, `(() => {
      const v = document.querySelector('.thinking-view')
      if (!v) return null
      const btn = v.querySelector('.link-btn')
      return { shown: v.querySelector('.tv-body')?.textContent ?? '', btn: btn ? btn.textContent.trim() : null }
    })()`)
    ok('长思考默认折叠过场段、保留高信号段', !!th && /因此需要先 glob/.test(th.shown) && !/让我先看看目录里有什么/.test(th.shown), String(th && th.shown).slice(0, 90))
    ok('提供"展开其余 N 段思考"入口', !!th && /展开其余 \d+ 段思考/.test(th.btn ?? ''), String(th && th.btn))
    if (th) {
      await js(cdp, `(() => { document.querySelector('.thinking-view .link-btn')?.click(); return true })()`)
      await sleep(400)
      const full = await js(cdp, `(() => { const v = document.querySelector('.thinking-view .tv-body'); return v ? v.textContent : null })()`)
      ok('展开后回到完整原文（不丢内容）', !!full && full.includes('让我先看看目录里有什么'), String(full).slice(0, 60))
      // 收起入口必须可见可点：曾因滚动容器把按钮压在折叠底部而收不回去
      const btnBox = await js(cdp, `(() => {
        const btn = document.querySelector('.thinking-view .link-btn')
        if (!btn) return null
        const r = btn.getBoundingClientRect()
        let clipped = false
        for (let p = btn.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p)
          if (/(auto|scroll|hidden)/.test(cs.overflowY) && r.bottom > p.getBoundingClientRect().bottom + 1) clipped = true
        }
        return { clipped, inViewport: r.top >= 0 && r.bottom <= innerHeight, text: btn.textContent.trim() }
      })()`)
      ok('展开后「收起其余思考」入口未被滚动区裁掉', !!btnBox && !btnBox.clipped && btnBox.inViewport, JSON.stringify(btnBox))
    }
    await shot('03c-thinking-digest')

    // ---- 2b. 切到有公开单价的模型：验证费用显示（deepseek-chat 在单价表内）----
    ok('打开模型管理', await js(cdp, `(() => { const c = document.querySelector('button.model-chip[title^="模型管理"]'); if (!c) return false; c.click(); return true })()`))
    await sleep(1200)
    // 批次 D「唯一编辑入口」（Task 8）的界面这一半：常驻提示词在弹窗里必须是只读展示块，
    // 那一格旁边不许再有可写控件——同一字段两处可写必然漂移。
    // 判据按"那一格里有没有 textarea/input"算，不按值长度算：提示词没设时值是空串，
    // 用值长度当判据的话，有人把 textarea 加回来也测不出来。
    const promptRo = await js(cdp, `(() => {
      const ro = document.querySelector('[data-prompt-readonly]')
      const modal = ro?.closest('.modal') ?? null
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight
      const b = ro?.getBoundingClientRect()
      const rows = [...document.querySelectorAll('.modal .form-row')]
        .filter((row) => /常驻提示词/.test(row.querySelector('label')?.textContent ?? ''))
      return {
        has: !!ro,
        inModal: !!modal,
        visible: !!b && b.width > 2 && b.height > 2 && b.top >= 0 && b.bottom <= vh + 1 && b.left >= 0 && b.right <= vw + 1,
        rowFound: rows.length,
        editableControls: rows.reduce((n, row) => n + row.querySelectorAll('textarea, input').length, 0)
      }
    })()`)
    ok('弹窗里的常驻提示词是只读块、在弹窗内且完整看得见（不是只挂在 DOM 上）',
      promptRo.has === true && promptRo.inModal === true && promptRo.visible === true && promptRo.rowFound === 1,
      JSON.stringify(promptRo))
    ok('那一格旁边没有可写的提示词控件（唯一编辑入口在侧栏卡片，两处可写必然漂移）',
      promptRo.editableControls === 0, JSON.stringify(promptRo))
    ok('切换到 deepseek-chat（列表来自真实 /models）', await js(cdp, `(() => { const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.trim().startsWith('deepseek-chat') && !x.disabled); if (!b) return false; b.click(); return true })()`))
    await sleep(600)
    await js(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '完成'); b?.click(); return true })()`)
    await sleep(500)
    ok('注入第二条输入', await typeInto('.wb-composer-wrap textarea, .composer textarea', '再列一次'))
    await sleep(400)
    await js(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发送' && !b.disabled); b?.click(); return true })()`)
    const done2 = await waitJs(cdp, `(() => { const s = window.__ahub_debug.state(); const k = ${JSON.stringify(agentId)}; return s.sessions[k] && s.sessions[k].counts[0] >= 4 && s.streamKeys.length === 0 })()`, 40000)
    ok('第二条对话完成', !!done2)
    const meta2 = await js(cdp, `(() => { const el = [...document.querySelectorAll('.msg-time')].pop(); return el ? el.textContent : null })()`)
    ok('有单价模型显示本轮费用（¥）', !!meta2 && /¥/.test(meta2), String(meta2))
    await shot('03b-cost-display')

    // ---- 3. 工具授权面板（沙箱 / 完全访问两档）----
    const chip = await js(cdp, `(() => { const c = [...document.querySelectorAll('.model-chip')].find(x => x.textContent.includes('工具')); if (!c) return null; c.click(); return c.textContent.trim() })()`)
    ok('顶栏工具 chip 存在并可点开', !!chip, String(chip))
    await sleep(700)
    await shot('04-tools-grant-sandbox')
    const fullRadio = await js(cdp, `(() => { const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('完全访问')); const r = l?.querySelector('input[type=radio]'); if (!r) return false; r.click(); return true })()`)
    ok('可切到「完全访问」档', fullRadio)
    await sleep(500)
    await shot('05-tools-grant-full-access')
    const risk = await js(cdp, `(() => { const el = [...document.querySelectorAll('label,div')].find(x => x.textContent.includes('我已知晓')); return !!el })()`)
    ok('完全访问需风险确认（二次确认存在）', risk)
    // 不保存，直接关闭面板
    await js(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '取消' || x.textContent.trim() === '关闭'); b?.click(); return true })()`)
    await sleep(500)

    // ---- 4. 窄窗口布局审计（长 chip 文案 + 徽章是否溢出）----
    for (const [w, h, tag] of [[1280, 800, '1280'], [1024, 720, '1024'], [860, 640, '860'], [720, 560, '720']]) {
      await setViewport(w, h)
      const audit = await layoutAudit()
      ok(`${tag}px 宽无横向溢出`, audit.total === 0, JSON.stringify(audit.issues?.slice(0, 4)))
      if (tag === '860' || tag === '720') await shot(`06-narrow-${tag}`)
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(400)

    // ---- 5. 设置页：Skill / Agent 与模型（余额、用量）----
    // 修复波 B · 项 1（评审 Minor ㉘）：debug.ts 里 settings() 与 openSettings() 是同一件事的两个名字
    // （settings 就是不带分区的 openSettings），并存会让"打开设置"在脚本里看起来有两种动作。
    // 统一到修复波 A 实际用的那一个（openSettings），语义逐字节相同：openSettings(undefined) → settingsSection: null。
    await js(cdp, 'window.__ahub_debug.openSettings()')
    await sleep(900)
    ok('打开 Skill 分区', await clickText('Skill'))
    await sleep(700)
    await shot('07-settings-skill')
    const skillAudit = await layoutAudit()
    ok('Skill 分区无横向溢出', skillAudit.total === 0, JSON.stringify(skillAudit.issues?.slice(0, 4)))
    ok('打开 Agent 与模型分区', await clickText('Agent 与模型'))
    await sleep(900)
    await shot('08-settings-agents')
    const agentAudit = await layoutAudit()
    ok('Agent 与模型分区无横向溢出', agentAudit.total === 0, JSON.stringify(agentAudit.issues?.slice(0, 4)))
    const balance = await js(cdp, `(() => { const t = document.body.innerText; return { hasBalance: /余额/.test(t), hasUsage: /用量|Token|token/.test(t) } })()`)
    ok('设置页存在余额/用量入口', balance.hasBalance || balance.hasUsage, JSON.stringify(balance))
    await js(cdp, `(() => { document.querySelector('button[aria-label="关闭设置"]')?.click(); return true })()`)
    await sleep(800)
    // C3：用量统计页的环（内圈按接入方、外圈按模型）+ 未上报按次数单列 + 文案不出现"双环"
    await js(cdp, `window.__ahub_debug.openSettings('usage')`)
    await sleep(1400)
    const rings = await js(cdp, `(() => {
      // 必须限定在用量面板里查：DonutRings 的壳类名两处共用（设置页双圈 + 对话栏迷你环），
      // 不加作用域会先命中对话栏那个迷你环，量到的就是错的对象。
      // （别在这段注释里写反引号：整块在模板字符串里，反引号会把字符串提前关掉。）
      const wrap = document.querySelector('.usage-panel .usage-rings') || document.querySelector('.modal .usage-rings')
      return {
        hasSvg: !!wrap && !!wrap.querySelector('svg'),
        inner: wrap ? wrap.querySelectorAll('path[data-ring="inner"]').length : 0,
        outer: wrap ? wrap.querySelectorAll('path[data-ring="outer"]').length : 0,
        unreported: wrap ? wrap.querySelector('[data-unreported]')?.getAttribute('data-unreported') ?? null : 'MISSING',
        noDoubleWord: !document.body.innerText.includes('双环')
      }
    })()`)
    ok('用量统计页画出占比环，内圈按接入方、外圈按模型（两侧都有扇区）',
      rings.hasSvg && rings.inner >= 1 && rings.outer >= 1, JSON.stringify(rings))
    ok('未上报 usage 的调用按次数单列一格（不折算成 token）', rings.unreported !== 'MISSING' && rings.unreported !== null, JSON.stringify(rings))
    ok('界面文案不出现"双环"（决策记录 A13：对话栏接受尺寸缩水，不拿它当卖点）', rings.noDoubleWord === true, JSON.stringify(rings))
    await js(cdp, `window.__ahub_debug.closeSettings()`)
    await sleep(700)
    ok('设置弹窗已关闭', !(await js(cdp, '!!document.querySelector(".settings-win")')))

    // C3 对话栏：原图标按钮位置换成单环迷你图，位置与点击行为不变、底部条不加高（决策记录 A13）
    await js(cdp, 'window.__ahub_debug.workbench()')
    await sleep(1500)
    const mini = await js(cdp, `(() => {
      const btn = document.querySelector('.ctx-bar .usage-open')
      if (!btn) return { found: false }
      const bar = document.querySelector('.ctx-bar')
      const wrap = btn.querySelector('[data-mini-ring]')
      return {
        found: true,
        rows: wrap ? Number(wrap.getAttribute('data-mini-rows')) : 0,
        hasRing: !!btn.querySelector('[data-mini-ring] svg'),
        h: Math.round(bar.getBoundingClientRect().height),
        label: btn.getAttribute('aria-label') || ''
      }
    })()`)
    // 判据不能写成 `hasRing || fallbackIcon`：旧图标也是 svg，那样整个 Task 5 回退掉套件照样绿
    // （评审实测 91/0）。有可见调用就必须见环，只有真没数据才允许退回图标。
    ok('对话栏底部：有账本可见调用时必须是单环迷你图（无数据才允许退回原图标）',
      mini.found && (mini.rows === 0 ? true : mini.hasRing === true), JSON.stringify(mini))
    // 底部条的像素高度**只报不判**：34px 这个阈值是我自己拍的、没在改动前量过，拿它当判据等于让产品去够一个
    // 没根据的数。真要比得先在同一构建上量"换图前/换图后"两次——那属于观感核，spec 本来就把 C2/C3 的观感
    // 列在"需人工核"里。位置不变与点击行为不变由上面两条真断言钉住。
    console.log(`  观察  对话栏底部条高度 = ${mini.h}px（换图前后是否变化需人工比截图）`)
    ok('底部条文案不出现"双环"（决策记录 A13）', !mini.label.includes('双环'), JSON.stringify(mini))
    await js(cdp, `(() => { const b = document.querySelector('.ctx-bar .usage-open'); b && b.click(); return true })()`)
    await sleep(900)
    ok('点迷你图仍打开本 Agent 的用量弹窗（换图不改行为）',
      await js(cdp, `!!document.querySelector('.modal .usage-rings, .modal .usage-panel')`), '点了没出弹窗')
    await js(cdp, `(() => { document.querySelector('.modal [aria-label="关闭"]')?.click(); return true })()`)
    await sleep(500)

    // 批次 D：侧栏 ⋯ 扩成 Agent 管理卡片（常驻提示词 + Skill 注入方式 + Skill 清单），
    // 且它是唯一编辑入口——同一字段两处可写必然漂移。
    // 点击与观察分两次求值：React 18 不会在同一个任务里提交状态更新，
    // 同一次求值里 querySelector 拿到的是点击前的 DOM（这个坑本轮已踩过两次）。
    await js(cdp, `(() => { document.querySelector('.agent-item .more')?.click(); return true })()`)
    await sleep(600)
    const card = await js(cdp, `(() => {
      const wrap = document.querySelector('.agent-menu')
      const c = wrap && wrap.querySelector('[data-agent-card]')
      if (!c) return { found: !!wrap, card: false }
      return {
        found: true, card: true,
        hasPrompt: !!c.querySelector('textarea'),
        hasSkillMode: !!c.querySelector('[data-skill-mode]'),
        hasSkillList: !!c.querySelector('[data-skill-pick]'),
        keepsOld: /重命名/.test(wrap.innerText) && /移除/.test(wrap.innerText)
      }
    })()`)
    ok('侧栏 ⋯ 展开的是 Agent 管理卡片（常驻提示词 + Skill 注入方式 + Skill 清单）',
      card.card && card.hasPrompt && card.hasSkillMode && card.hasSkillList, JSON.stringify(card))
    ok('原有两项（重命名 / 移除）仍在卡片里，没被这次扩展挤掉', card.keepsOld === true, JSON.stringify(card))
    const fits = await js(cdp, `(() => {
      const m = document.querySelector('.agent-menu'); if (!m) return null
      const r = m.getBoundingClientRect()
      return { inside: r.top >= 0 && r.bottom <= window.innerHeight + 1, h: Math.round(r.height) }
    })()`)
    ok('卡片变高后菜单仍完整落在视口内（翻转判定按实际高度，不再按 82px 猜）', !!fits && fits.inside, JSON.stringify(fits))
    await js(cdp, `(() => { document.body.click(); return true })()`)
    await sleep(400)

    // ---- 6. 工作流首页（保存任务卡片是否遮挡）----
    // 先确认视图在首页：应用一启动会恢复用户上次打开的任务，那时首页 composer 不在 DOM 里，
    // 下面两条溢出审计会量到 null（量的不是产品）。收尾把视图还回去。
    homePrev = (await ensureWfHome(cdp)).prev
    // C1 的三条断言量的是**品牌首页**的 pill，而上面那行 ensureWfHome 只关任务、不改屏
    // （closeTask 里没有 setScreen），此刻应用还停在第 2～5 步留下的 workbench 屏，
    // .mode-pill-wrap 根本不在 DOM 里。先显式回品牌首页再量，否则绿红量的都不是被测对象。
    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(700)
    // C1：模式选择从右上角绝对定位下移到输入卡下方；hover/聚焦出介绍；一点选中、二点进入
    const pillBox = await js(cdp, `(() => {
      const wrap = document.querySelector('.mode-pill-wrap')
      const ask = document.querySelector('.home-ask') || document.querySelector('.home-composer-wrap')
      if (!wrap || !ask) return null
      const w = wrap.getBoundingClientRect(), a = ask.getBoundingClientRect()
      return { belowAsk: w.top >= a.bottom - 2, topFromAsk: Math.round(w.top - a.bottom) }
    })()`)
    ok('模式选择 pill 已下移到输入卡下方（不再钉在视口右上角）', !!pillBox && pillBox.belowAsk, JSON.stringify(pillBox))
    // 计划里这两条写成"一次求值里既按下又读 DOM"，真机量不到，原因都不在产品（一次性探针实测：
    // focus() 之后 20ms 卡片就在 DOM 里了、同一次求值里读是 false；同一次求值连点两次 aria-checked
    // 已经变 true 但 onClick 拿到的是上一次的渲染快照）：
    // ① React 的 onMouseEnter 由原生 mouseover/mouseout 派生，直接派发 MouseEvent('mouseenter') 它收不到
    //    → 悬浮这条路改用 CDP Input.dispatchMouseEvent 走真鼠标，不拿"派发成功"当"用户悬浮过"；
    // ② React 18 把事件里的更新排到下一个任务提交（真人的一次动作与一次观察本来就在两个任务里）
    //    → 动作与观察分两次求值，与本套件其余各条同一个写法。
    // 判据口径（修复轮 1 · Important-2）：Ruling T1-a 的全部理由就是"DOM 在 ≠ 用户看得见"——
    // static 定位会把卡片推出视口而 `querySelector` 照样拿得到。同一把尺子必须量回断言本身，
    // 所以这里不只问"卡片在不在 DOM"，还要求它整张落在视口内（top>=0 且 bottom<=innerHeight）；
    // 否则产品换个方式回退（z-index / margin / transform）这条依然是绿的。
    // parts（逐分行高）：FAIL 时直接指认是哪一行把卡片撑出视口的；960×640 那档每轮都另打一行
    // `[mode-info@960x640]`，所以余量漂没漂是写在每次输出里的，不用等红了再来一轮。
    const infoProbe = `(() => {
      const e = document.querySelector('.mode-info')
      if (!e) return { open: false }
      const r = e.getBoundingClientRect()
      return {
        open: true,
        title: String(e.querySelector('.mi-title')?.textContent ?? '').trim(),
        top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight,
        visible: r.top >= 0 && r.bottom <= window.innerHeight,
        parts: [...e.children].map((c) => (typeof c.className === 'string' ? c.className : '') + '=' + Math.round(c.getBoundingClientRect().height))
      }
    })()`
    const pillPt = await js(cdp, `(() => {
      const b = document.querySelector('.mode-pill-wrap [data-mode="workbench"]')
      if (!b) return null
      const q = b.getBoundingClientRect()
      return { x: Math.round(q.x + q.width / 2), y: Math.round(q.y + q.height / 2) }
    })()`)
    let hoverInfo = null
    if (pillPt) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pillPt.x, y: pillPt.y, button: 'none' })
      await sleep(400)
      hoverInfo = await js(cdp, infoProbe)
      // 收起：Escape 走既有的关闭路径，别让悬浮的余温冒充键盘那条路的成果
      await js(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
      await sleep(400)
    }
    await js(cdp, `(() => { document.querySelector('.mode-pill-wrap [data-mode="workbench"]')?.focus(); return true })()`)
    await sleep(400)
    const focusInfo = await js(cdp, infoProbe)
    // 标题也钉死（修复轮 1 · Minor）：悬浮/聚焦打开的必须是**工作站**那一台的卡片，
    // 只判"非空"的话，错模式的介绍卡一样能过。
    ok('悬浮或键盘聚焦会展开模式介绍（且介绍卡完整落在视口内，不只是 DOM 里存在）',
      !!hoverInfo?.open && hoverInfo.visible && hoverInfo.title === '工作站模式'
      && !!focusInfo?.open && focusInfo.visible && focusInfo.title === '工作站模式',
      JSON.stringify({ hoverInfo, focusInfo }))
    // 二次点击进入：先确认"第一点只选中、没进"，再确认"再点同一个才进"（少一面就退回
    // "点一下就进"或"点两下还在原地"这两种都被计划判为错的行为）
    const sel = await js(cdp, `(() => {
      const b = document.querySelector('.mode-pill-wrap [data-mode="workflow"]')
      if (!b) return { found: false }
      b.click()
      return { found: true }
    })()`)
    await sleep(400)
    const selected = await js(cdp, `(() => {
      const b = document.querySelector('.mode-pill-wrap [data-mode="workflow"]')
      return { checked: b?.getAttribute('aria-checked') ?? null, screen: window.__ahub_debug.state().screen }
    })()`)
    await js(cdp, '(() => { document.querySelector(\'.mode-pill-wrap [data-mode="workflow"]\')?.click(); return true })()')
    await sleep(600)
    const twoClick = await js(cdp, '(() => ({ screen: window.__ahub_debug.state().screen }))()')
    ok('同一个已选中的入口再点一次直接进入该模式',
      sel.found && selected.checked === 'true' && selected.screen === 'brand' && twoClick.screen === 'workflow',
      JSON.stringify({ ...selected, ...twoClick }))
    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(700)

    // C2：进入工作站的动画只在**真切模式**时播一次；重启恢复/切任务/切会话这类纯重挂载不播。
    // 根因不是观感：大字层原先没有状态位，`Workbench` 每次重挂载都重播，那才是"挡事"的地方。
    // 两次点击必须分两次求值：React 18 不会在同一个任务里提交第一次的 pendingMode 更新，
    // 同一次求值里的第二个 click 看到的仍是"未选中"，只会选中不会进入（Task 1 评审已指出这个测量机制坑）。
    // 两处 click 一律用 ?.：属性被改名/删掉时这里必须"点了个空"然后让下面那条断言报红，
    // 而不是抛 TypeError 把套件崩在中途——崩了只跑到 45/91，红是红了，但后面所有断言的报告都没了
    // （批次 C 评审的 Minor；上一窗那条"93/1 但红的是哪条没记下来"就是这么丢的）。
    await js(cdp, `(() => { document.querySelector('.mode-pill-wrap [data-mode="workbench"]')?.click(); return true })()`)
    await sleep(400)
    await js(cdp, `(() => { document.querySelector('.mode-pill-wrap [data-mode="workbench"]')?.click(); return true })()`)
    const entryPlayed = await js(cdp, `!!document.querySelector('[data-entry="1"]')`)
    ok('切进工作站时播进入动画（大字层带 data-entry 在场）', entryPlayed === true, String(entryPlayed))
    await sleep(1000) // 等 cause 被清掉（ENTRY_TOTAL_MS 780ms + 余量），否则下一条测的是残留
    const entryAfterRemount = await js(cdp, `(() => {
      window.__ahub_debug.workbench(); window.__ahub_debug.workbench()
      return !!document.querySelector('[data-entry="1"]')
    })()`)
    ok('纯重挂载不再播（cause 已清空：切会话/切任务/重启恢复不会再被大字挡一次）', entryAfterRemount === false, String(entryAfterRemount))
    await js(cdp, 'window.__ahub_debug.brand()')
    await sleep(600)
    // 修复轮 1 · Important-3（Ruling T1-e）：上一轮新增的 .mi-note（why 那句）把介绍卡撑到 228px，
    // 在应用自己的最小高度（src/main/index.ts:283 minHeight:640）下底部被裁 21px。
    // 上面那条悬浮/聚焦判的是**用户持久化窗口**这一档，本机窗口多大就量多大，绿红随环境漂；
    // 这一条把视口钉死到最小档，"卡片整张看不看得见"才有一个不随机器变的落点。
    // 照抄本套件既有的 Emulation.setDeviceMetricsOverride 写法（修复波 A · 项 7 同一先例）。
    await setViewport(960, 640)
    await js(cdp, `(() => { document.querySelector('.mode-pill-wrap [data-mode="workbench"]')?.focus(); return true })()`)
    await sleep(500)
    const infoMinBox = await js(cdp, infoProbe)
    console.log('  [mode-info@960x640] ' + JSON.stringify(infoMinBox))
    ok('应用自身最小高度（显式定视口 960×640）下模式介绍卡完整落在视口内',
      !!infoMinBox.open && infoMinBox.visible && infoMinBox.title === '工作站模式',
      `裁切=${infoMinBox.bottom - infoMinBox.vh}px ${JSON.stringify(infoMinBox)}`)
    await js(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await sleep(300)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(400)
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(1200)
    await shot('09-workflow-home')
    // ---- 修复波 A · 项 7：这一段显式定视口，不拿"用户上次把窗口拖成多大"当被测宽度 ----
    // 第 4 步跑完窄窗阶梯后 clearDeviceMetricsOverride，于是第 5、6 步的审计用的是**用户持久化的
    // 真实窗口宽**（src/main/index.ts 的 WindowState 会记住上次拖多大）——同一条断言在不同机器上
    // 绿红不定（本机内容区 956 就红，宽窗口机器上就绿）。所以这里先把视口钉死再量一次。
    // 注意 main 里 BrowserWindow 的 minWidth: 960 是**外框**宽，Windows 上内容区实测 956；
    // Emulation 定的是内容区，取 960×720 即"外框最小宽度"这一档（比实测内容区还宽 4px，是宽松侧）。
    await setViewport(960, 720)
    const wfMinAudit = await layoutAudit()
    const wfMinBox = await js(cdp, `(() => {
      const s = document.querySelector('.screen.workflow')
      const c = document.querySelector('.wf-composer-wrap')
      return {
        vw: document.documentElement.clientWidth,
        screen: s ? { clientWidth: s.clientWidth, scrollWidth: s.scrollWidth } : null,
        composer: c ? Math.round(c.getBoundingClientRect().width) : null
      }
    })()`)
    ok('应用自身最小宽度（显式定视口 960×720）下工作流首页无横向溢出',
      // composer != null 是**前提**而不是装饰：上一轮实测到，若用户配置里留着未跑完的工作流任务，
      // 应用启动会把它恢复成任务视图（.wf-topbar），首页的 .wf-composer-wrap 根本不在 DOM 里，
      // 那时 layoutAudit 拿不到溢出、这条就"绿得没测到任何东西"。所以先要求被测对象在场。
      wfMinBox.composer != null && wfMinAudit.total === 0,
      `${JSON.stringify(wfMinAudit.issues?.slice(0, 4))} 视口/内容列/composer=${JSON.stringify(wfMinBox)}`)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(400)
    // ---- 修复波 B · 项 3 第一条：既有的 `工作流首页无横向溢出` 原先拿"用户上次把窗口拖多大"
    // 当被测宽度（波 A §11.4 实测：在坏掉的 92vw 构建上它是**过的**，抓到缺陷的是上面那条 960×720）。
    // 二选一里选 ①：把它也钉到显式视口——但用**默认窗宽 1280×800**（src/main/index.ts:86 的 fallback
    // 就是这个数），不与 960 那条合成同一件事：960 守"应用自身最小宽度"，这条守"默认/常用宽度不回归"，
    // 两档各自可复现。断言本体（layoutAudit 的 total===0）一字未改，也没缩成"只量 scrollWidth"，
    // 只是被测宽度从"随用户窗口漂移"变成"钉死"，并同样要求 composer 在场（不满足前提的绿不算测到）。
    await setViewport(1280, 800)
    const wfAudit = await layoutAudit()
    const wfWideBox = await js(cdp, `(() => {
      const s = document.querySelector('.screen.workflow')
      const c = document.querySelector('.wf-composer-wrap')
      return { vw: document.documentElement.clientWidth, screen: s ? { clientWidth: s.clientWidth, scrollWidth: s.scrollWidth } : null, composer: c ? Math.round(c.getBoundingClientRect().width) : null }
    })()`)
    ok('工作流首页无横向溢出（显式定视口 1280×800 · 默认窗宽档，不是"用户上次拖多宽"）',
      wfWideBox.composer != null && wfAudit.total === 0,
      `${JSON.stringify(wfAudit.issues?.slice(0, 4))} 视口/内容列/composer=${JSON.stringify(wfWideBox)}`)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(400)
    const saved = await js(cdp, `(() => {
      const el = document.querySelector('.wf-saved')
      if (!el) return { present: false }
      const r = el.getBoundingClientRect()
      const cards = [...el.querySelectorAll('.wf-saved-card')].length
      const clash = [...document.querySelectorAll('body *')].filter((o) => {
        if (el.contains(o) || o.contains(el)) return false
        const q = o.getBoundingClientRect()
        if (q.width < 20 || q.height < 12) return false
        return !(q.right < r.left || q.left > r.right || q.bottom < r.top || q.top > r.bottom)
      }).map((o) => (typeof o.className === 'string' ? o.className : o.tagName).slice(0, 40))
      return { present: true, cards, rect: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }, clash: clash.slice(0, 6) }
    })()`)
    console.log('  [wf-saved] ' + JSON.stringify(saved))
    if (!saved.present) console.log('  SKIP  保存任务卡片（当前配置无已保存任务，未验证遮挡）')
    else ok('保存任务卡片不与其他元素重叠', saved.clash.length === 0, JSON.stringify(saved.clash))

    // ---- 6b. 全局快捷键（键位可在设置改）：用配置里实际生效的键位合成事件，不硬编码 Ctrl+M ----
    const bindToEvent = (b) => {
      const parts = String(b).split('+')
      const key = parts[parts.length - 1]
      const mods = parts.slice(0, -1).map((s) => s.toLowerCase())
      const named = { comma: ',', period: '.', slash: '/', space: ' ' }
      return { key: named[key.toLowerCase()] ?? key.toLowerCase(), ctrl: mods.includes('ctrl'), shift: mods.includes('shift'), alt: mods.includes('alt') }
    }
    const pressKey = async (b) => {
      const e = bindToEvent(b)
      await js(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(e.key)}, ctrlKey: ${e.ctrl}, shiftKey: ${e.shift}, altKey: ${e.alt}, bubbles: true, cancelable: true })); return true })()`)
    }
    const binds = await js(cdp, 'window.__ahub_debug.state().keybindings')
    const msBind = binds.modeSwitch || 'Ctrl+M'
    console.log('  [hotkey] 实际生效的切模式键位：' + msBind)
    // 不断言"用户没改过键"（人会改），只断言生效键位里没有占用编辑必需键的（启动剔除逻辑在管）
    const RESERVED = ['c', 'v', 'x', 'z', 'y', 'a', 'w', 't']
    const illegal = Object.entries(binds).filter(([, b]) => {
      const parts = String(b).split('+')
      const key = (parts.pop() || '').toLowerCase()
      return parts.map((p) => p.toLowerCase()).includes('ctrl') && !parts.some((p) => ['shift', 'alt'].includes(p)) && RESERVED.includes(key)
    })
    ok('生效键位中不存在占用编辑必需键的项', illegal.length === 0, JSON.stringify(illegal))
    const hotFrom = await js(cdp, 'window.__ahub_debug.state().screen')
    await pressKey(msBind)
    await sleep(900)
    const hotTo = await js(cdp, 'window.__ahub_debug.state().screen')
    ok(`${msBind} 切回工作站模式`, hotFrom === 'workflow' && hotTo === 'workbench', `${hotFrom} -> ${hotTo}`)
    await pressKey(msBind)
    await sleep(900)
    ok(`${msBind} 再次按下切回工作流`, (await js(cdp, 'window.__ahub_debug.state().screen')) === 'workflow')
    // 打开设置的键位（默认 Ctrl+Comma）：证明四个动作都走同一套匹配
    await pressKey(binds.openSettings || 'Ctrl+Comma')
    await sleep(1000)
    const settingsByHotkey = await js(cdp, '!!document.querySelector(".settings-win")')
    ok('打开设置快捷键生效', settingsByHotkey)
    // 键位标签只在「快捷键」分区里渲染：先点分区再读，否则拿到空数组（上一轮就是这么误报的）
    await js(cdp, `(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '快捷键')?.click(); return true })()`)
    await sleep(900)
    const kbdLabels = await js(cdp, `(() => [...document.querySelectorAll('.kbd')].map((x) => x.textContent.trim()).slice(0, 4))()`)
    ok('设置→快捷键分区渲染出四个可改键位', kbdLabels.length === 4, JSON.stringify(kbdLabels))
    await js(cdp, `(() => { document.querySelector('button[aria-label="关闭设置"]')?.click(); return true })()`)
    await sleep(700)
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(600)

    // ---- 6c. 结构：工作流并入左侧栏 + 任务列表 + 预设 + 用量入口（本轮 3/4/5/6/7）----
    const shell = await js(cdp, `(() => {
      const inShell = !!document.querySelector('.workbench.screen .sidebar')
      const tasks = !!document.querySelector('.wf-tasks')
      const newBtn = !!document.querySelector('.wf-tasks-new')
      const preset = [...document.querySelectorAll('.cfg-chip')].some((b) => b.textContent.includes('预设'))
      const outChip = [...document.querySelectorAll('.cfg-chip')].some((b) => b.textContent.includes('产物'))
      const straySwitch = [...document.querySelectorAll('.wf-topbar .btn, .wf-topbar .icon-btn, .screen.workflow .icon-btn')].filter((b) => /切换/.test(b.textContent) || (b.title || '').includes('切换模式')).length
      const savedCards = document.querySelectorAll('.wf-saved-card').length
      return { inShell, tasks, newBtn, preset, outChip, straySwitch, savedCards, screen: window.__ahub_debug.state().screen }
    })()`)
    ok('工作流界面共用工作站左侧栏', shell.inShell && shell.screen === 'workflow', JSON.stringify(shell))
    ok('侧栏有工作流任务列表与新建入口', shell.tasks && shell.newBtn)
    // 加号在工作站也要有用：切进工作流 + 给反馈（曾经点了完全没反应）
    await js(cdp, 'window.__ahub_debug.workbench()')
    await sleep(1000)
    await js(cdp, `(() => { document.querySelector('.wf-tasks-new')?.click(); return true })()`)
    await sleep(1000)
    const plus = await js(cdp, `(() => ({
      screen: window.__ahub_debug.state().screen,
      toast: [...document.querySelectorAll('.toast-item,.toast')].map((t) => t.textContent).join('|')
    }))()`)
    ok('工作站点侧栏加号会切进工作流并给出反馈', plus.screen === 'workflow' && /新任务/.test(plus.toast), JSON.stringify(plus))
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(700)
    ok('配置条含「预设」与「产物」入口', shell.preset && shell.outChip)
    ok('切换模式入口已收归侧栏（工作流页内不再有重复按钮）', shell.straySwitch === 0, 'stray=' + shell.straySwitch)
    ok('旧「保存任务」卡片已彻底移除', shell.savedCards === 0)
    // 默认菜单被替换：Ctrl+W 走确认流程，Ctrl+R（会打断正在跑的任务）与 DevTools 键不再注册
    const menu = await js(cdp, 'window.__ahub_debug.menuSummary()')
    ok('应用菜单已换成自定义菜单', !!menu?.custom, JSON.stringify(menu?.accelerators ?? null))
    ok('不再注册 Ctrl+R 强制刷新（会当场打断工作流）', !(menu?.accelerators ?? []).some((a) => /^(CmdOrCtrl|Ctrl)\+R$/i.test(a)), JSON.stringify(menu?.accelerators))
    ok('不再注册 Ctrl+Shift+I 开发者工具', !(menu?.accelerators ?? []).some((a) => /Shift\+I$/i.test(a)))
    ok('Ctrl+W 仍在菜单里（走我们的关闭确认，而非默认直接关窗）', (menu?.accelerators ?? []).some((a) => /Ctrl\+W/i.test(a)))
    await shot('12-workflow-shell')

    const pop = await js(cdp, `(() => {
      const b = [...document.querySelectorAll('.cfg-chip')].find((x) => x.textContent.includes('预设'))
      b?.click()
      return !!b
    })()`)
    await sleep(500)
    const popUi = await js(cdp, `(() => {
      const p = document.querySelector('.wf-chip-pop')
      return { open: !!p, hasSaveInput: !!p?.querySelector('input'), empty: /还没有预设/.test(p?.textContent ?? '') }
    })()`)
    ok('预设弹层可打开且含「存为预设」输入', !!pop && popUi.open && popUi.hasSaveInput, JSON.stringify(popUi))
    const savedPreset = await js(cdp, `(() => {
      const p = document.querySelector('.wf-chip-pop')
      const i = p?.querySelector('input')
      if (!i) return null
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, '验证预设'); i.dispatchEvent(new Event('input', { bubbles: true }))
      ;[...p.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.click()
      return true
    })()`)
    await sleep(900)
    const presetState = await js(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const p = s.wf.presets.find((x) => x.name === '验证预设')
      return { count: s.wf.presets.length, has: !!p, executor: p?.executor ?? null }
    })()`)
    ok('预设保存成功并绑定当前三角色', !!savedPreset && presetState.has && !!presetState.executor, JSON.stringify(presetState))
    // 现场清理：删掉本次建的预设，别留在用户配置里
    await js(cdp, `(() => {
      const p = window.__ahub_debug.state().wf.presets.find((x) => x.name === '验证预设')
      if (p) window.__ahub_debug.deletePreset(p.id)
      return true
    })()`)
    await sleep(600)
    ok('清理：验证预设已删除', (await js(cdp, 'window.__ahub_debug.state().wf.presets.filter((p) => p.name === "验证预设").length')) === 0)
    await js(cdp, `(() => { document.body.click(); return true })()`)
    await sleep(400)

    // 用量入口：对话栏图标 → 本 Agent 的调用账本
    await js(cdp, 'window.__ahub_debug.workbench()')
    await sleep(1200)
    const usageBtn = await js(cdp, `(() => { const b = document.querySelector('.ctx-bar .usage-open'); if (!b) return false; b.click(); return true })()`)
    await sleep(1200)
    const usageUi = await js(cdp, `(() => {
      const p = document.querySelector('.usage-panel')
      if (!p) return null
      return { rows: p.querySelectorAll('.usage-table tbody tr').length, recent: p.querySelectorAll('.usage-row').length, text: p.textContent.slice(0, 60) }
    })()`)
    ok('对话栏用量图标可打开统计面板', !!usageBtn && !!usageUi, JSON.stringify(usageUi))
    ok('账本记到了本次验证产生的真实调用', !!usageUi && (usageUi.rows > 0 || usageUi.recent > 0), JSON.stringify(usageUi))
    await shot('13-usage-panel')
    await js(cdp, `(() => { document.querySelector('.modal-foot .btn, .modal .btn-ghost')?.click(); return true })()`)
    await sleep(600)

    // ---- 7. 工作流真实引擎：思考增量进卡片 + 产物目录交付（本轮需求 1/6）----
    const ART = join(SANDBOX, 'artifacts')
    await js(cdp, `window.__ahub_debug.setWorkflowOutputDir(${JSON.stringify(ART)})`)
    await sleep(600)
    const reqBefore = seen.requests.length
    await js(cdp, `window.__ahub_debug.startMockToolTask(${JSON.stringify(baseUrl)}, ${JSON.stringify(SANDBOX)}, '用一句话说明什么是工作流模式')`)
    const thinkRole = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const c = s.run?.cardDetails?.find((x) => x.process.some((p) => p.startsWith('thinking:')))
      return c ? c.role : null
    })()`, 90000)
    ok('工作流卡片过程区出现思考内容（kind=thinking）', !!thinkRole, String(thinkRole))
    await shot('10-workflow-thinking')

    // 执行角色的产物落盘（mock Agent 无写文件动作 → 由 AgentHub 把成果写成文本产物）
    const artAt = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const withArt = (s.run?.cardDetails ?? []).find((c) => (c.artifacts ?? []).some((a) => /\\[app\\]/.test(a)))
      return withArt ? { role: withArt.role, arts: withArt.artifacts, outDir: s.run?.outputDir } : null
    })()`, 120000)
    ok('执行角色产出被登记为真实文件产物（by=app）', !!artAt && Array.isArray(artAt.arts) && artAt.arts.length > 0, JSON.stringify(artAt))
    ok('运行记录携带本次生效的产物目录', !!artAt && artAt.outDir === ART, String(artAt && artAt.outDir))
    if (artAt) {
      const p = String(artAt.arts[0]).match(/\((.*?)\)\[/)?.[1]
      ok('产物路径就在所选产物目录内', !!p && p.startsWith(ART), String(p))
      ok('文件真实存在于磁盘（不是界面文案）', !!p && existsSync(p), String(p))
      const body = p && existsSync(p) ? readFileSync(p, 'utf-8') : ''
      ok('产物内容含执行成果正文', body.includes('由 AgentHub 落盘') && body.length > 40, `${body.length} 字`)
      console.log('  [artifact] ' + p + ' · ' + body.split('\n')[0])
    }
    const wfBodies = JSON.stringify(seen.bodies.slice(reqBefore))
    ok('工作流角色的工具沙箱被切到产物目录（空目录返回"没有匹配"）', /没有匹配/.test(wfBodies), wfBodies.slice(0, 160))
    await js(cdp, 'window.__ahub_debug.stopTask()')
    await sleep(2000)

    // ---- 7b. 执行角色真实写文件（by=tool）：产物来源标注与沙箱根切换 ----
    await js(cdp, `window.__ahub_debug.startMockToolTask(${JSON.stringify(baseUrl)}, ${JSON.stringify(SANDBOX)}, '交付一个文件产物：写一份说明')`)
    // 把审核方式打出来：走不走确认门决定后面几项断言的时机，出问题时要能一眼看出是哪种
    const cfg7b = await js(cdp, 'window.__ahub_debug.state().config')
    console.log(`  [7b] 审核方式=${cfg7b?.reviewMode} 每轮确认=${cfg7b?.confirmEveryRound}`)
    const toolArt = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const c = (s.run?.cardDetails ?? []).find((x) => (x.artifacts ?? []).some((a) => /\\[tool\\]/.test(a)))
      return c ? { role: c.role, arts: (c.artifacts ?? []).filter((a) => /\\[tool\\]/.test(a)) } : null
    })()`, 150000)
    ok('执行角色 write_file 成功被登记为真实产物（by=tool）', !!toolArt, JSON.stringify(toolArt))
    if (toolArt) {
      const tp = String(toolArt.arts[0]).match(/\((.*?)\)\[/)?.[1]
      ok('该产物写入所选产物目录（沙箱根已临时切换）', tp === join(ART, '交付说明.md') && existsSync(tp), String(tp))
      ok('未落在 Agent 原授权目录（沙箱根未被使用）', !existsSync(join(SANDBOX, '交付说明.md')))
      const hasAppArt = await js(cdp, `(() => { const s = window.__ahub_debug.state(); return (s.run?.cardDetails ?? []).some((c) => (c.artifacts ?? []).some((a) => /\\[app\\]/.test(a))) })()`)
      ok('已有执行方写盘产物时不再生成 AgentHub 兜底文本（来源不重复）', !hasAppArt)
      // 检查点：真实写盘必须进了可回滚清单；改动清单挂在交付卡片上，所以要先走到交付
      const cps = await js(cdp, '(() => { const s = window.__ahub_debug.state(); return s.run ? s.run.id : null })()')
      await shot('11-workflow-tool-artifact')
      if (cps) {
        const man = await js(cdp, `window.__ahub_debug.checkpoint(${JSON.stringify(cps)})`)
        ok('工具层写盘进入改动检查点（交付可回滚）', (man?.summary?.total ?? 0) >= 1, JSON.stringify(man?.summary))
        // 交付可能停在确认门、也可能按配置自动交付；两种都要走到 completed。
        // mock 服务每轮要几秒、最多 3 轮 ×3 次调用，所以这里给的是一整段真实时间，
        // 而不是"审核链路应该瞬间跑完"的假设
        const REACHED = '(() => { const r = window.__ahub_debug.state().run; return !!r && (r.status === "completed" || !!r.gate) })()'
        const reached = await waitJs(cdp, REACHED, 480000)
        const st0 = await js(cdp, 'window.__ahub_debug.state().run')
        ok('跑到交付或确认门（审核链路没卡死）', !!reached, `status=${st0?.status} stage=${st0?.stage} round=${st0?.round} cards=${st0?.cards}`)
        if (reached && st0.status !== 'completed') await js(cdp, 'window.__ahub_debug.passGate()')
        const delivered = await waitJs(cdp, 'window.__ahub_debug.state().run?.status === "completed"', 240000)
        const st1 = await js(cdp, 'window.__ahub_debug.state().run')
        ok('走到交付（改动清单要有地方挂）', !!delivered, `status=${st1?.status}`)
        const sel = `[data-checkpoint="${cps}"]`
        // 交付完成时人可能在工作站页（前面几项切过屏），TaskView 没挂载就没有交付卡片可看
        await js(cdp, 'window.__ahub_debug.workflow()')
        const cardUp = await waitJs(cdp, '!!document.querySelector(".delivery-card")', 10000)
        ok('回到工作流界面后交付卡片在（不是只在状态机里"完成"）', !!cardUp)
        const barShown = await waitJs(cdp, `!!document.querySelector(${JSON.stringify(sel)})`, 10000)
        if (!barShown) {
          // 找不到就把现场打出来：是 run.id 不对、还是这个组件压根没渲染
          const any = await js(cdp, `[...document.querySelectorAll('[data-checkpoint]')].map((e) => e.getAttribute('data-checkpoint')).join(',')`)
          const dom = await js(cdp, '(() => { const d = document.querySelector(".delivery-card"); return d ? d.className + " | " + d.innerText.slice(0, 160).replace(/\\n/g, " / ") : "no delivery card" })()')
          console.log(`  [诊断] 期望 run.id=${cps}；页面上的 data-checkpoint=[${any}]；交付卡片=${dom}`)
        }
        ok('交付卡片挂出了改动清单入口', barShown === true)
        await js(cdp, `document.querySelector(${JSON.stringify(sel)})?.querySelector('.cp-toggle')?.click()`)
        await sleep(400)
        const delta = await js(cdp, `!!document.querySelector(${JSON.stringify(sel)})?.querySelector('[data-checkpoint-delta]')`)
        ok('展开后能看到目录对照（开工前基线 vs 现在）', delta === true, String(delta))
        await shot('12-workflow-checkpoint-bar')
      }
    }
    const st = await js(cdp, 'window.__ahub_debug.state()')
    if (st.run && st.run.status !== 'completed') await js(cdp, 'window.__ahub_debug.stopTask()')
    await sleep(2000)
    // 留着 7b 那条任务的 id：下面要用它走一遍「以此为目标开新任务」，
    // 那样才会把上一任务的执行/审核结论放进 _carryOver（计划轮必须看得到这个）
    const carryRunId = st.run?.id ?? null

    // ---- 7c. 批次 F：任务级计划态（开工先出计划 → 批准 → 同一个 run 续跑）----
    // 先验用户入口：计划态开关必须在执行设置里可见、可点、真写进配置。
    // （复核发现的洞：批次 F 落地时只有 debug 钩子能开它，普通用户根本用不到这个特性。）
    await ensureWfHome(cdp)
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(500)
    // 开关坐在「工作流设置」弹窗里（ConfigPanel 是 Modal，默认不开）：不先把弹窗点开，
    // 这条就会查不到节点而红，而第二条"关回去"会因为两次点击都落空而**空转报绿**。
    // 这里必须按文案挑那颗 chip：`.cfg-chip` 在页面上有**两颗**——第一颗是「审核：人工/自动」的切换，
    // 第二颗才是「更多设置」。按类名取第一颗等于在旁边那个开关上乱翻（实测就是这么红的）。
    const chipClicked = await js(cdp, `(() => { const b = [...document.querySelectorAll('button.cfg-chip')].find((x) => /更多设置/.test(x.textContent ?? '')); if (!b) return false; b.click(); return true })()`)
    await sleep(700)
    const opened = await js(cdp, `!!document.querySelector('.modal[aria-label="工作流设置"]')`)
    const swBefore = await js(cdp, `(() => { const s = document.querySelector('button.switch[aria-label="计划态"]'); return { found: !!s, checked: s?.getAttribute('aria-checked') ?? null } })()`)
    await js(cdp, `(() => { document.querySelector('button.switch[aria-label="计划态"]')?.click(); return true })()`)
    await sleep(500)
    const swAfter = await js(cdp, `(() => ({ planFirst: !!window.__ahub_debug.state().config.planFirst, checked: document.querySelector('button.switch[aria-label="计划态"]')?.getAttribute('aria-checked') ?? null }))()`)
    await js(cdp, `(() => { document.querySelector('button.switch[aria-label="计划态"]')?.click(); return true })()`)
    await sleep(500)
    const swBack = await js(cdp, '(() => !!window.__ahub_debug.state().config.planFirst)()')
    await js(cdp, `(() => { document.querySelector('.modal-head button[title="关闭"]')?.click(); return true })()`)
    await sleep(400)
    ok('执行设置里有「计划态」开关，点下去真写进配置（这个特性不能只靠验证钩子才起得来）',
      chipClicked === true && opened === true && swBefore.found === true && swAfter.planFirst === true && swAfter.checked === 'true',
      JSON.stringify({ chipClicked, opened, swBefore, swAfter }))
    ok('开关关回去后配置里 planFirst=false（不开半开状态；前置是同一次点击真的先把它打开过）',
      swAfter.planFirst === true && swBack === false, JSON.stringify({ swAfter, swBack }))
    // 走 mock 服务，不烧真实额度。产物目录仍是上面 7/7b 用的 ART，
    // 这样 Task 11 的目录对照与这几条断言看的是同一个目录。
    // 先用「以此为目标开新任务」把上一任务的结论带出来：计划轮必须看得到它，
    // 否则"继续修改 + 计划态"会在一无所知的情况下写第一版计划（本轮修掉的漏项）。
    // 顺序要紧：上面的 ensureWfHome 会走 newTask()，而它无条件清掉 _carryOver，
    // 所以必须**先回看 7b 那条任务**再触发 continueModify，不能被那次切视图抹掉。
    if (carryRunId) {
      await js(cdp, `window.__ahub_debug.openWfTask(${JSON.stringify(carryRunId)})`)
      await sleep(700)
    }
    const carried = await js(cdp, 'window.__ahub_debug.continueModify()')
    console.log(`  [7c] continueModify → draft=${JSON.stringify(carried?.draft)} runCleared=${carried?.runCleared} 上一任务=${carryRunId ? '有' : '无'}`)
    const reqBefore7c = seen.requests.length
    await js(cdp, `window.__ahub_debug.startPlanTask(${JSON.stringify(baseUrl)}, ${JSON.stringify(SANDBOX)}, '计划态验证：先给出要做什么的计划')`)
    const planGate = await waitJs(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      return r && r.status === 'waiting_user' && r.gateKind === 'plan'
        ? { ok: true, planTextLen: r.planTextLen, roles: (r.cardDetails || []).map((c) => c.role), stage: r.stage, runId: r.id }
        : null
    })()`, 180000)
    ok('计划轮结束后挂出的是"计划批准门"（gateKind==="plan"），不是审核门', !!planGate, JSON.stringify(planGate))
    console.log(`  [7c] 计划正文长度=${planGate && planGate.planTextLen} 卡片=${planGate && planGate.roles.join('/')} stage=${planGate && planGate.stage}`)
    ok('计划门上有真实计划正文（长度>0；空正文的门等于把人晾在那儿）', !!planGate && planGate.planTextLen > 0, JSON.stringify(planGate))
    ok('批准前没有执行/审核卡片（任务级：先只读规划一轮）',
      !!planGate && !/executor|reviewer/.test(planGate.roles.join(',')), JSON.stringify(planGate && planGate.roles))
    const planArts = await js(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      return { arts: (r.cardDetails || []).reduce((n, c) => n + (c.artifacts || []).length, 0), roles: (r.cardDetails || []).map((c) => c.role) }
    })()`)
    ok('计划轮不产生兜底落盘产物（否则计划正文自己成了交付物）', planArts.arts === 0, JSON.stringify(planArts))
    // 真机侧的 schema 断言：计划轮那次调用，模型收到的工具清单里就不该有写类工具
    const planBodies = seen.bodies.slice(reqBefore7c)
    const planToolNames = planBodies.flatMap((b) => (b.tools || []).map((t) => t.function && t.function.name).filter(Boolean))
    const WRITE5 = ['write_file', 'replace_in_file', 'delete_file', 'move', 'run_command']
    ok('计划轮发给模型的 schema 里一个写类工具都没有（模型看不到就不会反复试）',
      planToolNames.length > 0 && !planToolNames.some((n) => WRITE5.includes(n)),
      `计划轮工具=${[...new Set(planToolNames)].join(',')}`)
    ok('计划轮的 schema 仍带着只读工具（拦写不拦读，规划才看得清现场）',
      planToolNames.includes('read_file') && planToolNames.includes('glob_files'),
      [...new Set(planToolNames)].join(','))
    // 上一任务上下文得真的出现在计划轮那次调用里（源码里有字段不算数，看发出去的请求体）
    ok('计划轮看得到上一任务的结论（「以此为目标开新任务」带过来的上下文真的进了这一轮请求）',
      JSON.stringify(planBodies).includes('上一任务上下文'),
      JSON.stringify(planBodies).slice(0, 200))
    // 界面这一半：门必须看得见、正文要落在视口内（"在 DOM 里"不等于"看得见"是本仓的老规矩）
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(400)
    const planDom = await js(cdp, `(() => {
      const card = document.querySelector('[data-plan-gate]')
      const txt = document.querySelector('[data-plan-text]')
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const inView = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 2 && b.height > 2 && b.top >= 0 && b.left >= 0 && b.right <= vw + 1 && b.bottom <= vh + 1 }
      const btns = [...document.querySelectorAll('.gate-plan button')]
      return { card: !!card, cardVisible: inView(card), textVisible: inView(txt), text: txt ? txt.textContent.slice(0, 40) : '', approve: btns.some((b) => /批准并继续/.test(b.textContent)), approveEnabled: btns.some((b) => /批准并继续/.test(b.textContent) && !b.disabled), costSaid: btns.some((b) => /按意见重出计划/.test(b.textContent) && /再消耗一次|再花一次|消耗一次调用/.test(b.textContent)), replan: btns.some((b) => /按意见重出计划/.test(b.textContent)) }
    })()`)
    ok('计划批准门在界面上看得见（卡片与正文完整落在视口内，不只是挂在 DOM 上）',
      planDom.card === true && planDom.cardVisible === true && planDom.textVisible === true, JSON.stringify(planDom))
    ok('门上有「批准并继续」这个动作（人不点就不会执行）', planDom.approve === true, JSON.stringify(planDom))
    ok('有正文时「批准并继续」可用（禁用判据只看正文是否为空，不拦正常情况）',
      planDom.approveEnabled === true, JSON.stringify(planDom))
    ok('「按意见重出计划」把代价写在按钮上（要再消耗一次调用，不能只给一个好听的动词）',
      planDom.replan === true && planDom.costSaid === true, JSON.stringify(planDom))
    // Task 11：CLI 角色的改动只能事后列出。这里判的是"话说得对不对"——
    // 承诺范围必须收在这个任务真实的产物目录上，且绝不出现"一定没改文件"那种拦不到的话。
    const cliNote = await js(cdp, `(() => { const el = document.querySelector('[data-cli-changes]'); return el ? el.textContent : '' })()`)
    ok('计划门挂了目录对照结果，且把范围写死在这个任务真实的产物目录上（不是泛指"没改文件"）',
      cliNote.length > 0 && cliNote.includes(ART), JSON.stringify(cliNote.slice(0, 160)))
    ok('对照措辞里没有超出能力的承诺（"一定没改/绝对没改/保证没写"一类，CLI 那侧拦不到就不许说）',
      !/一定没改|绝对没改|保证没改|保证没写|没有改动文件/.test(cliNote), JSON.stringify(cliNote.slice(0, 160)))
    // 计划门的动作面：正文可复制、**点「存为产物」才落盘**（前面已断言计划轮自己不产生产物）。
    const artsBefore = existsSync(ART) ? readdirSync(ART).filter((f) => f.endsWith('.md')) : []
    const saveClicked = await js(cdp, `(() => { const b = [...document.querySelectorAll('.gate-plan button')].find((x) => /存为产物/.test(x.textContent ?? '')); if (!b) return false; b.click(); return true })()`)
    await sleep(1500)
    const artsAfter = existsSync(ART) ? readdirSync(ART).filter((f) => f.endsWith('.md')) : []
    const newPlanFiles = artsAfter.filter((f) => !artsBefore.includes(f))
    ok('计划门上有「存为产物」这个动作', saveClicked === true, String(saveClicked))
    ok('点「存为产物」才写成产物（正文落进这个任务的产物目录，点之前目录里没有它）',
      newPlanFiles.length === 1 && /^计划-/.test(newPlanFiles[0]),
      JSON.stringify({ artsBefore, artsAfter }))
    const planFileBody = newPlanFiles.length === 1 ? readFileSync(join(ART, newPlanFiles[0]), 'utf-8') : ''
    ok('存下来的产物带着这个任务的目标与正文（不是空文件，也不是执行成果）',
      planFileBody.includes('计划态验证') && planFileBody.length > 40, `${planFileBody.length} 字`)
    // 「按意见重出计划」：再跑一轮**计划态**规划 → 新增一张规划卡、批准门重挂、执行角色仍然进不来
    await js(cdp, `(() => { const t = document.querySelector('.gate-plan textarea'); if (!t) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(t, '请更具体一些'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(300)
    const replanClicked = await js(cdp, `(() => { const b = [...document.querySelectorAll('.gate-plan button')].find((x) => /按意见重出计划/.test(x.textContent ?? '')); if (!b) return false; b.click(); return true })()`)
    const afterReplan = await waitJs(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      if (!r) return null
      const roles = (r.cardDetails || []).map((c) => c.role)
      const planners = roles.filter((x) => x === 'planner').length
      return r.gateKind === 'plan' && planners >= 2 ? { roles, planners, runId: r.id } : null
    })()`, 180000)
    ok('「按意见重出计划」重跑的是计划态那一轮：规划卡新增一张、批准门重挂、执行角色仍进不来',
      replanClicked === true && !!afterReplan && !afterReplan.roles.includes('executor'),
      JSON.stringify({ replanClicked, afterReplan }))
    ok('重出计划不新建任务（run.id 与第一版计划同一个）',
      !!afterReplan && !!planGate && afterReplan.runId === planGate.runId,
      JSON.stringify({ before: planGate && planGate.runId, after: afterReplan && afterReplan.runId }))
    // 批准门不许有旁路：未批准时"单角色重跑执行"就是绕过批准去写盘的另一条路（复核时发现的洞，已堵）。
    await js(cdp, 'window.__ahub_debug.rerunRole("executor")')
    await sleep(1500)
    const bypass = await js(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      return { roles: (r.cardDetails || []).map((c) => c.role), status: r.status, gateKind: r.gateKind }
    })()`)
    ok('计划未批准时「单角色重跑执行」被拒（不出现执行卡片、仍停在计划门）',
      !bypass.roles.includes('executor') && bypass.status === 'waiting_user' && bypass.gateKind === 'plan',
      JSON.stringify(bypass))
    // 剪贴板被拒时得如实报错并给出替代路径（正文本可选中，还有"存为产物"）。
    // Electron 里剪贴板通常是通的，这一档必须临时把它改成 reject 才测得到；测完立刻还原。
    await js(cdp, `(() => { window.__clipBack = navigator.clipboard; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied by test')) } }); return true })()`)
    await js(cdp, `(() => { const b = [...document.querySelectorAll('.gate-plan button')].find((x) => /复制正文/.test(x.textContent ?? '')); b?.click(); return true })()`)
    await sleep(700)
    const clipToast = await js(cdp, `(() => [...document.querySelectorAll('.toast-item,.toast')].map((t) => t.textContent).join('|'))()`)
    await js(cdp, `(() => { if (window.__clipBack) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__clipBack }); return true })()`)
    ok('剪贴板被拒时报的是"复制失败"并指出另两条路，不静默什么都不说',
      /复制失败/.test(clipToast) && /存为产物|框选/.test(clipToast), JSON.stringify(clipToast.slice(0, 160)))
    // 批准：同一个 run 从执行角色续跑，不新建任务、不重放计划轮
    const runIdBefore = planGate ? planGate.runId : null
    // 连点两次：门是同步清掉的，第二次应当无事发生——这条承诺以前只靠读代码认定
    await js(cdp, 'window.__ahub_debug.passGate()')
    await js(cdp, 'window.__ahub_debug.passGate()')
    // 单执行循环的占用位：批准后那条链**同步**占住 _started，所以探针要紧贴在 passGate 之后发，
    // 不能等一会儿再发——等久了链可能已经跑到下一个门、占用位释放，那条断言就变成赌时长（会偶发假红）。
    // 判据只看 run.id 没被顶掉：原先后果是第二个 start() 用 set({run}) 换掉两条链正在写的同一个 run。
    await js(cdp, `void window.__ahub_debug.startDemoTask('链在跑时提交的第二个任务')`)
    const afterSecond = await js(cdp, '(() => ({ runId: window.__ahub_debug.state().run?.id, status: window.__ahub_debug.state().run?.status }))()')
    const afterApprove = await waitJs(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      if (!r) return null
      const roles = (r.cardDetails || []).map((c) => c.role)
      return roles.includes('executor') ? { roles, runId: r.id, planners: roles.filter((x) => x === 'planner').length, executors: roles.filter((x) => x === 'executor').length } : null
    })()`, 180000)
    ok('批准后同一个 run 继续进三角色链（执行卡片出现，不是新建任务）',
      !!afterApprove && afterApprove.runId === runIdBefore, JSON.stringify({ before: runIdBefore, after: afterApprove }))
    ok('连点两次「批准并继续」不起第二条链（执行卡只有一张）',
      !!afterApprove && afterApprove.executors === 1, JSON.stringify(afterApprove && afterApprove.roles))
    ok('链在跑时提交第二个任务被拒（run.id 没被顶掉：续跑那条链占着单执行循环）',
      !!afterSecond && afterSecond.runId === runIdBefore, JSON.stringify({ before: runIdBefore, afterSecond }))
    // "不重放计划轮"的判据是**规划卡张数与批准前一致**：上面已经重出过一次计划，
    // 所以不能写死 1 张——要钉的是"批准之后没有再多出一张规划卡"
    const plannersAtGate = afterReplan ? afterReplan.planners : 0
    ok('计划轮没有被重放（批准后规划卡张数与批准前一致：重放等于重复烧额度）',
      !!afterApprove && afterApprove.planners === plannersAtGate,
      JSON.stringify({ atGate: plannersAtGate, after: afterApprove }))
    await js(cdp, 'window.__ahub_debug.stopTask()')
    await sleep(2000)

    // ---- 7d. 空计划的门 + 单次"本任务先出计划"（这两条动作面以前只有实现、没有断言）----
    // mock 服务对含 SENTINEL-EMPTY-PLAN 的目标只回 stop、不回正文，才造得出"空计划"这一档
    await js(cdp, `window.__ahub_debug.startPlanTask(${JSON.stringify(baseUrl)}, ${JSON.stringify(SANDBOX)}, 'SENTINEL-EMPTY-PLAN 让这一版计划没有正文')`)
    const emptyGate = await waitJs(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      return r && r.gateKind === 'plan' && r.status === 'waiting_user' ? { planTextLen: r.planTextLen, roles: (r.cardDetails || []).map((c) => c.role) } : null
    })()`, 180000)
    ok('规划角色没吐正文时门照样挂出来（不静默把任务判成失败，也不假装出了计划）',
      !!emptyGate && emptyGate.planTextLen === 0, JSON.stringify(emptyGate))
    // 判据看**全文**：空计划那句是门上的最后一条 note，早先按前 80 字切会把要验的那句切掉（假红）
    const emptyBtn = await js(cdp, `(() => { const b = [...document.querySelectorAll('.gate-plan button')].find((x) => /批准并继续/.test(x.textContent ?? '')); return { found: !!b, disabled: b ? b.disabled === true : null, hint: [...document.querySelectorAll('.gate-plan .gate-plan-note')].map((n) => n.textContent).join('|') } })()`)
    ok('空计划时「批准并继续」禁用，并把原因写在门上看得到（不是让人对着一个没反应的按钮猜）',
      emptyBtn.found === true && emptyBtn.disabled === true && /空的/.test(emptyBtn.hint), JSON.stringify({ found: emptyBtn.found, disabled: emptyBtn.disabled, hint: (emptyBtn.hint || '').slice(-90) }))
    // 直接调存储层：绕过"按钮禁用"那一层，验拒绝不只长在脸上
    await js(cdp, 'window.__ahub_debug.passGate()')
    await sleep(2500)
    const afterEmptyApprove = await js(cdp, `(() => {
      const r = window.__ahub_debug.state().run
      return { status: r?.status, gateKind: r?.gateKind, roles: (r?.cardDetails || []).map((c) => c.role) }
    })()`)
    ok('空计划时存储层也拒批准：执行卡片不出现、门仍挂在原地',
      !afterEmptyApprove.roles.includes('executor') && afterEmptyApprove.gateKind === 'plan' && afterEmptyApprove.status === 'waiting_user',
      JSON.stringify(afterEmptyApprove))
    await js(cdp, 'window.__ahub_debug.stopTask()')
    await sleep(1500)

    // ② 单次开关：全局计划态关着，只勾「本任务先出计划」——这一次仍应先出计划，且全局配置不被改动
    await js(cdp, 'window.__ahub_debug.restoreWorkflowConfig({ planFirst: false })')
    await js(cdp, 'window.__ahub_debug.closeTask()')
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(900)
    const preSingle = await js(cdp, '(() => ({ planFirst: !!window.__ahub_debug.state().config.planFirst }))()')
    await typeInto('.wf-composer-wrap textarea, .composer textarea', '单次计划态验证：先给计划')
    await sleep(400)
    const switchFound = await js(cdp, `(() => { const s = document.querySelector('button.switch[aria-label="本任务先出计划"]'); if (!s) return false; s.click(); return true })()`)
    await sleep(300)
    const beginClicked = await js(cdp, `(() => { const b = document.querySelector('button.wf-start'); if (!b) return false; b.click(); return true })()`)
    const singleGate = await waitJs(cdp, `(() => {
      const s = window.__ahub_debug.state()
      const r = s.run
      return r && r.gateKind === 'plan' ? { gateKind: r.gateKind, configPlanFirst: !!s.config.planFirst, roles: (r.cardDetails || []).map((c) => c.role) } : null
    })()`, 180000)
    ok('「本任务先出计划」是单次开关：全局关着也能让这一次先出计划',
      preSingle.planFirst === false && switchFound === true && beginClicked === true && !!singleGate && singleGate.gateKind === 'plan' && !singleGate.roles.includes('executor'),
      JSON.stringify({ preSingle, switchFound, beginClicked, singleGate }))
    ok('这一次之后全局配置仍是关的（单次勾选不许污染以后每一次提交）',
      !!singleGate && singleGate.configPlanFirst === false, JSON.stringify(singleGate))
    await js(cdp, 'window.__ahub_debug.stopTask()')
    await sleep(2000)
    await js(cdp, `window.__ahub_debug.setWorkflowOutputDir(${JSON.stringify(prevOutDir ?? '')})`)
    await sleep(800)

    // ---- 8. 清理现场：删除本次新增 Agent（含历史）与任务记录 ----
    const removed = await js(cdp, `window.__ahub_debug.removeAgentByName(${JSON.stringify(AGENT_NAME)})`)
    ok('清理：已删除 Mock Agent 及其历史', removed === true, String(removed))
    await sleep(1200)
    let runsAdded = 0
    for (const f of existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : []) {
      if (!runsBefore.has(f)) { rmSync(join(RUNS_DIR, f), { force: true }); runsAdded++ }
    }
    console.log(`  清理  删除本次新增任务记录 ${runsAdded} 个`)
    const after = await js(cdp, 'window.__ahub_debug.state()')
    // 诊断：若此处为 0，等 2.5s 再读一次——恢复说明是渲染进程重载后的水合瞬态，不恢复才是真丢状态
    const after2 = after.agents.length === before.agents.length ? after : await (async () => { await sleep(2500); return js(cdp, 'window.__ahub_debug.state()') })()
    console.log(`  [diag] 清理后 Agent 数：即时=${after.agents.length}，2.5s 后=${after2.agents.length}，基线=${before.agents.length}`)
    ok('清理后 Agent 数回到基线', after2.agents.length === before.agents.length, `${after.agents.length} / ${after2.agents.length} vs ${before.agents.length}`)
    // 单独钉"没有残留"而不是并进上面那条计数比对：计数比对把"删多了"和"删少了"混成一个数字，
    // 残留恰好是会把下一轮基线污染掉的那一侧，值得一条点名的断言。
    ok('清理后没有本套件专用名的 Agent 残留（残留会污染下一轮的基线与快照）',
      after2.agents.every((a) => a.name !== AGENT_NAME),
      after2.agents.filter((a) => a.name === AGENT_NAME).map((a) => a.id).join(',') || '（无残留）')
  } catch (e) {
    console.error('[ui] 失败：' + (e?.stack || e?.message || e))
    fail++
  } finally {
    // 还原用户产物目录：放在 finally，中途抛错/被打断也不会把配置留在测试沙箱路径上
    if (cdp && prevOutDir !== null) {
      try {
        await js(cdp, `window.__ahub_debug.setWorkflowOutputDir(${JSON.stringify(prevOutDir)})`)
        await sleep(600)
        console.log('  清理  已还原用户产物目录：' + JSON.stringify(prevOutDir))
      } catch { /* 页面可能已关，下面还会按字节还原整份配置 */ }
    }
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc?.kill() } catch { /* noop */ }
    await sleep(1000)
    // 修复波 B · 项 1b：按字节把整份 config.json 还原回测试前（含 workflowDefaults 三个角色 id）。
    // 先等实例退净：残留实例在场时回写，写的是那个活实例正在用的文件，它退出又会把测试态盖回去。
    await restoreWfHome(cdp, homePrev)
    if (!waitAppGone()) snapshotWriteAllowed = false
    if (cfgFile && snapshotWriteAllowed) {
      try {
        if (configSnapshot) writeFileSync(cfgFile, configSnapshot)
        else if (existsSync(cfgFile)) rmSync(cfgFile, { force: true })
      } catch (e) {
        fail++
        console.log(`  FAIL  config.json 快照还原抛错 —— ${e.message}（需要手工还原 ${cfgFile}）`)
      }
      const nowBytes = existsSync(cfgFile) ? readFileSync(cfgFile) : null
      const nowDefaults = defaultsOf(nowBytes)
      ok('还原真的跑了：config.json 回到测试前的字节内容，workflowDefaults 三个角色 id 逐一对上',
        !!configSnapshot && !!nowBytes && nowBytes.equals(configSnapshot) &&
          !!snapshotDefaults && !!nowDefaults &&
          nowDefaults.planner === snapshotDefaults.planner &&
          nowDefaults.executor === snapshotDefaults.executor &&
          nowDefaults.reviewer === snapshotDefaults.reviewer,
        `快照=${JSON.stringify(snapshotDefaults)} 现在=${JSON.stringify(nowDefaults)} 字节 ${nowBytes?.length ?? '文件不存在'} / ${configSnapshot?.length ?? 0}`)
    } else if (cfgFile) {
      fail++
      console.log('  FAIL  残留实例，拒绝回写快照 — AgentHub.exe 30s 内没退干净：宁可把 config.json 留在测试现场，也不往活实例的文件里写（需手工还原 ' + cfgFile + '）')
    } else {
      console.log('  注意  快照未取到（在读取配置之前就中止）：本轮没有字节快照可还原，config.json 保持现场不动')
    }
    try { mock.close() } catch { /* noop */ }
    rmSync(SANDBOX, { recursive: true, force: true })
  }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
