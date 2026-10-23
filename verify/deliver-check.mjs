// 交付与思考摘要的功能验证（渲染层纯逻辑：type-only 导入可被 transpile 擦除，无需打包）
// 用法：node verify/deliver-check.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 先扫掉上一次留下的临时目录：Windows 上刚 require 过的 .cjs 会被短暂占用，
// 收尾那次 rmSync 常常剩个空壳（ENOTEMPTY 不在重试范围内），下次开头删才可靠
for (const stale of readdirSync(tmpdir()).filter((d) => d.startsWith('ahub-deliver-'))) {
  try {
    rmSync(join(tmpdir(), stale), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch { /* 删不掉就继续，不影响本次验证 */ }
}

const TMP = mkdtempSync(join(tmpdir(), 'ahub-deliver-'))
function loadTs(rel, asName) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText
  const file = join(TMP, asName + '.cjs')
  writeFileSync(file, out)
  return require(file)
}

/**
 * pricing 现在值导入 shared/overrides（单价覆盖的缓存要 main/renderer 共用同一个实例），
 * 单文件 transpile 会把那条 require 指到不存在的临时目录 —— 这里直接用编译产物，
 * 顺带保证被测口径与真实运行时是同一份代码。
 */
const pricing = require('../out/shared/pricing.js')

const { digestThinking } = loadTs('../src/renderer/src/lib/thinking.ts', 'thinking')
const { buildRoleMessages, parseRoleOutput } = loadTs('../src/renderer/src/lib/rolePrompts.ts', 'rolePrompts')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''} `) }
}

// ---------- A. 思考摘要：短思考不裁、长思考挑重点、原文可完整展开 ----------
console.log('\n[A] digestThinking（默认只显重点，其余段可展开）')
{
  const short1 = '我先看看这个目录里有什么文件。'
  const d = digestThinking(short1)
  ok('单段思考不裁剪', d.restCount === 0 && d.keepText === short1)
  const two = '第一段。\n\n第二段。'
  const d2 = digestThinking(two)
  ok('两段思考不裁剪（≤2 段保持原样）', d2.restCount === 0 && d2.keepText === two)
}
{
  const filler = ['让我先看看项目的结构，然后再决定怎么做。', '我先读一下 README 文件的内容。', '嗯，这里还需要再检查一下配置。']
  const important = ['因此结论是：把 grant.dir 覆盖为产物目录，只换目录不提权。', '风险：模型未授权工具时必须由 AgentHub 落盘，否则无法验证。']
  const text = [...filler, ...important].join('\n\n')
  const d = digestThinking(text)
  ok('长思考折叠了段落', d.restCount > 0, `rest=${d.restCount}`)
  ok('结论段被保留', important.every((p) => d.keepText.includes(p)), d.keepText.slice(0, 80))
  ok('keepText 是原文子集（不改写内容）', text.includes(d.keepText) || d.keepText.split('\n\n').every((p) => text.includes(p)))
  ok('保留段数不超过 5', d.keepText.split('\n\n').length <= 5, String(d.keepText.split('\n\n').length))
}
{
  // 全段低信号时保底保留末尾结论段，不出现"什么都没有"
  const dull = ['随便聊聊今天天气。', '再随便想想别的事。', '最后收尾一句。', '嗯。', '再来一句。', '还有一句。']
  const d = digestThinking(dull.join('\n\n'))
  ok('全低信号时仍有可见内容', d.keepText.length > 0 && d.restCount > 0, d.keepText)
}

// ---------- B. 执行角色提示词按能力形态拼装（不再误称"无工具权限"） ----------
console.log('\n[B] buildRoleMessages：执行角色能力形态 + 产物目录')
const ctx = { goal: '写一个脚本', round: 1, maxRounds: 3, outputDir: 'D:\\art' }
{
  const cli = buildRoleMessages('executor', ctx, { kind: 'cli', dir: 'D:\\art', hasTools: true })
  ok('CLI 执行角色被告知可读写文件', /可读写文件、可执行命令/.test(cli.system) && !/无本机工具执行权限/.test(cli.system))
  ok('CLI 执行角色拿到工作目录', cli.system.includes('D:\\art') && /工作目录/.test(cli.system))
  ok('执行角色仍要求如实报告', /绝不虚构已执行的操作/.test(cli.system))
  ok('输出协议为单个 JSON 对象', /只输出一个 JSON 对象/.test(cli.system))
}
{
  const t = buildRoleMessages('executor', ctx, { kind: 'model', dir: 'D:\\art', hasTools: true, allowCommands: true, allowWeb: false })
  ok('已授权工具的模型角色描述文件工具', /已授权文件工具/.test(t.system))
  ok('产物目录作为文件工具工作根写明', /产物目录（文件工具的工作根目录/.test(t.system) && t.system.includes('D:\\art'))
  ok('命令授权单独说明', /已授权执行 shell 命令/.test(t.system))
  ok('未授权联网时不提联网', !/已授权联网/.test(t.system))
}
{
  const n = buildRoleMessages('executor', ctx, { kind: 'model', dir: '', hasTools: false })
  ok('无工具模型如实说明纯文本接入', /无本机工具执行权限/.test(n.system))
  ok('无工具模型被告知 conclusion 会被落盘', /conclusion 会被原样保存/.test(n.system))
  ok('无工具时不虚构目录提示', !/产物目录/.test(n.system))
}
{
  const p = buildRoleMessages('planner', ctx)
  ok('规划角色看到产物目录（可据此定验收标准）', p.user.includes('D:\\art') && /验收标准|验收/.test(p.user))
  const r = buildRoleMessages('reviewer', ctx)
  ok('审核角色看到产物目录（可据此核实）', r.user.includes('D:\\art'))
  const e = buildRoleMessages('executor', ctx, { kind: 'model', dir: '', hasTools: false })
  ok('规划/审核不混入执行角色提示词', !/执行 Agent/.test(p.system) && !/执行 Agent/.test(r.system) && /执行 Agent/.test(e.system))
}
{
  const parsed = parseRoleOutput('{"conclusion":"完成","checklist":[{"text":"a","done":true}]}')
  ok('结构化输出解析仍可用', parsed?.conclusion === '完成' && parsed.checklist?.length === 1)
}

const { matchKeyBinding, formatKeyBinding, safeName, validateKeyBinding } = loadTs('../src/renderer/src/lib/utils.ts', 'utils')
// pricing 现在会值导入 shared/overrides，单文件 transpile 会断链：直接用编译产物，
// 被测口径与真实运行时口径是同一份
const { visionOf } = pricing
{
  const ev = (o) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', ...o })
  ok('Ctrl+M 命中', matchKeyBinding('Ctrl+M', ev({ ctrlKey: true, key: 'm' })))
  ok('多按了 Shift 不算命中（不会误触发）', !matchKeyBinding('Ctrl+M', ev({ ctrlKey: true, shiftKey: true, key: 'm' })))
  ok('Ctrl+Shift+N 命中', matchKeyBinding('Ctrl+Shift+N', ev({ ctrlKey: true, shiftKey: true, key: 'N' })))
  ok('Cmd 等价于 Ctrl（mac 习惯不误伤，Windows 上 meta 也算）', matchKeyBinding('Ctrl+M', ev({ metaKey: true, key: 'm' })))
  ok('未配置键位永不命中（空键位 ≠ 全触发）', !matchKeyBinding(undefined, ev({ ctrlKey: true, key: 'm' })))
  ok('具名键 Comma 能匹配到 ","', matchKeyBinding('Ctrl+Comma', ev({ ctrlKey: true, key: ',' })))
  ok('录制格式：Ctrl + , → Ctrl+Comma', formatKeyBinding(ev({ ctrlKey: true, key: ',' })) === 'Ctrl+Comma')
  ok('裸键不允许登记为全局快捷键', formatKeyBinding(ev({ key: 'a' })) === null)
  ok('只按修饰键时继续等待主键', formatKeyBinding(ev({ ctrlKey: true, key: 'Control' })) === null)
  // 实测踩坑：modeSwitch 被设成 Ctrl+C 后 Ctrl+M 失效且毫无提示，复制也被吞
  ok('拒绝占用 Ctrl+C（复制）', validateKeyBinding('Ctrl+C').ok === false && /编辑必需键/.test(validateKeyBinding('Ctrl+C').message ?? ''))
  ok('拒绝 Ctrl+V/X/Z/A 等编辑必需键', ['Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+A'].every((b) => validateKeyBinding(b).ok === false))
  ok('加 Shift 后放行（Ctrl+Shift+C 不占编辑键）', validateKeyBinding('Ctrl+Shift+C').ok === true)
  ok('默认键位自身全部合法', ['Ctrl+M', 'Ctrl+Comma', 'Ctrl+Backspace', 'Ctrl+Shift+N'].every((b) => validateKeyBinding(b).ok === true))
  ok('无法识别的键位被判非法', validateKeyBinding('糊在一起').ok === false || validateKeyBinding('').ok === false)
  ok('safeName 仍在（文件名安全化口径唯一）', safeName('a/b:c*.md') === 'a_b_c_.md' && safeName('') === 'untitled')
  ok('已知纯文本模型判为不支持图片', visionOf('deepseek-chat') === 'no' && visionOf('deepseek-reasoner') === 'no')
  ok('已知视觉模型判为支持', visionOf('gpt-4o-2024-11-20') === 'yes' && visionOf('claude-3-5-sonnet') === 'yes' && visionOf('qwen2.5-vl-72b') === 'yes')
  ok('未登记模型判为 unknown（提示后放行，不替服务端下结论）', visionOf('some-new-model') === 'unknown')
}
{
  const ctx = { goal: '目标', round: 1, maxRounds: 3, outputDir: 'D:\\art' }
  const withPrompt = buildRoleMessages('planner', ctx, undefined, '始终用中文，不要输出前言')
  ok('Agent 常驻提示词注入到 system', withPrompt.system.includes('始终用中文，不要输出前言'))
  ok('常驻提示词排在角色协议之后（不覆盖输出格式）', withPrompt.system.indexOf('始终用中文') > withPrompt.system.indexOf('{'))
  const without = buildRoleMessages('planner', ctx)
  ok('未配置常驻提示词时不注入空段落', !without.system.includes('常驻要求') && without.system.length < withPrompt.system.length)
  const execPrompt = buildRoleMessages('executor', ctx, { kind: 'model', dir: 'D:\\art', hasTools: true }, '改完必须跑测试')
  ok('执行角色同时具备产物目录与常驻提示词', execPrompt.system.includes('D:\\art') && execPrompt.system.includes('改完必须跑测试'))
  ok('执行角色的输出协议未被常驻提示词挤掉', /conclusion/.test(execPrompt.system))
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
// 收尾删掉 transpile 临时目录：不清就会每次跑留一个（实测攒了十几个）
// Windows 上刚 require 过的文件可能短暂被占，带重试才删得干净
try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
} catch { /* 忽略 */ }
process.exit(fail > 0 ? 1 : 0)
