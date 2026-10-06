import type {
  ClientEventId,
  ClientId,
  EventId,
  IsoDateTime,
  MatchId,
  PlayerId,
  ShotType,
  TeamId,
  TeamSide,
} from './ids';

/**
 * ============================================================================
 * GameEvents —— 事件溯源的核心表结构
 * ============================================================================
 * 对应方案里的 `GameEvents` 表。**千万不要只存最终比分**：
 * 只有把每一次点击都存成不可变事件，才能做到
 *   1) 实时重算比分；2) 随时撤销上一操作；3) 离线补传后按时间重排；
 *   4) 生成图文直播流与球员数据榜。
 */

export const GAME_EVENT_TYPES = [
  /** 比赛开始 / 进入跳球 */
  'game_start',
  /** 得分 */
  'score',
  /** 个人犯规 */
  'foul',
  /** 全队犯规（单节累计，用于罚球判定提示） */
  'team_foul',
  /** 暂停 */
  'timeout',
  /** 换人 */
  'substitution',
  /** 失误 */
  'turnover',
  /** 抢断 */
  'steal',
  /** 盖帽 */
  'block',
  /** 篮板 */
  'rebound',
  /** 结束当前节次 */
  'period_end',
  /** 结束比赛 */
  'game_end',
  /** 撤销：把某条历史事件标记为「作废」，见 VoidEventPayload */
  'void',
] as const;

export type GameEventType = (typeof GAME_EVENT_TYPES)[number];

export interface ScoreEventPayload {
  points: 1 | 2 | 3;
  shotType?: ShotType;
  /** 快攻得分标记，用于直播文案「快攻得手」。 */
  fastBreak?: boolean;
  /** 助攻球员，可空。 */
  assistPlayerId?: PlayerId | null;
}

export interface FoulEventPayload {
  /** 犯规类型，自由文本即可，基层赛事不需要严格枚举。 */
  foulType?: 'personal' | 'technical' | 'unsportsmanlike' | 'other';
}

export interface TeamFoulEventPayload {
  /** 默认 1，多数情况一条事件记一次全队犯规。 */
  count?: number;
}

export interface TimeoutEventPayload {
  /** 20 秒短暂停 / 60 秒常规暂停。 */
  durationSeconds?: 20 | 60;
}

export interface SubstitutionEventPayload {
  playerInId: PlayerId;
  playerOutId: PlayerId;
}

export interface ReboundEventPayload {
  kind: 'offensive' | 'defensive';
}

export type TurnoverEventPayload = Record<string, never>;
export type StealEventPayload = Record<string, never>;
export type BlockEventPayload = Record<string, never>;
export type GameStartEventPayload = Record<string, never>;

export interface PeriodEndEventPayload {
  /** 该节结束时的比分快照，仅用于直播文案，权威比分仍由事件推导。 */
  homeScore?: number;
  awayScore?: number;
}

export interface GameEndEventPayload {
  /** 结束原因，便于区分正常结束与提前终止。 */
  reason?: 'normal' | 'forfeit' | 'aborted';
}

/**
 * 撤销事件：不删除历史事件，而是追加一条 `void` 指向被作废的事件。
 * 这样做的好处是审计链完整（谁在什么时候撤销了什么），
 * 同时重放时只需忽略被 void 的事件即可得到正确比分。
 */
export interface VoidEventPayload {
  targetEventId: EventId;
  reason?: string;
}

/** 各类事件 payload 的映射表，便于泛型收窄。 */
export interface GameEventPayloadMap {
  game_start: GameStartEventPayload;
  score: ScoreEventPayload;
  foul: FoulEventPayload;
  team_foul: TeamFoulEventPayload;
  timeout: TimeoutEventPayload;
  substitution: SubstitutionEventPayload;
  turnover: TurnoverEventPayload;
  steal: StealEventPayload;
  block: BlockEventPayload;
  rebound: ReboundEventPayload;
  period_end: PeriodEndEventPayload;
  game_end: GameEndEventPayload;
  void: VoidEventPayload;
}

/**
 * 一条比赛事件。
 *
 * 关键排序字段说明（离线优先架构的核心）：
 *   - `clientTimestamp`：事件在**计分设备本地**发生的时间。断网期间各设备各记各的，
 *     联网后靠它把多个设备的操作合并成一条时间线。
 *   - `seq`：服务端在**接受该事件时**分配的严格递增序号。它是权威顺序，
 *     也是给观众端做增量同步 + 断线重放的游标（cursor）。
 *   - 冲突规则见 ./clock.ts：先比 clientTimestamp，再比 clientId，最后比 clientEventId，
 *     保证任意设备用同一批事件都能算出**完全一致**的顺序与比分（确定性收敛）。
 */
export interface GameEvent {
  id: EventId;
  matchId: MatchId;
  type: GameEventType;
  /** 事件归属队伍；game_start / period_end / game_end 可为空。 */
  teamId: TeamId | null;
  /** 事件归属球员；非球员事件（暂停、全队犯规）为空。 */
  playerId: PlayerId | null;
  /** 该事件造成的得分增量：0 / 1 / 2 / 3。 */
  points: number;
  /** 发生时比赛处于第几节（从 1 开始）。 */
  period: number;
  /** 事件发生时比赛剩余秒数（可空，基层赛事常常没有专职计时员）。 */
  gameClockSeconds: number | null;
  /** 计分设备本地时间。 */
  clientTimestamp: IsoDateTime;
  /** 计分设备标识。 */
  clientId: ClientId;
  /** 幂等键：同一 (matchId, clientEventId) 只会被接受一次。 */
  clientEventId: ClientEventId;
  /** 服务端分配的权威序号。同步补传的事件会被重新排序。 */
  seq: number;
  /** 服务端接受时间（审计用，不参与排序）。 */
  createdAt: IsoDateTime;
  /**
   * 若该事件已被撤销，这里指向那条 void 事件。
   * 它是服务端投影时顺手写入的冗余标记，方便增量同步时无需回查全部事件。
   */
  voidedByEventId?: EventId | null;
  /** 事件类型对应的结构化数据。 */
  payload: GameEventPayloadMap[GameEventType];
}

/** 泛型版：当调用方已知事件类型时可获得精确的 payload 类型。 */
export type TypedGameEvent<T extends GameEventType> = Omit<GameEvent, 'type' | 'payload'> & {
  type: T;
  payload: GameEventPayloadMap[T];
};

/** 计分端在本地生成、尚未被服务端确认的事件。 */
export interface PendingGameEvent
  extends Omit<GameEvent, 'id' | 'seq' | 'createdAt'> {
  /** 本地乐观渲染时使用的临时 id。 */
  id: EventId;
}

/**
 * 客户端提交的事件草稿：不带 seq / createdAt（服务端权威），
 * 但**必须**带 clientEventId（幂等）与 clientTimestamp（排序）。
 */
export type GameEventDraft = Omit<GameEvent, 'seq' | 'createdAt'>;

export function isGameEventType(value: unknown): value is GameEventType {
  return typeof value === 'string' && (GAME_EVENT_TYPES as readonly string[]).includes(value);
}

/** 事件是否属于「比赛进程」类（用于判断能否撤销）。 */
export const UNDOABLE_EVENT_TYPES: readonly GameEventType[] = [
  'score',
  'foul',
  'team_foul',
  'timeout',
  'substitution',
  'turnover',
  'steal',
  'block',
  'rebound',
];

export interface GameEventDraftInput {
  type: GameEventType;
  teamId?: TeamId | null;
  playerId?: PlayerId | null;
  period: number;
  gameClockSeconds?: number | null;
  clientTimestamp: IsoDateTime;
  clientId: ClientId;
  clientEventId: ClientEventId;
  payload?: GameEventPayloadMap[GameEventType];
}

/** 从事件类型推导出的默认得分增量，保证 points 与 type 一致。 */
export function resolveEventPoints(type: GameEventType, payload: unknown): number {
  if (type !== 'score') return 0;
  const points = (payload as ScoreEventPayload | undefined)?.points;
  if (points === 1 || points === 2 || points === 3) return points;
  throw new Error('score 事件的 payload.points 必须为 1、2 或 3');
}

export interface TeamSideRef {
  side: TeamSide;
  teamId: TeamId;
}
