#!/usr/bin/env node
// 最小 MCP server（stdio，换行分隔 JSON-RPC），只用于回归验证 AgentHub 的 MCP 客户端。
// 故意做几件"真实 server 也会做"的事，专门用来打测试：
//  - 往 stdout 打一行非协议日志（客户端必须无视而不是被它打挂）
//  - tools/list 里带一个缺 inputSchema 的工具（客户端要补空对象，否则严格接口会拒）
//  - 一个 isError 的工具、一个未知方法、一个会拖到超时的工具
// 用法：node verify/mock-mcp-server.mjs
import readline from 'node:readline'

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

// 这行不是 JSON：客户端应直接丢掉
process.stdout.write('[mock-mcp] listening\n')

const TOOLS = [
  { name: 'echo', description: '把输入原样返回', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'no_schema', description: '没有声明参数结构' },
  { name: 'boom', description: '返回 isError 的工具' }
]

const rl = readline.createInterface({ input: process.stdin, terminal: false })
// 真实 MCP server 也是"stdin 关了就该退"，不加这条会留下孤儿进程
rl.on('close', () => process.exit(0))

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (id === undefined) return // 通知（notifications/initialized 等）不需要回

  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', title: 'Mock MCP', version: '1.0' } } })
    return
  }
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (name === 'echo') {
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${params?.arguments?.text ?? ''}` }] } })
      return
    }
    if (name === 'no_schema') {
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok-no-schema' }] } })
      return
    }
    if (name === 'boom') {
      write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '这个工具故意失败' }] } })
      return
    }
    if (name === 'sleep') {
      setTimeout(() => write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'too late' }] } }), 30_000)
      return
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具 ${name}` } })
    return
  }
  if (method === 'prompts/list') {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'this server has no prompts' } })
    return
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
})
