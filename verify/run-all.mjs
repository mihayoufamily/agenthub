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
  // fixes 602：2026-10-25 审查修复轮实测（602 PASS / 0 FAIL）。569 → 602 多的 33 条是本轮钉的：
  // cmd 语义拆段（单 & / 换行 / 单引号不是引号 / ^ 转义）与 P0 攻击串端到端、危险形态变体 12 条与不误伤 2 条、
  // argv 换行拒收、负单价拒收、migrateV0toV1 从源码绊线升级行为断言 3 条、检查点一节按新语义重写
  // （任务前锚点文件 + move 覆盖备份回归子场景 cp-ow，K 节净增 13 条）。
  // fixes 625：2026-10-25 两轮实测（审查修复轮 602 + 功能波轮 625）。602→625 多的 23 条：
  // winnav 无锚 fail-closed 反转与显式传根对照、__ahub_debug 验证态源码绊线 3 条、SSRF all:true 校验 3 条、
  // 引擎纯函数接线 2 条、MCP trustCommand 分派 1 条、队列计划开关口径 1 条、git 回滚段 [K2] 13 条。
  // fixes 657：2026-10-25 两轮实测累积。625→642 是技能生效范围轮（[SK]：skillUsages 纯函数行为、
  // skillToggleToast 四组合逐字、SKILL_TIMING_NOTE 渲染层手抄绊线、AgentManageCard 模式解释绊线——
  // ConfigPanel 刻意不在列，角色级无 skillMode）；642→648 是 Agent 管理卡分区化轮（头部/保存状态/
  // 来源徽章/技能中心入口六条绊线 + SKILL_SOURCE_LABELS 齐全性）；648→657 是工作流技能管理轮
  // （[SK]⑨：SKILL_TIMING_NOTE_WF 有牙 + 手抄绊线、三写入口单一写路径、TaskView 只读、
  // 开工快照 skillPlan 与 RunSkillEntry 契约、TaskView 读快照）。
  // 口径订正记录：WF 时机文案初版写"含返工与续跑不受影响"，被渲染层批次的代码核实推翻
  // （runStage 每阶段现读配置，任务内下一阶段即生效）——措辞已改，绊线的独特片段同步换成"下一个角色阶段"。
  // fixes 686：2026-10-25 官方模型服务轮实测（686 PASS / 0 FAIL）。671 → 686 多的 15 条是 [OM] 段：
  // parseOfficialModelsIndex 闸门（http 端点整表拒收 / 坏条目跳过点名 / 全非法不判 ok / 注册表 URL 防换源）
  // + 接线绊线（缓存独立文件 / IPC 通道与 init / preload 桥 / 官方页签与 key 门槛 / 吊销文案先于通用 401 / 测试连接透出错误正文）。
  // fixes 687：2026-10-26 图片同源豁免轮实测（687 PASS / 0 FAIL）。686 → 687 的一条是 [MI] 追加：
  // image:fetch 同源豁免绊线（本地网关图片与 API 同 host 可渲染——sameHosts 由主进程对照 agents 配置生成，
  // 第一跳与跳转后的 SSRF 拦截判定仍在，豁免不拆墙）。
  // fixes 701：2026-10-26 内置基础组轮实测（701 PASS / 0 FAIL）。687 → 701 多的 14 条是 [BM] 段：
  // buildDefaultTools 默认值形状、mcp 闸门拒伪造 builtin 条目（提交与读侧双防线）、
  // BuiltinMcpClient 进程内集成（3 工具/时区换算/非法时区/记忆往返/函数表命名路由）、
  // 接线绊线（ipc 装配与免信任分流、agents 默认工具、SettingsPage 只读行）。
  // fixes 705：2026-10-26 工具清单轮实测（705 PASS / 0 FAIL）。701 → 705 的 4 条是 [TL] 段：
  // toolDefs 全量 11 工具的行为断言 + tools:defs 通道/preload/工具面板折叠区三条绊线（单一真相：界面看到的=模型拿到的）。
  { name: 'fixes', tier: 'logic', script: 'fixes-check.mjs', min: 705, what: '安全与正确性修复（SSRF/ReDoS/费用/白名单/权限来源/编码）+ 批次 F 计划态闸门、MCP 与 Hook 的对照轮、目录对照、CLI 回报路径的盘符大小写、单执行循环占用位与计划轮上下文接线 + 2026-10-25 审查修复轮（cmd 语义拆段与危险形态变体、move 覆盖备份、检查点 backed 语义、argv 换行、负单价）+ 功能波轮（winnav fail-closed、debug 验证态、SSRF 校验、git 级回滚）+ 技能生效范围与工作流技能管理（skillUsages/时机文案/三写入口/开工快照）+ 模型回复图片渲染（[MI]：解析器/围栏免疫/SSRF 守卫在场）' },
  { name: 'deliver', tier: 'logic', script: 'deliver-check.mjs', min: 59, what: '思考摘要分段 + 角色提示词装配（产物目录、能力形态、技能注入层序、上一任务上下文都真跑过）' },
  // engine 28 / mcp-transport 31：2026-10-25 功能波轮实测（28 PASS / 31 PASS / 0 FAIL，各自独立脚本可单跑）。
  { name: 'engine', tier: 'logic', script: 'engine-check.mjs', min: 28, what: '引擎纯函数快照：六个竞态序列（清门/快照还原/续跑推断/队列出入/终态口径）+ 计划审计常量' },
  { name: 'mcp-transport', tier: 'logic', script: 'mcp-transport-check.mjs', min: 31, what: 'MCP HTTP 传输：JSON/SSE 两种响应形状、session 透传、close、超时、http 记录闸门与 trustCommand 分派' },
  // market 42：2026-10-25 技能中心轮实测（42 PASS / 0 FAIL）。zip 读写与注册表闸门在 main 层
  // （zip.ts 用 node:zlib，进 shared 会踩"shared 不碰 node:*"绊线）。
  { name: 'market', tier: 'logic', script: 'market-check.mjs', min: 42, what: '技能中心：zip 打包/解包往返与 zip-slip 拒绝、注册表 index 闸门（缺字段/坏 sha256/越权 url 逐条点名）、内置技能清单、安装哈希不符拒绝' },
  // ui=83：2026-10-24 v0.5.0 Task 1 修复轮 1 实测（结果：83 PASS / 0 FAIL）。
  // 82 → 83 多的是"显式定视口 960×640 下介绍卡完整落在视口内"那一条（Ruling T1-e 的落点）；
  // 变异自证跑过：把 .mi-note 文案改回上一轮长版本 → 该条红（bottom=661 / vh=640，裁 21px）、82 PASS / 1 FAIL，
  // 还原后 83 PASS / 0 FAIL（bottom=636）。所以这个数字是量出来的，不是估的。
  { name: 'ui', tier: 'gui', script: 'ui-shot.mjs', min: 134, what: '界面真机：对话栏模型与费用、思考折叠、产物落盘(by=tool/app)、任务列表、预设、窄窗口无溢出（量前先收掉 hover 浮层）、首页模式选择、批次 F 计划批准门与目录对照、计划态开关入口与单次开关、点存才落盘、按意见重出计划、空计划双层拒批准、剪贴板失败如实报错、双点批准不起第二条链、链在跑时拒第二提交、计划轮不跑用户 Hook（批准后恢复，同 run 内互为对照）+ Agent 管理卡展开截图（134 = 133 + 2026-10-25 新增的 agent-manage-card.png）' },
  { name: 'approval', tier: 'gui', script: 'approval-shot.mjs', min: 94, what: '命令审批真机：没批准不执行、拒绝/本次/始终、危险形态仍要问、历史进设置' },
  { name: 'cli-e2e', tier: 'gui', script: 'cli-e2e.mjs', min: 10, what: 'CLI 适配器经真实 IPC 的行为' },
  { name: 'cli-shot', tier: 'gui', script: 'cli-shot.mjs', min: 4, what: '本机 CLI 面板截图（5 个条目与实测状态）', gate: false },
  { name: 'wf-config', tier: 'gui', script: 'workflow-config-shot.mjs', min: 7, what: '工作流三角色配置条（跨厂商绑定）' },
  { name: 'model-picker', tier: 'gui', script: 'model-picker-shot.mjs', min: 3, what: 'CLI 模型清单进切换弹窗' },
  { name: 'model-list', tier: 'gui', script: 'model-list-check.mjs', min: 4, what: 'CLI 模型清单真实 IPC 返回', gate: false },
  // cli 层要真跑 codex / CodeBuddy / arkcli（烧真实额度）。下限按实测钉：cli-thinking 8、cli-workflow 9；
  // cross-vendor 留 null（能不能跑通随本机外部服务是否在线而变，钉在任何一侧都是假基线）。
  // cli-thinking 不 spawn 应用（只 require 编译产物里的适配层 + 真跑 CLI），所以它不受单实例锁影响。
  // launchesApp 默认 true：新加的套件不声明也会走这道闸门，声明 false 才跳过——漏标只会多等，不会少等。
  { name: 'cli-thinking', tier: 'cli', script: 'cli-thinking.mjs', min: 8, launchesApp: false, timeoutMs: 20 * 60 * 1000, what: '真实 CLI 吐出 reasoning 事件（codex / CodeBuddy）' },
  { name: 'cli-workflow', tier: 'cli', script: 'cli-workflow-check.mjs', min: 11, timeoutMs: 20 * 60 * 1000, what: '真实 CLI 工作流闭环：思考进卡片 + 产物真实落盘 + 交付把目录里真实存在的文件都交代过' },
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

// 一个套件都没选中就报"全绿"是这台机器的老毛病（跟"退出码 0 但不打印计数行"同一类）：
// `--only a,b`（少写等号）会被解析成 wanted=['true']、`--only=ui,aproval` 会静默丢掉拼错的那套，
// 两种都留下"跑了一轮什么都没验"的绿。这里一律 fail-closed。
if (selected.length === 0) {
  const names = SUITES.map((s) => s.name).join(', ')
  const bogus = wanted ? wanted.filter((n) => !SUITES.some((s) => s.name === n)) : []
  console.log(`[run-all] 没有选中任何套件，判红（不跑不等于跑过）`)
  if (bogus.length) console.log(`    --only 里这些名字不存在：${bogus.join(', ')}（要写 --only=a,b，空格形式不吃）`)
  console.log(`    现有套件：${names}；层级开关：logic 默认、--gui、--with-cli`)
  process.exit(1)
}

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
  if (suite.tier !== 'logic' && suite.launchesApp !== false) {
    if (!waitAppGone()) {
      console.log(`\n[FAIL] ${suite.name}  AgentHub.exe 还在运行，跳过（本套要独占启动它）。常见原因不是"上一个套件残留"，而是**用户自己开着应用**或在托盘后台运行——先请用户完全退出再跑`)
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
console.log(`\n[run-all] 必过项失败 ${failed} 个${failed ? '' : '，全绿'}`)
process.exit(failed > 0 ? 1 : 0)
