# AgentHub

多 Agent 工作台与工作流协作桌面应用（Windows 优先）。

![welcome](docs/screenshots/01-welcome.png)

## 下载即用（免安装）

从 [Releases](https://github.com/mihayoufamily/agenthub/releases/latest) 下载 zip → 解压到任意目录 → 双击 `AgentHub.exe`。

- 本地数据保存在 `%APPDATA%\agenthub\`，删除该目录即可彻底清除
- 首次使用建议：添加 Agent → 演示 Agent，无需任何配置即可体验完整流程
- 应用内会自动检查新版本（GitHub Releases，3 天一次），发现新版顶部提示，前往 Releases 手动下载

## 这是什么

AgentHub 提供两种工作方式：

- **工作台模式**：在同一个应用里自由切换多个 Agent，每个 Agent 保留自己的会话、输入草稿与运行状态；支持拖拽排序、Shift+滚轮切换、Agent 间交接、每 Agent 多会话（新建/切换/重命名/删除，草稿随会话保留）。
- **工作流模式**：规划 Agent → 执行 Agent → 审核 Agent 依次协作，未通过审核则返工（默认最多 3 轮，可配置），支持自动审核与人工确认两种方式，完成后输出交付卡片。

视觉与交互对标 Codex / WorkBuddy / DSH / 豆包 / Tabbit 的产品形态（仅界面与交互，不涉及模型能力，不使用任何第三方品牌素材）。

## 快速开始（源码运行）

```bash
npm install          # 国内网络可用：npm install --registry=https://registry.npmmirror.com
npm run dev          # 构建并启动桌面应用
```

要求：Node.js ≥ 18，Windows 10/11（已在 Windows 上实际验证）。

## 打包

```bash
npm run pack:portable   # 生成免安装便携目录 release/AgentHub-win-x64/（本机已验证）
npm run dist            # 生成 NSIS 安装包（需要环境能运行 electron-builder 的 app-builder，见下述已知限制）
```

## 功能状态（如实声明）

### 已实现并验证 ✅

- 开屏动画时间线（黑底 → Logo → 奶白过渡 → 开始按钮），支持 Esc 跳过与"减少动态效果"
- 每次启动播放完整欢迎流程，点击"开始"进入品牌首页（"今天要构建什么"），工作模式自选；运行中任务在后台恢复，进入工作流可见
- 品牌首页：多行输入（自适应增高）、Enter/Shift+Enter 发送（可配置）、中文输入法安全（组合中不误发）、文本附件（白名单类型 ≤64KB，内容随真实调用发送；演示 Agent 仅展示引用）、草稿持久化
- 工作台：侧栏 Agent 列表（状态点/未读提示/演示徽章）、管理顺序窗口（拖拽 + 上下移 + 持久化）、移除时区分"移除连接"与"删除历史"、Shift+滚轮节流切换（边界停止）、交给其他 Agent（带预览）、单 Agent 聊天记录导出（Markdown）
- 多会话：每 Agent 独立会话列表（新建/切换/重命名/删除）、草稿随会话保留、首条消息自动命名、活跃会话持久化（重启恢复）、旧单会话数据自动迁移
- 工作流：三角色配置条（悬停 200ms 预览浮层 + 点击固定面板）、任务状态机、规划/执行/审核卡片（流式输出、可折叠过程区、完成后自动折叠且不打断阅读）、人工确认门（通过并交付 / 填意见返工 / 停止）、返工上限（保留成果等待决定）、超时停止、补充要求下一轮生效
- 工作流真实引擎：三角色为自定义模型 Agent 时经 OpenAI 兼容接口**真实流式调用**（角色提示词注入、结构化验收清单输出、解析失败降级纯文本并转人工确认）；审核无法逐项判定时不放行也不盲目返工；演示 Agent 参与的角色逐卡标注"演示"，绝不把脚本内容包装成真实执行
- 交付卡片：完成内容、验收对照、产物列表、导出任务记录（真实写盘）、继续修改（沿用上一任务执行/审核上下文）、新建任务
- 模式切换：运行中任务弹红色警告（图标 + 文字 + 默认焦点在安全项）
- 设置六分区：外观 / Agent 与模型 / 工作流 / 快捷键 / 数据 / 关于
- 项目长期记忆（与任务记录分离，可查看/修改/删除）
- 数据持久化：配置带版本号 + 迁移、会话与任务记录独立 JSON、API Key 用系统安全凭据存储（safeStorage 加密）、配置导出不含任何秘密
- Agent 扫描：仅查 PATH 上的常见 CLI，不读任何软件配置/密钥；发现 ≠ 接入（如实标注）
- 模型 API（OpenAI 兼容）：真实连接测试 + 流式对话 + 取消；无 Key 时如实报错
- 本地 CLI Agent 执行适配器（统一 `CliTarget`：真 exe + 前置参数 + 环境变量，非 PATH 安装按"已知位置 + 盘符浅扫描"定位；spawn 不经 shell、stdin 关闭）：
  - **arkcli 本机实测**：`+chat` 流式 NDJSON、真实推理、取消、用量统计
  - **Codex CLI 本机实测**：`exec --json` JSONL；支持应用安装形态 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`；上游错误（如 429）如实透出
  - **CodeBuddy Code 本机实测**：官方 npm 包 `@tencent-ai/codebuddy-code` 优先，WorkBuddy 内置 lite 版兜底；`-p --output-format stream-json`；未登录时原样返回 `Authentication required`
  - **DeepSeek Harness headless 本机实测**：`dsh headless`（纯文本、非流式）；缺模型凭据时原样返回 `MISSING_CREDENTIAL`
  - **claude 未实测**：按官方 CLI 规范实现，未安装时如实报错
  - 共同点：凭据全部由 CLI 自身管理，本应用不读取任何密钥；支持 Agent 级工作目录边界
- CLI 工具事件透传：CodeBuddy/Claude 的 tool_use/tool_result、codex 的命令执行与文件变更实时进入执行卡片（单聊与工作流，产物可登记）；按角色区分的调用超时（规划 3 分钟/审核 5 分钟/执行 10 分钟，超时保留已产出）与 90 秒无输出心跳提示
- 模型 Agent 思考模型支持（DeepSeek/方舟等）：reasoning_content 采集、折叠展示、多轮按官方协议传回（含工具循环）
- 错误信息中文化：限流/未登录/缺凭据/权限拒绝/认证失败等常见错误映射为人话提示 + 原文折叠
- 工作流三角色同源警示：审核方与执行方同源时在确认门与交付卡片黄字提示（不阻止）
- 应用内更新检查（GitHub Releases 比对版本，手动下载模式，不自动安装）与开机自启开关（设置 → 关于）
- 应用图标与打包资源：Logo 同源 ico（256/48/32/16），NSIS 与便携版均已接入
- 本地 E2E（`npm run test:e2e`，CDP 驱动便携版）：启动序列/演示对话/多会话/设置入口断言（见 tests/e2e/README.md）
- 演示模式：无任何真实 Agent/Key 可跑通全流程（含一次返工与人工确认），全程清晰标注"演示"

### 演示模式边界 ⚠️

演示 Agent 的回复、工具事件、产物均为脚本化内容，**不是真实模型输出**，产物不写盘，界面全程带"演示"徽章，绝不包装成真实执行。

### 未实现 / 已知限制 ❌

- **claude CLI 适配器未实测**：适配层已按官方 CLI 规范实现（见 docs/AGENT_ADAPTERS.md），但本机未安装，无法端到端验证；arkcli / codex / codebuddy / dsh 四个适配器均已本机实测
- **CodeBuddy CLI 需先登录**：装官方 CLI（`npm i -g @tencent-ai/codebuddy-code`）后在终端执行 `codebuddy` → `/login`（或设 `CODEBUDDY_API_KEY`）。WorkBuddy 内置的 lite 版**没有交互模式**，无法在其中登录，但它与官方 CLI 共享 `~/.codebuddy` 凭据，登录后同样可用
- **DSH headless 需模型凭据**：`dsh headless` 走 DeepSeek Harness 的凭据服务，启动环境里需要有 `DEEPSEEK_API_KEY`（或在 DSH 的 web profile Models 页写入），否则返回 `MISSING_CREDENTIAL`；且它的输出是纯文本非流式，卡片内容在任务结束时一次性出现
- **electron-builder 打包**：依赖其内置的 Go 二进制（app-builder）；在本项目开发机上 Go 二进制被系统安全策略拦截，故本机验证走 `pack:portable`（纯 JS）。在正常机器上 `npm run dist` 可用，但**未在其他机器实测**
- **Chromium 沙箱兼容开关**：部分装有大数字类安全软件的机器上，Electron 的 GPU/渲染沙箱子进程会被拦截崩溃（0xC0000005）。本应用提供 `AGENTHUB_NO_SANDBOX=1` 环境变量作为兼容模式（降低渲染进程隔离；本应用只加载本地页面，无远程内容）。正常机器无需开启
- 自动更新：仅"检查 + 提示"（发现新版本显示横幅，用户前往 Releases 手动下载），不自动下载或安装
- 平台：仅 Windows 已验证；macOS/Linux 未测试（架构上未使用 Windows 独有 API，除凭据存储走系统能力外）

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [Agent 适配器开发说明](docs/AGENT_ADAPTERS.md)
- [发布检查清单](docs/RELEASE_CHECKLIST.md)

## 许可证

MIT（见 [LICENSE](LICENSE)）。依赖清单见 package.json，均为 MIT/BSD 类许可（详见 node_modules 内各包 LICENSE）。
