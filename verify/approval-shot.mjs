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
// 导入往返断言（第 9 节）会写真实的 config.json：快照按文件字节取，进程退出后按字节还原——
// 开发者的配置不留测试态（照本套件对审批历史"先快照、后还原"的约定办，只是这份更大）
let cfgFile = null
let configSnapshot = null
const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env: launchEnv() })
try {
  const page = await waitHttp(PORT, 30000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.__ahub_debug && !!window.agenthub', 30000)
  const historyBefore = await js(cdp, 'window.agenthub.approval.history(500)')
  cfgFile = join((await js(cdp, 'window.agenthub.app.info()')).userDataPath, 'config.json')
  configSnapshot = existsSync(cfgFile) ? readFileSync(cfgFile) : null

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
  // 本脚本自身产生 4 次确认：拒绝、本次允许、始终允许、危险形态拒绝
  const recCount = await js(cdp, 'document.querySelectorAll("[data-approval-record]").length')
  ok('审批历史列出了刚才的每一次确认', recCount >= 4, String(recCount))
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
  // launch 是新格式的启动依据（v0.4.0 起 planSpawn 只认 argv，command 是只读原文）
  const srv = { id: `gui-mcp-${Date.now().toString(36)}`, name: 'Mock MCP', command: `"${process.execPath}" "${MOCK_MCP}"`, launch: { bin: process.execPath, args: [MOCK_MCP] }, formatVersion: 2, enabled: true, timeoutMs: 8000 }
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

  // ---- 8b. MCP 新表单：argv 预览、.cmd 标注、legacy 停用（任务4 Step 5 真机断言）----
  const trustedBefore8 = await js(cdp, 'window.agenthub.mcp.trusted()')
  await js(cdp, `window.__ahub_debug.setMcpServers([{ id:'legacy1', name:'旧版样例', command:'\\"node\\" \\"x.js\\"', enabled:true }])`)
  await js(cdp, 'window.__ahub_debug.openSettings("mcp")')
  await sleep(500)
  const legacy = await js(cdp, '!!document.querySelector(\'[data-testid="mcp-legacy"]\')')
  ok('旧版单命令配置在界面上被标停用（不是让用户自己猜为什么连不上）', legacy === true)
  const stillListed = await js(cdp, 'document.body.innerText.includes("旧版样例")')
  ok('标停用但不删除记录（原命令还看得见）', stillListed === true)
  const probeLegacy = await js(cdp, `window.__ahub_debug.probeMcp({ id:'legacy1', name:'旧版样例', command:'"node" "x.js"' })`)
  ok('探测旧格式返回 invalid_legacy_command 码', String(probeLegacy?.message ?? '').includes('invalid_legacy_command'), JSON.stringify(probeLegacy))
  await js(cdp, `window.__ahub_debug.setMcpServers([{ id:'ok1', name:'新格式', command:'node x.js', launch:{ bin:'node', args:['x.js'] }, formatVersion:2, enabled:true }])`)
  await sleep(400)
  const noLegacy = await js(cdp, '!!document.querySelector(\'[data-testid="mcp-legacy"]\')')
  ok('新格式不再挂停用横幅', noLegacy === false)
  await js(cdp, 'window.__ahub_debug.setMcpServers([])')

  // 表单预演：实时 argv 预览 + comspec 披露 + 保存前的拒收原因（规则与主进程同一条 cmdUnsafeReason）
  const typeInto = (valueExpr) =>
    js(cdp, `(() => { const el = document.querySelector('[data-testid="mcp-command"]'); if (!el) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, ${valueExpr}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await typeInto(`'npx.cmd -y @scope/pkg'`)
  await sleep(250)
  const previewText = String(await js(cdp, `document.querySelector('[data-testid="mcp-argv-preview"]')?.textContent ?? ''`))
  const viaShell = await js(cdp, '!!document.querySelector(\'[data-testid="mcp-via-shell"]\')')
  ok('表单实时预演 argv，并如实标注 .cmd 家族要经 cmd 包一层（不冒充纯 argv 直传）',
    previewText.includes('npx.cmd') && previewText.includes('@scope/pkg') && viaShell === true, previewText.slice(0, 160))
  // 注意取值：tokenizeCommand 会把引号剥掉，表单里构造不出含 " 的 token；
  // % 能活着切进 argv（cmd 引号内也展开），是表单这一侧真实可达的拒收样本
  await typeInto(`'npx.cmd --tag=%USERPROFILE%'`)
  await sleep(250)
  const unsafeText = String(await js(cdp, `document.querySelector('[data-testid="mcp-cmd-unsafe"]')?.textContent ?? ''`))
  ok('保存前就把拒收规则写在界面上：点名是哪个 token、为什么（不必等保存后静默连不上）',
    unsafeText.includes('--tag=%USERPROFILE%'), unsafeText.slice(0, 160))
  // 现场还原：列表回 before、信任回测前（mcp:set 会连带清掉不再存在的 id 的信任，这是它的正确行为，测试自己负责复原）
  await js(cdp, `window.__ahub_debug.setMcpServers(${JSON.stringify(before)})`)
  for (const id of trustedBefore8) await js(cdp, `window.agenthub.mcp.setTrust(${JSON.stringify(id)}, true)`)
  const trusted8 = await js(cdp, 'window.agenthub.mcp.trusted()')
  ok('MCP 表单测试已还原：配置列表与信任都回到测试前',
    JSON.stringify(await js(cdp, 'window.agenthub.mcp.list()')) === JSON.stringify(before) &&
      trusted8.length === trustedBefore8.length && trustedBefore8.every((id) => trusted8.includes(id)))

  // ---- 9. 导入往返（任务2 遗留的真机收口；本节写真实 config.json，脚本末尾按字节还原）----
  console.log('\n[9] MCP 导入往返：旧记录标失效、脏元素不进取渲染层')
  const rt = await js(cdp, `window.__ahub_debug.configRoundTrip({ mcpServers: [{ id:'rt-old', name:'导入旧版', command:'node x.js', enabled:true }, null, { id:'rt-new', name:'导入新版', command:'node y.js', launch:{ bin:'node', args:['y.js'] }, enabled:true }] })`)
  ok('导入保住 mcpServers 且旧单命令当场被标失效停用（v0.3.0 会整键丢掉）',
    rt?.import?.ok === true && Array.isArray(rt?.config?.mcpServers) && rt.config.mcpServers.length === 3 &&
      rt.config.mcpServers[0]?.legacyInvalid === true && rt.config.mcpServers[0]?.enabled === false,
    JSON.stringify(rt?.config?.mcpServers)?.slice(0, 240))
  const rtList = await js(cdp, 'window.agenthub.mcp.list()')
  ok('脏元素（null）留在 config 里但被 mcp:list 挡下——挡脏数据是消费者的约定',
    Array.isArray(rtList) && rtList.length === 2 && rtList.every((s) => s && typeof s.id === 'string'), JSON.stringify(rtList).slice(0, 240))
  await js(cdp, 'window.__ahub_debug.closeSettings()')
  await sleep(120)
  await js(cdp, 'window.__ahub_debug.openSettings("mcp")')
  await sleep(500)
  const rtBody = String(await js(cdp, 'document.body.innerText'))
  const rtBanner = await js(cdp, `document.querySelectorAll('[data-testid="mcp-legacy"]').length`)
  ok('脏配置下设置页照常渲染：两条记录都看得见、旧版挂着停用横幅',
    rtBody.includes('导入旧版') && rtBody.includes('导入新版') && rtBanner === 1, rtBody.slice(0, 120))

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
} finally {
  await sleep(300)
  try { proc.kill() } catch { /* noop */ }
  // 应用退出后按字节还原 config.json：导入往返写过的内容（含 agents 的 hasKey 重置）一律回到测试前
  try {
    if (configSnapshot) writeFileSync(cfgFile, configSnapshot)
    else if (cfgFile && existsSync(cfgFile)) rmSync(cfgFile, { force: true })
  } catch (e) { console.log(`  WARN  config.json 还原失败：${e.message}（需要手工还原 ${cfgFile}）`) }
  await sleep(300)
  rmSync(dir, { recursive: true, force: true })
}
