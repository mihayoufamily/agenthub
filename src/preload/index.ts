import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig, AgentSession, WorkflowRun, MemoryEntry, CustomModelConfig,
  ModelTestResult, ScanResultItem, AppInfo, AgentConfig, CliName
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
    save: (s: AgentSession) => ipcRenderer.invoke('session:save', s),
    load: (agentId: string) => ipcRenderer.invoke('session:load', agentId) as Promise<AgentSession | null>,
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
    chat: (name: CliName, opts: { model?: string; exePath?: string }, reqId: string, messages: { role: string; content: string }[]) =>
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
    chat: (cfg: CustomModelConfig, reqId: string, messages: { role: string; content: string }[]) =>
      ipcRenderer.invoke('model:chat', cfg, reqId, messages),
    cancel: (reqId: string) => ipcRenderer.invoke('model:cancel', reqId),
    /** 订阅流式事件（main -> renderer） */
    onEvent: (cb: (e: { reqId: string; type: string; text?: string; message?: string; usage?: { tokens?: number } }) => void) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('model:event', handler)
      return () => ipcRenderer.removeListener('model:event', handler)
    }
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
