/**
 * CLI 思考过程真机核验（需求 3）：真实 spawn codex / codebuddy，断言适配层吐出 reasoning 事件。
 * 用法：node verify/cli-thinking.mjs [codex] [codebuddy] [--model <id>]
 * 说明：会真实调用本机 CLI（消耗少量额度）；cwd 用临时目录，不写任何用户数据，结束即删。
 *
 * 为什么要自己挑模型：不传 `-m` 时 codex 回落到 `~/.codex/config.toml` 的全局默认模型，
 * 而本机那个默认值（gpt-5.5）被本地代理**广告在 /models 里、真调用时拒**——套件于是恒红，
 * 红的却不是被测代码。挑法：`--model` 优先，否则读**只读**的用户 config 里同名 CLI Agent 已绑的
 * model（工作站跑的就是它）；两条都拿不到才退回不传（行为同从前，并在日志里说明）。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const cli = require('../out/main/adapters/cli.js')

const argv = process.argv.slice(2)
const modelFlagIdx = argv.indexOf('--model')
const MODEL_FLAG = modelFlagIdx >= 0 ? String(argv[modelFlagIdx + 1] || '').trim() : ''
const positional = modelFlagIdx >= 0 ? argv.filter((_, i) => i !== modelFlagIdx && i !== modelFlagIdx + 1) : argv
const NAMES = positional.filter((a) => !a.startsWith('--'))
const TARGETS = NAMES.length ? NAMES : ['codex', 'codebuddy']
const PROMPT = '先想清楚再回答：为什么 0.1 + 0.2 不等于 0.3？用一两句话说明。'

/** 只读用户 config，取该 CLI 在工作站里已绑并跑通过的模型与思考强度（工作站跑的就是这套参数） */
function cliSettingsFromAppConfig(name) {
  const out = { model: '', thinkingLevel: 'low' }
  try {
    const file = join(process.env.APPDATA || '', 'agenthub', 'config.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    const hit = (cfg.agents || []).find((a) => a?.cliConfig?.cli === name)
    if (hit) {
      if (String(hit.cliConfig.model || '').trim()) out.model = String(hit.cliConfig.model).trim()
      if (String(hit.cliConfig.thinkingLevel || '').trim()) out.thinkingLevel = String(hit.cliConfig.thinkingLevel).trim()
    }
  } catch {
    /* 读不到就按默认参数跑，日志里会写清楚用的是哪套 */
  }
  return out
}

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

for (const name of TARGETS) {
  console.log(`\n========== ${name} ==========`)
  if (!cli.isKnownCli(name)) { ok(`${name} 是已知 CLI`, false); continue }
  const test = await cli.testConnection(name)
  ok(`${name} 连接可用`, test.ok, test.message)
  if (!test.ok) continue

  const fromApp = cliSettingsFromAppConfig(name)
  const model = MODEL_FLAG || fromApp.model
  const thinkingLevel = fromApp.thinkingLevel
  console.log(`  模型: ${model || '(不传 -m，用该 CLI 自己的默认模型)'} · 思考强度: ${thinkingLevel}`)
  const dir = mkdtempSync(join(tmpdir(), 'ahub-cli-think-'))
  const started = Date.now()
  try {
    // 上游这一轮吐几段思考摘要**不可控**（同机同参数实测过 1 段与 0 段），所以"真跑必须看到思考"
    // 不能当门禁——那是一条会随机红的断言。产品承诺"它吐了我们就得并进思考区"改由逻辑层跑真代码钉住
    // （`fixes-check` 的 `[CLI]` 段：`codexReasoningParts` 两条）。这里只如实报告观察到几段。
    // 重试只针对"没走到 done"（挂起/中断是外部不确定），不针对思考段数。
    let reasoning = []
    let text = ''
    let err = null
    let timedOut = false
    let sawDone = false
    let attempts = 0
    while (attempts < 2 && !(sawDone && !err)) {
      attempts++
      const events = []
      const reqId = `think-${name}-${Date.now()}-${attempts}`
      const settled = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 180000)
        void cli
          .cliChatStream(name, { workDir: dir, thinkingLevel, model }, reqId, [{ role: 'user', content: PROMPT }], (ev) => {
            events.push(ev)
            if (ev.type === 'done' || ev.type === 'error') {
              clearTimeout(timer)
              setTimeout(() => resolve({ finished: true }), 800)
            }
          })
          .then((r) => {
            if (!r.ok) {
              clearTimeout(timer)
              resolve({ startFailed: r.message })
            }
          })
      })
      timedOut = !!settled.timeout
      if (settled.timeout) cli.cancelChat(reqId)
      reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.text)
      text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('')
      err = events.find((e) => e.type === 'error')
      sawDone = events.some((e) => e.type === 'done')
      console.log(`  [第 ${attempts} 次 / ${Date.now() - started}ms] 事件 ${events.length} 条 · 思考 ${reasoning.length} 段 · 正文 ${text.length} 字`)
      console.log('  结束状态:', JSON.stringify(settled).slice(0, 200))
      if (reasoning.length) console.log('  思考首段:', JSON.stringify(reasoning[0].slice(0, 120)))
      if (err) console.log('  错误:', String(err.message).slice(0, 200))
      else if (!reasoning.length) console.log('  事件类型:', JSON.stringify(events.map((e) => e.type).slice(0, 20)))
      if (!sawDone && !err && attempts < 2) console.log('  这次没走到 done（挂起或中断），再跑一次确认——重试只针对流不完整，不针对思考段数')
    }
    // 上游这一轮吐几段思考摘要**不可控**（同机同参数实测过 1 段与 0 段），所以"真跑必须看到思考"
    // 不能当门禁——那是一条会随机红的断言。产品承诺"它吐了我们就得并进思考区"改由逻辑层跑真代码钉住
    // （`fixes-check` 的 `[CLI]` 段：`codexReasoningParts` 两条）。这里只如实报告本轮观察到几段。
    console.log(`  观察  本轮上游给了 ${reasoning.length} 段思考摘要`)
    ok(`${name} 事件流完整（done 到达、不挂起、没有未处理错误）`, !timedOut && !err && sawDone, JSON.stringify({ timedOut, err: err && String(err.message).slice(0, 90) }))
    ok(`${name} 有正文回答`, text.trim().length > 0)
    // 多段思考之间必须留空行（分隔符补在后续段开头），否则界面里黏成一段、"只显重点"分段筛选失效
    ok(`${name} 多段思考之间有空行分隔（或只有一段）`, reasoning.length < 2 || reasoning.slice(1).every((t) => t.startsWith('\n\n')), JSON.stringify(reasoning[1]?.slice(0, 40)))
  } finally {
    // CLI 子进程可能还占着 cwd 句柄：等它退出并带重试，避免 EPERM 把临时目录留成垃圾
    await new Promise((r) => setTimeout(r, 1500))
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (e) {
      console.log('  清理临时目录失败（需手工删除）:', dir, String(e).slice(0, 80))
    }
  }
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
