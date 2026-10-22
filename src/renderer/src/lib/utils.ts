// 通用工具

let uidCounter = 0
export function uid(prefix = 'id'): string {
  uidCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, '0')
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}:${String(m % 60).padStart(2, '0')}:${ss}`
  }
  return `${m}:${ss}`
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Token 数格式化：1234 -> 1.2k，12345 -> 12.3k，1234567 -> 1.23M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 节流器（Shift+滚轮切换等场景），返回节流后的函数与立即失效句柄 */
export function throttle<T extends (...args: never[]) => void>(fn: T, gapMs: number): T {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: Parameters<T>) => {
    const now = Date.now()
    const remaining = gapMs - (now - last)
    if (remaining <= 0) {
      last = now
      fn(...args)
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        fn(...args)
      }, remaining)
    }
  }
  return wrapped as T
}

/** IME 安全的 Enter 判断：输入法组合期间（含 keyCode 229）不触发发送 */
export function isSendEnter(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in e ? (e as React.KeyboardEvent).nativeEvent : (e as KeyboardEvent)
  if (native.isComposing) return false
  if (native.keyCode === 229) return false
  return e.key === 'Enter'
}

/** 将文本切成流式小块（模拟流式输出用） */
export function chunkText(text: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 文件名 sanitize（导出用） */
/**
 * 编辑必需的 Ctrl 组合键：允许把它们设成全局快捷键，等于让用户从此复制不了粘贴不了
 * （实测踩坑：modeSwitch 被设成 Ctrl+C 后，Ctrl+M 失效且没有任何提示）。
 */
const RESERVED_CTRL_KEYS = new Set(['c', 'v', 'x', 'z', 'y', 'a', 'w', 't'])

/** 键位是否可用：能解析、且没占用编辑必需组合键 */
export function validateKeyBinding(binding: string): { ok: boolean; message?: string } {
  const want = parseKeyBinding(binding)
  if (!want) return { ok: false, message: '键位无法识别' }
  if (want.ctrl && !want.shift && !want.alt && RESERVED_CTRL_KEYS.has(want.key)) {
    return { ok: false, message: `Ctrl+${want.key.toUpperCase()} 是编辑必需键（复制/粘贴/撤销等），换一个或加上 Shift` }
  }
  return { ok: true }
}

/**
 * 快捷键匹配：'Ctrl+Shift+K' 这种串解析成修饰键 + 主键。
 * 主键支持字母/数字/F 键与几个具名键（Comma/Backspace/Enter/Esc…），大小写不敏感。
 */
const NAMED_KEYS: Record<string, string> = {
  comma: ',', period: '.', slash: '/', space: ' ', backspace: 'backspace', enter: 'enter', escape: 'esc', esc: 'esc', tab: 'tab', insert: 'insert', delete: 'delete', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown'
}

export function parseKeyBinding(binding: string): { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string } | null {
  const parts = String(binding).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (!parts.length) return null
  let ctrl = false
  let shift = false
  let alt = false
  let meta = false
  const keys: string[] = []
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') ctrl = true
    else if (p === 'shift') shift = true
    else if (p === 'alt' || p === 'option') alt = true
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') meta = true
    else keys.push(p)
  }
  if (keys.length !== 1) return null
  const k = keys[0]
  const named = NAMED_KEYS[k]
  return { ctrl, shift, alt, meta, key: named ?? (k.length === 1 ? k : k) }
}

/** 事件是否命中给定键位（未配或解析不出来一律不命中，绝不"空键位=全触发"） */
export function matchKeyBinding(binding: string | undefined, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string }): boolean {
  if (!binding) return false
  const want = parseKeyBinding(binding)
  if (!want) return false
  if (want.ctrl !== (e.ctrlKey || e.metaKey)) return false
  if (want.alt !== e.altKey) return false
  if (want.shift !== e.shiftKey) return false
  const got = (e.key === ',' ? ',' : e.key.toLowerCase())
  return got === want.key
}

/** 把按出来的键组合成 'Ctrl+Shift+K' 形式的键位串（设置页录制用） */
export function formatKeyBinding(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string }): string | null {
  const k = e.key === ',' ? 'Comma' : e.key === '.' ? 'Period' : e.key === '/' ? 'Slash' : e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key.charAt(0).toUpperCase() + e.key.slice(1).toLowerCase()
  if (/^(Control|Shift|Alt|Meta)$/i.test(e.key)) return null // 只按了修饰键，继续等主键
  const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean)
  if (!mods.length) return null // 不给裸键设全局快捷键，会吃掉正常输入
  return [...mods, k].join('+')
}
/** 文件名安全化：去掉非法字符与超长部分（任务记录与文本产物共用同一口径） */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'untitled'
}
