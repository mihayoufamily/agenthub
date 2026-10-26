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
  const [qrMode, setQrMode] = useState<'lan' | 'public'>('lan')
  const [lanIdx, setLanIdx] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    bridge.mobile.status().then(setSt).catch(() => setSt(null))
    bridge.mobile.tunnelStatus().then(setTun).catch(() => setTun(null))
    const off = bridge.mobile.onTunnelStatus(setTun)
    return off
  }, [open])

  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      const r = await bridge.mobile.setEnabled(on)
      setSt({ enabled: on, running: r.running, port: r.port, hasToken: !!r.token, token: r.token, urls: r.urls })
      // 服务关了公网入口跟着失效；开回来隧道按记忆的意图重连（推送会更新 tun）
      if (!on) setQrMode('lan')
      bridge.mobile.tunnelStatus().then(setTun).catch(() => {})
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

  const on = st?.enabled === true
  const running = st?.running === true
  // 多网卡（有线+Wi-Fi 同路由器）时某个 IP 可能被路由器跨域隔离：列出全部地址供切换
  const lanUrls = st?.urls ?? []
  const lanUrl = lanUrls[Math.min(lanIdx, lanUrls.length - 1)] ?? ''
  const token = st?.token ?? ''
  const publicUrl = tun?.url ? `${tun.url}/?t=${token}` : ''
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

        {/* 公网接入：服务本体开着才显示；二进制未捆绑时如实说明 */}
        {on && running && tun && (
          <div className="mob-tunnel">
            <div className="mob-row">
              <div>
                <div className="mob-title">
                  公网接入 <Badge tone="warn">试运行</Badge>
                </div>
                <div className="mob-sub">不在同一 Wi-Fi 也能用：经 Cloudflare 临时隧道转发，地址每次开启都会变化</div>
              </div>
              <Switch
                on={tun.enabled}
                onChange={(v) => void toggleTunnel(v)}
                disabled={!tun.binaryFound && !tun.enabled}
                label="公网接入"
              />
            </div>
            {!tun.binaryFound && (
              <div className="mob-sub">未找到 cloudflared 组件（resources/bin/cloudflared.exe），此安装包未捆绑公网接入，局域网功能不受影响</div>
            )}
            {tun.binaryFound && tun.enabled && tun.connecting && <div className="mob-sub">正在连接 Cloudflare 边缘…（最长约 15 秒）</div>}
            {tun.binaryFound && tun.enabled && tun.running && publicUrl && (
              <div className="mob-status">
                <Badge tone="ok">公网已就绪</Badge>
              </div>
            )}
            {tun.binaryFound && tun.enabled && !tun.connecting && !tun.running && tun.error && (
              <div className="mob-sub" style={{ color: 'var(--danger, #e5484d)' }}>{tun.error}</div>
            )}
          </div>
        )}

        {on && running && url && (
          <>
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
            {tun?.running && publicUrl && (
              <div className="mob-qr-switch">
                <button type="button" className={!showPublic ? 'active' : ''} onClick={() => setQrMode('lan')}>局域网</button>
                <button type="button" className={showPublic ? 'active' : ''} onClick={() => setQrMode('public')}>公网</button>
              </div>
            )}
            <ul className="mob-notes">
              {showPublic ? (
                <>
                  <li>公网模式：手机用<b>任意网络</b>（蜂窝/别的 Wi-Fi）扫码即可</li>
                  <li>流量经 <b>Cloudflare 加密隧道</b>；国内直连 Cloudflare 偶尔不稳，打不开可切回局域网模式</li>
                  <li>地址每次开启都变，重开公网接入后需重新扫码</li>
                </>
              ) : (
                <>
                  <li>手机与电脑连<b>同一个 Wi-Fi</b>；扫码或输入地址即可打开</li>
                  <li>首次启用 Windows 防火墙可能弹窗，请<b>允许（专用网络）</b>，否则手机连不上</li>
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
