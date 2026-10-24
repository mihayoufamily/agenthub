/**
 * 回归验证收口：一条命令跑完该跑的层级并汇总结果。
 * 用法：node verify/run-all.mjs [--with-cli] [--gui] [--only=a,b] [--port=9240]
 *   默认只跑「纯逻辑」层（不起应用、不花额度、不写用户数据）。
 *   --gui     追加界面真机层（CDP 驱动便携版；需要你先退出正在运行的 AgentHub，
 *             单实例锁会让子实例起不来；脚本自身会清理新增 Agent 与任务记录）
 *   --with-cli 追加真实 CLI 层（真的调用 codex / CodeBuddy / arkcli，消耗额度）
 * 退出码：任一必过项 FAIL 即非 0。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 每个套件的原始输出落一份（回显会截断，文件不会）：本地排查与 CI artifact 都靠它
const LOGDIR = resolve(HERE, '..', 'verify-logs')

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))

/**
 * tier: logic（默认）| gui（--gui）| cli（--with-cli）；gate=false 只报告不计入成败
 * min：该套件的**断言数下限**，取值必须是某一轮实测的 PASS 数（不许估、不许照抄旧台账）。
 *   实测 PASS < min → 该套件判 FAIL 并点名"断言数从 N 掉到 M"。这是反向保险：
 *   谁删掉/静默跳过十条断言，套件本来照样报 OK，现在会红。
 *   往套件里**加**断言后，要把对应 min 一起抬到新的实测值，否则下限就在原地腐烂。
 *   min: null = 本轮没有实测基线（见 cli 层那行注释），只报数不设下限；跑出第一轮必须补上。
 *   本轮基线来源：2026-10-24 收尾 C1 全量实测，逐套件数字见
 *   .superpowers/sdd/2026-10-23-v0.4.0-safety-and-ci/wave-c1-numbers.md
 */
// 每套件的**硬超时**：以前完全不设，一个挂住的套件会把整轮验证吊死（复审点出的面）。
// 逻辑层两套各几秒、真机各几分钟，10 分钟是宽松上限；cli 层要真跑外部 CLI，给 20 分钟。
const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60 * 1000
const SUITES = [
  { name: 'fixes', tier: 'logic', script: 'fixes-check.mjs', min: 504, what: '安全与正确性修复（SSRF/ReDoS/费用/白名单/权限来源/编码）' },
  { name: 'deliver', tier: 'logic', script: 'deliver-check.mjs', min: 52, what: '思考摘要分段 + 角色提示词装配（产物目录、能力形态）' },
  { name: 'ui', tier: 'gui', script: 'ui-shot.mjs', min: 79, what: '界面真机：对话栏模型与费用、思考折叠、产物落盘(by=tool/app)、任务列表、预设、窄窗口无溢出' },
  { name: 'approval', tier: 'gui', script: 'approval-shot.mjs', min: 94, what: '命令审批真机：没批准不执行、拒绝/本次/始终、危险形态仍要问、历史进设置' },
  { name: 'cli-e2e', tier: 'gui', script: 'cli-e2e.mjs', min: 10, what: 'CLI 适配器经真实 IPC 的行为' },
  { name: 'cli-shot', tier: 'gui', script: 'cli-shot.mjs', min: 4, what: '本机 CLI 面板截图（5 个条目与实测状态）', gate: false },
  { name: 'wf-config', tier: 'gui', script: 'workflow-config-shot.mjs', min: 7, what: '工作流三角色配置条（跨厂商绑定）' },
  { name: 'model-picker', tier: 'gui', script: 'model-picker-shot.mjs', min: 3, what: 'CLI 模型清单进切换弹窗' },
  { name: 'model-list', tier: 'gui', script: 'model-list-check.mjs', min: 4, what: 'CLI 模型清单真实 IPC 返回', gate: false },
  // cli 层要真跑 codex / CodeBuddy / arkcli（烧真实额度），本轮未实测 → 下限留空；跑过一轮后按实测 PASS 钉上
  { name: 'cli-thinking', tier: 'cli', script: 'cli-thinking.mjs', min: 8, timeoutMs: 20 * 60 * 1000, what: '真实 CLI 吐出 reasoning 事件（codex / CodeBuddy）' },
  { name: 'cli-workflow', tier: 'cli', script: 'cli-workflow-check.mjs', min: 9, timeoutMs: 20 * 60 * 1000, what: '真实 CLI 工作流闭环：思考进卡片 + 产物真实落盘' },
  // `gate: false` —— 这套要三家外部服务同时可用（本机模型端点 + codex + CodeBuddy）。实测一轮里规划角色挑到的
  // 是本地 Qwen，服务没起就"任务失败：fetch failed"，红的是环境不是被测代码，所以只报不拦；
  // 断言数照打，下限仍留 null（跑通与否随环境变）。角色绑定本身已改成套件自绑（setRoles），不再依赖用户当前配置。
  { name: 'cross-vendor', tier: 'cli', script: 'cross-vendor-run.mjs', min: null, gate: false, timeoutMs: 20 * 60 * 1000, what: '跨厂商三角色真跑一轮（规划→执行→审核 + 人工门）' }
]

const wanted = args.only
  ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean)
  : null
const tiers = ['logic', ...(args.gui ? ['gui'] : []), ...(args['with-cli'] ? ['cli'] : [])]
const selected = SUITES.filter((s) => tiers.includes(s.tier) && (!wanted || wanted.includes(s.name)))

const PASS_RE = /结果[：:]\s*(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL/

/**
 * 等上一个套件的应用真的退干净：单实例锁下，残留进程会让下一个套件 spawn 秒退，
 * 报出来是"devtools not ready"——看着像产品崩了，其实是脚手架自己踩自己。
 */
function waitAppGone(timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq AgentHub.exe', '/NH'], { encoding: 'utf-8' })
    if (!/AgentHub\.exe/i.test(r.stdout ?? '')) break
    if (Date.now() - t0 > timeoutMs) return false
    spawnSync('cmd', ['/c', 'ping', '-n', '3', '127.0.0.1', '>nul'], { shell: true })
  }
  spawnSync('cmd', ['/c', 'ping', '-n', '3', '127.0.0.1', '>nul'], { shell: true })
  return true
}

const results = []
let failed = 0

if (tiers.includes('gui') || tiers.includes('cli')) {
  const exe = resolve('d:/AgentHub/AgentHub.exe')
  if (!existsSync(exe)) {
    console.log(`[run-all] 未找到便携版 ${exe}，GUI/CLI 层需要它（先 npm run pack:portable 或部署到该路径）`)
    process.exit(1)
  }
}

console.log(`[run-all] 计划跑 ${selected.length} 项：${selected.map((s) => s.name).join(', ') || '（空）'}`)
// 先构建：fixes/deliver 直接读 out/，不构建就会拿上一次的产物报"绿"（实测踩过：类型错误 + 逻辑层全绿）
if (!args['no-build']) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: resolve(HERE, '..'), encoding: 'utf-8', shell: true })
  const bOut = `${b.stdout ?? ''}${b.stderr ?? ''}`
  if (b.status !== 0) {
    console.log('\n[FAIL] build  类型检查/编译未通过，后面所有结果都不可信')
    for (const l of bOut.split('\n').filter((x) => /error TS/.test(x)).slice(0, 12)) console.log('    ' + l.trim())
    console.log('\n================ 汇总 ================\n  FAIL  build')
    process.exit(1)
  }
  console.log('[run-all] 构建通过（typecheck + main + renderer）')
}
for (const suite of selected) {
  if (suite.tier !== 'logic') {
    if (!waitAppGone()) {
      console.log(`\n[FAIL] ${suite.name}  上一个套件残留的 AgentHub 进程未退出，跳过（避免误报成"起不来"）`)
      failed++
      results.push({ name: suite.name, pass: null, fail: null, bad: true, gated: suite.gate !== false })
      continue
    }
  }
  const t0 = Date.now()
  const budget = suite.timeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS
  const r = spawnSync(process.execPath, [resolve(HERE, suite.script)], {
    cwd: resolve(HERE, '..'),
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: budget
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  try {
    mkdirSync(LOGDIR, { recursive: true })
    writeFileSync(join(LOGDIR, `${suite.name}.log`), out, 'utf-8')
  } catch { /* 落盘失败不影响判定 */ }
  const m = out.match(PASS_RE)
  const pass = m ? Number(m[1]) : null
  const fail = m ? Number(m[2]) : null
  const exit = r.status
  const crashed = exit !== 0 && (fail === null || fail === 0)
  // 每一条不通过都要留下能直接读懂的理由；"红了但不知道为什么红"最后总会把人引向削弱断言。
  const reasons = []
  // 超时单独点出来：spawnSync 超时后 exit 是 null、输出可能为空，不写清楚会被读成"崩了"。
  if (r.error?.code === 'ETIMEDOUT') reasons.push(`套件超过 ${Math.round(budget / 60000)} 分钟的硬超时被中止（不是断言红；若它起了应用，残留进程由下一个套件前的 waitAppGone 拦）`)
  if (crashed) reasons.push(`退出码 ${exit}${r.signal ? ` / 信号 ${r.signal}` : ''}，但输出里没有失败断言计数（崩了或被超时杀掉，不是断言红）`)
  if ((fail ?? 0) > 0) reasons.push(`${fail} 条断言失败`)
  // 收尾 C1 · 项 1b：退出码 0 却没打印 `结果：N PASS / M FAIL` 的套件，以前会被读成"通过"，
  // 而它其实可能在打印计数行之前就 return 了（整套没跑完）。f5c6a74 已给所有已知不打印的
  // 套件补齐计数行，所以这条规则开下去不该打死任何现有套件；真打死了就给它补计数行，
  // 不要放宽这条规则、也不要加例外名单。
  if (pass === null && exit === 0) reasons.push('套件没打印计数行（结果：N PASS / M FAIL），断言数无从核对')
  // 收尾 C1 · 项 1a：每套件断言数下限。删断言、或断言被静默跳过，PASS 数就会掉 → 这里拦成 FAIL。
  if (suite.min != null && pass !== null && pass < suite.min) {
    reasons.push(`断言数从 ${suite.min} 掉到 ${pass}（低于该套件下限 min=${suite.min}；确实加了断言就把下限抬到新的实测值）`)
  }
  const bad = reasons.length > 0
  if (bad && suite.gate !== false) failed++
  const tag = bad ? (suite.gate === false ? 'WARN' : 'FAIL') : 'OK  '
  console.log(`\n[${tag}] ${suite.name}  ${pass ?? '-'} PASS / ${fail ?? '-'} FAIL  ${Math.round((Date.now() - t0) / 1000)}s  exit=${exit ?? `signal:${r.signal}`}  min=${suite.min ?? '-'}  —— ${suite.what}`)
  if (bad) {
    for (const reason of reasons) console.log('    原因：' + reason)
    // 回显顺序有讲究（CI 上实测踩过）：以前只 filter /FAIL|失败|Error:/ 再 slice(0,12)，
    // 而套件里有一堆 **PASS 行本身含"失败"二字**（"post 失败不撤销…""没配命令时如实失败"…），
    // 于是真正的 FAIL 行被挤出窗口——"红了但看不出是哪条"，排查只能靠猜。
    // 现在：真正的 FAIL 行**全给**（最多 20 条），上下文另算，绝不挤掉 FAIL。
    const all = out.split('\n')
    const failLines = all.filter((l) => /^\s*FAIL\s/.test(l))
    for (const l of failLines.slice(0, 20)) console.log('    ' + l.trim())
    if (failLines.length > 20) console.log(`    …另有 ${failLines.length - 20} 条 FAIL 未回显（完整输出见 verify-logs/${suite.name}.log）`)
    const ctx = all.filter((l) => !/^\s*FAIL\s/.test(l) && /失败|Error:/.test(l)).slice(0, 6)
    if (ctx.length) console.log('    —— 相关上下文 ——')
    for (const l of ctx) console.log('    ' + l.trim())
  }
  results.push({ name: suite.name, pass, fail, exit, min: suite.min ?? null, reasons, bad, gated: suite.gate !== false })
}

console.log('\n================ 汇总 ================')
for (const x of results) {
  console.log(`  ${x.bad ? (x.gated ? 'FAIL' : 'warn') : 'OK  '}  ${x.name}${x.pass != null ? ` (${x.pass}/${(x.pass ?? 0) + (x.fail ?? 0)})` : ''}`)
}
if (results.length === 0) console.log('  没有选中任何套件（检查 --only 拼写）')
console.log(`\n[run-all] 必过项失败 ${failed} 个${failed ? '' : '，全绿'}`)
process.exit(failed > 0 ? 1 : 0)
