import { randomUUID } from 'node:crypto';
import type { GameEvent, GameEventDraft, Match, Player, Season, Team } from '@openhoopscore/contracts';
import type {
  AppendEventsOutcome,
  AppendEventsRequest,
  CreateMatchRecord,
  CreateSeasonRecord,
  MatchAggregate,
  PlayerDraftRecord,
  StoredSeason,
  StorePort,
  SyncBatchRecord,
  VoidEventsOutcome,
  VoidEventsRequest,
} from './store.port';
import { AssignmentPlanner } from './assignment-planner';

const DEFAULT_COLORS = ['#E4572E', '#2563EB', '#16A34A', '#9333EA', '#0891B2', '#DB2777'];

/**
 * 内存驱动：单元测试与 e2e 用，进程退出即清空。
 *
 * 它同时是「事件写入算法」的参考实现 ——
 * JSON 驱动与 Prisma 驱动都遵循同一套幂等 + 重排 + 序号分配规则：
 *   1. 幂等：已存在的 clientEventId 直接判为 duplicate（不重复计分）；
 *   2. 排序：把所有事件按 clientTimestamp → clientId → clientEventId 排成一条时间线；
 *   3. 序号：按时间线重新分配连续 seq，因此离线补传的旧事件会「插入」到历史中间；
 *   4. 重排：一批补传事件里只要有不满足 seq 单调的，就把 reordered 标记为 true，
 *      客户端据此重新拉取直播流。
 */
export class MemoryStore implements StorePort {
  readonly driver = 'memory' as const;

  private seasons = new Map<string, Season>();
  private matches = new Map<string, Match>();
  private teams = new Map<string, Team>();
  private players = new Map<string, Player>();
  private events = new Map<string, GameEvent[]>();
  private syncBatches: SyncBatchRecord[] = [];

  private readonly planner = new AssignmentPlanner();

  async init(): Promise<void> {
    /* 内存驱动无需初始化 */
  }

  async dispose(): Promise<void> {
    this.seasons.clear();
    this.matches.clear();
    this.teams.clear();
    this.players.clear();
    this.events.clear();
    this.syncBatches = [];
  }

  // ------------------------------------------------------------------ 赛季

  async createSeason(input: CreateSeasonRecord): Promise<Season> {
    const season: Season = {
      id: randomUUID(),
      name: input.name,
      organizer: input.organizer,
      startDate: input.startDate,
      endDate: input.endDate,
      createdAt: new Date().toISOString(),
    };
    this.seasons.set(season.id, season);
    return season;
  }

  async listSeasons(): Promise<StoredSeason[]> {
    return [...this.seasons.values()]
      .map((season) => ({
        ...season,
        matchCount: [...this.matches.values()].filter((m) => m.seasonId === season.id).length,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async findSeasonById(id: string): Promise<Season | null> {
    return this.seasons.get(id) ?? null;
  }

  // ------------------------------------------------------------------ 比赛

  async createMatch(input: CreateMatchRecord): Promise<MatchAggregate> {
    const now = new Date().toISOString();
    const matchId = randomUUID();

    const buildTeam = (side: 'home' | 'away', index: number): Team => {
      const source = side === 'home' ? input.home : input.away;
      const team: Team = {
        id: randomUUID(),
        matchId,
        side,
        name: source.name,
        shortName: source.shortName,
        color: source.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length]!,
        players: [],
      };
      team.players = source.players.map((player) => this.buildPlayer(team.id, player));
      for (const player of team.players) this.players.set(player.id, player);
      this.teams.set(team.id, team);
      return team;
    };

    const home = buildTeam('home', 0);
    const away = buildTeam('away', 1);

    const match: Match = {
      id: matchId,
      seasonId: input.seasonId,
      competition: input.competition,
      title: input.title,
      venue: input.venue,
      scheduledAt: input.scheduledAt,
      status: 'scheduled',
      periodFormat: input.periodFormat,
      periodSeconds: input.periodSeconds,
      regulationPeriods: input.regulationPeriods,
      shareCode: input.shareCode,
      homeTeamId: home.id,
      awayTeamId: away.id,
      createdAt: now,
      updatedAt: now,
    };
    this.matches.set(matchId, match);
    this.events.set(matchId, []);
    return { match, teams: { home, away } };
  }

  private buildPlayer(teamId: string, input: PlayerDraftRecord): Player {
    return {
      id: randomUUID(),
      teamId,
      jerseyNumber: input.jerseyNumber,
      name: input.name,
      isStarter: input.isStarter,
      createdAt: new Date().toISOString(),
    };
  }

  async listMatches(filter: { seasonId?: string; status?: Match['status']; limit?: number } = {}): Promise<MatchAggregate[]> {
    const all = [...this.matches.values()]
      .filter((match) => (filter.seasonId ? match.seasonId === filter.seasonId : true))
      .filter((match) => (filter.status ? match.status === filter.status : true))
      .sort((a, b) => {
        const aKey = a.scheduledAt ?? a.createdAt;
        const bKey = b.scheduledAt ?? b.createdAt;
        return aKey < bKey ? 1 : -1;
      })
      .slice(0, filter.limit ?? 100);
    return all.map((match) => this.aggregate(match));
  }

  async findMatchById(id: string): Promise<MatchAggregate | null> {
    const match = this.matches.get(id);
    return match ? this.aggregate(match) : null;
  }

  async findMatchByShareCode(code: string): Promise<MatchAggregate | null> {
    const match = [...this.matches.values()].find((m) => m.shareCode.toUpperCase() === code.toUpperCase());
    return match ? this.aggregate(match) : null;
  }

  async updateMatch(id: string, patch: Partial<Match>): Promise<MatchAggregate | null> {
    const match = this.matches.get(id);
    if (!match) return null;
    const updated: Match = { ...match, ...patch, id: match.id, updatedAt: new Date().toISOString() };
    this.matches.set(id, updated);
    return this.aggregate(updated);
  }

  async addPlayer(matchId: string, side: 'home' | 'away', input: PlayerDraftRecord): Promise<Player | null> {
    const match = this.matches.get(matchId);
    if (!match) return null;
    const team = this.aggregate(match).teams[side];
    if (team.players.some((p) => p.jerseyNumber === input.jerseyNumber)) {
      throw new Error(`球衣号码 ${input.jerseyNumber} 在该队已存在`);
    }
    const player = this.buildPlayer(team.id, input);
    this.players.set(player.id, player);
    team.players.push(player);
    return player;
  }

  async deletePlayer(matchId: string, playerId: string): Promise<boolean> {
    const match = this.matches.get(matchId);
    if (!match) return false;
    const aggregate = this.aggregate(match);
    for (const team of [aggregate.teams.home, aggregate.teams.away]) {
      const index = team.players.findIndex((p) => p.id === playerId);
      if (index >= 0) {
        team.players.splice(index, 1);
        this.players.delete(playerId);
        return true;
      }
    }
    return false;
  }

  private aggregate(match: Match): MatchAggregate {
    const home = this.teams.get(match.homeTeamId)!;
    const away = this.teams.get(match.awayTeamId)!;
    return { match, teams: { home, away } };
  }

  // ------------------------------------------------------------------ 事件

  async listEvents(matchId: string, options: { sinceSeq?: number; limit?: number } = {}): Promise<GameEvent[]> {
    const all = (this.events.get(matchId) ?? []).filter((event) => event.seq > (options.sinceSeq ?? 0));
    return options.limit ? all.slice(0, options.limit) : all;
  }

  async countEvents(matchId: string): Promise<number> {
    return (this.events.get(matchId) ?? []).length;
  }

  async appendEvents(request: AppendEventsRequest): Promise<AppendEventsOutcome> {
    const existing = this.events.get(request.matchId) ?? [];
    const plan = this.planner.plan({
      existing,
      incoming: request.events,
      matchId: request.matchId,
      roster: request.roster,
      maxEventsPerMatch: request.maxEventsPerMatch,
      now: new Date(),
      newId: () => randomUUID(),
    });

    this.events.set(request.matchId, plan.events);

    const match = this.matches.get(request.matchId);
    if (match && plan.accepted.length > 0 && match.status === 'scheduled') {
      this.matches.set(request.matchId, { ...match, status: 'live', updatedAt: new Date().toISOString() });
    } else if (match && plan.accepted.length > 0) {
      this.matches.set(request.matchId, { ...match, updatedAt: new Date().toISOString() });
    }

    return {
      events: plan.events,
      accepted: plan.accepted,
      duplicates: plan.duplicates,
      rejected: plan.rejected,
      reordered: plan.reordered,
      finalSeq: plan.finalSeq,
    };
  }

  async voidEvents(request: VoidEventsRequest): Promise<VoidEventsOutcome> {
    const existing = this.events.get(request.matchId) ?? [];
    const plan = this.planner.plan({
      existing,
      incoming: [request.voidDraft],
      matchId: request.matchId,
      roster: request.roster,
      maxEventsPerMatch: Number.MAX_SAFE_INTEGER,
      now: new Date(),
      newId: () => randomUUID(),
    });

    const voidEvent = plan.createdEvents[0];
    const targetIds = new Set(request.targetEventIds);
    const marked = plan.events.map((event) =>
      targetIds.has(event.id) && voidEvent ? { ...event, voidedByEventId: voidEvent.id } : event,
    );

    this.events.set(request.matchId, marked);

    const match = this.matches.get(request.matchId);
    if (match) this.matches.set(request.matchId, { ...match, updatedAt: new Date().toISOString() });

    return {
      voidedEventIds: request.targetEventIds,
      voidEvents: voidEvent ? [voidEvent] : [],
      finalSeq: plan.finalSeq,
    };
  }

  async recordSyncBatch(record: SyncBatchRecord): Promise<void> {
    this.syncBatches.push(record);
  }

  async findExistingClientEventIds(matchId: string, clientEventIds: string[]): Promise<string[]> {
    const wanted = new Set(clientEventIds);
    return (this.events.get(matchId) ?? [])
      .filter((event) => wanted.has(event.clientEventId))
      .map((event) => event.clientEventId);
  }

  async purgeArchived(before: Date): Promise<number> {
    let removed = 0;
    for (const [matchId, match] of this.matches) {
      if (match.status !== 'archived') continue;
      if (new Date(match.updatedAt) >= before) continue;
      removed += (this.events.get(matchId) ?? []).length;
      this.events.set(matchId, []);
    }
    return removed;
  }

  /** 仅供测试：注入一批历史事件。 */
  async seedEvents(matchId: string, events: GameEvent[]): Promise<void> {
    this.events.set(matchId, events);
  }
}
