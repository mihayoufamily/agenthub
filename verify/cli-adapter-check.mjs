/**
 * CLI 适配层诊断：逐个 CLI 打印定位结果 + 连接测试 + 一次真实调用的事件流。
 * 用法：node verify/cli-adapter-check.mjs [--chat]
 * 说明：--chat 会真的发起一次 CLI 调用（消耗少量额度）；不加只做定位与 --version 探测。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cli = require('../out/main/adapters/cli.js')

const NAMES = ['arkcli', 'codex', 'codebuddy', 'dsh', 'claude']
const withChat = process.argv.includes('--chat')

for (const name of NAMES) {
  console.log(`\n========== ${name} ==========`)
  const target = await cli.resolveCliTarget(name).catch((e) => ({ error: String(e) }))
  if (!target || target.error) {
    console.log('定位:', target ? target.error : '未找到（null）')
    continue
  }
  console.log('定位:', JSON.stringify({ exe: target.exe, prefixArgs: target.prefixArgs, env: target.env, label: target.label }, null, 2))
  const test = await cli.testConnection(name)
  console.log('连接测试:', JSON.stringify(test))

  if (!withChat || !test.ok) continue

  const reqId = `diag-${name}-${Date.now()}`
  const events = []
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true, events }), 120000)
    cli.cliChatStream(name, {}, reqId, [{ role: 'user', content: '只回复两个字：好的' }], (ev) => {
      events.push(ev)
      if (ev.type === 'done' || ev.type === 'error') {
        clearTimeout(timer)
        // 让 stdout 剩余缓冲走完
        setTimeout(() => resolve({ events }), 500)
      }
    }).then((r) => {
      if (!r.ok) {
        clearTimeout(timer)
        resolve({ startFailed: r.message, events })
      }
    })
  })
  const deltas = (result.events || []).filter((e) => e.type === 'delta').map((e) => e.text).join('')
  const err = (result.events || []).find((e) => e.type === 'error')
  const usage = (result.events || []).find((e) => e.type === 'usage')
  console.log(`调用结果（${Date.now() - started}ms）:`, JSON.stringify({
    startFailed: result.startFailed,
    timeout: result.timeout,
    done: (result.events || []).some((e) => e.type === 'done'),
    text: deltas.slice(0, 200),
    error: err ? err.message : undefined,
    tokens: usage ? usage.usage?.tokens : undefined,
    eventCount: (result.events || []).length
  }, null, 2))
}
