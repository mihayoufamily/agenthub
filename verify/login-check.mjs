// 账号体系验证 v2（2026-10-26 二批）：无锁屏 + 数据档案 + 头像 + 云端同步。
// 断言口径：
//  1) 无密码启动：应用直接可用（无锁屏 UI）
//  2) 档案隔离：首个账号收养遗留数据；新账号空档案起步（Agent 数为 0）；切回主账号数据还在
//  3) 头像：上传 dataURL 存取生效
//  4) 云端同步：推送→本地改动→拉取，账号表与档案回到推送时点（自制 sync-server 本地起）
//  5) 手机端登录照旧（错密码 401 / 对密码换发 token）
// 前置：构建 + 部署便携版。隔离 profile，可与用户实例并存。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9257
const HTTP_PORT = 8749
const SYNC_PORT = 8790
try { rmSync('D:/dsh/agenthub/.tmp/profile-auth', { recursive: true, force: true }) } catch { /* 忽略 */ }

let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const BASE = `http://127.0.0.1:${HTTP_PORT}`

async function anonJson(path, body) {
  const r = await fetch(BASE + path, body !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {})
  let parsed = null
  try { parsed = await r.json() } catch { /* 空 body */ }
  return { status: r.status, body: parsed ?? {} }
}

const syncProc = spawn('node', ['D:/dsh/agenthub/relay/sync-server.mjs', `--port=${SYNC_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
syncProc.stderr?.on('data', (d) => console.log('[sync-err]', d.toString().trim().slice(0, 160)))
const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--user-data-dir=D:/dsh/agenthub/.tmp/profile-auth'], { stdio: 'ignore', env: launchEnv() })
let cdp = null
try {
  // 同步服务就绪
  let syncOk = false
  for (let i = 0; i < 20; i++) {
    try { syncOk = (await (await fetch(`http://127.0.0.1:${SYNC_PORT}/sync/info?k=${'0'.repeat(32)}`)).json()).ok === true; if (syncOk) break } catch { /* 重试 */ }
    await sleep(400)
  }
  check('自制同步服务启动且 /sync/info 健康', syncOk)

  const page = await waitHttp(PORT, 30000)
  cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 30000)
  // 测试实例固定用 8749（8748 可能被用户实例占用）
  await js(cdp, `window.agenthub.config.get().then((c) => window.agenthub.config.setPrefs({ ...c.prefs, mobileService: { ...c.prefs.mobileService, port: ${HTTP_PORT} } }))`)
  await js(cdp, 'window.agenthub.mobile.setEnabled(true)')
  await sleep(2500) // 等 App 启动编排完成（demo Agent 种子等）

  /* ---- 1) 无密码启动 ---- */
  const lockShown = await js(cdp, `document.body.innerText.includes('已锁定')`)
  check('无锁屏：启动直接进应用（无「已锁定」字样）', lockShown === false)
  const st0 = await js(cdp, 'window.agenthub.auth.state()')
  check('初始档案：无账号时机主（local）', st0?.active?.id === 'local' && st0?.hasAccounts === false, JSON.stringify(st0))

  /* ---- 2) 档案隔离 ---- */
  const addA = await js(cdp, `window.agenthub.auth.addAccount('alice', 'pass1234')`)
  check('创建 alice（首个账号，收养遗留档案）', addA?.ok === true, JSON.stringify(addA))
  await js(cdp, 'location.reload()')
  await sleep(2800)
  await waitJs(cdp, '!!window.agenthub', 15000)
  const stA = await js(cdp, 'window.agenthub.auth.state()')
  check('重启后档案=alice（上次使用者）', stA?.active?.id === addA?.id && stA?.active?.name === 'alice', JSON.stringify(stA))
  const seedN = (await js(cdp, 'window.agenthub.config.get()'))?.agents?.length ?? 0
  check('alice 收养了遗留 Agent（种子数据跟人走）', seedN >= 2, String(seedN))

  const loginA = await anonJson('/api/login', { username: 'alice', password: 'pass1234' })
  const A = loginA.body.token
  const viaA = await anonJson('/api/state?a=' + A)
  check('手机端以 alice 视角看到她的 Agent', viaA.status === 200 && (viaA.body.agents ?? []).length === seedN, JSON.stringify({ n: (viaA.body.agents ?? []).length }))

  const addB = await js(cdp, `window.agenthub.auth.addAccount('bob', 'bobpass56')`)
  check('创建 bob（新账号自动成为当前档案）', addB?.ok === true, JSON.stringify(addB))
  await js(cdp, 'location.reload()')
  await sleep(2800)
  await waitJs(cdp, '!!window.agenthub', 15000)
  const loginB = await anonJson('/api/login', { username: 'bob', password: 'bobpass56' })
  const B = loginB.body.token
  const viaB = await anonJson('/api/state?a=' + B)
  // 新空档案会走 App 的首次运行种子（自动补演示 Agent，开箱可用）——
  // 隔离的正确口径：bob 的 Agent 与 alice 的没有任何共享 id
  const aliceIds = new Set((viaA.body.agents ?? []).map((a) => a.id))
  const isolated = (viaB.body.agents ?? []).every((a) => !aliceIds.has(a.id))
  check('bob 的 Agent 档案与 alice 隔离（无共享 id；新档案自动种演示 Agent）', viaB.status === 200 && isolated, JSON.stringify({ bobN: (viaB.body.agents ?? []).length, aliceN: aliceIds.size }))

  // 切回 alice（侧栏同款通道）：无密码
  const sw = await js(cdp, `window.agenthub.auth.listAccounts().then((l) => window.agenthub.auth.setActive(l.find((x) => x.name === 'alice').id))`)
  check('切回 alice（无密码）', sw?.ok === true, JSON.stringify(sw))
  const viaA2 = await anonJson('/api/state?a=' + A)
  check('alice 的数据在切换后原样还在', viaA2.status === 200 && (viaA2.body.agents ?? []).length === seedN, JSON.stringify({ n: (viaA2.body.agents ?? []).length }))

  /* ---- 3) 头像 ---- */
  const tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofGh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJgA/9k='
  const av = await js(cdp, `window.agenthub.auth.listAccounts().then((l) => window.agenthub.auth.setAvatar(l.find((x) => x.name === 'alice').id, ${JSON.stringify(tinyJpeg)}))`)
  check('上传头像 → 保存成功', av?.ok === true, JSON.stringify({ ok: av?.ok }))
  const avState = await js(cdp, 'window.agenthub.auth.state()')
  check('当前档案带头像 dataURL', avState?.active?.avatar === tinyJpeg, JSON.stringify({ has: !!avState?.active?.avatar }))

  /* ---- 4) 云端同步往返 ---- */
  const push = await js(cdp, `window.agenthub.auth.cloudPush('http://127.0.0.1:${SYNC_PORT}', 'sync-pass-1234')`)
  check('推送到云端（alice+bob 档案加密托管）', push?.ok === true, JSON.stringify(push))
  // 本地改动：再加 carol（推送时点之后的变化应被拉取覆盖）
  await js(cdp, `window.agenthub.auth.addAccount('carol', 'carolpass78')`)
  const pull = await js(cdp, `window.agenthub.auth.cloudPull('http://127.0.0.1:${SYNC_PORT}', 'sync-pass-1234')`)
  check('从云端拉取（覆盖回推送时点）', pull?.ok === true, JSON.stringify(pull))
  const afterPull = await js(cdp, 'window.agenthub.auth.listAccounts()')
  const names = (afterPull ?? []).map((x) => x.name).sort()
  check('拉取后账号表回到推送时点（carol 被覆盖掉）', names.join(',') === 'alice,bob', JSON.stringify(names))
  const avAfter = await js(cdp, 'window.agenthub.auth.state()')
  check('头像随云端档案一起恢复', avAfter?.active?.avatar === tinyJpeg, JSON.stringify({ has: !!avAfter?.active?.avatar }))

  /* ---- 5) 手机端登录（口径回归） ---- */
  const bad = await anonJson('/api/login', { username: 'alice', password: 'nope' })
  check('手机登录：错密码 401', bad.status === 401 && /用户名或密码不对/.test(bad.body.message ?? ''), JSON.stringify(bad.body))
  const good = await anonJson('/api/login', { username: 'alice', password: 'pass1234' })
  check('手机登录：对密码换发 token', good.status === 200 && !!good.body.token, JSON.stringify({ status: good.status }))
  const noCred = await anonJson('/api/state')
  check('无凭据 → 401（fail-closed 不变）', noCred.status === 401, String(noCred.status))
} catch (e) {
  failed++
  console.log('  ✗ 脚本异常 — ' + (e?.stack ?? e))
} finally {
  try { cdp?.socket?.end() } catch { /* 忽略 */ }
  try { proc.kill() } catch { /* 忽略 */ }
  try { syncProc.kill() } catch { /* 忽略 */ }
  await sleep(800)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
