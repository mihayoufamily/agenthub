import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// 样式经 index.html <link> 引入（见 src/renderer/styles/），无需打包处理

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root 挂载点')
createRoot(el).render(<App />)
