// AgentHub 中继网关 · Cloudflare Workers 版（2026-10-26）
// 与 relay/server.mjs（自架 Node 版）协议完全一致：AgentHub 端零业务改动，仅连接 URL 携带 ?t=token。
//
// 路由模型：每个 token 一个 Durable Object 实例（idFromName(token) 确定性路由）——
//   AgentHub 出站 upgrade ?t=<token> → 路由到 DO(token)，WS 注册进该实例
//   手机请求      ?t=<token>        → 路由到同一个 DO(token)，找到该实例的 WS 转发
// 互相隔离：token A 的手机请求永远到不了 token B 的实例（不同的 DO）。
//
// 特性：hibernatable WebSocket（空闲休眠省额度，消息到自动唤醒）；免费额度对看板流量绰绰有余。
//
// 部署（见 relay/worker/README.md）：npx wrangler deploy；自定义域名 gw.zdymodel.de5.net 在 wrangler.toml。

export class RelayDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    /** 当前注册的 AgentHub 出站连接（同 token 后连踢前连） */
    this.hub = null
    /** 请求 id → resolve（手机请求等待 AgentHub 回包） */
    this.pending = new Map()
  }

  /** 手机页面/网关错误时的可读引导页（与 Node 版同口径） */
  guide(status, title) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>📡 ' + title + '</p><p style="opacity:.6;font-size:14px">请打开电脑端 AgentHub「手机查看」，确认服务与中继已开启后重新扫码</p></div></body>',
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
    )
  }

  async fetch(req) {
    const url = new URL(req.url)

    // ---- AgentHub 出站 WebSocket 注册 ----
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1])
      if (this.hub) { try { this.hub.close(1000, 'replaced') } catch { /* noop */ } }
      this.hub = pair[1]
      this.hub.send(JSON.stringify({ type: 'hello-ok' }))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // ---- 手机/页面请求 → 转发到本 DO 的实例 ----
    if (!this.hub) return this.guide(502, '桌面端不在线')

    const id = crypto.randomUUID()
    let body = null
    if (req.method === 'POST') {
      const b = await req.text()
      if (b.length > 256 * 1024) return new Response('too large', { status: 413 })
      body = b
    }
    const pack = {
      type: 'req', id,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
      body
    }
    const resp = await new Promise((resolve) => {
      this.pending.set(id, resolve)
      try { this.hub.send(JSON.stringify(pack)) } catch { this.pending.delete(id); resolve({ status: 502, headers: {}, body: '{"ok":false,"message":"转发失败"}' }); return }
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ status: 504, headers: {}, body: '{"ok":false,"message":"桌面端响应超时"}' }) } }, 20000)
    })
    const headers = new Headers({ 'Content-Type': resp.headers?.['content-type'] ?? 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return new Response(resp.body ?? '', { status: resp.status ?? 502, headers })
  }

  /** AgentHub 回包（hibernatable 唤醒入口） */
  async webSocketMessage(ws, message) {
    let msg
    try { msg = JSON.parse(message) } catch { return }
    if (msg.type === 'resp' && msg.id && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      resolve({ status: msg.status, headers: msg.headers, body: msg.body })
    }
  }

  async webSocketClose(ws) {
    if (this.hub === ws) this.hub = null
  }
}

export default {
  /** 手机与 AgentHub 的所有请求统一入口：按 ?t=token 确定性路由到 DO */
  async fetch(req, env) {
    const url = new URL(req.url)

    // 运维健康检查（无敏感信息）
    if (url.pathname === '/relay-info') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), note: 'agenthub relay (workers), per-token DO routing' }), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      })
    }

    const t = url.searchParams.get('t') ?? ''
    if (!t || !/^[0-9a-f]{16,64}$/.test(t)) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>📡 缺少配对凭据</p><p style="opacity:.6;font-size:14px">请回桌面端 AgentHub「手机查看」重新扫码</p></div></body>',
        { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }
      )
    }
    const doStub = env.RELAY.get(env.RELAY.idFromName(t))
    // 透传完整 URL（含 t），DO 内继续按 pathname/query 处理
    return doStub.fetch(req)
  }
}
