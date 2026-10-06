import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Taro, { useDidHide, useUnload, useRouter } from '@tarojs/taro';
import { Button, ScrollView, Text, View } from '@tarojs/components';
import type { PlayerStatLine, TeamState } from '../../contracts';
import {
  ApiError,
  getMatch,
  getMatchLive,
  resolveShareCode,
} from '../../services/api';
import { subscribeMatch, type RealtimeSubscription } from '../../services/realtime';
import { connectionLabel, useMatchStore } from '../../store/match-store';
import { LAST_SHARE_CODE_STORAGE_KEY } from '../../constants';
import { formatClock, formatPeriod, formatRelativeTime, formatTimeOfDaySeconds } from '../../utils/time';
import './index.css';

/** 比分牌展示模型：优先用后端权威 TeamState，其次用 Scoreboard。 */
interface TeamDisplay {
  name: string;
  shortName: string;
  color: string;
  score: number;
  teamFouls: number;
  periodFouls: number;
}

const TONE_CLASS: Record<string, string> = {
  home: 'feed__item--home',
  away: 'feed__item--away',
  neutral: 'feed__item--neutral',
};

function displayFromTeamState(team: TeamState, period: number): TeamDisplay {
  return {
    name: team.name,
    shortName: team.shortName || team.name,
    color: team.color || '#64748b',
    score: team.score,
    teamFouls: team.teamFouls,
    periodFouls: team.teamFoulsByPeriod?.[period] ?? 0,
  };
}

export default function LivePage() {
  const router = useRouter();
  const paramMatchId = router.params.matchId ?? '';
  const paramCode = router.params.code ?? '';

  /** 页面级状态（不放进全局 store 的临时 UI 状态）。 */
  const [matchId, setMatchId] = useState(paramMatchId);
  const [resolving, setResolving] = useState(!paramMatchId && !!paramCode);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [localClock, setLocalClock] = useState<number | null>(null);

  const store = useMatchStore();
  const {
    detail,
    state,
    feed,
    connection,
    connectionDetail,
    highlights,
    error: storeError,
    beginLoad,
    setDetail,
    setError,
    applyLive,
    applyState,
    applyScoreboard,
    mergeCommitted,
    mergeFeed,
    pushHighlight,
    markFinished,
    setConnection,
    reset,
  } = store;

  const subscriptionRef = useRef<RealtimeSubscription | null>(null);
  const lastClockTickRef = useRef<number>(Date.now());

  /* ------------------------------ 1. 解析 matchId ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    if (paramMatchId) {
      setMatchId(paramMatchId);
      setResolving(false);
      return () => {
        cancelled = true;
      };
    }
    const code =
      paramCode ||
      (() => {
        try {
          return (Taro.getStorageSync(LAST_SHARE_CODE_STORAGE_KEY) as string) || '';
        } catch {
          return '';
        }
      })();
    if (!code) {
      setFatalError('缺少 matchId 或分享码，请回到首页重新进入');
      setResolving(false);
      return () => {
        cancelled = true;
      };
    }
    resolveShareCode(code)
      .then((resolved) => {
        if (cancelled) return;
        setMatchId(resolved.matchId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFatalError(err instanceof ApiError ? err.message : `分享码 ${code} 无效`);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paramMatchId, paramCode]);

  /* ------------------------------ 2. 首屏加载 ------------------------------ */

  const loadAll = useCallback(async () => {
    if (!matchId) return;
    beginLoad(matchId);
    setFatalError(null);
    try {
      const [live, matchDetail] = await Promise.all([
        getMatchLive(matchId),
        getMatch(matchId).catch(() => null),
      ]);
      applyLive(live);
      setDetail(matchDetail);
      if (live?.state?.gameClockSeconds !== null && live?.state?.gameClockSeconds !== undefined) {
        setLocalClock(live.state.gameClockSeconds);
        lastClockTickRef.current = Date.now();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载实时比分失败');
    }
  }, [matchId, beginLoad, applyLive, setDetail, setError]);

  useEffect(() => {
    if (!matchId) return;
    void loadAll();
    return () => {
      reset();
    };
  }, [matchId, loadAll, reset]);

  /* ------------------------------ 3. Socket.IO 订阅 ------------------------------ */

  useEffect(() => {
    if (!matchId) return undefined;

    const subscription = subscribeMatch({
      matchId,
      role: 'audience',
      lastSeq: useMatchStore.getState().lastSeq,
      handlers: {
        onStatus: (status, detailText) => setConnection(status, detailText ?? null),
        onJoined: (ack) => {
          if (ack.state) applyState(ack.state);
          if (ack.feed && ack.feed.length > 0) mergeFeed(ack.feed);
        },
        onStatePatch: (payload) => {
          if (payload.state) applyState(payload.state);
        },
        onEventsCommitted: (payload) => {
          mergeCommitted({
            scoreboard: payload.scoreboard,
            finalSeq: payload.finalSeq,
            reordered: payload.reordered,
            at: payload.at,
          });
          // 服务端重排（离线补传）后，历史图文直播可能被改写，整表重拉一次。
          if (payload.reordered) void loadAll();
        },
        onFeedAppended: (payload) => mergeFeed(payload.items ?? []),
        onUndoApplied: (payload) => {
          applyScoreboard(payload.scoreboard);
          // 撤销会改写历史条目，重拉直播流最稳妥。
          void loadAll();
        },
        onMatchFinished: (payload) => markFinished(payload.finalScoreboard, payload.at),
        onPlayerHighlight: (payload) => pushHighlight(payload),
        onServerError: (payload) => setConnection('error', payload.message),
      },
    });

    subscriptionRef.current = subscription;
    return () => {
      subscription.dispose();
      subscriptionRef.current = null;
    };
  }, [
    matchId,
    applyState,
    mergeFeed,
    mergeCommitted,
    loadAll,
    applyScoreboard,
    markFinished,
    pushHighlight,
    setConnection,
  ]);

  // 小程序切到后台 / 页面卸载：必须断开长连接，否则后台会持续占用连接数。
  useDidHide(() => {
    // 保留连接（观众可能只是切出去看一眼），但记录时间用于展示「N 秒前更新」。
  });

  useUnload(() => {
    subscriptionRef.current?.dispose();
    subscriptionRef.current = null;
    reset();
  });

  /* ------------------------------ 4. 本地倒计时 ------------------------------ */

  const serverClock = state?.gameClockSeconds ?? null;
  const status = state?.status ?? 'scheduled';

  useEffect(() => {
    if (serverClock !== null) {
      setLocalClock(serverClock);
      lastClockTickRef.current = Date.now();
    }
  }, [serverClock, state?.period]);

  useEffect(() => {
    if (status !== 'live' || localClock === null) return undefined;
    const timer = setInterval(() => {
      setLocalClock((prev) => {
        if (prev === null) return prev;
        return prev > 0 ? prev - 1 : 0;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status, localClock === null]);

  /* ------------------------------ 5. 展示模型 ------------------------------ */

  const home = useMemo<TeamDisplay | null>(() => {
    if (state?.home) return displayFromTeamState(state.home, state.period ?? 1);
    if (state?.scoreboard?.home) {
      const board = state.scoreboard.home;
      return {
        name: board.name,
        shortName: board.shortName || board.name,
        color: board.color || '#64748b',
        score: board.score,
        teamFouls: 0,
        periodFouls: 0,
      };
    }
    return null;
  }, [state]);

  const away = useMemo<TeamDisplay | null>(() => {
    if (state?.away) return displayFromTeamState(state.away, state.period ?? 1);
    if (state?.scoreboard?.away) {
      const board = state.scoreboard.away;
      return {
        name: board.name,
        shortName: board.shortName || board.name,
        color: board.color || '#64748b',
        score: board.score,
        teamFouls: 0,
        periodFouls: 0,
      };
    }
    return null;
  }, [state]);

  const period = state?.period ?? 1;
  const regulationPeriods = detail?.match.regulationPeriods ?? 4;
  const statusLabel =
    status === 'live' ? '进行中' : status === 'finished' ? '已结束' : status === 'scheduled' ? '未开始' : '已归档';

  const topPlayers = useMemo(() => {
    if (!state) return [];
    const lines: Array<PlayerStatLine & { side: 'home' | 'away'; teamColor: string }> = [];
    const collect = (team: TeamState, side: 'home' | 'away') => {
      for (const line of team.players ?? []) {
        lines.push({ ...line, side, teamColor: team.color || '#64748b' });
      }
    };
    collect(state.home, 'home');
    collect(state.away, 'away');
    return lines.sort((a, b) => b.points - a.points || b.threePointersMade - a.threePointersMade).slice(0, 8);
  }, [state]);

  const connectionText = connectionLabel(connection, connectionDetail);
  const connectionClass =
    connection === 'connected' ? 'status--ok' : connection === 'error' ? 'status--bad' : 'status--warn';

  const handleRetry = useCallback(() => {
    subscriptionRef.current?.reconnect();
    if (!subscriptionRef.current?.isConnected()) void loadAll();
  }, [loadAll]);

  const handlePullDown = useCallback(async () => {
    await loadAll();
    subscriptionRef.current?.requestState(useMatchStore.getState().lastSeq, true);
    await Taro.stopPullDownRefresh();
  }, [loadAll]);

  const openLeaderboard = useCallback(() => {
    if (!matchId) return;
    void Taro.navigateTo({ url: `/pages/leaderboard/index?matchId=${matchId}` });
  }, [matchId]);

  /* ------------------------------ 6. 渲染 ------------------------------ */

  if (resolving) {
    return (
      <View className="page center">
        <Text className="muted">正在解析分享码…</Text>
      </View>
    );
  }

  if (fatalError) {
    return (
      <View className="page">
        <View className="card">
          <Text className="card__title">无法进入直播间</Text>
          <Text className="danger">{fatalError}</Text>
          <Button className="btn btn--primary" onClick={() => void Taro.navigateBack()}>
            返回首页
          </Button>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      scrollY
      className="live"
      onScrollToLower={() => undefined}
      refresherEnabled
      onRefresherRefresh={() => void handlePullDown()}
    >
      <View className="page">
        <View className={`status ${connectionClass}`}>
          <Text className="status__text">{connectionText}</Text>
          {connection !== 'connected' ? (
            <Text className="status__retry" onClick={handleRetry}>
              重试
            </Text>
          ) : null}
        </View>

        {storeError ? <Text className="danger live__error">{storeError}</Text> : null}

        <View className="card scoreboard">
          <View className="scoreboard__meta">
            <Text className="muted">{detail?.match.competition ?? state?.scoreboard?.matchId ?? ''}</Text>
            <Text className="muted">
              {statusLabel} · {formatPeriod(period, regulationPeriods)}
            </Text>
          </View>
          <View className="scoreboard__row">
            <View className="scoreboard__team">
              <Text className="scoreboard__name" style={{ color: home?.color ?? '#e5e7eb' }}>
                {home?.shortName ?? '主队'}
              </Text>
              <Text className="scoreboard__fouls muted">
                全队犯规 {home?.teamFouls ?? 0}（本节 {home?.periodFouls ?? 0}）
              </Text>
            </View>
            <View className="scoreboard__digits">
              <Text className="scoreboard__score">{home?.score ?? 0}</Text>
              <Text className="scoreboard__colon">:</Text>
              <Text className="scoreboard__score">{away?.score ?? 0}</Text>
            </View>
            <View className="scoreboard__team scoreboard__team--right">
              <Text className="scoreboard__name" style={{ color: away?.color ?? '#e5e7eb' }}>
                {away?.shortName ?? '客队'}
              </Text>
              <Text className="scoreboard__fouls muted">
                全队犯规 {away?.teamFouls ?? 0}（本节 {away?.periodFouls ?? 0}）
              </Text>
            </View>
          </View>
          <View className="scoreboard__clock">
            <Text className="scoreboard__clock-value">{formatClock(localClock)}</Text>
            <Text className="muted">剩余时间（本地推算，以现场计时为准）</Text>
          </View>
          {state?.scoreboard?.blowout ? (
            <Text className="scoreboard__blowout">分差较大，比赛悬念不多</Text>
          ) : null}
          <View className="scoreboard__actions">
            <Text className="scoreboard__updated muted">
              更新于 {formatRelativeTime(state?.updatedAt)}
            </Text>
            <Text className="scoreboard__link" onClick={openLeaderboard}>
              球员榜 ›
            </Text>
          </View>
        </View>

        {highlights.length > 0 ? (
          <View className="card highlights">
            <Text className="card__title">精彩时刻</Text>
            {highlights.map((item) => (
              <Text key={item.id} className={`highlight highlight--${item.teamSide}`}>
                {item.text}
              </Text>
            ))}
          </View>
        ) : null}

        <View className="card">
          <View className="row row--between">
            <Text className="card__title">图文直播（{feed.length}）</Text>
            <Text className="muted">最新在上</Text>
          </View>
          {feed.length === 0 ? (
            <Text className="muted">还没有比赛事件，等计分员开始记录…</Text>
          ) : (
            feed.slice(0, 60).map((item) => (
              <View key={item.id} className={`feed__item ${TONE_CLASS[item.tone] ?? ''}`}>
                <Text className="feed__time">
                  {item.clock ?? '--:--'} · P{item.period}
                </Text>
                <Text className="feed__text">{item.text}</Text>
                <Text className="feed__score">
                  {item.homeScore} : {item.awayScore}
                  {'  '}
                  <Text className="muted">{formatTimeOfDaySeconds(item.createdAt)}</Text>
                </Text>
              </View>
            ))
          )}
        </View>

        {topPlayers.length > 0 ? (
          <View className="card">
            <Text className="card__title">本场得分</Text>
            {topPlayers.map((line) => (
              <View key={line.playerId} className="player">
                <Text className="player__jersey" style={{ color: line.teamColor }}>
                  #{line.jerseyNumber}
                </Text>
                <Text className="player__name">{line.name}</Text>
                <Text className="player__points">{line.points} 分</Text>
                <Text className="muted player__extra">
                  {line.threePointersMade} 三分 · {line.fouls} 犯规
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
