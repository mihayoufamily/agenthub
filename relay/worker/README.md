# 中继网关 · Cloudflare Workers 版

自架 Node 版（`../server.mjs`）的官方托管形态：**免费、零运维、7×24**。协议一致，AgentHub 端零业务改动。

## 部署

```bash
cd relay/worker
npx wrangler login        # 浏览器授权你的 Cloudflare 账号（域名 zone 需在该账号）
npx wrangler deploy       # 自动创建 DO + 绑定 gw.zdymodel.de5.net 自定义域名
npx wrangler tail         # 观测实时流量
```

## 协议差异（相对 Node 版）

- AgentHub 连接 URL **携带 token**：`wss://gw.zdymodel.de5.net/?t=<token>`（Node 版在 hello 消息里带；Worker 版靠 URL 路由 DO，hello 仍兼容）
- 手机请求不变：`https://gw.zdymodel.de5.net/?t=<token>`，路径/参数原样转发

## 额度与限制（免费版）

- Workers：10 万请求/天；DO：SQLite 后端 + hibernatable WebSocket
- 心跳：Node 版网关有 30s ping/pong；Worker 版依赖 hibernation 不需要应用层心跳——AgentHub 的 ping（每 30s）会周期性唤醒 DO，属正常开销
- 单请求 CPU 10ms（转发场景远低于此）
