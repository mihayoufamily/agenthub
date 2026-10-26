// 本机账号体系（2026-10-26，二批改版）：
//  - 账号 = 数据档案（agents/会话/工作流配置/任务/用量/头像各自独立），**不再锁屏**：
//    启动直接进应用，当前使用哪个档案由 activeUid 决定，侧栏一键切换（无密码）
//  - 密码仍然存在（scrypt 加盐），只用于**手机端登录**（username+password 换会话 token）
//  - 头像：渲染层上传前裁圆压缩（≤64KB dataURL），存 auth.json（导出剥离、不出机器）
//  - 云端同步（自制服务）：整份账号档案 AES-256-GCM 加密后托管到用户自己的服务器，
//    服务器只存密文；多设备用同一把同步口令拉取，实现"云端管理账号"
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const SCRYPT_N = 16384
const KEYLEN = 64
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000
/** 手机登录尝试限流：同 IP 每分钟 5 次（暴力破解基本盘） */
const LOGIN_RATE = { max: 5, windowMs: 60000 }
/** 头像 dataURL 上限（渲染层已压缩，这里兜底拒绝超大值） */
const AVATAR_MAX = 80 * 1024

interface Account {
  id: string
  name: string
  /** 格式 `salt$hash`（均 hex） */
  hash: string
  createdAt: number
  lastLoginAt?: number
  /** 头像 dataURL（渲染层已裁圆压缩；空=用默认字头头像） */
  avatar?: string
}
interface MobileSession {
  token: string
  accountId: string
  expiresAt: number
}
interface AuthFile {
  v: 2
  accounts: Account[]
  /** 手机端登录会话（重启恢复，免得应用一更新手机就要重新登录） */
  sessions?: MobileSession[]
  /** 当前使用的账号档案（无密码切换；缺省=主账号或 'local'） */
  activeUid?: string
  /** 机主（'local' 作用域、尚未创建账号时）的头像 */
  localAvatar?: string
  /** 云端同步配置：服务地址 + 口令派生校验串（口令本身不落盘，见 cloud.ts） */
  cloud?: { url: string; keyCheck: string }
}

let file: AuthFile | null = null
let authPath = ''
/** 登录限流：ip -> 时间戳数组 */
const attempts = new Map<string, number[]>()

function load(): AuthFile {
  if (file) return file
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as AuthFile
    if (raw && Array.isArray(raw.accounts)) {
      file = { v: 2, accounts: raw.accounts, sessions: raw.sessions ?? [], activeUid: raw.activeUid, localAvatar: raw.localAvatar, cloud: raw.cloud }
      return file
    }
  } catch { /* 首次/损坏 → 全新 */ }
  file = { v: 2, accounts: [], sessions: [], activeUid: undefined }
  return file
}

function save() {
  if (!file) return
  const tmp = authPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  fs.renameSync(tmp, authPath)
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const h = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N }).toString('hex')
  return `${salt}$${h}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, want] = stored.split('$')
  if (!salt || !want) return false
  try {
    const h = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N })
    const w = Buffer.from(want, 'hex')
    return h.length === w.length && crypto.timingSafeEqual(h, w)
  } catch {
    return false
  }
}

// ---------- 初始化与档案状态 ----------

export function initAuth(userDataDir: string): void {
  authPath = path.join(userDataDir, 'auth.json')
  // 缓存作废重读：Store 构造早期的 getConfig 会在 authPath 就位前触发一次 load()，
  // 把"空账号表"缓存住——不重读的话整个启动期账号系统都是空的（档案收养全乱，实测踩坑）
  file = null
  load()
  const f = load()
  const before = f.sessions?.length ?? 0
  if (f.sessions) {
    f.sessions = f.sessions.filter((s) => s.expiresAt > Date.now())
    if (f.sessions.length !== before) save()
  }
}

export interface AuthState {
  hasAccounts: boolean
  /** 当前使用的数据档案（侧栏可无密码切换） */
  active: { id: string; name: string; avatar?: string } | null
  /** 云端同步配置（不含口令） */
  cloud: { url: string } | null
}

export function authState(): AuthState {
  const f = load()
  const cur = f.accounts.find((a) => a.id === activeUid()) ?? null
  return {
    hasAccounts: f.accounts.length > 0,
    // 无账号时 = 机主档案（'local'），头像存独立的 localAvatar 字段
    active: cur ? { id: cur.id, name: cur.name, avatar: cur.avatar } : { id: 'local', name: '机主', avatar: f.localAvatar },
    cloud: f.cloud ? { url: f.cloud.url } : null
  }
}

/** 当前数据档案 id：显式切换过的账号；无账号时 'local'（机主遗留数据作用域） */
export function activeUid(): string {
  const f = load()
  if (f.accounts.length === 0) return 'local'
  const want = f.activeUid
  if (want && f.accounts.some((a) => a.id === want)) return want
  return f.accounts[0].id
}

/** 切换档案（无密码；渲染层切换后自行 reload 重载档案数据） */
export function setActive(id: string): { ok: boolean; message?: string } {
  const f = load()
  if (id !== 'local' && !f.accounts.some((a) => a.id === id)) return { ok: false, message: '账号不存在' }
  if (f.accounts.length === 0 && id !== 'local') return { ok: false, message: '账号不存在' }
  f.activeUid = id
  save()
  return { ok: true }
}

export function listAccounts(): { id: string; name: string; avatar?: string; lastLoginAt?: number }[] {
  return load().accounts.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, lastLoginAt: a.lastLoginAt }))
}

export function addAccount(name: string, password: string): { ok: boolean; message?: string; id?: string } {
  const n = name.trim()
  if (!n || n.length > 24) return { ok: false, message: '用户名需为 1-24 字' }
  if (password.length < 4) return { ok: false, message: '密码至少 4 位' }
  const f = load()
  if (f.accounts.some((a) => a.name === n)) return { ok: false, message: '用户名已存在' }
  const acc: Account = { id: crypto.randomBytes(8).toString('hex'), name: n, hash: hashPassword(password), createdAt: Date.now() }
  f.accounts.push(acc)
  // 新建的账号自动成为当前档案（刚建完就想用它，符合直觉）
  f.activeUid = acc.id
  save()
  return { ok: true, id: acc.id }
}

export function removeAccount(id: string): { ok: boolean; message?: string } {
  const f = load()
  if (!f.accounts.some((a) => a.id === id)) return { ok: false, message: '账号不存在' }
  if (f.accounts.length === 1) return { ok: false, message: '至少保留一个账号（删除后手机端将无法登录）' }
  f.accounts = f.accounts.filter((a) => a.id !== id)
  if (f.sessions) f.sessions = f.sessions.filter((s) => s.accountId !== id)
  if (f.activeUid === id) f.activeUid = f.accounts[0]?.id
  save()
  return { ok: true }
}

export function changePassword(id: string, oldPw: string, newPw: string): { ok: boolean; message?: string } {
  const acc = load().accounts.find((a) => a.id === id)
  if (!acc) return { ok: false, message: '账号不存在' }
  if (!verifyPassword(oldPw, acc.hash)) return { ok: false, message: '原密码不对' }
  if (newPw.length < 4) return { ok: false, message: '新密码至少 4 位' }
  acc.hash = hashPassword(newPw)
  const f = load()
  if (f.sessions) f.sessions = f.sessions.filter((s) => s.accountId !== id)
  save()
  return { ok: true }
}

export function setAvatar(id: string, dataUrl: string): { ok: boolean; message?: string; avatar?: string } {
  if (typeof dataUrl !== 'string') return { ok: false, message: '参数不对' }
  if (dataUrl === '') {
    // 清空头像：账号清自己的；'local' 清机主独立字段
    const f0 = load()
    const acc0 = f0.accounts.find((a) => a.id === id)
    if (acc0) delete acc0.avatar
    else if (id === 'local') delete f0.localAvatar
    else return { ok: false, message: '账号不存在' }
    save()
    return { ok: true }
  }
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) return { ok: false, message: '只支持 png/jpg/webp 图片' }
  if (dataUrl.length > AVATAR_MAX) return { ok: false, message: '图片过大（压缩后再传，≤64KB）' }
  // 'local' = 机主（尚未创建账号也能用头像）；真账号存各自字段
  const f = load()
  const acc = f.accounts.find((a) => a.id === id)
  if (acc) {
    acc.avatar = dataUrl
  } else if (id === 'local') {
    f.localAvatar = dataUrl
  } else {
    return { ok: false, message: '账号不存在' }
  }
  save()
  return { ok: true, avatar: dataUrl }
}

// ---------- 手机端用户名密码登录 ----------

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const arr = (attempts.get(ip) ?? []).filter((t) => now - t < LOGIN_RATE.windowMs)
  arr.push(now)
  attempts.set(ip, arr)
  return arr.length > LOGIN_RATE.max
}

export function mobileLogin(username: string, password: string, ip: string): { ok: boolean; message?: string; token?: string; name?: string } {
  if (rateLimited(ip)) return { ok: false, message: '尝试太频繁，请一分钟后再试' }
  const f = load()
  const acc = f.accounts.find((a) => a.name === username.trim())
  if (!acc || !verifyPassword(password, acc.hash)) return { ok: false, message: '用户名或密码不对' }
  const token = crypto.randomBytes(32).toString('hex')
  const s: MobileSession = { token, accountId: acc.id, expiresAt: Date.now() + TOKEN_TTL_MS }
  f.sessions = [...(f.sessions ?? []).filter((x) => x.expiresAt > Date.now()), s].slice(-200)
  acc.lastLoginAt = Date.now()
  save()
  return { ok: true, token, name: acc.name }
}

export function mobileVerify(token: string | undefined): { id: string; name: string } | null {
  if (!token) return null
  const f = load()
  const s = f.sessions?.find((x) => x.token === token)
  if (!s || s.expiresAt < Date.now()) return null
  s.expiresAt = Date.now() + TOKEN_TTL_MS
  const acc = f.accounts.find((a) => a.id === s.accountId)
  if (!acc) return null
  return { id: acc.id, name: acc.name }
}

export function mobileLogout(token: string | undefined): void {
  if (!token) return
  const f = load()
  if (f.sessions) {
    f.sessions = f.sessions.filter((s) => s.token !== token)
    save()
  }
}

/** 首个账号 = 机主（配对 token 扫码通道的身份归属；旧数据也收养给这个作用域） */
export function primaryAccountId(): string | null {
  return load().accounts[0]?.id ?? null
}

export function hasAccount(id: string): boolean {
  return load().accounts.some((a) => a.id === id)
}

/** 改账号名（侧栏/设置；找回账号的"找回·XXXX"默认名由此改成用户想要的名字） */
export function renameAccount(id: string, newName: string): { ok: boolean; message?: string } {
  const n = newName.trim()
  if (!n || n.length > 24) return { ok: false, message: '用户名需为 1-24 字' }
  const f = load()
  const acc = f.accounts.find((a) => a.id === id)
  if (!acc) return { ok: false, message: '账号不存在' }
  if (f.accounts.some((a) => a.id !== id && a.name === n)) return { ok: false, message: '用户名已存在' }
  acc.name = n
  save()
  return { ok: true }
}

/** 孤儿档案收容：账号记录在旧 bug 中被覆盖、但档案数据还在——按原 id 补建账号（密码由恢复方指定） */
export function recoverAccount(id: string, password: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(id)) return null
  const f = load()
  if (f.accounts.some((a) => a.id === id)) return null
  const name = `找回·${id.slice(0, 4)}`
  f.accounts.push({ id, name, hash: hashPassword(password), createdAt: Date.now() })
  save()
  return name
}

// ---------- 云端同步（自制服务；密文托管，口令不落盘） ----------

export function cloudConfig(): { url: string; keyCheck: string } | null {
  return load().cloud ?? null
}

export function setCloudConfig(url: string, keyCheck: string): void {
  const f = load()
  f.cloud = url ? { url: url.replace(/\/+$/, ''), keyCheck } : undefined
  save()
}

/** 同步载荷：全部账号（含密码哈希与头像）+ 当前档案指针 + 机主头像。明文只在客户端，上云前整体加密 */
export function exportForSync(): { accounts: Account[]; activeUid?: string; localAvatar?: string } {
  const f = load()
  return { accounts: f.accounts, activeUid: f.activeUid, localAvatar: f.localAvatar }
}

/** 从云端恢复：整表替换账号（手机会话作废——新设备要重新登录）；返回恢复了几个账号 */
export function importFromSync(data: { accounts?: { id: string; name: string; hash: string; avatar?: string; createdAt?: number; lastLoginAt?: number }[]; activeUid?: string }): { ok: boolean; count?: number; message?: string } {
  if (!data || !Array.isArray(data.accounts)) return { ok: false, message: '同步数据里没有账号表' }
  const clean = (data.accounts.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.hash === 'string') as Account[])
  if (!clean.length) return { ok: false, message: '同步数据里没有有效账号' }
  const f = load()
  f.accounts = clean
  f.sessions = []
  f.activeUid = typeof data.activeUid === 'string' && clean.some((a) => a.id === data.activeUid) ? data.activeUid : clean[0].id
  if (typeof (data as { localAvatar?: string }).localAvatar === 'string') f.localAvatar = (data as { localAvatar?: string }).localAvatar
  save()
  return { ok: true, count: clean.length }
}

/** 同步口令的本地校验串（口令本身绝不落盘；换口令时提示会覆盖云端） */
export function keyCheckOf(passphrase: string): string {
  return crypto.createHash('sha256').update(`check:${passphrase}`).digest('hex').slice(0, 16)
}

/** 应用名（存档目录）——index.ts 在 app.ready 前后调用均可 */
export function authFilePath(): string {
  return authPath || path.join(app.getPath('userData'), 'auth.json')
}

/** 验证态专用：--ahub-verify 的自动化跑（保留兼容；新版无锁屏此函数为 no-op 语义） */
export function unlockForVerify(): void {
  /* v2 起无锁屏：保留导出避免旧调用点编译错误 */
}
