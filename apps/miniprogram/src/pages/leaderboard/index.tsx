import { useCallback, useEffect, useMemo, useState } from 'react';
import Taro, { useRouter } from '@tarojs/taro';
import { ScrollView, Text, View } from '@tarojs/components';
import type { PlayerLeaderboardEntry } from '../../contracts';
import {
  ApiError,
  getLeaderboard,
  sortLeaderboard,
  type LeaderboardSort,
} from '../../services/api';
import { useMatchStore } from '../../store/match-store';
import './index.css';

const SORT_OPTIONS: Array<{ key: LeaderboardSort; label: string }> = [
  { key: 'points', label: '得分' },
  { key: 'fouls', label: '犯规' },
  { key: 'threePointersMade', label: '三分' },
];

const METRIC_LABEL: Record<LeaderboardSort, string> = {
  points: '分',
  fouls: '次犯规',
  threePointersMade: '记三分',
};

/** 服务端不可用时，从 store 里已有的 TeamState.players 推导一份榜单。 */
function deriveFromStore(matchId: string): PlayerLeaderboardEntry[] {
  const state = useMatchStore.getState().state;
  if (!state || state.matchId !== matchId) return [];

  const rows: PlayerLeaderboardEntry[] = [];
  const push = (team: typeof state.home, side: 'home' | 'away') => {
    for (const line of team.players ?? []) {
      if (line.points === 0 && line.fouls === 0 && line.threePointersMade === 0) continue;
      rows.push({
        playerId: line.playerId,
        teamId: line.teamId,
        teamSide: side,
        teamName: team.name,
        name: line.name,
        jerseyNumber: line.jerseyNumber,
        points: line.points,
        fouls: line.fouls,
        threePointersMade: line.threePointersMade,
        rank: 0,
      });
    }
  };
  push(state.home, 'home');
  push(state.away, 'away');
  return rows;
}

/** 按得分给出并列名次（同分并列，下一个名次跳号）。 */
function assignRanks(entries: PlayerLeaderboardEntry[]): PlayerLeaderboardEntry[] {
  const sorted = [...entries].sort((a, b) => b.points - a.points || a.jerseyNumber.localeCompare(b.jerseyNumber));
  let lastPoints: number | null = null;
  let lastRank = 0;
  return sorted.map((entry, index) => {
    if (lastPoints === null || entry.points !== lastPoints) {
      lastRank = index + 1;
      lastPoints = entry.points;
    }
    return { ...entry, rank: lastRank };
  });
}

export default function LeaderboardPage() {
  const router = useRouter();
  const matchId = router.params.matchId ?? '';

  const [sort, setSort] = useState<LeaderboardSort>('points');
  const [entries, setEntries] = useState<PlayerLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'api' | 'local'>('api');

  const state = useMatchStore((snapshot) => snapshot.state);
  const detail = useMatchStore((snapshot) => snapshot.detail);

  const load = useCallback(
    async (nextSort: LeaderboardSort) => {
      if (!matchId) {
        setError('缺少 matchId，请从直播间进入');
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const response = await getLeaderboard(matchId, nextSort);
        const items = response.entries ?? [];
        setEntries(items.length > 0 ? sortLeaderboard(items, nextSort) : assignRanks(deriveFromStore(matchId)));
        setSource(items.length > 0 ? 'api' : 'local');
      } catch (err) {
        const local = assignRanks(deriveFromStore(matchId));
        setEntries(sortLeaderboard(local, nextSort));
        setSource('local');
        setError(
          err instanceof ApiError
            ? `${err.message}（已改用本机已有数据）`
            : '获取球员榜失败（已改用本机已有数据）',
        );
      } finally {
        setLoading(false);
      }
    },
    [matchId],
  );

  useEffect(() => {
    void load(sort);
  }, [load, sort]);

  // 直播间的 Socket 更新了 state 时，本地推导的榜单也应该跟着变。
  useEffect(() => {
    if (source !== 'local' || !state) return;
    setEntries(sortLeaderboard(assignRanks(deriveFromStore(matchId)), sort));
  }, [state, source, sort, matchId]);

  const title = useMemo(() => {
    if (detail) return `${detail.match.competition} · ${detail.match.title}`;
    return '球员榜';
  }, [detail]);

  const handlePullDown = useCallback(async () => {
    await load(sort);
    await Taro.stopPullDownRefresh();
  }, [load, sort]);

  return (
    <ScrollView
      scrollY
      className="leaderboard"
      refresherEnabled
      onRefresherRefresh={() => void handlePullDown()}
    >
      <View className="page">
        <View className="card">
          <Text className="card__title">{title}</Text>
          <Text className="muted">
            {matchId ? `比赛 ${matchId.slice(0, 8)}` : '未知比赛'} ·{' '}
            {source === 'api' ? '服务端榜单' : '本机推导'}
          </Text>
          <View className="tabs">
            {SORT_OPTIONS.map((option) => (
              <Text
                key={option.key}
                className={`tab ${sort === option.key ? 'tab--active' : ''}`}
                onClick={() => setSort(option.key)}
              >
                {option.label}
              </Text>
            ))}
          </View>
          {loading ? <Text className="muted">加载中…</Text> : null}
          {error ? <Text className="danger leaderboard__error">{error}</Text> : null}
        </View>

        <View className="card">
          {entries.length === 0 ? (
            <Text className="muted">暂无球员数据（比赛还没开始或还没有事件）</Text>
          ) : (
            entries.map((entry, index) => (
              <View key={entry.playerId} className="rank">
                <Text className="rank__no">{entry.rank || index + 1}</Text>
                <View className="rank__main">
                  <Text className="rank__name">
                    #{entry.jerseyNumber} {entry.name}
                  </Text>
                  <Text className="muted rank__team">
                    {entry.teamName} · {entry.teamSide === 'home' ? '主队' : '客队'}
                  </Text>
                </View>
                <View className="rank__stats">
                  <Text className="rank__metric">
                    {entry[sort]}
                    <Text className="rank__unit">{METRIC_LABEL[sort]}</Text>
                  </Text>
                  <Text className="muted rank__sub">
                    {entry.points}分 / {entry.fouls}犯 / {entry.threePointersMade}三分
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}
