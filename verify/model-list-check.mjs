// 应用内确认：两个 CLI 的模型清单走真实 IPC 返回什么
// 用法：node verify/model-list-check.mjs [--port=9231]
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9231
let failed = 0
let passed = 0
// 修复波 B · 项 1c 同类：这个套件此前只把 IPC 回包**打印**出来、一条断言都没有，
// run-all 于是永远报 `-/-`、连"有没有回包"都不判。下面补的是**结构契约**（有 ok 布尔，
// 且 ok:true 必须有 models 数组 / 否则必须有 message），不断言某个 CLI 一定装了模型
// ——那台机器没装 codex 时如实报 ok:false + message 是正确行为，不该判红。
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
try {
  const page = await waitHttp(PORT, 25000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 25000)
  for (const name of ['codex', 'codebuddy', 'dsh']) {
    const r = await js(cdp, `window.agenthub.cli.models(${JSON.stringify(name)})`)
    console.log(`${name}:`, JSON.stringify({ ok: r.ok, source: r.source, count: r.models?.length, models: r.models, message: r.message }))
    check(`cli:models(${name}) 回的是结构化结果（ok 布尔 + models 数组或 message）`,
      typeof r?.ok === 'boolean' && (Array.isArray(r?.models) || typeof r?.message === 'string'),
      JSON.stringify(r)?.slice(0, 160))
    if (name === 'codex') {
      // 用户拍定：界面上只显示他中转里的模型。清单来源必须是端点本身，
      // 不能再混本地 catalog 文件或 config.toml 的默认模型（那个默认值本机实测"清单里有、真调用被拒"）。
      check('codex 的模型清单只来自它实际连的中转端点（不再有 catalog/config 兜底）',
        r.ok === false || r.source === 'endpoint', JSON.stringify({ ok: r.ok, source: r.source })?.slice(0, 120))
    }
  }
  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
}
console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
