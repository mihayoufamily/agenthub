import { app, safeStorage } from 'electron'
import { migrateV0toV1, migrateV1toV2, migrateV2toV3, normalizeImported, SCHEMA_HEAD, type McpConfigShape } from '../shared/config-migration'
import { join, dirname, basename, relative } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, renameSync, copyFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AppConfig, AgentSession, WorkflowRun, MemoryEntry, Prefs, Skill } from '../shared/types'
import { createZip, extractZip } from './zip'

/** 迁移链要处理的原始配置形状：可能有未知键，也可能缺字段，一切以"保留"为先 */
type RawCfg = Partial<AppConfig> & Record<string, unknown>

/**
 * 渲染层可控 ID（agentId / run.id）的路径闸门：这些 ID 直接拼进文件路径，`..\..` 一类串能逃出 userData。
 * 与 checkpoints.safeId 同口径（字符白名单 + 长度上限），另拒纯点串（`.`/`..`/`...` 是目录语义）。
 * 本仓威胁模型里渲染层不是可信方（与 ipc.ts model:chat"不接受渲染层自构造的 grant"同一原则），
 * store 是权威闸门，ipc 侧不重复校验。
 */
function safeFileId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) && !/^\.+$/.test(id)
}

interface StoreDirs {
  config: string
  sessions: string
  runs: string
  memory: string
  credentials: string
  logs: string
  skills: string
}

export class Store {
  dirs: StoreDirs
  /** userData 根目录：损坏备份扫描要覆盖根与三个子目录，构造时记下来免得各处再取 */
  rootDir: string

  constructor() {
    const base = app.getPath('userData')
    this.rootDir = base
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
      logs: logsDir,
      skills: join(base, 'skills.json')
    }
  }

  // ---------- 通用 JSON 读写 ----------
  private readJson<T>(p: string, fallback: T): T {
    try {
      if (!existsSync(p)) return fallback
      return JSON.parse(readFileSync(p, 'utf-8')) as T
    } catch {
      // 损坏保留：解析失败时把坏文件改名挪开（best-effort，挪不动也不报错），让用户有机会手工找回；
      // 不挪开的话，下一次任何写点（迁移回写/保存）都会把整份原数据覆盖掉。
      try { renameSync(p, `${p}.corrupt-${Date.now()}`) } catch { /* 文件被占用等：保留 fallback 语义即可 */ }
      // 取舍：应用不因一个坏文件拒启动——宁可空跑也不挡所有人进门，返回 fallback 照常起。
      return fallback
    }
  }

  private writeJson(p: string, data: unknown) {
    // 原子落盘：先写同目录临时文件再 rename 整体替换，防"写一半进程崩了/被杀了"留下半份 JSON，
    // 把整份 config/会话/记忆清零。断电级持久不是本层承诺（rename 前掉电仍可能是旧文件）。
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, p)
  }

  log(line: string) {
    try {
      const p = join(this.dirs.logs, 'main.log')
      // 上限 2MB，超了从头写起：主进程 console 也镜像到这里（见 index.ts），不设上限会无限长。
      try { if (statSync(p).size > 2 * 1024 * 1024) writeFileSync(p, '') } catch { /* 文件还不存在 */ }
      writeFileSync(p, `[${new Date().toISOString()}] ${String(line).slice(0, 2000)}\n`, { flag: 'a' })
    } catch { /* 日志失败不阻塞 */ }
  }

  // ---------- 损坏备份（readJson 解析失败时留下的 *.corrupt-<ts>）的发现与恢复 ----------
  /** 扫描范围：userData 根 + sessions/ runs/ logs/——readJson 落盘的所有 JSON 都在这四处 */
  private corruptScanDirs(): string[] {
    return [this.rootDir, this.dirs.sessions, this.dirs.runs, this.dirs.logs]
  }

  listCorruptBackups(): { corruptPath: string; originalPath: string; ts: number }[] {
    const out: { corruptPath: string; originalPath: string; ts: number }[] = []
    for (const dir of this.corruptScanDirs()) {
      let files: string[] = []
      try {
        files = readdirSync(dir) as string[]
      } catch { /* 目录不在了不算错：那里本来就没有备份 */ }
      for (const f of files) {
        // 贪婪匹配取最后一个 .corrupt-：正常文件名里再出现 ".corrupt-" 也按最后一段后缀算（与本写入端一致）
        const m = /^(.+)\.corrupt-(.*)$/.exec(f)
        if (!m) continue
        const ts = Number(m[2])
        out.push({ corruptPath: join(dir, f), originalPath: join(dir, m[1]), ts: Number.isFinite(ts) ? ts : 0 })
      }
    }
    // 按时间戳排序（解析不出按 0 排在最前）：顺序稳定，界面不必再排一遍
    return out.sort((a, b) => a.ts - b.ts)
  }

  restoreCorruptBackup(corruptPath: string): { ok: boolean; message: string } {
    // 安全闸 ①：路径非空且真实存在
    if (typeof corruptPath !== 'string' || !corruptPath.trim()) return { ok: false, message: '备份路径为空' }
    if (!existsSync(corruptPath)) return { ok: false, message: `备份文件不存在：${corruptPath}` }
    // 安全闸 ②：必须匹配 *.corrupt-<ts> 形态（basename 上判，目录部分交给下一道闸）
    const name = basename(corruptPath)
    const m = /^(.+)\.corrupt-[^\\/]*$/.exec(name)
    if (!m) return { ok: false, message: '不是损坏备份文件（应为 *.corrupt-<时间戳> 形态）' }
    const dir = dirname(corruptPath)
    const originalPath = join(dir, m[1])
    // 安全闸 ③：推导出的原路径必须与备份同目录（join(dir, …) 天然满足，这里显式复核，
    // 防未来有人改了推导逻辑引入目录跳转）；再加一道白名单：只允许动 userData 根与三个数据子目录，
    // 否则"任意 *.corrupt-* 文件覆盖任意同目录文件"会放大成对 userData 之外路径的覆盖写。
    if (dirname(originalPath) !== dir || !this.corruptScanDirs().includes(dir)) {
      return { ok: false, message: '备份路径不在本应用数据目录内，已拒绝恢复' }
    }
    // 恢复 = 用备份覆盖现有的原文件。覆盖前**不**校验现有文件是否可读——用户在界面上已确认要恢复，
    // 而它此刻大概率也是读不出来的坏文件，这正是恢复的意义；再多问一道只会把确认流程变成摆设。
    try {
      copyFileSync(corruptPath, originalPath)
    } catch (e) {
      return { ok: false, message: `恢复失败：${(e as Error).message}` }
    }
    // 改名 *.restored-<ts> 防止重复列出；挪不动（文件被占用等）也不回滚恢复本身，只如实说明
    try {
      renameSync(corruptPath, `${corruptPath}.restored-${Date.now()}`)
    } catch {
      return { ok: true, message: `已恢复到 ${originalPath}（备份标记改名失败，列表里可能仍会显示这条）` }
    }
    // 注意：恢复的是磁盘上的文件，内存里/启动时读走的还是旧内容——要重启应用才会重新读取
    return { ok: true, message: `已恢复到 ${originalPath}，重启应用后生效` }
  }

  // ---------- 配置（带版本迁移） ----------
  getConfig(): AppConfig {
    let raw: RawCfg = this.readJson<RawCfg>(this.dirs.config, {} as RawCfg)
    // 迁移链：v0(空/旧结构) -> v1 -> v2 -> v3。规则在 shared/config-migration.ts，这里只读写盘
    const v = (raw as { schemaVersion?: number }).schemaVersion ?? 0
    let changed = false
    if (v < 1) {
      raw = migrateV0toV1(raw)
      changed = true
    }
    if (v < 2) {
      raw = migrateV1toV2(raw as McpConfigShape) as RawCfg
      raw.schemaVersion = SCHEMA_HEAD
      changed = true
    }
    if (v < 3) {
      // 每一级都要单独过：只在 v<2 里顺手带上会把"已经是 v2 的配置"漏掉（本机就是这种）
      raw = migrateV2toV3(raw as unknown as Record<string, unknown>) as unknown as RawCfg
      raw.schemaVersion = SCHEMA_HEAD
      changed = true
    }
    if (changed) this.writeJson(this.dirs.config, raw)
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

  setPresets(list: AppConfig['presets']) {
    const cfg = this.getConfig()
    cfg.presets = list
    this.writeJson(this.dirs.config, cfg)
  }

  /** 定时任务整表（lastRunAt 记账也走这里，scheduler.ts 每次触发后写回） */
  setTaskSchedules(list: AppConfig['taskSchedules']) {
    const cfg = this.getConfig()
    cfg.taskSchedules = list
    this.writeJson(this.dirs.config, cfg)
  }

  /** 工作流剧本整表（与 setPresets 同一条"读整份 config、改一个键、写回"路径） */
  setTemplates(list: AppConfig['workflowTemplates']) {
    const cfg = this.getConfig()
    cfg.workflowTemplates = list
    this.writeJson(this.dirs.config, cfg)
  }

  /** 自定义单价覆盖：随 config 一起导出/导入，换机器不用重抄一遍价格 */
  setPriceOverrides(list: AppConfig['priceOverrides']) {
    const cfg = this.getConfig()
    cfg.priceOverrides = list
    this.writeJson(this.dirs.config, cfg)
  }

  setHooks(list: AppConfig['hooks']) {
    const cfg = this.getConfig()
    cfg.hooks = list
    this.writeJson(this.dirs.config, cfg)
  }

  setMcpServers(list: AppConfig['mcpServers']) {
    const cfg = this.getConfig()
    cfg.mcpServers = list
    this.writeJson(this.dirs.config, cfg)
  }

  /** 已全局停用的内置 MCP server id（内置组启停；写入方 ipc 已限定为已知内置 id） */
  setMcpBuiltinOff(list: AppConfig['mcpBuiltinOff']) {
    const cfg = this.getConfig()
    cfg.mcpBuiltinOff = list
    this.writeJson(this.dirs.config, cfg)
  }

  /**
   * 沙箱降级策略（设置 → 关于 三选）：走的就是这条既有配置路径——读整份 config、改一个键、写回。
   * 调用方（ipc.ts）已把值限定在 auto/ask/off，脏值进不来。
   */
  setSandboxFallback(policy: NonNullable<AppConfig['sandboxFallback']>) {
    const cfg = this.getConfig()
    cfg.sandboxFallback = policy
    this.writeJson(this.dirs.config, cfg)
    return cfg.sandboxFallback
  }

  /** 导出配置：剥离一切敏感信息（API Key 只在凭据存储，本方法额外确保不含 keyId 明文密钥） */
  exportConfig(): string {
    const cfg = JSON.parse(JSON.stringify(this.getConfig())) as AppConfig
    for (const a of cfg.agents) {
      if (a.modelConfig) a.modelConfig.hasKey = false
    }
    // MCP server 的 env 是第三方凭据（GitHub token 等）的存放位，与"配置导出不含任何秘密"的承诺冲突：
    // 保留键名（导入后知道要重填哪些）、值置空串；null/非对象元素原样透传（迁移层的既有口径）
    for (const s of cfg.mcpServers ?? []) {
      if (s && typeof s === 'object' && s.env && typeof s.env === 'object') {
        for (const k of Object.keys(s.env)) s.env[k] = ''
      }
    }
    return JSON.stringify({ ...cfg, exportedAt: new Date().toISOString(), note: 'API Key 不会被导出，导入后需重新填写；MCP server 的环境变量值已置空，导入后需重填' }, null, 2)
  }

  importConfig(json: string): { ok: boolean; message: string } {
    try {
      const incoming = JSON.parse(json) as Partial<AppConfig>
      if (!incoming || typeof incoming !== 'object') return { ok: false, message: '格式错误：不是有效 JSON 对象' }
      // 迁移只做"补齐结构 + 跑规则"，不再重建字面量（重建会把 mcpServers/presets/hooks/价格覆盖全丢掉）
      const merged = normalizeImported(migrateV0toV1(incoming as RawCfg)) as AppConfig
      merged.schemaVersion = SCHEMA_HEAD
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
    // ID 不合法直接 no-op：宁可不落这次会话，也不在任意路径建文件
    if (!safeFileId(agentId)) return
    this.writeJson(join(this.dirs.sessions, `${agentId}.json`), { v: 2, sessions, activeId })
  }

  loadSessions(agentId: string): { sessions: AgentSession[]; activeId?: string } | null {
    if (!safeFileId(agentId)) return null
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
    // ID 不合法 no-op：清空/写回都不该落到 userData 之外的路径
    if (!safeFileId(agentId)) return
    if (deleteHistory) {
      const p = join(this.dirs.sessions, `${agentId}.json`)
      if (existsSync(p)) writeFileSync(p, JSON.stringify({ v: 2, sessions: [], activeId: undefined }))
    }
  }

  // ---------- 工作流任务记录 ----------
  saveRun(run: WorkflowRun) {
    // run.id 来自渲染层，同 saveSessions 的闸门口径
    if (!safeFileId(run.id)) return
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
    if (!safeFileId(id)) return
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

  // ---------- Skill 提示包（Markdown 可复用；聊天引用注入） ----------
  getSkills(): Skill[] {
    const list = this.readJson<Skill[]>(this.dirs.skills, [])
    return Array.isArray(list) ? list : []
  }

  /** 保存（新增或更新同 id）；返回保存后的 Skill */
  saveSkill(skill: Skill): Skill {
    const list = this.getSkills()
    const i = list.findIndex((s) => s.id === skill.id)
    const next = { ...skill, updatedAt: Date.now() }
    if (i >= 0) list[i] = next
    else list.push(next)
    this.writeJson(this.dirs.skills, list)
    return next
  }

  removeSkill(id: string) {
    this.writeJson(this.dirs.skills, this.getSkills().filter((s) => s.id !== id))
  }

  // ---------- 整包迁移（换机导出/导入；与"配置导入/导出"的区别是连会话/任务/记忆一起带走） ----------
  /** 整包大小上限：会话与任务记录可能很大，超限如实拒绝而不是产出一份没人打得开的包 */
  private static readonly BUNDLE_MAX_BYTES = 200 * 1024 * 1024
  /** 记忆条数上限：与渲染层 settings.ts 的 MAX_MEMORY 同一条规则，合并后照旧截最近 300 条 */
  private static readonly MEMORY_MAX = 300

  /**
   * 打包整包到 savePath（对话框在 ipc 侧已选好）。包里含：config.json、memory.json、skills.json、
   * approvals.json、sessions/ 全部、runs/ 全部。
   * **刻意排除 credentials.enc**：safeStorage 加密绑定原机器的 Windows 用户，换机解不开，
   * 打进包只会给收包人一个永远解不开的文件——API Key 不随包迁移，导入后需重填
   * （与"配置导出不含 Key"同一口径）。logs/ 是本机排障信息，不进包。
   * 条目名用相对路径（'config.json'、'sessions/<file>'），createZip/extractZip 的约定见 main/zip.ts。
   */
  exportBundle(savePath: string): { ok: boolean; message: string } {
    if (typeof savePath !== 'string' || !savePath.trim()) return { ok: false, message: '保存路径为空' }
    type BundleEntry = { name: string; data: Buffer }
    const entries: BundleEntry[] = []
    // 根目录四份 JSON：不存在就跳过（新装机器可能还没有 memory/skills），不为凑齐造假文件
    for (const f of ['config.json', 'memory.json', 'skills.json', 'approvals.json']) {
      const p = join(this.rootDir, f)
      if (existsSync(p)) entries.push({ name: f, data: readFileSync(p) })
    }
    const collectDir = (dir: string, prefix: string) => {
      try {
        for (const f of readdirSync(dir) as string[]) {
          if (!f.endsWith('.json')) continue
          const p = join(dir, f)
          if (!statSync(p).isFile()) continue
          entries.push({ name: `${prefix}/${f}`, data: readFileSync(p) })
        }
      } catch { /* 目录读不到（不存在/被占用）就少打这部分：导出尽力而为，回执里不含它 */ }
    }
    collectDir(this.dirs.sessions, 'sessions')
    collectDir(this.dirs.runs, 'runs')
    const total = entries.reduce((n, e) => n + e.data.length, 0)
    if (total > Store.BUNDLE_MAX_BYTES) {
      return { ok: false, message: `整包大小 ${(total / 1024 / 1024).toFixed(0)}MB，超过 200MB 上限，已停止导出（请清理旧任务记录后再试）` }
    }
    if (!entries.some((e) => e.name === 'config.json')) {
      return { ok: false, message: '导出失败：config.json 不存在，本包不会是可导入的整包' }
    }
    try {
      writeFileSync(savePath, createZip(entries))
      return {
        ok: true,
        message: `已导出 ${entries.length} 个文件到 ${savePath}。API Key 不随包迁移（系统加密绑定原机器），导入后需重填`
      }
    } catch (e) {
      return { ok: false, message: `导出失败：${(e as Error).message}` }
    }
  }

  /**
   * 导入整包（zipPath 来自 openDialog）。五类数据各有策略：
   *  - config.json = 替换（复用 importConfig 的迁移链与 hasKey 重置；覆盖前先留档 config.pre-import-<时间戳>.json，
   *    与"损坏保留"同款机制——替换式导入必须留退路）；
   *  - sessions/、runs/ = 按文件名合并（id 即文件名，同名覆盖、新号新增，天然去重；文件名过 safeFileId 闸门，
   *    与本仓 saveSessions/saveRun 同一条"渲染层可控 ID 不拼进任意路径"的红线）；
   *  - memory.json = 合并（按条目 id 去重取并集，超 300 条截最近的）；
   *  - skills.json = 合并（按 skill id，同 id 用导入的覆盖——用户明确导入就是要它）；
   *  - approvals.json = 替换（白名单/MCP 信任是机器无关的决策记录，整体替换最可预期；config 备份已覆盖回退需求）。
   * 全部落盘的是**磁盘文件**，运行中已读进内存的 store 实例不会自动重读——重启应用才生效，回执里如实说明。
   */
  importBundle(zipPath: string): { ok: boolean; message: string; counts?: { sessions: number; runs: number; memory: number; skills: number } } {
    if (typeof zipPath !== 'string' || !zipPath.trim()) return { ok: false, message: 'zip 路径为空' }
    if (!existsSync(zipPath)) return { ok: false, message: `文件不存在：${zipPath}` }
    // 解到独立临时目录（zip-slip 防护在 extractZip 内：词法拒 `..`/盘符/绝对路径 + 解析后前缀复核）
    const tmp = mkdtempSync(join(tmpdir(), 'agenthub-import-'))
    try {
      const zipBuf = readFileSync(zipPath)
      const { files, skipped } = extractZip(zipBuf, tmp)
      // skipped 里可能有恶意条目（zip-slip / 加密 / CRC 不符）：有 config.json 就继续，否则如实拒绝。
      // 不因个别脏条目拒收整包——但也不能假装什么都没发生，回执里点出数量。
      const relOf = (abs: string) => relative(tmp, abs).replace(/\\/g, '/')
      const byRel = new Map<string, string>()
      for (const f of files) byRel.set(relOf(f), f)
      const configPath = byRel.get('config.json')
      if (!configPath) {
        const note = skipped.length ? `（另有 ${skipped.length} 个条目被拒收）` : ''
        return { ok: false, message: `不是 AgentHub 整包：包里没有 config.json${note}` }
      }
      // config.json 必须能解析成对象才认（整包身份校验的最小门槛；迁移与归一化交给 importConfig 的既有链）
      let configText: string
      try {
        configText = readFileSync(configPath, 'utf-8')
        const parsed = JSON.parse(configText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是 JSON 对象')
      } catch {
        return { ok: false, message: '不是 AgentHub 整包：config.json 无法解析' }
      }
      const counts = { sessions: 0, runs: 0, memory: 0, skills: 0 }

      // --- config：替换（先留档再导入） ---
      try {
        if (existsSync(this.dirs.config)) copyFileSync(this.dirs.config, `${this.dirs.config}.pre-import-${Date.now()}`)
      } catch { /* 留档挪不动（被占用等）不挡导入本身：importConfig 的原子写仍在 */ }
      const cfgRes = this.importConfig(configText)
      if (!cfgRes.ok) return { ok: false, message: `导入失败（config）：${cfgRes.message}` }

      // --- sessions/、runs/：按文件名合并 ---
      const mergeDir = (prefix: string, dest: string): number => {
        let n = 0
        for (const [rel, abs] of byRel) {
          // 只收单层 <id>.json：子目录结构不是本仓任何落盘路径产生的，来路不明的一律不收
          if (!rel.startsWith(`${prefix}/`) || !rel.endsWith('.json')) continue
          if (rel.slice(prefix.length + 1).includes('/')) continue
          const id = basename(rel).slice(0, -'.json'.length)
          if (!safeFileId(id)) continue
          try {
            copyFileSync(abs, join(dest, `${id}.json`))
            n += 1
          } catch { /* 单个文件复制失败不中断整包：回执里的数字是真实收下的数 */ }
        }
        return n
      }
      counts.sessions = mergeDir('sessions', this.dirs.sessions)
      counts.runs = mergeDir('runs', this.dirs.runs)

      // --- memory：按条目 id 合并（导入的覆盖同 id），超上限截最近 ---
      const memPath = byRel.get('memory.json')
      if (memPath) {
        try {
          const incoming = JSON.parse(readFileSync(memPath, 'utf-8')) as unknown
          if (Array.isArray(incoming)) {
            const valid = incoming.filter((m): m is MemoryEntry => !!m && typeof m === 'object' && typeof (m as MemoryEntry).id === 'string')
            const map = new Map(this.getMemory().map((m) => [m.id, m]))
            for (const m of valid) map.set(m.id, m)
            const merged = [...map.values()]
              .sort((a, b) => (a.ts || 0) - (b.ts || 0))
              .slice(-Store.MEMORY_MAX)
            this.setMemory(merged)
            counts.memory = valid.length
          }
        } catch { /* memory.json 坏了不影响其它类：少合这一类，回执数字如实反映 */ }
      }

      // --- skills：按 skill id 合并，同 id 用导入的覆盖 ---
      const skillsPath = byRel.get('skills.json')
      if (skillsPath) {
        try {
          const incoming = JSON.parse(readFileSync(skillsPath, 'utf-8')) as unknown
          if (Array.isArray(incoming)) {
            const valid = incoming.filter((s): s is Skill => !!s && typeof s === 'object' && typeof (s as Skill).id === 'string')
            const map = new Map(this.getSkills().map((s) => [s.id, s]))
            for (const s of valid) map.set(s.id, s)
            this.writeJson(this.dirs.skills, [...map.values()])
            counts.skills = valid.length
          }
        } catch { /* 同 memory：单类损坏不拖累整包 */ }
      }

      // --- approvals：整体替换（原子写同 approvals.ts 的 tmp+rename 口径） ---
      const approvalsPath = byRel.get('approvals.json')
      if (approvalsPath) {
        try {
          const text = readFileSync(approvalsPath, 'utf-8')
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const dest = join(this.rootDir, 'approvals.json')
            const tmpFile = `${dest}.tmp`
            writeFileSync(tmpFile, JSON.stringify(parsed, null, 2), 'utf-8')
            renameSync(tmpFile, dest)
          }
        } catch { /* 审批文件不合也不拖累整包：白名单保持现状（原文件没被碰过） */ }
      }

      const skippedNote = skipped.length ? `；${skipped.length} 个异常条目被拒收` : ''
      return {
        ok: true,
        counts,
        message:
          `导入完成：会话 ${counts.sessions} 个、任务 ${counts.runs} 条、记忆 ${counts.memory} 条、技能 ${counts.skills} 个；` +
          `审批白名单已替换${skippedNote}。API Key 不随包迁移，导入后需重填。需要重启应用生效。`
      }
    } catch (e) {
      return { ok: false, message: `导入失败：${(e as Error).message}` }
    } finally {
      // 临时目录清不干净不算失败（Windows 上文件句柄未释放时 rm 会 EBUSY）：best-effort
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 留在 %TEMP% 下次自清 */ }
    }
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
    // 与 writeJson 同一道原子替换：凭据文件写一半被杀，损失的是整份凭据表
    const tmp = `${this.dirs.credentials}.tmp`
    writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(map)))
    renameSync(tmp, this.dirs.credentials)
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

