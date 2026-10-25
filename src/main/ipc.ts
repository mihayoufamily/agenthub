import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { join, isAbsolute } from 'node:path'
import { readFile, stat, readdir } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import type { Store } from './store'
import { scanAgents, checkManualPath } from './discovery'
import * as openai from './adapters/openai'
import * as cli from './adapters/cli'
import type { CustomModelConfig, AgentSession, WorkflowRun, Prefs, AgentConfig, AppConfig, ToolGrant, Skill, PriceOverride, ApprovalDecision, HookRule, McpServer, TaskSchedule, WorkflowTemplate, MemoryEntry } from '../shared/types'
import { configurePriceOverrides, partitionPriceOverrides } from '../shared/overrides'
import { partitionHookRules, sanitizeHookList } from '../shared/hooks'
import { sanitizeMcpList, partitionMcpServers } from '../shared/mcp-list'
import { normalizePolicy, VERIFY_SWITCH } from '../shared/compat'
import { execTool, toolDefs, sandboxPath, isNonPublicHost, safeWebUrl, type CommandApprover } from './tools'
import { isValidImageSrc, isRemoteImageSrc } from '../shared/message-images'
import * as approvals from './approvals'
import * as mcp from './mcp'
import * as checkpoints from './checkpoints'
import * as scheduler from './scheduler'
import { readConventions } from './conventions'
import { buildRepoMap } from './repomap'
import { checkUpdate, downloadPortable, isDownloading, updatesDir, stagedStatus, applyStagedUpdate } from './updater'
import * as ledger from './ledger'
import { setBusy } from './lifecycle'
import type { LedgerEntry } from './ledger'
// 技能中心内核：frontmatter 解析的全仓唯一实现也在这里（本文件原先那一份已挪入，不许出现第二份）
import * as market from './market'
// 官方模型服务注册表：内置"官方模型"入口的数据源（端点+清单来自注册表仓库，不写死在代码里）
import * as officialModels from './official-models'

/**
 * 工作流产物目录（主进程唯一口径）：用户在设置里选的目录；未选则默认文档目录下的 AgentHub-artifacts。
 * 渲染层不参与拼接，避免"界面显示的目录"与"实际写入的目录"不一致。
 */
export function workflowOutDir(getStore: () => Store): string {
  const { app } = require('electron') as typeof import('electron')
  const saved = getStore().getConfig().workflowDefaults?.outputDir?.trim()
  if (saved) return saved
  try {
    return join(app.getPath('documents'), 'AgentHub-artifacts')
  } catch {
    return ''
  }
}

// Agent Skills 的 frontmatter 解析已挪到 main/market.ts（parseSkillFrontmatter，全仓唯一实现）：
// 技能中心要扫内置技能与解包市场技能，两处都要同一套解析，留两份实现必然漂移。

// ---------- 工作流剧本的形状闸门（与 scheduler.partitionSchedules 同一口径，只是更轻） ----------
/** 读路径：滤掉手改 config.json 塞进来的 null/非对象，不让剧本列表的 .map 解引用炸掉设置页 */
function sanitizeTemplates(raw: unknown): WorkflowTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is WorkflowTemplate => !!t && typeof t === 'object')
}
/** 写路径：name/goalTemplate 非空才收，其余字段补形/收窄；脏条目点名拒收（不静默丢） */
function partitionTemplates(list: unknown): { kept: WorkflowTemplate[]; rejected: { id: string; message: string }[] } {
  const kept: WorkflowTemplate[] = []
  const rejected: { id: string; message: string }[] = []
  if (!Array.isArray(list)) return { kept, rejected: [{ id: '#', message: 'templates:set 只接受数组' }] }
  for (let i = 0; i < list.length; i++) {
    const t = list[i] as Partial<WorkflowTemplate> | null
    const at = t && typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `#${i}`
    if (!t || typeof t !== 'object') { rejected.push({ id: at, message: '不是对象' }); continue }
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    const goal = typeof t.goalTemplate === 'string' ? t.goalTemplate.trim() : ''
    if (!name) { rejected.push({ id: at, message: '名称为空' }); continue }
    if (!goal) { rejected.push({ id: at, message: '目标模板为空' }); continue }
    if (kept.length >= 50) { rejected.push({ id: at, message: '已到 50 条上限，这一条没有保存' }); continue }
    kept.push({
      id: at.slice(0, 64),
      name: name.slice(0, 40),
      goalTemplate: goal.slice(0, 8000),
      ...(typeof t.presetId === 'string' && t.presetId.trim() ? { presetId: t.presetId.trim().slice(0, 64) } : {}),
      ...(t.planFirst === true ? { planFirst: true } : {}),
      createdAt: typeof t.createdAt === 'number' && Number.isFinite(t.createdAt) ? t.createdAt : Date.now()
    })
  }
  return { kept, rejected }
}

/** 账本采集：在事件出口统计耗时/事件数/usage/错误，done|error 时落一条脱敏记录 */
function ledgerTap(meta: Omit<LedgerEntry, 'ts' | 'ok' | 'ms' | 'events'>) {
  const t0 = Date.now()
  let events = 0
  let usage: { tokens?: number; prompt?: number; completion?: number } | undefined
  let errMsg: string | undefined
  let wrote = false
  return (ev: openai.ChatChunkEvent) => {
    events++
    if (ev.type === 'usage' && ev.usage) usage = ev.usage
    if (ev.type === 'error') errMsg = ev.message
    if (ev.type !== 'done' && ev.type !== 'error') return
    if (wrote) return
    wrote = true
    ledger.record({
      ...meta,
      ts: t0,
      ok: ev.type === 'done' && !errMsg,
      ms: Date.now() - t0,
      events,
      ...(usage?.tokens ? { tokens: usage.tokens } : {}),
      ...(usage?.prompt ? { prompt: usage.prompt } : {}),
      ...(usage?.completion ? { completion: usage.completion } : {}),
      ...(errMsg ? { error: errMsg.slice(0, 300) } : {})
    })
  }
}

/** baseUrl → harness 标识（账本按接入方分组，比整条 URL 好读） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return baseUrl.slice(0, 40) || '未知接入方'
  }
}

/** 注册全部 IPC 通道。getStore/getWin 为延迟引用，避免初始化顺序问题。 */
export function registerIpc(getStore: () => Store, getWin: () => BrowserWindow | null) {
  /** reqId -> 关掉这条请求的 MCP 连接；流结束、报错、取消都要收掉，不留后台进程 */
  const mcpSessions = new Map<string, () => void>()

  /**
   * 命令审批闸门：判定与裁决都在主进程，界面只是"问一个人"的通道。
   * 请求走 model:event 的 approval 事件下发，点完由 approval:decide 回来落地。
   */
  const makeApprover = (
    reqId: string,
    ctx: { agentId?: string; agentName?: string; dir: string }
  ): CommandApprover => ({
    rules: () => approvals.rulesFor(ctx.agentId),
    ask: (info) =>
      approvals.requestApproval(
        {
          id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          reqId,
          tool: info.tool,
          command: info.command,
          dir: ctx.dir,
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
          reason: info.reason,
          uncovered: info.uncovered,
          ts: Date.now(),
          // 写前预览：一次覆盖一次问，"始终允许"对白名单型裁决没有意义
          ...(info.kind ? { kind: info.kind } : {}),
          ...(info.diff ? { diff: info.diff } : {})
        },
        (req) => getWin()?.webContents.send('model:event', { reqId, type: 'approval', approval: req })
      )
  })

  // ---------- 应用信息 ----------
  const { app } = require('electron')

  // ---------- 技能中心（市场）内核注入 ----------
  // builtinDir 由 app.getAppPath() 推：packaged 时是 <便携根>/resources/app/builtin-skills，
  // dev 时是仓库根/builtin-skills，两种形态都对。存储访问收窄成两个动作注入，见 market.ts。
  market.init(join(app.getAppPath(), 'builtin-skills'), app.getPath('userData'))
  officialModels.initOfficialModels(app.getPath('userData'))
  // 内置 MCP 基础组的记忆工具绑定到既有长期记忆存储（memory.json，与 memory:get/set 同一份）
  mcp.bindBuiltinMemory({
    get: () => getStore().getMemory(),
    add: (text, kind) => {
      const list = getStore().getMemory()
      const entry: MemoryEntry = {
        id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        kind, text, ts: Date.now(), editable: true
      }
      getStore().setMemory([...list, entry])
      return entry
    }
  })
  market.bindStore({ getSkills: () => getStore().getSkills(), saveSkill: (s) => getStore().saveSkill(s) })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `Windows ${process.getSystemVersion()}`,
    userDataPath: app.getPath('userData')
    // documentsPath 已删：渲染层零消费（Grep 过 src/renderer 无引用），AppInfo 类型同步删字段
  }))

  ipcMain.handle('app:openDataFolder', () => {
    shell.openPath(app.getPath('userData'))
  })

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })

  // ---------- 更新检查与开机自启 ----------
  ipcMain.handle('update:check', (_e, manual: boolean) => checkUpdate(manual === true))

  /**
   * 下载便携更新包：只下载与校验哈希，绝不执行/替换（承诺写进了 UI 文案）。
   * 下载是长任务，invoke 立即返回 {ok}；进度与完成/失败经 update:event 推送，渲染层订阅。
   */
  ipcMain.handle('update:download', () => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    // 重复调用在入口就拒（inFlight 闸门在 updater 模块内，防两个流写同一个文件）
    if (isDownloading()) return { ok: false, message: '已有下载在进行中，请等待完成' }
    void downloadPortable((p) => win.webContents.send('update:event', p))
      .then((r) => win.webContents.send('update:event', r))
      .catch((e) => win.webContents.send('update:event', { type: 'error', message: (e as Error)?.message ?? String(e) }))
    return { ok: true }
  })

  ipcMain.handle('update:openDownloadDir', async () => {
    // 打开下载目录前确保它存在：目录从未下载过时 openPath 会对不存在的路径报错
    const dir = updatesDir()
    try { mkdirSync(dir, { recursive: true }) } catch { /* 建不出就按原样 open，让 shell 报真实错误 */ }
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err } : { ok: true }
  })

  /** 已暂存待应用的更新（staged.json）；没有则 null。横幅挂载时查一次，有就进「应用更新」态 */
  ipcMain.handle('update:stagedStatus', () => stagedStatus())

  /**
   * 一键应用已暂存的更新：主进程立刻热交换 resources/app（只支持便携版明文目录，dev/asar 在
   * updater 内拒绝）。成功后延迟 1.5s 再 relaunch——留时间让渲染层把"更新完成，即将重启"的
   * 提示真正画出来；热交换失败不算异常出口：updater 已写 pending 标记，下次启动早期自动补做。
   */
  ipcMain.handle('update:apply', () => {
    // 下载还在写盘时不允许换入：staged 可能正被新一轮下载重建，换进去的是半成品
    if (isDownloading()) return { ok: false, message: '正在下载更新包，请等待完成后再应用' }
    const r = applyStagedUpdate()
    if (r.ok && r.relaunch) {
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 1500)
    }
    return r
  })

  ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('autostart:set', (_e, on: boolean) => {
    // openAtLogin 指向当前可执行文件（便携版即 exe 本身）
    app.setLoginItemSettings({ openAtLogin: on === true, path: process.execPath })
    return app.getLoginItemSettings().openAtLogin
  })

  // ---------- 配置 ----------
  ipcMain.handle('config:get', () => getStore().getConfig())
  ipcMain.handle('prefs:set', (_e, prefs: Prefs) => getStore().setPrefs(prefs))
  // 运行时形状闸门：这里的 TS 类型只是编译期装饰，渲染层 invoke('agents:set', null) 会把
  // `agents: null` 写进 config.json，后续 exportConfig 的 for-of 与设置页当场崩。回执口径同 config:importJson。
  ipcMain.handle('agents:set', (_e, agents: AgentConfig[]) => {
    if (!Array.isArray(agents)) return { ok: false, message: 'agents:set 只接受数组' }
    getStore().setAgents(agents)
    return { ok: true }
  })
  ipcMain.handle('workflowDefaults:set', (_e, wd: AppConfig['workflowDefaults']) => getStore().setWorkflowDefaults(wd))
  ipcMain.handle('presets:set', (_e, list: AppConfig['presets']) => getStore().setPresets(list))

  // ---------- 定时任务（调度内核在 main/scheduler.ts，纯计算；这里只做通道与接线） ----------
  ipcMain.handle('schedule:list', () => scheduler.sanitizeSchedules(getStore().getConfig().taskSchedules))
  ipcMain.handle('schedule:set', (_e, list: TaskSchedule[]) => {
    // 形状闸门在 scheduler.partitionSchedules（逻辑层可断言）：goal 非空、kind 合法、
    // time 为 HH:mm、weekly 的 weekday 0-6、interval ≥5；脏数据点名拒收回界面，不静默丢
    const { kept, rejected } = scheduler.partitionSchedules(list)
    getStore().setTaskSchedules(kept)
    return { ok: true, list: kept, rejected }
  })
  ipcMain.handle('schedule:remove', (_e, id: string) => {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, message: 'id 必须是非空字符串' }
    getStore().setTaskSchedules(scheduler.sanitizeSchedules(getStore().getConfig().taskSchedules).filter((s) => s.id !== id.trim()))
    return { ok: true }
  })

  // ---------- 工作流剧本（templates）：轻闸门——goalTemplate 是会进提示词的文本，只拦形状不拦内容 ----------
  ipcMain.handle('templates:get', () => sanitizeTemplates(getStore().getConfig().workflowTemplates))
  ipcMain.handle('templates:set', (_e, list: WorkflowTemplate[]) => {
    const { kept, rejected } = partitionTemplates(list)
    getStore().setTemplates(kept)
    return { ok: true, list: kept, rejected }
  })

  // 调度器接线（每 tick 现读 store 配置，设置页保存后下一拍即生效）：
  // fire 经 scheduler:fire 推给渲染层，由 App.tsx → workflow.startScheduled 起链/排队；
  // lastRunAt 记账由 main 侧直接写 store，不依赖渲染层回执（窗口隐藏到托盘时事件照样可达，
  // 窗口不可用时事件丢弃——那一拍的任务按"没开成"算，如实不补）
  scheduler.init({
    getConfig: () => getStore().getConfig(),
    fire: (s) => getWin()?.webContents.send('scheduler:fire', s),
    setSchedules: (list) => getStore().setTaskSchedules(list)
  })

  /**
   * 沙箱降级策略（设置 → 关于）。值域在主进程限定死，不接受界面以外的形状：
   * 这条改的是"崩溃时要不要替你关掉 Chromium 沙箱"，写进一个没定义的值等于把降级行为变成未知状态。
   */
  ipcMain.handle('sandboxFallback:set', (_e, policy: unknown) => {
    const cur = normalizePolicy(getStore().getConfig().sandboxFallback)
    if (policy !== 'auto' && policy !== 'ask' && policy !== 'off') {
      return { ok: false as const, policy: cur, message: '降级策略只能是 自动降级 / 每次问我 / 不自动降级 三者之一（未写入）' }
    }
    return { ok: true as const, policy: getStore().setSandboxFallback(policy) }
  })

  // ---------- 调用账本（脱敏元数据；用量统计与排障共用一份数据源） ----------
  ipcMain.handle('ledger:list', (_e, limit?: number) => ledger.list(limit ?? 200))
  ipcMain.handle('ledger:stats', (_e, sinceTs?: number) => ledger.aggregate(ledger.list(100000).filter((e) => !sinceTs || e.ts >= sinceTs)))
  ipcMain.handle('ledger:costSince', (_e, sinceTs: number, runId?: string) => ledger.costSince(Number(sinceTs) || 0, runId))
  ipcMain.handle('ledger:clear', () => {
    ledger.clear()
    return { ok: true }
  })
  ipcMain.handle('ledger:export', async () => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showSaveDialog(win, {
      title: '导出调用账本（只含元数据：耗时/token/错误信息，不含正文与凭据）',
      defaultPath: `agenthub-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl', 'txt'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    try {
      writeFileSync(r.filePath, ledger.dump(), 'utf-8')
      return { ok: true, message: r.filePath }
    } catch (e) {
      return { ok: false, message: `写入失败：${(e as Error).message}` }
    }
  })

  /**
   * 后台任务完成/失败的系统通知：窗口正聚焦时不打扰（界面里已经看得见），
   * 最小化、隐藏到托盘或切去别的应用时才会弹；点通知把窗口叫回来。
   */
  ipcMain.handle('app:notify', (_e, title: string, body: string) => {
    const win = getWin()
    if (win && win.isFocused() && win.isVisible()) return { ok: true, skipped: true }
    const { Notification } = require('electron') as typeof import('electron')
    if (!Notification.isSupported()) return { ok: false, message: '系统通知不可用' }
    try {
      const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 220) })
      n.on('click', () => {
        const w = getWin()
        if (!w) return
        if (!w.isVisible()) w.show()
        w.focus()
      })
      n.show()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  /** 渲染层上报"有工作流正在执行"：主进程据此决定关闭要不要弹确认 */
  ipcMain.handle('app:setBusy', (_e, busy: boolean) => {
    setBusy(!!busy)
    return { ok: true }
  })

  /** 当前应用菜单的加速键清单（验证脚本据此确认 Ctrl+R 刷新等默认键已不再注册） */
  // ---------- MCP server（tools-only，stdio） ----------
  // mcp:list 只放行形状正确的记录（sanitizeMcpList 可断言）：迁移层刻意把脏元素原样透传，
  // 手改 config.json 的 null 不该活到渲染层被解引用炸掉设置页/ChatView。
  // 内置基础组由主进程合成在最前（只读；sanitize 会剥掉存储里任何伪造 builtin 字段的条目）。
  ipcMain.handle('mcp:list', () => [mcp.BUILTIN_MCP_BASIC, ...sanitizeMcpList(getStore().getConfig().mcpServers)])
  ipcMain.handle('mcp:set', (_e, list: McpServer[]) => {
    // 闸门抽到 shared/mcp-list.partitionMcpServers（逻辑层可断言）：形状判定 + 条数上限 + 补形打标，
    // 被拒的条目一律点名回界面（rejected），不再由 .slice 静默丢掉第 21 条。
    const { kept, rejected } = partitionMcpServers(list)
    getStore().setMcpServers(kept)
    // 删掉的 server 要把信任一起清掉：留着一条没人认领的信任，将来同 id 复用就自动放行了
    const keep = new Set(kept.map((s) => s.id))
    for (const id of approvals.mcpTrusted()) if (!keep.has(id)) approvals.setMcpTrust(id, false)
    return { ok: true, list: kept, rejected }
  })
  ipcMain.handle('mcp:probe', (_e, server: McpServer) => mcp.probeServer(server))
  ipcMain.handle('mcp:trust', () => approvals.mcpTrusted())
  ipcMain.handle('mcp:trust:set', (_e, id: string, trusted: boolean) => ({ ok: true, list: approvals.setMcpTrust(String(id ?? ''), !!trusted) }))

  // ---------- 工具 Hook（用户在设置里配置） ----------
  // 读路径的形状闸门（复审 Out-of-Scope 里点出的：hooks:list 原样返回整表，手改 config.json 塞个
  // null 会让设置页 rules.map 当场解引用炸掉，比"存了但看不见"更糟）。与 mcp:list 同一口径：
  // 读的时候滤掉非对象，写的时候由 partitionHookRules 点名拒收。
  ipcMain.handle('hooks:list', () => sanitizeHookList(getStore().getConfig().hooks))
  ipcMain.handle('hooks:set', (_e, list: HookRule[]) => {
    // 闸门抽到 shared/hooks.partitionHookRules（内部逐条跑 validateHook(h)，逻辑层可断言）：
    // 校验不通过的条目**原样留在配置里**（不删用户数据），只把原因回给界面点名显示。
    // 旧写法 `.filter((h) => …ok).slice(0, 40)` 对整表重校验，用户拨一下任意一个开关，
    // 一条 >4096 字符的旧规则就地消失且没人告诉他。
    const { kept, rejected } = partitionHookRules(list)
    getStore().setHooks(kept)
    return { ok: true, list: kept, rejected }
  })

  // ---------- 自定义单价（覆盖内置表；随配置导出导入） ----------
  ipcMain.handle('prices:get', () => getStore().getConfig().priceOverrides ?? [])
  ipcMain.handle('prices:set', (_e, list: PriceOverride[]) => {
    // 闸门抽到 shared/overrides.partitionPriceOverrides（逻辑层可断言）：空模式与条数截断以前都是静默丢
    const { kept, rejected } = partitionPriceOverrides(list)
    getStore().setPriceOverrides(kept)
    configurePriceOverrides(kept)
    return { ok: true, list: kept, rejected }
  })

  ipcMain.handle('app:menuSummary', () => {
    const { Menu } = require('electron') as typeof import('electron')
    const out: string[] = []
    const walk = (items: Electron.MenuItem[] | undefined) => {
      for (const it of items ?? []) {
        if (it.accelerator) out.push(it.accelerator)
        if (it.submenu) walk((it.submenu as Electron.Menu).items)
      }
    }
    walk(Menu.getApplicationMenu()?.items)
    return { accelerators: out, custom: Menu.getApplicationMenu() !== null }
  })

  ipcMain.handle('config:export', async () => {
    const json = getStore().exportConfig()
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showSaveDialog(win, {
      title: '导出配置（不含 API Key）',
      defaultPath: 'agenthub-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    const fs = await import('node:fs')
    fs.writeFileSync(r.filePath, json, 'utf-8')
    return { ok: true, message: r.filePath }
  })

  ipcMain.handle('config:import', async () => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showOpenDialog(win, {
      title: '导入配置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, message: '已取消' }
    const fs = await import('node:fs')
    const json = fs.readFileSync(r.filePaths[0], 'utf-8')
    return getStore().importConfig(json)
  })

  /**
   * 程序化导入：只为 verify/approval-shot.mjs 的导入往返断言存在（文件选择弹窗无法被 CDP 驱动，
   * 真导入路径 store.importConfig 只能从这里进）。它是**整份配置替换**，比任何 set* 通道都宽，
   * 所以收两道闸（评审修复4）：
   * ① 只在 argv 带验证开关 --ahub-verify 时注册（app.isPackaged 不能当闸门——被测的部署构建本来就是
   *   packaged；生产路径没有界面入口，但通道在就可达，索性不在）；
   * ② 入口先拒非字符串与超限 payload：旧写法 String(json ?? '') 会把任意大的字符串（甚至数字/对象）
   *   塞进主线程 JSON.parse，没有边界。与 config:import 同一个 importConfig，无额外能力，只有额外收敛。
   */
  if (process.argv.includes(VERIFY_SWITCH)) {
    const MAX_IMPORT_JSON = 8 * 1024 * 1024
    ipcMain.handle('config:importJson', (_e, json: unknown) => {
      if (typeof json !== 'string') return { ok: false, message: 'config:importJson 只接受字符串参数' }
      if (json.length > MAX_IMPORT_JSON) return { ok: false, message: `导入内容超过 ${Math.round(MAX_IMPORT_JSON / 1024 / 1024)}MB 上限，已拒收（未解析、未写盘）` }
      return getStore().importConfig(json)
    })
  }

  // ---------- 损坏备份（*.corrupt-<ts>）的发现与恢复 ----------
  ipcMain.handle('data:corruptList', () => getStore().listCorruptBackups())
  ipcMain.handle('data:corruptRestore', (_e, corruptPath: unknown) => {
    // 这里只挡"非空字符串"这一层入口形状；路径形态/目录白名单闸门都在 store.restoreCorruptBackup
    if (typeof corruptPath !== 'string' || !corruptPath.trim()) return { ok: false, message: 'corruptPath 必须是非空字符串' }
    return getStore().restoreCorruptBackup(corruptPath)
  })

  // ---------- 整包迁移（换机导出/导入）：对话框在本侧，渲染层只发意图不带路径 ----------
  ipcMain.handle('data:exportBundle', async () => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showSaveDialog(win, {
      title: '导出整包（换机迁移；不含 API Key）',
      defaultPath: `agenthub-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'AgentHub 整包', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    return getStore().exportBundle(r.filePath)
  })
  ipcMain.handle('data:importBundle', async () => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showOpenDialog(win, {
      title: '导入整包（会覆盖/合并现有数据；导入后需重启应用）',
      filters: [{ name: 'AgentHub 整包', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, message: '已取消' }
    return getStore().importBundle(r.filePaths[0])
  })

  // ---------- 凭据 ----------
  ipcMain.handle('credential:save', (_e, keyId: string, secret: string) => {
    getStore().saveCredential(keyId, secret)
    return { ok: true }
  })
  ipcMain.handle('credential:has', (_e, keyId: string) => getStore().hasCredential(keyId))
  ipcMain.handle('credential:delete', (_e, keyId: string) => {
    getStore().deleteCredential(keyId)
    return { ok: true }
  })

  // ---------- 会话 ----------
  // sessions 形状闸门：非数组会在 store 侧被当对象落盘，加载路径又按数组解构——先挡在入口
  ipcMain.handle('session:save', (_e, agentId: string, sessions: AgentSession[], activeId?: string) => {
    if (!Array.isArray(sessions)) return { ok: false, message: 'session:save 的 sessions 只接受数组' }
    getStore().saveSessions(agentId, sessions, activeId)
    return { ok: true }
  })
  ipcMain.handle('session:load', (_e, agentId: string) => getStore().loadSessions(agentId))
  ipcMain.handle('session:remove', (_e, agentId: string, deleteHistory: boolean) => {
    getStore().removeSession(agentId, deleteHistory)
    return { ok: true }
  })

  // ---------- 工作流任务记录 ----------
  // 非对象拒绝：null/字符串会带着 `undefined.json` 之类的文件名进 store，先挡在入口（store 侧另有 safeFileId 兜底）
  ipcMain.handle('run:save', (_e, run: WorkflowRun) => {
    if (!run || typeof run !== 'object') return { ok: false, message: 'run:save 只接受任务记录对象' }
    getStore().saveRun(run)
    return { ok: true }
  })
  ipcMain.handle('run:list', () => getStore().listRuns())
  ipcMain.handle('run:remove', (_e, id: string) => {
    getStore().removeRun(id)
    return { ok: true }
  })

  // ---------- 长期记忆 ----------
  ipcMain.handle('memory:get', () => getStore().getMemory())
  // 形状闸门：非数组照样能写进 memory.json，消费方（渲染层列表渲染）按数组解构会崩——与 agents:set 同口径
  ipcMain.handle('memory:set', (_e, entries) => {
    if (!Array.isArray(entries)) return { ok: false, message: 'memory:set 只接受数组' }
    return getStore().setMemory(entries)
  })

  // ---------- Agent 扫描 ----------
  ipcMain.handle('agents:scan', () => scanAgents())
  ipcMain.handle('agents:checkPath', (_e, p: string) => checkManualPath(p))

  // ---------- 自定义模型（真实 OpenAI 兼容接入） ----------
  ipcMain.handle('model:test', async (_e, cfg: CustomModelConfig, apiKey: string) => {
    return openai.testConnection(cfg, apiKey)
  })

  // 模型切换：列出接口真实可用的模型（需要已保存的凭据）
  ipcMain.handle('model:list', async (_e, cfg: CustomModelConfig) => {
    const key = getStore().getCredential(cfg.keyId)
    if (!key) return { ok: false, message: '未找到 API Key，请重新添加连接' }
    return openai.listModels(cfg, key)
  })

  ipcMain.handle('model:chat', async (_e, cfg: CustomModelConfig, reqId: string, messages: openai.IncomingMsg[], opts?: { agentId?: string; workflow?: boolean; checkpointId?: string; runId?: string; planMode?: boolean }) => {
    const key = getStore().getCredential(cfg.keyId)
    if (!key) {
      const win = getWin()
      win?.webContents.send('model:event', { reqId, type: 'error', message: '未找到 API Key，请先在 Agent 设置中填写并保存' })
      return { ok: false }
    }
    // 工具授权以存储配置为唯一来源：渲染层只传 agentId 供查表，
    // 不接受渲染层自构造的 grant（否则渲染层可自我提权为完全访问/联网）
    const stored = getStore().getConfig()
    let grant: ToolGrant | undefined = opts?.agentId
      ? stored.agents.find((a) => a.id === opts.agentId)?.tools
      : undefined
    // 工作流执行角色：本次任务以"产物目录"为文件工作根（仅覆盖 dir，不覆盖 access/命令/联网授权）。
    // 未启用文件工具的模型不会被此处赋予文件能力——它走 AgentHub 文本落盘（artifact:write）。
    if (opts?.workflow && grant) {
      const out = workflowOutDir(getStore)
      if (out) {
        try { mkdirSync(out, { recursive: true }) } catch { /* 创建失败时工具调用会如实报错 */ }
        grant = { ...grant, dir: out }
      }
    }
    // 计划态（批次 F）：渲染层传 true 时把这道闸合进 grant。它只能**加限制**——
    // access / 命令 / 联网这些权限仍以存储配置为唯一来源，这里一个都不放开。
    if (opts?.planMode === true && grant) grant = { ...grant, planMode: true }
    const agentName = opts?.agentId ? stored.agents.find((a) => a.id === opts.agentId)?.name : undefined
    const tap = ledgerTap({
      channel: 'model',
      harness: hostOf(cfg.baseUrl),
      model: cfg.modelId,
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      ...(agentName ? { agentName } : {}),
      workflow: !!opts?.workflow,
      ...(opts?.runId ? { runId: opts.runId } : {})
    })
    // 改动检查点：一次工作流任务共用 run.id（返工/续跑都回到任务开始前的状态），
    // 工作站对话按 reqId 单独成一个检查点。目录取主进程侧的 grant.dir，不信渲染层传的路径。
    let checkpoint: string | undefined
    // 计划态不建检查点（spec 批次 F 表格那行：不改文件就不该有回滚基线）；
    // 批准之后执行角色那一轮照常建，基线仍落在"真正动手之前"。
    if (grant && !grant.planMode) {
      const cpId = String(opts?.checkpointId ?? reqId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
      if (cpId) {
        await checkpoints.start(cpId, grant.dir)
        checkpoint = cpId
      }
    }
    const userHooks = stored.hooks ?? []
    // ---------- MCP：只连这个 Agent 勾选且启用的 server，首次连接要先确认 ----------
    // 探完工具清单再问人，这样"放行"时看到的是它到底能干什么，而不是一个 server 名字。
    // 评审修复：先过 mcp:list 同一道闸门（sanitizeMcpList）再映射 id——旧写法在**原始**
    // stored.mcpServers 上 find((s) => s.id === id)，下一行的 !!s 过滤发生在解引用之后，
    // 手改 config.json 塞进的 null 会当场 TypeError 掀掉整次对话。闸门顺带把旧单命令记录
    // 标成停用，这里按 enabled !== false 直接跳过：停用的 server 不该再"尝试连接并必然失败"。
    const knownServers = sanitizeMcpList(stored.mcpServers)
    const selected = (grant?.mcpServerIds ?? [])
      // 内置基础组不在用户配置里（合成条目），按常量 id 命中；其余从过闸门的配置里找
      .map((id) => (id === mcp.BUILTIN_MCP_BASIC.id ? mcp.BUILTIN_MCP_BASIC : knownServers.find((s) => s.id === id)))
      .filter((s): s is McpServer => !!s && s.enabled !== false)
    const clients: mcp.McpClient[] = []
    const wiringEntries: { client: mcp.McpClient; tools: mcp.McpToolInfo[] }[] = []
    for (const s of selected) {
      try {
        const { client } = await mcp.McpClient.connect(s)
        clients.push(client)
        const tools = await client.listTools()
        // 内置组免信任弹窗：进程内实现、随应用发布，与内置工具同级信任；
        // 其余 server 首次连接仍要确认（探完工具清单再问人，放行时看得见它能干什么）
        if (s.builtin !== 'basic' && !approvals.isMcpTrusted(s.id)) {
          const d = await approvals.requestApproval(
            {
              id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
              reqId,
              tool: 'mcp',
              // 信任弹窗是用户看清"我到底允许了哪条命令"的唯一地方：新格式显示实际执行的
              // bin+args（command 可能为空，旧写法会弹出空白）；旧格式显示原命令并标注已停用。
              // argv 用 JSON 数组形态显示（与设置页「实际执行」预览同一种口径，修复波 A · 项 6）：
              // 人工授权闸口正是必须显示 argv 边界的地方，裸空格 join 会让含空格的参数看起来像两个 token。
              command: mcp.trustCommand(s),
              dir: grant?.dir ?? '',
              reason: s.transport === 'http' ? `首次连接远程 MCP server「${s.name}」：工具调用与数据将发往它所在的远程服务（不是本机进程）` : `首次连接 MCP server「${s.name}」：它的工具会以这条命令的权限在本机执行`,
              uncovered: [],
              kind: 'mcp',
              mcpServerId: s.id,
              mcpTools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description.slice(0, 160) } : {}) })),
              ts: Date.now()
            },
            (req) => getWin()?.webContents.send('model:event', { reqId, type: 'approval', approval: req })
          )
          if (d === 'deny') {
            client.close()
            clients.pop()
            continue
          }
        }
        if (tools.length) wiringEntries.push({ client, tools })
      } catch (e) {
        // 连不上不该让整次对话失败：如实报一条 notice，界面与账本都看得到
        getWin()?.webContents.send('model:event', { reqId, type: 'notice', text: `MCP「${s.name}」连接失败：${(e as Error).message}` })
      }
    }
    const wired = wiringEntries.length ? mcp.mcpToolDefs(wiringEntries) : undefined
    const mcpWiring: openai.McpWiring | undefined = wired
      ? {
          defs: wired.defs,
          routes: Object.fromEntries(
            Object.entries(wired.routes).map(([name, route]) => [
              name,
              {
                label: `mcp:${route.client.server.name}:${route.tool}`,
                call: async (argsJson: string, signal?: AbortSignal) => {
                  if (signal?.aborted) return { ok: false, output: '已取消：请求被用户停止' }
                  let args: Record<string, unknown> = {}
                  try {
                    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
                  } catch {
                    return { ok: false, output: `参数不是合法 JSON：${argsJson.slice(0, 200)}` }
                  }
                  try {
                    const r = await route.client.callTool(route.tool, args)
                    return { ok: r.ok, output: `MCP 工具 ${route.tool}：${r.output}` }
                  } catch (e) {
                    return { ok: false, output: `MCP 调用失败：${(e as Error).message}` }
                  }
                }
              }
            ])
          )
        }
      : undefined
    const closeMcp = () => {
      for (const c of clients) {
        try { c.close() } catch { /* noop */ }
      }
      mcpSessions.delete(reqId)
    }
    if (clients.length) mcpSessions.set(reqId, closeMcp)
    openai.chatStream(cfg, key, reqId, messages, (ev) => {
      tap(ev)
      // 一条请求一个连接：流结束（或报错）就关掉 server 进程，不留跨请求的活进程
      if (ev.type === 'done' || ev.type === 'error') closeMcp()
      getWin()?.webContents.send('model:event', ev)
    }, grant, grant ? {
      approver: makeApprover(reqId, {
        dir: grant.dir,
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(agentName ? { agentName } : {})
      }),
      ...(checkpoint ? { checkpoint } : {}),
      ...(userHooks.length ? { userHooks } : {}),
      meta: {
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(opts?.runId ? { runId: opts.runId } : {}),
        reqId
      }
    } : undefined, mcpWiring)
    return { ok: true, checkpoint }
  })

  ipcMain.handle('model:cancel', (_e, reqId: string) => {
    openai.cancelStream(reqId)
    // 挂在这条流上的审批一并按拒绝收掉：否则界面留一张没人认领的弹窗
    approvals.denyPendingFor(reqId)
    // MCP 连接也跟着关：取消后不该有 server 进程还在后台跑
    mcpSessions.get(reqId)?.()
    return { ok: true }
  })

  // 余额查询（DeepSeek 官方 /user/balance；其他 provider 返回 ok=false 由界面转"仅显示消耗"）
  ipcMain.handle('model:balance', async (_e, cfg: CustomModelConfig) => {
    const key = getStore().getCredential(cfg.keyId)
    if (!key) return { ok: false, message: '未找到 API Key，请重新添加连接' }
    return openai.queryBalance(cfg, key)
  })

  // ---------- Skill 提示包（Markdown 可复用；聊天引用注入，设置页管理） ----------
  ipcMain.handle('skills:list', () => getStore().getSkills())
  ipcMain.handle('skills:save', (_e, skill: Skill) => {
    if (!skill || typeof skill.name !== 'string' || !skill.name.trim()) return { ok: false, message: 'Skill 名称不能为空' }
    if (typeof skill.content !== 'string' || !skill.content.trim()) return { ok: false, message: 'Skill 内容不能为空' }
    const saved = getStore().saveSkill({
      id: typeof skill.id === 'string' && skill.id ? skill.id : `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: skill.name.trim().slice(0, 60),
      desc: String(skill.desc ?? '').slice(0, 200),
      content: skill.content,
      createdAt: typeof skill.createdAt === 'number' ? skill.createdAt : Date.now(),
      // 开关与标准兼容字段：未显式禁用即启用
      enabled: skill.enabled !== false,
      dir: typeof skill.dir === 'string' ? skill.dir.slice(0, 300) : undefined,
      files: Array.isArray(skill.files) ? skill.files.filter((f) => typeof f === 'string').slice(0, 40) : undefined,
      format: skill.format === 'agentskills' ? 'agentskills' : 'legacy',
      // 来源标注字段（市场/内置）：编辑保存时原样带回，不因一次编辑就把"这是市场装的"悄悄抹掉
      ...(typeof skill.source === 'string' && ['local', 'builtin', 'market'].includes(skill.source) ? { source: skill.source } : {}),
      ...(typeof skill.sourceId === 'string' && skill.sourceId ? { sourceId: skill.sourceId.slice(0, 80) } : {}),
      ...(typeof skill.version === 'string' && skill.version ? { version: skill.version.slice(0, 40) } : {}),
      ...(typeof skill.author === 'string' && skill.author ? { author: skill.author.slice(0, 80) } : {}),
      ...(typeof skill.homepage === 'string' && skill.homepage ? { homepage: skill.homepage } : {})
    })
    return { ok: true, skill: saved }
  })
  ipcMain.handle('skills:remove', (_e, id: string) => {
    getStore().removeSkill(id)
    return { ok: true }
  })

  // ---------- 技能中心（市场）：内置 / 注册表 / 安装 / 导出 ----------
  // id 入参先过字符白名单（本仓既有口径，防路径拼接）：install/exportPack 都拼得进路径
  const MARKET_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
  /** 内置技能只读清单（装前可读的另一半：不落盘也能看到正文）。失败形态与渲染层契约一致：ok=false + message，不抛桥异常 */
  ipcMain.handle('market:builtin', () => {
    try {
      return { ok: true, skills: market.listBuiltin() }
    } catch (e) {
      return { ok: false, message: `内置技能读取失败：${(e as Error).message}` }
    }
  })
  ipcMain.handle('market:registry', () => market.fetchRegistry())
  ipcMain.handle('market:install', async (_e, id: string) => {
    if (typeof id !== 'string' || !MARKET_ID_RE.test(id)) return { ok: false, message: '条目 id 不合法' }
    // 渲染层只给 id，不传整条 item：url/sha256 一律以主进程刚拉到的注册表为准，
    // 防"界面伪造一条 item 指向任意下载源"——注册表是唯一可信来源
    const reg = await market.fetchRegistry()
    const item = reg.items.find((it) => it.id === id)
    if (!item) return { ok: false, message: reg.ok ? `注册表里没有这个条目：${id}` : `注册表不可用：${reg.error ?? '未知原因'}` }
    return market.installFromMarket(item)
  })
  ipcMain.handle('market:exportPack', (_e, id: string) => {
    if (typeof id !== 'string' || !MARKET_ID_RE.test(id)) return Promise.resolve({ ok: false, message: '技能 id 不合法' })
    return market.exportPack(id)
  })

  // ---------- 官方模型服务（注册表）：端点与模型清单的唯一真相在 mihayoufamily/agenthub-models ----------
  // 渲染层只拿展示数据与"生成预置 Agent"的三元组（baseUrl / modelId / 名称）；API Key 一律用户自己粘贴，
  // 本通道不下发任何凭据，也不接受渲染层上传端点——换端点 = 改注册表仓库，不是改界面
  ipcMain.handle('officialModels:list', () => officialModels.fetchOfficialModels())

  /**
   * 导入 Agent Skills 标准目录：读 <dir>/SKILL.md（frontmatter 的 name / description + 正文），
   * 并登记 references/ scripts/ examples/ 等附带文件的**路径清单**。
   * 只登记路径不代读内容，也绝不执行 skill 里的脚本——脚本要跑仍要走工具层的命令授权。
   */
  ipcMain.handle('skills:importDir', async () => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showOpenDialog(win, { title: '选择 Skill 目录（内含 SKILL.md）', properties: ['openDirectory'] })
    const dir = r.filePaths?.[0]
    if (r.canceled || !dir) return { ok: false, message: '已取消' }
    const mdPath = ['SKILL.md', 'skill.md', 'Skill.md'].map((n) => join(dir, n)).find((p) => existsSync(p))
    if (!mdPath) return { ok: false, message: `该目录下没有 SKILL.md：${dir}` }
    let raw = ''
    try {
      raw = readFileSync(mdPath, 'utf-8')
    } catch (e) {
      return { ok: false, message: `读取失败：${(e as Error).message}` }
    }
    const MAX_SKILL = 256 * 1024
    if (raw.length > MAX_SKILL) raw = raw.slice(0, MAX_SKILL) + '\n…（内容超长，已截断）'
    const { meta, body } = market.parseSkillFrontmatter(raw)
    let files: string[] = []
    try {
      files = readdirSync(dir, { recursive: true })
        .map((f) => String(f).replace(/\\/g, '/'))
        .filter((f) => /^(references|scripts|examples|assets)\//i.test(f) || /\.(md|txt|json|ya?ml)$/i.test(f))
        .filter((f) => f !== 'SKILL.md')
        .slice(0, 40)
    } catch { /* 列不出来只注入正文，不算失败 */ }
    const saved = getStore().saveSkill({
      id: `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: (meta.name || dir.split(/[\\/]/).pop() || '未命名 Skill').slice(0, 60),
      desc: (meta.description || '').slice(0, 200),
      content: (body.trim() || raw.trim()),
      createdAt: Date.now(),
      enabled: true,
      dir,
      files,
      format: 'agentskills'
    })
    return { ok: true, skill: saved }
  })

  // ---------- 工具层（沙箱执行） ----------
  // 工具清单（只读展示）：与发给模型的同一份 toolDefs——授权面板里"看到的"与模型"拿到的"永远一致，
  // 不在渲染层再抄一份清单（两份必然漂移）。flags 取面板当前的开关状态。
  ipcMain.handle('tools:defs', (_e, flags: { allowCommands?: boolean; allowWeb?: boolean }) =>
    (toolDefs(!!flags?.allowCommands, !!flags?.allowWeb) as { function: { name: string; description?: string } }[])
      .map((d) => ({ name: d.function.name, desc: String(d.function.description ?? '').split('\n')[0].slice(0, 140) }))
  )
  // 这条直调入口只存在于验证态：与 config:importJson 同一道闸门（argv 带 --ahub-verify 才注册）、同一先例。
  // 原因：它接受渲染层自构造的 grant，`{dir:'C:\\', access:'full'}` 即全盘读写——与 model:chat
  // "grant 从存储配置解析、不接受渲染层自构造（否则渲染层可自我提权）"的原则直接冲突。
  // 渲染层要跑工具走 model:chat 那条路。app.isPackaged 不能当闸门——被测的部署构建本来就是 packaged。
  if (process.argv.includes(VERIFY_SWITCH)) {
    ipcMain.handle('tools:exec', async (_e, grant: ToolGrant, tool: string, argsJson: string, checkpointId?: string) => {
      if (!grant || typeof grant.dir !== 'string' || !grant.dir) {
        return { ok: false, output: '拒绝：未配置工具目录' }
      }
      // 这条入口是给验证脚本与高级用途直接跑一次工具用的：命令审批照样要过，
      // 只是问的是"正在调用它的那个人"，而不是某个 Agent 的白名单
      const cp = typeof checkpointId === 'string' ? checkpointId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) : ''
      if (cp) await checkpoints.start(cp, grant.dir)
      const userHooks = getStore().getConfig().hooks ?? []
      return execTool(grant, tool, argsJson, undefined, {
        approver: makeApprover('tools:exec', { dir: grant.dir }),
        ...(cp ? { checkpoint: cp } : {}),
        ...(userHooks.length ? { userHooks } : {})
      })
    })
  }

  // ---------- 模型回复图片代理（image:fetch） ----------
  /**
   * 渲染模型回复中的远程图片：主进程代为 GET 并转 base64 data URL（渲染进程自身不带外网权限）。
   * 信任边界（如实写，不装糊涂）：tools:exec 的教训是"渲染层自构造 grant"，那条通道因此只在
   * 验证态注册。本通道不收 grant、不执行任何东西、不落盘——只做"下载一张图转 data URL"，风险
   * 等级完全不同，所以常态注册。**allowWeb（该 Agent 是否开启联网）的校验留在渲染层**
   * （MessageBody 的 allowRemoteImages prop，由调用方从 agent 配置取）：通道侧没有可信的
   * agentId——渲染层传什么就是什么，照单全收等于把授权判定又交回给被授权方（同一个洞）。
   * 这层能守住的是平台级底线：① 只收 http(s) 图片链接（data: 图不需要下载）；② SSRF 守卫与
   * web_fetch 同一份实现（isNonPublicHost 第一跳直判 + safeWebUrl 的 DNS 全地址复核与跳转后
   * 复核）；③ 响应必须 image/* 且 ≤5MB；④ 逐块限量读取，超大响应不会撑爆主进程。
   */
  const IMG_MAX_BYTES = 5 * 1024 * 1024
  const IMG_TIMEOUT_MS = 15_000
  const IMG_UA = 'AgentHub-Updater' // UA 同 updater（更新器已用此标识与 GitHub 通信）
  /**
   * 进程内 LRU 缓存（键 = url）：同一张图渲染多次不重复下载。
   * 只存内存不落盘——图片是"回复的一次渲染"，重启后重拉是可接受的语义，落盘反而要把
   * "模型给过的外链"变成持久数据。条数 ≤24 / 总量 ≤24MB，超限从最旧端淘汰。
   */
  const imgCache = new Map<string, { dataUrl: string; mime: string; bytes: number }>()
  const IMG_CACHE_MAX_ENTRIES = 24
  const IMG_CACHE_MAX_BYTES = 24 * 1024 * 1024
  let imgCacheBytes = 0
  const imgCachePut = (url: string, entry: { dataUrl: string; mime: string; bytes: number }) => {
    const old = imgCache.get(url)
    if (old) { imgCacheBytes -= old.bytes; imgCache.delete(url) }
    imgCache.set(url, entry)
    imgCacheBytes += entry.bytes
    while ((imgCache.size > IMG_CACHE_MAX_ENTRIES || imgCacheBytes > IMG_CACHE_MAX_BYTES) && imgCache.size > 0) {
      const oldest = imgCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      imgCacheBytes -= imgCache.get(oldest)!.bytes
      imgCache.delete(oldest)
    }
  }
  /** 二进制版限量读取（tools.ts 的 readBodyCapped 是文本口径且未导出，这里是图片字节流的最小实现） */
  const readImageCapped = async (res: Response, limit: number): Promise<Buffer | null> => {
    if (!res.body) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let len = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks.map((c) => Buffer.from(c)), len)
      if (!value) continue
      if (len + value.length > limit) {
        void reader.cancel().catch(() => { /* 已放弃剩余内容 */ })
        return null
      }
      chunks.push(value)
      len += value.length
    }
  }
  ipcMain.handle('image:fetch', async (_e, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { ok: false, message: '链接为空' }
    const url = rawUrl.trim()
    if (!isValidImageSrc(url) || !isRemoteImageSrc(url)) {
      return { ok: false, message: '只代理 http(s) 图片链接（data: 图无需下载）' }
    }
    const hit = imgCache.get(url)
    if (hit) return { ok: true, dataUrl: hit.dataUrl, mime: hit.mime, bytes: hit.bytes }
    // 同源豁免：图片与某个已配置模型 Agent 的端点**同 host** 时，环回/内网地址放行——
    // 本来就在与这台服务器通话（如本地网关 127.0.0.1:8080 的 /images），下载它给出的
    // 图片没有扩大攻击面。豁免名单由主进程对照自己的存储配置得出，渲染层无权自报。
    const sameHosts = new Set<string>()
    for (const a of getStore().getConfig().agents) {
      const b = a.modelConfig?.baseUrl
      if (typeof b === 'string' && b) {
        try { sameHosts.add(new URL(b).host) } catch { /* 端点写坏的条目跳过 */ }
      }
    }
    let target = url
    try {
      const sameOrigin = sameHosts.has(new URL(url).host)
      // 第一跳 hostname 直判：命中内网/环回给点名文案，让"模型指内网"这件事对用户可见
      if (!sameOrigin && isNonPublicHost(new URL(url).hostname)) {
        return { ok: false, message: '拒绝：模型给出的地址指向内网/本机（SSRF 已拦截）' }
      }
      if (!sameOrigin) {
        // DNS 复核与 web_fetch 同一份 safeWebUrl：all:true 拿全部地址，任一命中内网即拒
        const checked = await safeWebUrl(url)
        if (!checked) return { ok: false, message: '拒绝：模型给出的地址指向内网，或域名解析失败（SSRF 已拦截）' }
        target = checked
      }
    } catch {
      return { ok: false, message: '链接无法解析' }
    }
    const { net } = require('electron') as typeof import('electron')
    try {
      const res = await net.fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
        headers: { 'User-Agent': IMG_UA, Accept: 'image/*' }
      })
      // 跳转后按最终落点复核（与 webGet 同口径）：跳进内网的响应体不返回给渲染层；
      // 落点仍是同源端点（本地网关跳自己的另一条路径）照常放行
      let finalOk = false
      try {
        finalOk = sameHosts.has(new URL(res.url || target).host) || (await safeWebUrl(res.url || target)) !== null
      } catch { finalOk = false }
      if (!finalOk) {
        return { ok: false, message: '拒绝：跳转后指向内网/本机（SSRF 已拦截，图片未返回）' }
      }
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} ${res.statusText}` }
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!mime.startsWith('image/')) {
        return { ok: false, message: `响应不是图片（Content-Type: ${mime || '未知'}）` }
      }
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (Number.isFinite(declared) && declared > IMG_MAX_BYTES) {
        return { ok: false, message: '图片超过 5MB 上限，未下载' }
      }
      const buf = await readImageCapped(res, IMG_MAX_BYTES)
      if (!buf || buf.length === 0) return { ok: false, message: '图片超过 5MB 上限，或响应为空' }
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      imgCachePut(url, { dataUrl, mime, bytes: buf.length })
      return { ok: true, dataUrl, mime, bytes: buf.length }
    } catch (e) {
      return { ok: false, message: `下载失败：${(e as Error)?.message ?? '未知网络错误'}` }
    }
  })

  // ---------- 改动检查点（回滚） ----------
  ipcMain.handle('checkpoint:manifest', async (_e, id: string) => {
    const m = checkpoints.manifestOf(String(id ?? ''))
    return { manifest: m, summary: checkpoints.summarize(m), delta: await checkpoints.deltaOf(String(id ?? '')) }
  })
  ipcMain.handle('checkpoint:rollback', async (_e, id: string, mode?: string) => {
    // mode 原样透传（'tool' 缺省 / 'git' 由另一批次在 checkpoints.ts 扩展）：当前的单参签名先
    // 用 as 兜住第二个实参（JS 运行时多传不报错，TS 层面也不红），合入后这里无需再改
    const rb = checkpoints.rollback as (id: string, mode?: 'tool' | 'git') => ReturnType<typeof checkpoints.rollback>
    return rb(String(id ?? ''), mode === 'git' ? 'git' : 'tool')
  })
  ipcMain.handle('checkpoint:prune', async (_e, id: string) => {
    await checkpoints.prune(String(id ?? ''))
    return { ok: true }
  })

  // ---------- 命令审批（白名单 / 待裁决 / 审批历史） ----------
  ipcMain.handle('approval:pending', () => approvals.pendingList())
  ipcMain.handle('approval:decide', (_e, id: string, decision: ApprovalDecision) => approvals.resolveApproval(id, decision))
  ipcMain.handle('approval:rules', (_e, agentId?: string) => approvals.rulesFor(agentId))
  ipcMain.handle('approval:rules:all', () => approvals.allRules())
  ipcMain.handle('approval:rules:set', (_e, agentId: string, rules: string[]) => approvals.setRules(agentId, rules))
  ipcMain.handle('approval:history', (_e, limit?: number) => approvals.listRecords(limit ?? 200))
  ipcMain.handle('approval:history:clear', () => {
    approvals.clearRecords()
    return { ok: true }
  })

  // 选择目录（Agent 工具沙箱根配置用）
  ipcMain.handle('dialog:pickDir', async () => {
    const win = getWin()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: '选择产物目录（Agent 的文件操作将限制在此目录内）', properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  /**
   * 当前生效的工作流产物目录（界面展示与打开用；口径与工具层/落盘一致）。
   * 顺手确保目录存在：工作流会把它同时当作 CLI 进程的 cwd 与文件工具沙箱根，
   * 目录不存在时 spawn 直接 ENOENT（"WorkBuddy 进程打不开"的真实成因）。
   * 建不成时不静默换目录——让上层按原样失败并如实报错。
   */
  ipcMain.handle('artifact:dir', () => {
    const dir = workflowOutDir(getStore)
    if (dir) {
      try { mkdirSync(dir, { recursive: true }) } catch { /* 交由调用链如实报错 */ }
    }
    return dir
  })

  /** 读取某工作目录下的项目约定文件（AGENTS.md / CLAUDE.md）；目录为空或不存在返回空数组 */
  ipcMain.handle('conv:read', (_e, dir?: string) => readConventions(typeof dir === 'string' ? dir : undefined))

  /** 工作目录的 repo map（大项目里让模型先看到地图，而不是靠 grep 摸黑） */
  ipcMain.handle('repomap:get', async (_e, dir?: string) => buildRepoMap(typeof dir === 'string' ? dir : undefined))

  // ---------- Agent 工作目录只读通道（@ 文件引用用；渲染层只发 agentId + 相对路径） ----------
  /** 单次列目录上限：超出截断并说明。@引用是给人翻文件用的，不是目录索引服务 */
  const FS_LIST_MAX = 500
  /** 单次读取上限（字节）：与附件按钮的文本上限同量级，更大的文件请走附件流程 */
  const FS_READ_MAX = 64 * 1024

  /** 从存储配置解析 Agent 的工作根：类型不同的 Agent 给如实的拒绝理由，不猜 */
  function resolveAgentRoot(agentId: unknown): { ok: true; dir: string } | { ok: false; message: string } {
    if (typeof agentId !== 'string' || !agentId.trim()) return { ok: false, message: 'agentId 必须是非空字符串' }
    const a = getStore().getConfig().agents.find((x) => x.id === agentId)
    if (!a) return { ok: false, message: `未找到 Agent：${agentId}` }
    // CLI Agent 的工作目录由它自己的进程管理，AgentHub 不在它头上架文件通道
    if (a.cliConfig) return { ok: false, message: 'CLI Agent 的工作目录由它自己的进程管理，@引用暂不支持，请用附件按钮' }
    if (a.isDemo) return { ok: false, message: '演示 Agent 没有真实工作目录，@引用不可用，请用附件按钮' }
    const dir = a.tools?.dir?.trim()
    if (!dir) return { ok: false, message: '该 Agent 未配置文件工具目录（在 Agent 设置开启文件工具并选择目录后，@引用可用）' }
    return { ok: true, dir }
  }

  /** 共同的路径安全闸：rel 必须相对、必须留在该 Agent 的工作根内（词法前缀 + 最近存在祖先 realpath，与工具层 sandboxPath 同一套实现） */
  function guardRel(agentId: unknown, rel: unknown): { ok: true; abs: string } | { ok: false; message: string } {
    if (typeof rel !== 'string') return { ok: false, message: 'rel 必须是字符串' }
    // 绝对路径一律拒收：这是"工作目录内的相对引用"通道，不是任意路径读取器
    if (rel.length > 0 && isAbsolute(rel)) return { ok: false, message: 'rel 必须是相对路径' }
    const root = resolveAgentRoot(agentId)
    if (!root.ok) return root
    // 空串按根目录（列目录用）；sandboxPath 会做 ../ 逃逸与 symlink 逃逸两道校验
    const abs = sandboxPath({ dir: root.dir, access: 'sandbox' }, rel === '' ? '.' : rel)
    if (!abs) return { ok: false, message: '路径越出该 Agent 的工作目录，已拒绝' }
    return { ok: true, abs }
  }

  ipcMain.handle('fs:listDir', async (_e, agentId: unknown, rel: unknown) => {
    const g = guardRel(agentId, rel)
    if (!g.ok) return g
    try {
      const st = await stat(g.abs)
      if (!st.isDirectory()) return { ok: false, message: '该路径不是目录' }
      const dirents = await readdir(g.abs, { withFileTypes: true })
      // 目录在前、名称排序后再截断：截掉的总是"排最后的文件"，不是随机丢
      const sorted = [...dirents].sort((a, b) =>
        a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
      )
      const truncated = sorted.length > FS_LIST_MAX
      const list = truncated ? sorted.slice(0, FS_LIST_MAX) : sorted
      const entries: { name: string; isDir: boolean; size: number }[] = []
      for (const d of list) {
        let size = 0
        try {
          size = (await stat(join(g.abs, d.name))).size
        } catch { /* stat 失败（权限/竞态删除）按 0 报，条目本身照常列出 */ }
        entries.push({ name: d.name, isDir: d.isDirectory(), size })
      }
      return { ok: true, entries, ...(truncated ? { message: `条目超过 ${FS_LIST_MAX}，已按目录优先、名称排序截断` } : {}) }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  ipcMain.handle('fs:readTextFile', async (_e, agentId: unknown, rel: unknown) => {
    const g = guardRel(agentId, rel)
    if (!g.ok) return g
    try {
      const st = await stat(g.abs)
      if (st.isDirectory()) return { ok: false, message: '该路径是目录，请选择文件' }
      if (st.size > FS_READ_MAX) {
        return { ok: false, message: `文件超过 ${Math.round(FS_READ_MAX / 1024)}KB 读取上限，请改用附件按钮发送` }
      }
      const content = await readFile(g.abs, 'utf8')
      return { ok: true, content }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  /** 产物目录的文件清单（核对"验收项↔文件"用，不能只信角色说的话）。传 dir 时列那个目录（任务自己的产物目录），否则列当前配置的 */
  ipcMain.handle('artifact:ls', async (_e, dir?: string) => {
    const target = typeof dir === 'string' && dir.trim() ? dir.trim() : workflowOutDir(getStore)
    if (!target) return { ok: false, files: [], message: '产物目录不可用' }
    const { files, truncated } = await checkpoints.listDirFiles(target)
    const out: { rel: string; bytes: number }[] = []
    for (const rel of files) {
      try {
        out.push({ rel, bytes: (await stat(join(target, rel))).size })
      } catch {
        out.push({ rel, bytes: 0 })
      }
    }
    return { ok: true, dir: target, files: out, truncated }
  })

  /**
   * 确保并返回 AgentHub 自建工作区目录：<文档>/AgentHub-workspaces/<name>。
   * 渲染层此前自己拼这个路径却没人创建它，CLI 拿它当 cwd 会直接 ENOENT（"进程启动失败"）。
   * 只开这一个根下的单层名字：字符白名单 + 截断，杜绝借道在任意位置建目录。
   */
  ipcMain.handle('app:ensureWorkspaceDir', (_e, name: string) => {
    const safe = typeof name === 'string' ? name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) : ''
    if (!safe || safe === '.' || safe === '..') return { ok: false, message: '目录名不合法' }
    let root = ''
    try {
      root = join(app.getPath('documents'), 'AgentHub-workspaces')
    } catch {
      return { ok: false, message: '系统文档目录读取失败' }
    }
    const dir = join(root, safe)
    try {
      mkdirSync(dir, { recursive: true })
      return { ok: true, path: dir }
    } catch (e) {
      return { ok: false, message: `创建失败：${(e as Error).message}` }
    }
  })

  /**
   * 由 AgentHub 落盘一篇文本产物（执行角色没有文件工具时的兜底交付：模型的完整文本成果写成文件）。
   * 目录固定为工作流产物目录，渲染层只能给文件名；文件名做字符过滤（不含分隔符，杜绝路径穿越）。
   */
  ipcMain.handle('artifact:write', async (_e, fileName: string, content: string, checkpointId?: string) => {
    const dir = workflowOutDir(getStore)
    if (!dir) return { ok: false, message: '产物目录不可用（系统文档目录读取失败）' }
    const safe = typeof fileName === 'string'
      ? fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 80)
      : ''
    if (!safe) return { ok: false, message: '文件名不合法' }
    const text = typeof content === 'string' ? content : ''
    if (!text.trim()) return { ok: false, message: '内容为空，未写入' }
    const MAX_ART = 512 * 1024
    const body = text.length > MAX_ART ? text.slice(0, MAX_ART) + '\n…（内容超长，已截断）' : text
    try {
      mkdirSync(dir, { recursive: true })
      // 同名自增：同轮单角色重跑不该覆盖旧卡登记的产物文件（历史事实被改写）。
      // 首次写入的文件名不变（既有断言与用户预期不破），重跑产生 -2/-3… 新文件；试满 100 次仍冲突就如实拒绝。
      let p = join(dir, safe)
      if (existsSync(p)) {
        const dot = safe.lastIndexOf('.')
        const stem = dot > 0 ? safe.slice(0, dot) : safe
        const ext = dot > 0 ? safe.slice(dot) : ''
        let n = 2
        while (n < 102 && existsSync(join(dir, `${stem}-${n}${ext}`))) n++
        if (n >= 102) return { ok: false, message: '同名产物文件已尝试 100 个候选名仍冲突，拒绝写入' }
        p = join(dir, `${stem}-${n}${ext}`)
      }
      // 由 AgentHub 落盘的文本产物同样进检查点：它和工具写盘的文件混在一个目录里，
      // 回滚不该只认其中一半
      const cpId = typeof checkpointId === 'string' ? checkpointId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) : ''
      if (cpId) await checkpoints.start(cpId, dir)
      const diff = cpId ? await checkpoints.diffOfFile(p, body) : null
      const existed = existsSync(p)
      const rel = cpId ? checkpoints.relativeOf(dir, p) : null
      if (cpId && rel !== null) await checkpoints.beforeChange(cpId, p)
      writeFileSync(p, body, 'utf-8')
      if (cpId && rel !== null) {
        checkpoints.record(cpId, { rel, path: p, kind: existed ? 'modified' : 'created', diff, bytes: body.length })
      }
      return { ok: true, path: p, ...(cpId && rel !== null ? { checkpoint: cpId } : {}) }
    } catch (e) {
      return { ok: false, message: `写入失败：${(e as Error).message}` }
    }
  })

  /** 打开本机文件或目录（产物交付卡片用）：只接受存在的绝对路径；可执行类型拒收 */
  ipcMain.handle('app:openPath', async (_e, p: string) => {
    if (typeof p !== 'string' || !isAbsolute(p)) return { ok: false, message: '只接受绝对路径' }
    if (!existsSync(p)) return { ok: false, message: `路径不存在：${p}` }
    // 可执行扩展名黑名单：shell.openPath 对 .exe 等于"启动它"，等于让产物卡片能借道拉起任意程序。
    // 与 app:openExternal 只放行 http(s) 的谨慎度对齐；打开文件夹与普通文档不受影响。
    const EXE_EXT = new Set(['exe', 'bat', 'cmd', 'scr', 'com', 'msi', 'ps1', 'vbs', 'js', 'jar', 'lnk', 'hta', 'pif', 'cpl'])
    const ext = (p.slice(p.lastIndexOf('.') + 1) || '').toLowerCase()
    if (EXE_EXT.has(ext)) return { ok: false, message: '已拒绝打开可执行文件（.exe/.bat 等会直接运行程序），请从文件管理器手动打开' }
    const err = await shell.openPath(p)
    return err ? { ok: false, message: err } : { ok: true }
  })


  // ---------- 本机 CLI Agent（真实执行，凭据由 CLI 自身管理） ----------
  ipcMain.handle('cli:test', (_e, name: string) => {
    if (!cli.isKnownCli(name)) return { ok: false, message: `未知 CLI：${name}` }
    return cli.testConnection(name)
  })

  ipcMain.handle('cli:chat', async (_e, name: string, opts: cli.CliChatOptions, reqId: string, messages: { role: string; content: string; reasoning?: string }[]) => {
    if (!cli.isKnownCli(name)) {
      getWin()?.webContents.send('model:event', { reqId, type: 'error', message: `未知 CLI：${name}` })
      return { ok: false }
    }
    // 事件复用 model:event 通道（reqId 路由），渲染层无需区分来源
    // 账本按**实际生效**的模型归本：Agent 没填模型时不留空（留空那条既归不进任何模型、也算不了钱）
    const tap = ledgerTap({ channel: 'cli', harness: name, model: cli.cliEffectiveModel(name, opts) })
    return cli.cliChatStream(name, opts ?? {}, reqId, messages, (ev) => {
      tap(ev)
      getWin()?.webContents.send('model:event', ev)
    })
  })

  ipcMain.handle('cli:cancel', (_e, reqId: string) => {
    cli.cancelChat(reqId)
    return { ok: true }
  })

  // 模型清单：可枚举的 CLI 返回列表（CodeBuddy 解析 --help，Codex 只问它的中转端点 /models），其余如实说明
  ipcMain.handle('cli:models', (_e, name: string) => {
    if (!cli.isKnownCli(name)) return { ok: false, message: `未知 CLI：${name}` }
    return cli.listModels(name)
  })

  // ---------- 对话框 ----------
  ipcMain.handle('dialog:pickFiles', async () => {
    const win = getWin()
    if (!win) return []
    // 只开放真实支持的附件类型：文本白名单（内容随调用发送）+ 图片（模型走 data URL，CLI 只拿路径）
    const TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql']
    const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
    const MAX_BYTES = 64 * 1024
    const MAX_IMG_BYTES = 4 * 1024 * 1024
    const r = await dialog.showOpenDialog(win, {
      title: '添加附件（文本内容会发送给 Agent；图片发给支持视觉的模型）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有支持的附件', extensions: [...TEXT_EXT, ...Object.keys(IMAGE_MIME)] },
        { name: `文本文件（≤${Math.round(MAX_BYTES / 1024)}KB）`, extensions: TEXT_EXT },
        { name: `图片（≤${Math.round(MAX_IMG_BYTES / 1024 / 1024)}MB）`, extensions: Object.keys(IMAGE_MIME) }
      ]
    })
    if (r.canceled) return []
    const out: Array<{ name: string; path: string; size: number; content?: string; dataUrl?: string; image?: boolean; error?: boolean; message?: string }> = []
    for (const p of r.filePaths) {
      const name = p.split(/[\\/]/).pop() ?? p
      const ext = (name.split('.').pop() ?? '').toLowerCase()
      try {
        const st = await stat(p)
        if (IMAGE_MIME[ext]) {
          if (st.size > MAX_IMG_BYTES) {
            out.push({ name, path: p, size: st.size, error: true, message: `图片超过 ${Math.round(MAX_IMG_BYTES / 1024 / 1024)}MB` })
            continue
          }
          const buf = await readFile(p)
          out.push({ name, path: p, size: st.size, image: true, dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}` })
          continue
        }
        if (st.size > MAX_BYTES) {
          out.push({ name, path: p, size: st.size, error: true, message: `文本超过 ${Math.round(MAX_BYTES / 1024)}KB` })
          continue
        }
        const content = await readFile(p, 'utf8')
        out.push({ name, path: p, size: st.size, content })
      } catch (e) {
        out.push({ name, path: p, size: 0, error: true, message: (e as Error).message })
      }
    }
    return out
  })

  /** 导出保存对话框：defaultDir 只用于决定对话框落在哪个文件夹（用户仍可改），不做任何写入 */
  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string, content: string, defaultDir?: string) => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const safeName = typeof defaultName === 'string' ? defaultName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) : 'export.md'
    const inDir = typeof defaultDir === 'string' && isAbsolute(defaultDir) && existsSync(defaultDir)
    const r = await dialog.showSaveDialog(win, {
      title: '导出',
      defaultPath: inDir ? join(defaultDir, safeName) : safeName,
      filters: [{ name: '全部文件', extensions: ['*'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    const fs = await import('node:fs')
    fs.writeFileSync(r.filePath, content, 'utf-8')
    return { ok: true, message: r.filePath }
  })
}
