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
    /** 请求 id → resolve（手机请求等待 AgentHub 回包） */
    this.pending = new Map()
  }

  /**
   * 当前在线的 AgentHub 出站连接。
   * 不用内存字段存 hub：hibernatable WS 休眠唤醒后 constructor 重跑、内存清空，
   * 而桌面端的 WS 还活着——内存指针一丢，手机请求就误报"桌面端不在线"（2026-10-26 实测踩坑）。
   * state.getWebSockets(tag) 是唯一持久真相源：休眠前后都返回真实存活的连接。
   */
  get hub() {
    const sockets = this.state.getWebSockets('hub')
    return sockets.length ? sockets[sockets.length - 1] : null
  }

  /** 手机页面/网关错误时的可读引导页（与 Node 版同口径） */
  guide(status, title) {
    // 502（桌面端不在线）自动重试：桌面端心跳恢复后手机几秒内自动进入，不用手动刷新。
    // 上限 40 次（约 2 分钟）后停止，显示终态引导——避免桌面端真关了时无限刷新耗电。
    const retry =
      status === 502
        ? '<script>try{var n=(+sessionStorage.ahR||0)+1;sessionStorage.ahR=n;if(n<40){setTimeout(function(){location.reload()},3000)}else{var h=document.querySelector(".hint");if(h)h.textContent="桌面端仍未上线：请到电脑端 AgentHub「手机查看」确认服务与中继开关都开着（或点「检测连通性」看原因）"}}catch(e){setTimeout(function(){location.reload()},3000)}</script>'
        : ''
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>📡 ' +
        title +
        '</p><p class="hint" style="opacity:.6;font-size:14px">请打开电脑端 AgentHub「手机查看」，确认服务与中继已开启后重新扫码</p></div>' +
        retry +
        '</body>',
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
    )
  }

  async fetch(req) {
    const url = new URL(req.url)

    // ---- AgentHub 出站 WebSocket 注册 ----
    if (req.headers.get('Upgrade') === 'websocket') {
      // 同 token 后连踢前连（重开应用/重连场景，最新连接为准）
      for (const old of this.state.getWebSockets('hub')) {
        try { old.close(1000, 'replaced') } catch { /* noop */ }
      }
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], ['hub'])
      pair[1].send(JSON.stringify({ type: 'hello-ok' }))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // ---- 手机/页面请求 → 转发到本 DO 的实例 ----
    const hub = this.hub
    if (!hub) {
      // 兜底自愈：网关升级部署后，旧代码注册的连接没带 'hub' tag，getWebSockets('hub') 永远查不到——
      // 客户端那边还"假在线"（尤其旧版没有心跳）。主动掐掉孤儿连接，客户端自动重连并按新代码注册，
      // 否则老客户端会一直卡在"已连接"假象里，手机端永远 502。
      for (const orphan of this.state.getWebSockets()) {
        try { orphan.close(4001, 're-register') } catch { /* noop */ }
      }
      return this.guide(502, '桌面端不在线')
    }

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
      try { hub.send(JSON.stringify(pack)) } catch { this.pending.delete(id); resolve({ status: 502, headers: {}, body: '{"ok":false,"message":"转发失败"}' }); return }
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ status: 504, headers: {}, body: '{"ok":false,"message":"桌面端响应超时"}' }) } }, 20000)
    })
    const headers = new Headers({ 'Content-Type': resp.headers?.['content-type'] ?? 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return new Response(resp.body ?? '', { status: resp.status ?? 502, headers })
  }

  /** AgentHub 回包（hibernatable 唤醒入口） */
  async webSocketMessage(ws, message) {
    // hello 兼容（与 Node 版同协议）：桌面端重连重注册时回确认
    if (typeof message === 'string' && message.includes('"type":"hello"')) {
      try { ws.send(JSON.stringify({ type: 'hello-ok' })) } catch { /* noop */ }
      return
    }
    let msg
    try { msg = JSON.parse(message) } catch { return }
    if (msg.type === 'resp' && msg.id && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      resolve({ status: msg.status, headers: msg.headers, body: msg.body })
    }
  }

  async webSocketClose(ws) {
    // 连接真断了：挂起的手机请求立刻 502 收口，别让用户干等 20s 超时
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id)
      resolve({ status: 502, headers: {}, body: '{"ok":false,"message":"桌面端连接已断开"}' })
    }
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

    // 隧道诊断：从 Cloudflare 内部探测隧道域名可达性（绕开访问侧网络变量，判定 1033 出在哪一层）
    if (url.pathname === '/debug-tunnel') {
      const target = url.searchParams.get('host') ?? 'mobile.zdymodel.de5.net'
      if (!/^[a-z0-9.-]+$/i.test(target)) return new Response('bad host', { status: 400 })
      const t0 = Date.now()
      try {
        const r = await fetch(`https://${target}/`, { signal: AbortSignal.timeout(12000), redirect: 'manual' })
        return new Response(JSON.stringify({ ok: true, status: r.status, ms: Date.now() - t0, note: 'CF 内部可达隧道域名' }), {
          headers: { 'content-type': 'application/json; charset=utf-8' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String(e).slice(0, 200), note: 'CF 内部也不可达 → 隧道路由/边缘问题，与访问侧网络无关' }), {
          status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
        })
      }
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
