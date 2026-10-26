# AgentHub 中继网关

让所有 AgentHub 用户**零配置**获得公网手机访问：下载者的 AgentHub 主动出站连到本网关（免端口/免防火墙/免域名），手机请求按配对 token 路由到对应实例。

## 架构

```
AgentHub(任意网络) ──出站 WebSocket──> 本网关 <──HTTPS── 手机浏览器
                      （按 token 路由，token→实例一一对应）
```

- 网关是**哑管道**：不解析业务、不落盘、不缓存
- 每个 token 只能触达自己的 AgentHub；同 token 后连者踢前连
- 业务逻辑（鉴权/数据裁剪/写校验）全部在 AgentHub 本地服务，网关零重复

## 自行部署（ anyone 可以架自己的网关）

```bash
# 依赖：Node >= 18（无任何 npm 依赖）
node relay/server.mjs --port 8090
# 健康检查：curl http://127.0.0.1:8090/relay-info  → {"ok":true,"online":N}
```

放到公网的最省事方式：Cloudflare Tunnel（免费、自带 HTTPS、免端口映射）——

```yaml
# ~/.cloudflared/config.yml 的 ingress 里加一条
  - hostname: gw.your-domain.com
    service: http://127.0.0.1:8090
```

```bash
cloudflared tunnel route dns <隧道名> gw.your-domain.com
```

AgentHub 端默认连接 `wss://gw.zdymodel.de5.net`（官方网关）；自架者通过prefs
`mobileService.relayUrl` 改成自己的 `wss://gw.your-domain.com`。

## 隐私边界（如实说明）

- HTTPS 覆盖公网传输段；网关按 token 路由、互相隔离
- 但网关进程**可见转发明文**（会话内容/用量数据经过它，不落盘）——自架网关即自担信任
- token 即完整访问权（看会话/发消息/审批），不要发给不信任的人；泄露后桌面端关闭再开启服务即全部作废

## 协议（v1）

- 实例 → 网关：`{"type":"hello","token":"<hex>"}`；网关回 `{"type":"hello-ok"}`
- 网关 → 实例：`{"type":"req","id","method","path","query","headers","body"}`（body 仅 POST，字符串）
- 实例 → 网关：`{"type":"resp","id","status","headers","body"}`
- 心跳：WS ping/pong 30s；手机请求 20s 超时
- 预留：payload 端到端加密（token 派生密钥）为二期项，协议字段已按对象封装可直接替换
