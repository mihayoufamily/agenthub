// IPC 桥的类型化封装
import type { AgentHubApi } from '../../../preload/index'

declare global {
  interface Window {
    agenthub: AgentHubApi
  }
}

export const bridge: AgentHubApi = window.agenthub
