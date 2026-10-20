import { app, BrowserWindow, nativeTheme, ipcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { registerIpc } from './ipc'
import { Store } from './store'

// 窗口状态持久化（简化：保存位置尺寸，启动时恢复并做屏幕边界校验）
interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean }

const devServerUrl = process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null
let store: Store | null = null

// 本应用为界面型应用，无 3D/视频需求；禁用硬件加速提升受限环境兼容性
// （软件渲染对聊天界面无感知差异；若目标环境 GPU 稳定可删除此行）
app.disableHardwareAcceleration()

// 兼容性开关（默认关闭）：部分安全软件会破坏 Chromium 沙箱导致 GPU/渲染子进程
// 0xC0000005 崩溃。设置 AGENTHUB_NO_SANDBOX=1 可禁用 Chromium 沙箱（降低渲染进程隔离，
// 本应用仅加载本地页面且无远程内容，风险可控）。正常机器无需开启。
if (process.env.AGENTHUB_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
  console.log('[main] AGENTHUB_NO_SANDBOX=1：已禁用 Chromium 沙箱（兼容模式）')
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1280, height: 800 }
  try {
    const p = join(app.getPath('userData'), 'window-state.json')
    if (!existsSync(p)) return fallback
    const s = JSON.parse(readFileSync(p, 'utf-8')) as WindowState
    // 屏幕边界校验：位置超出可视屏幕时回退默认
    const screen = require('electron').screen
    const displays = screen.getAllDisplays()
    const visible = displays.some((d: { workArea: { x: number; y: number; width: number; height: number } }) => {
      const { x, y, width, height } = d.workArea
      return (s.x ?? 0) >= x - 50 && (s.x ?? 0) < x + width && (s.y ?? 0) >= y - 50 && (s.y ?? 0) < y + height
    })
    if (!visible) return { ...fallback, maximized: s.maximized }
    return { ...s, width: Math.max(s.width, 960), height: Math.max(s.height, 640) }
  } catch {
    return fallback
  }
}

function saveWindowState(win: BrowserWindow) {
  try {
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    const s: WindowState = { ...bounds, maximized: win.isMaximized() }
    writeFileSync(join(app.getPath('userData'), 'window-state.json'), JSON.stringify(s))
  } catch { /* 忽略窗口状态保存失败 */ }
}

/** 截图验证序列：--shots=<目录> 时驱动各界面状态并逐张截屏（规格 §23 视觉验证） */
async function runShotSequence(win: BrowserWindow) {
  const arg = process.argv.find((a) => a.startsWith('--shots='))!
  const dir = arg.slice('--shots='.length)
  const fs = await import('node:fs')
  fs.mkdirSync(dir, { recursive: true })
  const logFile = join(dir, 'log.txt')
  const log = (line: string) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`) } catch { /* noop */ }
    console.log(`[shots] ${line}`)
  }
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(join(dir, `${name}.png`), img.toPNG())
    log(`saved ${name}.png (${img.getSize().width}x${img.getSize().height})`)
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const js = async (code: string) => {
    try {
      const r = await win.webContents.executeJavaScript(code)
      const st = await win.webContents
        .executeJavaScript('JSON.stringify(window.__ahub_debug ? window.__ahub_debug.state() : {nohook:true})')
        .catch(() => 'state?')
      log(`js ok -> state=${st}`)
      return r
    } catch (e) {
      log(`js error: ${e}`)
      return undefined
    }
  }

  log('sequence start')
  // 01 欢迎页（完整开屏时间线后）
  await wait(4200)
  await shot('01-welcome')
  // 02 品牌首页
  await js('window.__ahub_debug && window.__ahub_debug.brand()')
  await wait(1300)
  await shot('02-brand-home')
  // 03 工作台（空状态 + 演示 Agent）
  await js('window.__ahub_debug && window.__ahub_debug.workbench()')
  await wait(2300)
  await shot('03-workbench')
  // 04 工作流首页（配置条）
  await js('window.__ahub_debug && window.__ahub_debug.workflow()')
  await wait(1200)
  await shot('04-workflow-home')
  // 05 演示任务运行中（第一轮规划/执行卡片流式）
  await js('window.__ahub_debug && window.__ahub_debug.startDemoTask()')
  await wait(6500)
  await shot('05-task-running')
  // 06 等待人工确认门（第 1 轮审核完，含一次返工建议）
  await wait(6000)
  await shot('06-review-gate')
  // 07 返工后交付：通过确认门 → 交付卡片
  await js('window.__ahub_debug && window.__ahub_debug.passGate()')
  await wait(3500)
  await shot('07-delivery')
  // 08 状态导出（校验截图之外的真实状态断言）
  const state = await win.webContents.executeJavaScript('JSON.stringify(window.__ahub_debug && window.__ahub_debug.state())')
  console.log(`[shots] final state: ${state}`)
  app.quit()
}

function createWindow() {
  const ws = loadWindowState()
  const win = new BrowserWindow({
    ...ws,
    width: ws.width,
    height: ws.height,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b0c', // 开屏黑底，避免白闪
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  if (ws.maximized) win.maximize()
  let shown = false
  win.once('ready-to-show', () => {
    shown = true
    win.show()
  })
  // 窗口显示前渲染进程连续崩溃（典型表现：双击后无任何反应）时，
  // 自动以兼容模式重启一次（禁用 Chromium 沙箱）。正常机器不触发、沙箱保持开启。
  let preShowCrashes = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    if (shown || preShowCrashes >= 99) return
    preShowCrashes += 1
    console.log(`[main] 窗口显示前渲染进程异常（${details.reason}），计数 ${preShowCrashes}`)
    if (preShowCrashes >= 2 && process.env.AGENTHUB_NO_SANDBOX !== '1') {
      console.log('[main] 自动切换兼容模式重启（AGENTHUB_NO_SANDBOX=1）')
      delete process.env.ELECTRON_RUN_AS_NODE
      process.env.AGENTHUB_NO_SANDBOX = '1'
      app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith('--shots=')) })
      app.quit()
    }
  })
  win.on('close', () => saveWindowState(win))

  // 诊断：渲染层 console 与加载状态转发到主进程 stdout
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`)
  })
  win.webContents.on('did-finish-load', () => console.log('[main] renderer did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`[main] did-fail-load ${code} ${desc}`))
  win.webContents.on('render-process-gone', (_e, details) => console.log(`[main] render-process-gone: ${details.reason}`))

  // 截图验证模式
  if (process.argv.some((a) => a.startsWith('--shots='))) {
    void runShotSequence(win)
  }

  // 居中诊断模式：--diag 输出欢迎页关键元素的边界矩形（像素级核对），结果写入临时目录 agenthub-diag.json
  if (process.argv.includes('--diag')) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(
            `JSON.stringify((()=>{const r=(s)=>{const el=document.querySelector(s);if(!el)return null;const b=el.getBoundingClientRect();return {l:+b.left.toFixed(1),r:+b.right.toFixed(1),t:+b.top.toFixed(1),b:+b.bottom.toFixed(1),cx:+((b.left+b.right)/2).toFixed(1),cy:+((b.top+b.bottom)/2).toFixed(1)}};return {vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio,inner:r('.splash-inner'),logo:r('.splash-logo'),word:r('.splash-word'),wrap:r('.splash-start-wrap'),btn:r('.btn-start')}})())`
          )
          .then((r) => {
            try {
              writeFileSync(join(app.getPath('temp'), 'agenthub-diag.json'), String(r))
            } catch { /* 写失败不阻塞 */ }
            console.log('[diag]', r)
            app.quit()
          })
          .catch((e) => {
            console.log('[diag] error', String(e))
            app.quit()
          })
      }, 5200)
    })
  }

  // 加载失败时提供可重试的错误页，而不是一直卡住
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain) return
    console.error(`[main] 加载失败 code=${code} desc=${desc}`)
    const retry = encodeURIComponent(url)
    const html = `<!doctype html><html><body style="margin:0;background:#0b0b0c;color:#f7f2e8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
      <div style="font-size:18px">界面加载失败</div><div style="opacity:.6;font-size:13px">${desc}</div>
      <button onclick="location.href=decodeURIComponent('${retry}')" style="padding:10px 24px;border:0;border-radius:8px;background:#b45309;color:#fff;font-size:14px;cursor:pointer">重试</button>
    </body></html>`
    win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    // out/main/index.js -> ../../dist/renderer/index.html
    win.loadFile(join(__dirname, '../../dist/renderer/index.html'))
  }
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    store = new Store()
    registerIpc(() => store as Store, () => mainWindow)
    // 跟随主题（渲染进程可通过 theme:set 覆盖 themeSource）
    nativeTheme.themeSource = 'system'
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// 主题 IPC（在 ipc.ts 中注册其余通道）
ipcMain.handle('theme:set', (_e, theme: 'light' | 'dark' | 'system') => {
  nativeTheme.themeSource = theme
})
