// 本轮修复的功能验证（直接调用编译产物 out/，不经 GUI、不 mock 被测代码）
// 用法：node verify/fixes-check.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const { execTool } = await import('../out/main/tools.js')
const openai = await import('../out/main/adapters/openai.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

// ---------- A/B. glob 匹配器 + search_files ----------
console.log('\n[A] glob_files / search_files（新匹配器，无正则回溯）')
const tmp = mkdtempSync(join(tmpdir(), 'ahub-glob-'))
writeFileSync(join(tmp, 'a.md'), '# TODO 顶层\n')
mkdirSync(join(tmp, 'sub', 'deep'), { recursive: true })
writeFileSync(join(tmp, 'sub', 'b.md'), 'TODO 中层\n')
writeFileSync(join(tmp, 'sub', 'deep', 'c.ts'), '// TODO 深层\n')
mkdirSync(join(tmp, 'node_modules'), { recursive: true })
writeFileSync(join(tmp, 'node_modules', 'x.md'), 'TODO 依赖内\n')
writeFileSync(join(tmp, 'a'.repeat(60) + '.md'), 'TODO 长名\n')
const grant = { dir: tmp, allowCommands: false, allowWeb: true }
const run = (tool, args) => execTool(grant, tool, JSON.stringify(args))

{
  const r = await run('glob_files', { pattern: '**/*.md' })
  ok('**/*.md 跨层匹配', r.ok && r.output.includes('a.md') && r.output.includes('sub/b.md'), r.output)
  ok('跳过 node_modules', r.ok && !r.output.includes('node_modules'), r.output)
}
{
  const r = await run('glob_files', { pattern: '*.md' })
  ok('*.md 不跨目录', r.ok && r.output.includes('a.md') && !r.output.includes('sub/b.md'), r.output)
}
{
  const r = await run('glob_files', { pattern: 'sub/**/*.ts' })
  ok('sub/**/*.ts 命中深层', r.ok && r.output.includes('sub/deep/c.ts'), r.output)
}
{
  const r = await run('glob_files', { pattern: 'SUB/*.MD' })
  ok('大小写不敏感（Windows 习惯）', r.ok && r.output.includes('sub/b.md'), r.output)
}
{
  const r = await run('glob_files', { pattern: '' })
  ok('空模式被拒绝', !r.ok, r.output)
  const long = await run('glob_files', { pattern: '*'.repeat(201) })
  ok('超长模式被拒绝（200 字符上限）', !long.ok, long.output)
}
{
  // 灾难性回溯模式：旧正则实现在此会挂死主进程
  const t0 = Date.now()
  const r = await run('glob_files', { pattern: '*a*a*a*a*a*a*a*a*a*a*b' })
  const ms = Date.now() - t0
  ok('ReDoS 模式快速返回（<1s）', ms < 1000, `${ms}ms`)
  ok('ReDoS 模式结果正确（无匹配）', r.ok && r.output.includes('没有匹配'), r.output)
}
{
  const r = await run('search_files', { pattern: 'TODO', glob: '**/*.md' })
  ok('search_files + glob 过滤', r.ok && r.output.includes('a.md:1') && !r.output.includes('c.ts'), r.output)
  const bad = await run('search_files', { pattern: 'TODO', glob: '*'.repeat(201) })
  ok('search_files 非法 glob 被拒绝', !bad.ok, bad.output)
}

// ---------- C. web_fetch SSRF 拦截 ----------
console.log('\n[C] web_fetch SSRF 拦截（拒绝发生在发出请求之前）')
const blocked = [
  ['环回 IP', 'http://127.0.0.1:9999/'],
  ['localhost', 'http://localhost/admin'],
  ['元数据服务', 'http://169.254.169.254/latest/meta-data/'],
  ['内网 192.168', 'http://192.168.1.1/'],
  ['内网 10.x', 'http://10.0.0.5/'],
  ['内网 172.16', 'http://172.16.0.1/'],
  ['IPv6 环回', 'http://[::1]/'],
  ['本地协议', 'file:///C:/Windows/win.ini'],
  ['公网名指向环回', 'http://localtest.me/']
]
for (const [name, url] of blocked) {
  const r = await run('web_fetch', { url })
  ok(`拦截 ${name}（${url}）`, !r.ok && r.output.includes('拒绝'), r.output)
}
{
  const r = await run('web_fetch', { url: 'https://example.com/' })
  // 纯 Node 环境没有 electron.net：走到 require('electron') 失败即证明已通过 SSRF 闸门
  ok('公网域名未被误拦（失败点在 electron 而非 SSRF）', !r.ok && !r.output.includes('SSRF'), r.output)
}
{
  const noWeb = await execTool({ dir: tmp, allowWeb: false }, 'web_fetch', JSON.stringify({ url: 'https://example.com/' }))
  ok('未授权联网时拒绝', !noWeb.ok && noWeb.output.includes('未授权联网'), noWeb.output)
}

// ---------- D/E. mock OpenAI 兼容服务：用量明细 + 模型白名单 ----------
console.log('\n[D] 用量明细（入/出）随事件上报 + [E] 模型白名单不截断')

/** 按脚本回放的 SSE mock：每个请求依次消费一段帧序列 */
function startMock(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url] ?? routes['*']
    if (!handler) { res.writeHead(404).end('{}'); return }
    handler(req, res)
  })
  return new Promise((resolve_) => server.listen(0, '127.0.0.1', () => resolve_({ server, port: server.address().port })))
}
const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
const textFrame = (text) => ({ choices: [{ index: 0, delta: { content: text } }] })
const stopFrame = (usage) => ({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) })
const toolFrame = (usage) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.md' }) } }] }, finish_reason: 'tool_calls' }],
  ...(usage ? { usage } : {})
})

function collect(chatStream, cfg, messages, grant) {
  return new Promise((resolve_) => {
    const events = []
    chatStream(cfg, 'test-key', 'req_' + Date.now(), messages, (e) => {
      events.push(e)
      if (e.type === 'done' || e.type === 'error') resolve_(events)
    }, grant)
  })
}

{
  const { server, port } = await startMock({
    '/v1/chat/completions': (_q, res) => sse(res, [textFrame('你好'), stopFrame({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })])
  })
  const events = await collect(openai.chatStream, { provider: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'deepseek-chat' }, [{ role: 'user', content: 'hi' }], undefined)
  const usage = events.find((e) => e.type === 'usage')?.usage
  ok('单轮上报 tokens=150', usage?.tokens === 150, JSON.stringify(usage))
  ok('单轮上报入/出明细（100/50）', usage?.prompt === 100 && usage?.completion === 50, JSON.stringify(usage))
  const { estimateCost } = await import('../out/shared/pricing.js')
  const cost = estimateCost('deepseek-chat', usage)
  ok('费用按入/出分别计价（¥0.0005）', cost === 0.0005, String(cost))
  ok('费用不再把输出按输入价计（旧值 ¥0.00015）', cost !== 0.00015, String(cost))
  server.close()
}
{
  // 工具循环两轮：明细应累加
  let call = 0
  const { server, port } = await startMock({
    '/v1/chat/completions': (_q, res) => {
      call++
      sse(res, call === 1
        ? [toolFrame({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })]
        : [textFrame('完成'), stopFrame({ prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 })])
    }
  })
  const events = await collect(openai.chatStream, { provider: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'deepseek-chat' }, [{ role: 'user', content: '读文件' }], { dir: tmp })
  const usage = events.find((e) => e.type === 'usage')?.usage
  ok('工具循环累计 tokens=350', usage?.tokens === 350, JSON.stringify(usage))
  ok('工具循环累计入/出（300/50）', usage?.prompt === 300 && usage?.completion === 50, JSON.stringify(usage))
  ok('工具调用真实执行', events.some((e) => e.type === 'tool' && e.toolCall?.status === 'done'), JSON.stringify(events.filter((e) => e.type === 'tool').map((e) => e.toolCall?.status)))
  server.close()
}
{
  // 有一轮缺明细：不得给出半真的入/出拆分
  let call = 0
  const { server, port } = await startMock({
    '/v1/chat/completions': (_q, res) => {
      call++
      sse(res, call === 1
        ? [toolFrame({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })]
        : [textFrame('完成'), stopFrame({ total_tokens: 230 })])
    }
  })
  const events = await collect(openai.chatStream, { provider: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'deepseek-chat' }, [{ role: 'user', content: '读文件' }], { dir: tmp })
  const usage = events.find((e) => e.type === 'usage')?.usage
  ok('明细不全时只报总量（不给错的拆分）', usage?.tokens === 350 && usage.prompt == null && usage.completion == null, JSON.stringify(usage))
  server.close()
}
{
  const ids = Array.from({ length: 60 }, (_, i) => `model-${i + 1}`)
  const { server, port } = await startMock({
    '/v1/models': (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: ids.map((id) => ({ id })) })) }
  })
  const r = await openai.testConnection({ provider: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'model-55' }, 'test-key')
  ok('白名单不截断（60 个全返回）', r.ok && r.models?.length === 60, `len=${r.models?.length}`)
  ok('第 55 个模型可被校验命中', r.models?.includes('model-55') === true, r.message)
  server.close()
}

// ---------- F. 命令输出截断边界（不再把 UTF-8 误判成 GBK） ----------
console.log('\n[F] run_command 输出截断边界（UTF-8 不被误解码为 GBK）')
{
  // 60000 个"中" = 180KB UTF-8，超过 100KB 上限且截断点必落在多字节字符中间
  const r = await execTool({ dir: tmp, allowCommands: true }, 'run_command', JSON.stringify({ command: `node -e "process.stdout.write('中'.repeat(60000))"` }))
  ok('截断后仍为正常中文（无替换符）', r.ok && r.output.includes('中') && !r.output.includes('�'), r.output.slice(0, 60))
  ok('未被按 GBK 误解码（无"涓"类乱码）', !/涓|锟/.test(r.output), r.output.slice(0, 60))
  ok('标注了截断', r.output.includes('截断'), r.output.slice(-40))
}

// ---------- G. reasoning 回传由主进程裁决（渲染层不再硬编码） ----------
console.log('\n[G] 历史消息的 reasoning 默认不回传接口')
{
  const bodies = []
  const { server, port } = await startMock({
    '/v1/chat/completions': (req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => { try { bodies.push(JSON.parse(raw)) } catch { bodies.push({}) } ; sse(res, [textFrame('好'), stopFrame({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })]) })
    }
  })
  await collect(openai.chatStream, { provider: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'deepseek-chat' }, [
    { role: 'user', content: '上问' },
    { role: 'assistant', content: '上答', reasoning: '上一轮的思考内容' },
    { role: 'user', content: '本问' }
  ], undefined)
  const asst = bodies[0]?.messages?.find((m) => m.role === 'assistant')
  ok('默认不带 reasoning_content（严格接口不 400）', asst && !('reasoning_content' in asst), JSON.stringify(asst))
  ok('思考内容不混入正文', asst?.content === '上答', JSON.stringify(asst))
  server.close()
}

// ---------- H. 关闭确认（Ctrl+W 不再静默退出应用） ----------
console.log('\n[H] decideClose（正在执行工作流时关闭必须弹确认）')
{
  const lc = await import('../out/main/lifecycle.js')
  ok('没在跑：直接退出（不打扰）', lc.decideClose({ busy: false, quitting: false }) === 'quit')
  ok('正在跑：弹确认', lc.decideClose({ busy: true, quitting: false }) === 'ask')
  ok('已确认过退出：不再重复追问（否则托盘退出会被自己拦住）', lc.decideClose({ busy: true, quitting: true }) === 'quit')
  ok('确认框的默认选项是"后台继续运行"（index.ts 里 defaultId=0）', /buttons: \[\s*'后台继续运行/.test(readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')))
  ok('busy 由渲染层上报而非主进程猜测', readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf-8').includes('app:setBusy'))
}

// ---------- I. 项目约定自动读取（AGENTS.md / CLAUDE.md） ----------
console.log('\n[I] readConventions（进目录自动读约定，不用手抄进常驻提示词）')
{
  const cv = await import('../out/main/conventions.js')
  const dir = mkdtempSync(join(tmpdir(), 'ahub-conv-'))
  ok('空目录返回空数组（不是异常）', (await cv.readConventions(dir)).length === 0)
  ok('未设目录返回空数组', (await cv.readConventions(undefined)).length === 0 && (await cv.readConventions('  ')).length === 0)
  writeFileSync(join(dir, 'AGENTS.md'), '构建用 npm run build，禁止直接改 out/。\n')
  writeFileSync(join(dir, 'CLAUDE.md'), '回复保持中文。\n')
  writeFileSync(join(dir, 'README.md'), '不该被读取\n')
  const list = await cv.readConventions(dir)
  ok('两个约定文件都读到且按声明顺序', list.length === 2 && list[0].name === 'AGENTS.md' && list[1].name === 'CLAUDE.md', JSON.stringify(list.map((f) => f.name)))
  ok('只读约定文件，不误吞 README', !list.some((f) => f.content.includes('不该被读取')))
  ok('子目录不放约定就不算（不递归）', (await cv.readConventions(join(dir, 'nope'))).length === 0)
  const big = mkdtempSync(join(tmpdir(), 'ahub-conv-big-'))
  writeFileSync(join(big, 'AGENTS.md'), 'x'.repeat(40 * 1024))
  const [trunc] = await cv.readConventions(big)
  ok('超长文件截断并如实标记', trunc?.truncated === true && trunc.content.length === 16 * 1024, `${trunc?.content?.length}`)
  const block = cv.renderConventionsBlock(list)
  ok('注入段落标出来源文件名', block.includes('AGENTS.md') && block.includes('CLAUDE.md') && block.includes('自动读取'), block.slice(0, 80))
  ok('空清单不产生段落', cv.renderConventionsBlock([]) === '')
  ok('截断段落写明已截断', cv.renderConventionsBlock([trunc]).includes('已截断'))
  // 注入顺序：角色协议 → 项目约定 → 常驻要求（协议不能被仓库文字覆盖）
  const rp = readFileSync(new URL('../src/renderer/src/lib/rolePrompts.ts', import.meta.url), 'utf-8')
  ok('工作流三角色都带约定（约定进 RunContext 拼装）', /ctx\.conventions\?\.trim\(\)/.test(rp))
  ok('常驻要求排在项目约定之后（后写的更贴近执行者）', rp.indexOf('ctx.conventions') < rp.indexOf('agentSystemPrompt?.trim()'))
  // 两条链路都要接上：工作站对话 + 工作流角色
  ok('工作站对话接了约定注入', readFileSync(new URL('../src/renderer/src/stores/sessions.ts', import.meta.url), 'utf-8').includes('renderConventionsBlock'))
  ok('工作流引擎接了约定注入', readFileSync(new URL('../src/renderer/src/stores/workflow.ts', import.meta.url), 'utf-8').includes('conventionsBlock(outputDir)'))
  rmSync(dir, { recursive: true, force: true })
  rmSync(big, { recursive: true, force: true })
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
