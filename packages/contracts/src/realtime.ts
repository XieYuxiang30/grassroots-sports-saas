import type { GameEvent, GameEventDraft } from './events';
import type { ClientId, EventId, IsoDateTime, MatchId, PlayerId, TeamId, TeamSide } from './ids';
import type { LiveFeedItem, MatchState, Scoreboard, UndoableAction } from './state';

/**
 * ============================================================================
 * Socket.IO 实时协议
 * ============================================================================
 * 房间命名（服务端 join 时统一使用 `roomOf`）：
 *   - `match:{matchId}`            所有人（观众 + 计分员）都进，接收比分广播
 *   - `match:{matchId}:scorers`    只有计分员进，接收撤销栈等敏感事件
 *
 * 设计要点（针对「现场网络极差」）：
 *   1. 服务端只广播**增量**（新事件 + 最新比分）与**低频全量**（每 N 次变更补一次 state），
 *      客户端断线重连后带上 `lastSeq` 拉增量，避免全量重传。
 *   2. 心跳与超时放宽（见 .env.example），并把 `transports` 优先 websocket、
 *      自动降级到长轮询，兼容场馆里只放行 80/443 的网络。
 *   3. 计分端的每一次点击**先落 IndexedDB**，再发 `scoring:submit`；
 *      断网时本地队列累积，恢复后按批补传，服务端幂等去重。
 */

export const REALTIME_NAMESPACE = '/realtime';

export const MATCH_ROOM = (matchId: MatchId): string => `match:${matchId}`;
export const SCORER_ROOM = (matchId: MatchId): string => `match:${matchId}:scorers`;

/** 角色决定推送内容与权限：观众只读，计分员可写。 */
export type RealtimeRole = 'audience' | 'scorer' | 'display';

/* ------------------------------ 客户端 → 服务端 ------------------------------ */

export interface JoinMatchPayload {
  matchId: MatchId;
  role: RealtimeRole;
  /** 计分员口令（role=scorer 时必填）。 */
  passcode?: string;
  /** 计分端设备标识，用于在线设备列表与冲突排查。 */
  clientId?: ClientId;
  /** 客户端已有数据的最大 seq，服务端据此推送缺失事件。 */
  lastSeq?: number;
  /** 观众端标识（可选，仅用于统计并发）。 */
  viewerId?: string;
}

export interface JoinMatchAck {
  ok: boolean;
  role: RealtimeRole;
  matchId: MatchId;
  serverTime: IsoDateTime;
  /** 加入失败原因。 */
  error?: 'match_not_found' | 'invalid_passcode' | 'match_archived';
  /** 加入成功时直接带回权威状态 + 缺失事件，省掉一次 REST 往返。 */
  state?: MatchState;
  events?: GameEvent[];
  feed?: LiveFeedItem[];
  /** 当前在线计分设备，方便「另一台设备正在计分」提示。 */
  onlineScorers?: Array<{ clientId: ClientId; since: IsoDateTime }>;
}

export interface SubmitEventsPayload {
  matchId: MatchId;
  clientId: ClientId;
  /** 计分员口令：写操作必须校验，避免观众端伪造比分。 */
  passcode?: string;
  events: GameEventDraft[];
  /** 乐观 UI 用的本地批次号，服务端原样回传。 */
  batchId?: string;
}

export interface SubmitEventsAck {
  ok: boolean;
  batchId?: string;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  serverSeq: number;
  error?: 'invalid_passcode' | 'match_not_found' | 'too_many_events' | 'invalid_event';
  /** 被拒绝事件的明细，便于计分端把本地队列标记为失败而不是无限重试。 */
  rejected?: Array<{ clientEventId: string; reason: string }>;
}

export interface UndoPayload {
  matchId: MatchId;
  clientId: ClientId;
  passcode?: string;
  targetEventId?: EventId;
  steps?: number;
}

export interface UndoAck {
  ok: boolean;
  voidedEventIds: EventId[];
  descriptions: string[];
  error?: 'nothing_to_undo' | 'invalid_passcode' | 'target_not_found';
}

export interface RequestStatePayload {
  matchId: MatchId;
  /** 只要比这个 seq 新的事件。 */
  sinceSeq?: number;
  /** 是否附带图文直播流。 */
  withFeed?: boolean;
}

export interface SetClockPayload {
  matchId: MatchId;
  clientId: ClientId;
  passcode?: string;
  period?: number;
  gameClockSeconds?: number | null;
  running?: boolean;
}

/** 比赛结束/归档由计分端触发，服务端广播通知观众端。 */
export interface FinishMatchPayload {
  matchId: MatchId;
  clientId: ClientId;
  passcode?: string;
  reason?: 'normal' | 'forfeit' | 'aborted';
}

export interface ClientToServerEvents {
  'match:join': (payload: JoinMatchPayload, ack?: (result: JoinMatchAck) => void) => void;
  'match:leave': (payload: { matchId: MatchId }) => void;
  'scoring:submit': (payload: SubmitEventsPayload, ack?: (result: SubmitEventsAck) => void) => void;
  'scoring:undo': (payload: UndoPayload, ack?: (result: UndoAck) => void) => void;
  'state:request': (
    payload: RequestStatePayload,
    ack?: (result: { ok: boolean; state?: MatchState; events?: GameEvent[]; feed?: LiveFeedItem[]; error?: string }) => void,
  ) => void;
  'clock:set': (payload: SetClockPayload, ack?: (result: { ok: boolean; error?: string }) => void) => void;
  'match:finish': (payload: FinishMatchPayload, ack?: (result: { ok: boolean; error?: string }) => void) => void;
}

/* ------------------------------ 服务端 → 客户端 ------------------------------ */

/** 有事件被接受后广播的增量（观众端靠它做零延迟更新）。 */
export interface EventsCommittedEvent {
  matchId: MatchId;
  /** 新接受的、按权威顺序排好的事件。 */
  events: GameEvent[];
  /** 权威状态（本期只带比分牌与关键计数，减小包体）。 */
  scoreboard: Scoreboard;
  finalSeq: number;
  /** 是否有客户端补传导致重排（观众端需重新拉取直播流）。 */
  reordered: boolean;
  at: IsoDateTime;
}

export interface StatePatchEvent {
  matchId: MatchId;
  state: MatchState;
  reason: 'period_change' | 'clock' | 'match_status' | 'resync' | 'undo' | 'manual';
  at: IsoDateTime;
}

export interface FeedAppendedEvent {
  matchId: MatchId;
  items: LiveFeedItem[];
  at: IsoDateTime;
}

export interface UndoAppliedEvent {
  matchId: MatchId;
  voidedEventIds: EventId[];
  descriptions: string[];
  scoreboard: Scoreboard;
  undoable: UndoableAction[];
  clientId: ClientId;
  at: IsoDateTime;
}

export interface ScorerPresenceEvent {
  matchId: MatchId;
  online: Array<{ clientId: ClientId; since: IsoDateTime }>;
  at: IsoDateTime;
}

export interface MatchFinishedEvent {
  matchId: MatchId;
  reason: 'normal' | 'forfeit' | 'aborted';
  finalScoreboard: Scoreboard;
  at: IsoDateTime;
}

export interface PlayerHighlightEvent {
  matchId: MatchId;
  playerId: PlayerId;
  teamId: TeamId;
  teamSide: TeamSide;
  /** 里程碑类型，用于观众端弹幕式提示。 */
  milestone: 'double_double' | 'twenty_points' | 'fouled_out' | 'three_point_streak';
  text: string;
  at: IsoDateTime;
}

export interface ErrorEvent {
  code: string;
  message: string;
  matchId?: MatchId;
}

export interface ServerToClientEvents {
  'events:committed': (payload: EventsCommittedEvent) => void;
  'state:patch': (payload: StatePatchEvent) => void;
  'feed:appended': (payload: FeedAppendedEvent) => void;
  'undo:applied': (payload: UndoAppliedEvent) => void;
  'scorers:presence': (payload: ScorerPresenceEvent) => void;
  'match:finished': (payload: MatchFinishedEvent) => void;
  'player:highlight': (payload: PlayerHighlightEvent) => void;
  error: (payload: ErrorEvent) => void;
}

/** 供客户端与服务端共享的事件名常量（避免拼写漂移）。 */
export const CLIENT_EVENTS = {
  join: 'match:join',
  leave: 'match:leave',
  submit: 'scoring:submit',
  undo: 'scoring:undo',
  requestState: 'state:request',
  setClock: 'clock:set',
  finish: 'match:finish',
} as const satisfies Record<string, keyof ClientToServerEvents>;

export const SERVER_EVENTS = {
  committed: 'events:committed',
  statePatch: 'state:patch',
  feedAppended: 'feed:appended',
  undoApplied: 'undo:applied',
  scorersPresence: 'scorers:presence',
  matchFinished: 'match:finished',
  playerHighlight: 'player:highlight',
  error: 'error',
} as const satisfies Record<string, keyof ServerToClientEvents>;
