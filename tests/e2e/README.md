# 本地 E2E（CDP 驱动便携版）

针对已同步的便携版做端到端验证：启动真实 exe → DevTools 协议驱动界面 → 断言核心链路。

## 前置

1. 已构建并同步便携版：`npm run build` → `npm run pack:portable` → 将 `release/AgentHub-win-x64` 同步到目标目录（默认 `d:\AgentHub`）
2. 目标便携版未在运行（脚本会以调试端口拉起新实例并强杀）
3. 注意：与应用正常使用共用 `%APPDATA%\agenthub` 数据；用例会新建/删除会话

## 运行

```powershell
npm run test:e2e                      # 默认 d:\AgentHub\AgentHub.exe，端口 9223
node tests/e2e/local.mjs --exe=<便携版exe路径> --port=9224
```

## 覆盖用例

- 启动序列：欢迎页 → 品牌 → 工作站，debug hooks 可用
- 演示 Agent 选中 → 发送消息（React 受控输入注入）→ 流式演示回复完成
- 多会话：新建（标题"新会话"/消息 0）→ 独立草稿 → 首条消息自动命名 → 切换恢复旧会话 → 重命名 → 删除（会话数 -1）
- 设置 → 关于：检查更新按钮、开机自启开关存在

## 断言通道

通过 `window.__ahub_debug.state()`（见 `src/renderer/src/lib/debug.ts`）读取真实 store 状态（含 sessions 摘要），不 mock。

## 诚实说明

- 更新检查的"发现新版本"分支需远端存在更高版本，脚本仅断言入口存在（网络请求真实发生，结果受 GitHub 可达性影响）
- E2E 不在 CI 中运行（CI 仅 typecheck + build）
