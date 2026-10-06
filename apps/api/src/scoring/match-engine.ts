import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  GameEvent,
  LiveFeedItem,
  MatchState,
  PlayerStatLine,
  ProjectionTeamRef,
  Scoreboard,
  ScoreTimelinePoint,
  ShotType,
  TeamState,
  UndoableAction,
} from '@openhoopscore/contracts';
import {
  DEFAULT_TEAM_FOUL_LIMIT,
  UNDOABLE_EVENT_TYPES,
  buildScoreboard,
  formatGameClock,
  projectMatch,
} from '@openhoopscore/contracts';
import type { MatchAggregate } from '../store/store.port';

/**
 * ============================================================================
 * 比赛引擎 —— 把「事件流」翻译成「观众能看懂的一切」
 * ============================================================================
 * 纯计算，无 IO，可单测。它负责三件事：
 *   1. 重放投影 → 比分牌 + 双方球队/球员统计（MatchState）
 *   2. 事件流 → 中文图文直播文案（LiveFeedItem[]）
 *   3. 撤销栈 → 计分端「上一步做了什么」的提示（UndoableAction[]）
 */
@Injectable()
export class MatchEngine {
  /** 构造投影上下文：事件里的 teamId / playerId 通过它映射到主客队。 */
  contextOf(aggregate: MatchAggregate) {
    const playerTeamId: Record<string, string> = {};
    for (const team of [aggregate.teams.home, aggregate.teams.away]) {
      for (const player of team.players) playerTeamId[player.id] = team.id;
    }
    return {
      matchId: aggregate.match.id,
      homeTeam: { teamId: aggregate.teams.home.id, side: 'home' } satisfies ProjectionTeamRef,
      awayTeam: { teamId: aggregate.teams.away.id, side: 'away' } satisfies ProjectionTeamRef,
      regulationPeriods: aggregate.match.regulationPeriods,
      playerTeamId,
    };
  }

  /** 从**已按权威顺序**排好的事件流重建完整比赛状态。 */
  buildState(aggregate: MatchAggregate, events: readonly GameEvent[]): MatchState {
    const context = this.contextOf(aggregate);
    const tally = projectMatch(events, context, { assumeSorted: true });

    // 事件里显式结束比赛时，以事件为准（事件溯源：状态也是推导出来的）
    const status = tally.status === 'finished' ? 'finished' : aggregate.match.status === 'archived' ? 'archived' : tally.status;

    const scoreboard = buildScoreboard(
      aggregate.match.id,
      tally,
      context,
      {
        home: {
          name: aggregate.teams.home.name,
          shortName: aggregate.teams.home.shortName,
          color: aggregate.teams.home.color,
        },
        away: {
          name: aggregate.teams.away.name,
          shortName: aggregate.teams.away.shortName,
          color: aggregate.teams.away.color,
        },
      },
    );

    const home = this.buildTeamState(aggregate.teams.home, tally, context, events);
    const away = this.buildTeamState(aggregate.teams.away, tally, context, events);

    // 比赛时钟：取最新一条带钟的事件值
    const lastWithClock = [...events].reverse().find((event) => event.gameClockSeconds !== null && event.gameClockSeconds !== undefined);

    return {
      matchId: aggregate.match.id,
      status,
      period: tally.period,
      gameClockSeconds: lastWithClock?.gameClockSeconds ?? null,
      home,
      away,
      scoreboard: { ...scoreboard, status, period: tally.period, gameClockSeconds: lastWithClock?.gameClockSeconds ?? null },
      lastSeq: tally.lastSeq,
      appliedEventCount: tally.appliedEventCount,
      voidedEventIds: tally.voidedEventIds,
      updatedAt: tally.updatedAt ?? aggregate.match.updatedAt,
    };
  }

  private buildTeamState(
    team: MatchAggregate['teams']['home'],
    tally: ReturnType<typeof projectMatch>,
    context: ReturnType<MatchEngine['contextOf']>,
    events: readonly GameEvent[],
  ): TeamState {
    const isHome = team.id === context.homeTeam.teamId;
    const teamTally = isHome ? tally.home : tally.away;
    const onCourt = this.computeOnCourt(team.players, events);

    const players: PlayerStatLine[] = team.players.map((player) => {
      const projection = tally.players[player.id];
      return {
        playerId: player.id,
        teamId: team.id,
        name: player.name,
        jerseyNumber: player.jerseyNumber,
        points: projection?.points ?? 0,
        fouls: projection?.fouls ?? 0,
        madeByShotType: this.computeShotTypes(events, player.id),
        threePointersMade: projection?.threePointersMade ?? 0,
        turnovers: this.countEvents(events, 'turnover', player.id),
        steals: this.countEvents(events, 'steal', player.id),
        blocks: this.countEvents(events, 'block', player.id),
        reboundsOffensive: this.countRebounds(events, player.id, 'offensive'),
        reboundsDefensive: this.countRebounds(events, player.id, 'defensive'),
        onCourt: onCourt.get(player.id) ?? player.isStarter,
      };
    });

    return {
      teamId: team.id,
      side: team.side,
      name: team.name,
      shortName: team.shortName,
      color: team.color,
      score: teamTally.score,
      teamFouls: teamTally.teamFouls,
      teamFoulsByPeriod: teamTally.teamFoulsByPeriod,
      timeoutsUsed: teamTally.timeoutsUsed,
      players,
    };
  }

  private computeShotTypes(events: readonly GameEvent[], playerId: string): Record<ShotType, number> {
    const result: Record<ShotType, number> = {
      layup: 0,
      mid: 0,
      three: 0,
      dunk: 0,
      free_throw: 0,
      other: 0,
    };
    for (const event of events) {
      if (event.type !== 'score' || event.playerId !== playerId) continue;
      const shotType = (event.payload as { shotType?: ShotType } | undefined)?.shotType;
      const key: ShotType = shotType && Object.prototype.hasOwnProperty.call(result, shotType) ? shotType : 'other';
      result[key] += 1;
    }
    return result;
  }

  private countEvents(events: readonly GameEvent[], type: GameEvent['type'], playerId: string): number {
    return events.filter((event) => event.type === type && event.playerId === playerId).length;
  }

  private countRebounds(events: readonly GameEvent[], playerId: string, kind: 'offensive' | 'defensive'): number {
    return events.filter(
      (event) =>
        event.type === 'rebound' &&
        event.playerId === playerId &&
        (event.payload as { kind?: string } | undefined)?.kind === kind,
    ).length;
  }

  /** 依据换人事件推导「当前在场球员」；没有换人记录时退化为「首发在场」。 */
  private computeOnCourt(
    players: readonly { id: string; isStarter: boolean }[],
    events: readonly GameEvent[],
  ): Map<string, boolean> {
    const onCourt = new Map<string, boolean>();
    const starters = new Set(players.filter((player) => player.isStarter).map((player) => player.id));
    const hasStarterInfo = players.some((player) => player.isStarter);
    for (const player of players) onCourt.set(player.id, hasStarterInfo ? starters.has(player.id) : true);

    const voided = this.voidedIds(events);
    for (const event of events) {
      if (event.type !== 'substitution' || voided.has(event.id)) continue;
      const payload = event.payload as { playerInId?: string; playerOutId?: string };
      if (payload.playerInId) onCourt.set(payload.playerInId, true);
      if (payload.playerOutId) onCourt.set(payload.playerOutId, false);
    }
    return onCourt;
  }

  private voidedIds(events: readonly GameEvent[]): Set<string> {
    const voided = new Set<string>();
    for (const event of events) {
      if (event.type === 'void') {
        const target = (event.payload as { targetEventId?: string } | undefined)?.targetEventId;
        if (target) voided.add(target);
      }
    }
    return voided;
  }

  // ------------------------------------------------------------------ 图文直播

  /**
   * 事件流 → 图文直播条目。
   *
   * 计分端与观众端看到的是同一份文案，避免「计分台说三分、手机上说两分」。
   * 每条都带比分快照，因此观众中途进入也能看到完整的比分走势。
   */
  buildFeed(aggregate: MatchAggregate, events: readonly GameEvent[], limit = 200): LiveFeedItem[] {
    const context = this.contextOf(aggregate);
    const voided = this.voidedIds(events);
    const playerById = new Map<string, { name: string; jerseyNumber: string }>();
    for (const team of [aggregate.teams.home, aggregate.teams.away]) {
      for (const player of team.players) {
        playerById.set(player.id, { name: player.name, jerseyNumber: player.jerseyNumber });
      }
    }

    const items: LiveFeedItem[] = [];
    let homeScore = 0;
    let awayScore = 0;

    for (const event of events) {
      if (event.type === 'void') continue;

      const side = event.teamId === context.homeTeam.teamId ? 'home' : event.teamId === context.awayTeam.teamId ? 'away' : null;
      const team = side === 'home' ? aggregate.teams.home : side === 'away' ? aggregate.teams.away : null;

      // 被作废的事件不产生直播条目，但**已经计入的比分要回退**
      if (voided.has(event.id)) {
        if (event.type === 'score') {
          if (side === 'home') homeScore = Math.max(0, homeScore - event.points);
          if (side === 'away') awayScore = Math.max(0, awayScore - event.points);
        }
        continue;
      }

      if (event.type === 'score') {
        if (side === 'home') homeScore += event.points;
        if (side === 'away') awayScore += event.points;
      }

      const player = event.playerId ? playerById.get(event.playerId) : undefined;
      const text = this.describe(event, {
        playerName: player?.name ?? null,
        jerseyNumber: player?.jerseyNumber ?? null,
        teamName: team?.name ?? null,
      });

      items.push({
        id: event.id,
        matchId: event.matchId,
        seq: event.seq,
        clock: formatGameClock(event.gameClockSeconds),
        period: event.period,
        teamId: event.teamId,
        teamSide: side,
        teamName: team?.name ?? null,
        playerId: event.playerId,
        playerName: player?.name ?? null,
        jerseyNumber: player?.jerseyNumber ?? null,
        type: event.type,
        points: event.points,
        text,
        tone: side ?? 'neutral',
        homeScore,
        awayScore,
        createdAt: event.createdAt || event.clientTimestamp,
      });
    }

    // 最新在最前，便于观众端首屏渲染
    return items.slice(-limit).reverse();
  }

  /** 单条事件的中文文案。集中在一处，方便统一口径与本地化。 */
  private describe(
    event: GameEvent,
    meta: { playerName: string | null; jerseyNumber: string | null; teamName: string | null },
  ): string {
    const who = meta.playerName
      ? `${meta.playerName}${meta.jerseyNumber ? `（${meta.jerseyNumber} 号）` : ''}`
      : (meta.teamName ?? '球队');
    const prefix = `第${event.period}节`;
    const clock = event.gameClockSeconds !== null && event.gameClockSeconds !== undefined
      ? ` ${formatGameClock(event.gameClockSeconds)}`
      : '';

    switch (event.type) {
      case 'score': {
        const payload = event.payload as { shotType?: ShotType; fastBreak?: boolean; assistPlayerId?: string | null };
        const shot = payload.shotType === 'three' || event.points === 3
          ? '三分'
          : payload.shotType === 'free_throw' || event.points === 1
            ? '罚球'
            : payload.shotType === 'dunk'
              ? '扣篮'
              : '两分';
        const fast = payload.fastBreak ? '快攻' : '';
        return `${prefix}${clock} ${who} ${fast}命中${shot}，+${event.points}`;
      }
      case 'foul':
        return `${prefix}${clock} ${who} 犯规`;
      case 'team_foul':
        return `${prefix}${clock} ${meta.teamName ?? '球队'} 全队犯规`;
      case 'timeout':
        return `${prefix}${clock} ${meta.teamName ?? '球队'} 请求暂停`;
      case 'substitution': {
        const payload = event.payload as { playerInId?: string; playerOutId?: string };
        return `${prefix}${clock} ${meta.teamName ?? '球队'} 换人（${payload.playerOutId ? '下场' : ''}${payload.playerInId ? ' / 上场' : ''}）`;
      }
      case 'turnover':
        return `${prefix}${clock} ${who} 失误`;
      case 'steal':
        return `${prefix}${clock} ${who} 抢断`;
      case 'block':
        return `${prefix}${clock} ${who} 盖帽`;
      case 'rebound': {
        const kind = (event.payload as { kind?: string } | undefined)?.kind;
        return `${prefix}${clock} ${who} 抢下${kind === 'offensive' ? '前场' : '后场'}篮板`;
      }
      case 'period_end':
        return `${prefix}比赛结束，比分 ${(event.payload as { homeScore?: number }).homeScore ?? 0} : ${(event.payload as { awayScore?: number }).awayScore ?? 0}`;
      case 'game_start':
        // game_start 事件本身不带 teamId（跳球不属于任何一方），
        // 因此文案里回落到「比赛开始」，不要把空字符串拼进句子里。
        return meta.teamName ? `比赛开始，${meta.teamName} 跳球` : '比赛开始，双方跳球';
      case 'game_end':
        return '全场比赛结束';
      default:
        return `${prefix}${clock} ${event.type}`;
    }
  }

  /** 比分时间线（观众端走势图）。 */
  buildTimeline(feed: readonly LiveFeedItem[]): ScoreTimelinePoint[] {
    return [...feed]
      .reverse()
      .map((item) => ({
        seq: item.seq,
        period: item.period,
        homeScore: item.homeScore,
        awayScore: item.awayScore,
        label: item.text,
      }));
  }

  /**
   * 撤销栈：按「最近发生的在前」排序的可撤销操作。
   *
   * 撤销的对象是**事件**而不是「动作」，因此：
   *   - 撤销可以被审计（谁在什么时候撤销了什么）；
   *   - 撤销之后剩下的历史事件顺序不变，比分自然回退。
   */
  buildUndoStack(aggregate: MatchAggregate, events: readonly GameEvent[], limit = 10): UndoableAction[] {
    const context = this.contextOf(aggregate);
    const voided = this.voidedIds(events);
    const playerById = new Map<string, string>();
    for (const team of [aggregate.teams.home, aggregate.teams.away]) {
      for (const player of team.players) playerById.set(player.id, player.name);
    }

    return [...events]
      .filter((event) => UNDOABLE_EVENT_TYPES.includes(event.type) && !voided.has(event.id))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map((event) => ({
        eventId: event.id,
        seq: event.seq,
        type: event.type,
        description: this.describeUndo(event, context, playerById),
        createdAt: event.createdAt || event.clientTimestamp,
      }));
  }

  private describeUndo(
    event: GameEvent,
    context: ReturnType<MatchEngine['contextOf']>,
    playerById: Map<string, string>,
  ): string {
    const side = event.teamId === context.homeTeam.teamId ? '主队' : event.teamId === context.awayTeam.teamId ? '客队' : '';
    const playerName = event.playerId ? playerById.get(event.playerId) : undefined;
    const who = playerName ? `${playerName}（${side}）` : side;
    switch (event.type) {
      case 'score':
        return `撤销 ${who} 的 ${event.points} 分（第${event.period}节）`;
      case 'foul':
        return `撤销 ${who} 的犯规`;
      case 'team_foul':
        return `撤销 ${side} 全队犯规`;
      case 'timeout':
        return `撤销 ${side} 暂停`;
      case 'substitution':
        return `撤销 ${side} 换人`;
      case 'turnover':
        return `撤销 ${who} 失误`;
      case 'steal':
        return `撤销 ${who} 抢断`;
      case 'block':
        return `撤销 ${who} 盖帽`;
      case 'rebound':
        return `撤销 ${who} 篮板`;
      default:
        return `撤销 ${event.type}`;
    }
  }

  /** 给撤销操作生成一条 void 事件草稿。 */
  buildVoidDraft(
    aggregate: MatchAggregate,
    target: GameEvent,
    clientId: string,
    reason?: string,
  ): {
    id: string;
    matchId: string;
    type: 'void';
    teamId: string | null;
    playerId: null;
    points: 0;
    period: number;
    gameClockSeconds: number | null;
    clientTimestamp: string;
    clientId: string;
    clientEventId: string;
    payload: { targetEventId: string; reason?: string };
  } {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      matchId: aggregate.match.id,
      type: 'void',
      teamId: target.teamId,
      playerId: null,
      points: 0,
      period: target.period,
      gameClockSeconds: target.gameClockSeconds,
      clientTimestamp: now,
      clientId: `${clientId}:undo`,
      clientEventId: randomUUID(),
      payload: reason ? { targetEventId: target.id, reason } : { targetEventId: target.id },
    };
  }

  /** 观众端「球员高亮」判定：得分里程碑、犯满离场。 */
  detectHighlights(aggregate: MatchAggregate, state: MatchState, previous?: MatchState) {
    const highlights: Array<{
      playerId: string;
      teamId: string;
      teamSide: 'home' | 'away';
      milestone: 'double_double' | 'twenty_points' | 'fouled_out' | 'three_point_streak';
      text: string;
    }> = [];
    const teams: Array<[TeamState, 'home' | 'away']> = [
      [state.home, 'home'],
      [state.away, 'away'],
    ];
    for (const [team, side] of teams) {
      for (const player of team.players) {
        const before = previous
          ? (side === 'home' ? previous.home : previous.away).players.find((item) => item.playerId === player.playerId)
          : undefined;
        const reachedTwenty = player.points >= 20 && (!before || before.points < 20);
        if (reachedTwenty) {
          highlights.push({
            playerId: player.playerId,
            teamId: team.teamId,
            teamSide: side,
            milestone: 'twenty_points',
            text: `${player.name} 砍下 20 分！`,
          });
        }
        const fouledOut = player.fouls >= DEFAULT_TEAM_FOUL_LIMIT && (!before || before.fouls < DEFAULT_TEAM_FOUL_LIMIT);
        if (fouledOut) {
          highlights.push({
            playerId: player.playerId,
            teamId: team.teamId,
            teamSide: side,
            milestone: 'fouled_out',
            text: `${player.name} 五次犯规离场`,
          });
        }
      }
    }
    return highlights;
  }

  /** 统计辅助：把 MatchState 转成排行榜条目。 */
  buildLeaderboard(
    aggregate: MatchAggregate,
    state: MatchState,
    sortedBy: 'points' | 'fouls' | 'threePointersMade' = 'points',
  ) {
    const entries = [
      ...state.home.players.map((player) => ({ player, teamSide: 'home' as const, teamName: state.home.name })),
      ...state.away.players.map((player) => ({ player, teamSide: 'away' as const, teamName: state.away.name })),
    ]
      .map(({ player, teamSide, teamName }) => ({
        playerId: player.playerId,
        teamId: player.teamId,
        teamSide,
        teamName,
        name: player.name,
        jerseyNumber: player.jerseyNumber,
        points: player.points,
        fouls: player.fouls,
        threePointersMade: player.threePointersMade,
        rank: 0,
      }))
      .sort((a, b) => {
        if (sortedBy === 'fouls') return b.fouls - a.fouls || b.points - a.points;
        if (sortedBy === 'threePointersMade') return b.threePointersMade - a.threePointersMade || b.points - a.points;
        return b.points - a.points || b.threePointersMade - a.threePointersMade;
      });

    let rank = 0;
    let previousValue: number | null = null;
    entries.forEach((entry, index) => {
      const value = entry[sortedBy];
      if (previousValue === null || value !== previousValue) {
        rank = index + 1;
        previousValue = value;
      }
      entry.rank = rank;
    });

    return { matchId: aggregate.match.id, entries, sortedBy };
  }

  /** 比分字符串，列表页与分享卡片用。 */
  scoreText(state: MatchState): string {
    return `${state.scoreboard.home.score} : ${state.scoreboard.away.score}`;
  }

  /** 竞赛规则提示：本节犯规是否已进入罚球状态（FIBA：第 5 次起）。 */
  penaltyStatus(state: MatchState, period: number) {
    return {
      home: (state.home.teamFoulsByPeriod[period] ?? 0) >= DEFAULT_TEAM_FOUL_LIMIT,
      away: (state.away.teamFoulsByPeriod[period] ?? 0) >= DEFAULT_TEAM_FOUL_LIMIT,
    };
  }

  scoreboardOf(state: MatchState): Scoreboard {
    return state.scoreboard;
  }
}
