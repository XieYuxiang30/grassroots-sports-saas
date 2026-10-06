import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

/**
 * 前端入口。
 *
 * 注册 Service Worker（vite-plugin-pwa 生成）：
 * 计分端要在平板上当 App 用，**外壳必须能离线打开** —— 现场经常是「先断网再开页面」。
 * 注意：接口与 Socket.IO 永远走网络（见 vite.config.ts 的 navigateFallbackDenylist），
 * 比分绝不能命中缓存。
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW 注册失败不影响使用：只是失去了离线打开外壳的能力
    });
  });
}
