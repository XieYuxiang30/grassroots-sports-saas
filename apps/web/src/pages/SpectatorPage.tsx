import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PlayerLeaderboardEntry } from '@openhoopscore/contracts';
import { ScoreboardView, statusLabel } from '@/components/Scoreboard';
import { useLiveMatch } from '@/hooks/useLiveMatch';
import { api } from '@/services/api';

/**
 * ============================================================================
 * 观众端（手机 H5，扫码进来的落地页）
 * ============================================================================
 * 观众的使用场景决定了设计：
 *   - 站在场边、单手拿手机、屏幕可能反光 → 比分必须首屏最大、最高对比度；
 *   - 网络很差 → 断线时不能白屏，要显示「连接中」并保留最后一次比分；
 *   - 中途进场（第二节才扫码）→ 图文直播要一次性给足上下文，而不是只有新事件。
 */
export default function SpectatorPage() {
  const { matchId = '' } = useParams();
  const { state, scoreboard, feed, connection, lastEventAt, error } = useLiveMatch(matchId);
  const [tab, setTab] = useState<'feed' | 'players'>('feed');
  const [leaderboard, setLeaderboard] = useState<PlayerLeaderboardEntry[] | null>(null);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ competition: string; title: string; venue: string | null; shareCode: string } | null>(
    null,
  );

  useEffect(() => {
    if (!matchId) return;
    let cancelled = false;
    void api
      .getMatch(matchId)
      .then((response) => {
        if (cancelled) return;
        setDetail({
          competition: response.match.competition,
          title: response.match.title,
          venue: response.match.venue,
          shareCode: response.match.shareCode,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  // 切到球员榜时按需拉取；比分变化后也刷新一次（榜单跟着比分走）
  const lastSeq = state?.lastSeq ?? 0;
  useEffect(() => {
    if (tab !== 'players' || !matchId) return;
    let cancelled = false;
    void api
      .leaderboard(matchId, 'points')
      .then((response) => {
        if (!cancelled) {
          setLeaderboard(response.entries);
          setLeaderboardError(null);
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // 接口挂了也要能看：退化为用本地 state 推导的球员数据
        setLeaderboardError(`球员榜接口不可用（${err.message}），以下为本地推导结果`);
        setLeaderboard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, matchId, lastSeq]);

  const localLeaderboard = useMemo<PlayerLeaderboardEntry[]>(() => {
    if (!state) return [];
    const rows: PlayerLeaderboardEntry[] = [];
    for (const [team, side] of [
      [state.home, 'home'],
      [state.away, 'away'],
    ] as const) {
      for (const player of team.players) {
        rows.push({
          playerId: player.playerId,
          teamId: player.teamId,
          teamSide: side,
          teamName: team.name,
          name: player.name,
          jerseyNumber: player.jerseyNumber,
          points: player.points,
          fouls: player.fouls,
          threePointersMade: player.threePointersMade,
          rank: 0,
        });
      }
    }
    return rows.sort((a, b) => b.points - a.points);
  }, [state]);

  if (!state || !scoreboard) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div>{error ?? '正在连接比赛…'}</div>
        <Link className="btn btn-ghost" to="/">
          返回首页
        </Link>
      </div>
    );
  }

  const entries = leaderboard ?? localLeaderboard;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{detail ? `${detail.competition} · ${detail.title}` : '实时比分'}</h1>
        <span className={`badge ${connection === 'online' ? 'badge-online' : 'badge-offline'}`}>
          {connection === 'online' ? '● 实时' : connection === 'connecting' ? '连接中…' : '已断开·重连中'}
        </span>
      </div>

      <div className="page-body">
        {error ? <div className="error-box">{error}</div> : null}

        <ScoreboardView
          scoreboard={scoreboard}
          extra={
            <span className="faint">
              {lastEventAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(lastEventAt)) / 1000))} 秒前更新` : statusLabel(state.status)}
            </span>
          }
        />

        {detail?.venue ? <div className="faint center">{detail.venue}</div> : null}

        <div className="row">
          <button
            type="button"
            className={`btn${tab === 'feed' ? ' btn-primary' : ''}`}
            onClick={() => setTab('feed')}
          >
            图文直播
          </button>
          <button
            type="button"
            className={`btn${tab === 'players' ? ' btn-primary' : ''}`}
            onClick={() => setTab('players')}
          >
            球员数据
          </button>
        </div>

        {tab === 'feed' ? (
          <div className="card">
            <p className="card-title">比赛实况</p>
            {feed.length === 0 ? (
              <div className="empty faint">比赛还没开始，稍等片刻…</div>
            ) : (
              <div className="feed-list">
                {feed.map((item) => (
                  <div className="feed-item" key={item.id}>
                    <span className="feed-time">{item.clock ?? `第${item.period}节`}</span>
                    <span className={`feed-text tone-${item.tone}`}>{item.text}</span>
                    <span className="feed-score">
                      {item.homeScore}:{item.awayScore}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <p className="card-title">球员数据</p>
            {leaderboardError ? <div className="warn-box" style={{ marginBottom: 10 }}>{leaderboardError}</div> : null}
            {entries.length === 0 ? (
              <div className="empty faint">本场没有录入球员名单</div>
            ) : (
              <>
                <div className="leaderboard-row faint">
                  <span>#</span>
                  <span>球员</span>
                  <span>得分</span>
                  <span>犯规</span>
                </div>
                {entries.map((entry, index) => (
                  <div className="leaderboard-row" key={entry.playerId}>
                    <span className="rank">{leaderboard ? entry.rank : index + 1}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.jerseyNumber} 号 {entry.name}
                      <span className="faint"> · {entry.teamName}</span>
                    </span>
                    <span className="tabular" style={{ fontWeight: 700 }}>
                      {entry.points}
                    </span>
                    <span className="tabular muted">{entry.fouls}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        <div className="row">
          <Link className="btn" to={`/display/${matchId}`} style={{ textAlign: 'center' }}>
            大屏比分牌
          </Link>
          <Link className="btn" to="/" style={{ textAlign: 'center' }}>
            首页
          </Link>
        </div>

        <p className="faint center">分享码 {detail?.shareCode} · 把本页链接发给朋友即可一起看</p>
      </div>
    </div>
  );
}
