// 手机查看弹窗（2026-10-26 批次）：侧栏底栏「手机查看」的入口面板。
// 开关状态在主进程（prefs.mobileService），这里只经 bridge.mobile 读写事实——
// 二维码内容是带 token 的完整 URL（token 明文只在主进程与这个 URL 里，弹窗不单独展示 token）。
// 公网接入（同日追加）：经捆绑的 cloudflared quick tunnel 转发，地址每次开启都变；
// 二维码在「局域网 / 公网」间切换，公网地址可用前按钮置灰。
import React, { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Modal } from '../components/Modal'
import { Switch, Badge, CopyButton } from '../components/primitives'
import { bridge } from '../lib/ipc'

type Status = { enabled: boolean; running: boolean; port: number; hasToken: boolean; token?: string; urls: string[] }
type TunnelStatus = { enabled: boolean; running: boolean; connecting: boolean; url?: string; error?: string; binaryFound: boolean }
type RelayStatus = { enabled: boolean; connected: boolean; publicUrl?: string; relayUrl: string; error?: string }

/** 二维码：qrcode-generator（零依赖、自带类型），scalable SVG 由手机相机/微信扫码识别 */
function qrSvg(url: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
}

export function MobileAccessModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [st, setSt] = useState<Status | null>(null)
  const [tun, setTun] = useState<TunnelStatus | null>(null)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [qrMode, setQrMode] = useState<'lan' | 'public'>('lan')
  const [lanIdx, setLanIdx] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    bridge.mobile.status().then(setSt).catch(() => setSt(null))
    bridge.mobile.tunnelStatus().then(setTun).catch(() => setTun(null))
    bridge.mobile.relayStatus().then(setRelay).catch(() => setRelay(null))
    const offT = bridge.mobile.onTunnelStatus(setTun)
    const offR = bridge.mobile.onRelayStatus(setRelay)
    return () => { offT(); offR() }
  }, [open])

  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      const r = await bridge.mobile.setEnabled(on)
      setSt({ enabled: on, running: r.running, port: r.port, hasToken: !!r.token, token: r.token, urls: r.urls })
      // 服务关了公网入口跟着失效；开回来隧道/中继按记忆的意图重连（推送会更新状态）
      if (!on) setQrMode('lan')
      bridge.mobile.tunnelStatus().then(setTun).catch(() => {})
      bridge.mobile.relayStatus().then(setRelay).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const toggleTunnel = async (on: boolean) => {
    setTun((t) => (t ? { ...t, connecting: on, error: undefined } : t))
    try {
      const r = await bridge.mobile.setTunnelEnabled(on)
      setTun({ enabled: r.enabled, running: r.running, connecting: r.connecting, url: r.url, error: r.error, binaryFound: r.binaryFound })
      if (on && r.url) setQrMode('public')
    } catch {
      bridge.mobile.tunnelStatus().then(setTun).catch(() => {})
    }
  }

  const toggleRelay = async (on: boolean) => {
    try {
      const r = await bridge.mobile.setRelayEnabled(on)
      setRelay({ enabled: r.enabled, connected: r.connected, publicUrl: r.publicUrl, relayUrl: r.relayUrl, error: r.error })
      if (on && r.publicUrl) setQrMode('public')
    } catch {
      bridge.mobile.relayStatus().then(setRelay).catch(() => {})
    }
  }

  const on = st?.enabled === true
  const running = st?.running === true
  // 多网卡（有线+Wi-Fi 同路由器）时某个 IP 可能被路由器跨域隔离：列出全部地址供切换
  const lanUrls = st?.urls ?? []
  const lanUrl = lanUrls[Math.min(lanIdx, lanUrls.length - 1)] ?? ''
  const token = st?.token ?? ''
  // 公网地址：中继（固定，推荐）优先，quick tunnel（临时）备选
  const publicUrl = relay?.connected && relay.publicUrl ? relay.publicUrl : tun?.url ? `${tun.url}/?t=${token}` : ''
  const publicSource: 'relay' | 'tunnel' | null = relay?.connected && relay.publicUrl ? 'relay' : (tun?.url ? 'tunnel' : null)
  const showPublic = qrMode === 'public' && !!publicUrl
  const url = showPublic ? publicUrl : lanUrl

  return (
    <Modal open={open} onClose={onClose} title="手机查看" width={420}>
      <div className="mob-wrap">
        <div className="mob-row">
          <div>
            <div className="mob-title">启用手机端访问</div>
            <div className="mob-sub">手机浏览器打开地址，查看会话 / 任务进度 / 用量，并可远程发消息、审批确认门</div>
          </div>
          <Switch on={on} onChange={(v) => void toggle(v)} label="启用手机端访问" />
        </div>

        {on && (
          <div className="mob-status">
            {running ? <Badge tone="ok">服务运行中 · 端口 {st?.port}</Badge> : <Badge tone="danger">服务未运行（端口可能被占用，重启应用再试）</Badge>}
          </div>
        )}

        {/* 公网接入：两条路——中继（固定地址，推荐）与 quick tunnel（临时，备选） */}
        {on && running && (
          <div className="mob-tunnel">
            <div className="mob-row">
              <div>
                <div className="mob-title">
                  公网（固定入口） <Badge tone="ok">推荐</Badge>
                </div>
                <div className="mob-sub">经官方中继网关转发，地址固定不变，手机任意网络可用；电脑重启后不用重新扫码</div>
              </div>
              <Switch on={relay?.enabled === true} onChange={(v) => void toggleRelay(v)} label="公网中继" />
            </div>
            {relay?.enabled === true && relay.connected && relay.publicUrl && (
              <div className="mob-status"><Badge tone="ok">已连接中继</Badge></div>
            )}
            {relay?.enabled === true && !relay.connected && (
              <div className="mob-sub">正在连接中继网关…（断线会自动重连）{relay.error ? ` · ${relay.error}` : ''}</div>
            )}

            <div className="mob-row" style={{ marginTop: 10 }}>
              <div>
                <div className="mob-title">
                  公网（临时隧道） <Badge tone="warn">备选</Badge>
                </div>
                <div className="mob-sub">P2P 临时地址，每次开启都变化；国内网络常被 DNS 污染，打不开就用上面的固定入口</div>
              </div>
              <Switch
                on={tun?.enabled === true}
                onChange={(v) => void toggleTunnel(v)}
                disabled={tun ? !tun.binaryFound && !tun.enabled : false}
                label="临时隧道"
              />
            </div>
            {tun?.enabled === true && !tun.binaryFound && (
              <div className="mob-sub">未找到 cloudflared 组件（resources/bin/cloudflared.exe），此安装包未捆绑，固定入口不受影响</div>
            )}
            {tun?.binaryFound && tun.enabled && tun.connecting && <div className="mob-sub">正在连接 Cloudflare 边缘…（最长约 15 秒）</div>}
            {tun?.binaryFound && tun.enabled && tun.running && (
              <div className="mob-status"><Badge tone="ok">临时隧道已就绪</Badge></div>
            )}
            {tun?.binaryFound && tun.enabled && !tun.connecting && !tun.running && tun.error && (
              <div className="mob-sub" style={{ color: 'var(--danger, #e5484d)' }}>{tun.error}</div>
            )}
          </div>
        )}

        {on && running && url && (
          <>
            {/* 模式切换置顶：先选通道，再看对应的码 */}
            <div className="mob-qr-tabs">
              <button type="button" className={!showPublic ? 'active' : ''} onClick={() => setQrMode('lan')}>
                📶 局域网
              </button>
              {publicSource && (
                <button type="button" className={showPublic ? 'active' : ''} onClick={() => setQrMode('public')}>
                  🌐 公网{publicSource === 'relay' ? ' · 固定' : ' · 临时'}
                </button>
              )}
            </div>
            {/* 二维码卡片：边框颜色区分通道，顶部标签条写明适用场景 */}
            <div className={'mob-qr-card ' + (showPublic ? 'pub' : 'lan')}>
              <div className="mob-qr-tag">
                {showPublic
                  ? publicSource === 'relay'
                    ? '🌐 公网 · 手机用任意网络（蜂窝也行）· 地址固定'
                    : '🌐 公网临时隧道 · 地址每次开启都变'
                  : '📶 局域网 · 手机连同一个 Wi-Fi'}
              </div>
              <div className="mob-qr" dangerouslySetInnerHTML={{ __html: qrSvg(url) }} />
              <div className="mob-url">
                <code>{url}</code>
                <CopyButton getText={() => url} label="复制" />
              </div>
              {/* 局域网多地址切换：哪个 IP 手机打得开就用哪个（有线/无线跨域隔离时只有个别通） */}
              {!showPublic && lanUrls.length > 1 && (
                <div className="mob-qr-switch">
                  {lanUrls.map((u, i) => (
                    <button
                      key={u}
                      type="button"
                      className={i === Math.min(lanIdx, lanUrls.length - 1) ? 'active' : ''}
                      onClick={() => setLanIdx(i)}
                    >
                      {u.match(/\/\/([^:]+):/)?.[1] ?? `地址 ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ul className="mob-notes">
              {showPublic ? (
                publicSource === 'relay' ? (
                  <>
                    <li>公网固定入口：手机用<b>任意网络</b>（蜂窝/别的 Wi-Fi）扫码即可</li>
                    <li>地址<b>固定不变</b>，电脑重启后无需重新扫码；流量经中继网关转发</li>
                    <li>token 即完整访问权（看会话/发消息/审批），不要发给不信任的人</li>
                  </>
                ) : (
                  <>
                    <li>公网临时隧道：地址<b>每次开启都变</b>，重开后需重新扫码</li>
                    <li>国内网络对临时隧道域名常有干扰，打不开请改用「公网（固定入口）」</li>
                  </>
                )
              ) : (
                <>
                  <li>手机与电脑连<b>同一个 Wi-Fi</b>；扫码或输入地址即可打开</li>
                  <li>首次启用 Windows 防火墙可能弹窗，请<b>允许（专用网络）</b>，否则手机连不上</li>
                  <li>多网卡电脑有多个地址：某个扫码打不开就切下面的 IP 再扫</li>
                </>
              )}
              <li>手机浏览器里点「添加到主屏幕」可当 App 用</li>
              <li>手机端已配对：换 token = 关闭再开启上方的开关（关闭不重置，仅重置可联系开发）</li>
              <li>电脑端关闭应用或此开关后，手机页面立即失效</li>
            </ul>
          </>
        )}

        {!on && (
          <div className="mob-sub" style={{ marginTop: 10 }}>
            默认关闭。开启后主进程会监听局域网端口（{st?.port ?? 8748}），凭二维码里的配对 token 访问——
            没有扫码的人打不开任何页面。
          </div>
        )}

        {busy && <div className="mob-sub" style={{ marginTop: 8 }}>正在切换…</div>}
      </div>
    </Modal>
  )
}
