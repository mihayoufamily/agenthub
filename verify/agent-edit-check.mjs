// Agent 编辑配置（2026-10-25 批次）：入口显隐 + model:test 凭据回退路径
// 用法：node verify/agent-edit-check.mjs [--port=9235]
// 前置：先构建并同步便携版（npm run build && npm run pack:portable 后同步），应用未在运行。
// 断言口径：
//  1) UI：管理卡片操作区——model 类 Agent 有「编辑配置…」，demo/CLI 类没有；
//  2) IPC：model:test 在 apiKey 为空时按 cfg.hasKey 回退已存凭据（主进程取明文，渲染层不经手）：
//     - hasKey:false + 空 Key → 结构化失败（不真发网络请求）
//     - hasKey:true + 不存在的 keyId + 空 Key → "未找到 API Key" 类失败（回退查找路径）
//     两例都不依赖真实端点，失败信息均为"没 Key"而非"连接失败"。
import { spawn } from 'node:child_process'
import { CdpClient, sleep, launchEnv, waitHttp, js, waitJs } from './cdp.mjs'

const PORT = 9235
let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const proc = spawn('D:/AgentHub/AgentHub.exe', [`--remote-debugging-port=${PORT}`, '--ahub-verify'], { stdio: 'ignore', env: launchEnv() })
try {
  const page = await waitHttp(PORT, 25000)
  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitJs(cdp, '!!window.agenthub', 25000)
  // 验证钩子在 agenthub 就绪后几十毫秒才装上；启动停的是品牌首页，先进工作台再等侧栏水合
  await waitJs(cdp, '!!window.__ahub_debug', 25000)
  await js(cdp, 'window.__ahub_debug.workbench()')
  await waitJs(cdp, 'document.querySelectorAll(".agent-list .agent-item").length > 0', 25000)
  await sleep(800) // 首帧渲染稳定

  /* ---- 1) model:test 凭据回退（先打 IPC，不依赖 UI 状态） ---- */
  // hasKey:false + 空 Key：没有可回退的凭据，主进程必须结构化拒绝而不是拿空 Key 打真实请求
  const noKey = await js(cdp, `window.agenthub.models.test({ provider:'p', baseUrl:'https://example.invalid/v1', modelId:'m', keyId:'key_none', hasKey:false }, '')`)
  check('model:test 空 Key + hasKey:false → 结构化失败（ok:false + message）',
    noKey?.ok === false && typeof noKey?.message === 'string', JSON.stringify(noKey)?.slice(0, 160))
  check('失败原因是"没 Key"而不是"连接失败"（证明没拿空 Key 出网）',
    noKey?.ok === false && /API Key/.test(noKey?.message ?? ''), JSON.stringify(noKey)?.slice(0, 160))
  // hasKey:true + 不存在的 keyId + 空 Key：走回退查找路径，查无此凭据同样结构化失败
  const staleKey = await js(cdp, `window.agenthub.models.test({ provider:'p', baseUrl:'https://example.invalid/v1', modelId:'m', keyId:'key_not_exist_zz', hasKey:true }, '')`)
  check('model:test 空 Key + 不存在的 keyId → 回退查找后结构化失败',
    staleKey?.ok === false && /API Key/.test(staleKey?.message ?? ''), JSON.stringify(staleKey)?.slice(0, 160))

  /* ---- 2) 管理卡片「编辑配置…」入口显隐 ---- */
  // 逐个 Agent 点开 ⋯ 管理卡片，按头部摘要判定类型再断言按钮有无。
  // React 18 并发渲染：点击后的 DOM 更新在微任务里落地，同步读拿不到菜单——每步之间真 await。
  const ui = await js(cdp, `(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms))
    const items = [...document.querySelectorAll('.agent-list .agent-item')]
    const out = []
    for (const item of items) {
      const more = item.querySelector('.more')
      if (!more) continue
      more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await tick(120)
      const menu = document.querySelector('.agent-menu')
      if (!menu) { out.push({ name: '?', kind: 'no-menu', edit: false }); continue }
      const head = menu.querySelector('.ac-head-sub')?.textContent ?? ''
      const actions = [...menu.querySelectorAll('[data-sec-actions] button')].map((b) => b.textContent.trim())
      const kind = head.includes('演示 Agent') ? 'demo' : head.includes('CLI Agent') ? 'cli' : 'model'
      out.push({ name: menu.querySelector('.ac-head-name')?.textContent ?? '?', kind, edit: actions.includes('编辑配置…'), actions })
      more.dispatchEvent(new MouseEvent('click', { bubbles: true })) // 复位，别影响下一个
      await tick(120)
    }
    return out
  })()`)
  const list = Array.isArray(ui) ? ui : []
  check('读到了侧栏 Agent 列表（≥1 项）', list.length > 0, JSON.stringify(list)?.slice(0, 200))
  for (const a of list) {
    if (a.kind === 'model') {
      check(`「${a.name}」(model) 管理卡片有「编辑配置…」`, a.edit === true, JSON.stringify(a.actions))
    } else {
      check(`「${a.name}」(${a.kind}) 管理卡片没有「编辑配置…」`, a.edit === false, JSON.stringify(a.actions))
    }
  }
  check('至少存在一个 model 类 Agent（正向用例真实跑过）', list.some((a) => a.kind === 'model'), JSON.stringify(list.map((a) => a.kind)))

  /* ---- 3) 编辑弹窗本体：预填 / Key 状态提示 / 保存按钮文案随改动切换（全程只读，不点保存） ---- */
  const modal = await js(cdp, `(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms))
    const items = [...document.querySelectorAll('.agent-list .agent-item')]
    for (const item of items) {
      const more = item.querySelector('.more')
      if (!more) continue
      more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await tick(120)
      const menu = document.querySelector('.agent-menu')
      if (!menu) continue
      const head = menu.querySelector('.ac-head-sub')?.textContent ?? ''
      if (head.includes('演示 Agent') || head.includes('CLI Agent')) {
        more.dispatchEvent(new MouseEvent('click', { bubbles: true })); await tick(120); continue
      }
      const editBtn = [...menu.querySelectorAll('[data-sec-actions] button')].find((b) => b.textContent.includes('编辑配置…'))
      if (!editBtn) return { error: 'model 类 Agent 卡片上没找到编辑按钮' }
      editBtn.click()
      await tick(200)
      const m = document.querySelector('.modal')
      if (!m) return { error: '点了编辑但弹窗没出现' }
      const inputs = [...m.querySelectorAll('.modal-body input')]
      // 输入顺序：名称 / Base URL / 模型 ID / API Key(password)
      const [nameI, urlI, modelI, keyI] = inputs
      const out = {
        title: m.querySelector('.modal-head')?.textContent ?? '',
        name: nameI?.value ?? '', baseUrl: urlI?.value ?? '', modelId: modelI?.value ?? '',
        keyPlaceholder: keyI?.placeholder ?? '',
        hasKeyHint: m.querySelector('.modal-body')?.textContent.includes('已配置') ?? false,
        hasClear: [...m.querySelectorAll('button')].some((b) => b.textContent.includes('清除已存 Key')),
        saveLabel: [...m.querySelectorAll('.modal-foot button')].map((b) => b.textContent.trim())
      }
      // 改一个连接字段（不点保存）：保存按钮应从「保存」变成「测试连接并保存」
      const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setVal.call(modelI, (modelI.value || 'm') + '-x')
      modelI.dispatchEvent(new Event('input', { bubbles: true }))
      await tick(150)
      out.saveLabelAfterChange = [...m.querySelectorAll('.modal-foot button')].map((b) => b.textContent.trim())
      // 关掉弹窗，别留现场
      m.querySelector('.modal-head .icon-btn')?.click()
      await tick(120)
      return out
    }
    return { error: '没找到 model 类 Agent 的管理卡片' }
  })()`)
  if (modal?.error) {
    check('编辑弹窗打开并预填', false, modal.error)
  } else {
    check('弹窗标题是「编辑配置 —…」', (modal?.title ?? '').includes('编辑配置'), modal?.title)
    check('名称字段预填了当前 Agent 名', !!modal?.name, modal?.name)
    check('Base URL 与模型 ID 预填了当前连接配置', !!modal?.baseUrl && !!modal?.modelId, `${modal?.baseUrl} / ${modal?.modelId}`)
    check('Key 输入框提示"留空 = 保持现有 Key 不变"', (modal?.keyPlaceholder ?? '').includes('留空'), modal?.keyPlaceholder)
    check('显示"已配置"状态且有「清除已存 Key」入口', modal?.hasKeyHint === true && modal?.hasClear === true)
    check('未改动时保存按钮文案是「保存」', (modal?.saveLabel ?? []).includes('保存'), JSON.stringify(modal?.saveLabel))
    check('改动连接字段后按钮切为「测试连接并保存」', (modal?.saveLabelAfterChange ?? []).includes('测试连接并保存'), JSON.stringify(modal?.saveLabelAfterChange))
  }
  /* ---- 4) 技能区折叠开关：点标题折叠/展开，重开卡片后状态仍在（prefs 持久化） ---- */
  const toggleSeq = await js(cdp, `(async () => {
    const tick = (ms) => new Promise((r) => setTimeout(r, ms))
    const item = [...document.querySelectorAll('.agent-list .agent-item')][0]
    const more = item?.querySelector('.more')
    if (!more) return { error: '没有 Agent 项' }
    more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick(120)
    const tg = () => document.querySelector('[data-skills-toggle]')
    if (!tg()) return { error: '没找到技能区折叠标题' }
    const snap = () => ({
      expanded: tg()?.getAttribute('aria-expanded') === 'true',
      modeVisible: !!document.querySelector('[data-skill-mode]'),
      modeBadge: [...(tg()?.querySelectorAll('.ac-badge') ?? [])].map((b) => b.textContent.trim())
    })
    // 初始态不假设：上一次跑如果防抖写盘被杀进程打断，会遗留折叠态（真实事故——本脚本自己踩过）。
    // 先归一到展开态再开始断言，展开落盘要等 400ms 防抖。
    if (snap().expanded === false) { tg().click(); await tick(600) }
    const before = snap()
    tg().click() // 折叠
    await tick(200)
    const collapsed = snap()
    // 关卡片再开：折叠态应保持（走 prefs 持久化，400ms 防抖后落盘）
    more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick(150)
    more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick(300)
    const reopened = snap()
    tg().click() // 还原成展开，别把用户的偏好留在测试态
    // 等 600ms 让 patchPrefs 的 400ms 防抖真正落盘——上次就是这里只等 200ms 就杀进程，
    // 还原写盘丢了，遗留折叠态把下一次跑的断言整体反转
    await tick(600)
    const restored = snap()
    return { before, collapsed, reopened, restored }
  })()`)
  if (toggleSeq?.error) {
    check('技能区折叠开关可用', false, toggleSeq.error)
  } else {
    check('归一后展开：aria-expanded=true 且注入方式可见', toggleSeq?.before?.expanded === true && toggleSeq?.before?.modeVisible === true, JSON.stringify(toggleSeq?.before))
    check('点击标题后折叠：注入方式区消失，徽章显示注入档位',
      toggleSeq?.collapsed?.expanded === false && toggleSeq?.collapsed?.modeVisible === false && (toggleSeq?.collapsed?.modeBadge ?? []).some((t) => t === '自动注入' || t === '仅可引用'),
      JSON.stringify(toggleSeq?.collapsed))
    check('关卡片重开后折叠态保持（prefs 持久化生效）',
      toggleSeq?.reopened?.expanded === false && toggleSeq?.reopened?.modeVisible === false, JSON.stringify(toggleSeq?.reopened))
    check('再点一次还原展开', toggleSeq?.restored?.expanded === true && toggleSeq?.restored?.modeVisible === true, JSON.stringify(toggleSeq?.restored))
  }
  cdp.socket.end()
} finally {
  // 多留 500ms：让最后一次 patchPrefs 的防抖写盘走完 IPC 再杀进程，不留测试态
  await sleep(800)
  try { proc.kill() } catch { /* noop */ }
}
console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
