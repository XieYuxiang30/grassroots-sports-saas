/**
 * 共享契约（@openhoopscore/contracts）的统一入口。
 *
 * ============================================================================
 * 为什么按模块精确引用，而不是 `from '@openhoopscore/contracts'`
 * ============================================================================
 * 说明（已核对当前仓库状态）：
 *   - `packages/contracts` 现在可以正常构建，`package.json` 也已经为
 *     ids / events / state / api / realtime / clock / score 都配了子路径导出，
 *     所以下面这些 `@openhoopscore/contracts/xxx` 引用都是官方支持的入口；
 *   - 不直接引根入口的原因有两条：
 *       1) 小程序端只需要「类型 + 少量常量」，按模块引用能让打包器少拉无关代码；
 *       2) 根入口会把 `api.ts` 里的 DTO 一并带进来，那些是 Node 侧管理后台用的，
 *          小程序端用不到。
 *   - `ProjectionTeamRef` 等类型已经统一放在 `state.ts`，不会再出现重名再导出。
 *
 * 下面这些类型全部是**直接 re-export**，没有重述、没有放宽 ——
 * 真源始终是 packages/contracts。
 */

export type {
  ClientEventId,
  ClientId,
  EventId,
  GamePeriodFormat,
  IsoDateTime,
  JsonValue,
  MatchId,
  MatchStatus,
  PlayerId,
  SeasonId,
  ShotType,
  TeamId,
  TeamSide,
} from '@openhoopscore/contracts/ids';

export type {
  BlockEventPayload,
  FoulEventPayload,
  GameEndEventPayload,
  GameEvent,
  GameEventDraft,
  GameEventPayloadMap,
  GameEventType,
  GameStartEventPayload,
  PeriodEndEventPayload,
  ReboundEventPayload,
  ScoreEventPayload,
  SubstitutionEventPayload,
  TeamFoulEventPayload,
  TimeoutEventPayload,
  TurnoverEventPayload,
  TypedGameEvent,
  VoidEventPayload,
} from '@openhoopscore/contracts/events';

export {
  GAME_EVENT_TYPES,
  UNDOABLE_EVENT_TYPES,
  isGameEventType,
  resolveEventPoints,
} from '@openhoopscore/contracts/events';

export type {
  LiveFeedItem,
  Match,
  MatchDetail,
  MatchLiveState,
  MatchState,
  Player,
  PlayerStatLine,
  ScoreTimelinePoint,
  Scoreboard,
  Season,
  Team,
  TeamState,
  UndoableAction,
} from '@openhoopscore/contracts/state';

export type {
  ErrorEvent,
  EventsCommittedEvent,
  FeedAppendedEvent,
  JoinMatchAck,
  JoinMatchPayload,
  MatchFinishedEvent,
  PlayerHighlightEvent,
  RealtimeRole,
  ScorerPresenceEvent,
  StatePatchEvent,
  UndoAppliedEvent,
} from '@openhoopscore/contracts/realtime';

export {
  CLIENT_EVENTS,
  MATCH_ROOM,
  REALTIME_NAMESPACE,
  SCORER_ROOM,
  SERVER_EVENTS,
} from '@openhoopscore/contracts/realtime';

/**
 * 关于 `score.ts` 与 `clock.ts`：
 *   - `score.ts` 里的 `projectMatch` 是**纯函数计分内核**。小程序端只做展示，
 *     比分一律以服务端 `state:patch` 推送的权威 `MatchState` 为准，
 *     因此不引入它，避免在端上出现「第二份比分推导逻辑」。
 *   - `clock.ts` 里的确定性时钟是**服务端写入侧**的职责（排序、幂等），
 *     客户端不参与排序，同样不引入。
 *   两者都在 `packages/contracts` 里正常构建并导出，需要时可以按
 *   `@openhoopscore/contracts/score` / `/clock` 直接引用。
 */

/* ============================================================================
 * 以下是 packages/contracts/src/api.ts 中**观众端实际用到的**响应类型原样重述。
 *
 * 为什么不直接 re-export `@openhoopscore/contracts/api`：
 * 那个模块同时包含管理后台用的请求 DTO（创建比赛、球员录入等），
 * 小程序端用不到；按需重述这几个响应类型可以让打包器少拉无关代码。
 * 字段名 / 可空性 / 语义与契约严格保持一致 —— 修改时两边都要改。
 * ========================================================================== */

import type { IsoDateTime, MatchId, MatchStatus, PlayerId, TeamId, TeamSide } from '@openhoopscore/contracts/ids';
import type { GameEvent } from '@openhoopscore/contracts/events';
import type { MatchLiveState } from '@openhoopscore/contracts/state';

export interface ApiErrorBody {
  statusCode: number;
  message: string;
  error?: string;
  code?: string;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  storageDriver: 'json' | 'prisma' | 'memory';
  serverTime: IsoDateTime;
  projectionVersion: string;
}

/** 列表页用的比赛摘要。 */
export interface MatchSummary {
  id: MatchId;
  competition: string;
  title: string;
  venue: string | null;
  status: MatchStatus;
  scheduledAt: IsoDateTime | null;
  shareCode: string;
  period: number;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  /** 大屏/列表页用的比分字符串，如 "58 : 52"。 */
  scoreText: string;
  updatedAt: IsoDateTime;
}

export interface ListMatchesResponse {
  items: MatchSummary[];
  total: number;
}

/** 扫码进房：分享码 → 比赛 id。 */
export interface ResolveShareCodeResponse {
  matchId: MatchId;
  match: MatchSummary;
}

/** `GET /api/matches/:id/live` 与契约的 MatchLiveState 完全同构。 */
export type MatchLiveResponse = MatchLiveState;

/** `GET /api/matches/:id/events?sinceSeq=` */
export interface QueryEventsResponse {
  matchId: MatchId;
  events: GameEvent[];
  nextSeq: number;
  hasMore: boolean;
}

export interface PlayerLeaderboardEntry {
  playerId: PlayerId;
  teamId: TeamId;
  teamSide: TeamSide;
  teamName: string;
  name: string;
  jerseyNumber: string;
  points: number;
  fouls: number;
  threePointersMade: number;
  /** 排名，从 1 开始，同分并列。 */
  rank: number;
}

export interface PlayerLeaderboardResponse {
  matchId: MatchId;
  entries: PlayerLeaderboardEntry[];
  sortedBy: 'points' | 'fouls' | 'threePointersMade';
}
