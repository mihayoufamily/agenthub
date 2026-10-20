// UI 全局状态：屏幕导航、开屏阶段、Toast、弹窗开关
// 注意：动画/导航状态与任务执行状态（sessions/workflow store）严格分离
import { create } from 'zustand'
import type { WorkMode, Attachment } from '@shared/types'
import { uid } from '../lib/utils'

export type Screen = 'splash' | 'brand' | 'workbench' | 'workflow'
export type SplashStage = 'black' | 'logo' | 'word' | 'cream' | 'ready' | 'stable'

export interface ToastItem {
  id: string
  text: string
  kind: 'info' | 'ok' | 'warn' | 'error'
}

interface UiState {
  screen: Screen
  splashStage: SplashStage
  homeDraft: string
  homeAttachments: Attachment[]
  pendingMode: WorkMode | null
  settingsOpen: boolean
  toasts: ToastItem[]
  switchHud: string | null
  bootError: string | null

  setScreen: (s: Screen) => void
  setSplashStage: (s: SplashStage) => void
  setHomeDraft: (t: string) => void
  setHomeAttachments: (a: Attachment[]) => void
  setPendingMode: (m: WorkMode | null) => void
  openSettings: () => void
  closeSettings: () => void
  toast: (text: string, kind?: ToastItem['kind']) => void
  dismissToast: (id: string) => void
  setSwitchHud: (t: string | null) => void
  setBootError: (e: string | null) => void
}

export const useUi = create<UiState>()((set) => ({
  screen: 'splash',
  splashStage: 'black',
  homeDraft: '',
  homeAttachments: [],
  pendingMode: null,
  settingsOpen: false,
  toasts: [],
  switchHud: null,
  bootError: null,

  setScreen: (s) => set({ screen: s }),
  setSplashStage: (s) => set({ splashStage: s }),
  setHomeDraft: (t) => set({ homeDraft: t }),
  setHomeAttachments: (a) => set({ homeAttachments: a }),
  setPendingMode: (m) => set({ pendingMode: m }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toast: (text, kind = 'info') => {
    const id = uid('toast')
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, kind === 'error' ? 5200 : 3000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setSwitchHud: (t) => set({ switchHud: t }),
  setBootError: (e) => set({ bootError: e })
}))
