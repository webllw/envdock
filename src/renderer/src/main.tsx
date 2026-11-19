import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useAppStore } from './store/useAppStore'
import './styles/global.css'

// 首帧前应用主题，避免深浅切换时先闪一帧默认色
document.documentElement.dataset.theme = useAppStore.getState().theme

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
