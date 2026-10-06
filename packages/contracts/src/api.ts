import type { GameEvent, GameEventDraft } from './events';
import type {
  ClientId,
  GamePeriodFormat,
  IsoDateTime,
  MatchId,
  MatchStatus,
  PlayerId,
  SeasonId,
  ShotType,
  TeamId,
  TeamSide,
} from './ids';
import type { LiveFeedItem, MatchDetail, MatchLiveState, MatchState, ProjectionTeamRef } from './state';

/** ============================ REST 请求 / 响应 ============================ */

export interface ApiErrorBody {
  statusCode: number;
  message: string;
  error?: string;
  /** 机器可读的错误码，前端据此做本地化文案。 */
  code?: string;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  storageDriver: 'json' | 'prisma' | 'memory';
  serverTime: IsoDateTime;
  /** 事件溯源内核版本，便于多端排查投影不一致。 */
  projectionVersion: string;
}

/* ------------------------------ 赛事 / 赛季 ------------------------------ */

export interface CreateSeasonDto {
  name: string;
  organizer?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface SeasonResponse {
  id: SeasonId;
  name: string;
  organizer: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: IsoDateTime;
  matchCount: number;
}

/* ------------------------------ 比赛 ------------------------------ */

export interface CreatePlayerDto {
  name: string;
  jerseyNumber: string;
  isStarter?: boolean;
}

export interface CreateTeamDto {
  name: string;
  shortName?: string;
  color?: string;
  players?: CreatePlayerDto[];
}

export interface CreateMatchDto {
  seasonId?: SeasonId | null;
  competition: string;
  title: string;
  venue?: string | null;
  scheduledAt?: IsoDateTime | null;
  periodFormat?: GamePeriodFormat;
  periodSeconds?: number;
  regulationPeriods?: number;
  home: CreateTeamDto;
  away: CreateTeamDto;
}

export interface UpdateMatchDto {
  competition?: string;
  title?: string;
  venue?: string | null;
  scheduledAt?: IsoDateTime | null;
  status?: MatchStatus;
  periodSeconds?: number;
  regulationPeriods?: number;
}

export interface AddPlayerDto extends CreatePlayerDto {
  /** 'home' | 'away' */
  side: TeamSide;
}

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

/* ------------------------------ 事件与同步 ------------------------------ */

/**
 * 提交事件（在线实时 + 离线补传共用同一个端点）。
 * 离线补传时 `events` 可能是积压的几十上百条，服务端会：
 *   1. 按幂等键去重；
 *   2. 归一化时间戳；
 *   3. 按确定性时钟重新排序并分配 seq；
 *   4. 重放投影，返回权威状态。
 */
export interface SubmitEventsDto {
  matchId: MatchId;
  clientId: ClientId;
  events: GameEventDraft[];
  /** 提交方当前已知的最大 seq，仅用于服务端日志与冲突提示，不参与排序。 */
  sinceSeq?: number;
}

export interface SubmitEventsResult {
  matchId: MatchId;
  /** 客户端事件 id → 服务端结果。 */
  results: Array<{
    clientEventId: string;
    status: 'accepted' | 'duplicate' | 'rejected' | 'reordered';
    eventId?: string;
    seq?: number;
    /** 被拒绝时的原因，例如 teamId 不属于本场比赛。 */
    reason?: string;
  }>;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  /** 提交后服务端权威状态。 */
  state: MatchState;
  /** 本次提交后新增的图文直播条目（供计分端「刚刚发生了什么」提示）。 */
  feed: LiveFeedItem[];
  /** 提示：客户端本地顺序与服务端权威顺序不一致（离线多设备场景）。 */
  reordered: boolean;
}

export interface QueryEventsResponse {
  matchId: MatchId;
  events: GameEvent[];
  /** 本次返回的最大 seq，作为下次增量拉取的游标。 */
  nextSeq: number;
  hasMore: boolean;
}

export interface MatchLiveResponse extends MatchLiveState {}

/* ------------------------------ 撤销 ------------------------------ */

export interface UndoDto {
  matchId: MatchId;
  clientId: ClientId;
  /** 指定要作废的事件 id；不传则默认撤销「最后一步可撤销操作」。 */
  targetEventId?: string;
  /** 一次撤销多步，用于计分员连点错误。 */
  steps?: number;
  reason?: string;
}

export interface UndoResult {
  matchId: MatchId;
  /** 实际被作废的事件（按撤销顺序，从最近往前）。 */
  voidedEventIds: string[];
  /** 解释每一步撤销了什么，便于 UI 提示。 */
  descriptions: string[];
  state: MatchState;
  undoable: MatchLiveState['undoable'];
}

/* ------------------------------ 计分端本地补传 ------------------------------ */

/** 计分端上报的本地积压状态，服务端用于展示「离线记录中 / 已同步」提示。 */
export interface SyncStatusReport {
  matchId: MatchId;
  clientId: ClientId;
  pendingCount: number;
  lastLocalEventAt: IsoDateTime | null;
  online: boolean;
}

export interface SyncStatusResponse {
  matchId: MatchId;
  clientId: ClientId;
  ack: SyncAck;
  serverSeq: number;
  /** 服务端认为客户端还缺的事件数（粗略估计，仅用于提示）。 */
  behindBy: number;
}

export interface SyncAck {
  accepted: boolean;
  serverTime: IsoDateTime;
}

/* ------------------------------ 观赛（球员榜） ------------------------------ */

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
  /** 用于统一排序的字段说明。 */
  sortedBy: 'points' | 'fouls' | 'threePointersMade';
}

/* ------------------------------ 计分核心转发（供计分端离线兜底） ------------------------------ */

export interface ComputePreviewDto {
  matchId: MatchId;
  /** 客户端本地积压的事件 + 服务端已确认事件，服务端做一次无副作用试算。 */
  events: GameEventDraft[];
}

export interface ComputePreviewResponse {
  /** 试算出的比分，用于校验两端投影算法一致。 */
  homeScore: number;
  awayScore: number;
  period: number;
  projectionVersion: string;
}

export type { GameEvent, GameEventDraft, MatchDetail, MatchState, LiveFeedItem, ProjectionTeamRef, ShotType };
