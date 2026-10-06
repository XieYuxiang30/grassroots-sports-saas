import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { JoinMatchAck, LiveFeedItem, MatchState, Scoreboard } from '@openhoopscore/contracts';
import { socketUrl } from '@/services/api';

/**
 * 观众端实时订阅钩子。
 *
 * 为什么观众端用「单个 hook 收口」而不是像计分端那样建一个引擎：
 *   - 观众端是**纯只读**，没有本地队列、没有冲突合并，状态机简单得多；
 *   - 但断线重连必须可靠：Socket.IO 自带重连 + 带上 lastSeq 补拉增量，
 *     这正是「观众在体育馆角落信号只有一格」时的关键。
 *
 * 返回值里刻意暴露 `connection`，让 UI 能诚实显示「连接中」，而不是让用户
 * 看着一个不动的比分以为比赛没开始。
 */
export interface LiveSubscription {
  state: MatchState | null;
  scoreboard: Scoreboard | null;
  feed: LiveFeedItem[];
  connection: 'connecting' | 'online' | 'offline';
  lastEventAt: string | null;
  error: string | null;
}

export function useLiveMatch(matchId: string): LiveSubscription {
  const [state, setState] = useState<MatchState | null>(null);
  const [feed, setFeed] = useState<LiveFeedItem[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!matchId) return;
    let disposed = false;

    const socket = io(socketUrl(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 600,
      reconnectionDelayMax: 6000,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnection('online');
      setError(null);
      socket.emit(
        'match:join',
        { matchId, role: 'audience', lastSeq: lastSeqRef.current },
        (ack: JoinMatchAck) => {
          if (disposed) return;
          if (!ack?.ok) {
            setError(ack?.error === 'match_not_found' ? '比赛不存在或已删除' : '加入观赛失败');
            setConnection('offline');
            return;
          }
          // 首屏与重连补拉都走同一个分支：合并不是替换，避免抖动
          if (ack.state) {
            setState(ack.state);
            lastSeqRef.current = Math.max(lastSeqRef.current, ack.state.lastSeq);
          }
          if (ack.feed) setFeed((previous) => mergeFeed(ack.feed ?? [], previous));
        },
      );
    });

    socket.on('disconnect', () => setConnection('offline'));
    socket.on('connect_error', () => setConnection('offline'));

    socket.on('events:committed', (payload: { events: unknown[]; scoreboard: Scoreboard; finalSeq: number; reordered: boolean; at: string }) => {
      lastSeqRef.current = Math.max(lastSeqRef.current, payload.finalSeq);
      setLastEventAt(payload.at);
      // 只需要比分牌：完整的 MatchState 由 state:patch 补齐，省流量
      setState((previous) =>
        previous
          ? { ...previous, scoreboard: payload.scoreboard, period: payload.scoreboard.period, status: payload.scoreboard.status, lastSeq: Math.max(previous.lastSeq, payload.finalSeq) }
          : previous,
      );
      if (payload.reordered) {
        // 补传导致时间线重排：直播流上下文可能已经变了，重新请求一次
        socket.emit('state:request', { matchId, sinceSeq: 0, withFeed: true }, (result: { ok: boolean; state?: MatchState; feed?: LiveFeedItem[] }) => {
          if (result?.ok) {
            if (result.state) setState(result.state);
            if (result.feed) setFeed(result.feed);
          }
        });
      }
    });

    socket.on('state:patch', (payload: { state: MatchState; at: string }) => {
      setState(payload.state);
      lastSeqRef.current = Math.max(lastSeqRef.current, payload.state.lastSeq);
      setLastEventAt(payload.at);
    });

    socket.on('feed:appended', (payload: { items: LiveFeedItem[] }) => {
      setFeed((previous) => mergeFeed(payload.items, previous));
    });

    socket.on('undo:applied', (payload: { scoreboard: Scoreboard; descriptions: string[]; at: string }) => {
      setLastEventAt(payload.at);
      // 撤销会改写历史直播条目，最稳的做法是重新拉一次直播流
      socket.emit('state:request', { matchId, sinceSeq: 0, withFeed: true }, (result: { ok: boolean; state?: MatchState; feed?: LiveFeedItem[] }) => {
        if (result?.ok) {
          if (result.state) setState(result.state);
          if (result.feed) setFeed(result.feed);
        }
      });
    });

    socket.on('match:finished', (payload: { finalScoreboard: Scoreboard }) => {
      setState((previous) => (previous ? { ...previous, status: 'finished', scoreboard: payload.finalScoreboard } : previous));
    });

    socket.on('error', (payload: { message: string }) => setError(payload.message));

    return () => {
      disposed = true;
      socket.emit('match:leave', { matchId });
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [matchId]);

  const requestResync = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit('state:request', { matchId, sinceSeq: lastSeqRef.current, withFeed: false }, (result: { ok: boolean; state?: MatchState }) => {
      if (result?.ok && result.state) setState(result.state);
    });
  }, [matchId]);

  return {
    state,
    scoreboard: state?.scoreboard ?? null,
    feed,
    connection,
    lastEventAt,
    error,
  };
}

/** 合并直播流：按 id 去重，最新的在最前，最多保留 200 条。 */
function mergeFeed(incoming: LiveFeedItem[], existing: LiveFeedItem[]): LiveFeedItem[] {
  if (incoming.length === 0) return existing;
  const seen = new Set<string>();
  const result: LiveFeedItem[] = [];
  for (const item of [...incoming, ...existing]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result.slice(0, 200);
}
