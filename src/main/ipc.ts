import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { join, isAbsolute } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import type { Store } from './store'
import { scanAgents, checkManualPath } from './discovery'
import * as openai from './adapters/openai'
import * as cli from './adapters/cli'
import type { CustomModelConfig, AgentSession, WorkflowRun, Prefs, AgentConfig, AppConfig, ToolGrant, Skill } from '../shared/types'
import { execTool } from './tools'
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

  // ---------- 调用账本（脱敏元数据；用量统计与排障共用一份数据源） ----------
  ipcMain.handle('ledger:list', (_e, limit?: number) => ledger.list(limit ?? 200))
  ipcMain.handle('ledger:stats', (_e, sinceTs?: number) => ledger.aggregate(ledger.list(100000).filter((e) => !sinceTs || e.ts >= sinceTs)))
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

  ipcMain.handle('model:chat', (_e, cfg: CustomModelConfig, reqId: string, messages: openai.IncomingMsg[], opts?: { agentId?: string; workflow?: boolean }) => {
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
      workflow: !!opts?.workflow
    })
    openai.chatStream(cfg, key, reqId, messages, (ev) => {
      tap(ev)
      getWin()?.webContents.send('model:event', ev)
    }, grant)
    return { ok: true }
  })

  ipcMain.handle('model:cancel', (_e, reqId: string) => {
    openai.cancelStream(reqId)
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
  ipcMain.handle('tools:exec', async (_e, grant: ToolGrant, tool: string, argsJson: string) => {
    if (!grant || typeof grant.dir !== 'string' || !grant.dir) {
      return { ok: false, output: '拒绝：未配置工具目录' }
    }
    return execTool(grant, tool, argsJson)
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
  ipcMain.handle('artifact:write', (_e, fileName: string, content: string) => {
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
      writeFileSync(p, body, 'utf-8')
      return { ok: true, path: p }
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

  // 模型清单：可枚举的 CLI 返回列表（CodeBuddy 解析 --help，Codex 读 catalog），其余如实说明
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
