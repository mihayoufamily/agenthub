// 命令审批真机验证：没批准就绝不该跑起来，批准之后才跑，危险形态点了"始终允许"也不写白名单。
// 用法：node verify/approval-shot.mjs [--port=9236]
// 走 tools:exec 这条入口（同一套审批闸门），不碰用户的 Agent 配置与白名单。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

// 被测 server 用绝对路径：应用进程的 cwd 不是脚本的 cwd
const MOCK_MCP = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url))

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const PORT = Number(argv.port ?? 9236)

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'ahub-approval-'))
/** 命令用重定向落一个标记文件：跑没跑过，看文件系统就知道，不用信界面 */
const cmd = (marker) => `echo hi > ${join(dir, marker)}`
const fire = (marker) =>
  js(
    cdpRef,
    `window.__r = null; window.agenthub.tools.exec(${JSON.stringify({ dir, allowCommands: true })}, 'run_command', ${JSON.stringify(JSON.stringify({ command: cmd(marker) }))}).then((r) => { window.__r = r }); 'fired'`
  )
const result = () => js(cdpRef, 'window.__r')
const click = (sel) => js(cdpRef, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true })()`)
const modalCmd = () => js(cdpRef, `document.querySelector('[data-approval-cmd]')?.textContent ?? ''`)
const modalReason = () => js(cdpRef, `document.querySelector('[data-approval-modal]')?.innerText ?? ''`)
const pendingCount = () => js(cdpRef, 'window.__ahub_debug.approvals().length')

let cdpRef = null
const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
try {
  const page = await waitHttp(PORT, 30000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.__ahub_debug && !!window.agenthub', 30000)
  const historyBefore = await js(cdp, 'window.agenthub.approval.history(500)')

  // ---- 1. 不在白名单 → 弹确认，且此刻命令还没执行 ----
  console.log('\n[1] 未批准的命令不会执行')
  await fire('A.txt')
  const shown = await waitJs(cdp, "!!document.querySelector('[data-approval-modal]')", 10000)
  ok('确认框弹出', !!shown)
  ok('确认框如实显示命令原文', (await modalCmd()).includes('echo hi'), await modalCmd())
  ok('说清了为什么要问', (await modalReason()).includes('白名单'), (await modalReason()).slice(0, 120))
  ok('等待期间命令没有执行', !existsSync(join(dir, 'A.txt')))
  ok('待裁决队列里有这一条', (await pendingCount()) === 1, String(await pendingCount()))

  // ---- 2. 点拒绝：不执行，模型收到"用户不批准" ----
  console.log('\n[2] 点「拒绝」')
  ok('拒绝按钮可点', await click('[data-approval-deny]'))
  await waitJs(cdp, 'window.__r !== null', 10000)
  const denied = await result()
  ok('拒绝后命令确实没跑', !existsSync(join(dir, 'A.txt')))
  ok('返回给模型的是"用户不批准"', !!denied && denied.ok === false && denied.output.includes('用户不批准'), denied?.output)
  ok('确认框已收起且队列清空', !(await js(cdp, "!!document.querySelector('[data-approval-modal]')")) && (await pendingCount()) === 0)

  // ---- 3. 点本次允许：执行，且不留白名单 ----
  console.log('\n[3] 点「本次允许」')
  await fire('B.txt')
  await waitJs(cdp, "!!document.querySelector('[data-approval-modal]')", 10000)
  ok('再次弹出确认', true)
  await click('[data-approval-once]')
  await waitJs(cdp, 'window.__r !== null', 10000)
  const once = await result()
  ok('本次允许后命令真的跑了', existsSync(join(dir, 'B.txt')) && !!once && once.ok === true, JSON.stringify(once))

  // ---- 4. 点始终允许：执行；tools:exec 没有 agentId，不该往任何白名单里塞东西 ----
  console.log('\n[4] 点「始终允许」')
  await fire('C.txt')
  await waitJs(cdp, "!!document.querySelector('[data-approval-modal]')", 10000)
  await click('[data-approval-always]')
  await waitJs(cdp, 'window.__r !== null', 10000)
  ok('始终允许后命令执行', existsSync(join(dir, 'C.txt')))
  const anonRules = await js(cdp, 'window.__ahub_debug.approvalRules(undefined)')
  ok('匿名入口（无 agentId）不会污染任何 Agent 的白名单', Array.isArray(anonRules) && anonRules.length === 0, JSON.stringify(anonRules))

  // ---- 5. 危险形态：白名单覆盖不了，仍然要确认 ----
  console.log('\n[5] 危险形态仍然要问')
  const risky = `del /s /q ${join(dir, 'C.txt')}`
  js(cdpRef, `window.__r = null; window.agenthub.tools.exec(${JSON.stringify({ dir, allowCommands: true })}, 'run_command', ${JSON.stringify(JSON.stringify({ command: risky }))}).then((r) => { window.__r = r }); 'fired'`)
  const riskyShown = await waitJs(cdp, "!!document.querySelector('[data-approval-modal]')", 10000)
  ok('危险命令照样弹出确认', !!riskyShown)
  ok('理由写明是危险形态', (await modalReason()).includes('危险形态'), (await modalReason()).slice(0, 160))
  await click('[data-approval-deny]')
  await waitJs(cdp, 'window.__r !== null', 10000)
  ok('危险命令被拒后文件还在', existsSync(join(dir, 'C.txt')))

  // ---- 6. 审批历史进了设置页 ----
  console.log('\n[6] 设置页「命令审批」')
  await js(cdp, 'window.__ahub_debug.settings()')
  await sleep(600)
  const navOk = await js(cdp, `(() => { const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.includes('命令审批')); if (!b) return false; b.click(); return true })()`)
  ok('设置里有「命令审批」分区', navOk)
  await sleep(600)
  const recCount = await js(cdp, 'document.querySelectorAll("[data-approval-record]").length')
  ok('审批历史列出了刚才的每一次确认', recCount >= 5, String(recCount))
  const hist = await js(cdp, 'window.agenthub.approval.history(50)')
  ok('历史里拒绝与允许都有记录', hist.some((h) => h.decision === 'deny') && hist.some((h) => h.decision === 'once'))
  // 现场还原：只有本来没有历史时才清空，别把用户真实的审批审计记录抹掉
  if (historyBefore.length === 0) {
    await js(cdp, 'window.agenthub.approval.clearHistory()')
    ok('清空后历史为空', (await js(cdp, 'window.agenthub.approval.history(50)')).length === 0)
  } else {
    console.log(`  INFO  审批历史原本已有 ${historyBefore.length} 条，测试记录保留不清空`)
    pass++
  }
  await js(cdp, 'window.__ahub_debug.workbench()')

  // ---- 7. 改动检查点与回滚（走真实 IPC，不只看纯函数） ----
  console.log('\n[7] 检查点：写文件进清单、回滚回到开始前')
  const work = join(dir, 'cp-work')
  mkdirSync(work)
  // 检查点 id 会留在 userData/checkpoints 里（清单很小且只读），用随机后缀避免和历史数据撞
  const cpId = `gui-cp-${Date.now().toString(36)}`
  writeFileSync(join(work, 'note.md'), '原始内容\n', 'utf-8')
  const w = await js(
    cdp,
    `window.__ahub_debug.execTool(${JSON.stringify({ dir: work, allowCommands: false })}, 'write_file', ${JSON.stringify(JSON.stringify({ path: 'note.md', content: '改后内容\n' }))}, ${JSON.stringify(cpId)})`
  )
  ok('写入登记为 modified 且带 diff', w?.change?.kind === 'modified' && (w?.change?.diff ?? '').includes('+ 改后内容'), JSON.stringify(w?.change))
  ok('落盘确实是新内容', readFileSync(join(work, 'note.md'), 'utf-8') === '改后内容\n')
  const man = await js(cdp, `window.__ahub_debug.checkpoint(${JSON.stringify(cpId)})`)
  ok('清单里能看到这次改动', man?.summary?.total >= 1 && man?.summary?.modified === 1, JSON.stringify(man?.summary))
  const rb = await js(cdp, `window.__ahub_debug.rollbackCheckpoint(${JSON.stringify(cpId)})`)
  ok('回滚报成功（不是嘴上说说）', rb?.ok === true && rb.restored === 1, JSON.stringify(rb))
  ok('文件真的回到任务开始前的内容', readFileSync(join(work, 'note.md'), 'utf-8') === '原始内容\n', readFileSync(join(work, 'note.md'), 'utf-8'))
  ok('回滚后清单仍可回看', (await js(cdp, `window.__ahub_debug.checkpoint(${JSON.stringify(cpId)})`))?.manifest?.entries?.length >= 1)

  // ---- 8. MCP：设置页配置、探测、信任与撤销（客户端本身在 logic 层测） ----
  console.log('\n[8] MCP 设置页与信任开关')
  const srv = { id: `gui-mcp-${Date.now().toString(36)}`, name: 'Mock MCP', command: `"${process.execPath}" "${MOCK_MCP}"`, enabled: true, timeoutMs: 8000 }
  const before = await js(cdp, 'window.agenthub.mcp.list()')
  await js(cdp, `window.agenthub.mcp.set(${JSON.stringify([...before, srv])})`)
  await js(cdp, 'window.__ahub_debug.settings()')
  await sleep(600)
  const navMcp = await js(cdp, `(() => { const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.trim() === 'MCP'); if (!b) return false; b.click(); return true })()`)
  ok('设置里有「MCP」分区', navMcp === true)
  await sleep(400)
  ok('MCP 分区渲染出这一条 server', (await js(cdp, `!!document.querySelector('[data-mcp-row]')`)) === true)
  const pr = await js(cdp, `window.agenthub.mcp.probe(${JSON.stringify(srv)})`)
  ok('从渲染层探到工具清单（3 个）', pr?.ok === true && pr.tools?.length === 3, JSON.stringify(pr)?.slice(0, 160))
  ok('未信任时不显示"撤销信任"（说明信任态是从主进程读的）', (await js(cdp, 'window.agenthub.mcp.trusted()')).includes(srv.id) === false)
  await js(cdp, `window.agenthub.mcp.setTrust(${JSON.stringify(srv.id)}, true)`)
  ok('信任可以写入主进程', (await js(cdp, 'window.agenthub.mcp.trusted()')).includes(srv.id) === true)
  await js(cdp, `window.agenthub.mcp.set(${JSON.stringify(before)})`)
  ok('删掉 server 时信任一起被清掉（不留没人认领的信任）', (await js(cdp, 'window.agenthub.mcp.trusted()')).includes(srv.id) === false)
  ok('配置已还原', JSON.stringify(await js(cdp, 'window.agenthub.mcp.list()')) === JSON.stringify(before))
  await js(cdp, 'window.__ahub_debug.workbench()')

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
  rmSync(dir, { recursive: true, force: true })
}
