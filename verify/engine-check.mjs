// 工作流引擎纯函数的逻辑层快照测试（并发修复序列 + 任务队列 + 终态口径）。
// 用法：node verify/engine-check.mjs（跑之前先 npm run build:main —— 本套件 require 编译产物 out/shared/engine-transitions.js，
// 与真实运行时是同一份代码；不构建就会拿上一次的产物甚至模块缺失报"红/崩"）。
//
// 边界如实写明：build:main 只编 src/main + src/preload + src/shared，workflow.ts（渲染层接线：
// pumpQueue 的触发点、queueCurrent、start(queued) 分流）不在产物里，本套件测不到——那部分靠
// `npx tsc -p tsconfig.json --noEmit` 的类型检查与 GUI 层套件保证。这里钉的是纯数据变换本身：
// clearGateForRun / restoreSnapshot / pickNextResumeRole / enqueue / takeNext / isTerminal / hasExitCard，
// 以及 BUSY_STATUSES 与 TERMINAL_STATUSES 的互斥口径。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  clearGateForRun, restoreSnapshot, pickNextResumeRole, isTerminal, hasExitCard,
  enqueue, takeNext, MAX_QUEUE, BUSY_STATUSES, TERMINAL_STATUSES
} = require('../out/shared/engine-transitions.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''} `) }
}

/** 造一张最小三角色卡（类型在 TS 里，这里按 shared/types 的 RoleCard 形状给字段） */
const card = (role, status, conclusion, extra = {}) => ({
  id: `c-${role}-${Math.random().toString(36).slice(2, 8)}`,
  role, agentName: 'A', model: 'm', round: 1, status, title: role,
  conclusion: conclusion ?? '', process: [], ts: 0, ...extra
})
const gate = (round = 1) => ({ id: 'g1', round, passed: [{ text: 'a', done: true, verdict: 'pass' }], issues: [] })
const run = (over = {}) => ({
  id: 'r1', goal: '目标', status: 'waiting_user', stage: 'reviewing', round: 1, maxRounds: 3,
  reviewMode: 'human', startedAt: 0, cards: [], gate: gate(), ...over
})

// ---------- A. clearGateForRun：带门起链的统一形状（竞态 1：门还挂着却在跑的矛盾态） ----------
console.log('\n[A] clearGateForRun（清门 + 置 running + 设 stage，一次 set 完成）')
{
  const r = clearGateForRun(run({ gate: gate(), stage: 'reviewing', cards: [card('executor', 'done', '做了')] }), 'running', 'executing')
  ok('门被清掉、status 置 running、stage 按角色给对', r.gate === undefined && r.status === 'running' && r.stage === 'executing')
  ok('其余字段原样保留（卡片与记录不因清门丢失）', r.cards.length === 1 && r.goal === '目标' && r.round === 1)
  const p = clearGateForRun(run(), 'running', 'planning')
  ok('规划角色起链 stage = planning', p.stage === 'planning' && p.gate === undefined && p.status === 'running')
}

// ---------- B. restoreSnapshot：单角色重跑收尾的还原（竞态 2：不还原则 runBusy 恒真空占引擎位） ----------
console.log('\n[B] restoreSnapshot（waiting_user 带门 → 门回来；completed → 仍终态）')
{
  const snap = { status: 'waiting_user', stage: null, gate: gate(2) }
  const r = restoreSnapshot(run({ status: 'running', stage: 'reviewing', gate: undefined }), snap)
  ok('waiting_user + 门快照还原后门重新挂上（round 也原样）', r.status === 'waiting_user' && r.gate?.round === 2 && r.stage === null)
  const snap2 = { status: 'completed', stage: null, gate: undefined }
  const r2 = restoreSnapshot(run({ status: 'running', stage: 'reviewing' }), snap2)
  ok('completed 快照还原后仍是终态、无门（引擎位释放，runBusy 为假）',
    r2.status === 'completed' && r2.gate === undefined && isTerminal(r2.status))
}

// ---------- C. pickNextResumeRole：中断续跑该从谁接（竞态 3~5：重放烧额度 / 旧结论重挂门 / 绕过没发生的步骤） ----------
console.log('\n[C] pickNextResumeRole（最后一张真产出过结论的卡 → 下一环；没产出的重跑）')
{
  // 竞态序列 3：崩溃在执行中途——最后一张 executor 卡 streaming，那一步等于没发生，重跑 executor
  const mid = pickNextResumeRole([card('planner', 'done', '计划ok'), card('executor', 'streaming', '')])
  ok('executor 卡 streaming/结论为空 → 不算产出，返回 executor 重跑',
    mid.role === 'executor' && mid.produced === false, JSON.stringify(mid))
  // done 但结论是空白串同样不算产出（"产出过结论" = done 且结论非空）
  const blank = pickNextResumeRole([card('planner', 'done', '计划ok'), card('executor', 'done', '   ')])
  ok('executor 卡 done 但结论为空白 → 仍算没产出，重跑 executor',
    blank.role === 'executor' && blank.produced === false, JSON.stringify(blank))
  // 竞态序列 4：执行已产出 → 接审核，不重放规划与执行（重放 = 重复扣额度、重复写文件）
  const exec = pickNextResumeRole([card('planner', 'done', '计划ok'), card('executor', 'done', '执行完了')])
  ok('executor done 且结论非空 → 返回 reviewer 接着跑（producedRole=executor）',
    exec.role === 'reviewer' && exec.produced === true && exec.producedRole === 'executor', JSON.stringify(exec))
  // 竞态序列 5：审核已产出 → 返回 reviewer（producedRole=reviewer），由调用方重挂门，
  // 绝不自作主张交付或返工
  const rev = pickNextResumeRole([card('planner', 'done', '计划ok'), card('executor', 'done', '执行完了'), card('reviewer', 'done', '审完了')])
  ok('reviewer done → 返回 reviewer 且 producedRole=reviewer（调用方重挂门）',
    rev.role === 'reviewer' && rev.produced === true && rev.producedRole === 'reviewer', JSON.stringify(rev))
  // 没有任何产出：规划还在 streaming / 一张卡都没有 → 从规划起跑
  const p0 = pickNextResumeRole([card('planner', 'streaming', '')])
  ok('规划卡 streaming → 从 planner 起跑', p0.role === 'planner' && p0.produced === false && p0.producedRole === null)
  const none = pickNextResumeRole([])
  ok('一张相关卡都没有 → 从 planner 起跑', none.role === 'planner' && none.card === null)
}

// ---------- D. enqueue / takeNext：队列的顺序、上限与出队 ----------
console.log('\n[D] enqueue / takeNext（排队制并行：单执行循环不变，终态后按 FIFO 接队）')
{
  const q0 = []
  const q1 = enqueue(q0, { goal: '一', queuedAt: 1 })
  const q2 = enqueue(q1.queue, { goal: '二', queuedAt: 2 })
  const q3 = enqueue(q2.queue, { goal: '三', queuedAt: 3 })
  ok('入队保持 FIFO 顺序', q3.queue.map((t) => t.goal).join(',') === '一,二,三')
  // 上限：MAX_QUEUE = 10，第 11 条被拒且给出拒绝原因
  let q = q3.queue
  for (let i = 4; i <= 10; i++) q = enqueue(q, { goal: `任务${i}`, queuedAt: i }).queue
  const full = enqueue(q, { goal: '挤不进', queuedAt: 99 })
  ok(`超限（第 ${MAX_QUEUE + 1} 条）被拒绝并给出原因`, MAX_QUEUE === 10 && !!full.rejected && full.queue.length === 10, full.rejected ?? '无 rejected')
  ok('拒绝时原队列原样（不丢已排任务、不悄悄挤掉队头）', full.queue === q && full.queue.every((t) => t.goal !== '挤不进'))
  const head = takeNext(full.queue)
  ok('takeNext 取队头并缩短队列', head !== null && head.item.goal === '一' && head.queue.length === 9 && head.queue[0].goal === '二')
  let rest = full.queue
  let last = null
  while (true) { const t = takeNext(rest); if (!t) break; last = t.item; rest = t.queue }
  ok('逐条取空后 takeNext 返回 null（取完的队列是空表）', last?.goal === '任务10' && rest.length === 0)
  ok('空队列 takeNext 返回 null（pumpQueue 不接队）', takeNext([]) === null)
}

// ---------- E. hasExitCard：七个终态逐个有出口卡 ----------
console.log('\n[E] hasExitCard（七个终态逐个断言；waiting_user 挂门与 interrupted 不是出口）')
{
  for (const s of ['cancelled', 'failed', 'timeout', 'rework_limit', 'token_limit', 'budget_limit', 'completed']) {
    ok(`hasExitCard('${s}') === true`, hasExitCard(s) === true, String(hasExitCard(s)))
  }
  ok('waiting_user（挂门等人）与 interrupted（重启未核对）没有出口卡，running 更没有',
    hasExitCard('waiting_user') === false && hasExitCard('interrupted') === false && hasExitCard('running') === false)
}

// ---------- F. isTerminal 与 runBusy 的互斥口径（竞态 6：终态被当成忙态，切换/新建/删除全被空占） ----------
console.log('\n[F] isTerminal vs BUSY_STATUSES（两份列表互斥，谁改一份漏一份会被这里拦住）')
{
  const overlap = TERMINAL_STATUSES.filter((s) => BUSY_STATUSES.includes(s))
  ok('终态列表与引擎忙状态列表无交集', overlap.length === 0, JSON.stringify(overlap))
  ok('isTerminal 对七个终态全真、对忙状态与 waiting_user/interrupted 全假',
    TERMINAL_STATUSES.every((s) => isTerminal(s) === true) &&
    BUSY_STATUSES.every((s) => isTerminal(s) === false) &&
    isTerminal('waiting_user') === false && isTerminal('interrupted') === false)
  ok('runBusy 的忙列表恰是 preparing/running/waiting_review（占用位口径没被顺手改掉）',
    BUSY_STATUSES.length === 3 && BUSY_STATUSES.includes('preparing') && BUSY_STATUSES.includes('running') && BUSY_STATUSES.includes('waiting_review'))
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
