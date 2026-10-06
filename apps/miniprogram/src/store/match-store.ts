import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { ConnectionStatus } from '../services/realtime';
import type {
  LiveFeedItem,
  MatchDetail,
  MatchLiveState,
  MatchState,
  PlayerHighlightEvent,
  Scoreboard,
} from '../contracts';

/**
 * ============================================================================
 * 比赛状态仓库（zustand）
 * ============================================================================
 * 单一数据源：`MatchState` 由服务端权威投影给出（REST `/live` 首屏 + Socket `state:patch`），
 * 前端只做合并与展示，不自己重算比分，避免两端投影不一致。
 *
 * feed 用 `id` 去重（事件 id 与图文直播条目 id 一致），因为：
 *   - `feed:appended` 是增量推送；
 *   - `events:committed.reordered = true` 时服务端可能重排，需要整表替换。
 */

export interface MatchHighlight {
  id: string;
  playerId: string;
  teamSide: 'home' | 'away';
  text: string;
  milestone: string;
  at: string;
}

export interface MatchStoreState {
  /** 当前比赛 id；null 表示尚未加载。 */
  matchId: string | null;
  detail: MatchDetail | null;
  state: MatchState | null;
  feed: LiveFeedItem[];
  /** 已知的最大 seq，用于重连时带 lastSeq。 */
  lastSeq: number;
  connection: ConnectionStatus;
  /** 连接状态的人类可读补充（重连次数、错误原因）。 */
  connectionDetail: string | null;
  highlights: MatchHighlight[];
  loading: boolean;
  error: string | null;
  /** 数据最后一次更新时间（ISO）。 */
  updatedAt: string | null;

  /* ---------------- actions ---------------- */
  reset: () => void;
  beginLoad: (matchId: string) => void;
  setError: (message: string | null) => void;
  setDetail: (detail: MatchDetail | null) => void;
  applyLive: (payload: MatchLiveState) => void;
  applyState: (state: MatchState) => void;
  applyScoreboard: (scoreboard: Scoreboard) => void;
  mergeCommitted: (payload: { scoreboard: Scoreboard; finalSeq: number; reordered: boolean; at: string }) => void;
  mergeFeed: (items: readonly LiveFeedItem[]) => void;
  replaceFeed: (items: readonly LiveFeedItem[]) => void;
  pushHighlight: (payload: PlayerHighlightEvent) => void;
  markFinished: (scoreboard: Scoreboard, at: string) => void;
  setConnection: (status: ConnectionStatus, detail?: string | null) => void;
  setLoading: (loading: boolean) => void;
}

const MAX_FEED_ITEMS = 200;
const MAX_HIGHLIGHTS = 8;

/** 图文直播流：最新在最上面（按 seq 倒序，seq 相同按 createdAt 倒序）。 */
function sortFeed(items: readonly LiveFeedItem[]): LiveFeedItem[] {
  return [...items].sort((a, b) => {
    if (b.seq !== a.seq) return b.seq - a.seq;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

export const useMatchStore = create<MatchStoreState>()(
  subscribeWithSelector((set) => ({
    matchId: null,
    detail: null,
    state: null,
    feed: [],
    lastSeq: 0,
    connection: 'idle',
    connectionDetail: null,
    highlights: [],
    loading: false,
    error: null,
    updatedAt: null,

    reset: () =>
      set({
        matchId: null,
        detail: null,
        state: null,
        feed: [],
        lastSeq: 0,
        connection: 'idle',
        connectionDetail: null,
        highlights: [],
        loading: false,
        error: null,
        updatedAt: null,
      }),

    beginLoad: (matchId) =>
      set((prev) => ({
        matchId,
        loading: true,
        error: null,
        // 换场次时清空上一场的数据，避免串场。
        state: prev.matchId === matchId ? prev.state : null,
        feed: prev.matchId === matchId ? prev.feed : [],
        detail: prev.matchId === matchId ? prev.detail : null,
        lastSeq: prev.matchId === matchId ? prev.lastSeq : 0,
        highlights: prev.matchId === matchId ? prev.highlights : [],
      })),

    setError: (message) => set({ error: message, loading: false }),

    setDetail: (detail) => set({ detail }),

    applyLive: (payload) =>
      set((prev) => ({
        state: payload.state ?? prev.state,
        feed: payload.feed ? sortFeed(dedupeFeed(payload.feed)).slice(0, MAX_FEED_ITEMS) : prev.feed,
        lastSeq: Math.max(prev.lastSeq, payload.state?.lastSeq ?? 0),
        loading: false,
        error: null,
        updatedAt: payload.state?.updatedAt ?? prev.updatedAt,
      })),

    applyState: (state) =>
      set((prev) => ({
        state,
        lastSeq: Math.max(prev.lastSeq, state.lastSeq ?? 0),
        updatedAt: state.updatedAt ?? prev.updatedAt,
      })),

    applyScoreboard: (scoreboard) =>
      set((prev) => {
        if (!prev.state) return { updatedAt: scoreboard.updatedAt };
        return {
          state: {
            ...prev.state,
            status: scoreboard.status,
            period: scoreboard.period,
            gameClockSeconds: scoreboard.gameClockSeconds,
            scoreboard,
            updatedAt: scoreboard.updatedAt,
          },
          updatedAt: scoreboard.updatedAt,
        };
      }),

    mergeCommitted: ({ scoreboard, finalSeq, at }) =>
      set((prev) => {
        const nextState = prev.state
          ? {
              ...prev.state,
              status: scoreboard.status,
              period: scoreboard.period,
              gameClockSeconds: scoreboard.gameClockSeconds,
              scoreboard,
              lastSeq: Math.max(prev.state.lastSeq ?? 0, finalSeq),
              updatedAt: scoreboard.updatedAt,
            }
          : prev.state;
        return {
          state: nextState,
          lastSeq: Math.max(prev.lastSeq, finalSeq),
          updatedAt: at ?? scoreboard.updatedAt,
        };
      }),

    mergeFeed: (items) =>
      set((prev) => ({
        feed: sortFeed(dedupeFeed([...items, ...prev.feed])).slice(0, MAX_FEED_ITEMS),
      })),

    replaceFeed: (items) => set({ feed: sortFeed(dedupeFeed(items)).slice(0, MAX_FEED_ITEMS) }),

    pushHighlight: (payload) =>
      set((prev) => {
        const item: MatchHighlight = {
          id: `${payload.playerId}:${payload.milestone}:${payload.at}`,
          playerId: payload.playerId,
          teamSide: payload.teamSide,
          text: payload.text,
          milestone: payload.milestone,
          at: payload.at,
        };
        const deduped = prev.highlights.filter((existing) => existing.id !== item.id);
        return { highlights: [item, ...deduped].slice(0, MAX_HIGHLIGHTS) };
      }),

    markFinished: (scoreboard, at) =>
      set((prev) => ({
        state: prev.state
          ? { ...prev.state, status: 'finished', scoreboard, updatedAt: scoreboard.updatedAt }
          : prev.state,
        updatedAt: at,
      })),

    setConnection: (status, detail = null) =>
      set({ connection: status, connectionDetail: detail ?? null }),

    setLoading: (loading) => set({ loading }),
  })),
);

/** 按 id 去重，保留后出现（更新）的那条。 */
function dedupeFeed(items: readonly LiveFeedItem[]): LiveFeedItem[] {
  const map = new Map<string, LiveFeedItem>();
  for (const item of items) {
    if (!item) continue;
    const key = item.id ?? `${item.seq}:${item.text}`;
    const existing = map.get(key);
    if (!existing || (item.createdAt ?? '') >= (existing.createdAt ?? '')) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

/** 当前已知的最大 seq（给 realtime 的 lastSeq 用）。 */
export function selectLastSeq(): number {
  return useMatchStore.getState().lastSeq;
}

/** 连接状态中文文案，供 UI 直接渲染。 */
export function connectionLabel(status: ConnectionStatus, detail?: string | null): string {
  switch (status) {
    case 'connecting':
      return '连接中…';
    case 'reconnecting':
      return detail ? `重连中…（${detail}）` : '重连中…';
    case 'connected':
      return '实时连接正常';
    case 'error':
      return detail ? `连接异常：${detail}` : '连接异常';
    case 'disconnected':
      return '已断开';
    default:
      return '未连接';
  }
}

export { sortFeed };
