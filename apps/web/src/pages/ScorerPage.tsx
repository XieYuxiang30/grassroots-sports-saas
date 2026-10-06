import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { ShareCard } from '@/components/ShareCard';
import { ScoreboardView, statusLabel } from '@/components/Scoreboard';
import { getScorerEngine, type ScorerSnapshot } from '@/offline/engine';
import { api, ApiError } from '@/services/api';

/**
 * ============================================================================
 * 计分端（PWA）
 * ============================================================================
 * 这是整个产品的核心界面，所有设计都围绕「计分员在现场能不能一次点对」：
 *
 *  1. **大按钮、单手可达**：+1/+2/+3 占满下方，犯规/暂停/失误等放在旁边；
 *  2. **点完立刻看到比分变化**：事件先落 IndexedDB，再异步同步，
 *     所以断网时画面照样更新（顶部会明确显示「离线记录中 · N 条待同步」）；
 *  3. **撤销永远在视野里**：计分员点错是高频事件，撤销按钮固定在顶部工具条；
 *  4. **键盘快捷键**：平板接蓝牙键盘或用笔记本计分时，1/2/3 直接记分、Ctrl+Z 撤销；
 *  5. **防误触**：切换节次、结束比赛这类不可逆操作都要二次确认。
 */

const PASSCODE_KEY = 'hoop:scorer:passcode';

export default function ScorerPage() {
  const { matchId = '' } = useParams();
  const navigate = useNavigate();
  const [passcode, setPasscode] = useLocalStorage(PASSCODE_KEY, '');
  const [passcodeInput, setPasscodeInput] = useState('');
  const engine = useMemo(() => getScorerEngine(), []);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 已保存口令则直接连；否则先要口令
  useEffect(() => {
    if (!matchId || !passcode) return;
    let cancelled = false;
    setConnecting(true);
    engine
      .connect(matchId, passcode)
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiError = err instanceof ApiError ? err : null;
        if (apiError?.statusCode === 403) {
          // 口令过期或错误：清掉，重新要求输入
          setPasscode('');
          setError('计分口令不正确，请重新输入');
        } else if (apiError?.statusCode === 404) {
          setError('比赛不存在，请回到后台确认');
        } else {
          setError(`连接失败：${(err as Error).message}`);
        }
      })
      .finally(() => {
        if (!cancelled) setConnecting(false);
      });

    return () => {
      cancelled = true;
      engine.dispose();
    };
  }, [matchId, passcode, engine, setPasscode]);

  // 顶部提示自动消失
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const state = snapshot.state;
  const detail = snapshot.detail;

  /** 队伍切换 + 记分。玩家必须先选中，避免「记了分但不知道是谁」。 */
  const record = async (
    side: 'home' | 'away',
    action: {
      type: import('@openhoopscore/contracts').GameEventType;
      points?: 1 | 2 | 3;
      shotType?: import('@openhoopscore/contracts').ShotType;
      payload?: Record<string, unknown>;
    },
  ) => {
    if (!state) return;
    const teamId = side === 'home' ? detail?.teams.home.id : detail?.teams.away.id;
    if (!teamId) return;

    // 只有「球员相关」的事件才要求先选人；暂停、全队犯规不需要
    const needsPlayer = ['score', 'foul', 'turnover', 'steal', 'block', 'rebound'].includes(action.type);
    if (needsPlayer && !selectedPlayerId) {
      showToast('请先点选一名球员，再点动作按钮');
      return;
    }
    const playerBelongsToSide =
      !selectedPlayerId ||
      (side === 'home' ? detail?.teams.home.players : detail?.teams.away.players)?.some(
        (player) => player.id === selectedPlayerId,
      );
    if (needsPlayer && !playerBelongsToSide) {
      showToast('选中的球员不属于这支球队');
      return;
    }

    await engine.record({
      type: action.type,
      teamId,
      playerId: needsPlayer ? selectedPlayerId : null,
      period: state.period,
      gameClockSeconds: state.gameClockSeconds,
      payload:
        action.type === 'score'
          ? { points: action.points ?? 2, shotType: action.shotType ?? shotTypeOf(action.points ?? 2) }
          : (action.payload ?? {}),
    });

    if (action.type === 'score') showToast(`已记录 ${action.points ?? 2} 分`);
  };

  const handleUndo = async () => {
    setBusy(true);
    try {
      const descriptions = await engine.undo(undefined, 1);
      showToast(descriptions[0] ? `已撤销：${descriptions[0]}` : '已撤销上一步');
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleEndPeriod = async () => {
    if (!state) return;
    if (!window.confirm(`确认结束第 ${state.period} 节？节次会推进到第 ${state.period + 1} 节。`)) return;
    setBusy(true);
    try {
      await engine.endPeriod();
      showToast('已进入下一节');
    } catch (err) {
      showToast(`操作失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    if (!window.confirm('确认结束整场比赛？结束后仍可查看全部事件与图文直播。')) return;
    setBusy(true);
    try {
      await engine.finish('normal');
      showToast('比赛已结束');
    } catch (err) {
      showToast(`操作失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 键盘快捷键：接蓝牙键盘或笔记本计分时非常顺手
  useEffect(() => {
    if (!state || snapshot.pendingCount < 0) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void handleUndo();
        return;
      }
      if (event.key === '1' || event.key === '2' || event.key === '3') {
        const points = Number(event.key) as 1 | 2 | 3;
        const side = event.shiftKey ? 'away' : 'home';
        event.preventDefault();
        void record(side, { type: 'score', points, shotType: shotTypeOf(points) });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  /* ------------------------------ 口令门禁 ------------------------------ */

  if (!passcode) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>计分端登录</h1>
          <Link className="btn btn-ghost" to="/">
            返回
          </Link>
        </div>
        <div className="page-body" style={{ maxWidth: 420 }}>
          <div className="card stack">
            <div className="field">
              <label htmlFor="passcode">计分口令</label>
              <input
                id="passcode"
                className="input"
                type="password"
                inputMode="text"
                autoComplete="current-password"
                placeholder="向赛事管理员索取"
                value={passcodeInput}
                onChange={(event) => setPasscodeInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && passcodeInput.trim()) setPasscode(passcodeInput.trim());
                }}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={!passcodeInput.trim()}
              onClick={() => setPasscode(passcodeInput.trim())}
            >
              进入计分台
            </button>
            {error ? <div className="error-box">{error}</div> : null}
            <p className="faint">
              对口令说明：观众端只读不需要口令；只有计分与撤销需要。默认口令见后端 .env 的 SCORER_PASSCODE。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (connecting || !snapshot.ready || !state || !detail) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div>{error ?? '正在载入比赛…'}</div>
        {error ? (
          <div className="row" style={{ maxWidth: 320 }}>
            <button type="button" className="btn" onClick={() => navigate('/admin')}>
              去后台
            </button>
            <button type="button" className="btn" onClick={() => setPasscode('')}>
              重新输入口令
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const statusClass =
    snapshot.connection === 'online' && snapshot.pendingCount === 0
      ? 'online'
      : snapshot.pendingCount > 0
        ? 'pending'
        : 'offline';

  const statusText =
    snapshot.connection === 'online' && snapshot.pendingCount === 0
      ? '已连接 · 实时同步中'
      : snapshot.pendingCount > 0
        ? `离线记录中 · ${snapshot.pendingCount} 条待同步${snapshot.connection === 'online' ? '（正在补传）' : ''}`
        : '未连接服务器 · 记录会先存在本机，恢复后自动补传';

  const renderTeam = (side: 'home' | 'away') => {
    const team = side === 'home' ? detail.teams.home : detail.teams.away;
    const teamState = side === 'home' ? state.home : state.away;
    return (
      <div className={`team-panel ${side}`} key={side}>
        <div className="team-panel-head">
          <span>{team.name}</span>
          <span className="tabular" style={{ fontSize: 20, color: team.color }}>
            {teamState.score}
          </span>
        </div>
        <div className="player-list">
          {team.players.length === 0 ? (
            <div className="empty faint">尚未录入球员，可先只记团队得分</div>
          ) : (
            team.players.map((player) => {
              const line = teamState.players.find((item) => item.playerId === player.id);
              return (
                <div
                  key={player.id}
                  className={`player-row${selectedPlayerId === player.id ? ' selected' : ''}`}
                  onClick={() => setSelectedPlayerId(player.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') setSelectedPlayerId(player.id);
                  }}
                >
                  <span className="jersey">{player.jerseyNumber}</span>
                  <span className="player-name">{player.name}</span>
                  <span className="player-stat">
                    {line?.points ?? 0} 分 · {line?.fouls ?? 0} 犯
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="action-grid">
            {([1, 2, 3] as const).map((points) => (
              <button
                key={points}
                type="button"
                className={`action-btn${points === 3 ? ' scored' : ''}`}
                onClick={() => void record(side, { type: 'score', points, shotType: shotTypeOf(points) })}
                disabled={busy}
              >
                +{points}
                <small>{points === 1 ? '罚球' : points === 2 ? '两分' : '三分'}</small>
              </button>
            ))}
          </div>
          <div className="action-grid">
            <button
              type="button"
              className="action-btn danger"
              style={{ fontSize: 14, padding: '12px 6px' }}
              onClick={() => void record(side, { type: 'foul' })}
              disabled={busy}
            >
              犯规
              <small>{teamState.teamFoulsByPeriod[state.period] ?? 0} 次团队</small>
            </button>
            <button
              type="button"
              className="action-btn"
              style={{ fontSize: 14, padding: '12px 6px' }}
              onClick={() => void record(side, { type: 'timeout' })}
              disabled={busy}
            >
              暂停
              <small>已用 {teamState.timeoutsUsed}</small>
            </button>
            <button
              type="button"
              className="action-btn"
              style={{ fontSize: 14, padding: '12px 6px' }}
              onClick={() => void record(side, { type: 'turnover' })}
              disabled={busy}
            >
              失误
              <small>球权转换</small>
            </button>
          </div>
          <div className="action-grid">
            <button
              type="button"
              className="action-btn"
              style={{ fontSize: 13, padding: '10px 6px' }}
              onClick={() => void record(side, { type: 'rebound', payload: { kind: 'offensive' } })}
              disabled={busy}
            >
              前场板
            </button>
            <button
              type="button"
              className="action-btn"
              style={{ fontSize: 13, padding: '10px 6px' }}
              onClick={() => void record(side, { type: 'rebound', payload: { kind: 'defensive' } })}
              disabled={busy}
            >
              后场板
            </button>
            <button
              type="button"
              className="action-btn"
              style={{ fontSize: 13, padding: '10px 6px' }}
              onClick={() => void record(side, { type: 'team_foul', payload: { count: 1 } })}
              disabled={busy}
            >
              团队犯规
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <div className={`offline-bar ${statusClass}`}>
        <span>{statusText}</span>
        <span style={{ flex: 1 }} />
        {snapshot.storageKind !== 'indexeddb' ? (
          <span title="当前浏览器未启用 IndexedDB，离线队列退化为 localStorage/内存，容量有限">
            存储：{snapshot.storageKind === 'localstorage' ? 'localStorage' : '内存'}
          </span>
        ) : null}
        {snapshot.pendingCount > 0 ? (
          <button type="button" className="btn btn-ghost" style={{ padding: '4px 10px' }} onClick={() => void engine.flush()}>
            立即同步
          </button>
        ) : null}
      </div>

      <div className="page-header">
        <h1>
          {detail.match.competition} · {detail.match.title}
        </h1>
        <span className="faint">分享码 {detail.match.shareCode}</span>
        <Link className="btn btn-ghost" to="/">
          退出
        </Link>
      </div>

      <div className="page-body">
        {error ? <div className="error-box">{error}</div> : null}
        {snapshot.lastError ? <div className="warn-box">{snapshot.lastError}</div> : null}
        {snapshot.resyncing ? <div className="warn-box">正在重新对齐时间线（检测到离线补传）…</div> : null}

        <ScoreboardView
          scoreboard={state.scoreboard}
          title={statusLabel(state.status)}
          extra={
            snapshot.onlineScorers.length > 1 ? (
              <span className="badge badge-offline" title="多台设备同时计分时需要人工核对">
                {snapshot.onlineScorers.length} 台设备在计分
              </span>
            ) : null
          }
        />

        <div className="undo-bar">
          <button type="button" className="btn btn-danger" onClick={() => void handleUndo()} disabled={busy}>
            ↩ 撤销上一步
          </button>
          <span className="muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {snapshot.undoable[0]?.description ?? '暂无可撤销操作'}
          </span>
          <button type="button" className="btn" onClick={() => void handleEndPeriod()} disabled={busy}>
            结束本节
          </button>
          <button type="button" className="btn" onClick={() => void handleFinish()} disabled={busy}>
            结束比赛
          </button>
        </div>

        <div className="scorer-layout">
          {renderTeam('home')}
          {renderTeam('away')}
        </div>

        <div className="card">
          <p className="card-title">本场图文直播（观众端同步可见）</p>
          <div className="feed-list">
            {snapshot.feed.length === 0 ? (
              <div className="empty faint">还没有事件</div>
            ) : (
              snapshot.feed.slice(0, 12).map((item) => (
                <div className="feed-item" key={item.id}>
                  <span className="feed-time">{item.clock ?? `第${item.period}节`}</span>
                  <span className={`feed-text tone-${item.tone}`}>{item.text}</span>
                  <span className="feed-score">
                    {item.homeScore}:{item.awayScore}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {detail.teams.home.players.length > 0 ? (
          <ShareCard
            shareCode={detail.match.shareCode}
            shareUrl={`${window.location.origin}/m/${detail.match.shareCode}`}
            matchTitle={detail.match.title}
          />
        ) : null}

        <p className="faint">
          快捷键：1 / 2 / 3 记主队得分，Shift+1/2/3 记客队，Ctrl+Z 撤销。所有事件先写入本机
          IndexedDB，断网也不会丢；恢复网络后自动幂等补传。
        </p>
      </div>

      {toast ? (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: `calc(24px + var(--safe-bottom))`,
            transform: 'translateX(-50%)',
            background: '#1f2b45',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '10px 16px',
            boxShadow: 'var(--shadow)',
            zIndex: 50,
            maxWidth: '90vw',
            textAlign: 'center',
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function shotTypeOf(points: 1 | 2 | 3): import('@openhoopscore/contracts').ShotType {
  return points === 3 ? 'three' : points === 1 ? 'free_throw' : 'mid';
}

export type { ScorerSnapshot };

/** 供后台页复用：检查后端是否可达。 */
export async function probeBackend(): Promise<string> {
  const health = await api.health();
  return `${health.storageDriver} / 投影 ${health.projectionVersion}`;
}
