import type { GameEvent } from './events';
import type {
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

/** ============================ 实体（Admin 后台维护） ============================ */

export interface Player {
  id: PlayerId;
  teamId: TeamId;
  /** 球衣号码，同一队伍内唯一。 */
  jerseyNumber: string;
  name: string;
  /** 是否首发，仅用于展示。 */
  isStarter: boolean;
  createdAt: IsoDateTime;
}

export interface Team {
  id: TeamId;
  matchId: MatchId;
  side: TeamSide;
  name: string;
  /** 队伍简称，展示端空间有限时使用。 */
  shortName: string;
  /** 主题色，用于比分牌与图表。 */
  color: string;
  players: Player[];
}

export interface Match {
  id: MatchId;
  seasonId: SeasonId | null;
  /** 赛事名称，如「XX 街道第三届篮球联赛」。 */
  competition: string;
  /** 比赛标题，如「A 组第 3 轮」。 */
  title: string;
  venue: string | null;
  /** 计划开赛时间。 */
  scheduledAt: IsoDateTime | null;
  status: MatchStatus;
  periodFormat: GamePeriodFormat;
  /** 单节时长（秒），用于展示与倒计时建议值。 */
  periodSeconds: number;
  /** 允许的常规节数（不含加时）。 */
  regulationPeriods: number;
  /** 扫码进房的分享码（短、易念，便于现场口头传播）。 */
  shareCode: string;
  homeTeamId: TeamId;
  awayTeamId: TeamId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Season {
  id: SeasonId;
  name: string;
  organizer: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: IsoDateTime;
}

/** 比赛详情聚合（一次请求把计分端 / 观众端需要的东西全带上）。 */
export interface MatchDetail {
  match: Match;
  season: Season | null;
  teams: { home: Team; away: Team };
}

/** ============================ 投影：当前比分与统计 ============================ */

export interface PlayerStatLine {
  playerId: PlayerId;
  teamId: TeamId;
  name: string;
  jerseyNumber: string;
  points: number;
  fouls: number;
  /** 按得分方式统计命中数。 */
  madeByShotType: Record<ShotType, number>;
  /** 命中三分数，便于观众端高亮。 */
  threePointersMade: number;
  turnovers: number;
  steals: number;
  blocks: number;
  reboundsOffensive: number;
  reboundsDefensive: number;
  /** 该球员当前是否在场（依据换人事件推导）。 */
  onCourt: boolean;
}

export interface TeamState {
  teamId: TeamId;
  side: TeamSide;
  name: string;
  shortName: string;
  color: string;
  score: number;
  /** 全队犯规总数。 */
  teamFouls: number;
  /** 按节次累计的全队犯规，用于显示「本节犯规」。 */
  teamFoulsByPeriod: Record<number, number>;
  timeoutsUsed: number;
  players: PlayerStatLine[];
}

/** 比分牌：观众端首屏渲染只需要它。 */
export interface Scoreboard {
  matchId: MatchId;
  status: MatchStatus;
  period: number;
  /** 剩余秒数，可空。 */
  gameClockSeconds: number | null;
  home: { teamId: TeamId; name: string; shortName: string; color: string; score: number };
  away: { teamId: TeamId; name: string; shortName: string; color: string; score: number };
  /** 领先方，平局为 null。 */
  leader: TeamSide | null;
  /** 分差绝对值。 */
  margin: number;
  /** 比赛是否已无悬念（分差 ≥ 20 且第四节过半）——只做展示提示。 */
  blowout: boolean;
  updatedAt: IsoDateTime;
}

/** 完整比赛状态：由事件流重放得到的唯一真相。 */
export interface MatchState {
  matchId: MatchId;
  status: MatchStatus;
  period: number;
  gameClockSeconds: number | null;
  home: TeamState;
  away: TeamState;
  scoreboard: Scoreboard;
  /** 已应用的最大 seq，客户端据此增量同步。 */
  lastSeq: number;
  /** 已应用的有效事件数（不含被作废的）。 */
  appliedEventCount: number;
  /** 被作废的事件 id 集合，撤销逻辑与调试都需要。 */
  voidedEventIds: string[];
  /** 最近一次事件的时间，用于「N 秒前更新」提示。 */
  updatedAt: IsoDateTime;
}

/** 图文直播条目，如「第一节 05:30 张三命中三分」。 */
export interface LiveFeedItem {
  id: string;
  matchId: MatchId;
  seq: number;
  /** 归一化后的展示时间（mm:ss）。 */
  clock: string | null;
  period: number;
  teamId: TeamId | null;
  teamSide: TeamSide | null;
  teamName: string | null;
  playerId: PlayerId | null;
  playerName: string | null;
  jerseyNumber: string | null;
  type: GameEvent['type'];
  points: number;
  /** 已生成好的中文文案，前端直接渲染。 */
  text: string;
  /** 文案语气：主队得分 / 客队得分 / 中立。 */
  tone: 'home' | 'away' | 'neutral';
  /** 比分快照（该事件生效后）。 */
  homeScore: number;
  awayScore: number;
  createdAt: IsoDateTime;
}

/** 比分时间线上的一个关键点，用于观众端画走势图。 */
export interface ScoreTimelinePoint {
  seq: number;
  period: number;
  homeScore: number;
  awayScore: number;
  label: string;
}

/** 撤销栈里的一项：展示「上一步」到底做了什么，避免计分员误撤销。 */
export interface UndoableAction {
  eventId: string;
  seq: number;
  type: GameEvent['type'];
  description: string;
  createdAt: IsoDateTime;
}

/** 服务端权威状态 + 撤销栈一起返回，计分端不必自己推演。 */
export interface MatchLiveState {
  state: MatchState;
  feed: LiveFeedItem[];
  timeline: ScoreTimelinePoint[];
  undoable: UndoableAction[];
}

/**
 * 投影上下文里的队伍引用。
 *
 * 放在这里（而不是 ./score.ts）是为了让 ./api.ts 能引用它而又不产生
 * 「api → score → api」的循环依赖：类型层面循环虽不报错，
 * 但会让 d.ts 生成顺序变得不可预测。
 */
export interface ProjectionTeamRef {
  teamId: string;
  /** 'home' | 'away' */
  side: TeamSide;
  /** 全队犯规上限提示用，默认按 FIBA 规则 5 次。 */
  teamFoulLimit?: number;
}
