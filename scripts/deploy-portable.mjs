// 便携版部署：release/AgentHub-win-x64 → D:/AgentHub（本机安装位置）
// 背景：2026-10-25/26 连续出现"部署命令看着成功、目标目录实际是旧内容"的事故
// （文件被占用时 cp 部分失败被吞、或外部进程用旧构建覆盖）。人肉 cp 链没有任何
// 校验，所以这里把部署收口成脚本：复制完逐字节核对关键产物，不一致就大声失败。
//
// 用法：node scripts/deploy-portable.mjs [目标目录，默认 D:/AgentHub]
// 注意：应用运行中无法覆盖 exe——先退出 AgentHub（托盘右键 → 退出）再跑。
import { cpSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const srcDir = join(process.cwd(), 'release', 'AgentHub-win-x64')
const dstDir = resolve(process.argv[2] ?? 'D:/AgentHub')

if (!existsSync(join(srcDir, 'AgentHub.exe'))) {
  console.error('[deploy] 缺少 release 产物：先运行 npm run pack:portable')
  process.exit(1)
}
if (existsSync(join(dstDir, 'AgentHub.exe')) === false && existsSync(dstDir) === false) {
  console.error(`[deploy] 目标目录不存在：${dstDir}`)
  process.exit(1)
}

// 1) 应用本体：整体替换 resources/app（旧目录删不掉就报错退出，绝不原地混拷）
const appSrc = join(srcDir, 'resources', 'app')
const appDst = join(dstDir, 'resources', 'app')
try {
  rmSync(appDst, { recursive: true, force: true })
} catch (e) {
  console.error(`[deploy] 旧 resources/app 删不掉（应用在运行或文件被占用）：${e.message}`)
  process.exit(1)
}
cpSync(appSrc, appDst, { recursive: true })
cpSync(join(srcDir, 'AgentHub.exe'), join(dstDir, 'AgentHub.exe'))
// 公网接入捆绑：cloudflared.exe 在 resources/bin（= process.resourcesPath/bin），与 app 目录同级
// ——漏了它 mobile-tunnel 找不到二进制，公网开关显示"未找到组件"且无法关闭（2026-10-26 实测踩坑）
if (existsSync(join(srcDir, 'resources', 'bin'))) {
  cpSync(join(srcDir, 'resources', 'bin'), join(dstDir, 'resources', 'bin'), { recursive: true })
}

// 2) 自校验：关键产物逐字节与 release 一致，不一致即失败退出
const keyFiles = [
  'dist/renderer/bundle.js',
  'out/main/index.js',
  'out/main/lifecycle.js',
  'out/main/ipc.js',
  'package.json'
]
let allOk = true
for (const rel of keyFiles) {
  const s = join(appSrc, rel)
  const d = join(appDst, rel)
  if (!existsSync(s)) continue
  const sb = readFileSync(s)
  const db = existsSync(d) ? readFileSync(d) : null
  const same = db !== null && sb.length === db.length && sb.equals(db)
  if (!same) allOk = false
  console.log(`${same ? 'OK ' : 'MISMATCH '} ${rel} (${db ? db.length : '缺失'} bytes)`)
}
// exe 也核对字节数（204MB 逐字节比较太慢，比大小足够暴露复制失败）
const exeS = statSync(join(srcDir, 'AgentHub.exe')).size
const exeD = existsSync(join(dstDir, 'AgentHub.exe')) ? statSync(join(dstDir, 'AgentHub.exe')).size : -1
console.log(`${exeS === exeD ? 'OK ' : 'MISMATCH '} AgentHub.exe (${exeD} bytes)`)
if (exeS !== exeD) allOk = false

if (!allOk) {
  console.error('[deploy] 自校验失败：目标目录内容与 release 不一致——包不可信，请检查文件占用后重试')
  process.exit(1)
}
console.log(`[deploy] DEPLOY_VERIFIED -> ${dstDir}（启动 AgentHub.exe 即为最新构建）`)
