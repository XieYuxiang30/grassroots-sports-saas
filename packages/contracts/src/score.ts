import { compareEventsForOrder } from './clock';
import type { GameEvent, GameEventType, VoidEventPayload } from './events';
import type { ProjectionTeamRef } from './state';

/**
 * ============================================================================
 * 纯函数计分内核
 * ============================================================================
 * 这段逻辑**同时运行在服务端与计分端本地**：
 *   - 计分端离线时用它做乐观渲染（点击立刻看到比分变化）；
 *   - 服务端用它从事件流重放出权威比分；
 *   - 两者输入同一批事件必须得到同一结果，否则会出现「本地显示 12:10、服务器 10:10」。
 * 因此这里不依赖任何运行时环境（无 Date.now、无随机数、无 IO）。
 */

export interface ScoredEvent {
  eventId: string;
  type: GameEventType;
  teamId: string | null;
  playerId: string | null;
  points: number;
  period: number;
  seq: number;
  clientTimestamp: string;
  clientId: string;
  clientEventId: string;
}

export interface ScoreTally {
  home: number;
  away: number;
  /** 按节次的得分，便于做单节比分条。 */
  homeByPeriod: Record<number, number>;
  awayByPeriod: Record<number, number>;
}

export interface PlayerTally {
  playerId: string;
  teamId: string;
  points: number;
  fouls: number;
  threePointersMade: number;
}

export interface TeamTally {
  score: number;
  teamFouls: number;
  teamFoulsByPeriod: Record<number, number>;
  timeoutsUsed: number;
}

export interface ProjectionTally {
  score: ScoreTally;
  home: TeamTally;
  away: TeamTally;
  players: Record<string, PlayerTally>;
  period: number;
  status: 'scheduled' | 'live' | 'finished' | 'archived';
  /** 有效（未被作废）事件数。 */
  appliedEventCount: number;
  /** 被作废的事件 id。 */
  voidedEventIds: string[];
  lastSeq: number;
  updatedAt: string | null;
}

export interface ProjectionContext {
  matchId: string;
  homeTeam: ProjectionTeamRef;
  awayTeam: ProjectionTeamRef;
  /** 常规节数，超过则视为加时。 */
  regulationPeriods?: number;
  status?: ProjectionTally['status'];
}

export const DEFAULT_TEAM_FOUL_LIMIT = 5;

function emptyTally(): ProjectionTally {
  return {
    score: { home: 0, away: 0, homeByPeriod: {}, awayByPeriod: {} },
    home: { score: 0, teamFouls: 0, teamFoulsByPeriod: {}, timeoutsUsed: 0 },
    away: { score: 0, teamFouls: 0, teamFoulsByPeriod: {}, timeoutsUsed: 0 },
    players: {},
    period: 1,
    status: 'scheduled',
    appliedEventCount: 0,
    voidedEventIds: [],
    lastSeq: 0,
    updatedAt: null,
  };
}

function ensurePlayer(tally: ProjectionTally, playerId: string, teamId: string): PlayerTally {
  const existing = tally.players[playerId];
  if (existing) return existing;
  const created: PlayerTally = { playerId, teamId, points: 0, fouls: 0, threePointersMade: 0 };
  tally.players[playerId] = created;
  return created;
}

function sideOf(context: ProjectionContext, teamId: string | null): 'home' | 'away' | null {
  if (!teamId) return null;
  if (teamId === context.homeTeam.teamId) return 'home';
  if (teamId === context.awayTeam.teamId) return 'away';
  return null;
}

/**
 * 从事件流重放比分。
 *
 * 顺序规则：调用方应当传入**已按权威顺序（seq）排好**的事件；
 * 若传入的是乱序（例如纯客户端离线队列），本函数会先按
 * clientTimestamp → clientId → clientEventId 重新排序，
 * 保证与服务端对同一批离线事件的推导结果一致。
 *
 * 作废规则：`void` 事件指向的 targetEventId 会被从投影中剔除，
 * 但 void 事件本身计入 appliedEventCount 以便审计。
 */
export function projectMatch(
  events: readonly GameEvent[],
  context: ProjectionContext,
  options: { assumeSorted?: boolean } = {},
): ProjectionTally {
  const ordered = options.assumeSorted ? [...events] : [...events].sort(compareEventsForOrder);
  const tally = emptyTally();
  tally.status = context.status ?? 'scheduled';

  // 第一遍：收集作废关系，避免「先得分后撤销」的顺序问题。
  const voided = new Set<string>();
  for (const event of ordered) {
    if (event.type === 'void') {
      const payload = event.payload as VoidEventPayload | undefined;
      if (payload?.targetEventId) voided.add(payload.targetEventId);
    } else if (event.voidedByEventId) {
      // 允许事件携带服务端标记的作废引用（增量同步时更省流量）。
      voided.add(event.id);
    }
  }
  tally.voidedEventIds = [...voided].sort();

  for (const event of ordered) {
    tally.lastSeq = Math.max(tally.lastSeq, event.seq);
    const ts = event.createdAt || event.clientTimestamp;
    if (!tally.updatedAt || ts > tally.updatedAt) tally.updatedAt = ts;

    // 作废事件本身不改变比分，但计入审计。
    if (event.type === 'void') {
      tally.appliedEventCount += 1;
      continue;
    }
    // 被作废的事件直接跳过，等价于「没发生过」。
    if (voided.has(event.id)) continue;

    tally.appliedEventCount += 1;
    const side = sideOf(context, event.teamId);
    const teamTally = side === 'home' ? tally.home : side === 'away' ? tally.away : null;

    switch (event.type) {
      case 'game_start': {
        tally.status = 'live';
        if (event.period) tally.period = Math.max(1, event.period);
        break;
      }
      case 'score': {
        const points = Number.isFinite(event.points) ? event.points : 0;
        if (side === 'home') {
          tally.score.home += points;
          tally.home.score += points;
          tally.score.homeByPeriod[event.period] = (tally.score.homeByPeriod[event.period] ?? 0) + points;
        } else if (side === 'away') {
          tally.score.away += points;
          tally.away.score += points;
          tally.score.awayByPeriod[event.period] = (tally.score.awayByPeriod[event.period] ?? 0) + points;
        }
        if (event.playerId && event.teamId) {
          const line = ensurePlayer(tally, event.playerId, event.teamId);
          line.points += points;
          if (points === 3) line.threePointersMade += 1;
        }
        if (tally.status === 'scheduled') tally.status = 'live';
        break;
      }
      case 'foul': {
        if (event.playerId && event.teamId) {
          ensurePlayer(tally, event.playerId, event.teamId).fouls += 1;
        }
        break;
      }
      case 'team_foul': {
        if (teamTally) {
          const count = Math.max(1, Number((event.payload as { count?: number } | undefined)?.count ?? 1));
          teamTally.teamFouls += count;
          teamTally.teamFoulsByPeriod[event.period] = (teamTally.teamFoulsByPeriod[event.period] ?? 0) + count;
        }
        break;
      }
      case 'timeout': {
        if (teamTally) teamTally.timeoutsUsed += 1;
        break;
      }
      case 'period_end': {
        const next = Math.max(tally.period, event.period) + 1;
        const regulation = context.regulationPeriods ?? 4;
        tally.period = Math.min(next, regulation + 10); // 加时赛上限保护
        break;
      }
      case 'game_end': {
        tally.status = 'finished';
        break;
      }
      case 'substitution':
      case 'turnover':
      case 'steal':
      case 'block':
      case 'rebound': {
        if (event.playerId && event.teamId) ensurePlayer(tally, event.playerId, event.teamId);
        break;
      }
      default:
        break;
    }
  }

  return tally;
}

/** 从投影结果生成观众端比分牌。 */
export function buildScoreboard(
  matchId: string,
  tally: ProjectionTally,
  context: ProjectionContext,
  sync: { home: { name: string; shortName: string; color: string }; away: { name: string; shortName: string; color: string } },
): import('./state').Scoreboard {
  const margin = Math.abs(tally.score.home - tally.score.away);
  const leader: import('./ids').TeamSide | null =
    tally.score.home === tally.score.away ? null : tally.score.home > tally.score.away ? 'home' : 'away';
  const regulation = context.regulationPeriods ?? 4;
  const lateGame = tally.period >= regulation && tally.status === 'live';
  return {
    matchId,
    status: tally.status,
    period: tally.period,
    gameClockSeconds: null as number | null,
    home: {
      teamId: context.homeTeam.teamId,
      name: sync.home.name,
      shortName: sync.home.shortName,
      color: sync.home.color,
      score: tally.score.home,
    },
    away: {
      teamId: context.awayTeam.teamId,
      name: sync.away.name,
      shortName: sync.away.shortName,
      color: sync.away.color,
      score: tally.score.away,
    },
    leader,
    margin,
    blowout: lateGame && margin >= 20,
    updatedAt: tally.updatedAt ?? new Date(0).toISOString(),
  };
}

/** 把剩余秒数格式化为 mm:ss（无计时员时为 null）。 */
export function formatGameClock(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const clamped = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(clamped / 60)
    .toString()
    .padStart(2, '0');
  const ss = (clamped % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 计分端本地撤销栈：找出「上一步可以撤销的操作」。 */
export function findUndoableEvents(events: readonly GameEvent[]): ScoredEvent[] {
  const voided = new Set<string>();
  for (const event of events) {
    if (event.type === 'void') {
      const payload = event.payload as VoidEventPayload | undefined;
      if (payload?.targetEventId) voided.add(payload.targetEventId);
    }
  }
  return events
    .filter((event) => event.type !== 'void' && !voided.has(event.id))
    .map((event) => ({
      eventId: event.id,
      type: event.type,
      teamId: event.teamId,
      playerId: event.playerId,
      points: event.points,
      period: event.period,
      seq: event.seq,
      clientTimestamp: event.clientTimestamp,
      clientId: event.clientId,
      clientEventId: event.clientEventId,
    }));
}
