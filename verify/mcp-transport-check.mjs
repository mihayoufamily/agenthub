// MCP HTTP 传输的逻辑层验证（直接调用编译产物 out/，不经 GUI、不 mock 被测代码）。
// 自带内存 HTTP MCP server（node:http，127.0.0.1 随机端口），照 mock-mcp-server.mjs 的工具清单风格，
// 另有 SSE 响应变体与带 mcp-session-id 的变体。覆盖：
//   initialize（JSON 与 SSE 两种响应形状）/ tools/list / tools/call / session-id 透传 /
//   close 发 DELETE / 超时与错误如实 / mcp-list 闸门对 http 记录的接受与拒绝 / planSpawn 对 http 不出 cmd 形状。
// 运行需要 build:main 产物：node verify/mcp-transport-check.mjs（超时用例要等 15s 的 initialize 上限，属正常）
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

const mcp = await import('../out/main/mcp.js')
const mcpList = await import('../out/shared/mcp-list.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

const TOOLS = [
  { name: 'echo', description: '把输入原样返回', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'no_schema', description: '没有声明参数结构' },
  { name: 'boom', description: '返回 isError 的工具' }
]

/**
 * 内存 HTTP MCP server。opts：
 *   sse     —— 所有响应走 text/event-stream（先发一条非 JSON 的 data 行、再发一条别的 id 的 decoy，
 *              客户端必须丢掉它们、只认匹配自己 id 的最终消息）
 *   session —— initialize 响应头带 mcp-session-id，后续请求（含 DELETE）没带就 404
 *   hang    —— initialize 收到后永远不响应（测 15s 超时）；tools/call 的 sleep 工具同样不响应（测 close 中止）
 * 记录每个请求的 method / mcp-session-id / body 到 log，供透传断言用。
 */
function startHttpMcp(opts = {}) {
  const state = { log: [], sid: `sess_${Math.random().toString(36).slice(2, 8)}`, deleted: false, pending: [] }
  const replyJson = (res, id, result, extraHeaders = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json', ...extraHeaders })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }
  const replySse = (res, id, result) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: not-json\n\n') // 非协议行：客户端必须丢掉
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'decoy', result: { decoy: true } })}\n\n`) // 别的请求的响应
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
    res.end()
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      state.log.push({ method: req.method, sid: String(req.headers['mcp-session-id'] ?? ''), body })
      if (req.method === 'DELETE') {
        if (req.headers['mcp-session-id'] === state.sid) { state.deleted = true; res.writeHead(200); res.end() }
        else { res.writeHead(404); res.end('unknown session') }
        return
      }
      let msg
      try { msg = JSON.parse(body) } catch { res.writeHead(400); res.end('bad json'); return }
      const { id, method, params } = msg
      // 会话口径：initialize 之前不可能有 sid，之后没带 sid 的请求一律 404
      if (opts.session && method !== 'initialize' && req.headers['mcp-session-id'] !== state.sid) {
        res.writeHead(404); res.end('no session'); return
      }
      if (id === undefined) { res.writeHead(202); res.end(); return } // notifications/initialized：不等响应
      if (method === 'initialize') {
        if (opts.hang) { state.pending.push(res); return } // 永远不响应：客户端该在 15s 超时
        const result = { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-http-mcp', title: 'Mock HTTP MCP', version: '1.0' } }
        const extra = opts.session ? { 'mcp-session-id': state.sid } : {}
        if (opts.sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream', ...extra }); res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`); res.end() }
        else replyJson(res, id, result, extra)
        return
      }
      if (method === 'tools/list') {
        const result = { tools: TOOLS }
        if (opts.sse) replySse(res, id, result)
        else replyJson(res, id, result)
        return
      }
      if (method === 'tools/call') {
        const name = params?.name
        if (name === 'echo') {
          const result = { content: [{ type: 'text', text: `echo:${params?.arguments?.text ?? ''}` }] }
          if (opts.sse) replySse(res, id, result)
          else replyJson(res, id, result)
          return
        }
        if (name === 'no_schema') {
          const result = { content: [{ type: 'text', text: 'ok-no-schema' }] }
          if (opts.sse) replySse(res, id, result)
          else replyJson(res, id, result)
          return
        }
        if (name === 'boom') {
          const result = { isError: true, content: [{ type: 'text', text: '这个工具故意失败' }] }
          if (opts.sse) replySse(res, id, result)
          else replyJson(res, id, result)
          return
        }
        if (name === 'sleep') { state.pending.push(res); return } // 挂着不响应：等客户端 close 中止
        if (name === '__httpfail') { res.writeHead(500); res.end('mock server 内部错误'); return }
        // 未知工具：JSON-RPC error（HTTP 状态仍是 200，与真实 server 的做法一致）
        const err = { code: -32601, message: `未知工具 ${name}` }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: err }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        origin: `http://127.0.0.1:${port}`,
        state,
        close: async () => {
          for (const r of state.pending) { try { r.destroy() } catch { /* noop */ } }
          server.closeAllConnections()
          await new Promise((r) => server.close(r))
        }
      })
    })
  })
}

const httpServer = (url, name = 'http-mock') => ({ id: `mcp_${name}`, name, command: '', transport: 'http', url, formatVersion: 2, enabled: true })

// ---------- mcp-list 闸门：http 记录的接受与拒绝 ----------
console.log('\n[mcp-list 闸门]')
{
  const { sanitizeMcpList, partitionMcpServers, MCP_HTTP_URL_REJECT_MESSAGE, MCP_SHAPE_REJECT_MESSAGE } = mcpList

  const good = { id: 'a', name: '远程', command: '', transport: 'http', url: 'https://mcp.example.com/mcp' }
  const s1 = sanitizeMcpList([good])
  ok('sanitize 接受 url 合法的 http 记录（不打失效标记）', s1.length === 1 && s1[0].transport === 'http' && s1[0].url === 'https://mcp.example.com/mcp' && !s1[0].httpInvalid && s1[0].enabled !== false)

  const s2 = sanitizeMcpList([{ id: 'b', name: '没地址', command: '', transport: 'http' }])
  ok('sanitize 对缺 url 的 http 记录补失效标记并停用', s2.length === 1 && s2[0].httpInvalid === true && s2[0].enabled === false)

  const s3 = sanitizeMcpList([{ id: 'c', name: '坏地址', command: '', transport: 'http', url: 'ftp://x.example.com' }])
  ok('sanitize 对非 http(s) url 的记录同样标失效', s3.length === 1 && s3[0].httpInvalid === true && s3[0].enabled === false)

  const s4 = sanitizeMcpList([
    { id: 'd', name: '本机', command: '', launch: { bin: 'node', args: ['server.js'] } },
    { id: 'e', name: '旧格式', command: 'node x.js' }
  ])
  ok('stdio 记录不受影响（不标 httpInvalid，旧单命令仍走 legacyInvalid）',
    s4.length === 2 && s4[0].httpInvalid === undefined && s4[0].enabled !== false && s4[1].legacyInvalid === true && s4[1].httpInvalid === undefined)

  const once = JSON.stringify(sanitizeMcpList([{ id: 'f', name: '幂等', command: '', transport: 'http', url: 'http://127.0.0.1:1/mcp' }]))
  ok('sanitize 幂等（跑两遍逐字节相同）', once === JSON.stringify(sanitizeMcpList(JSON.parse(once))))

  const p1 = partitionMcpServers([good])
  ok('partition 接受 url 合法的 http 记录', p1.kept.length === 1 && p1.rejected.length === 0 && p1.kept[0].id === 'a')

  const p2 = partitionMcpServers([{ id: 'g', name: '坏地址', command: '', transport: 'http', url: 'not a url' }])
  ok('partition 拒收 url 非法的 http 记录并点名原因', p2.kept.length === 0 && p2.rejected.length === 1 && p2.rejected[0].id === 'g' && p2.rejected[0].message === MCP_HTTP_URL_REJECT_MESSAGE)

  const p3 = partitionMcpServers([{ id: 'h', name: '没地址', command: '', transport: 'http' }])
  ok('partition 拒收缺 url 的 http 记录', p3.kept.length === 0 && p3.rejected.length === 1 && p3.rejected[0].message === MCP_HTTP_URL_REJECT_MESSAGE)

  const p4 = partitionMcpServers([
    { id: 'i', name: '', command: 'node x.js' },
    { id: 'j', name: '本机', command: '', launch: { bin: 'node', args: [] } },
    { id: 'k', name: '坏地址', command: '', transport: 'http', url: 'http://' }
  ])
  ok('混合整表：stdio 收、名称空与 url 坏各按自己的原因拒', p4.kept.length === 1 && p4.kept[0].id === 'j' &&
    p4.rejected.length === 2 && p4.rejected[0].id === 'i' && p4.rejected[0].message === MCP_SHAPE_REJECT_MESSAGE &&
    p4.rejected[1].id === 'k' && p4.rejected[1].message === MCP_HTTP_URL_REJECT_MESSAGE)
}

// ---------- planSpawn：http 记录不出 cmd 形状 ----------
console.log('\n[planSpawn 分流]')
{
  let threw = null
  try { mcp.planSpawn(httpServer('http://127.0.0.1:9/mcp')) } catch (e) { threw = e }
  ok('planSpawn 对 http 记录抛错（绝不编出一条 spawn 计划）', !!threw && String(threw.message).includes('HTTP 传输'))
  // 对照：stdio 记录照旧返回 argv 形状
  const plan = mcp.planSpawn({ id: 'x', name: '本机', command: '', launch: { bin: 'node', args: ['a.js'] } })
  ok('planSpawn 对 stdio 记录照旧（file/args，不经 cmd）', plan.file === 'node' && Array.isArray(plan.args) && plan.comspec === false)
}

// ---------- JSON 响应形状 + probe 回执 ----------
console.log('\n[HTTP 客户端：JSON 响应]')
const jSrv = await startHttpMcp()
try {
  const rec = httpServer(jSrv.url)
  const probe = await mcp.probeServer(rec)
  ok('probeServer（JSON）：连接成功、拿到 3 个工具', probe.ok === true && probe.tools?.length === 3)
  ok('probeServer（JSON）：回执带 display，指向 origin', typeof probe.display === 'string' && probe.display.includes('远程 HTTP server') && probe.display.includes(jSrv.origin))

  const { client } = await mcp.McpClient.connect(rec)
  try {
    const r1 = await client.callTool('echo', { text: '你好' })
    ok('tools/call echo（JSON）：结果原样返回', r1.ok === true && r1.output.includes('echo:你好'))

    const r2 = await client.callTool('no_schema', {})
    ok('tools/call 无 schema 的工具照常调用', r2.ok === true && r2.output.includes('ok-no-schema'))

    const r3 = await client.callTool('boom', {})
    ok('tools/call isError 如实透出（ok:false + 原文）', r3.ok === false && r3.output.includes('这个工具故意失败'))

    let e1 = null
    try { await client.callTool('nope', {}) } catch (e) { e1 = e }
    ok('未知工具的 JSON-RPC error 中文透出且保留原文', !!e1 && String(e1.message).includes('未知工具 nope'))

    let e2 = null
    try { await client.callTool('__httpfail', {}) } catch (e) { e2 = e }
    ok('HTTP 500 如实透出（状态码 + 截断响应体）', !!e2 && String(e2.message).includes('HTTP 500') && String(e2.message).includes('mock server 内部错误'))

    const initd = jSrv.state.log.find((l) => l.body.includes('notifications/initialized'))
    ok('initialize 后发送 notifications/initialized', !!initd)
  } finally { client.close() }

  const bad = await mcp.probeServer(httpServer('not a url', 'bad-url'))
  ok('probeServer 对非法 URL 如实报错（不炸整套）', bad.ok === false && String(bad.message).includes('http(s) URL'))

  let e3 = null
  try { await mcp.McpClient.connect(httpServer('ftp://nope', 'bad-url2')) } catch (e) { e3 = e }
  ok('connect 对非法 URL 在使用点再拦一次', !!e3 && String(e3.message).includes('http(s) URL'))
} finally { await jSrv.close() }

// ---------- SSE 响应形状 ----------
console.log('\n[HTTP 客户端：SSE 响应]')
const sSrv = await startHttpMcp({ sse: true })
try {
  const { client, info } = await mcp.McpClient.connect(httpServer(sSrv.url, 'sse-mock'))
  try {
    ok('initialize（SSE）：跳过非 JSON 行与 decoy id，拿到 serverInfo', info.title === 'Mock HTTP MCP' && info.version === '1.0')
    const tools = await client.listTools()
    ok('tools/list（SSE）：解析 tools 数组', tools.length === 3 && tools[0].name === 'echo')
    const r = await client.callTool('echo', { text: 'sse' })
    ok('tools/call（SSE）：流式响应收到结果', r.ok === true && r.output.includes('echo:sse'))
  } finally { client.close() }
} finally { await sSrv.close() }

// ---------- session-id 透传 + close 发 DELETE ----------
console.log('\n[会话与关闭]')
const sessSrv = await startHttpMcp({ session: true })
try {
  const { client } = await mcp.McpClient.connect(httpServer(sessSrv.url, 'sess-mock'))
  const tools = await client.listTools()
  const afterInit = sessSrv.state.log.filter((l) => JSON.parse(l.body).method !== 'initialize')
  ok('initialize 拿到 session 后，后续请求都带上 mcp-session-id', tools.length === 3 && afterInit.length >= 1 && afterInit.every((l) => l.sid.length > 0))
  await client.callTool('echo', { text: 'sess' })
  client.close()
  await sleep(150) // DELETE 是 best-effort 异步发出的，等它落账
  // DELETE 的 session-id 要等于 server 发出去的那个（initialize 请求本身没带 sid，不能拿它比）
  const del = sessSrv.state.log.find((l) => l.method === 'DELETE')
  ok('close() 对有会话的连接发送 DELETE 且带同一个 session-id',
    !!del && del.sid === sessSrv.state.sid && sessSrv.state.deleted === true)
} finally { await sessSrv.close() }

// ---------- 取消与超时如实 ----------
console.log('\n[取消与超时]')
{
  const hSrv = await startHttpMcp()
  try {
    const { client } = await mcp.McpClient.connect(httpServer(hSrv.url, 'hang-mock'))
    // 先挂起调用、再 close：顺序反了 await 会一直等到 120s 空闲超时（那不是本用例要测的路径）
    const t0 = Date.now()
    const pending = client.callTool('sleep', {}).catch((e) => e)
    await sleep(300)
    client.close()
    const err = await pending
    const dt = Date.now() - t0
    ok('close() 中止在途 tools/call（秒级返回，话说是连接已关闭）', err instanceof Error && String(err.message).includes('连接已关闭') && dt < 3000)
  } finally { await hSrv.close() }

  const hang = await startHttpMcp({ hang: true })
  try {
    const probe = await mcp.probeServer(httpServer(hang.url, 'timeout-mock'))
    ok('initialize 超时（15s）如实报错且带时长', probe.ok === false && String(probe.message).includes('超时') && String(probe.message).includes('15'))
  } finally { await hang.close() }
}

// ---------- 信任回执的"实际执行对象" ----------
console.log('\n[信任回执]')
{
  ok('trustCommand（http）：显示数据与工具调用的去向（origin）', (() => {
    const s = mcp.trustCommand(httpServer('http://127.0.0.1:12345/mcp', 't1'))
    return s.includes('远程 HTTP server') && s.includes('http://127.0.0.1:12345')
  })())
  ok('trustCommand（stdio）：argv JSON 形态与旧口径逐字相同', (() => {
    const s = mcp.trustCommand({ id: 't2', name: '本机', command: '', launch: { bin: 'C:\\Program Files\\node.exe', args: ['a.js', 'b c'] } })
    return s === JSON.stringify(['C:\\Program Files\\node.exe', 'a.js', 'b c'])
  })())
  ok('trustCommand（旧单命令）：原文 + 已停用标注不变', (() => {
    const s = mcp.trustCommand({ id: 't3', name: '旧', command: 'node x.js', legacyInvalid: true })
    return s === 'node x.js（已停用，v0.4.0 不再用旧单命令启动）'
  })())
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
