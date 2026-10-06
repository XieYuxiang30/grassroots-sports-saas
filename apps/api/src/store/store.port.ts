import type {
  GameEvent,
  GameEventDraft,
  Match,
  MatchStatus,
  Player,
  Season,
  Team,
} from '@openhoopscore/contracts';
import type { MatchRoster } from './assignment-planner';

/**
 * 持久化端口（Port）。
 *
 * 之所以抽出这一层：基层赛事的部署环境差别很大 ——
 *   - 学生机 / 演示环境：不想装 PostgreSQL，直接用 `json` 驱动（零依赖，文件落盘）；
 *   - 正式环境：`prisma` 驱动 + PostgreSQL，享有序号唯一约束与事务级幂等。
 * 业务代码只依赖这个接口，换驱动不用改一行计分逻辑。
 */

export interface MatchAggregate {
  match: Match;
  teams: { home: Team; away: Team };
}

export interface CreateMatchRecord {
  seasonId: string | null;
  competition: string;
  title: string;
  venue: string | null;
  scheduledAt: string | null;
  periodFormat: Match['periodFormat'];
  periodSeconds: number;
  regulationPeriods: number;
  shareCode: string;
  home: { name: string; shortName: string; color: string; players: PlayerDraftRecord[] };
  away: { name: string; shortName: string; color: string; players: PlayerDraftRecord[] };
}

export interface PlayerDraftRecord {
  name: string;
  jerseyNumber: string;
  isStarter: boolean;
}

export interface CreateSeasonRecord {
  name: string;
  organizer: string | null;
  startDate: string | null;
  endDate: string | null;
}

/** 一次事件追加请求：驱动负责幂等、排序、序号分配与冲突标记。 */
export interface AppendEventsRequest {
  matchId: string;
  clientId: string;
  events: GameEventDraft[];
  /** 参赛名单快照，用于校验事件里的队伍/球员归属。 */
  roster: MatchRoster;
  /** 单场比赛事件数上限，超过则拒绝（保护存储）。 */
  maxEventsPerMatch: number;
}

export interface AppendEventsOutcome {
  /** 服务端最终落库的（本次新接受 + 因重排需要移动的）事件，按权威顺序升序。 */
  events: GameEvent[];
  accepted: Array<{ clientEventId: string; eventId: string; seq: number }>;
  duplicates: Array<{ clientEventId: string; eventId: string; seq: number }>;
  rejected: Array<{ clientEventId: string; reason: string }>;
  /** 是否发生了顺序调整（离线补传典型场景）。 */
  reordered: boolean;
  /** 落库后该比赛的最大 seq。 */
  finalSeq: number;
}

export interface VoidEventsRequest {
  matchId: string;
  /** 要作废的事件 id（按「最近优先」顺序传入）。 */
  targetEventIds: string[];
  /** 撤销事件的元信息。 */
  voidDraft: GameEventDraft;
  /** 参赛名单快照，用于校验。 */
  roster: MatchRoster;
}

export interface VoidEventsOutcome {
  voidedEventIds: string[];
  voidEvents: GameEvent[];
  finalSeq: number;
}

export interface SyncBatchRecord {
  matchId: string;
  clientId: string;
  eventCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  sinceSeq: number | null;
  finalSeq: number;
  offlineSeconds: number | null;
}

export interface StoredSeason extends Season {
  matchCount: number;
}

export interface StorePort {
  /** 驱动名，健康检查里会返回。 */
  readonly driver: 'json' | 'prisma' | 'memory';

  init(): Promise<void>;
  dispose(): Promise<void>;

  // ---- 赛季 ----
  createSeason(input: CreateSeasonRecord): Promise<Season>;
  listSeasons(): Promise<StoredSeason[]>;
  findSeasonById(id: string): Promise<Season | null>;

  // ---- 比赛 ----
  createMatch(input: CreateMatchRecord): Promise<MatchAggregate>;
  listMatches(filter?: { seasonId?: string; status?: MatchStatus; limit?: number }): Promise<MatchAggregate[]>;
  findMatchById(id: string): Promise<MatchAggregate | null>;
  findMatchByShareCode(code: string): Promise<MatchAggregate | null>;
  updateMatch(id: string, patch: Partial<Match>): Promise<MatchAggregate | null>;
  addPlayer(matchId: string, side: 'home' | 'away', player: PlayerDraftRecord): Promise<Player | null>;
  deletePlayer(matchId: string, playerId: string): Promise<boolean>;

  // ---- 事件 ----
  listEvents(matchId: string, options?: { sinceSeq?: number; limit?: number }): Promise<GameEvent[]>;
  countEvents(matchId: string): Promise<number>;
  appendEvents(request: AppendEventsRequest): Promise<AppendEventsOutcome>;
  voidEvents(request: VoidEventsRequest): Promise<VoidEventsOutcome>;
  recordSyncBatch(record: SyncBatchRecord): Promise<void>;
  /** 检查若干 clientEventId 是否已存在，用于计分端启动时清理本地队列。 */
  findExistingClientEventIds(matchId: string, clientEventIds: string[]): Promise<string[]>;

  /** 保留期清理：删除 archived 且早于 cutoff 的比赛事件（合规/容量管理）。 */
  purgeArchived(before: Date): Promise<number>;
}
