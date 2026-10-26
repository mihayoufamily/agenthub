// 手机端页面（2026-10-26 批次）：主进程 HTTP 服务直出的自包含 HTML——无构建、无外部资源、
// 零依赖（token 经 URL ?t= 携带，页面 fetch 原样带回；改模板时注意 ${} 转义与引号配对）。
// 视觉对齐 AgentHub 暗色 tokens（背景/卡片/主色近似值硬编码，与桌面端 tokens.css 同源取值）。
export const MOBILE_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#17181c">
<title>AgentHub</title>
<style>
  :root{--bg:#17181c;--panel:#1e2025;--panel2:#24262d;--line:#2e3138;--txt:#e8eaf0;--sub:#9aa0ad;
    --accent:#4f8ef7;--ok:#3fbf7f;--warn:#e8a33d;--bad:#e06456;--radius:12px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    font-size:15px;line-height:1.5;padding-bottom:env(safe-area-inset-bottom)}
  header{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);
    padding:10px 14px;display:flex;align-items:center;gap:8px;z-index:5}
  header b{font-size:16px}
  header .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);margin-left:auto}
  header .dot.off{background:var(--bad)}
  nav{display:flex;background:var(--panel);border-bottom:1px solid var(--line)}
  nav button{flex:1;padding:11px 0;background:none;border:none;color:var(--sub);font-size:14px;
    border-bottom:2px solid transparent}
  nav button.on{color:var(--txt);border-bottom-color:var(--accent)}
  main{padding:12px;max-width:720px;margin:0 auto}
  .chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;-webkit-overflow-scrolling:touch}
  .chips button{flex-shrink:0;padding:6px 12px;border-radius:16px;background:var(--panel2);
    border:1px solid var(--line);color:var(--sub);font-size:13px}
  .chips button.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .msg{margin:10px 0;max-width:86%}
  .msg .bubble{padding:9px 12px;border-radius:var(--radius);white-space:pre-wrap;word-break:break-word}
  .msg.user{margin-left:auto}.msg.user .bubble{background:var(--accent);color:#fff;border-bottom-right-radius:4px}
  .msg.assistant .bubble{background:var(--panel2);border:1px solid var(--line);border-bottom-left-radius:4px}
  .msg .meta{font-size:11px;color:var(--sub);margin-top:3px;text-align:right}
  .msg .tools{font-size:11px;color:var(--sub);margin-top:3px}
  .msg .tools span{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-right:4px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
    padding:12px;margin:10px 0}
  .card h3{font-size:14px;margin-bottom:6px;font-weight:600}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--panel2);
    border:1px solid var(--line);color:var(--sub);margin-right:6px}
  .badge.running{color:#7db2ff;border-color:#3a5a8c}.badge.waiting_user,.badge.waiting_review{color:var(--warn);border-color:#8c6a2f}
  .badge.completed{color:var(--ok);border-color:#2f6b4d}.badge.failed,.badge.cancelled,.badge.timeout,
  .badge.token_limit,.badge.budget_limit,.badge.rework_limit,.badge.interrupted,.badge.stopping{color:var(--bad);border-color:#7c4038}
  .gate{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);display:flex;gap:8px;flex-wrap:wrap}
  .gate input{flex:1 1 100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;
    color:var(--txt);padding:8px;font-size:14px}
  .gate button{flex:1;padding:9px 0;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font-size:14px}
  .gate button.ok{background:var(--ok);border-color:var(--ok);color:#fff}
  .gate button.stop{color:var(--bad)}
  .kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
  .kv:last-child{border-bottom:none}
  .kv b{font-variant-numeric:tabular-nums}
  .send{position:sticky;bottom:0;background:var(--panel);border-top:1px solid var(--line);
    padding:10px 12px;display:flex;gap:8px}
  .send textarea{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:10px;
    color:var(--txt);padding:9px;font-size:15px;font-family:inherit;resize:none;height:42px}
  .send button{background:var(--accent);border:none;border-radius:10px;color:#fff;padding:0 18px;font-size:15px}
  .hint{color:var(--sub);font-size:13px;text-align:center;padding:30px 20px}
  .err{position:fixed;top:0;left:0;right:0;background:var(--bad);color:#fff;font-size:13px;
    padding:6px 14px;text-align:center;z-index:9;display:none}
</style>
</head>
<body>
<div class="err" id="err">连接桌面端失败，正在重试…</div>
<header><b>AgentHub</b><span id="conn" class="dot" title="连接状态"></span></header>
<nav>
  <button data-tab="chat" class="on">会话</button>
  <button data-tab="tasks">任务</button>
  <button data-tab="usage">用量</button>
</nav>
<main id="main"></main>
<div class="send" id="sendbar" style="display:none">
  <textarea id="input" placeholder="发消息给当前 Agent…（Enter 换行，按钮发送）"></textarea>
  <button id="sendbtn">发送</button>
</div>
<script>
(function(){
  'use strict'
  var T = new URLSearchParams(location.search).get('t') || localStorage.getItem('ahub_t') || ''
  if (T) localStorage.setItem('ahub_t', T)
  var state = null, curAgent = localStorage.getItem('ahub_agent') || null, tab = 'chat', timer = null
  var $ = function(id){ return document.getElementById(id) }
  var main = $('main')

  function api(path, opts){
    opts = opts || {}
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(T)
    return fetch(url, opts).then(function(r){
      if (r.status === 401) { document.body.innerHTML = '<div class="hint" style="padding-top:40vh">🔗 配对无效或已更换<br><span style="font-size:12px">请回桌面端「手机查看」重新扫码</span></div>'; throw new Error('401') }
      return r.json()
    })
  }

  function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
  function fmtTs(ts){ if(!ts) return ''; var d = new Date(ts); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2) }
  function fmtTokens(n){ if(!n) return '0'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n) }

  function setConn(ok){ $('conn').className = 'dot' + (ok ? '' : ' off'); $('err').style.display = ok ? 'none' : 'block' }

  // ---- 会话标签 ----
  function renderChat(){
    var agents = (state && state.agents) || []
    if (!agents.length) { main.innerHTML = '<div class="hint">还没有 Agent。</div>'; return }
    if (!curAgent || !agents.some(function(a){ return a.id === curAgent })) curAgent = state.activeAgentId || agents[0].id
    var chips = '<div class="chips">' + agents.map(function(a){
      return '<button data-agent="' + esc(a.id) + '" class="' + (a.id === curAgent ? 'on' : '') + '">' + esc(a.name) + '</button>'
    }).join('') + '</div>'
    var s = state.session
    var msgs = ''
    if (!s || s.agentId !== curAgent) msgs = '<div class="hint">该 Agent 暂无会话。</div>'
    else msgs = (s.messages || []).map(function(m){
      var tools = m.toolNames && m.toolNames.length ? '<div class="tools">' + m.toolNames.map(function(n){ return '<span>' + esc(n) + '</span>' }).join('') + '</div>' : ''
      var meta = []
      if (m.handoffFrom) meta.push('来自 ' + esc(m.handoffFrom))
      if (m.model) meta.push(esc(m.model))
      if (m.cost != null) meta.push('¥' + m.cost)
      if (m.streaming) meta.push('…')
      return '<div class="msg ' + esc(m.role) + '"><div class="bubble">' + esc(m.text) + '</div>' + tools +
        (meta.length ? '<div class="meta">' + meta.join(' · ') + ' · ' + fmtTs(m.ts) + '</div>' : '') + '</div>'
    }).join('') || '<div class="hint">还没有消息。</div>'
    main.innerHTML = chips + msgs
    window.scrollTo(0, document.body.scrollHeight)
    main.querySelectorAll('[data-agent]').forEach(function(b){
      b.addEventListener('click', function(){ curAgent = b.getAttribute('data-agent'); localStorage.setItem('ahub_agent', curAgent); render(); refresh() })
    })
    $('sendbar').style.display = 'flex'
  }

  function sendMsg(){
    var input = $('input'), text = (input.value || '').trim()
    if (!text) return
    input.value = ''
    api('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: curAgent, text: text }) })
      .then(function(r){ if (!r.ok) alert(r.message || '发送失败'); else refresh() })
      .catch(function(){ alert('发送失败：桌面端不可达') })
  }

  // ---- 任务标签 ----
  function renderTasks(){
    $('sendbar').style.display = 'none'
    var runs = (state && state.runs) || []
    if (!runs.length) { main.innerHTML = '<div class="hint">还没有工作流任务。<br><span style="font-size:12px">在桌面端新建任务后，这里实时显示进度。</span></div>'; return }
    main.innerHTML = runs.map(function(r){
      var gateHtml = ''
      if (r.gate) {
        var label = r.gate.kind === 'plan' ? '计划批准门' : '审核确认门'
        gateHtml = '<div class="gate"><span class="badge waiting_user">' + label + ' · 第 ' + r.gate.round + ' 轮</span>' +
          '<input id="fb-' + esc(r.id) + '" placeholder="反馈意见（可空）">' +
          '<button class="ok" data-gate="deliver" data-run="' + esc(r.id) + '">' + (r.gate.kind === 'plan' ? '批准计划' : '通过') + '</button>' +
          '<button data-gate="rework" data-run="' + esc(r.id) + '">返工</button>' +
          '<button class="stop" data-gate="stop" data-run="' + esc(r.id) + '">停止</button></div>'
      }
      var meta = []
      if (r.stage) meta.push(esc(r.stage))
      if (r.maxRounds) meta.push('第 ' + r.round + '/' + r.maxRounds + ' 轮')
      if (r.tokens) meta.push(fmtTokens(r.tokens) + ' tok')
      if (r.demo) meta.push('演示')
      return '<div class="card"><h3>' + esc(r.goal) + '</h3>' +
        '<span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span>' +
        '<span style="font-size:12px;color:var(--sub)">' + meta.join(' · ') + '</span>' + gateHtml + '</div>'
    }).join('')
    main.querySelectorAll('[data-gate]').forEach(function(b){
      b.addEventListener('click', function(){
        var runId = b.getAttribute('data-run'), action = b.getAttribute('data-gate')
        var fb = document.getElementById('fb-' + runId)
        var feedback = fb ? (fb.value || '') : ''
        if (action === 'stop' && !confirm('确定停止这个任务？')) return
        api('/api/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: runId, action: action, feedback: feedback }) })
          .then(function(r){ if (!r.ok) alert(r.message || '操作失败'); else refresh() })
          .catch(function(){ alert('操作失败：桌面端不可达') })
      })
    })
  }

  // ---- 用量标签 ----
  function renderUsage(){
    $('sendbar').style.display = 'none'
    var u = (state && state.usage) || { today: {}, total: {} }
    var row = function(name, v){ return '<div class="kv"><span>' + name + '</span><b>' + v + '</b></div>' }
    main.innerHTML = '<div class="card"><h3>今日</h3>' +
      row('调用次数', (u.today.calls || 0)) + row('Token', fmtTokens(u.today.tokens)) + row('折算费用', '¥' + (u.today.cost || 0)) + '</div>' +
      '<div class="card"><h3>累计</h3>' +
      row('调用次数', (u.total.calls || 0)) + row('Token', fmtTokens(u.total.tokens)) + row('折算费用', '¥' + (u.total.cost || 0)) + '</div>' +
      '<div class="hint" style="padding-top:12px">口径与桌面端设置页一致：只统计有真实上报的调用。</div>'
  }

  function render(){
    if (tab === 'chat') renderChat()
    else if (tab === 'tasks') renderTasks()
    else renderUsage()
  }

  function refresh(){
    return api('/api/state?agent=' + encodeURIComponent(curAgent || ''))
      .then(function(s){ state = s; setConn(true); render() })
      .catch(function(e){ if (String(e.message) !== '401') setConn(false) })
  }

  document.querySelectorAll('nav button').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('nav button').forEach(function(x){ x.classList.remove('on') })
      b.classList.add('on')
      tab = b.getAttribute('data-tab')
      render()
    })
  })
  $('sendbtn').addEventListener('click', sendMsg)
  $('input').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg() }
  })

  function loop(){ if (!document.hidden) refresh() }
  refresh(); timer = setInterval(loop, 3000)
})()
</script>
</body>
</html>`
