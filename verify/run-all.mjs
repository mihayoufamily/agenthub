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
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
}))

/** tier: logic（默认）| gui（--gui）| cli（--with-cli）；gate=false 只报告不计入成败 */
const SUITES = [
  { name: 'fixes', tier: 'logic', script: 'fixes-check.mjs', what: '安全与正确性修复（SSRF/ReDoS/费用/白名单/权限来源/编码）' },
  { name: 'deliver', tier: 'logic', script: 'deliver-check.mjs', what: '思考摘要分段 + 角色提示词装配（产物目录、能力形态）' },
  { name: 'ui', tier: 'gui', script: 'ui-shot.mjs', what: '界面真机：对话栏模型与费用、思考折叠、产物落盘(by=tool/app)、双槽位、预设、窄窗口无溢出' },
  { name: 'cli-e2e', tier: 'gui', script: 'cli-e2e.mjs', what: 'CLI 适配器经真实 IPC 的行为' },
  { name: 'cli-shot', tier: 'gui', script: 'cli-shot.mjs', what: '本机 CLI 面板截图（5 个条目与实测状态）', gate: false },
  { name: 'wf-config', tier: 'gui', script: 'workflow-config-shot.mjs', what: '工作流三角色配置条（跨厂商绑定）' },
  { name: 'model-picker', tier: 'gui', script: 'model-picker-shot.mjs', what: 'CLI 模型清单进切换弹窗' },
  { name: 'model-list', tier: 'gui', script: 'model-list-check.mjs', what: 'CLI 模型清单真实 IPC 返回', gate: false },
  { name: 'cli-thinking', tier: 'cli', script: 'cli-thinking.mjs', what: '真实 CLI 吐出 reasoning 事件（codex / CodeBuddy）' },
  { name: 'cli-workflow', tier: 'cli', script: 'cli-workflow-check.mjs', what: '真实 CLI 工作流闭环：思考进卡片 + 产物真实落盘' },
  { name: 'cross-vendor', tier: 'cli', script: 'cross-vendor-run.mjs', what: '跨厂商三角色真跑一轮（规划→执行→审核 + 人工门）' }
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
  const r = spawnSync(process.execPath, [resolve(HERE, suite.script)], {
    cwd: resolve(HERE, '..'),
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(PASS_RE)
  const pass = m ? Number(m[1]) : null
  const fail = m ? Number(m[2]) : null
  const crashed = r.status !== 0 && (fail === null || fail === 0)
  const bad = crashed || (fail ?? 0) > 0
  if (bad && suite.gate !== false) failed++
  const tag = bad ? (suite.gate === false ? 'WARN' : 'FAIL') : 'OK  '
  console.log(`\n[${tag}] ${suite.name}  ${pass ?? '-'} PASS / ${fail ?? '-'} FAIL  ${Math.round((Date.now() - t0) / 1000)}s  —— ${suite.what}`)
  if (bad) {
    const lines = out.split('\n').filter((l) => /FAIL|失败|Error:/.test(l)).slice(0, 12)
    for (const l of lines) console.log('    ' + l.trim())
  }
  results.push({ name: suite.name, pass, fail, bad, gated: suite.gate !== false })
}

console.log('\n================ 汇总 ================')
for (const x of results) {
  console.log(`  ${x.bad ? (x.gated ? 'FAIL' : 'warn') : 'OK  '}  ${x.name}${x.pass != null ? ` (${x.pass}/${(x.pass ?? 0) + (x.fail ?? 0)})` : ''}`)
}
if (results.length === 0) console.log('  没有选中任何套件（检查 --only 拼写）')
console.log(`\n[run-all] 必过项失败 ${failed} 个${failed ? '' : '，全绿'}`)
process.exit(failed > 0 ? 1 : 0)
