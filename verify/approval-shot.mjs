// 命令审批真机验证：没批准就绝不该跑起来，批准之后才跑，危险形态点了"始终允许"也不写白名单。
// 用法：node verify/approval-shot.mjs [--port=9236]
// 走 tools:exec 这条入口（同一套审批闸门），不碰用户的 Agent 配置与白名单。
// 启动带 --ahub-verify：config:importJson（整份导入通道）只在主进程 argv 有这个验证开关时才注册
// （评审修复4），第 9/10 节的导入往返依赖它，第 12 节的降级门控也依赖它（env 单独不成）；
// 第 11 节会不带开关重启一次，反证通道确实没注册、门控确实不生效。
// 本套件起三个实例（单实例锁，逐个等上一个退净）：主实例 + 无验证开关 + 带降级门控，
// 分别覆盖审批/导入、闸门反证、以及兼容模式徽章的正反两向（[0] 反向在主实例里）。
// 徽章单挂在 Shell（工作站/工作流共用外壳），正反两向都在**两种模式**下各断一次（评审 finding 3）。
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

// 被测 server 用绝对路径：应用进程的 cwd 不是脚本的 cwd
const MOCK_MCP = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url))

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))
const PORT = Number(argv.port ?? 9236)

/** 等 AgentHub.exe 退干净：单实例锁下残留进程会让第二个实例秒退（run-all 里同样的坑） */
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

/**
 * 修复波 B · 项 1（评审 Minor ㉜）：残留实例不是"警告一下继续跑"级别的事。
 * 本套件末尾会把 userData 的 config.json 字节快照**回写磁盘**；只要还有一个 AgentHub 实例活着，
 * 回写目标就可能是那个活实例正在使用的文件（它在退出时又会把自己的内存态盖回去），
 * 于是用户的配置被留在测试中间态里。所以这里一律中止：抛错 → catch 记一条 FAIL → 非零退出，
 * 并把 snapshotWriteAllowed 关掉，让 finally 不再碰那个文件（宁可留测试态，也不要写坏活实例）。
 * 这条不是理论风险：Task 4 的 GREEN 复跑就是被用户 17:18 启动的 AgentHub 挡住的，
 * 当时的行为正是 WARN 之后继续。
 */
function requireAppGone(who) {
  if (waitAppGone()) return
  snapshotWriteAllowed = false
  throw new Error(`残留实例：${who} 30s 内没退干净，AgentHub.exe 仍在运行 —— 中止本套件，拒绝把 userData 快照回写 config.json（先确认没有别的人在用这台机器上的 AgentHub，再重跑）`)
}

// [10] 要驱动一次真 model:chat（MCP 首次连接信任弹窗在 chat 装配线上才会问人）：
// 本地 mock OpenAI 兼容服务，与 ui-shot 同款最小形状——GET /models 供连接测试，
// POST /chat/completions 流一段正文后收尾。
const mockLlm = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    return
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404).end('{}')
})
// 修复波 B · 项 1（评审 Minor ㉛）：listen 原来排在 try **之前**，而 try/finally 之间还夹着
// mkdtempSync 与 spawn ——那两步任一抛异常就根本没有 finally 去 close 这个监听中的 socket，
// 进程因为活跃 handle 永远不退出：表现是"套件挂住"，不是"套件失败"（挂住的套件在 run-all 里
// 连退出码都拿不到，比红更糟）。现在 listen 与它后面的每一步都在同一个 try 里，finally 保证 close。
let llmBase = null
let dir = null

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}
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
/** 工作屏渲染完成的锚点：空状态/有 Agent 两种顶栏都带 .wb-topbar（徽章本身单挂在 Shell，不在这条栏里） */
async function gotoWorkbench(c) {
  for (let i = 0; i < 24; i++) {
    await js(c, 'window.__ahub_debug.workbench()')
    if (await js(c, "!!document.querySelector('.wb-topbar')")) return true
    await sleep(500)
  }
  return false
}
/** 工作流屏渲染完成的锚点：WorkflowHome 的 .wf-configbar / TaskView 的 .wf-topbar 任一出现 */
async function gotoWorkflow(c) {
  for (let i = 0; i < 24; i++) {
    await js(c, 'window.__ahub_debug.workflow()')
    if (await js(c, "!!document.querySelector('.wf-configbar') || !!document.querySelector('.wf-topbar')")) return true
    await sleep(500)
  }
  return false
}
// 导入往返断言（第 9 节）会写真实的 config.json：快照按文件字节取，进程退出后按字节还原——
// 开发者的配置不留测试态（照本套件对审批历史"先快照、后还原"的约定办，只是这份更大）
let cfgFile = null
let configSnapshot = null
// 修复波 B · 项 1（评审 Minor ㉜）：残留实例在场时**拒绝**回写快照（见 requireAppGone）。
let snapshotWriteAllowed = true
let proc = null
try {
  await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${mockLlm.address().port}/v1`
  dir = mkdtempSync(join(tmpdir(), 'ahub-approval-'))
  proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify'], { stdio: 'ignore', env: launchEnv() })
  const page = await waitHttp(PORT, 30000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.__ahub_debug && !!window.agenthub', 30000)
  const historyBefore = await js(cdp, 'window.agenthub.approval.history(500)')
  cfgFile = join((await js(cdp, 'window.agenthub.app.info()')).userDataPath, 'config.json')
  configSnapshot = existsSync(cfgFile) ? readFileSync(cfgFile) : null

  // ---- 0. 兼容模式徽章 · 反向（Task 6 Step 7a）：这一台是没降级的正常进程，徽章不该出现 ----
  // 徽章有两个失败方向：该显示时不显示（用户不知道沙箱关了）、不该显示时常驻（变成噪音）。
  // 这条进程就是"不该显示"的那一半，正向放在末尾 [12] 用门控 env 起的第三个实例里验。
  console.log('\n[0] 兼容模式徽章：正常启动不该有它')
  const onWb = await gotoWorkbench(cdp)
  ok('顶栏渲染出来了（反向断言有挂载点，不是空转）', onWb === true)
  const compatNormal = await js(cdp, 'window.__ahub_debug.compat()')
  ok('正常启动时 noSandbox 为假', compatNormal?.noSandbox === false, JSON.stringify(compatNormal))
  const badgeAbsent = await js(cdp, 'document.body.innerText.includes("兼容模式")')
  ok('正常启动不显示兼容模式徽章（不是常驻噪音）', badgeAbsent === false)
  ok('DOM 里也没有徽章节点，reason 为空', (await js(cdp, "!!document.querySelector('[data-compat-badge]')")) === false && (compatNormal?.reason ?? '') === '', JSON.stringify(compatNormal))
  // 徽章单挂 Shell（评审 finding 3）后，反向也要覆盖工作流屏：没降级时两种模式都不该出现
  const onWf0 = await gotoWorkflow(cdp)
  ok('工作流屏也渲染出来了（反向断言在两种模式都有挂载点，不是空转）', onWf0 === true)
  ok('正常启动切进工作流模式同样没有徽章节点（常驻≠噪音：没降级两种模式都不出现）',
    onWf0 && (await js(cdp, "document.querySelectorAll('[data-compat-badge]').length")) === 0)

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
  await js(cdp, 'window.__ahub_debug.openSettings()')
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
  await js(cdp, 'window.__ahub_debug.openSettings()')
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
  // 表单侧真实可达的两类被拒 token：% 能活着切进 argv（cmd 引号内也展开）；" 同样能——
  // tokenizeCommand 在单引号区内原样保留另一种引号（argv.ts:32-37），npx.cmd -y 'a"b' 会切出
  // 含 " 的 token 命中 cmdUnsafeReason 分支①。（上一轮"表单里构造不出含 \" 的 token"的注释是错的，
  // 评审实测推翻：该形态可达，这里把它补成端到端样本，不再只靠逻辑层钉。）
  await typeInto(`'npx.cmd --tag=%USERPROFILE%'`)
  await sleep(250)
  const unsafeText = String(await js(cdp, `document.querySelector('[data-testid="mcp-cmd-unsafe"]')?.textContent ?? ''`))
  ok('保存前就把拒收规则写在界面上：点名是哪个 token、为什么（不必等保存后静默连不上）',
    unsafeText.includes('--tag=%USERPROFILE%'), unsafeText.slice(0, 160))
  await typeInto(JSON.stringify(`npx.cmd -y 'a"b'`))
  await sleep(250)
  const unsafeQuote = String(await js(cdp, `document.querySelector('[data-testid="mcp-cmd-unsafe"]')?.textContent ?? ''`))
  ok('含 " 的 token 从表单真实可达且保存前被点名拒收（单引号区保留 "，"仅逻辑层覆盖"的补链）',
    unsafeQuote.includes('a"b'), unsafeQuote.slice(0, 200))

  // ---- 评审修复3(a)：command 为空但 launch 已填的记录必须活着存进 config ----
  // 原先这条只被 fixes-check 的 ipc.ts 源码 grep "钉"着——排版一变或行为回归，grep 照样绿。
  // 这里改为真机写入 + 回读，mcp:set 的 launch 放行从此有行为断言。
  await js(cdp, `window.__ahub_debug.setMcpServers([{ id:'launchonly', name:'只有launch', command:'', launch:{ bin:'node', args:['x.js'] }, formatVersion:2, enabled:true }])`)
  await sleep(300)
  const launchOnly = (await js(cdp, 'window.agenthub.mcp.list()')) ?? []
  ok('command 为空、launch 已填的记录保存后仍在列表里（重填保存不再被 mcp:set 静默丢弃）',
    launchOnly.length === 1 && launchOnly[0]?.id === 'launchonly' && launchOnly[0]?.launch?.bin === 'node',
    JSON.stringify(launchOnly).slice(0, 220))

  // ---- 评审修复1：「重填」不再在点击时就删记录+撤信任；移除推迟到新记录保存那一刻 ----
  // 旧缺陷：点重填 → save(list.filter(...)) 把删除写进 config.json，草稿只在组件 state；
  // McpSection 条件挂载，切分区/关设置一重挂草稿就没了，mcp:set 还顺带撤了该 id 的信任——
  // 记录不可恢复，违反"标失效+停用、绝不删除"。新形状：重填=原文回填草稿，旧条目留在列表；
  // 保存那一刻才被顶掉（remove-and-refill 的形状保留）。
  await js(cdp, `window.__ahub_debug.setMcpServers([{ id:'legacy1', name:'旧版样例', command:'\\"node\\" \\"x.js\\"', enabled:true }])`)
  await js(cdp, `window.agenthub.mcp.setTrust('legacy1', true)`)
  await js(cdp, 'window.__ahub_debug.openSettings("mcp")')
  await sleep(400)
  await click('[data-testid="mcp-refill"]')
  await sleep(300)
  const afterRefillClick = (await js(cdp, 'window.agenthub.mcp.list()')) ?? []
  ok('点「重填」只把原文填回草稿：旧条目仍留在 config（失效+停用），没有被立刻删除',
    afterRefillClick.length === 1 && afterRefillClick[0]?.id === 'legacy1' && afterRefillClick[0]?.legacyInvalid === true,
    JSON.stringify(afterRefillClick).slice(0, 220))
  const refillDraftCmd = String(await js(cdp, `document.querySelector('[data-testid="mcp-command"]')?.value ?? ''`))
  ok('重填把原命令塞回草稿（不保存也还能看到原文）', refillDraftCmd === '"node" "x.js"', refillDraftCmd)
  const refillNote = String(await js(cdp, `document.querySelector('[data-testid="mcp-refill-note"]')?.textContent ?? ''`))
  ok('界面写明后果：保存后旧条目连同它的信任授权一起删除',
    refillNote.includes('信任授权') && refillNote.includes('删除'), refillNote.slice(0, 180))
  // 重挂载路径（切分区/关设置的等价形态）：草稿没了可以重来，记录和信任不能没
  await js(cdp, 'window.__ahub_debug.closeSettings()')
  await sleep(150)
  await js(cdp, 'window.__ahub_debug.openSettings("mcp")')
  await sleep(400)
  const afterRemount = (await js(cdp, 'window.agenthub.mcp.list()')) ?? []
  const trustedAfterRemount = (await js(cdp, 'window.agenthub.mcp.trusted()')) ?? []
  ok('重挂载后记录与信任都还在：再点一次「重填」即可继续（不再有"一毁俱毁"）',
    afterRemount.length === 1 && afterRemount[0]?.id === 'legacy1' && trustedAfterRemount.includes('legacy1'),
    `${JSON.stringify(afterRemount).slice(0, 160)} trusted=${JSON.stringify(trustedAfterRemount)}`)
  // 走完整重填：再点重填 → 改命令 → 点「添加并探测」，此刻才顶掉旧条目并连带移除其信任
  await click('[data-testid="mcp-refill"]')
  await typeInto(`'node x.js'`)
  await js(cdp, `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '添加并探测'); b?.click(); return !!b })()`)
  await sleep(1500)
  const afterRefillSave = (await js(cdp, 'window.agenthub.mcp.list()')) ?? []
  const trustedAfterSave = (await js(cdp, 'window.agenthub.mcp.trusted()')) ?? []
  ok('保存那一刻旧条目才被新记录顶掉（remove-and-refill：同 id 不双记录，草稿把名字带了过来）',
    afterRefillSave.length === 1 && afterRefillSave[0]?.id !== 'legacy1' && afterRefillSave[0]?.name === '旧版样例' &&
      afterRefillSave[0]?.launch?.bin === 'node' && afterRefillSave[0]?.legacyInvalid !== true,
    JSON.stringify(afterRefillSave).slice(0, 240))
  ok('旧条目的信任只在保存这一刻随之移除（此前一直保留）', !trustedAfterSave.includes('legacy1'),
    JSON.stringify(trustedAfterSave))
  // 现场还原：列表回 before、信任回测前（mcp:set 会连带清掉不再存在的 id 的信任，这是它的正确行为，测试自己负责复原）
  await js(cdp, `window.__ahub_debug.setMcpServers(${JSON.stringify(before)})`)
  for (const id of trustedBefore8) await js(cdp, `window.agenthub.mcp.setTrust(${JSON.stringify(id)}, true)`)
  const trusted8 = await js(cdp, 'window.agenthub.mcp.trusted()')
  ok('MCP 表单测试已还原：配置列表与信任都回到测试前',
    JSON.stringify(await js(cdp, 'window.agenthub.mcp.list()')) === JSON.stringify(before) &&
      trusted8.length === trustedBefore8.length && trustedBefore8.every((id) => trusted8.includes(id)))

  // ---- 8b. 修复波 A · 项 3：Hook 整表保存不再静默删掉校验不通过的旧规则 ----
  // 缺陷：hooks:set 对**整表**跑 validateHook 并按 ok 过滤，而界面那次 save 提交的正是整表
  // （SettingsPage 的 patch → save(rules.map(...))）——用户拨一下任意一个 Hook 开关，
  // 一条 >4096 字符的旧规则（导入来的 / 手改的 / v0.3.0 写的）就地消失，且不告诉他。
  // 走真导入路径把超长规则放进 config（hooks:list 原样返回整表，所以设置页看得见它）；
  // config.json 整份由 finally 按字节还原，这里另外把运行中进程的 hooks 表也还原一次。
  console.log('\n[8b] Hook 整表保存：超长旧规则不被静默删掉，拒收原因点名显示在界面上')
  const hooksBefore = (await js(cdp, 'window.agenthub.hooks.list()')) ?? []
  const LONG_ID = 'ahub_verify_long_hook'
  const OTHER_ID = 'ahub_verify_other_hook'
  const longRule = { id: LONG_ID, event: 'post', command: 'x'.repeat(5000), match: '', enabled: true }
  const otherRule = { id: OTHER_ID, event: 'pre', command: 'node -e "process.exit(0)"', match: '', enabled: true }
  const hooksRt = await js(cdp, `window.__ahub_debug.configRoundTrip({ hooks: ${JSON.stringify([longRule, otherRule])} })`)
  ok('前置：超长规则经真导入路径进了 config（导入不校验 Hook，hooks:list 原样返回整表）',
    hooksRt?.import?.ok === true && Array.isArray(hooksRt?.config?.hooks) && hooksRt.config.hooks.length === 2 &&
      hooksRt.config.hooks[0]?.id === LONG_ID && hooksRt.config.hooks[0]?.command?.length === 5000,
    JSON.stringify((hooksRt?.config?.hooks ?? []).map((h) => ({ id: h?.id, len: h?.command?.length }))))
  await js(cdp, 'window.__ahub_debug.closeSettings()')
  await sleep(150)
  await js(cdp, 'window.__ahub_debug.openSettings("hooks")')
  await sleep(700)
  const hookRows = await js(cdp, `document.querySelectorAll('[data-hook-row]').length`)
  ok('设置页把两条都显示出来（超长那条也在：显示走脱敏 + 160 字符可见宽度，不撑破版面）',
    hookRows === 2, String(hookRows))
  // 「一次无关的开关改动」＝拨另一条的启用开关；界面提交的仍然是整表
  const toggled = await js(cdp, `(() => { const b = document.querySelector(${JSON.stringify(`[aria-label="启用 Hook ${OTHER_ID}"]`)}); if (!b) return false; b.click(); return true })()`)
  await sleep(800)
  ok('前置：拨的是另一条的开关（与超长那条无关）', toggled === true, String(toggled))
  const hookNotice = String(await js(cdp, `document.querySelector('[data-testid="hook-rejected"]')?.textContent ?? ''`))
  const hookNoticeIds = await js(cdp, `[...document.querySelectorAll('[data-testid="hook-rejected"] [data-rejected-id]')].map((x) => x.getAttribute('data-rejected-id'))`)
  ok('拨完无关的开关后界面出现拒绝提示：点名是哪一条、为什么（旧写法静默删掉，界面上什么都不发生）',
    hookNotice.includes(LONG_ID) && hookNotice.includes('命令最长') &&
      Array.isArray(hookNoticeIds) && hookNoticeIds.includes(LONG_ID),
    `提示文案=${hookNotice.slice(0, 200)} 点名的 id=${JSON.stringify(hookNoticeIds)}`)
  const hooksAfter = (await js(cdp, 'window.agenthub.hooks.list()')) ?? []
  ok('那条超长规则仍在配置里（不删用户数据：改短还是删掉由用户自己决定）',
    hooksAfter.some((h) => h?.id === LONG_ID && h?.command?.length === 5000),
    JSON.stringify(hooksAfter.map((h) => ({ id: h?.id, len: h?.command?.length }))))
  ok('无关的那次开关改动照常落盘（保留被拒条目不影响同表其它条目的保存）',
    hooksAfter.find((h) => h?.id === OTHER_ID)?.enabled === false,
    JSON.stringify(hooksAfter.find((h) => h?.id === OTHER_ID) ?? null).slice(0, 160))
  await js(cdp, `window.agenthub.hooks.set(${JSON.stringify(hooksBefore)})`)
  await js(cdp, 'window.__ahub_debug.closeSettings()')
  await sleep(300)
  const hooksRestored = (await js(cdp, 'window.agenthub.hooks.list()')) ?? []
  ok('Hook 测试已还原：hooks 表回到测试前',
    JSON.stringify(hooksRestored) === JSON.stringify(hooksBefore),
    `${JSON.stringify(hooksRestored).slice(0, 120)} vs ${JSON.stringify(hooksBefore).slice(0, 120)}`)

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

  // ---- 10. MCP 首次连接信任弹窗（评审修复3(b)：[data-approval-cmd] 不再只被 run_command 摸到）----
  // 驱动一次真 model:chat：装配线上主进程连 MCP → 列工具 → 未信任 → 弹信任窗，标签必须是
  // 实际执行的 bin+args（该记录 command 为空，旧写法弹的是空白标签——信任弹窗是用户看清
  // "我到底允许了哪条命令"的唯一地方）。同时把 null 塞进 stored.mcpServers（只有真导入路径留得住，
  // mcp:set 会滤掉）：旧代码在映射勾选 id 时于原始数组上 find((s) => s.id === id)，null 会当场
  // TypeError 掀掉整次对话（评审修复6——!!s 过滤排在解引用之后，晚了）。
  console.log('\n[10] MCP 首次信任弹窗：标签显示 bin+args；脏 null 不再炸掉整次对话')
  await js(cdp, 'window.__ahub_debug.closeSettings()')
  const chatWork = join(dir, 'chat')
  mkdirSync(chatWork)
  const chatAgentId = await js(cdp, `window.__ahub_debug.addMockToolAgent(${JSON.stringify(llmBase)}, ${JSON.stringify(chatWork)}, false)`)
  ok('信任弹窗场景就位：mock 模型 Agent 建成（连接测试走本地 mock）', typeof chatAgentId === 'string' && chatAgentId.length > 0, String(chatAgentId))
  const srv2 = { id: 'gui-trust-srv', name: '信任弹窗验证', command: '', launch: { bin: process.execPath, args: [MOCK_MCP] }, formatVersion: 2, enabled: true }
  await js(cdp, `window.__ahub_debug.setMcpServers([${JSON.stringify(srv2)}])`)
  await js(cdp, `window.agenthub.config.get().then((c) => { const a = c.agents.find((x) => x.id === ${JSON.stringify(chatAgentId)}); a.tools = { ...a.tools, mcpServerIds: [${JSON.stringify(srv2.id)}] }; return window.agenthub.config.setAgents(c.agents) })`)
  const rtTrust = await js(cdp, `window.__ahub_debug.configRoundTrip({ mcpServers: [null, ${JSON.stringify(srv2)}] })`)
  ok('前置就位：导入后原始 config 里同时躺着脏 null 与 launch-only server',
    rtTrust?.import?.ok === true && Array.isArray(rtTrust?.config?.mcpServers) &&
      rtTrust.config.mcpServers.length === 2 && rtTrust.config.mcpServers[0] === null,
    JSON.stringify(rtTrust?.config?.mcpServers)?.slice(0, 200))
  const mcfg = await js(cdp, `window.agenthub.config.get().then((c) => (c.agents.find((x) => x.id === ${JSON.stringify(chatAgentId)})?.modelConfig) ?? null)`)
  js(cdpRef, `window.__chat = null; window.agenthub.models.chat(${JSON.stringify(mcfg)}, 'gui-trust-chat', [{ role: 'user', content: '你好' }], { agentId: ${JSON.stringify(chatAgentId)} }).then((r) => { window.__chat = { ok: !!r && r.ok === true } }, (e) => { window.__chat = { err: String((e && e.message) || e) } }); 'fired'`)
  const mcpModal = await waitJs(cdpRef, `!!document.querySelector('[data-approval-modal][data-approval-kind="mcp"]')`, 25000)
  ok('勾选且启用的未信任 MCP server 触发首次连接弹窗（脏 null 记录没把整次对话炸掉——model:chat 走 mcp:list 同一道闸门）',
    mcpModal === true, `modal=${JSON.stringify(mcpModal)} chat=${JSON.stringify(await js(cdpRef, 'window.__chat'))}`)
  const trustLabel = String(await modalCmd())
  // 修复波 A · 项 6：授权闸口要显示 argv 边界，口径与设置页「实际执行」预览统一成 JSON 数组
  // （旧写法用裸空格 join，含空格的参数在人工授权闸口看起来像两个 token）。
  // 断言跟着**对齐**（不是放宽）：原来只查子串包含，现在要求整串能 JSON.parse 成 argv 数组，
  // 且第 0 项逐字符等于实际的可执行文件路径——含空格的路径也只算一个 token。
  let trustArgv = null
  try { trustArgv = JSON.parse(trustLabel) } catch { /* 不是 JSON 数组＝口径没统一 */ }
  ok('信任弹窗标签显示实际执行的 bin+args（launch-only 记录 command 为空也绝不弹空白标签）',
    Array.isArray(trustArgv) && trustArgv[0] === String(process.execPath) &&
      trustArgv.some((x) => String(x).includes('mock-mcp-server.mjs')),
    `标签原文=${trustLabel.slice(0, 200)} 解析成 argv=${JSON.stringify(trustArgv)?.slice(0, 200)}`)
  await click('[data-approval-deny]')
  await waitJs(cdpRef, 'window.__chat !== null', 25000)
  const chatRes = await js(cdpRef, 'window.__chat')
  ok('点「拒绝」= 本次不连它、对话照常完成（弹窗不是死路）', chatRes?.ok === true, JSON.stringify(chatRes))
  ok('拒绝不写入信任（信任只能由用户在弹窗或设置页显式给）', ((await js(cdpRef, 'window.agenthub.mcp.trusted()')) ?? []).includes(srv2.id) === false)
  // 现场清理：删本次新增的 mock Agent 与凭据（config.json 另有字节快照在 finally 兜底）
  await js(cdpRef, `window.__ahub_debug.removeAgentByName('Mock 工具验证')`)
  if (mcfg?.keyId) await js(cdpRef, `window.agenthub.credentials.delete(${JSON.stringify(mcfg.keyId)})`)
  await js(cdpRef, `window.__ahub_debug.setMcpServers(${JSON.stringify(before)})`)

  // ---- 11. config:importJson 的入口边界与注册闸门（评审修复4）----
  // 整份配置替换的通道不能没有边界：入口先拒非字符串与超限 payload（未解析、未写盘）；
  // 且只在 argv 带 --ahub-verify 时注册——app.isPackaged 不算闸门（被测部署构建本来就是 packaged）。
  console.log('\n[11] config:importJson：非字符串/超限在入口被拒；不带验证开关的进程里通道根本不存在')
  await js(cdp, `window.__ahub_debug.setMcpServers([{ id:'gatekeep', name:'闸门样本', command:'', launch:{ bin:'node', args:[] }, formatVersion:2, enabled:true }])`)
  const listBeforeGate = await js(cdp, 'window.agenthub.mcp.list()')
  const notStr = await js(cdp, `window.agenthub.config.importJson(123)`)
  ok('非字符串 payload 在入口被拒（不再 String(...) 硬转着喂 JSON.parse）',
    notStr?.ok === false && String(notStr?.message).includes('字符串'), JSON.stringify(notStr))
  const oversizeBytes = 9 * 1024 * 1024
  const tooBig = await js(cdp, `window.agenthub.config.importJson(JSON.stringify({ filler: 'x'.repeat(${oversizeBytes}) }))`)
  ok('超过上限的 payload 先拒后谈（主线程不吞任意大的字符串；上限字样如实报出来）',
    tooBig?.ok === false && String(tooBig?.message).includes('上限'), JSON.stringify(tooBig)?.slice(0, 160))
  const listAfterGate = await js(cdp, 'window.agenthub.mcp.list()')
  ok('两次被拒的导入都没动盘：mcpServers 与尝试前逐字节一致（超限那次如果真进了 importConfig，这里就没了）',
    JSON.stringify(listAfterGate) === JSON.stringify(listBeforeGate), JSON.stringify(listAfterGate)?.slice(0, 200))
  await js(cdp, `window.__ahub_debug.setMcpServers(${JSON.stringify(before)})`)
  // 不带 --ahub-verify 重启一次：通道应当没注册，invoke 以"未注册"失败（生产路径拿不到整份导入）。
  // 顺便把降级门控 env 也带上——它应当**不**生效（缺 --ahub-verify 这一半），
  // 这条就是"用户正常双击永远不会看到假徽章"的真机证据（[12] 是两个条件都齐的正向）。
  try { proc.kill() } catch { /* noop */ }
  requireAppGone('第一个实例（主实例）')
  proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT + 1}`], { stdio: 'ignore', env: { ...launchEnv(), AGENTHUB_FORCE_SANDBOX_CRASH: '1' } })
  const page2 = await waitHttp(PORT + 1, 40000)
  const cdp2 = new CdpClient(page2.webSocketDebuggerUrl)
  await cdp2.connect()
  await cdp2.send('Runtime.enable')
  const ready2 = await waitJs(cdp2, '!!window.agenthub && !!window.__ahub_debug', 30000)
  const gateNoSwitch = ready2
    ? await js(cdp2, `window.agenthub.config.importJson('{"x":1}').then((r) => 'resolved:' + JSON.stringify(r), (e) => 'rejected:' + String((e && e.message) || e))`)
    : 'second-instance-not-ready'
  ok('不带 --ahub-verify 的进程里 config:importJson 没有注册（通道按验证开关注册，不是无条件可达）',
    String(gateNoSwitch).startsWith('rejected:'), String(gateNoSwitch).slice(0, 200))
  ok('门控只带 env、缺 --ahub-verify 时不生效：这个进程的 noSandbox 仍是假（假徽章进不了正常启动）',
    ready2 && (await js(cdp2, 'window.__ahub_debug.compat()'))?.noSandbox === false,
    JSON.stringify(ready2 ? await js(cdp2, 'window.__ahub_debug.compat()') : null))
  ok('同一进程顶栏也没有徽章节点（门控没开就等于什么都没发生）',
    ready2 && (await gotoWorkbench(cdp2)) && (await js(cdp2, "!!document.querySelector('[data-compat-badge]')")) === false)

  // ---- 12. 兼容模式徽章 · 正向（Task 6 Step 7b）：门控起的第三个实例必须看得到徽章 ----
  // 门控 = AGENTHUB_FORCE_SANDBOX_CRASH=1 **且** --ahub-verify（两个条件同时成立，缺一不可，
  // 上一条 [11] 已反证 env 单独不成）。它只把状态呈现为"已降级"，真降级路径走的是同一条渲染分支。
  console.log('\n[12] 兼容模式徽章：门控降级后顶栏出现，且设置里可改策略')
  try { proc.kill() } catch { /* noop */ }
  requireAppGone('第二个实例（不带 --ahub-verify 的那个）')
  proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT + 2}`, '--ahub-verify'], {
    stdio: 'ignore',
    env: { ...launchEnv(), AGENTHUB_FORCE_SANDBOX_CRASH: '1' }
  })
  const page3 = await waitHttp(PORT + 2, 40000)
  const cdp3 = new CdpClient(page3.webSocketDebuggerUrl)
  await cdp3.connect()
  await cdp3.send('Runtime.enable')
  const ready3 = await waitJs(cdp3, '!!window.agenthub && !!window.__ahub_debug', 30000)
  const badgeShown = ready3 && (await gotoWorkbench(cdp3))
    ? await waitJs(cdp3, "!!document.querySelector('[data-compat-badge]')", 12000)
    : false
  ok('门控降级后顶栏出现兼容模式徽章', badgeShown === true)
  const compat3 = await js(cdp3, 'window.__ahub_debug.compat()')
  ok('状态里 policy 合法且 noSandbox 为真', compat3?.noSandbox === true && ['auto', 'ask', 'off'].includes(compat3?.policy), JSON.stringify(compat3))
  ok('reason 标明降级来源（供人核对不是凭空显示）', String(compat3?.reason ?? '').includes('sandbox'), JSON.stringify(compat3))
  const badgeText3 = String(await js(cdp3, `document.querySelector('[data-compat-badge]')?.textContent ?? ''`))
  ok('徽章措辞说的是实际关掉的东西（渲染沙箱），不是配置里写了什么', badgeText3.includes('渲染沙箱已关闭'), badgeText3)
  // 评审 finding 3：徽章单挂 Shell 要覆盖两种模式——数量断言"只挂一处"，工作流断言"换屏不消失"
  const badgeCountWb = await js(cdp3, "document.querySelectorAll('[data-compat-badge]').length")
  ok('工作站内徽章恰好一枚（Shell 单挂，不再是 Workbench/ChatView 两处各挂一份）', badgeCountWb === 1, String(badgeCountWb))

  // ---- 修复波 A · 项 1：徽章被「发现新版本」横幅整个盖住 + 缺 pointer-events:none 会接走顶栏点击 ----
  // 评审实证：.update-banner 是 position:fixed; top:14; z-index:900（components.css），与徽章原来的
  // position:absolute; top:10; left:50%; translateX(-50%); zIndex:30 **完全重叠**；横幅由启动时的
  // 静默更新检查置位（App.tsx，3 天节流），所以"版本落后的用户 + 兼容模式"是常态而不是边角，
  // 徽章被整个盖住 → A4 承诺的"常驻可见"静默失效。
  // 上面那几条只查 DOM 存在性（querySelector('[data-compat-badge]')），**看不见遮挡**——这正是它漏过去的原因。
  // 所以下面一律走 rect 几何 + elementFromPoint/elementsFromPoint，不再加一条"节点存在"。
  const bannerOn = await js(cdp3, `window.__ahub_debug.setUpdateBanner({ version: '9.9.9', url: 'https://example.invalid/agenthub' })`)
  await sleep(500)
  ok('前置：更新横幅真的置位了（走 App.tsx 那次静默更新检查用的同一个 store 动作，不是另造一条状态）',
    !!bannerOn && bannerOn.version === '9.9.9', JSON.stringify(bannerOn))
  const occ = await js(cdp3, `(() => {
    const badge = document.querySelector('[data-compat-badge]')
    const banner = document.querySelector('.update-banner')
    if (!badge || !banner) return { missing: { badge: !!badge, banner: !!banner } }
    const b = badge.getBoundingClientRect()
    const n = banner.getBoundingClientRect()
    const cx = b.left + b.width / 2
    const cy = b.top + b.height / 2
    const hit = document.elementFromPoint(cx, cy)
    const stack = document.elementsFromPoint(cx, cy)
    const inBanner = (e) => !!e && (e === banner || banner.contains(e))
    // 顶栏上"能被点"的元素：徽章缺 pointer-events:none 时会接走它压在下面的这些点击
    const clickable = [...document.querySelectorAll('.wb-topbar button, .wb-topbar .model-chip, .wb-topbar .full-access-badge, .wf-topbar .goal, .wf-topbar button, .cfg-chip')]
    const under = clickable.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width >= 4 && r.height >= 4 && !(b.right < r.left || b.left > r.right || b.bottom < r.top || b.top > r.bottom)
    })
    const eaten = under.filter((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return top !== el && !el.contains(top)
    }).map((el) => (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 40))
    return {
      badge: { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), h: +b.height.toFixed(1) },
      banner: { t: +n.top.toFixed(1), b: +n.bottom.toFixed(1), h: +n.height.toFixed(1) },
      intersect: !(b.right < n.left || b.left > n.right || b.bottom < n.top || b.top > n.bottom),
      hitIsBanner: inBanner(hit),
      stackHasBanner: stack.some(inBanner),
      hitIsBadge: hit === badge,
      pointerEvents: getComputedStyle(badge).pointerEvents,
      clickableTotal: clickable.length,
      underBadge: under.map((el) => (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 40)),
      eaten
    }
  })()`)
  console.log('  [12b] 徽章/横幅几何：' + JSON.stringify(occ))
  const badgeCountWithBanner = await js(cdp3, "document.querySelectorAll('[data-compat-badge]').length")
  ok('置位横幅后徽章 rect 与横幅 rect 不相交，且徽章仍在（不是"横幅在就把徽章隐藏"——那正是把可见性承诺删掉）',
    !occ.missing && occ.intersect === false && occ.badge.t >= occ.banner.b - 1 && badgeCountWithBanner === 1,
    `${JSON.stringify(occ.missing ?? null)} 相交=${occ.intersect} 徽章 top=${occ.badge?.t} 横幅 bottom=${occ.banner?.b} 徽章节点数=${badgeCountWithBanner}`)
  ok('elementFromPoint(徽章中心) 不在横幅里：徽章没被盖住（z-index 900 的横幅压在 z-index 30 的徽章上时这条会红）',
    !occ.missing && occ.hitIsBanner === false && occ.stackHasBanner === false,
    `hitIsBanner=${occ.hitIsBanner} stackHasBanner=${occ.stackHasBanner} 徽章=${JSON.stringify(occ.badge)} 横幅=${JSON.stringify(occ.banner)}`)
  ok('徽章 pointer-events:none：命中测试穿过它落到被压住的元素上，不吃顶栏点击',
    !occ.missing && occ.pointerEvents === 'none' && occ.hitIsBadge === false && Array.isArray(occ.eaten) && occ.eaten.length === 0,
    `pointer-events=${occ.pointerEvents} 徽章中心命中的是徽章本身=${occ.hitIsBadge} 被徽章压住又点不到的元素=${JSON.stringify(occ.eaten)}（顶栏可点元素共 ${occ.clickableTotal} 个，其中与徽章 rect 相交 ${occ.underBadge?.length ?? 0} 个：${JSON.stringify(occ.underBadge)}）`)
  // 复审/收尾实测：这条断言原先**在横幅还开着的时候**点顶栏 chip，而横幅本身就在顶部居中、
  // 会合法地盖住那一片（它是临时浮层，不是徽章的锅）。实测命中到的是 `ub-text`（横幅文字），
  // 于是这条会因为"测的东西不对"而红。挪到横幅清掉之后再点（见下面"横幅清除后"那组之后）。
  await js(cdp3, 'window.__ahub_debug.setUpdateBanner(null)')
  await sleep(300)
  const bannerOff = await js(cdp3, `(() => {
    const badge = document.querySelector('[data-compat-badge]')
    return { banner: !!document.querySelector('.update-banner'), top: badge ? +badge.getBoundingClientRect().top.toFixed(1) : null }
  })()`)
  ok('横幅清除后徽章回到原位（下移是跟着横幅走的，不是把徽章永久挪到 68px 那里留一块空白）',
    bannerOff.banner === false && bannerOff.top !== null && bannerOff.top < 40, JSON.stringify(bannerOff))
  // 「徽章不吃点击」要在**没有横幅**的时候点：横幅是临时浮层，顶部居中、会合法盖住那一片，
  // 把它算进"谁接走了点击"里会测到 `ub-text` 而不是徽章（收尾实测就是这么红的）。
  const chipHit = await js(cdp3, `(() => {
    const el = document.querySelector('.wb-topbar .model-chip') || document.querySelector('.wb-topbar button') || document.querySelector('.cfg-chip')
    if (!el) return { missing: true }
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      cls: (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 40),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
      isSelf: top === el || el.contains(top),
      topCls: top ? (typeof top.className === 'string' ? top.className : top.tagName).slice(0, 40) : null
    }
  })()`)
  ok('已知顶栏 chip 的中心命中它自己（横幅清掉之后）——徽章没有把这一片的点击接走',
    !chipHit.missing && chipHit.isSelf === true, JSON.stringify(chipHit))

  const onWf12 = await gotoWorkflow(cdp3)
  const badgeInWf = onWf12 ? await waitJs(cdp3, "document.querySelectorAll('[data-compat-badge]').length === 1", 12000) : false
  ok('Ctrl+M 进工作流模式徽章仍在（沙箱被关掉这件事换屏也看得见——用户"可见"那一半）',
    badgeInWf === true, `onWorkflow=${onWf12}`)
  const wfBadgeText = String(await js(cdp3, `document.querySelector('[data-compat-badge]')?.textContent ?? ''`))
  ok('工作流模式下的徽章措辞与工作站内一致（两种模式读同一份主进程事实，不是各屏各猜）',
    wfBadgeText === badgeText3, wfBadgeText)
  // 「可改」那一半：一次性提示之后，设置 → 关于 还得有常驻入口（三态都能选、能落盘、能改回）
  await js(cdp3, 'window.__ahub_debug.openSettings("about")')
  await sleep(600)
  ok('设置 → 关于 有可改的三态选择器（一次性提示不是唯一入口）',
    (await js(cdp3, `document.querySelectorAll('[data-testid="sandbox-fallback-option"]').length`)) === 3)
  const fbDescs = String(await js(cdp3, `[...document.querySelectorAll('[data-testid="sandbox-fallback-desc"]')].map((x) => x.textContent).join('|')`))
  ok('三条策略都写明"做什么 + 代价"，off 那条如实写会启动失败（不是"更安全"这种空话）',
    fbDescs.split('|').length === 3 && fbDescs.includes('启动失败'), fbDescs.slice(0, 200))
  const policyBefore = compat3?.policy
  // 目标选一个与当前值不同的，否则"改了"这条断言会因两边本来就相同而空过
  const target = policyBefore === 'ask' ? 'off' : 'ask'
  await js(cdp3, `(() => { const b = [...document.querySelectorAll('[data-testid="sandbox-fallback-option"]')].find((x) => x.dataset.policy === ${JSON.stringify(target)}); b?.click(); return !!b })()`)
  await sleep(900)
  ok(`选「${target}」后真的落进 config.sandboxFallback（不是只动界面状态）`,
    (await js(cdp3, 'window.agenthub.config.get()'))?.sandboxFallback === target,
    String((await js(cdp3, 'window.agenthub.config.get()'))?.sandboxFallback))
  ok('选择器高亮跟着主进程回读的值走（界面不自己记一份状态）',
    (await js(cdp3, `document.querySelector('[data-testid="sandbox-fallback-option"].active')?.dataset?.policy ?? ''`)) === target)
  await js(cdp3, `(() => { const b = [...document.querySelectorAll('[data-testid="sandbox-fallback-option"]')].find((x) => x.dataset.policy === ${JSON.stringify(policyBefore)}); b?.click(); return !!b })()`)
  await sleep(900)
  ok(`可以再改回原策略「${policyBefore}」：策略不是单向门，config 也跟着回去了`,
    (await js(cdp3, 'window.agenthub.config.get()'))?.sandboxFallback === policyBefore,
    String((await js(cdp3, 'window.agenthub.config.get()'))?.sandboxFallback))

} catch (e) {
  // 修复波 B · 项 1：中途抛错要**算一条 FAIL**，汇总行统一在 finally 之后打一次。
  // 原来异常直接穿透到进程外：exit code 非 0 但根本没有计数行，
  // run-all 只能报"崩了"，人也看不出跑到第几条断的；而"崩了"与"断言失败"在下游是同一件事。
  fail++
  console.log(`  FAIL  套件中止 —— ${e?.stack || e?.message || e}`)
} finally {
  await sleep(300)
  try { proc?.kill() } catch { /* noop */ }
  // 修复波 B · 项 1（评审 Minor ㉜）：回写快照之前，先确认实例真的退干净了。
  // 残留实例在场时把字节快照写回去，写的是"那个活实例正在使用的 config.json"，
  // 而它退出时又会把内存里的测试态盖回来 —— 用户配置就此被留在测试中间态。
  // （Task 4 的 GREEN 复跑就是这么被用户 17:18 启动的实例挡住的，当时只 WARN 然后继续。）
  if (!waitAppGone()) snapshotWriteAllowed = false
  if (snapshotWriteAllowed) {
    // 应用退出后按字节还原 config.json：导入往返写过的内容（含 agents 的 hasKey 重置）一律回到测试前
    try {
      if (configSnapshot) writeFileSync(cfgFile, configSnapshot)
      else if (cfgFile && existsSync(cfgFile)) rmSync(cfgFile, { force: true })
    } catch (e) { console.log(`  WARN  config.json 还原失败：${e.message}（需要手工还原 ${cfgFile}）`) }
  } else {
    fail++
    console.log('  FAIL  残留实例，拒绝回写快照 — AgentHub.exe 30s 内没退干净：宁可把 config.json 留在测试现场，也不往活实例的文件里写（快照在内存里，需要手工还原 ' + (cfgFile ?? '未知路径') + '）')
  }
  await sleep(300)
  try { mockLlm.close() } catch { /* noop */ }
  if (dir) rmSync(dir, { recursive: true, force: true })
}
console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
// 修复波 B · 项 1：本套件是九个真机套件里唯一"有 FAIL 也退 0"的（其余都 process.exit(1)）。
// run-all 靠解析汇总行才看出红，人直接 `node verify/approval-shot.mjs` 拿到的是 0——
// 中止路径要求非零退出，这条必须补上才成立。
process.exit(fail > 0 ? 1 : 0)
