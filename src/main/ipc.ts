import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { Store } from './store'
import { scanAgents, checkManualPath } from './discovery'
import * as openai from './adapters/openai'
import * as cli from './adapters/cli'
import type { CustomModelConfig, AgentSession, WorkflowRun, Prefs, AgentConfig, AppConfig, ToolGrant } from '../shared/types'
import { execTool } from './tools'
import { checkUpdate } from './updater'
import type { ChatMsg } from './adapters/openai'

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

  ipcMain.handle('model:chat', (_e, cfg: CustomModelConfig, reqId: string, messages: ChatMsg[], opts?: { tools?: ToolGrant }) => {
    const key = getStore().getCredential(cfg.keyId)
    if (!key) {
      const win = getWin()
      win?.webContents.send('model:event', { reqId, type: 'error', message: '未找到 API Key，请先在 Agent 设置中填写并保存' })
      return { ok: false }
    }
    // opts.tools（Agent 级授权）存在时启用工具循环：模型可在沙箱目录内读写文件/执行命令
    openai.chatStream(cfg, key, reqId, messages, (ev) => {
      getWin()?.webContents.send('model:event', ev)
    }, opts?.tools)
    return { ok: true }
  })

  ipcMain.handle('model:cancel', (_e, reqId: string) => {
    openai.cancelStream(reqId)
    return { ok: true }
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

  // ---------- 本机 CLI Agent（真实执行，凭据由 CLI 自身管理） ----------
  ipcMain.handle('cli:test', (_e, name: string) => {
    if (!cli.isKnownCli(name)) return { ok: false, message: `未知 CLI：${name}` }
    return cli.testConnection(name)
  })

  ipcMain.handle('cli:chat', async (_e, name: string, opts: cli.CliChatOptions, reqId: string, messages: { role: string; content: string; reasoning_content?: string }[]) => {
    if (!cli.isKnownCli(name)) {
      getWin()?.webContents.send('model:event', { reqId, type: 'error', message: `未知 CLI：${name}` })
      return { ok: false }
    }
    // 事件复用 model:event 通道（reqId 路由），渲染层无需区分来源
    return cli.cliChatStream(name, opts ?? {}, reqId, messages, (ev) => {
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
    // 只开放真实支持的附件类型：文本类白名单（内容会随真实调用发送给模型/CLI）
    const TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql']
    const MAX_BYTES = 64 * 1024
    const r = await dialog.showOpenDialog(win, {
      title: '添加文本附件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: `支持的文本文件（≤${Math.round(MAX_BYTES / 1024)}KB，内容将发送给 Agent）`, extensions: TEXT_EXT }]
    })
    if (r.canceled) return []
    const out: Array<{ name: string; path: string; size: number; content?: string; error?: boolean }> = []
    for (const p of r.filePaths) {
      const name = p.split(/[\\/]/).pop() ?? p
      try {
        const st = await stat(p)
        if (st.size > MAX_BYTES) {
          out.push({ name, path: p, size: st.size, error: true })
          continue
        }
        const content = await readFile(p, 'utf8')
        out.push({ name, path: p, size: st.size, content })
      } catch {
        out.push({ name, path: p, size: 0, error: true })
      }
    }
    return out
  })

  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string, content: string) => {
    const win = getWin()
    if (!win) return { ok: false, message: '窗口不可用' }
    const r = await dialog.showSaveDialog(win, {
      title: '导出',
      defaultPath: defaultName,
      filters: [{ name: '全部文件', extensions: ['*'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    const fs = await import('node:fs')
    fs.writeFileSync(r.filePath, content, 'utf-8')
    return { ok: true, message: r.filePath }
  })
}
