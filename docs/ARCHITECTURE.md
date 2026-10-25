# AgentHub 架构说明

## 进程模型

```
┌─────────────────────────────────────────────────┐
│ Electron Main（src/main/）                       │
│  ├─ index.ts    窗口生命周期、窗口状态持久化、     │
│  │              加载失败重试页、截图验证序列       │
│  ├─ store.ts    JSON 持久化（版本号 + 迁移）、    │
│  │              safeStorage 凭据加密              │
│  ├─ ipc.ts      全部 IPC 通道（allowlist 注册）   │
│  ├─ discovery.ts  本机 Agent CLI 扫描（PATH + 已知安装位置     │
│  │              + 盘符浅扫描；只定位不执行，不读 CLI 配置）│
│  └─ adapters/openai.ts  OpenAI 兼容流式适配器     │
├─────────────────────────────────────────────────┤
│ Preload（src/preload/）                          │
│  contextBridge 暴露类型化 API `window.agenthub`   │
│  API Key 只进不出（保存后渲染层拿不到明文）        │
├─────────────────────────────────────────────────┤
│ Renderer（src/renderer/，React 18 + Zustand）    │
│  ├─ stores/   ui(导航/Toast) · agents · sessions │
│  │            · workflow(任务引擎) · settings     │
│  ├─ lib/      ipc 封装 · demo 引擎 · debug 钩子   │
│  ├─ components/ 设计组件（Modal 焦点管理/Toast…）  │
│  └─ features/ Splash · BrandHome · Workbench ·   │
│               WorkflowHome · TaskView · Settings │
└─────────────────────────────────────────────────┘
```

## 状态分离原则（规格 §21）

- **页面/动画状态**（ui store：screen、splashStage、Toast、弹窗开关）与
  **任务执行状态**（workflow/sessions store：run、cards、流式缓冲）完全解耦。
- 任务提交只有单一入口 `workflow.start()`，内部 `_started` 标志防重复提交；
  界面重绘、窗口缩放、屏幕切换不会触发任何任务事件。
- 任务状态机：`not_started → preparing → running → waiting_review → (waiting_user) →
  completed | failed | cancelled | rework_limit | interrupted`。暂停仅在底层真实支持时
  才会出现（当前版本的演示引擎显示"停止"而非假暂停）。

## 数据与凭据

| 内容 | 位置 | 说明 |
|---|---|---|
| 配置（偏好/Agent/工作流默认） | `%APPDATA%/agenthub/config.json` | schemaVersion + 迁移链 |
| 会话 | `%APPDATA%/agenthub/sessions/<agentId>.json` | 独立文件，删文件即彻底删除 |
| 任务记录 | `%APPDATA%/agenthub/runs/<runId>.json` | 重启后恢复展示；运行中→interrupted，不盲目重放 |
| 长期记忆 | `%APPDATA%/agenthub/memory.json` | 区分项目记忆与任务记录 |
| API Key | `%APPDATA%/agenthub/credentials.enc` | safeStorage（Windows DPAPI）加密 |
| 日志 | `%APPDATA%/agenthub/logs/main.log` | 只记事件不记秘密 |

配置导出剥离全部秘密；导入后 API Key 置空、连接状态重置，需重新授权。

## 演示模式

- 演示内容生成集中在 `src/renderer/src/lib/demo.ts`，产出的每条消息/事件/卡片都带 `demo: true`。
- 演示数据与真实数据共用存储结构但字段可区分；界面用徽章持续标识。
- 工作流引擎（stores/workflow.ts）对演示与真实模型走同一套状态机，只是事件源不同。

## 构建链

- 主进程/preload：`tsc` 直出 CJS 到 `out/`（运行时只依赖 electron 内置模块，无三方运行时依赖）
- 渲染进程：`tsc → .tmp`，`rollup 3`（纯 JS）打包为单文件 IIFE `dist/renderer/bundle.js`
- 选择 rollup 而非 vite/esbuild 的原因：esbuild 为 Go 二进制，在部分受控环境被安全策略拦截；
  rollup 3 全纯 JS，任何环境可构建。vite 同理被排除。
- 启动器 `scripts/dev.mjs`：构建 → 探测可用的 electron.exe（工作区内受限时自动镜像到
  %TEMP%）→ 剥离 `ELECTRON_RUN_AS_NODE` → 启动。

## 截图验证（规格 §23）

`--shots=<目录>` 启动参数触发验证序列：驱动 欢迎页 → 品牌首页 → 工作台 → 工作流首页 →
演示任务（规划/执行/审核/返工/确认门）→ 交付，逐张 capturePage 存 PNG，并把每一步的
真实状态（screen/run.status/round/cards）写入 `<目录>/log.txt`。产物见 `verify/shots/`。
