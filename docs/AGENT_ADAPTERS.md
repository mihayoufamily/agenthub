# Agent 适配器开发说明

## 两种接入方式的边界（规格 §10）

| 方式 | 含义 | AgentHub 职责 |
|---|---|---|
| 接入现成 Agent | 使用该 Agent 自身开放的执行能力（API/SDK/CLI/协议） | 只做发现、连接、会话与事件转发 |
| 接入模型 API | 只有文本能力的模型接口 | AgentHub 提供工具调用、任务循环与运行环境 |

**红线：不得把只会返回文本的模型接口伪装成能执行系统任务的 Agent。**
界面只开放适配层真实声明的能力。

## 适配器接口（当前形态）

主进程适配器位于 `src/main/adapters/`。现有实现：

- `openai.ts` — OpenAI 兼容接口（`/models` 连接测试、`/chat/completions` SSE 流式、取消、用量尽力解析）。能力声明：仅文本对话，无工具执行、无审批。
- `cli.ts` — 本机 CLI Agent 执行适配器（统一 `CliSpec`：启动目标解析 / `--version` 本地测试 / 参数构造 / 事件解析）。启动目标 `CliTarget` 把"真 exe + 前置参数 + 环境变量"一起描述出来，因此 npm `.cmd` shim、Electron-as-node 启动器、Node 脚本入口都能安全 spawn（不经 shell、stdin 一律 ignore）：
  - **arkcli**（本机实测）：`+chat --stream --include-events`，消费 `response_output_text_delta`（增量正文）与 `response_completed`（用量）；exe 解析顺序为 npm 包内原生 exe → PATH 上的 `.exe`。
  - **codex**（本机实测）：`exec --json --skip-git-repo-check`，消费 `item.completed`（`agent_message`）/`turn.completed`（用量）/`error`/`turn.failed`。定位顺序：PATH → `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（应用安装形态，按子目录逐个探测，不假定只有一个版本）→ `.cargo\bin` → npm 包内。
  - **codebuddy**（本机实测）：CodeBuddy Code CLI，`-p --output-format stream-json`，事件形状与 claude 同构（`system/init`、`assistant`、`result`；`assistant.content[]` 里只取 `type === 'text'`，`thinking` 块忽略）。定位顺序：官方 npm 全局安装 `<npm 全局根>\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`（无扩展名的 node 启动器，必须用 node 执行）→ WorkBuddy 内置 `resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs` → 盘符浅扫描。**注意：WorkBuddy 内置的 lite 版没有交互模式**（无参数运行直接退出、`--serve` 的 Web UI 未打包），无法在其中执行 `/login`；需装官方 CLI 登录一次，两者共享 `~/.codebuddy` 凭据。未登录时 CLI 自己返回 `Authentication required`，本层原样透出。
  - **dsh**（本机实测）：DeepSeek Harness 的 `headless` 模式（一次性任务、打印结果、退出），`format: 'text'` 纯文本非流式。启动目标由 `dsh.cmd` 反解得出（Electron exe + `--expose-internals <cli.js>` + `ELECTRON_RUN_AS_NODE=1`）；`cli.js` 位于 asar 内，普通 fs 无法 stat，故只校验 exe。缺模型凭据时 CLI 返回 `MISSING_CREDENTIAL`，原样透出。
  - **claude**（未实测）：`-p --output-format stream-json`；未安装时连接测试如实报错。
  - 非 PATH 安装的统一兜底：已知安装位置 → 各固定盘符根下的一级目录浅扫描（只在 `existsSync` 级别探测，不递归整盘、不读任何配置文件）。
  - 能力声明：stream / cancel / usage 真实；tools / approval 不声明（界面不显示对应控件）。
  - 模型清单（`listModels`，IPC 通道 `cli:models`）：能枚举的 CLI 由主进程给出列表——**codebuddy** 解析 `--help` 里的 `Currently supported: (...)`（该列表随账号变化，登录前后不同，因此绝不硬编码）；**codex** 先问 `config.toml` 里 `base_url` 指向的 `/models`（中转站/代理的真实清单会变，本地 catalog 可能是旧的），问不到再退回 `model_catalog_json` 文件并把当前 `model` 排最前；**arkcli / dsh** 不可枚举，如实返回说明，界面回退到手填。渲染层用 `components/CliModels.tsx` 统一渲染（点选回填输入框）。

每个适配器需要实现（建议抽取为统一接口，v2 工作）：

```ts
interface AgentAdapter {
  id: string
  capabilities: {
    stream: boolean        // 流式事件
    tools: boolean         // 工具调用事件
    approval: boolean      // 操作审批
    cancel: boolean        // 取消
    usage: boolean         // 用量
    models: string[]       // 可选模型
  }
  testConnection(cfg: CustomModelConfig, key: string): Promise<ModelTestResult>
  chat(cfg, reqId, messages, onEvent): void   // onEvent: delta | done | error | usage | tool | approval
  cancel(reqId: string): void
}
```

## 添加一个 CLI 型 Agent 适配器的步骤

1. 在 `src/main/adapters/cli.ts` 加一个 `CliSpec`：实现 `resolveTarget()`（优先 `where`，再按"已知安装位置 → 盘符浅扫描"兜底），并在 `src/main/discovery.ts` 的 `SUPPORTED` 中登记（扫描会直接复用适配层的定位结果，因此非 PATH 安装也能被发现；禁止读取其配置/密钥）。
2. 在 `CliSpec` 中优先使用该 CLI 的官方非交互模式（如 `--output-format stream-json` 类）；spawn 时 `windowsHide: true`、`stdio: ['ignore','pipe','pipe']` 并做超时保护；需要 Node/Electron 启动器的用 `CliTarget.prefixArgs` + `env` 表达，不要走 shell。
3. 在 `src/shared/types.ts` 的 `CliName` 与渲染层 `CLI_META` 中补登记；`CliCandidates` 里补条目（含安装/认证说明与实测状态徽章）。
4. 在 `src/main/ipc.ts` 注册通道并接入 `agents.ts` 的 `sendMessage` 分支（按 `agent.kind` 分发）。
5. 能力如实声明：CLI 不支持的能力（如暂停）绝不在界面显示对应按钮。
6. 更新 README 的功能状态表，以及 `verify/cli-adapter-check.mjs` 的诊断清单。

## 工作流引擎如何消费适配器

`stores/workflow.ts` 的引擎按角色（规划/执行/审核）取配置中的 Agent，向其适配器发起请求并消费事件流。角色间会话与角色指令相互隔离——三角色允许共用同一个 Agent，但提示词与上下文按角色注入。

## 凭据规则

- API Key 一经保存即写入系统安全凭据存储（Electron safeStorage / Windows DPAPI）。
- 渲染进程只能问"有没有"（credential:has），永远拿不到明文。
- 主进程在发起真实请求时进程内解密使用；日志与导出全程脱敏。
