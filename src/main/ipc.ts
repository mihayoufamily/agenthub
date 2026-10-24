import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { join, isAbsolute } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import type { Store } from './store'
import { scanAgents, checkManualPath } from './discovery'
import * as openai from './adapters/openai'
import * as cli from './adapters/cli'
import type { CustomModelConfig, AgentSession, WorkflowRun, Prefs, AgentConfig, AppConfig, ToolGrant, Skill, PriceOverride, ApprovalDecision, HookRule, McpServer } from '../shared/types'
import { configurePriceOverrides, partitionPriceOverrides } from '../shared/overrides'
import { partitionHookRules, sanitizeHookList } from '../shared/hooks'
import { sanitizeMcpList, partitionMcpServers } from '../shared/mcp-list'
import { normalizePolicy, VERIFY_SWITCH } from '../shared/compat'
import { execTool, type CommandApprover } from './tools'
import * as approvals from './approvals'
import * as mcp from './mcp'
import * as checkpoints from './checkpoints'
import { readConventions } from './conventions'
import { buildRepoMap } from './repomap'
import { checkUpdate } from './updater'
import * as ledger from './ledger'
import { setBusy } from './lifecycle'
import type { LedgerEntry } from './ledger'

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

/** Agent Skills 的 frontmatter：只取顶层 `key: value`（够用且不会误吃正文里的冒号） */
function parseSkillFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body: raw.slice(m[0].length) }
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
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `Windows ${process.getSystemVersion()}`,
    userDataPath: app.getPath('userData'),
    documentsPath: app.getPath('documents')
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

  ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('autostart:set', (_e, on: boolean) => {
    // openAtLogin 指向当前可执行文件（便携版即 exe 本身）
    app.setLoginItemSettings({ openAtLogin: on === true, path: process.execPath })
    return app.getLoginItemSettings().openAtLogin
  })

  // ---------- 配置 ----------
  ipcMain.handle('config:get', () => getStore().getConfig())
  ipcMain.handle('prefs:set', (_e, prefs: Prefs) => getStore().setPrefs(prefs))
  ipcMain.handle('agents:set', (_e, agents: AgentConfig[]) => getStore().setAgents(agents))
  ipcMain.handle('workflowDefaults:set', (_e, wd: AppConfig['workflowDefaults']) => getStore().setWorkflowDefaults(wd))
  ipcMain.handle('presets:set', (_e, list: AppConfig['presets']) => getStore().setPresets(list))
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
  ipcMain.handle('mcp:list', () => sanitizeMcpList(getStore().getConfig().mcpServers))
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
  ipcMain.handle('session:save', (_e, agentId: string, sessions: AgentSession[], activeId?: string) => {
    getStore().saveSessions(agentId, sessions, activeId)
    return { ok: true }
  })
  ipcMain.handle('session:load', (_e, agentId: string) => getStore().loadSessions(agentId))
  ipcMain.handle('session:remove', (_e, agentId: string, deleteHistory: boolean) => {
    getStore().removeSession(agentId, deleteHistory)
    return { ok: true }
  })

  // ---------- 工作流任务记录 ----------
  ipcMain.handle('run:save', (_e, run: WorkflowRun) => {
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
  ipcMain.handle('memory:set', (_e, entries) => getStore().setMemory(entries))

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

  ipcMain.handle('model:chat', async (_e, cfg: CustomModelConfig, reqId: string, messages: openai.IncomingMsg[], opts?: { agentId?: string; workflow?: boolean; checkpointId?: string; runId?: string }) => {
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
    if (grant) {
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
      .map((id) => knownServers.find((s) => s.id === id))
      .filter((s): s is McpServer => !!s && s.enabled !== false)
    const clients: mcp.McpClient[] = []
    const wiringEntries: { client: mcp.McpClient; tools: mcp.McpToolInfo[] }[] = []
    for (const s of selected) {
      try {
        const { client } = await mcp.McpClient.connect(s)
        clients.push(client)
        const tools = await client.listTools()
        if (!approvals.isMcpTrusted(s.id)) {
          const d = await approvals.requestApproval(
            {
              id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
              reqId,
              tool: 'mcp',
              // 信任弹窗是用户看清"我到底允许了哪条命令"的唯一地方：新格式显示实际执行的
              // bin+args（command 可能为空，旧写法会弹出空白）；旧格式显示原命令并标注已停用。
              // argv 用 JSON 数组形态显示（与设置页「实际执行」预览同一种口径，修复波 A · 项 6）：
              // 人工授权闸口正是必须显示 argv 边界的地方，裸空格 join 会让含空格的参数看起来像两个 token。
              command: s.launch?.bin
                ? JSON.stringify([s.launch.bin, ...(Array.isArray(s.launch.args) ? s.launch.args : [])])
                : `${(s.command ?? '').trim()}${s.legacyInvalid ? '（已停用，v0.4.0 不再用旧单命令启动）' : ''}`,
              dir: grant?.dir ?? '',
              reason: `首次连接 MCP server「${s.name}」：它的工具会以这条命令的权限在本机执行`,
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
      format: skill.format === 'agentskills' ? 'agentskills' : 'legacy'
    })
    return { ok: true, skill: saved }
  })
  ipcMain.handle('skills:remove', (_e, id: string) => {
    getStore().removeSkill(id)
    return { ok: true }
  })

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
    const { meta, body } = parseSkillFrontmatter(raw)
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

  // ---------- 工具层（沙箱执行；渲染层可直调用于验证/高级用途） ----------
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

  // ---------- 改动检查点（回滚） ----------
  ipcMain.handle('checkpoint:manifest', async (_e, id: string) => {
    const m = checkpoints.manifestOf(String(id ?? ''))
    return { manifest: m, summary: checkpoints.summarize(m), delta: await checkpoints.deltaOf(String(id ?? '')) }
  })
  ipcMain.handle('checkpoint:rollback', async (_e, id: string) => {
    return checkpoints.rollback(String(id ?? ''))
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

  /** 产物目录的文件清单（验收项↔文件映射要拿真实目录核对，不能只信角色说的话） */
  ipcMain.handle('artifact:ls', async () => {
    const dir = workflowOutDir(getStore)
    if (!dir) return { ok: false, files: [], message: '产物目录不可用' }
    const { files, truncated } = await checkpoints.listDirFiles(dir)
    const out: { rel: string; bytes: number }[] = []
    for (const rel of files) {
      try {
        out.push({ rel, bytes: (await stat(join(dir, rel))).size })
      } catch {
        out.push({ rel, bytes: 0 })
      }
    }
    return { ok: true, dir, files: out, truncated }
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
      const p = join(dir, safe)
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

  /** 打开本机文件或目录（产物交付卡片用）：只接受存在的绝对路径 */
  ipcMain.handle('app:openPath', async (_e, p: string) => {
    if (typeof p !== 'string' || !isAbsolute(p)) return { ok: false, message: '只接受绝对路径' }
    if (!existsSync(p)) return { ok: false, message: `路径不存在：${p}` }
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
    const tap = ledgerTap({ channel: 'cli', harness: name, ...(opts?.model ? { model: opts.model } : {}) })
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
