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

1. 在 `src/main/discovery.ts` 的 `KNOWN_CLIS` 中确认扫描项（只查 PATH 存在性，禁止读取其配置/密钥）。
2. 新建 `src/main/adapters/<name>.ts`，优先使用该 CLI 的官方非交互模式（如 `--output-format stream-json` 类），spawn 时 `windowsHide: true` 并做超时保护。
3. 在 `src/main/ipc.ts` 注册通道并接入 `agents.ts` 的 `sendMessage` 分支（按 `agent.kind` 分发）。
4. 能力如实声明：CLI 不支持的能力（如暂停）绝不在界面显示对应按钮。
5. 更新 README 的功能状态表。

## 工作流引擎如何消费适配器

`stores/workflow.ts` 的引擎按角色（规划/执行/审核）取配置中的 Agent，向其适配器发起请求并消费事件流。角色间会话与角色指令相互隔离——三角色允许共用同一个 Agent，但提示词与上下文按角色注入。

## 凭据规则

- API Key 一经保存即写入系统安全凭据存储（Electron safeStorage / Windows DPAPI）。
- 渲染进程只能问"有没有"（credential:has），永远拿不到明文。
- 主进程在发起真实请求时进程内解密使用；日志与导出全程脱敏。
