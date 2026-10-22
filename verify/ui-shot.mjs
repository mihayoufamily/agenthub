// UI 布局与新功能真机核验（CDP 驱动便携版）
// 用法：node verify/ui-shot.mjs [--exe=d:/AgentHub/AgentHub.exe] [--port=9231]
// 会写入真实 %APPDATA%/agenthub：结束后自动删除本次新增的 Mock Agent（含历史）
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

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
const setViewport = async (w, h) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
}

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${mock.address().port}/v1`
  console.log('[ui] mock 服务：' + baseUrl + '，沙箱：' + SANDBOX)

  proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
  try {
    const page = await waitHttp(PORT, 30000)
    cdp = new CdpClient(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    if (!(await waitJs(cdp, '!!window.__ahub_debug', 30000))) throw new Error('页面未就绪')

    // 等水合完成再取基线：__ahub_debug 比 store 水合早几十毫秒就绪，读太早会拿到 0 个 Agent
    await waitJs(cdp, 'window.__ahub_debug.state().agents.length > 0 || !!window.__ahub_debug.state().selectedId', 15000)
    const before = await js(cdp, 'window.__ahub_debug.state()')
    console.log('[ui] 启动前 Agent 数：' + before.agents.length)
    prevOutDir = before.configOutputDir ?? ''
    console.log('[ui] 用户产物目录（结束时要还原成这个）：' + JSON.stringify(prevOutDir))
    const RUNS_DIR = join(process.env.APPDATA ?? '', 'agenthub', 'runs')
    const runsBefore = new Set(existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : [])
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
      return { shown: v.querySelector('.tv-body').textContent, btn: btn ? btn.textContent.trim() : null }
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
    await js(cdp, 'window.__ahub_debug.settings()')
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
    ok('设置弹窗已关闭', !(await js(cdp, '!!document.querySelector(".settings-win")')))

    // ---- 6. 工作流首页（保存任务卡片是否遮挡）----
    await js(cdp, 'window.__ahub_debug.workflow()')
    await sleep(1200)
    await shot('09-workflow-home')
    const wfAudit = await layoutAudit()
    ok('工作流首页无横向溢出', wfAudit.total === 0, JSON.stringify(wfAudit.issues?.slice(0, 4)))
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
      await shot('11-workflow-tool-artifact')
    }
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
      } catch { /* 页面可能已关，下面还会检查一次配置文件 */ }
    }
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc?.kill() } catch { /* noop */ }
    await sleep(1000)
    mock.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
