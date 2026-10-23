// 截图 + 断言：工作流模式的三角色配置条（跨厂商绑定）
// 用法：node verify/workflow-config-shot.mjs [--exe=d:\AgentHub\AgentHub.exe] [--port=9228]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const EXE = resolve(args.exe ?? 'd:/AgentHub/AgentHub.exe')
const PORT = Number(args.port ?? 9228)
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'shots-cli')

const main = async () => {
  if (!existsSync(EXE)) { console.error('未找到便携版：' + EXE); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
  let cdp
  let failed = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('  ✓ ' + name)
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
    await sleep(1500)

    // 先把角色绑定设成断言需要的状态：不能假设用户当前绑了谁（他在界面上随时能改，
    // 上一轮就是因为用户把审核换成演示 Agent 而假失败）
    // Agent 名是用户在界面上**自填**的，大小写由他决定（本机那三个是 DeepSeek / CodeBuddy / Codex）。
    // 原来这里用大小写敏感子串匹配，`deepseek` 匹配不上 `DeepSeek` → 前置检查失败、三条角色断言连带红
    // （本套件共 7 条 check，实测 4 红 3 绿，从没跑完过 —— Ruling R）。匹配一律大小写不敏感；前置检查的文案不动。
    const st0 = await js(cdp, 'window.__ahub_debug.state()')
    const find = (n) => st0.agents.find((a) => String(a?.name ?? '').toLowerCase().includes(String(n).toLowerCase()))
    const want = { deepseek: find('deepseek'), CodeBuddy: find('CodeBuddy'), Codex: find('Codex') }
    const missing = Object.entries(want).filter(([, a]) => !a).map(([k]) => k)
    check('本机存在 deepseek / CodeBuddy / Codex 三个 Agent', missing.length === 0, '缺：' + missing.join(','))
    const bind = (k) => ({ agentId: want[k].id, agentName: want[k].name, model: want[k].model })
    if (!missing.length) {
      await js(cdp, `window.__ahub_debug.restoreWorkflowConfig(${JSON.stringify({
        planner: bind('deepseek'), executor: bind('CodeBuddy'), reviewer: bind('Codex'), reviewMode: 'human'
      })})`)
      await sleep(1200)
    }

    const chips = await js(cdp, `[...document.querySelectorAll('.cfg-chip')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`)
    console.log('配置条：', JSON.stringify(chips, null, 2))

    check('规划角色 = deepseek', /deepseek/i.test(chips?.[0] ?? ''), chips?.[0])
    check('执行角色 = CodeBuddy', /CodeBuddy/i.test(chips?.[1] ?? ''), chips?.[1])
    check('审核角色 = Codex', /Codex/i.test(chips?.[2] ?? ''), chips?.[2])
    check('审核方式 = 人工确认', /人工确认/.test(JSON.stringify(chips)), JSON.stringify(chips))
    check('未处于运行态（无任务）', !(await js(cdp, `!!document.querySelector('.wf-topbar')`)))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(OUT, 'workflow-roles.png'), Buffer.from(shot.data, 'base64'))
    console.log('已保存：' + resolve(OUT, 'workflow-roles.png'))
    // 还原用户原有绑定，别把测试用的组合留在他的配置里
    await js(cdp, `window.__ahub_debug.restoreWorkflowConfig(${JSON.stringify(st0.config)})`)
    await sleep(800)
    const restored = await js(cdp, 'window.__ahub_debug.state()')
    check('已还原用户原有角色绑定', restored.config.planner.agentId === st0.config.planner.agentId && restored.config.reviewer.agentId === st0.config.reviewer.agentId)
  } catch (e) {
    failed++
    console.error('失败：' + e.message)
  } finally {
    try { cdp?.socket?.end() } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
    await sleep(800)
  }
  process.exit(failed === 0 ? 0 : 1)
}

void main()
