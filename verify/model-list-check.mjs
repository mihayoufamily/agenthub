// 应用内确认：两个 CLI 的模型清单走真实 IPC 返回什么
// 用法：node verify/model-list-check.mjs [--port=9231]
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9231
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
  }
  cdp.socket.end()
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
}
