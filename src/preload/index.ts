import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig, AgentSession, WorkflowRun, MemoryEntry, CustomModelConfig,
  ModelTestResult, ScanResultItem, AppInfo, AgentConfig, CliName, ToolGrant, ToolCall
} from '../shared/types'

/**
 * 渲染进程唯一桥。所有通道在 main/ipc.ts 中以 allowlist 方式注册。
 * API Key 一经保存即进入系统凭据存储，渲染进程不再回读明文。
 */
const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    relaunch: () => ipcRenderer.invoke('app:relaunch')
  },
  update: {
    /** 版本检查（manual=true 不受 3 天节流，用于设置页按钮） */
    check: (manual: boolean) => ipcRenderer.invoke('update:check', manual) as Promise<{
      current: string; hasUpdate: boolean; latest?: string; releaseUrl?: string; error?: string
    }>
  },
  autostart: {
    get: () => ipcRenderer.invoke('autostart:get') as Promise<boolean>,
    set: (on: boolean) => ipcRenderer.invoke('autostart:set', on) as Promise<boolean>
  },
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    setPrefs: (prefs: AppConfig['prefs']) => ipcRenderer.invoke('prefs:set', prefs),
    setAgents: (agents: AgentConfig[]) => ipcRenderer.invoke('agents:set', agents),
    setWorkflowDefaults: (wd: AppConfig['workflowDefaults']) => ipcRenderer.invoke('workflowDefaults:set', wd),
    exportFile: () => ipcRenderer.invoke('config:export'),
    importFile: () => ipcRenderer.invoke('config:import')
  },
  credentials: {
    save: (keyId: string, secret: string) => ipcRenderer.invoke('credential:save', keyId, secret),
    has: (keyId: string) => ipcRenderer.invoke('credential:has', keyId) as Promise<boolean>,
    delete: (keyId: string) => ipcRenderer.invoke('credential:delete', keyId)
  },
  sessions: {
    /** 保存该 Agent 的全部会话（v2 多会话；activeId 为当前活跃会话） */
    save: (agentId: string, sessions: AgentSession[], activeId?: string) =>
      ipcRenderer.invoke('session:save', agentId, sessions, activeId),
    load: (agentId: string) =>
      ipcRenderer.invoke('session:load', agentId) as Promise<{ sessions: AgentSession[]; activeId?: string } | null>,
    remove: (agentId: string, deleteHistory: boolean) => ipcRenderer.invoke('session:remove', agentId, deleteHistory)
  },
  runs: {
    save: (r: WorkflowRun) => ipcRenderer.invoke('run:save', r),
    list: () => ipcRenderer.invoke('run:list') as Promise<WorkflowRun[]>,
    remove: (id: string) => ipcRenderer.invoke('run:remove', id)
  },
  memory: {
    get: () => ipcRenderer.invoke('memory:get') as Promise<MemoryEntry[]>,
    set: (entries: MemoryEntry[]) => ipcRenderer.invoke('memory:set', entries)
  },
  agents: {
    scan: () => ipcRenderer.invoke('agents:scan') as Promise<ScanResultItem[]>,
    checkPath: (p: string) => ipcRenderer.invoke('agents:checkPath', p) as Promise<boolean>
  },
  cli: {
    /** 本地连接测试（解析 exe + 版本命令，不联网） */
    test: (name: CliName) => ipcRenderer.invoke('cli:test', name) as Promise<{ ok: boolean; message: string; version?: string; exePath?: string }>,
    /** 可枚举的模型清单（不可枚举时 ok=false，界面回退到手填） */
    models: (name: CliName) => ipcRenderer.invoke('cli:models', name) as Promise<{ ok: boolean; models?: string[]; message?: string; source?: string }>,
    chat: (name: CliName, opts: { model?: string; exePath?: string; workDir?: string; timeoutMs?: number }, reqId: string, messages: { role: string; content: string; reasoning_content?: string }[]) =>
      ipcRenderer.invoke('cli:chat', name, opts, reqId, messages) as Promise<{ ok: boolean; message?: string }>,
    cancel: (reqId: string) => ipcRenderer.invoke('cli:cancel', reqId),
    /** 流式事件与 models 共用 model:event 通道（reqId 路由） */
    onEvent: (cb: (e: { reqId: string; type: string; text?: string; message?: string; usage?: { tokens?: number } }) => void) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('model:event', handler)
      return () => ipcRenderer.removeListener('model:event', handler)
    }
  },
  models: {
    test: (cfg: CustomModelConfig, apiKey: string) => ipcRenderer.invoke('model:test', cfg, apiKey) as Promise<ModelTestResult>,
    /** 列出接口真实可用的模型（切换模型用；凭据在主进程取，渲染层不经手） */
    list: (cfg: CustomModelConfig) => ipcRenderer.invoke('model:list', cfg) as Promise<{ ok: boolean; models?: string[]; message?: string }>,
    chat: (cfg: CustomModelConfig, reqId: string, messages: { role: string; content: string; reasoning_content?: string }[], opts?: { tools?: ToolGrant }) =>
      ipcRenderer.invoke('model:chat', cfg, reqId, messages, opts),
    cancel: (reqId: string) => ipcRenderer.invoke('model:cancel', reqId),
    /** 订阅流式事件（main -> renderer；tool 事件为工具调用执行记录） */
    onEvent: (cb: (e: { reqId: string; type: string; text?: string; message?: string; usage?: { tokens?: number }; toolCall?: ToolCall; writtenPath?: string }) => void) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('model:event', handler)
      return () => ipcRenderer.removeListener('model:event', handler)
    }
  },
  tools: {
    /** 直接执行一次沙箱工具（验证与高级用途；参数不合法/越界会被拒） */
    exec: (grant: ToolGrant, tool: string, argsJson: string) =>
      ipcRenderer.invoke('tools:exec', grant, tool, argsJson) as Promise<{ ok: boolean; output: string; writtenPath?: string }>,
    pickDir: () => ipcRenderer.invoke('dialog:pickDir') as Promise<string | null>
  },
  dialogs: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles') as Promise<Array<{ name: string; path: string; size: number; content?: string; error?: boolean }>>,
    saveFile: (defaultName: string, content: string) =>
      ipcRenderer.invoke('dialog:saveFile', defaultName, content) as Promise<{ ok: boolean; message: string }>
  },
  theme: {
    set: (t: 'light' | 'dark' | 'system') => ipcRenderer.invoke('theme:set', t)
  }
}

export type AgentHubApi = typeof api

contextBridge.exposeInMainWorld('agenthub', api)
