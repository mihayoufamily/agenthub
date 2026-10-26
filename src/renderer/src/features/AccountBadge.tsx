// 侧栏账号区（2026-10-26 二批）：头像（上传，裁圆压缩）+ 账号名，点开账号面板
// （切换档案 / 管理账号）。无锁屏——账号只是数据档案身份，切换不需要密码。
// 面板用 createPortal：aside 的入场动画 transform 会困住 fixed 后代（同 NotificationCenter 事故）。
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { bridge } from '../lib/ipc'
import { useUi } from '../stores/ui'

type Account = { id: string; name: string; avatar?: string; lastLoginAt?: number }

/** 上传图片 → 居中裁方 → 128px → JPEG dataURL（≤64KB 由主进程兜底校验）。
 *  读文件必须走 FileReader（dataURL 通道）：CSP img-src 只有 'self' data:，
 *  createObjectURL 的 blob: 图片会被拦（实测踩坑：onerror 静默返回 null，上传看起来毫无反应） */
function pickAvatar(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) { resolve(null); return }
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          try {
            const S = 128
            const canvas = document.createElement('canvas')
            canvas.width = S; canvas.height = S
            const ctx = canvas.getContext('2d')
            if (!ctx) { resolve(null); return }
            // 居中裁方：短边为基准
            const side = Math.min(img.width, img.height)
            ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S)
            resolve(canvas.toDataURL('image/jpeg', 0.85))
          } catch {
            resolve(null)
          }
        }
        img.onerror = () => resolve(null)
        img.src = String(reader.result)
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(f)
    }
    input.click()
  })
}

function AvatarImg({ acc, size }: { acc: Account | null; size: number }) {
  if (acc?.avatar) {
    return <img src={acc.avatar} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  }
  // 默认字头头像：账号名首字
  const ch = (acc?.name ?? '主').trim().slice(0, 1).toUpperCase() || '主'
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: 'linear-gradient(135deg, var(--accent), #7c5cff)', color: '#fff',
      display: 'grid', placeItems: 'center', fontSize: size * 0.44, fontWeight: 600, userSelect: 'none'
    }}>{ch}</div>
  )
}

export function AccountBadge({ collapsed }: { collapsed?: boolean }) {
  const [active, setActive] = useState<Account | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const openSettings = useUi((s) => s.openSettings)

  const refresh = () => {
    void bridge.auth.state().then((s) => setActive(s.active)).catch(() => {})
    void bridge.auth.listAccounts().then(setAccounts).catch(() => {})
  }
  useEffect(refresh, [])

  const switchTo = async (id: string) => {
    const r = await bridge.auth.setActive(id)
    if (r.ok) window.location.reload() // 档案数据整体重载（agents/会话/任务/用量）
  }

  const upload = async () => {
    if (!active) return
    const dataUrl = await pickAvatar()
    if (!dataUrl) { useUi.getState().toast('图片读取失败（仅支持 png/jpg/webp）', 'error'); return }
    const r = await bridge.auth.setAvatar(active.id, dataUrl)
    if (r.ok) refresh()
    else useUi.getState().toast(r.message ?? '保存失败', 'error')
  }

  if (collapsed) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }} ref={(el) => { setAnchor(el) }}>
        <button
          ref={btnRef}
          className="foot-btn"
          style={{ width: 30, height: 30, padding: 0, borderRadius: '50%', overflow: 'visible', justifyContent: 'center' }}
          onClick={() => setOpen((v) => !v)}
          title="账号"
          data-testid="account-badge"
        >
          <AvatarImg acc={active} size={22} />
        </button>
        {open && anchor && <AccountPanel anchor={anchor} active={active} accounts={accounts} onSwitch={switchTo} onUpload={upload} onRenamed={refresh} onManage={() => { setOpen(false); openSettings('account') }} onClose={() => setOpen(false)} />}
      </div>
    )
  }

  return (
    <div style={{ padding: '6px 10px 2px' }} ref={(el) => { setAnchor(el) }}>
      <button
        ref={btnRef}
        className="foot-btn"
        style={{ width: '100%', borderRadius: 10, gap: 9 }}
        onClick={() => setOpen((v) => !v)}
        title="账号"
        data-testid="account-badge"
      >
        <AvatarImg acc={active} size={26} />
        <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active?.name ?? '账号'}</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-3)' }}>▼</span>
      </button>
        {open && anchor && <AccountPanel anchor={anchor} active={active} accounts={accounts} onSwitch={switchTo} onUpload={upload} onRenamed={refresh} onManage={() => { setOpen(false); openSettings('account') }} onClose={() => setOpen(false)} />}
      </div>
  )
}

function AccountPanel(props: {
  anchor: HTMLElement
  active: Account | null
  accounts: Account[]
  onSwitch: (id: string) => void
  onUpload: () => void
  onRenamed: () => void
  onManage: () => void
  onClose: () => void
}) {
  const { anchor, active, accounts, onSwitch, onUpload, onRenamed, onManage, onClose } = props
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const saveName = () => {
    if (!active || !draft.trim()) return
    void bridge.auth.renameAccount(active.id, draft.trim()).then((r) => {
      if (r.ok) { setRenaming(false); setErr(''); onRenamed() } else setErr(r.message ?? '修改失败')
    })
  }
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [anchor, onClose])
  const rect = anchor.getBoundingClientRect()
  const style: React.CSSProperties = {
    position: 'fixed', left: Math.max(8, rect.left), bottom: window.innerHeight - rect.top + 8,
    width: 232, zIndex: 900, background: 'var(--bg-2, #1e2025)', border: '1px solid var(--border, #2e3138)',
    borderRadius: 12, boxShadow: '0 10px 32px rgba(0,0,0,.4)', padding: 6, color: 'var(--text, #e8eaf0)'
  }
  return createPortal(
    <div ref={ref} style={style} data-testid="account-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px 10px', borderBottom: '1px solid var(--border, #2e3138)' }}>
        <AvatarImg acc={active} size={34} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active?.name ?? '—'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>当前数据档案</div>
        </div>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} title="修改名字" onClick={() => { setDraft(active?.name ?? ''); setRenaming((v) => !v); setErr('') }}>✏️</button>
        <button className="icon-btn" title="更换头像" onClick={onUpload}>🖼</button>
      </div>
      {renaming && active && (
        <div style={{ padding: '6px 8px 2px', display: 'flex', gap: 6 }}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName()
              if (e.key === 'Escape') setRenaming(false)
            }}
            style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border, #2e3138)', background: 'var(--bg-3, #24262d)', color: 'inherit', fontSize: 12.5 }}
            data-testid="account-rename-input"
          />
          <button className="fp-act primary" onClick={saveName}>保存</button>
        </div>
      )}
      {err && <div style={{ padding: '0 8px', fontSize: 11.5, color: 'var(--bad, #e06456)' }}>{err}</div>}
      <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '8px 8px 2px' }}>切换档案</div>
      {accounts.map((a) => (
        <button
          key={a.id}
          className="foot-btn"
          style={{ width: '100%', borderRadius: 8, gap: 8, background: a.id === active?.id ? 'var(--bg-3, #24262d)' : undefined }}
          onClick={() => { if (a.id !== active?.id) onSwitch(a.id); else onClose() }}
          title="点击切换；改名请用上方 ✏️（针对当前账号）"
        >
          <AvatarImg acc={a} size={20} />
          <span style={{ fontSize: 12.5 }}>{a.name}</span>
          {a.id === active?.id && <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 12 }}>✓</span>}
        </button>
      ))}
      <button className="foot-btn" style={{ width: '100%', borderRadius: 8, marginTop: 4 }} onClick={onManage}>
        <span style={{ fontSize: 12.5 }}>管理账号（增删/密码）…</span>
      </button>
    </div>,
    document.body
  )
}
