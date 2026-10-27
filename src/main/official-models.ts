// ============ 官方模型服务注册表：内置"官方模型"入口的数据源 ============
//
// 与技能注册表（market.ts）同一套取数模式：ETag 缓存（304 命中用缓存）、逐条校验、
// 非法条目跳过并点名、网络失败回退缓存并如实标 fromCache。
// 关键区别：这里**不下载任何东西**——清单只描述"端点 + 模型 id/名称/描述/上下文长度"，
// 真正的调用走既有自定义模型通道（model:test / model:chat），本模块零执行面、零新增信任面。
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fetchTextWithMirror } from './ghmirror'

/** 注册表仓库：mihayoufamily/agenthub-models（与 agenthub-skills 同一维护方；改模型/换端点提 PR 改 index.json，不用发应用版） */
export const MODELS_REGISTRY_URL = 'https://raw.githubusercontent.com/mihayoufamily/agenthub-models/main/index.json'

export interface OfficialModelItem {
  /** OpenAI 兼容 model id：一键生成 Agent 时填进 modelConfig.modelId */
  id: string
  name: string
  desc: string
  /** 上下文窗口（token 数，正整数）：界面提示与长文提醒用，不做硬截断 */
  contextWindow: number
}

export interface OfficialModelsResult {
  ok: boolean
  /** 服务显示名（如「AgentHub 官方模型服务」） */
  service?: string
  /** OpenAI 兼容端点（必须 https——注册表写 http:// 的清单整表拒收，明文传 key 不可接受） */
  endpoint?: string
  models: OfficialModelItem[]
  /** 清单维护说明（注册表带一句，界面可展示"最近更新"） */
  updatedNote?: string
  /** ok=false 时的中文原因；部分条目被跳过时也可能带说明 */
  error?: string
  /** true = 数据来自本地缓存（304 命中或网络失败回退）——界面要如实标，不冒充实时数据 */
  fromCache?: boolean
  /** true = raw 直连失败，数据来自 api.github.com 镜像（内容同源，只是换了通道） */
  viaMirror?: boolean
  /** true = 网络全不可达，数据来自随应用打包的内置快照（可能略旧，界面如实标） */
  fromBuiltin?: boolean
  /** 被跳过的非法条目（点名 id 或位置），不整表拒绝 */
  skipped?: string[]
}

/**
 * 校验注册表 JSON（纯函数，导出给逻辑层断言）。口径与 parseRegistryIndex 一致：
 * 一条脏数据不否决整张表，但"跳过了谁"必须回给界面（静默丢条目是本仓明确修过的缺陷，不重犯）。
 * endpoint 是唯一整表性的硬闸：官方服务的端点必须 https，且由本仓库维护（URL 常量收口）。
 */
export function parseOfficialModelsIndex(text: string): OfficialModelsResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, models: [], error: '官方模型注册表内容不是合法 JSON' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, models: [], error: '官方模型注册表格式不正确（应为 { service, endpoint, models: [...] }）' }
  }
  const d = data as Record<string, unknown>
  const endpoint = typeof d.endpoint === 'string' ? d.endpoint.trim() : ''
  if (!/^https:\/\/\S+$/.test(endpoint)) {
    return { ok: false, models: [], error: '注册表未给出合法的 https 端点' }
  }
  const list = d.models
  if (!Array.isArray(list)) {
    return { ok: false, models: [], error: '注册表 models 不是数组' }
  }
  const models: OfficialModelItem[] = []
  const skipped: string[] = []
  list.forEach((raw, i) => {
    const label = (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string')
      ? String((raw as { id: string }).id)
      : `#${i}`
    const bad = (why: string) => skipped.push(`${label}（${why}）`)
    if (!raw || typeof raw !== 'object') { bad('不是对象'); return }
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9._\/-]{1,64}$/.test(e.id)) { bad('id 不合法'); return }
    if (typeof e.name !== 'string' || !e.name.trim()) { bad('缺 name'); return }
    if (typeof e.desc !== 'string') { bad('缺 desc'); return }
    if (typeof e.contextWindow !== 'number' || !Number.isInteger(e.contextWindow) || e.contextWindow <= 0) {
      bad('contextWindow 不是正整数'); return
    }
    models.push({
      id: e.id,
      name: e.name.slice(0, 60),
      desc: e.desc.slice(0, 200),
      contextWindow: Math.min(e.contextWindow, 10_000_000)
    })
  })
  if (!models.length) {
    return { ok: false, models: [], endpoint, error: skipped.length ? `全部条目非法，已跳过：${skipped.join('；')}` : '注册表 models 为空' }
  }
  return {
    ok: true,
    endpoint,
    models,
    ...(typeof d.service === 'string' && d.service.trim() ? { service: d.service.slice(0, 60) } : {}),
    ...(typeof d.updatedNote === 'string' && d.updatedNote.trim() ? { updatedNote: d.updatedNote.slice(0, 200) } : {}),
    ...(skipped.length ? { skipped, error: `${skipped.length} 条非法条目已跳过：${skipped.join('；')}` } : {})
  }
}

// ---------- ETag 缓存（与 market.ts 的 market-cache.json 同款，独立文件互不覆盖） ----------

interface OfficialModelsCache {
  etag?: string
  body: string
  fetchedAt: number
}

let userDataDir = ''
let appPathDir = ''

/** 主进程启动时注入 userData 与 appPath（appPath 用来定位随包内置快照；与 market.init 同一个调用点） */
export function initOfficialModels(ud: string, appPath: string) {
  userDataDir = ud
  appPathDir = appPath
}

function cachePath(): string {
  return join(userDataDir, 'official-models-cache.json')
}

function readCache(): OfficialModelsCache | null {
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf-8')) as OfficialModelsCache
    if (typeof c.body !== 'string') return null
    return c
  } catch {
    return null
  }
}

function writeCache(c: OfficialModelsCache) {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(c), 'utf-8')
  } catch { /* 缓存写不进去不阻塞本次结果，下次再试 */ }
}

/** net.fetch 延迟取（与 market.ts 同款：逻辑层测试不起 electron，摸不到 net 也不 import 就炸） */
function netFetch(url: string, init?: RequestInit): Promise<Response> {
  const { net } = require('electron') as typeof import('electron')
  return net.fetch(url, init)
}

/** 内置快照（随应用打包，dev 在仓库根/builtin/registry，packaged 在 resources/app/builtin/registry） */
function readBuiltinSnapshot(): string | null {
  const p = join(appPathDir, 'builtin', 'registry', 'official-models.json')
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : null
  } catch {
    return null
  }
}

/**
 * 拉官方模型清单，三级回退：raw（ETag/304）→ api.github.com 镜像 → 内置快照。
 * 每级来源都如实标注（fromCache / viaMirror / fromBuiltin），不冒充实时数据。
 */
export async function fetchOfficialModels(): Promise<OfficialModelsResult> {
  const cached = readCache()
  const accept = (text: string): OfficialModelsResult => {
    const r = parseOfficialModelsIndex(text)
    if (r.ok) writeCache({ body: text, fetchedAt: Date.now() })
    // 上游格式坏了就不覆盖缓存：手里最后一份好数据比"刚拉的坏数据"值钱
    else if (cached) return { ...parseOfficialModelsIndex(cached.body), fromCache: true, error: r.error }
    return r
  }
  // ① raw 直连（唯一带 ETag/304 协商的通道）
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'AgentHub-Updater',
      Accept: 'application/json'
    }
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    const res = await netFetch(MODELS_REGISTRY_URL, { headers, signal: AbortSignal.timeout(10000) })
    if (res.status === 304 && cached) return { ...parseOfficialModelsIndex(cached.body), fromCache: true }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return accept(await res.text())
  } catch { /* raw 不可达（国内常态）→ 镜像 */ }
  // ② api.github.com 镜像（不同基础设施，国内可达性好；内容同源）
  const mir = await fetchTextWithMirror(MODELS_REGISTRY_URL, netFetch)
  if (mir.ok && mir.text != null) {
    const r = accept(mir.text)
    if (cached && !r.ok) return { ...parseOfficialModelsIndex(cached.body), fromCache: true, viaMirror: true }
    return r.ok ? { ...r, viaMirror: true } : r
  }
  // ③ 内置快照（永不落空的底线；快照可能略旧，如实标注）
  const snap = readBuiltinSnapshot()
  if (snap != null) {
    const r = parseOfficialModelsIndex(snap)
    return {
      ...r,
      fromBuiltin: true,
      ...(r.ok ? { error: '网络不可达，已回退应用内置清单（快照，可能略旧）' } : {})
    }
  }
  return { ok: false, models: [], error: '无法获取官方模型清单：raw 与镜像均不可达，且应用未携带内置清单' }
}
