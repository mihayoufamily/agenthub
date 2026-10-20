// 开发流程：构建 main + renderer -> 探测可用的 electron 可执行文件 -> 启动
// 说明：某些受控环境中，工作区目录内的原生二进制执行受限（表现为 ICU/句柄错误），
// 启动器会自动把 electron dist 镜像到系统临时目录后再运行，对最终用户无感知。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const isWin = process.platform === 'win32'
const root = process.cwd()
const npm = isWin ? 'npm.cmd' : 'npm'
const distDir = join(root, 'node_modules', 'electron', 'dist')

function runStep(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: isWin })
    p.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))))
    p.on('error', rejectPromise)
  })
}

try {
  await runStep(npm, ['run', 'build:main'])
  await runStep(npm, ['run', 'build:renderer'])
} catch (e) {
  console.error(`[dev] 构建失败：${e.message}`)
  process.exit(1)
}

function probe(exe) {
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return r.status === 0 && (r.stdout || '').includes('v')
  } catch {
    return false
  }
}

function pickElectron() {
  const direct = join(distDir, isWin ? 'electron.exe' : 'electron')
  if (probe(direct)) return direct
  // 受限环境回退：镜像到临时目录
  const mirror = join(os.tmpdir(), 'agenthub-electron-dist')
  const mirrorExe = join(mirror, isWin ? 'electron.exe' : 'electron')
  if (!probe(mirrorExe)) {
    console.log('[dev] 工作区目录内 electron 受限，镜像到临时目录运行…')
    rmSync(mirror, { recursive: true, force: true })
    cpSync(distDir, mirror, { recursive: true })
  }
  if (!probe(mirrorExe)) {
    console.error('[dev] electron 无法运行，请检查上方日志')
    process.exit(1)
  }
  return mirrorExe
}

const exe = pickElectron()
// 剥离 ELECTRON_RUN_AS_NODE：某些宿主环境（如 WorkBuddy 会话）会全局设置它，
// 使 electron.exe 以纯 Node 模式运行导致主进程拿不到 Electron API
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
console.log(`[dev] 启动: ${exe} ${root}`)
const electron = spawn(exe, [root], { stdio: 'inherit', env: childEnv })
electron.on('exit', (code) => process.exit(code ?? 0))
