// 便携目录打包（纯 JS，不依赖 electron-builder 的 Go 二进制）
// 产出 release/AgentHub-win-x64/：直接运行 AgentHub.exe（即 electron.exe 改名）
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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

rmSync(outDir, { recursive: true, force: true })
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

// 3) 说明
writeFileSync(join(outDir, '使用说明.txt'), [
  'AgentHub 便携版',
  '',
  '1. 双击 AgentHub.exe 运行。',
  '2. 数据保存在 %APPDATA%/agenthub/，卸载时删除该目录即可清除全部本地数据。',
  '3. 若 GPU/界面异常，可设置环境变量 AGENTHUB_NO_SANDBOX=1 后再运行（兼容模式）。',
  '4. 首次使用建议点击"添加 Agent → 演示 Agent"体验完整流程。',
  ''
].join('\n'))

console.log(`[pack] done -> ${resolve(outDir)}`)
console.log('[pack] 运行 AgentHub.exe 即可（免安装）')
