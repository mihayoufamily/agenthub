/**
 * CLI 思考过程真机核验（需求 3）：真实 spawn codex / codebuddy，断言适配层吐出 reasoning 事件。
 * 用法：node verify/cli-thinking.mjs [codex] [codebuddy]
 * 说明：会真实调用本机 CLI（消耗少量额度）；cwd 用临时目录，不写任何用户数据，结束即删。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const cli = require('../out/main/adapters/cli.js')

const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const NAMES = asked.length ? asked : ['codex', 'codebuddy']
const PROMPT = '先想清楚再回答：为什么 0.1 + 0.2 不等于 0.3？用一两句话说明。'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

for (const name of NAMES) {
  console.log(`\n========== ${name} ==========`)
  if (!cli.isKnownCli(name)) { ok(`${name} 是已知 CLI`, false); continue }
  const test = await cli.testConnection(name)
  ok(`${name} 连接可用`, test.ok, test.message)
  if (!test.ok) continue

  const dir = mkdtempSync(join(tmpdir(), 'ahub-cli-think-'))
  const events = []
  const reqId = `think-${name}-${Date.now()}`
  const started = Date.now()
  try {
    // cliChatStream 在 spawn 成功时就返回，事件是之后流进来的：必须等 done/error，不能等 promise
    const settled = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 180000)
      void cli
        .cliChatStream(name, { workDir: dir, thinkingLevel: 'low' }, reqId, [{ role: 'user', content: PROMPT }], (ev) => {
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
    if (settled.timeout) cli.cancelChat(reqId)
    const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.text)
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('')
    const err = events.find((e) => e.type === 'error')
    console.log(`  [${Date.now() - started}ms] 事件 ${events.length} 条 · 思考 ${reasoning.length} 段 · 正文 ${text.length} 字`)
    console.log('  结束状态:', JSON.stringify(settled).slice(0, 200))
    if (reasoning.length) console.log('  思考首段:', JSON.stringify(reasoning[0].slice(0, 120)))
    if (err) console.log('  错误:', String(err.message).slice(0, 200))
    else if (!reasoning.length) console.log('  事件类型:', JSON.stringify(events.map((e) => e.type).slice(0, 20)))
    ok(`${name} 吐出 reasoning 事件（工作流卡片过程区的数据源）`, reasoning.length > 0 && !settled.timeout, err ? String(err.message).slice(0, 120) : '')
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
