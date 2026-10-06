import { io, type Socket } from 'socket.io-client';
import {
  CLIENT_EVENTS,
  REALTIME_NAMESPACE,
  SERVER_EVENTS,
  type EventsCommittedEvent,
  type FeedAppendedEvent,
  type JoinMatchAck,
  type MatchFinishedEvent,
  type PlayerHighlightEvent,
  type RealtimeRole,
  type StatePatchEvent,
  type UndoAppliedEvent,
} from '../contracts';
import { resolveBaseUrl } from './api';

/**
 * ============================================================================
 * Socket.IO 实时订阅封装（观众端）
 * ============================================================================
 * 现场网络极差，因此这里做了三件事：
 *   1. `reconnection: true` + 指数退避（reconnectionDelay / reconnectionDelayMax）；
 *   2. 把连接生命周期暴露成 `onStatus` 回调，UI 可以显示「连接中…」；
 *   3. 返回可 `dispose()` 的句柄，页面卸载必须调用，避免小程序后台长连接泄漏。
 *
 * 注意：微信小程序的 WebSocket 只支持 `transports: ['websocket']`，
 * 且 socket.io 客户端握手不走 `Sec-WebSocket-Protocol`，因此这里显式关掉
 * polling 与 upgrade，避免小程序端出现「一直连不上」的伪故障。
 */

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface RealtimeSubscriptionHandlers {
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** 新事件被接受（权威比分增量）。 */
  onEventsCommitted?: (payload: EventsCommittedEvent) => void;
  /** 服务端权威状态补丁（节次、时钟、状态、重同步）。 */
  onStatePatch?: (payload: StatePatchEvent) => void;
  /** 图文直播增量。 */
  onFeedAppended?: (payload: FeedAppendedEvent) => void;
  /** 撤销生效（观众端需要重拉直播流，因为历史条目可能被改写）。 */
  onUndoApplied?: (payload: UndoAppliedEvent) => void;
  /** 比赛结束。 */
  onMatchFinished?: (payload: MatchFinishedEvent) => void;
  /** 球员里程碑高亮。 */
  onPlayerHighlight?: (payload: PlayerHighlightEvent) => void;
  /** 服务端错误事件（命名空间内的 error）。 */
  onServerError?: (payload: { code: string; message: string; matchId?: string }) => void;
  /** 加入房间成功，ack 里可能已经带上权威状态与缺失事件。 */
  onJoined?: (ack: JoinMatchAck) => void;
  /** 连接异常（超时、网络不可用等）。 */
  onConnectionError?: (error: Error) => void;
}

export interface RealtimeSubscribeOptions {
  matchId: string;
  role?: RealtimeRole;
  /** 本地已有数据的最大 seq，服务端据此只推缺失事件。 */
  lastSeq?: number;
  viewerId?: string;
  /** 覆盖 baseURL（默认取 services/api 的 resolveBaseUrl()）。 */
  baseUrl?: string;
  handlers?: RealtimeSubscriptionHandlers;
}

export interface RealtimeSubscription {
  /** 当前是否已连接。 */
  isConnected: () => boolean;
  /** 主动请求补拉缺失事件（重连后 / 手动下拉刷新）。 */
  requestState: (sinceSeq?: number, withFeed?: boolean) => void;
  /** 手动重连（用户点「重试」）。 */
  reconnect: () => void;
  /** 断开并释放所有监听，页面 onUnload 必须调用。 */
  dispose: () => void;
  readonly socket: Socket;
}

const SOCKET_PATH = '/socket.io';

export function subscribeMatch(options: RealtimeSubscribeOptions): RealtimeSubscription {
  const {
    matchId,
    role = 'audience',
    lastSeq = 0,
    viewerId,
    handlers = {},
    baseUrl = resolveBaseUrl(),
  } = options;

  let disposed = false;
  let status: ConnectionStatus = 'idle';
  let joinedSeq = lastSeq;

  const emitStatus = (next: ConnectionStatus, detail?: string): void => {
    if (disposed) return;
    status = next;
    try {
      handlers.onStatus?.(next, detail);
    } catch {
      // 订阅者的回调异常不应影响连接。
    }
  };

  emitStatus('connecting');

  const socket: Socket = io(`${baseUrl.replace(/\/+$/, '')}${REALTIME_NAMESPACE}`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 8000,
    randomizationFactor: 0.5,
    timeout: 15000,
    forceNew: true,
    autoConnect: true,
    query: viewerId ? { viewerId } : undefined,
  });

  const join = (): void => {
    if (disposed) return;
    socket.emit(
      CLIENT_EVENTS.join,
      { matchId, role, lastSeq: joinedSeq, viewerId },
      (ack: JoinMatchAck) => {
        if (disposed) return;
        if (!ack?.ok) {
          emitStatus('error', ack?.error ?? 'join_failed');
          return;
        }
        emitStatus('connected');
        try {
          handlers.onJoined?.(ack);
        } catch {
          // ignore
        }
      },
    );
  };

  socket.on('connect', () => {
    emitStatus('connected');
    join();
  });

  socket.on('disconnect', (reason: string) => {
    emitStatus(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting', reason);
  });

  socket.io.on('reconnect_attempt', (attempt: number) => {
    emitStatus('reconnecting', `第 ${attempt} 次重连`);
  });

  socket.io.on('error', (error: Error) => {
    emitStatus('error', error?.message ?? 'socket_error');
    try {
      handlers.onConnectionError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // ignore
    }
  });

  socket.on('connect_error', (error: Error) => {
    emitStatus('reconnecting', error?.message ?? 'connect_error');
    try {
      handlers.onConnectionError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // ignore
    }
  });

  socket.on(SERVER_EVENTS.committed, (payload: EventsCommittedEvent) => {
    if (disposed || !payload) return;
    joinedSeq = Math.max(joinedSeq, payload.finalSeq ?? joinedSeq);
    try {
      handlers.onEventsCommitted?.(payload);
    } catch {
      // ignore
    }
  });

  socket.on(SERVER_EVENTS.statePatch, (payload: StatePatchEvent) => {
    if (disposed || !payload) return;
    if (payload.state) joinedSeq = Math.max(joinedSeq, payload.state.lastSeq ?? joinedSeq);
    try {
      handlers.onStatePatch?.(payload);
    } catch {
      // ignore
    }
  });

  socket.on(SERVER_EVENTS.feedAppended, (payload: FeedAppendedEvent) => {
    if (disposed || !payload) return;
    try {
      handlers.onFeedAppended?.(payload);
    } catch {
      // ignore
    }
  });

  socket.on(SERVER_EVENTS.undoApplied, (payload: UndoAppliedEvent) => {
    if (disposed || !payload) return;
    try {
      handlers.onUndoApplied?.(payload);
    } catch {
      // ignore
    }
  });

  socket.on(SERVER_EVENTS.matchFinished, (payload: MatchFinishedEvent) => {
    if (disposed || !payload) return;
    try {
      handlers.onMatchFinished?.(payload);
    } catch {
      // ignore
    }
  });

  socket.on(SERVER_EVENTS.playerHighlight, (payload: PlayerHighlightEvent) => {
    if (disposed || !payload) return;
    try {
      handlers.onPlayerHighlight?.(payload);
    } catch {
      // ignore
    }
  });

  // v4 起服务端保留 `error` 事件名，需要单独监听。
  const maybeOn = socket as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  maybeOn.on(SERVER_EVENTS.error, (payload: unknown) => {
    if (disposed) return;
    const detail = (payload ?? {}) as { code?: string; message?: string; matchId?: string };
    try {
      handlers.onServerError?.({
        code: detail.code ?? 'server_error',
        message: detail.message ?? '服务端返回错误',
        matchId: detail.matchId,
      });
    } catch {
      // ignore
    }
  });

  const subscription: RealtimeSubscription = {
    socket,
    isConnected: () => socket.connected,
    requestState: (sinceSeq = joinedSeq, withFeed = true) => {
      if (disposed || !socket.connected) return;
      socket.emit(
        CLIENT_EVENTS.requestState,
        { matchId, sinceSeq, withFeed },
        (ack: { ok: boolean; error?: string }) => {
          if (disposed) return;
          if (!ack?.ok) emitStatus('connected', ack?.error ?? 'state_request_failed');
        },
      );
    },
    reconnect: () => {
      if (disposed) return;
      emitStatus('connecting');
      if (socket.connected) {
        join();
      } else {
        socket.connect();
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // 离开房间，避免服务端维持无用的观众连接。
      try {
        if (socket.connected) socket.emit(CLIENT_EVENTS.leave, { matchId });
      } catch {
        // ignore
      }
      try {
        socket.removeAllListeners();
        socket.io.removeAllListeners();
        socket.disconnect();
        socket.close();
      } catch {
        // ignore
      }
      status = 'disconnected';
    },
  };

  // 暴露当前状态给调用方（首屏渲染时避免闪烁）。
  Object.defineProperty(subscription, 'status', {
    get: () => status,
    enumerable: false,
  });

  return subscription;
}
