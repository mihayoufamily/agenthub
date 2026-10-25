import { app, BrowserWindow, nativeTheme, ipcMain, Menu, Tray, dialog, nativeImage, shell, Notification } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { registerIpc } from './ipc'
import { Store } from './store'
import * as approvals from './approvals'
import * as checkpoints from './checkpoints'
import { configurePriceOverrides } from '../shared/overrides'
import { navDecision } from '../shared/winnav'
import { decideFallback, forcedCompatCrashEnabled, normalizePolicy, gpuStageAction, compatHintPending, SANDBOX_CRASH_THRESHOLD, FORCE_SANDBOX_CRASH_ENV, COMPAT_HINT_ENV, COMPAT_FAIL_TITLE, COMPAT_FAIL_MESSAGE_GPU, COMPAT_FAIL_MESSAGE_SANDBOX, VERIFY_SWITCH } from '../shared/compat'
import { decideCloseNow, isBusy, setQuitting } from './lifecycle'
import * as ledger from './ledger'
import { consumePendingUpdate } from './updater'

// 窗口状态持久化（简化：保存位置尺寸，启动时恢复并做屏幕边界校验）
interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean }

const devServerUrl = process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null
let store: Store | null = null

/**
 * 验证态开关：argv 带 --ahub-verify（或 --shots 截图序列——它自己就是靠渲染层的 __ahub_debug
 * 驱动的）时，把 ahub-verify=1 折进页面 URL，渲染层据此安装调试钩子（App.tsx 的 isVerifyRuntime）。
 * 与 ipc.ts 里 config:importJson 的注册闸门同一个先例：不用 app.isPackaged 当闸门——被测的
 * 部署构建本来就是 packaged，isPackaged 区分不了"发布版"和"验证跑"。
 */
const isVerifyLaunch = process.argv.includes(VERIFY_SWITCH) || process.argv.some((a) => a.startsWith('--shots='))

// 降级事实记录：徽章按"实际关了什么"显示，不按"配置里写了什么"——
// 用户要能分辨"我这台机器现在正跑在兼容模式"和"配置允许它降级"
let compatState = {
  noSandbox: process.env.AGENTHUB_NO_SANDBOX === '1',
  noGpu: process.env.AGENTHUB_NO_GPU === '1',
  reason: (process.env.AGENTHUB_NO_SANDBOX === '1' ? 'sandbox' : process.env.AGENTHUB_NO_GPU === '1' ? 'gpu' : '') as string
}

// 渲染策略：默认启用硬件加速（GPU 合成）——设置界面/工作流卡片/模式切换动画的帧率
// 依赖 GPU 合成，软件渲染下会明显掉帧。GPU 异常由下方"显示前崩溃自动降级"兜底：
// 渲染进程启动即崩时自动以 --disable-gpu 重启一次，仍崩再走 Chromium 沙箱兼容模式。

// 兼容性开关（默认关闭）：GPU 异常时手动设置 AGENTHUB_NO_GPU=1 强制软件渲染（等效旧版默认行为）
if (process.env.AGENTHUB_NO_GPU === '1') {
  app.disableHardwareAcceleration()
  console.log('[main] AGENTHUB_NO_GPU=1：已禁用硬件加速（软件渲染兼容模式）')
}

// 兼容性开关（默认关闭）：部分安全软件会破坏 Chromium 沙箱导致 GPU/渲染子进程
// 0xC0000005 崩溃。设置 AGENTHUB_NO_SANDBOX=1 可禁用 Chromium 沙箱（降低渲染进程隔离，
// 本应用仅加载本地页面且无远程内容，风险可控）。正常机器无需开启。
if (process.env.AGENTHUB_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
  console.log('[main] AGENTHUB_NO_SANDBOX=1：已禁用 Chromium 沙箱（兼容模式）')
}

// 验证专用：强制进入"已降级"状态，让徽章与三态可被 CDP 断言（Task 6 Step 7b 的正向半段）。
// 两道闸缺一不可（decideFallback 之外的另一个纯函数 forcedCompatCrashEnabled）：
// argv 必须带 --ahub-verify，且 env 显式为 '1'。用户正常双击不带该开关——
// 就算环境里残留了这个变量，也绝不会被显示成一个凭空的假徽章。
if (forcedCompatCrashEnabled(process.argv, process.env[FORCE_SANDBOX_CRASH_ENV])) {
  compatState = { noSandbox: true, noGpu: false, reason: 'sandbox(forced)' }
  console.log('[main] 验证门控：按已降级状态呈现徽章')
}

// Windows toast 的前置条件：不声明 AppUserModelId 时 Notification.show() 在部分机器上被系统静默丢弃
// （评审 finding 2：此前全仓没设过，"降级后提示一次"基本没人看到过）。值与 electron-builder.yml 的
// appId 一致，NSIS 安装后的开始菜单快捷方式带同一个 AUMID，toast 才有归属、才会呈现。
if (process.platform === 'win32') app.setAppUserModelId('com.agenthub.app')

/**
 * 降级后的一次性提示（评审 finding 2）：**由 relaunch 起来的新实例在 ready-to-show 之后发**。
 * 旧写法是 Notification().show() 紧跟 app.relaunch()+app.quit() 两行——发通知的进程自己就是
 * 要退出的那个，toast 还没被系统拿出来就被带走了。现在降级实例只置 COMPAT_HINT_ENV 交接标志，
 * 新实例窗口真正显示出来后在这里发一次（非阻塞、失败只记日志——真正"看得见"靠常驻徽章）。
 */
let compatHintFired = false
function maybeShowCompatHint() {
  if (compatHintFired) return
  if (!compatHintPending(process.env[COMPAT_HINT_ENV], compatState.noSandbox)) return
  compatHintFired = true
  delete process.env[COMPAT_HINT_ENV]
  try {
    new Notification({
      title: '已启用兼容模式（Chromium 沙箱已关闭）',
      body: '顶栏徽章会一直标明当前状态；在「设置 → 关于」可改成每次问我、或不再自动降级。',
      silent: false
    }).show()
    console.log('[main] 兼容模式一次性提示已在新实例发出')
  } catch (e) {
    console.log(`[main] 兼容模式提示通知失败（不影响已救活的窗口）：${String(e)}`)
  }
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1280, height: 800 }
  // 运行时防御：window-state.json 可能被截断/手改，缺失或非法数值一律回退
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
  try {
    const p = join(app.getPath('userData'), 'window-state.json')
    if (!existsSync(p)) return fallback
    const s = JSON.parse(readFileSync(p, 'utf-8')) as WindowState
    const x = num(s.x, NaN)
    const y = num(s.y, NaN)
    // 屏幕边界校验：位置超出可视屏幕时回退默认
    const screen = require('electron').screen
    const displays = screen.getAllDisplays()
    const visible = displays.some((d: { workArea: { x: number; y: number; width: number; height: number } }) => {
      const { x: dx, y: dy, width, height } = d.workArea
      return x >= dx - 50 && x < dx + width && y >= dy - 50 && y < dy + height
    })
    const width = Math.max(num(s.width, 1280), 960)
    const height = Math.max(num(s.height, 800), 640)
    if (!visible) return { width: 1280, height: 800, maximized: s.maximized === true }
    return { x: Number.isFinite(x) ? x : undefined, y: Number.isFinite(y) ? y : undefined, width, height, maximized: s.maximized === true }
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
  // 05 演示任务运行中（第一轮规划/执行卡片流式）。
  // startDemoTask 现在强制三角色绑演示 Agent（零真实调用；2026-10-25 事故：原先用配置里
  // 当前绑定的真实 CLI 跑了真实调用、花了额度，且 90s 心跳把确认门拖到 06 之后才挂出）。
  // 它返回进门前的整份工作流配置与"是否本次现补演示 Agent"：patchConfig 会落盘，
  // 序列收尾必须原样还原，否则用户的角色绑定就被截图跑改掉了。
  const started = await js('window.__ahub_debug && window.__ahub_debug.startDemoTask()')
  await wait(6500)
  await shot('05-task-running')
  // 06 等待人工确认门（第 1 轮审核完，含一次返工建议）
  await wait(6000)
  await shot('06-review-gate')
  // 07 返工后交付：通过确认门 → 交付卡片
  await js('window.__ahub_debug && window.__ahub_debug.passGate()')
  await wait(3500)
  await shot('07-delivery')
  // 收尾还原：先回滚角色绑定再删本次现补的演示 Agent（用户的演示 Agent 不动）。
  // 还原要在截图全部完成之后——交付卡上的角色名来自绑定，中途还原会拍到真实 Agent 的名字
  if (started && started.prevConfig) {
    await js(`window.__ahub_debug.restoreWorkflowConfig(${JSON.stringify(started.prevConfig)})`)
  }
  if (started && started.added && started.agentName) {
    await js(`window.__ahub_debug.removeAgentByName(${JSON.stringify(started.agentName)})`)
  }
  if (started && started.rejected) {
    log('startDemoTask 被拒（执行链占用中）：本次未做任何演示绑定，也无配置可还原')
  }
  // 08 状态导出（校验截图之外的真实状态断言）
  const state = await win.webContents.executeJavaScript('JSON.stringify(window.__ahub_debug && window.__ahub_debug.state())')
  console.log(`[shots] final state: ${state}`)
  app.quit()
}

/**
 * 应用菜单：替换 Electron 的默认菜单。
 *
 * 默认菜单带三个坑（Ctrl+W 直接退出就是这么来的）：
 *  - Window ▸ Close（Ctrl+W）关唯一窗口 → window-all-closed → 应用静默退出；
 *  - View ▸ Force Reload（Ctrl+R）会重载渲染进程，**正在跑的工作流当场断掉**；
 *  - View ▸ Toggle Developer Tools（Ctrl+Shift+I）对普通用户是误触面。
 * 这里保留编辑类加速键（复制/粘贴等照常），Close 改为走我们自己的确认流程。
 */
function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', click: () => requestClose() },
        // 不给"退出"配加速键：Alt+F4 由系统处理（最终仍会走 win.on('close') 的同一套确认），
        // 而 Ctrl+Q 这类组合可能和用户自定义的快捷键撞车
        { label: '退出 AgentHub', click: () => { setQuitting(true); app.quit() } }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 关闭请求：没在跑就直接退；正在跑弹确认（默认"后台继续运行"） */
async function requestClose() {
  const win = mainWindow
  if (!win) return
  if (decideCloseNow() !== 'ask') {
    setQuitting(true)
    win.close()
    return
  }
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['后台继续运行（收到托盘）', '仍然退出应用', '取消（留在当前窗口）'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: '有工作流正在执行',
    message: '关闭后正在执行的工作流会中断',
    detail: '进度按阶段边界保存，重启后只能标为"状态未知"手动继续，不会自动续跑。选择后台继续运行时会缩到系统托盘，跑完弹通知。'
  })
  if (r.response === 0) {
    ensureTray()
    win.hide()
  } else if (r.response === 1) {
    setQuitting(true)
    win.close()
  }
}

let tray: Tray | null = null

function ensureTray() {
  if (tray) return
  const iconPath = join(__dirname, '../../build/icon.ico')
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip(isBusy() ? 'AgentHub · 工作流正在执行' : 'AgentHub')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { type: 'separator' },
      { label: '退出 AgentHub', click: () => { setQuitting(true); app.quit() } }
    ])
  )
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
}

/**
 * 往错误页 HTML 里插文本前的转义。实体集与 tools.ts 的 htmlToText 解码集对称
 * （&amp; &lt; &gt; &quot; &#39;）——那边解什么，这边就转什么，不留半边。
 */
function escapeHtmlText(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function createWindow() {
  const ws = loadWindowState()
  // 应用图标（out/main -> ../../build/icon.ico；便携版/asar 内同结构）
  const iconPath = join(__dirname, '../../build/icon.ico')
  const win = new BrowserWindow({
    ...ws,
    width: ws.width,
    height: ws.height,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b0c', // 开屏黑底，避免白闪
    autoHideMenuBar: true,
    show: false,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  // 窗口导航兜底：本应用只加载本地页面，任何跳外部的东西都该去系统浏览器，不该留在窗口里
  const navDevUrl = devServerUrl ?? null
  // 本应用真实 renderer 产物根：out/main -> ../../dist/renderer
  // （便携版是 <安装根>\resources\app\dist\renderer，asar 包是 <安装根>\resources\app.asar\dist\renderer）
  // 传普通文件系统路径而不是 URL 串——winnav 会把目标 pathname 解码后按路径段比对，
  // 带空格/中文的安装目录（C:\Program Files\…）也解得开、对得上。
  // 下面的 loadFile 必须用同一个量推入口，两者一旦漂移就是白屏或放行过宽。
  const navOwnRendererRoot = join(__dirname, '../../dist/renderer')
  // 外链在新窗口/标签请求时直接转浏览器打开（裸 deny 会让将来出现的 target=_blank 点了没反应）
  win.webContents.setWindowOpenHandler(({ url }) => {
    const act = navDecision(url, navDevUrl, navOwnRendererRoot)
    if (act === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 同窗口导航：自己的页面放行，外链挡下后转系统浏览器
  win.webContents.on('will-navigate', (e) => {
    const url = e.url
    const act = navDecision(url, navDevUrl, navOwnRendererRoot)
    if (act === 'allow') return
    e.preventDefault()
    if (act === 'external') void shell.openExternal(url)
    else console.log(`[main] 已拦截非法导航：${url.slice(0, 120)}`)
  })
  // 服务端 3xx 也算导航，不拦就等于绕过上面两条
  win.webContents.on('will-redirect', (e) => {
    const url = e.url
    const act = navDecision(url, navDevUrl, navOwnRendererRoot)
    if (act === 'allow') return
    e.preventDefault()
    if (act === 'external') void shell.openExternal(url)
    else console.log(`[main] 已拦截非法重定向：${url.slice(0, 120)}`)
  })
  if (ws.maximized) win.maximize()
  let shown = false
  win.once('ready-to-show', () => {
    shown = true
    win.show()
    // 一次性提示只能在"活着"的实例里发（评审 finding 2）：窗口已经能呈现了才通知
    maybeShowCompatHint()
  })
  // 窗口显示前渲染进程连续崩溃（典型表现：双击后无任何反应）时，
  // 自动以兼容模式重启一次（禁用 Chromium 沙箱）。正常机器不触发、沙箱保持开启。
  let preShowCrashes = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    if (shown || preShowCrashes >= 99) return
    preShowCrashes += 1
    console.log(`[main] 窗口显示前渲染进程异常（${details.reason}），计数 ${preShowCrashes}`)
    // 降级阶梯：第 1 次崩溃先试 --disable-gpu（GPU 驱动异常常见）；仍崩再禁 Chromium 沙箱。
    // 策略 off 覆盖整条阶梯（评审 finding 4 / Ruling L）：连 GPU 这级兜底也不做自动重启，直接报启动失败并说明两种成因。
    // 判定在 shared/compat.gpuStageAction（纯函数、逻辑层逐条断言），这里只执行动作。
    if (preShowCrashes === 1) {
      const gpuPolicy = normalizePolicy(store?.getConfig().sandboxFallback)
      const gpuAction = gpuStageAction(gpuPolicy, process.env.AGENTHUB_NO_GPU)
      if (gpuAction === 'fail') {
        // 已经软件渲染（AGENTHUB_NO_GPU=1）也走这里：旧写法把"已软件渲染"整块跳过，
        // off + 第 1 次崩溃于是既不重启也不报错，静默等第二次崩溃（评审 Minor 10）——
        // 而 off 的文案承诺的是"窗口出现前崩溃就直接报启动失败"。
        console.log('[main] sandboxFallback=off：不做任何自动重启（含 GPU 软件渲染兜底），按启动失败处理')
        dialog.showErrorBox(COMPAT_FAIL_TITLE, COMPAT_FAIL_MESSAGE_GPU)
        setQuitting()
        app.quit()
        return
      }
      if (gpuAction === 'relaunch') {
        console.log('[main] 自动降级为软件渲染重启（AGENTHUB_NO_GPU=1）')
        delete process.env.ELECTRON_RUN_AS_NODE
        process.env.AGENTHUB_NO_GPU = '1'
        compatState = { noSandbox: process.env.AGENTHUB_NO_SANDBOX === '1', noGpu: true, reason: 'gpu' }
        process.env.AGENTHUB_RELAUNCH = '1'
        app.relaunch({ args: process.argv.slice(1) })
        app.quit()
        return
      }
      // gpuAction === 'none'：本机已在软件渲染里跑，GPU 这一级不适用，落到下面沙箱那一级按阈值判
    }
    // 沙箱这一级：判断在 shared/compat.decideFallback（纯函数、逻辑层逐条断言过），这里只执行动作。
    // 进入条件与决策层共用同一个 SANDBOX_CRASH_THRESHOLD——再抄一遍 `>= 2` 就是第二份真相（评审 finding 1）
    if (preShowCrashes >= SANDBOX_CRASH_THRESHOLD) {
      // 已经在兼容模式下还连续崩：参数一样、重启只会原地打转，交给下面的"没救活"路径（窗口不出来）
      if (process.env.AGENTHUB_NO_SANDBOX === '1') {
        console.log('[main] 已在兼容模式（沙箱已关）仍连续崩溃，不再重复降级重启')
        return
      }
      const policy = normalizePolicy(store?.getConfig().sandboxFallback)
      const action = decideFallback(policy, preShowCrashes)
      if (action === 'none') {
        // 防御性兜底：进入条件与决策表共用同一常量，这条按理应不可达；留着是为了两处一旦漂移时
        // 什么都不做，而不是让本不该执行的降级穿过 fail/ask 分支直接 relaunch（评审 finding 1）
        console.log('[main] decideFallback 判定未到沙箱级（不应到达这里），不执行任何降级动作')
        return
      }
      if (action === 'fail') {
        console.log('[main] sandboxFallback=off：不自动降级，按启动失败处理')
        dialog.showErrorBox(COMPAT_FAIL_TITLE, COMPAT_FAIL_MESSAGE_SANDBOX)
        setQuitting()
        app.quit()
        return
      }
      if (action === 'ask') {
        // showMessageBoxSync 在窗口已销毁/异常时会 throw；抛出逸出崩溃处理器会连主进程一起带走——
        // 与本任务"崩了也要把人救活"的目标正相反。守卫 + try，异常一律按「用户拒绝」fail-closed（不重启、退出）
        let pick = 1
        try {
          if (win.isDestroyed()) {
            console.log('[main] ask：窗口已销毁、问不了，按用户拒绝处理（不重启）')
          } else {
            pick = dialog.showMessageBoxSync(win, {
              type: 'warning',
              title: 'AgentHub 启动异常',
              message: '渲染进程连续崩溃，通常与本机的安全软件拦截 Chromium 沙箱有关。',
              detail: '禁用沙箱可降低渲染进程隔离（本应用只加载本地页面）。是否以此方式重启？',
              buttons: ['以兼容模式重启', '不重启，退出'],
              defaultId: 0,
              cancelId: 1
            })
          }
        } catch (e) {
          console.log(`[main] ask：确认弹窗抛出异常，按用户拒绝处理（不重启）：${String(e)}`)
          pick = 1
        }
        if (pick !== 0) {
          setQuitting()
          app.quit()
          return
        }
      }
      console.log(`[main] 自动切换兼容模式重启（AGENTHUB_NO_SANDBOX=1，策略 ${policy}）`)
      compatState = { noSandbox: true, noGpu: process.env.AGENTHUB_NO_GPU === '1', reason: 'sandbox' }
      delete process.env.ELECTRON_RUN_AS_NODE
      process.env.AGENTHUB_NO_SANDBOX = '1'
      // 标记重启来源：新实例在拿不到单实例锁时短暂等待（旧实例退出与锁释放存在竞态）
      process.env.AGENTHUB_RELAUNCH = '1'
      // 首次真的降级才交接一次性提示。这里**不发通知**（本进程紧接着 quit，toast 发出去等于没发——评审 finding 2），
      // 只置 COMPAT_HINT_ENV；relaunch 起来的新实例在 ready-to-show 后经 maybeShowCompatHint 发那一次
      const ackPath = join(app.getPath('userData'), 'compat-acknowledged.json')
      if (!existsSync(ackPath)) {
        try {
          writeFileSync(ackPath, JSON.stringify({ firstAt: Date.now() }))
          process.env[COMPAT_HINT_ENV] = '1'
        } catch (e) {
          console.log(`[main] 兼容模式提示标记写入失败（不影响降级重启本身）：${String(e)}`)
        }
      }
      // 保留全部启动参数（含 --shots 验证模式），重启后行为一致
      app.relaunch({ args: process.argv.slice(1) })
      app.quit()
    }
  })
  win.on('close', (e) => {
    saveWindowState(win)
    // Alt+F4 / 任务栏关闭同样要过确认：正在跑的工作流不能被静默掐断
    if (decideCloseNow() === 'ask') {
      e.preventDefault()
      void requestClose()
    }
  })

  // 诊断：渲染层 console 与加载状态转发到主进程 stdout
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`)
  })
  win.webContents.on('did-finish-load', () => console.log('[main] renderer did-finish-load'))
  // 加载失败：既转发诊断，也提供可重试的错误页（而不是一直卡住）。
  // 原来这里挂了**两个** did-fail-load 监听器——一个只打日志、一个才出错页，改一个漏一个（修复波 A · 项 6），合并掉。
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    console.log(`[main] did-fail-load ${code} ${desc}`)
    if (!isMain) return
    console.error(`[main] 加载失败 code=${code} desc=${desc}`)
    // desc 来自 Chromium 的失败描述，内容不由我们控制，而这个 data: 页面是加载进**特权窗口**的：
    // 未转义插值等于把一段外部文本当 HTML 解析。url 那半边本来就编码了（encodeURIComponent +
    // 按钮里 decodeURIComponent），desc 没有——这是本分支唯一一处往特权页面做的未转义插值。
    const safeDesc = escapeHtmlText(desc)
    // retry 虽然 encodeURIComponent 过，但它**不转义单引号**，而这里是把值塞进 onclick 的
    // JS 字符串字面量里：失败 URL 里只要有一个 '，字面量就被截断、后面变成代码。
    // 单引号按 %27 编掉，decodeURIComponent 会原样还原（pathname 里 %27 与 ' 等价）。
    const retry = encodeURIComponent(url).replace(/'/g, '%27')
    const html = `<!doctype html><html><body style="margin:0;background:#0b0b0c;color:#f7f2e8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
      <div style="font-size:18px">界面加载失败</div><div style="opacity:.6;font-size:13px">${safeDesc}</div>
      <button onclick="location.href=decodeURIComponent('${retry}')" style="padding:10px 24px;border:0;border-radius:8px;background:#b45309;color:#fff;font-size:14px;cursor:pointer">重试</button>
    </body></html>`
    win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })
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

  // 加载失败的可重试错误页已并入上面那一个 did-fail-load 监听器（原来这里是第二个，重复且只改得到一半）

  if (devServerUrl) {
    // 验证态在 URL 上追加查询串（渲染层据此安装 __ahub_debug，见 App.tsx 的 isVerifyRuntime）
    win.loadURL(devServerUrl + (devServerUrl.includes('?') ? '&ahub-verify=1' : '?ahub-verify=1'))
  } else {
    // out/main/index.js -> ../../dist/renderer/index.html（与上面的 navOwnRendererRoot 同一个量推出来，避免漂移）
    // 验证态用 loadFile 的 options.search 追加查询串：electron.d.ts 的 LoadFileOptions.search 会被
    // url.format() 原样拼在 pathname 后（前导 ? 要自己带，实测 file:///…index.html?ahub-verify=1）。
    win.loadFile(join(navOwnRendererRoot, 'index.html'), isVerifyLaunch ? { search: '?ahub-verify=1' } : undefined)
  }
  return win
}

function startApp() {
  // 更新 pending 消费：上次「应用更新」没换成功（文件被占用）的，在这里补做——拿到单实例锁之后、
  // 建窗口之前，此刻旧 app 目录最可能未被锁定。不放在模块最顶上（require electron 之后立刻）：
  // 那会抢在单实例锁之前，双开竞态下会在"另一个实例还开着"时动手换目录，几乎必败还白删标记；
  // 锁拿到再动是同一时点里最安全的位置，依然早于任何窗口与业务初始化。
  // consumePendingUpdate 内部整体自守（成败都清标记、异常不外抛、绝不阻止启动），这里再兜一层
  // 最外层 catch：换入逻辑的任何异常都不许影响本次启动。
  try {
    if (consumePendingUpdate()) return // 有 pending 已处理：本进程马上 relaunch+quit，不再往下建窗口
  } catch (e) {
    console.log(`[main] 消费待应用更新失败（照常启动）：${String(e)}`)
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      // 缩到托盘后再次双击图标：把窗口叫回来，而不是"看起来没反应"
      if (!mainWindow.isVisible()) mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    store = new Store()
    // 真机上主进程的 stdout 是看不见的（打包后没有控制台），而排查"CLI 到底在哪个目录、带了哪些参数"
    // 这件事已经卡过两次。把 console 同时镜像进 logs/main.log（store.log 自带 2MB 上限、失败不阻塞）。
    {
      const tee = (level: 'log' | 'error') => {
        const orig = console[level].bind(console)
        console[level] = (...args: unknown[]) => {
          orig(...args)
          try {
            store?.log(`${level === 'error' ? '[error] ' : ''}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`)
          } catch { /* 日志失败不阻塞 */ }
        }
      }
      tee('log')
      tee('error')
    }
    // 主进程侧的单价口径要先就位，账本补算费用与预算闸才用得上你填的价
    configurePriceOverrides(store.getConfig().priceOverrides ?? [])
    const ud = app.getPath('userData')
    // 命令审批的规则与历史落在 userData，位置在这里注入（纯规则层不碰磁盘）
    approvals.init(join(ud, 'approvals.json'))
    checkpoints.init(join(ud, 'checkpoints'))
    ledger.init(join(ud, 'ledger.jsonl'))
    registerIpc(() => store as Store, () => mainWindow)
    // 兼容模式事实（只读）：徽章与设置页都问主进程"实际关掉了什么"，自己不留状态。
    // 为什么写在 index.ts 而不是 ipc.ts：compatState 是本模块的模块级状态，
    // 挪进 ipc.ts 就得让 ipc.ts 反向 import index.ts 拿 getter —— index.ts 已经 import 了
    // registerIpc，那是一条循环依赖。这里在 registerIpc 之后就地注册，一个通道一句话。
    ipcMain.handle('app:compat', () => ({
      ...compatState,
      policy: normalizePolicy(store?.getConfig().sandboxFallback)
    }))
    buildAppMenu()
    // 跟随主题（渲染进程可通过 theme:set 覆盖 themeSource）
    nativeTheme.themeSource = 'system'
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  // 任何"确定要退出"的路径（托盘退出 / 确认框选退出 / relaunch）都不再被关闭确认拦住
  app.on('before-quit', () => setQuitting(true))

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (gotLock) {
  startApp()
} else if (process.env.AGENTHUB_RELAUNCH === '1') {
  // 兼容模式重启与旧实例退出存在竞态：旧实例可能尚未释放单实例锁，
  // 短暂重试等待（最多约 5 秒），避免重启实例拿不到锁直接退出导致"双击后无窗口"
  console.log('[main] 单实例锁暂被占用（重启竞态），等待释放…')
  let lockTries = 0
  const lockTimer = setInterval(() => {
    lockTries += 1
    if (app.requestSingleInstanceLock()) {
      clearInterval(lockTimer)
      console.log('[main] 已获得单实例锁，继续启动')
      startApp()
    } else if (lockTries >= 20) {
      clearInterval(lockTimer)
      console.log('[main] 单实例锁等待超时，退出')
      app.quit()
    }
  }, 250)
} else {
  app.quit()
}

// 主题 IPC（在 ipc.ts 中注册其余通道）
ipcMain.handle('theme:set', (_e, theme: 'light' | 'dark' | 'system') => {
  // 值域闸门：nativeTheme.themeSource 的 setter 对非法值会 throw，渲染层传脏值不该掀掉主进程调用链
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
  nativeTheme.themeSource = theme
})
