import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ScoreboardView } from '@/components/Scoreboard';
import { useLiveMatch } from '@/hooks/useLiveMatch';
import { api } from '@/services/api';

/**
 * 大屏比分牌（场馆投影 / 电视）。
 *
 * 与观众端的区别：没有交互、不要滚动，字号跟随视口缩放（clamp + vw），
 * 目标是「站在场边 5 米外也能看清比分」。底部滚动显示最近几条图文直播。
 */
export default function DisplayPage() {
  const { matchId = '' } = useParams();
  const { scoreboard, feed, connection, state } = useLiveMatch(matchId);
  const [shareCode, setShareCode] = useState<string>('');

  useEffect(() => {
    if (!matchId) return;
    void api
      .getMatch(matchId)
      .then((response) => setShareCode(response.match.shareCode))
      .catch(() => undefined);
  }, [matchId]);

  if (!scoreboard) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div>正在连接比赛…</div>
        <Link className="btn btn-ghost" to="/">
          返回首页
        </Link>
      </div>
    );
  }

  return (
    <div className="display-page">
      <ScoreboardView scoreboard={scoreboard} variant="display" />
      <div className="display-footer">
        <span className={`badge ${connection === 'online' ? 'badge-online' : 'badge-offline'}`}>
          {connection === 'online' ? '● 实时' : '连接中…'}
        </span>
        <div className="display-feed">
          {feed.slice(0, 3).map((item) => (
            <span className={`display-feed-item tone-${item.tone}`} key={item.id}>
              {item.clock ?? `第${item.period}节`} {item.text}
            </span>
          ))}
        </div>
        <span>
          {shareCode ? (
            <>
              扫码看比分：<strong style={{ letterSpacing: '0.2em' }}>{shareCode}</strong>
            </>
          ) : null}
        </span>
      </div>
      {/* 大屏不可交互，但保留一个退出入口（主办方按 Esc 或点这里回首页） */}
      {state?.status === 'finished' ? (
        <div
          style={{
            position: 'fixed',
            top: 'calc(8px + var(--safe-top))',
            right: 12,
            display: 'flex',
            gap: 8,
          }}
        >
          <Link className="btn btn-ghost" to="/">
            返回首页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
