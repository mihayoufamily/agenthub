// 云端账号同步客户端（2026-10-26）：整份账号档案 AES-256-GCM 加密后推到自制同步服务，
// 多设备用同一把同步口令拉取恢复。口令本身不落盘（只落 keyCheck 校验串）。
// 载荷：auth.exportForSync()（账号+哈希+头像+活跃指针）+ store.syncProfiles()（全部档案数据）。
// 注意（UI 如实提示）：API Key 在凭据存储（safeStorage 机器绑定），**不在同步范围**——
// 换设备恢复后模型 Agent 要重新填 Key。
import crypto from 'node:crypto'
import * as auth from './auth'
import type { Store } from './store'

const SCRYPT_KEYLEN = 32

function deriveKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, 'agenthub-sync-v1', SCRYPT_KEYLEN)
}

function encrypt(plain: string, passphrase: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

function decrypt(b64: string, passphrase: string): string {
  const raw = Buffer.from(b64, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const data = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function initCloudSync(_opts: { getStore: () => Store }) {
  /* store 引用按需传入各 handler（ipc 里直接闭包），这里留装配点 */
}

export function cloudPush(store: Store, url: string, passphrase: string): Promise<{ ok: boolean; message?: string }> {
  const payload = {
    accounts: auth.exportForSync().accounts,
    activeUid: auth.exportForSync().activeUid,
    profiles: store.syncProfiles(),
    savedAt: Date.now()
  }
  const body = JSON.stringify({ version: Date.now(), data: encrypt(JSON.stringify(payload), passphrase) })
  return fetch(`${url.replace(/\/+$/, '')}/sync/push?k=${auth.keyCheckOf(passphrase)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body
  })
    .then(async (r) => {
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string }
      if (r.ok && j.ok) {
        auth.setCloudConfig(url, auth.keyCheckOf(passphrase))
        return { ok: true as const, message: `已推送到云端（${payload.accounts.length} 个账号）` }
      }
      return { ok: false as const, message: j.message ?? `推送失败（HTTP ${r.status}）` }
    })
    .catch(() => ({ ok: false as const, message: '推送失败：服务器不可达' }))
}

export async function cloudPull(store: Store, url: string, passphrase: string): Promise<{ ok: boolean; message?: string }> {
  let j: { ok?: boolean; data?: string; message?: string } = {}
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/sync/pull?k=${auth.keyCheckOf(passphrase)}`)
    j = (await r.json().catch(() => ({}))) as { ok?: boolean; data?: string; message?: string }
    if (r.status === 404) return { ok: false, message: '云端没有档案（先在有数据的设备上推送）' }
  } catch {
    return { ok: false, message: '拉取失败：服务器不可达' }
  }
  if (!j.data) return { ok: false, message: j.message ?? '云端数据为空' }
  let payload: { accounts?: { id: string; name: string; hash: string; avatar?: string; createdAt?: number; lastLoginAt?: number }[]; activeUid?: string; profiles?: Record<string, unknown> }
  try {
    payload = JSON.parse(decrypt(j.data, passphrase))
  } catch {
    return { ok: false, message: '解密失败：同步口令不对' }
  }
  const r1 = auth.importFromSync(payload)
  if (!r1.ok) return { ok: false, message: r1.message }
  if (payload.profiles && typeof payload.profiles === 'object') store.restoreProfiles(payload.profiles)
  auth.setCloudConfig(url, auth.keyCheckOf(passphrase))
  return { ok: true, message: `已从云端恢复 ${r1.count} 个账号及其档案数据（重启应用生效；API Key 不在同步范围，需重填）` }
}
