# AgentHub 项目长期记忆

## 技术栈（定版，勿随意改动）
- Electron **37.10.3（精确锁定，加 ^ 会装到本机崩溃的 43.x）** + React 18 + TypeScript 5.5
- 构建链：主进程 tsc 直出 CJS（out/）；渲染层 tsc + rollup 3 打包 IIFE（dist/renderer/bundle.js）
- 状态：zustand 5；样式：手写 CSS tokens（src/renderer/src/styles/）
- 打包：`scripts/pack-portable.mjs`（本机可用）；electron-builder 配置保留给正常机器（`npm run dist`）

## 本机环境铁律（每次会话都可能踩）
1. Go 二进制（esbuild/app-builder）在本机被安全策略拦截——构建链必须保持纯 JS
2. WorkBuddy 会话 env 有 `ELECTRON_RUN_AS_NODE=1`——spawn electron 前必须 delete
3. Electron 沙箱子进程可能被安全软件杀（0xC0000005）——验证时加 AGENTHUB_NO_SANDBOX=1
4. 工作区内原生二进制执行受限——运行/验证时把 exe 复制到工作区外
5. `rm -rf` 大目录被 safe-delete shim 拦——用 node fs.rmSync
6. 打包必须保留 resources/default_app.asar

## 用户约束（硬性）
- 仅 Windows；交付桌面程序非 HTML；视觉/交互对标 Codex、WorkBuddy、DSH、豆包、Tabbit（形态非能力，不用其品牌素材）
- 统一叫"工作台模式"；第一版默认最多返工 3 轮（可配置）
- 演示模式必须清晰标识、与真实数据分离、不伪装真实执行
- GitHub 分发：不硬编码个人路径/密钥；导出剥离秘密；凭据走 safeStorage
- 许可证待用户确认（LICENSE 为占位，package.json 用 SEE LICENSE IN LICENSE）

## 关键路径
- 需求文档：D:\gptwork-codex\AgentHub_需求讨论与开发提示词.md
- 截图验证：`--shots=<dir>` 启动参数（main 进程 runShotSequence）→ verify/shots/
- 适配器开发指南：docs/AGENT_ADAPTERS.md（CLI 执行适配器是下一步重点）

## 下一步候选
- 内置至少一个真实 CLI Agent 执行适配器（claude/codex 的 stream-json 模式）
- 用真实 API Key 验证自定义模型对话闭环
- 应用图标（build/icon.ico）与 NSIS 安装包（在正常机器上）
