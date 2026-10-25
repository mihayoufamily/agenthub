// 便携目录打包（纯 JS，不依赖 electron-builder 的 Go 二进制）
// 产出 release/AgentHub-win-x64/：直接运行 AgentHub.exe（即 electron.exe 改名）
import { cpSync, rmSync, mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const cwd = process.cwd()
const outDir = join(cwd, 'release', 'AgentHub-win-x64')
const electronDist = join(cwd, 'node_modules', 'electron', 'dist')

if (!existsSync(join(electronDist, 'electron.exe'))) {
  console.error('[pack] 缺少 electron 二进制：先运行 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js')
  process.exit(1)
}
if (!existsSync(join(cwd, 'out', 'main', 'index.js')) || !existsSync(join(cwd, 'dist', 'renderer', 'index.html'))) {
  console.error('[pack] 缺少构建产物：先运行 npm run build')
  process.exit(1)
}

// 目录被其他程序占用（如资源管理器打开中）时删除会失败。原地覆盖会把旧构建里已删除/改名的文件
// 混进新包，所以优先"挪走再新建"，挪不动才退回原地覆盖（显式警告，让人知道包里可能有残留）。
let leftoverDir = ''
try {
  rmSync(outDir, { recursive: true, force: true })
} catch {
  leftoverDir = `${outDir}.old-${Date.now()}`
  try {
    renameSync(outDir, leftoverDir)
    console.log(`[pack] 旧目录删不掉（被占用），已挪到 ${leftoverDir}，构建完成后清理`)
  } catch {
    console.warn('[pack] 警告：旧目录无法移走，包内可能混入上一版残留文件')
  }
}
mkdirSync(join(outDir, 'resources', 'app'), { recursive: true })

// 1) electron 运行时（整目录复制，主程序改名 AgentHub.exe）
// 注意：resources/default_app.asar 必须保留——实测删除后启动即 0xC0000005 崩溃
cpSync(electronDist, outDir, { recursive: true })
cpSync(join(outDir, 'electron.exe'), join(outDir, 'AgentHub.exe'))
rmSync(join(outDir, 'electron.exe'), { force: true })

// 2) 应用本体（非 asar：目录形式，便于用户检查与修改）
const appDir = join(outDir, 'resources', 'app')
cpSync(join(cwd, 'package.json'), join(appDir, 'package.json'))
cpSync(join(cwd, 'out'), join(appDir, 'out'), { recursive: true })
cpSync(join(cwd, 'dist'), join(appDir, 'dist'), { recursive: true })
// build/：应用图标（主进程 BrowserWindow 引用 resources/app/build/icon.ico）
if (existsSync(join(cwd, 'build', 'icon.ico'))) {
  cpSync(join(cwd, 'build'), join(appDir, 'build'), { recursive: true })
}
// builtin-skills/：官方内置技能（技能中心按 app.getAppPath()/builtin-skills 扫描，与 build/ 同级）
if (existsSync(join(cwd, 'builtin-skills'))) {
  cpSync(join(cwd, 'builtin-skills'), join(appDir, 'builtin-skills'), { recursive: true })
}

// 3) 兼容模式一键启动器（安全软件拦截沙箱导致双击无反应时使用）
writeFileSync(join(outDir, 'start-compat-mode.cmd'), [
  '@echo off',
  'set AGENTHUB_NO_SANDBOX=1',
  'start "" "%~dp0AgentHub.exe"',
  ''
].join('\r\n'))

// 4) 说明
writeFileSync(join(outDir, '使用说明.txt'), [
  'AgentHub 便携版',
  '',
  '1. 双击 AgentHub.exe 运行。',
  '2. 数据保存在 %APPDATA%/agenthub/，卸载时删除该目录即可清除全部本地数据。',
  '3. 默认启用硬件加速（界面动画更流畅）。若启动即崩溃会自动降级为软件渲染重启；也可手动设置环境变量 AGENTHUB_NO_GPU=1 强制软件渲染，设置 AGENTHUB_NO_SANDBOX=1 禁用沙箱（兼容模式，或直接运行 start-compat-mode.cmd）。',
  '4. 首次使用建议点击"添加 Agent → 演示 Agent"体验完整流程。',
  ''
].join('\n'))

// 收尾：清掉前面挪走的旧目录；失败只打一行警告（不影响本次产出，下轮打包会再试删一次）
if (leftoverDir) {
  try {
    rmSync(leftoverDir, { recursive: true, force: true })
  } catch {
    console.warn(`[pack] 警告：旧目录清理失败（可手动删除）：${leftoverDir}`)
  }
}

console.log(`[pack] done -> ${resolve(outDir)}`)
console.log('[pack] 运行 AgentHub.exe 即可（免安装）')
