// 内联 SVG 图标集（无外部字体/图标依赖，规避许可证问题）
import React from 'react'

const PATHS: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M4 12l16-7-5 7 5 7-16-7z" fill="currentColor" stroke="none" />,
  attach: <path d="M15.5 8.5l-7.4 7.4a2.6 2.6 0 003.7 3.7l7.4-7.4a4.8 4.8 0 10-6.8-6.8l-7.4 7.4a7 7 0 009.9 9.9l5.6-5.6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3m0 12v3M4.2 7.5l2.6 1.5m10.4 6l2.6 1.5M4.2 16.5l2.6-1.5m10.4-6l2.6-1.5" />
    </>
  ),
  swap: <path d="M7 8h10l-3-3m3 3l-3 3M17 16H7l3-3m-3 3l3 3" />,
  reorder: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  warn: (
    <>
      <path d="M12 4L2.5 20h19L12 4z" />
      <path d="M12 10v4m0 3v.01" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  up: <path d="M6 14l6-6 6 6" />,
  down: <path d="M6 10l6 6 6-6" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1.2" fill="currentColor" />
      <circle cx="15" cy="6" r="1.2" fill="currentColor" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" />
      <circle cx="9" cy="18" r="1.2" fill="currentColor" />
      <circle cx="15" cy="18" r="1.2" fill="currentColor" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h8" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </>
  ),
  handoff: <path d="M8 7h8l-3-3m3 3l-3 3M16 17H8l3 3m-3-3l3-3" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8v.01" />
    </>
  ),
  folder: <path d="M4 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />,
  terminal: <path d="M5 7l4 4-4 4M11 17h8" />,
  shield: <path d="M12 4l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V7l7-3z" />,
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 00-3-3L5 17v3z" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />,
  scan: (
    <>
      <path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2m0 8v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2" />
      <path d="M4 12h16" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10m0 0l-4-4m4 4l4-4" />
      <path d="M5 19h14" />
    </>
  ),
  /* 用量统计：三根柱子的柱状图 */
  chart: (
    <>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V6M17 20v-9" />
    </>
  ),
  /* token 占比：带缺口的环（对话栏底部那个迷你图用 DonutRings 真画，这里只是兜底图标） */
  pie: (
    <>
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M12 3v9h9" />
    </>
  )
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name] ?? null}
    </svg>
  )
}
