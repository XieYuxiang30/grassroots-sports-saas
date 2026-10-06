import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import HomePage from '@/pages/HomePage';
import ScorerPage from '@/pages/ScorerPage';
import AdminPage from '@/pages/AdminPage';
import SpectatorPage from '@/pages/SpectatorPage';
import DisplayPage from '@/pages/DisplayPage';
import JoinPage from '@/pages/JoinPage';
import NotFoundPage from '@/pages/NotFoundPage';

/**
 * 路由表。
 *
 * 路径设计围绕现场实际用法：
 *   /                首页：输入分享码进房 / 快速入口
 *   /m/:code         扫码落地页：自动解析分享码后跳到观众端（二维码里就是这个地址）
 *   /live/:matchId   观众端 H5（手机竖屏，比分 + 图文直播 + 球员榜）
 *   /display/:matchId 大屏端（场馆投影/电视，纯比分牌，超大字号）
 *   /score/:matchId  计分端 PWA（平板横屏，大按钮 + 离线记录）
 *   /admin           赛事管理后台（建比赛、录名单、拿二维码）
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/m/:code" element={<JoinPage />} />
        <Route path="/live/:matchId" element={<SpectatorPage />} />
        <Route path="/display/:matchId" element={<DisplayPage />} />
        <Route path="/score/:matchId" element={<ScorerPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/matches/:matchId" element={<AdminPage />} />
        <Route path="/index.html" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
