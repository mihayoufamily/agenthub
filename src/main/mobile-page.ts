// 手机端页面（2026-10-26 批次）：主进程 HTTP 服务直出的自包含 HTML——无构建、无外部资源、
// 零依赖（token 经 URL ?t= / 账号 token 经 localStorage 携带；改模板时注意 ${} 转义与引号配对）。
// 视觉对齐 AgentHub 暗色 tokens（背景/卡片/主色近似值硬编码，与桌面端 tokens.css 同源取值）。
// 交互改造（同日二批，用户反馈"太难用"）：
//  - 脏检查增量渲染：3s 轮询只在内容真变时重绘，滚动位置智能保持（贴底跟随、上翻不动）
//  - 中文输入法保护：isComposing/keyCode229 期间 Enter 不发送（选字误发是中文用户必踩坑）
//  - 乐观发送：消息立即上屏（半透明 pending），失败标红可点重发，落库后静默并入
//  - Agent 切换：头部显示当前 Agent（点开底部抽屉），替代横向 chips
//  - 输入栏 fixed + textarea 自增高 + visualViewport 键盘适配；事件全委托（重绘零重绑）
//  - 任务门：返工输入点击展开、停止两段确认；非会话页新消息 → 导航红点 + 标题提醒
// 大搬运（同日三批，用户要求"尽可能把桌面版搬到手机"+登录系统）：
//  - 登录视图：页面壳始终可载入（静态零数据），/api/state 401 时切登录视图；账号 token 存 localStorage
//  - 会话管理：会话列表抽屉（新建/切换/删除），历史全量回看（服务端截 400 条）
//  - 思考过程：assistant 消息的 reasoning 折叠展示（💭）
//  - Agent 管理：列表/切换/新建（自定义模型，走桌面同一条"先测连接再存凭据"链）
//  - 任务发起：任务页顶部直接发起工作流 / 停止进行中的任务
//  - 设置：当前用户/退出登录、服务与账号说明
export const MOBILE_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="theme-color" content="#17181c">
<title>AgentHub</title>
<style>
  :root{--bg:#17181c;--panel:#1e2025;--panel2:#24262d;--line:#2e3138;--txt:#e8eaf0;--sub:#9aa0ad;
    --accent:#4f8ef7;--ok:#3fbf7f;--warn:#e8a33d;--bad:#e06456;--radius:12px;--hdr:48px;--nav:42px}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html{touch-action:manipulation}
  /* Windows Chrome 默认滚动条带上下箭头按钮、宽 17px，手机页里又丑又占地 */
  ::-webkit-scrollbar{width:4px;height:4px}
  ::-webkit-scrollbar-thumb{background:#3a3d46;border-radius:2px}
  ::-webkit-scrollbar-button{display:none}
  ::-webkit-scrollbar-track{background:transparent}
  body{background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    font-size:15px;line-height:1.55}
  header{position:fixed;top:0;left:0;right:0;height:var(--hdr);background:var(--panel);
    border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;
    padding:0 12px calc(env(safe-area-inset-top)*0) ;padding-top:env(safe-area-inset-top);z-index:6;cursor:pointer}
  header .hd-main{display:flex;align-items:center;gap:7px;min-width:0;flex:1}
  header b{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  header .hd-sub{font-size:11px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1}
  header .chev{color:var(--sub);font-size:10px;flex-shrink:0}
  header .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);margin-left:auto;flex-shrink:0}
  header .dot.off{background:var(--bad)}
  nav{position:fixed;top:calc(var(--hdr) + env(safe-area-inset-top));left:0;right:0;height:var(--nav);
    background:var(--panel);border-bottom:1px solid var(--line);display:flex;z-index:6}
  nav button{flex:1;background:none;border:none;color:var(--sub);font-size:13.5px;position:relative;
    border-bottom:2px solid transparent;padding:10px 0}
  nav button.on{color:var(--txt);border-bottom-color:var(--accent)}
  nav button .nbadge{position:absolute;top:6px;right:calc(50% - 22px);min-width:15px;height:15px;
    border-radius:8px;background:var(--bad);color:#fff;font-size:10px;line-height:15px;padding:0 4px;display:none}
  main{padding:calc(var(--hdr) + var(--nav) + env(safe-area-inset-top) + 10px) 12px 92px;max-width:720px;margin:0 auto}
  /* 会话切换条：贴在导航下方，点开抽屉 */
  .sbar{display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:var(--panel);
    border:1px solid var(--line);border-radius:10px;color:var(--txt);font-size:13px;padding:8px 12px;margin-bottom:8px}
  .sbar:active{background:var(--panel2)}
  .sbar .sb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:var(--sub)}
  .msg{margin:10px 0;max-width:86%;display:flex;flex-direction:column}
  .msg .bubble{padding:9px 12px;border-radius:var(--radius);white-space:pre-wrap;word-break:break-word;cursor:pointer}
  .msg.user{margin-left:auto;align-items:flex-end}.msg.user .bubble{background:var(--accent);color:#fff;border-bottom-right-radius:4px}
  .msg.assistant{align-items:flex-start}
  .msg.assistant .bubble{background:var(--panel2);border:1px solid var(--line);border-bottom-left-radius:4px}
  .msg.pending .bubble{opacity:.55}
  .msg.failed .bubble{opacity:1;border-color:var(--bad)}
  .msg.err-msg .bubble{border-color:var(--bad)}
  .msg .meta{font-size:11px;color:var(--sub);margin-top:3px}
  .msg .tools{font-size:11px;color:var(--sub);margin-top:3px}
  .msg .tools span{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-right:4px}
  /* 思考过程：折叠块（💭），展开看全文 */
  details.think{margin-bottom:6px;border:1px dashed var(--line);border-radius:9px;background:var(--panel)}
  details.think summary{cursor:pointer;list-style:none;font-size:12px;color:var(--sub);padding:6px 10px;user-select:none}
  details.think summary::-webkit-details-marker{display:none}
  details.think .tk-body{white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--sub);
    padding:2px 10px 9px;border-top:1px solid var(--line);max-height:46vh;overflow-y:auto}
  .caret{display:inline-block;margin-left:2px}
  .caret i{display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--sub);margin-right:2px;
    animation:crt 1.1s infinite}
  .caret i:nth-child(2){animation-delay:.18s}.caret i:nth-child(3){animation-delay:.36s}
  @keyframes crt{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;margin:10px 0}
  .card.gate-card{border-left:3px solid var(--warn)}
  .card h3{font-size:14px;margin-bottom:6px;font-weight:600;line-height:1.4}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--panel2);
    border:1px solid var(--line);color:var(--sub);margin-right:6px}
  .badge.running{color:#7db2ff;border-color:#3a5a8c}.badge.waiting_user,.badge.waiting_review{color:var(--warn);border-color:#8c6a2f}
  .badge.completed{color:var(--ok);border-color:#2f6b4d}.badge.failed,.badge.cancelled,.badge.timeout,
  .badge.token_limit,.badge.budget_limit,.badge.rework_limit,.badge.interrupted,.badge.stopping{color:var(--bad);border-color:#7c4038}
  .card .cmeta{font-size:12px;color:var(--sub);margin-top:4px}
  .gate{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
  .gate .glabel{font-size:13px;color:var(--warn);margin-bottom:8px}
  .gate .gbtns{display:flex;gap:8px}
  .gate button{flex:1;padding:9px 0;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font-size:14px}
  .gate button:active{transform:scale(.97)}
  .gate button.ok{background:var(--ok);border-color:var(--ok);color:#fff}
  .gate button.stop{color:var(--bad);background:none}
  .gate button.stop.armed{background:var(--bad);border-color:var(--bad);color:#fff}
  .gate .gfb{margin-top:8px}
  .gate .gfb textarea{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;
    color:var(--txt);padding:8px;font-size:14px;font-family:inherit;resize:none;height:64px}
  .gate .gfb .fbrow{display:flex;gap:8px;margin-top:6px}
  .gate .gfb button{padding:8px 14px;font-size:13px}
  .kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
  .kv:last-child{border-bottom:none}
  .kv b{font-variant-numeric:tabular-nums}
  .send{position:fixed;bottom:0;left:0;right:0;background:var(--panel);border-top:1px solid var(--line);
    padding:8px 10px calc(8px + env(safe-area-inset-bottom));display:none;gap:8px;z-index:6;align-items:flex-end}
  .send textarea{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:12px;
    color:var(--txt);padding:9px 11px;font-size:15px;font-family:inherit;resize:none;height:40px;
    line-height:1.4;max-height:120px;overflow-y:auto}
  .send textarea:focus{outline:none;border-color:var(--accent)}
  .send button{background:var(--accent);border:none;border-radius:12px;color:#fff;padding:0 16px;
    height:40px;font-size:15px;flex-shrink:0}
  .send button:active{transform:scale(.96)}
  .send button.busy{opacity:.5}
  .hint{color:var(--sub);font-size:13px;text-align:center;padding:30px 20px;line-height:1.7}
  .hint .sub{font-size:12px;opacity:.75}
  .err{position:fixed;top:0;left:0;right:0;background:var(--bad);color:#fff;font-size:13px;
    padding:6px 14px;text-align:center;z-index:9;display:none}
  .mask{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:7;display:none;opacity:0;transition:opacity .18s}
  .mask.on{display:block;opacity:1}
  .sheet{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);
    border-radius:16px 16px 0 0;z-index:8;transform:translateY(105%);transition:transform .22s ease-out;
    padding-bottom:calc(10px + env(safe-area-inset-bottom));max-height:70vh;display:flex;flex-direction:column}
  .sheet.on{transform:translateY(0)}
  .sheet .sh-hd{padding:13px 16px 8px;font-size:13px;color:var(--sub);display:flex;align-items:center}
  .sheet .sh-hd .sh-act{margin-left:auto;color:var(--accent);background:none;border:none;font-size:13.5px}
  .sheet .sh-list{overflow-y:auto;padding:0 8px 6px}
  .sheet .ag{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;
    border-radius:10px;padding:11px 10px;color:var(--txt);font-size:15px}
  .sheet .ag:active{background:var(--panel2)}
  .sheet .ag.on{background:var(--panel2)}
  .sheet .ag .ag-name{flex-shrink:0;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sheet .ag.on .ag-name{color:var(--accent)}
  .sheet .ag .ag-sub{color:var(--sub);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .sheet .ag .ag-check{margin-left:auto;color:var(--accent);font-size:14px;flex-shrink:0}
  .sheet .ag .ag-del{background:none;border:none;color:var(--sub);font-size:13px;padding:4px 6px;flex-shrink:0}
  .sheet .ag .ag-del:active{color:var(--bad)}
  /* 登录视图 */
  .login{position:fixed;inset:0;z-index:20;background:var(--bg);display:grid;place-items:center;padding:24px}
  .login .lg-box{width:min(340px,88vw)}
  .login .lg-logo{font-size:30px;text-align:center;margin-bottom:4px}
  .login .lg-title{text-align:center;font-size:17px;font-weight:600;margin-bottom:18px}
  .login label{display:block;font-size:12.5px;color:var(--sub);margin:10px 0 5px}
  .login input{width:100%;padding:10px 11px;border-radius:10px;border:1px solid var(--line);
    background:var(--panel2);color:var(--txt);font-size:15px}
  .login input:focus{outline:none;border-color:var(--accent)}
  .login .lg-btn{width:100%;margin-top:16px;padding:11px 0;border:none;border-radius:10px;
    background:var(--accent);color:#fff;font-size:15px}
  .login .lg-btn:disabled{opacity:.5}
  .login .lg-err{color:var(--bad);font-size:13px;margin-top:10px;text-align:center;min-height:18px}
  .login .lg-note{font-size:12px;color:var(--sub);text-align:center;margin-top:14px;line-height:1.7}
  /* Agent 卡片与新建表单 */
  .agcard{display:flex;align-items:center;gap:10px}
  .agcard .agc-main{flex:1;min-width:0}
  .agcard .agc-name{font-size:15px;font-weight:600}
  .agcard .agc-sub{font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .agcard .agc-cur{font-size:11px;color:var(--accent);flex-shrink:0}
  .form{margin-top:10px;border-top:1px dashed var(--line);padding-top:10px}
  .form label{display:block;font-size:12px;color:var(--sub);margin:8px 0 4px}
  .form input,.form textarea{width:100%;padding:9px 10px;border-radius:9px;border:1px solid var(--line);
    background:var(--panel2);color:var(--txt);font-size:14px;font-family:inherit}
  .form textarea{resize:none;height:64px}
  .form .frow{display:flex;gap:8px;margin-top:10px}
  .form .frow button{flex:1;padding:9px 0;border-radius:9px;border:1px solid var(--line);
    background:var(--panel2);color:var(--txt);font-size:14px}
  .form .frow button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .form .frow button:disabled{opacity:.5}
  .toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(8px);background:#333742;
    color:var(--txt);font-size:13px;padding:8px 16px;border-radius:20px;z-index:10;opacity:0;
    transition:opacity .2s,transform .2s;pointer-events:none;max-width:80vw}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  .jump{position:fixed;right:14px;bottom:88px;width:38px;height:38px;border-radius:50%;background:var(--panel2);
    border:1px solid var(--line);color:var(--txt);font-size:16px;z-index:5;display:none;box-shadow:0 2px 8px rgba(0,0,0,.35)}
  /* 登录视图下隐藏应用骨架 */
  body.authed .appui{display:block}
  body:not(.authed) .appui{display:none}
</style>
</head>
<body>
<div class="appui">
<div class="err" id="err">连接桌面端失败，正在重试…</div>
<header id="hdr">
  <div class="hd-main">
    <b id="agentName">AgentHub</b>
    <span class="hd-sub" id="agentSub"></span>
    <span class="chev" id="agentChev" style="display:none">▼</span>
  </div>
  <span id="conn" class="dot" title="连接状态"></span>
</header>
<nav>
  <button data-tab="chat" class="on">会话<span class="nbadge" id="nbadge">1</span></button>
  <button data-tab="tasks">任务</button>
  <button data-tab="agents">Agent</button>
  <button data-tab="usage">用量</button>
  <button data-tab="settings">设置</button>
</nav>
<main id="main"></main>
<button class="jump" id="jump" data-act="jump">↓</button>
<div class="mask" id="mask" data-act="sheet-close"></div>
<div class="sheet" id="sheet">
  <div class="sh-hd" id="sheetTitle">切换 Agent</div>
  <div class="sh-list" id="sheetList"></div>
</div>
<div class="send" id="sendbar">
  <textarea id="input" rows="1" placeholder="发消息…"></textarea>
  <button id="sendbtn">发送</button>
</div>
</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  'use strict'
  var T = new URLSearchParams(location.search).get('t') || localStorage.getItem('ahub_t') || ''
  if (T) localStorage.setItem('ahub_t', T)
  var A = localStorage.getItem('ahub_a') || ''   // 账号会话 token（登录换发，7 天有效）
  var state = null, curAgent = localStorage.getItem('ahub_agent') || null, tab = 'chat', timer = null
  var curSession = null          // 手机端选中的会话（null=跟随桌面端活跃会话）
  var authed = false             // 已通过任一凭据（配对或账号）
  var loginNote = ''
  var optimistic = []           // 乐观消息：{id,text,failed,ts}
  var lastChatSig = ''          // 会话区脏检查签名
  var lastTaskSig = ''          // 任务区脏检查签名
  var lastTabHtml = { agents: '', usage: '', settings: '' }  // 静态标签脏检查
  var expFb = null              // 展开返工输入框的 runId
  var stopArm = null            // 停止两段确认的 runId
  var stopArmTimer = null
  var unread = 0
  var sending = false
  var agFormOpen = false        // Agent 新建表单展开
  var taskFormOpen = false      // 任务发起表单展开
  var $ = function(id){ return document.getElementById(id) }
  var main = $('main')

  function qs(){
    var p = 't=' + encodeURIComponent(T) + '&a=' + encodeURIComponent(A)
    return p
  }
  function api(path, opts){
    opts = opts || {}
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + qs()
    return fetch(url, opts).then(function(r){
      if (r.status === 401) { enterLogin('登录已过期或配对无效，请重新登录'); throw new Error('401') }
      return r.json()
    })
  }
  function anonApi(path, opts){ return fetch(path, opts).then(function(r){ return r.json() }) }

  function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
  function fmtTs(ts){ if(!ts) return ''; var d = new Date(ts), now = new Date()
    var hm = ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)
    if (d.toDateString() === now.toDateString()) return hm
    return (d.getMonth()+1)+'-'+d.getDate()+' '+hm }
  function fmtRel(ts){ if(!ts) return ''; var d = Date.now()-ts
    if (d < 60e3) return '刚刚'
    if (d < 3600e3) return Math.floor(d/60e3)+' 分钟前'
    if (d < 86400e3) return Math.floor(d/3600e3)+' 小时前'
    var t = new Date(ts); return (t.getMonth()+1)+'-'+t.getDate() }
  function fmtTokens(n){ if(!n) return '0'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n) }

  function setConn(ok){ $('conn').className = 'dot' + (ok ? '' : ' off'); $('err').style.display = ok ? 'none' : 'block' }

  var toastTimer = null
  function toast(msg){
    var el = $('toast'); el.textContent = msg; el.classList.add('on')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function(){ el.classList.remove('on') }, 1800)
  }

  // ---- 登录视图 ----
  function enterLogin(note){
    if (authed && note === '登录已过期或配对无效，请重新登录') authed = false
    loginNote = note || ''
    document.body.classList.remove('authed')
    renderLogin()
  }
  function renderLogin(){
    var old = document.querySelector('.login')
    if (old) old.remove()
    var el = document.createElement('div')
    el.className = 'login'
    el.innerHTML = '<div class="lg-box">' +
      '<div class="lg-logo">🤖</div><div class="lg-title">登录 AgentHub</div>' +
      '<label>用户名</label><input id="lg-u" autocapitalize="off" autocorrect="off">' +
      '<label>密码</label><input id="lg-p" type="password">' +
      '<button class="lg-btn" id="lg-go">登 录</button>' +
      '<div class="lg-err" id="lg-err">' + esc(loginNote) + '</div>' +
      '<div class="lg-note">也可以回桌面端「手机查看」扫码配对（机主免登录）</div></div>'
    document.body.appendChild(el)
    var go = function(){
      var u = document.getElementById('lg-u').value || ''
      var p = document.getElementById('lg-p').value || ''
      if (!u || !p) return
      var btn = document.getElementById('lg-go')
      btn.disabled = true; btn.textContent = '登录中…'
      anonApi('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
        .then(function(r){
          if (r.ok && r.token) {
            A = r.token; localStorage.setItem('ahub_a', A)
            authed = true
            el.remove()
            document.body.classList.add('authed')
            toast('欢迎，' + (r.name || u))
            lastChatSig = ''; lastTaskSig = ''
            refresh()
          } else {
            document.getElementById('lg-err').textContent = r.message || '登录失败'
            btn.disabled = false; btn.textContent = '登 录'
          }
        })
        .catch(function(){
          document.getElementById('lg-err').textContent = '网络不可达'
          btn.disabled = false; btn.textContent = '登 录'
        })
    }
    document.getElementById('lg-go').addEventListener('click', go)
    var kp = function(e){ if (e.key === 'Enter') go() }
    document.getElementById('lg-u').addEventListener('keydown', kp)
    document.getElementById('lg-p').addEventListener('keydown', kp)
  }

  // http 明文环境没有 navigator.clipboard：退回 execCommand（iOS/Android 都认）
  function copyText(text){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ toast('已复制') }, function(){ fallbackCopy(text) })
      return
    }
    fallbackCopy(text)
  }
  function fallbackCopy(text){
    var ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select()
    var ok = false
    try { ok = document.execCommand('copy') } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta)
    toast(ok ? '已复制' : '复制失败，请长按选择复制')
  }

  function nearBottom(){ return window.innerHeight + window.pageYOffset >= document.body.scrollHeight - 90 }
  function scrollBottom(smooth){
    try { window.scrollTo({ top: document.body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }) }
    catch (e) { window.scrollTo(0, document.body.scrollHeight) }
  }
  window.addEventListener('scroll', function(){
    if (tab === 'chat') $('jump').style.display = nearBottom() ? 'none' : 'block'
  }, { passive: true })

  // ---- 会话标签 ----
  function chatSig(){
    var s = state && state.session
    if (!s || s.agentId !== curAgent) return 'empty:' + curAgent
    var sig = 'sid:' + s.sessionId + '|' + s.messages.map(function(m){
      return m.id + ':' + (m.text || '').length + ':' + (m.reasoning || '').length + ':' + (m.streaming ? 1 : 0) + (m.error ? 'e' : '')
    }).join(',')
    if (optimistic.length) sig += '|' + optimistic.map(function(o){ return o.id + o.text.length + (o.failed ? 'f' : '') }).join(',')
    return sig
  }

  function renderChat(force){
    var agents = (state && state.agents) || []
    if (!agents.length) {
      main.innerHTML = '<div class="hint">还没有 Agent。<br><span class="sub">去「Agent」标签页创建一个。</span></div>'
      $('sendbar').style.display = 'none'
      lastChatSig = chatSig()
      return
    }
    if (!curAgent || !agents.some(function(a){ return a.id === curAgent })) curAgent = state.activeAgentId || agents[0].id
    var cur = agents.find(function(a){ return a.id === curAgent })
    $('agentName').textContent = cur ? cur.name : 'AgentHub'
    $('agentSub').textContent = cur && cur.model ? cur.model : ''
    $('agentChev').style.display = agents.length > 1 ? '' : 'none'

    var s = state.session
    var sessList = (state && state.sessionList) || []
    var sessTitle = s && s.agentId === curAgent ? s.title : '选择会话'
    var msgs = (s && s.agentId === curAgent && s.messages) ? s.messages : []
    // 乐观条目：桌面端已落库（出现同文本 user 消息）即静默并入
    optimistic = optimistic.filter(function(o){ return o.failed || !msgs.some(function(m){ return m.role === 'user' && m.text === o.text }) })

    var sig = chatSig()
    $('sendbar').style.display = 'flex'
    if (!force && sig === lastChatSig) return
    var wasNear = nearBottom()
    lastChatSig = sig

    var html = ''
    html += '<div class="sbar" data-act="sess-sheet"><span>💬</span><span class="sb-title">' + esc(sessTitle) +
      (sessList.length ? '（' + sessList.length + '）' : '') + '</span><span>▾</span></div>'
    if (!msgs.length && !optimistic.length) html += '<div class="hint">还没有消息。<br><span class="sub">在下面输入框说点什么。</span></div>'
    msgs.forEach(function(m){
      var isUser = m.role === 'user'
      var think = (!isUser && m.reasoning)
        ? '<details class="think"><summary>💭 思考过程' + (m.reasoningTruncated ? '（已截断）' : '') + '</summary><div class="tk-body">' + esc(m.reasoning) + '</div></details>'
        : ''
      var bubble = '<div class="bubble" data-act="copy">' + esc(m.text) + (m.streaming && !isUser ? '<span class="caret"><i></i><i></i><i></i></span>' : '') + '</div>'
      var tools = (!isUser && m.toolNames && m.toolNames.length)
        ? '<div class="tools">' + m.toolNames.map(function(n){ return '<span>' + esc(n) + '</span>' }).join('') + '</div>' : ''
      var meta = ''
      if (!isUser) {
        var parts = []
        if (m.streaming) parts.push('正在回复…')
        if (m.handoffFrom) parts.push('来自 ' + esc(m.handoffFrom))
        if (m.model) parts.push(esc(m.model))
        if (m.cost != null) parts.push('¥' + m.cost)
        parts.push(fmtTs(m.ts))
        meta = '<div class="meta">' + parts.join(' · ') + '</div>'
      }
      html += '<div class="msg ' + esc(m.role) + (m.error ? ' err-msg' : '') + '">' + think + bubble + tools + meta + '</div>'
    })
    optimistic.forEach(function(o){
      html += '<div class="msg user' + (o.failed ? ' failed' : ' pending') + '"><div class="bubble" data-act="' + (o.failed ? 'resend' : 'copy') + '">' + esc(o.text) + '</div>' +
        (o.failed ? '<div class="meta" style="color:var(--bad)">发送失败 · 点气泡重发</div>' : '') + '</div>'
    })
    main.innerHTML = html
    if (wasNear) scrollBottom(false)
  }

  function markOptFailed(text, why){
    for (var i = optimistic.length - 1; i >= 0; i--) {
      if (optimistic[i].text === text && !optimistic[i].failed) { optimistic[i].failed = true; break }
    }
    sending = false
    var btn = $('sendbtn'); btn.classList.remove('busy'); btn.textContent = '发送'
    if (tab === 'chat') renderChat(true)
    toast(why || '发送失败')
  }

  function sendMsg(){
    var input = $('input'), text = (input.value || '').trim()
    if (!text || sending) return
    sending = true
    var btn = $('sendbtn'); btn.classList.add('busy'); btn.textContent = '···'
    input.value = ''; input.style.height = ''
    optimistic.push({ id: 'o' + Date.now(), text: text, failed: false })
    if (tab === 'chat') { renderChat(true); scrollBottom(true) }
    api('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: curAgent, text: text }) })
      .then(function(r){
        if (!r.ok) markOptFailed(text, r.message || '发送失败')
        else { sending = false; btn.classList.remove('busy'); btn.textContent = '发送'; refresh() }
      })
      .catch(function(){ markOptFailed(text, '发送失败：桌面端不可达') })
  }

  // ---- 会话管理 ----
  function sessionOp(op, sessionId, title){
    return api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: op, agentId: curAgent, sessionId: sessionId, title: title }) })
      .then(function(r){
        if (!r.ok) { toast(r.message || '操作失败'); return false }
        curSession = null
        lastChatSig = ''
        refresh()
        return true
      })
      .catch(function(){ toast('操作失败：桌面端不可达'); return false })
  }
  function openSessionSheet(){
    var list = (state && state.sessionList) || []
    var s = state && state.session
    var curId = s && s.agentId === curAgent ? s.sessionId : null
    var html = list.map(function(x){
      return '<button class="ag' + (x.id === curId ? ' on' : '') + '" data-act="sess-pick" data-id="' + esc(x.id) + '">' +
        '<span class="ag-name">' + esc(x.title) + '</span>' +
        '<span class="ag-sub">' + x.count + ' 条 · ' + fmtRel(x.updatedAt) + '</span>' +
        '<span class="ag-del" data-act="sess-del" data-id="' + esc(x.id) + '">删除</span>' +
        (x.id === curId ? '<span class="ag-check">✓</span>' : '') + '</button>'
    }).join('')
    if (!list.length) html = '<div class="hint" style="padding:16px">这个 Agent 还没有会话</div>'
    $('sheetTitle').innerHTML = '会话列表 <button class="sh-act" data-act="sess-new">＋ 新建对话</button>'
    $('sheetList').innerHTML = html
    $('mask').classList.add('on')
    $('sheet').classList.add('on')
  }

  // ---- 任务标签 ----
  function busyRun(runs){
    for (var i = 0; i < runs.length; i++) {
      var s = runs[i].status
      if (s === 'running' || s === 'preparing' || s === 'waiting_review' || s === 'waiting_user' || s === 'stopping') return runs[i]
    }
    return null
  }
  function renderTasks(force){
    $('sendbar').style.display = 'none'
    $('jump').style.display = 'none'
    var runs = (state && state.runs) || []
    var sig = taskFormOpen + '|' + runs.map(function(r){
      return [r.id, r.status, r.gate ? r.gate.kind + r.gate.round : '-', r.stage || '', r.round || ''].join(':')
    }).join(',')
    if (!force && sig === lastTaskSig) return
    lastTaskSig = sig
    var cur = busyRun(runs)
    var html = ''
    html += '<div class="card"><h3>发起任务</h3>'
    if (taskFormOpen) {
      html += '<div class="form" style="border-top:none;padding-top:0">' +
        '<textarea id="run-goal" placeholder="要做什么？写清楚目标，桌面端的三角色工作流会开工（当前角色绑定生效）…"></textarea>' +
        '<div class="frow"><button class="primary" data-act="run-start">发起</button><button data-act="task-form-close">取消</button></div></div>'
    } else {
      html += '<div class="form" style="border-top:none;padding-top:0"><div class="frow">' +
        '<button class="primary" data-act="task-form-open">＋ 新任务</button>' +
        (cur ? '<button class="stop" data-act="run-stop" data-id="' + esc(cur.id) + '" style="color:var(--bad)">停止当前任务</button>' : '') +
        '</div></div>'
    }
    html += '</div>'
    if (!runs.length) {
      html += '<div class="hint">还没有工作流任务。<br><span class="sub">在上面发起一个，这里实时显示进度与审批门。</span></div>'
      main.innerHTML = html
      return
    }
    html += runs.map(function(r){
      var gateHtml = ''
      if (r.gate) {
        var okLabel = r.gate.kind === 'plan' ? '批准计划' : '通过'
        var stopLabel = stopArm === r.id ? '确认停止？' : '停止'
        var fbHtml = expFb === r.id
          ? '<div class="gfb"><textarea id="fb-' + esc(r.id) + '" placeholder="告诉桌面端要改什么（可空）…"></textarea>' +
            '<div class="fbrow"><button data-act="gate-rework-confirm" data-id="' + esc(r.id) + '">确认返工</button></div></div>'
          : ''
        gateHtml = '<div class="gate"><div class="glabel">' + (r.gate.kind === 'plan' ? '计划批准门' : '审核确认门') + ' · 第 ' + esc(r.gate.round) + ' 轮</div>' +
          '<div class="gbtns">' +
          '<button class="ok" data-act="gate-ok" data-id="' + esc(r.id) + '">' + okLabel + '</button>' +
          '<button data-act="gate-rework" data-id="' + esc(r.id) + '">返工</button>' +
          '<button class="stop' + (stopArm === r.id ? ' armed' : '') + '" data-act="gate-stop" data-id="' + esc(r.id) + '">' + stopLabel + '</button>' +
          '</div>' + fbHtml + '</div>'
      }
      var meta = []
      if (r.stage) meta.push(esc(r.stage))
      if (r.maxRounds) meta.push('第 ' + esc(r.round) + '/' + esc(r.maxRounds) + ' 轮')
      if (r.tokens) meta.push(fmtTokens(r.tokens) + ' tok')
      if (r.startedAt) meta.push(fmtRel(r.startedAt))
      if (r.demo) meta.push('演示')
      return '<div class="card' + (r.gate ? ' gate-card' : '') + '"><h3>' + esc(r.goal) + '</h3>' +
        '<span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span>' +
        '<span class="cmeta">' + meta.join(' · ') + '</span>' + gateHtml + '</div>'
    }).join('')
    main.innerHTML = html
  }

  function gateAction(runId, action, feedback){
    api('/api/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: runId, action: action, feedback: feedback }) })
      .then(function(r){ if (!r.ok) toast(r.message || '操作失败'); else { toast(action === 'stop' ? '已停止' : '已提交'); expFb = null; refresh() } })
      .catch(function(){ toast('操作失败：桌面端不可达') })
  }

  // ---- Agent 标签 ----
  function renderAgents(force){
    $('sendbar').style.display = 'none'
    $('jump').style.display = 'none'
    var agents = (state && state.agents) || []
    var sig = agFormOpen + '|' + agents.map(function(a){ return a.id + a.name + (a.model || '') }).join(',')
    if (!force && sig === lastTabHtml.agents) return
    lastTabHtml.agents = sig
    var html = agents.map(function(a){
      var isCur = a.id === curAgent
      return '<div class="card agcard" data-act="ag-pick" data-id="' + esc(a.id) + '">' +
        '<div class="agc-main"><div class="agc-name">' + esc(a.name) + '</div>' +
        '<div class="agc-sub">' + esc([a.kind === 'demo' ? '演示' : a.kind === 'cli' ? 'CLI' : '自定义模型', a.model].filter(Boolean).join(' · ')) + '</div></div>' +
        (isCur ? '<span class="agc-cur">当前对话 ✓</span>' : '') + '</div>'
    }).join('')
    if (!agents.length) html = '<div class="hint">还没有 Agent</div>'
    html += '<div class="card"><h3>新建 Agent（自定义模型）</h3>'
    if (agFormOpen) {
      html += '<div class="form" style="border-top:none;padding-top:0">' +
        '<label>名称（可空，缺省用模型名）</label><input id="ag-name" placeholder="例如：我的 GLM">' +
        '<label>服务商</label><input id="ag-provider" placeholder="例如：zhipu / openai 兼容">' +
        '<label>Base URL</label><input id="ag-url" placeholder="https://open.bigmodel.cn/api/paas/v4" autocapitalize="off">' +
        '<label>模型 ID</label><input id="ag-model" placeholder="例如：glm-4.7" autocapitalize="off">' +
        '<label>API Key</label><input id="ag-key" type="password" placeholder="sk-…（加密存储，不上传）" autocapitalize="off">' +
        '<div class="frow"><button class="primary" data-act="ag-create">创建（先测连接）</button><button data-act="ag-form-close">取消</button></div>' +
        '<div class="hint" class="sub" style="padding:8px 0 0;text-align:left">创建走桌面端同一条链：先真实测连接，通过后 Key 加密存储（绝不入配置文件）。</div></div>'
    } else {
      html += '<div class="form" style="border-top:none;padding-top:0"><div class="frow"><button data-act="ag-form-open">＋ 新建</button></div></div>'
    }
    html += '</div>'
    main.innerHTML = html
  }

  function createAgent(){
    var g = function(id){ var el = document.getElementById(id); return el ? (el.value || '').trim() : '' }
    var payload = { provider: g('ag-provider'), baseUrl: g('ag-url'), modelId: g('ag-model'), apiKey: g('ag-key'), name: g('ag-name') }
    if (!payload.provider || !payload.baseUrl || !payload.modelId || !payload.apiKey) { toast('四项都要填'); return }
    api('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function(r){
        if (!r.ok) { toast(r.message || '创建失败'); return }
        toast('创建请求已提交，桌面端正在测连接…')
        agFormOpen = false
        renderAgents(true)
      })
      .catch(function(){ toast('操作失败：桌面端不可达') })
  }

  // ---- 用量标签 ----
  function renderUsage(force){
    $('sendbar').style.display = 'none'
    $('jump').style.display = 'none'
    var u = (state && state.usage) || { today: {}, total: {} }
    var sig = JSON.stringify(u)
    if (!force && sig === lastTabHtml.usage) return
    lastTabHtml.usage = sig
    var row = function(name, v){ return '<div class="kv"><span>' + name + '</span><b>' + v + '</b></div>' }
    main.innerHTML = '<div class="card"><h3>今日</h3>' +
      row('调用次数', (u.today.calls || 0)) + row('Token', fmtTokens(u.today.tokens)) + row('折算费用', '¥' + (u.today.cost || 0)) + '</div>' +
      '<div class="card"><h3>累计</h3>' +
      row('调用次数', (u.total.calls || 0)) + row('Token', fmtTokens(u.total.tokens)) + row('折算费用', '¥' + (u.total.cost || 0)) + '</div>' +
      '<div class="hint" style="padding-top:12px">口径与桌面端设置页一致：只统计有真实上报的调用。</div>'
  }

  // ---- 设置标签 ----
  function renderSettings(force){
    $('sendbar').style.display = 'none'
    $('jump').style.display = 'none'
    var user = (state && state.user) || '机主'
    var agents = (state && state.agents) || []
    var sessCount = (state && state.sessionList) ? state.sessionList.length : 0
    var sig = user + '|' + agents.length + '|' + sessCount
    if (!force && sig === lastTabHtml.settings) return
    lastTabHtml.settings = sig
    var row = function(name, v){ return '<div class="kv"><span>' + name + '</span><b>' + v + '</b></div>' }
    main.innerHTML = '<div class="card"><h3>账号</h3>' +
      row('当前用户', esc(user)) +
      '<div class="frow" style="margin-top:10px"><button data-act="logout" style="color:var(--bad)">退出登录</button></div></div>' +
      '<div class="card"><h3>工作区概况</h3>' +
      row('Agent 数', agents.length) + row('当前 Agent 会话数', sessCount) +
      row('通道', '局域网 / 公网（中继）') + '</div>' +
      '<div class="hint" style="padding-top:6px;line-height:1.9">扫码配对（机主）与账号登录并存；<br>退出登录后可用账号密码重新登录，或重新扫码。</div>'
  }

  function render(force){
    if (tab === 'chat') renderChat(force)
    else if (tab === 'tasks') renderTasks(force)
    else if (tab === 'agents') renderAgents(force)
    else if (tab === 'usage') renderUsage(force)
    else renderSettings(force)
  }

  function refresh(){
    return api('/api/state?agent=' + encodeURIComponent(curAgent || '') + (curSession ? '&session=' + encodeURIComponent(curSession) : ''))
      .then(function(s){
        var prevSig = lastChatSig
        state = s; setConn(true)
        if (!authed) { authed = true; document.body.classList.add('authed') }
        render(false)
        // 不在会话页时会话内容变了 → 红点 + 标题提醒（回到会话页即清）
        if (tab !== 'chat' && prevSig && chatSig() !== prevSig) {
          unread++
          $('nbadge').style.display = 'block'
          $('nbadge').textContent = unread > 9 ? '9+' : String(unread)
          document.title = '(' + unread + ') 新消息 · AgentHub'
        }
      })
      .catch(function(e){ if (String(e.message) !== '401') setConn(false) })
  }

  // ---- 抽屉（Agent / 会话共用） ----
  function openAgentSheet(){
    var agents = (state && state.agents) || []
    $('sheetTitle').textContent = '切换 Agent'
    $('sheetList').innerHTML = agents.map(function(a){
      return '<button class="ag' + (a.id === curAgent ? ' on' : '') + '" data-act="pick" data-id="' + esc(a.id) + '">' +
        '<span class="ag-name">' + esc(a.name) + '</span>' +
        '<span class="ag-sub">' + esc([a.kind, a.model].filter(Boolean).join(' · ')) + '</span>' +
        (a.id === curAgent ? '<span class="ag-check">✓</span>' : '') + '</button>'
    }).join('')
    $('mask').classList.add('on')
    $('sheet').classList.add('on')
  }
  function closeSheet(){
    $('mask').classList.remove('on')
    $('sheet').classList.remove('on')
  }

  // ---- 事件（全委托：重绘不丢绑定） ----
  document.addEventListener('click', function(e){
    var el = e.target
    while (el && el !== document && !(el.getAttribute && el.getAttribute('data-act'))) el = el.parentNode
    if (!el || !el.getAttribute) return
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id')
    if (act === 'copy') copyText(el.textContent || '')
    else if (act === 'resend') {
      var text = el.textContent || ''
      optimistic = optimistic.filter(function(o){ return !(o.failed && o.text === text) })
      var input = $('input'); input.value = text
      renderChat(true); input.focus()
    }
    else if (act === 'jump') { scrollBottom(true); $('jump').style.display = 'none' }
    else if (act === 'sheet') openAgentSheet()
    else if (act === 'sheet-close') closeSheet()
    else if (act === 'pick') {
      curAgent = id; curSession = null; localStorage.setItem('ahub_agent', curAgent)
      optimistic = []; unread = 0
      $('nbadge').style.display = 'none'; document.title = 'AgentHub'
      closeSheet(); lastChatSig = ''; renderChat(true); refresh()
    }
    else if (act === 'sess-sheet') openSessionSheet()
    else if (act === 'sess-pick') {
      curSession = id
      closeSheet(); lastChatSig = ''
      // 切换走桌面端同一条链（activeOf 持久化），随后轮询自然带回该会话
      api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'switch', agentId: curAgent, sessionId: id }) })
        .then(function(){ refresh() })
        .catch(function(){ toast('切换失败'); refresh() })
    }
    else if (act === 'sess-new') { closeSheet(); sessionOp('new') }
    else if (act === 'sess-del') {
      if (window.confirm('删除这个会话？消息不可恢复')) sessionOp('delete', id)
    }
    else if (act === 'gate-ok') gateAction(id, 'deliver', '')
    else if (act === 'gate-rework') { expFb = (expFb === id ? null : id); renderTasks(true) }
    else if (act === 'gate-rework-confirm') {
      var fb = document.getElementById('fb-' + id)
      gateAction(id, 'rework', fb ? (fb.value || '') : '')
    }
    else if (act === 'gate-stop') {
      if (stopArm !== id) {
        stopArm = id; renderTasks(true)
        if (stopArmTimer) clearTimeout(stopArmTimer)
        stopArmTimer = setTimeout(function(){ stopArm = null; if (tab === 'tasks') renderTasks(true) }, 3000)
      } else {
        stopArm = null
        if (stopArmTimer) clearTimeout(stopArmTimer)
        gateAction(id, 'stop', '')
      }
    }
    else if (act === 'task-form-open') { taskFormOpen = true; renderTasks(true) }
    else if (act === 'task-form-close') { taskFormOpen = false; renderTasks(true) }
    else if (act === 'run-start') {
      var g = document.getElementById('run-goal')
      var goal = g ? (g.value || '').trim() : ''
      if (!goal) { toast('先写目标'); return }
      api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'start', goal: goal }) })
        .then(function(r){ if (!r.ok) toast(r.message || '发起失败'); else { toast('已发起，桌面端开始开工'); taskFormOpen = false; renderTasks(true); refresh() } })
        .catch(function(){ toast('发起失败：桌面端不可达') })
    }
    else if (act === 'run-stop') {
      api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'stop' }) })
        .then(function(r){ if (!r.ok) toast(r.message || '停止失败'); else { toast('已请求停止'); refresh() } })
        .catch(function(){ toast('停止失败：桌面端不可达') })
    }
    else if (act === 'ag-form-open') { agFormOpen = true; renderAgents(true) }
    else if (act === 'ag-form-close') { agFormOpen = false; renderAgents(true) }
    else if (act === 'ag-create') createAgent()
    else if (act === 'ag-pick') {
      // Agent 卡片点按 = 切到该 Agent 并跳回会话页
      curAgent = id; curSession = null; localStorage.setItem('ahub_agent', curAgent)
      optimistic = []; lastChatSig = ''
      toast('已切换到 ' + (state && state.agents.find(function(a){ return a.id === id }) || {}).name)
      switchTab('chat')
      refresh()
    }
    else if (act === 'logout') {
      anonApi('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
        .catch(function(){ /* 忽略 */ })
      localStorage.removeItem('ahub_a')
      A = ''
      enterLogin('已退出登录')
    }
  })

  function switchTab(t){
    document.querySelectorAll('nav button').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-tab') === t) })
    tab = t
    if (t === 'chat') {
      unread = 0; $('nbadge').style.display = 'none'; document.title = 'AgentHub'
      renderChat(true); scrollBottom(false)
    } else render(true)
  }
  document.querySelectorAll('nav button').forEach(function(b){
    b.addEventListener('click', function(){ switchTab(b.getAttribute('data-tab')) })
  })
  $('hdr').addEventListener('click', function(){
    if (state && state.agents && state.agents.length > 1) openAgentSheet()
  })
  $('sendbtn').addEventListener('click', sendMsg)
  var input = $('input')
  input.addEventListener('keydown', function(e){
    // 中文输入法组词期间（isComposing/keyCode 229）按 Enter 是"选字"，绝不能当发送
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg() }
  })
  input.addEventListener('input', function(){
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  })
  // 键盘弹起（visualViewport 变化）时贴底的用户跟随到底
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function(){
      if (tab === 'chat' && nearBottom()) scrollBottom(false)
    })
  }
  document.addEventListener('visibilitychange', function(){ if (!document.hidden && authed) refresh() })

  function loop(){ if (!document.hidden && authed) refresh() }
  refresh(); timer = setInterval(loop, 3000)
})()
</script>
</body>
</html>`
