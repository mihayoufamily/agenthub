// 偏好设置：从主进程配置加载，变更即时生效并持久化（防抖）
import { create } from 'zustand'
import type { Prefs, AppInfo, MemoryEntry } from '@shared/types'
import { bridge } from '../lib/ipc'
import { uid, safeName } from '../lib/utils'
import { useUi } from './ui'

interface SettingsState {
  prefs: Prefs | null
  appInfo: AppInfo | null
  memory: MemoryEntry[]
  /** 启动引导：加载配置 -> 应用外观 -> 决定首屏 */
  init: () => Promise<void>
  patchPrefs: (p: Partial<Prefs>) => void
  applyDom: (p: Prefs) => void
  exportConfig: () => Promise<void>
  importConfig: () => Promise<void>
  loadMemory: () => Promise<void>
  addMemory: (kind: MemoryEntry['kind'], text: string, editable?: boolean) => void
  updateMemory: (id: string, text: string) => void
  removeMemory: (id: string) => void
  exportSessionRecord: () => Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function persistPrefs(prefs: Prefs) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void bridge.config.setPrefs(prefs)
  }, 400)
}

export const useSettings = create<SettingsState>()((set, get) => ({
  prefs: null,
  appInfo: null,
  memory: [],

  init: async () => {
    try {
      const cfg = await bridge.config.get()
      const info = await bridge.app.info()
      get().applyDom(cfg.prefs)
      set({ prefs: cfg.prefs, appInfo: info })
      await get().loadMemory()
    } catch (e) {
      useUi.getState().setBootError(`配置加载失败：${(e as Error).message}`)
    }
  },

  patchPrefs: (p) => {
    const cur = get().prefs
    if (!cur) return
    const next = { ...cur, ...p }
    set({ prefs: next })
    get().applyDom(next)
    persistPrefs(next)
  },

  applyDom: (p) => {
    const root = document.documentElement
    const resolved =
      p.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : p.theme
    root.dataset.theme = resolved
    root.dataset.anim = p.animations ? 'on' : 'off'
    root.dataset.motion = p.reducedMotion ? 'reduced' : 'full'
    root.style.setProperty('--font-size', `${p.fontSize}px`)
    void bridge.theme.set(p.theme)
  },

  exportConfig: async () => {
    const r = await bridge.config.exportFile()
    useUi.getState().toast(r.ok ? '配置已导出（不含 API Key）' : `导出未完成：${r.message}`, r.ok ? 'ok' : 'warn')
  },

  importConfig: async () => {
    const r = await bridge.config.importFile()
    if (r.ok) {
      useUi.getState().toast('导入成功，正在重新加载…', 'ok')
      await get().init()
    } else {
      useUi.getState().toast(`导入失败：${r.message}`, 'error')
    }
  },

  loadMemory: async () => {
    try {
      const m = await bridge.memory.get()
      set({ memory: m })
    } catch { /* 记忆加载失败不阻塞 */ }
  },

  addMemory: (kind, text, editable = true) => {
    const list = get().memory
    const entry: MemoryEntry = { id: uid('mem'), kind, text, ts: Date.now(), editable }
    const next = [...list, entry]
    set({ memory: next })
    void bridge.memory.set(next)
  },

  updateMemory: (id, text) => {
    const next = get().memory.map((m) => (m.id === id ? { ...m, text } : m))
    set({ memory: next })
    void bridge.memory.set(next)
  },

  removeMemory: (id) => {
    const next = get().memory.filter((m) => m.id !== id)
    set({ memory: next })
    void bridge.memory.set(next)
  },

  exportSessionRecord: async () => {
    const runs = await bridge.runs.list()
    const lines: string[] = ['# AgentHub 任务记录导出', '']
    for (const r of runs) {
      lines.push(`## ${r.goal}`, `- 状态：${r.status} · 轮次：${r.round}/${r.maxRounds} · 开始：${new Date(r.startedAt).toLocaleString()}`)
      if (r.demo) lines.push(`- ⚠ 此任务为演示数据（${r.demo ? '演示模式' : '真实执行'}）`)
      for (const c of r.cards) {
        lines.push('', `### [${c.role}] ${c.title}`, c.conclusion)
      }
      lines.push('', '---', '')
    }
    const name = safeName(`agenthub-runs-${Date.now()}`) + '.md'
    const r = await bridge.dialogs.saveFile(name, lines.join('\n'))
    useUi.getState().toast(r.ok ? `已导出到 ${r.message}` : '已取消导出', r.ok ? 'ok' : 'info')
  }
}))
