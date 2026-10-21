import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import type { AppConfig, AgentSession, WorkflowRun, MemoryEntry, Prefs } from '../shared/types'

const CURRENT_SCHEMA_VERSION = 1

interface StoreDirs {
  config: string
  sessions: string
  runs: string
  memory: string
  credentials: string
  logs: string
}

export class Store {
  dirs: StoreDirs

  constructor() {
    const base = app.getPath('userData')
    const sessionsDir = join(base, 'sessions')
    const runsDir = join(base, 'runs')
    const logsDir = join(base, 'logs')
    for (const d of [base, sessionsDir, runsDir, logsDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
    }
    this.dirs = {
      config: join(base, 'config.json'),
      sessions: sessionsDir,
      runs: runsDir,
      memory: join(base, 'memory.json'),
      credentials: join(base, 'credentials.enc'),
      logs: logsDir
    }
  }

  // ---------- 通用 JSON 读写 ----------
  private readJson<T>(p: string, fallback: T): T {
    try {
      if (!existsSync(p)) return fallback
      return JSON.parse(readFileSync(p, 'utf-8')) as T
    } catch {
      return fallback
    }
  }

  private writeJson(p: string, data: unknown) {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
  }

  log(line: string) {
    try {
      const p = join(this.dirs.logs, 'main.log')
      writeFileSync(p, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' })
    } catch { /* 日志失败不阻塞 */ }
  }

  // ---------- 配置（带版本迁移） ----------
  getConfig(): AppConfig {
    type RawCfg = Partial<AppConfig> & Record<string, unknown>
    let raw: RawCfg = this.readJson<RawCfg>(this.dirs.config, {} as RawCfg)
    // 迁移链：v0(空/旧结构) -> v1
    const v = (raw as { schemaVersion?: number }).schemaVersion ?? 0
    if (v < 1) {
      raw = migrateV0toV1(raw) as RawCfg
      raw.schemaVersion = 1
      this.writeJson(this.dirs.config, raw)
    }
    return raw as AppConfig
  }

  setPrefs(prefs: Prefs) {
    const cfg = this.getConfig()
    cfg.prefs = prefs
    this.writeJson(this.dirs.config, cfg)
  }

  setAgents(agents: AppConfig['agents']) {
    const cfg = this.getConfig()
    cfg.agents = agents
    this.writeJson(this.dirs.config, cfg)
  }

  setWorkflowDefaults(wd: AppConfig['workflowDefaults']) {
    const cfg = this.getConfig()
    cfg.workflowDefaults = wd
    this.writeJson(this.dirs.config, cfg)
  }

  /** 导出配置：剥离一切敏感信息（API Key 只在凭据存储，本方法额外确保不含 keyId 明文密钥） */
  exportConfig(): string {
    const cfg = JSON.parse(JSON.stringify(this.getConfig())) as AppConfig
    for (const a of cfg.agents) {
      if (a.modelConfig) a.modelConfig.hasKey = false
    }
    return JSON.stringify({ ...cfg, exportedAt: new Date().toISOString(), note: 'API Key 不会被导出，导入后需重新填写' }, null, 2)
  }

  importConfig(json: string): { ok: boolean; message: string } {
    try {
      const incoming = JSON.parse(json) as Partial<AppConfig>
      if (!incoming || typeof incoming !== 'object') return { ok: false, message: '格式错误：不是有效 JSON 对象' }
      const merged = migrateV0toV1(incoming)
      merged.schemaVersion = CURRENT_SCHEMA_VERSION
      // 导入的 Agent 中 hasKey 一律重置为 false，需重新授权
      for (const a of merged.agents ?? []) {
        if (a.modelConfig) {
          a.modelConfig.hasKey = false
          a.status = 'disconnected'
        }
      }
      this.writeJson(this.dirs.config, merged)
      return { ok: true, message: '导入成功；API Key 需重新填写并测试连接' }
    } catch (e) {
      return { ok: false, message: `导入失败：${(e as Error).message}` }
    }
  }

  // ---------- 会话（v2 多会话：每 Agent 一个文件，内容为会话数组；旧单会话格式加载时自动迁移） ----------
  saveSessions(agentId: string, sessions: AgentSession[], activeId?: string) {
    this.writeJson(join(this.dirs.sessions, `${agentId}.json`), { v: 2, sessions, activeId })
  }

  loadSessions(agentId: string): { sessions: AgentSession[]; activeId?: string } | null {
    const raw = this.readJson<Record<string, unknown> | null>(join(this.dirs.sessions, `${agentId}.json`), null)
    if (!raw) return null
    if (Array.isArray(raw.sessions)) {
      const sessions = (raw.sessions as AgentSession[]).map((s) => ({
        ...s,
        id: s.id || `ses-${agentId}-migrated-${Math.random().toString(36).slice(2, 8)}`,
        title: s.title || '历史会话'
      }))
      return { sessions, activeId: typeof raw.activeId === 'string' ? raw.activeId : undefined }
    }
    // 旧 v1 单会话格式（顶层含 messages）：迁移为单元素数组
    if (Array.isArray(raw.messages)) {
      const legacy = raw as unknown as AgentSession
      const migrated: AgentSession = {
        ...legacy,
        id: legacy.id || `ses-${agentId}-legacy`,
        title: legacy.title || '历史会话',
        createdAt: legacy.createdAt ?? Date.now()
      }
      return { sessions: [migrated] }
    }
    return null
  }

  removeSession(agentId: string, deleteHistory: boolean) {
    // deleteHistory=false 时仅"移除连接"不动会话；此处只有 deleteHistory=true 才清空全部会话
    if (deleteHistory) {
      const p = join(this.dirs.sessions, `${agentId}.json`)
      if (existsSync(p)) writeFileSync(p, JSON.stringify({ v: 2, sessions: [], activeId: undefined }))
    }
  }

  // ---------- 工作流任务记录 ----------
  saveRun(run: WorkflowRun) {
    this.writeJson(join(this.dirs.runs, `${run.id}.json`), run)
  }

  listRuns(): WorkflowRun[] {
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const files = fs.readdirSync(this.dirs.runs) as string[]
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => this.readJson<WorkflowRun | null>(join(this.dirs.runs, f), null))
        .filter((r): r is WorkflowRun => !!r)
        .sort((a, b) => b.startedAt - a.startedAt)
    } catch {
      return []
    }
  }

  removeRun(id: string) {
    const p = join(this.dirs.runs, `${id}.json`)
    if (existsSync(p)) unlinkSync(p)
  }

  // ---------- 长期记忆 ----------
  getMemory(): MemoryEntry[] {
    return this.readJson<MemoryEntry[]>(this.dirs.memory, [])
  }

  setMemory(entries: MemoryEntry[]) {
    this.writeJson(this.dirs.memory, entries)
  }

  // ---------- 凭据（safeStorage 加密，绝不进日志/导出） ----------
  private readCredMap(): Record<string, string> {
    try {
      if (!existsSync(this.dirs.credentials)) return {}
      const buf = readFileSync(this.dirs.credentials)
      if (!safeStorage.isEncryptionAvailable()) {
        this.log('safeStorage 不可用，凭据功能受限')
        return {}
      }
      const plain = safeStorage.decryptString(buf)
      return JSON.parse(plain) as Record<string, string>
    } catch {
      return {}
    }
  }

  private writeCredMap(map: Record<string, string>) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持安全凭据存储')
    writeFileSync(this.dirs.credentials, safeStorage.encryptString(JSON.stringify(map)))
  }

  saveCredential(keyId: string, secret: string) {
    const map = this.readCredMap()
    map[keyId] = secret
    this.writeCredMap(map)
    this.log(`credential saved: ${keyId}`)
  }

  getCredential(keyId: string): string | null {
    return this.readCredMap()[keyId] ?? null
  }

  hasCredential(keyId: string): boolean {
    return keyId in this.readCredMap()
  }

  deleteCredential(keyId: string) {
    const map = this.readCredMap()
    delete map[keyId]
    this.writeCredMap(map)
    this.log(`credential deleted: ${keyId}`)
  }
}

/** v0 -> v1：补齐默认偏好与字段 */
function migrateV0toV1(raw: Partial<AppConfig> & Record<string, unknown>): AppConfig {
  const defaultPrefs: Prefs = {
    theme: 'system',
    animations: true,
    reducedMotion: false,
    replayWelcome: true,
    fontSize: 14,
    sidebarCollapsed: false,
    enterToSend: true,
    shiftWheelSwitch: true,
    firstRunDone: false,
    lastMode: null
  }
  const oldPrefs = ((raw.prefs ?? {}) as Partial<Prefs>) || {}
  return {
    schemaVersion: 1,
    prefs: { ...defaultPrefs, ...oldPrefs },
    agents: (raw.agents as AppConfig['agents']) ?? [],
    workflowDefaults: (raw.workflowDefaults as AppConfig['workflowDefaults']) ?? {
      plannerAgentId: '',
      executorAgentId: '',
      reviewerAgentId: '',
      reviewMode: 'human',
      maxRounds: 3,
      timeoutMin: 30,
      confirmEveryRound: false,
      maxTokens: 0
    }
  }
}
