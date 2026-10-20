import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { Store } from './store'
import { scanAgents, checkManualPath } from './discovery'
import * as openai from './adapters/openai'
import type { CustomModelConfig, AgentSession, WorkflowRun, Prefs, AgentConfig, AppConfig } from '../shared/types'

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
    userDataPath: app.getPath('userData')
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
  ipcMain.handle('session:save', (_e, session: AgentSession) => {
    getStore().saveSession(session)
    return { ok: true }
  })
  ipcMain.handle('session:load', (_e, agentId: string) => getStore().loadSession(agentId))
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

  ipcMain.handle('model:chat', (_e, cfg: CustomModelConfig, reqId: string, messages: { role: string; content: string }[]) => {
    const key = getStore().getCredential(cfg.keyId)
    if (!key) {
      const win = getWin()
      win?.webContents.send('model:event', { reqId, type: 'error', message: '未找到 API Key，请先在 Agent 设置中填写并保存' })
      return { ok: false }
    }
    openai.chatStream(cfg, key, reqId, messages, (ev) => {
      getWin()?.webContents.send('model:event', ev)
    })
    return { ok: true }
  })

  ipcMain.handle('model:cancel', (_e, reqId: string) => {
    openai.cancelStream(reqId)
    return { ok: true }
  })

  // ---------- 对话框 ----------
  ipcMain.handle('dialog:pickFiles', async () => {
    const win = getWin()
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: '添加附件',
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
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
