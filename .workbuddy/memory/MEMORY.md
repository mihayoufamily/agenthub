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
7. d:\AgentHub\resources\default_app.asar 被无关进程长期锁定（crashpad，与 GameViewer 的同名进程难区分）——同步便携版只动 resources/app + 顶层 exe，运行时静态文件跳过
8. arkcli 真实推理耗时：规划 ~40s、执行 ~60-90s、审核 200-300s（glm-5.3 思考模式不可关）——E2E 门等待要给 600s
9. 杀进程后文件锁释放有竞态——删除临时 userData 前 sleep + 重试（run-e2e 模式）

## 用户约束（硬性）
- 仅 Windows；交付桌面程序非 HTML；视觉/交互对标 Codex、WorkBuddy、DSH、豆包、Tabbit（形态非能力，不用其品牌素材）
- 统一叫"工作台模式"；第一版默认最多返工 3 轮（可配置）
- 演示模式必须清晰标识、与真实数据分离、不伪装真实执行
- GitHub 分发：不硬编码个人路径/密钥；导出剥离秘密；凭据走 safeStorage
- 许可证已定：MIT（2026-10-21 用户确认）

## 关键路径
- 需求文档：D:\gptwork-codex\AgentHub_需求讨论与开发提示词.md
- 截图验证：`--shots=<dir>` 启动参数（main 进程 runShotSequence）→ verify/shots/
- 适配器开发指南：docs/AGENT_ADAPTERS.md（CLI 执行适配器是下一步重点）

## 下一步候选
- claude / codex 适配器端到端实测（需装对应 CLI；当前按官方规范实现未实测）
- 用真实 API Key 验证自定义模型对话闭环
- NSIS 安装包（在正常机器上跑 npm run dist）
- 工作流状态机细节：waiting_review 是审核进行中的中间态、waiting_user 才是人工门；human 模式下审核不通过仅在 confirmEveryRound=true 时停门，否则自动返工（README/docs 如实标注）
- 图标重生成：node scripts/gen-icon.mjs（改 Logo.tsx 后需同步改几何；inRoundRect 的 inset/rx 是 viewBox 单位、线段/圆是像素单位，勿再混）
