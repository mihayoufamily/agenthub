// IPC 桥的类型化封装
import type { AgentHubApi } from '../../../preload/index'

declare global {
  interface Window {
    agenthub: AgentHubApi
  }
}

export const bridge: AgentHubApi = window.agenthub

// ---------------------------------------------------------------------------
// @ 文件引用（输入框 @ 注入工作目录文件）：主进程侧通道（app:listDir / app:readTextFile）
// 由并行批次在 preload/main 落地，契约逐字如下。这里先行给出类型化包装——
// 用交叉类型断言消费 window.agenthub，preload 补上同名方法后断言与真实声明一致，
// 调用方（Composer）无须任何改动。
// ---------------------------------------------------------------------------

export type DirEntry = { name: string; isDir: boolean; size: number }
export type ListDirResult = { ok: boolean; entries?: DirEntry[]; message?: string }
export type ReadTextFileResult = { ok: boolean; content?: string; message?: string }

type FileRefMethods = {
  listDir: (agentId: string, rel: string) => Promise<ListDirResult>
  readTextFile: (agentId: string, rel: string) => Promise<ReadTextFileResult>
}

/** @ 文件引用：rel 为相对该 Agent 文件目录（模型 Agent 沙箱目录 / CLI cwd）的 '/' 分层相对路径；
 *  目录越界、未配置目录、CLI Agent 等情况由主进程以 ok=false + message 如实拒绝 */
export const fileRef: FileRefMethods = {
  listDir: (agentId, rel) => (bridge.app as typeof bridge.app & FileRefMethods).listDir(agentId, rel),
  readTextFile: (agentId, rel) => (bridge.app as typeof bridge.app & FileRefMethods).readTextFile(agentId, rel)
}
