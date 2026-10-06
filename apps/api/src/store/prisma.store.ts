import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { GameEvent, GameEventDraft, Match, Player, Season, Team } from '@openhoopscore/contracts';
import { normalizeClientTimestamp, resolveEventPoints } from '@openhoopscore/contracts';
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
import { compareBySortKey, validateDraft } from './assignment-planner';

/**
 * Prisma Client 的结构化类型别名。
 *
 * 这里刻意**不**从 '@prisma/client' import 类型：那样会在 `prisma generate`
 * 之前就让整个项目编译失败（选 json 驱动的用户根本不需要生成 Client）。
 * 真正的 Client 在 init() 里按需 require，类型层面只约束我们会用到的委托方法。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaClient {
  season: any;
  match: any;
  team: any;
  player: any;
  gameEvent: any;
  syncBatch: any;
  $transaction: any;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRaw: any;
}

/**
 * ============================================================================
 * PostgreSQL + Prisma 驱动（生产推荐）
 * ============================================================================
 * 与 JSON 驱动共享同一套写入语义，但把「权威序号 seq」做成**排名**而不是自增：
 *
 *     seq(E) = 1 + COUNT(同一场比赛里排序键小于 E 的事件)
 *     排序键 = (client_timestamp, client_id, client_event_id)
 *
 * 为什么必须这样：离线补传时旧事件会插到时间线中间。如果 seq 是自增的，
 * 每次插入都要 UPDATE 后续所有行 —— 既会撞 `(match_id, seq)` 唯一约束，
 * 又会把已经发给观众端的增量游标全部作废。用排名则「插入一个空位」，
 * 已有行的 seq 一个字节都不用改，代价只是 seq 允许出现空洞。
 *
 * 幂等由数据库唯一约束 `(match_id, client_event_id)` 兜底：
 * 即使两个计分端同时补传同一条事件，也只有一个能插入成功。
 */
export class PrismaStore implements StorePort {
  readonly driver = 'prisma' as const;

  private readonly logger = new Logger(PrismaStore.name);
  private prisma!: PrismaClient;

  async init(): Promise<void> {
    // 延迟 require：这样选 json 驱动时完全不需要生成 Prisma Client。
    let PrismaClientCtor: new (options?: unknown) => PrismaClient;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@prisma/client') as { PrismaClient: new (options?: unknown) => PrismaClient };
      PrismaClientCtor = mod.PrismaClient;
    } catch (error) {
      throw new Error(
        '无法加载 @prisma/client。请先执行：pnpm --filter @openhoopscore/api db:generate ' +
          `（原始错误：${(error as Error).message}）`,
      );
    }
    this.prisma = new PrismaClientCtor({ log: [{ emit: 'event', level: 'warn' }] });
    await this.prisma.$connect();
    await this.prisma.$queryRaw`SELECT 1`;
    this.logger.log('已连接 PostgreSQL');
  }

  async dispose(): Promise<void> {
    await this.prisma?.$disconnect();
  }

  // ------------------------------------------------------------------ 映射

  private toSeason(row: {
    id: string;
    name: string;
    organizer: string | null;
    startDate: Date | null;
    endDate: Date | null;
    createdAt: Date;
  }): Season {
    return {
      id: row.id,
      name: row.name,
      organizer: row.organizer,
      startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
      endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toMatch(row: {
    id: string;
    seasonId: string | null;
    competition: string;
    title: string;
    venue: string | null;
    scheduledAt: Date | null;
    status: string;
    periodFormat: string;
    periodSeconds: number;
    regulationPeriods: number;
    shareCode: string;
    homeTeamId: string;
    awayTeamId: string;
    createdAt: Date;
    updatedAt: Date;
  }): Match {
    return {
      id: row.id,
      seasonId: row.seasonId,
      competition: row.competition,
      title: row.title,
      venue: row.venue,
      scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
      status: row.status as Match['status'],
      periodFormat: row.periodFormat as Match['periodFormat'],
      periodSeconds: row.periodSeconds,
      regulationPeriods: row.regulationPeriods,
      shareCode: row.shareCode,
      homeTeamId: row.homeTeamId,
      awayTeamId: row.awayTeamId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toEvent(row: {
    id: string;
    matchId: string;
    eventType: string;
    teamId: string | null;
    playerId: string | null;
    points: number;
    period: number;
    gameClockSeconds: number | null;
    clientTimestamp: Date;
    clientId: string;
    clientEventId: string;
    seq: number;
    voidedByEventId: string | null;
    payload: unknown;
    createdAt: Date;
  }): GameEvent {
    return {
      id: row.id,
      matchId: row.matchId,
      type: row.eventType as GameEvent['type'],
      teamId: row.teamId,
      playerId: row.playerId,
      points: row.points,
      period: row.period,
      gameClockSeconds: row.gameClockSeconds,
      clientTimestamp: row.clientTimestamp.toISOString(),
      clientId: row.clientId,
      clientEventId: row.clientEventId,
      seq: row.seq,
      createdAt: row.createdAt.toISOString(),
      voidedByEventId: row.voidedByEventId,
      payload: (row.payload ?? {}) as GameEvent['payload'],
    };
  }

  private async aggregateOf(matchId: string): Promise<MatchAggregate | null> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { teams: { include: { players: { orderBy: { jerseyNumber: 'asc' } } } } },
    });
    if (!match) return null;
    const home = match.teams.find((team: { id: string }) => team.id === match.homeTeamId);
    const away = match.teams.find((team: { id: string }) => team.id === match.awayTeamId);
    if (!home || !away) throw new Error(`比赛 ${matchId} 的队伍数据缺失`);
    const toTeam = (team: typeof home): Team => ({
      id: team.id,
      matchId: team.matchId,
      side: team.side as Team['side'],
      name: team.name,
      shortName: team.shortName,
      color: team.color,
      players: team.players.map(
        (player: {
          id: string;
          teamId: string;
          jerseyNumber: string;
          name: string;
          isStarter: boolean;
          createdAt: Date;
        }): Player => ({
          id: player.id,
          teamId: player.teamId,
          jerseyNumber: player.jerseyNumber,
          name: player.name,
          isStarter: player.isStarter,
          createdAt: player.createdAt.toISOString(),
        }),
      ),
    });
    return { match: this.toMatch(match), teams: { home: toTeam(home), away: toTeam(away) } };
  }

  // ------------------------------------------------------------------ 赛季

  async createSeason(input: CreateSeasonRecord): Promise<Season> {
    const row = await this.prisma.season.create({
      data: {
        name: input.name,
        organizer: input.organizer,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      },
    });
    return this.toSeason(row);
  }

  async listSeasons(): Promise<StoredSeason[]> {
    const rows = await this.prisma.season.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { matches: true } } },
    });
    return rows.map((row: { _count: { matches: number } } & Parameters<PrismaStore['toSeason']>[0]) => ({
      ...this.toSeason(row),
      matchCount: row._count.matches,
    }));
  }

  async findSeasonById(id: string): Promise<Season | null> {
    const row = await this.prisma.season.findUnique({ where: { id } });
    return row ? this.toSeason(row) : null;
  }

  // ------------------------------------------------------------------ 比赛

  async createMatch(input: CreateMatchRecord): Promise<MatchAggregate> {
    // 先建比赛（外键列暂填占位 UUID，Prisma 不校验外键值），
    // 再在同一个事务里建两支队伍并回填外键，最后补上球员名单。
    // 这样既保持 Team.matchId 必填，也不会真的出现「悬空外键」的持久状态。
    const matchId = await this.prisma.$transaction(async (tx: PrismaClient) => {
      const created = await tx.match.create({
        data: {
          seasonId: input.seasonId,
          competition: input.competition,
          title: input.title,
          venue: input.venue,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          status: 'scheduled',
          periodFormat: input.periodFormat,
          periodSeconds: input.periodSeconds,
          regulationPeriods: input.regulationPeriods,
          shareCode: input.shareCode,
          homeTeamId: randomUUID(),
          awayTeamId: randomUUID(),
        },
      });

      const homeTeam = await tx.team.create({
        data: {
          matchId: created.id,
          side: 'home',
          name: input.home.name,
          shortName: input.home.shortName,
          color: input.home.color,
          players: { create: input.home.players.map((player) => ({ ...player })) },
        },
      });
      const awayTeam = await tx.team.create({
        data: {
          matchId: created.id,
          side: 'away',
          name: input.away.name,
          shortName: input.away.shortName,
          color: input.away.color,
          players: { create: input.away.players.map((player) => ({ ...player })) },
        },
      });

      await tx.match.update({
        where: { id: created.id },
        data: { homeTeamId: homeTeam.id, awayTeamId: awayTeam.id },
      });

      return created.id;
    });

    const aggregate = await this.aggregateOf(matchId);
    if (!aggregate) throw new Error('比赛创建后无法读取');
    return aggregate;
  }

  async listMatches(filter: { seasonId?: string; status?: Match['status']; limit?: number } = {}): Promise<MatchAggregate[]> {
    const rows = await this.prisma.match.findMany({
      where: {
        ...(filter.seasonId ? { seasonId: filter.seasonId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
      take: filter.limit ?? 100,
      select: { id: true },
    });
    const aggregates = await Promise.all(rows.map((row: { id: string }) => this.aggregateOf(row.id)));
    return aggregates.filter((item: MatchAggregate | null): item is MatchAggregate => item !== null);
  }

  async findMatchById(id: string): Promise<MatchAggregate | null> {
    return this.aggregateOf(id);
  }

  async findMatchByShareCode(code: string): Promise<MatchAggregate | null> {
    const row = await this.prisma.match.findUnique({ where: { shareCode: code.toUpperCase() }, select: { id: true } });
    return row ? this.aggregateOf(row.id) : null;
  }

  async updateMatch(id: string, patch: Partial<Match>): Promise<MatchAggregate | null> {
    const data: Record<string, unknown> = {};
    if (patch.competition !== undefined) data.competition = patch.competition;
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.venue !== undefined) data.venue = patch.venue;
    if (patch.scheduledAt !== undefined) data.scheduledAt = patch.scheduledAt ? new Date(patch.scheduledAt) : null;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.periodSeconds !== undefined) data.periodSeconds = patch.periodSeconds;
    if (patch.regulationPeriods !== undefined) data.regulationPeriods = patch.regulationPeriods;

    await this.prisma.match.update({ where: { id }, data });
    return this.aggregateOf(id);
  }

  async addPlayer(matchId: string, side: 'home' | 'away', input: PlayerDraftRecord): Promise<Player | null> {
    const aggregate = await this.aggregateOf(matchId);
    if (!aggregate) return null;
    const team = aggregate.teams[side];
    const row = await this.prisma.player.create({
      data: { teamId: team.id, jerseyNumber: input.jerseyNumber, name: input.name, isStarter: input.isStarter },
    });
    return {
      id: row.id,
      teamId: row.teamId,
      jerseyNumber: row.jerseyNumber,
      name: row.name,
      isStarter: row.isStarter,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async deletePlayer(matchId: string, playerId: string): Promise<boolean> {
    const aggregate = await this.aggregateOf(matchId);
    if (!aggregate) return false;
    const belongs = [aggregate.teams.home, aggregate.teams.away].some((team) =>
      team.players.some((player) => player.id === playerId),
    );
    if (!belongs) return false;
    await this.prisma.player.delete({ where: { id: playerId } });
    return true;
  }

  // ------------------------------------------------------------------ 事件

  async listEvents(matchId: string, options: { sinceSeq?: number; limit?: number } = {}): Promise<GameEvent[]> {
    const rows = await this.prisma.gameEvent.findMany({
      where: { matchId, seq: { gt: options.sinceSeq ?? 0 } },
      orderBy: { seq: 'asc' },
      ...(options.limit ? { take: options.limit } : {}),
    });
    return rows.map((row: Parameters<PrismaStore['toEvent']>[0]) => this.toEvent(row));
  }

  async countEvents(matchId: string): Promise<number> {
    return this.prisma.gameEvent.count({ where: { matchId } });
  }

  /**
   * 追加事件。
   *
   * 事务内流程（与 JSON 驱动结果一致）：
   *   1. 查出已存在的 clientEventId → 判重；
   *   2. 校验事件合法性（球队/球员归属、得分值、节次）；
   *   3. 用 COUNT 算出每条事件的排名 seq（不触碰已有行）；
   *   4. 批量插入，并把 `reordered` 标记为「新事件 seq 落在原有最大 seq 之前」。
   */
  async appendEvents(request: AppendEventsRequest): Promise<AppendEventsOutcome> {
    const now = new Date();

    return this.prisma.$transaction(async (tx: PrismaClient) => {
      const existingRows = await tx.gameEvent.findMany({
        where: { matchId: request.matchId },
        select: { id: true, clientEventId: true, seq: true },
      });
      const existingByClientId = new Map<string, { id: string; seq: number }>(
        existingRows.map((row: { id: string; clientEventId: string; seq: number }) => [
          row.clientEventId,
          { id: row.id, seq: row.seq },
        ]),
      );
      const previousMaxSeq = existingRows.reduce((max: number, row: { seq: number }) => Math.max(max, row.seq), 0);
      const totalExisting = existingRows.length;

      const accepted: AppendEventsOutcome['accepted'] = [];
      const duplicates: AppendEventsOutcome['duplicates'] = [];
      const rejected: AppendEventsOutcome['rejected'] = [];
      const createdEvents: GameEvent[] = [];
      const seen = new Set<string>();

      for (const draft of request.events) {
        const duplicate = existingByClientId.get(draft.clientEventId);
        if (duplicate) {
          duplicates.push({ clientEventId: draft.clientEventId, eventId: duplicate.id, seq: duplicate.seq });
          continue;
        }
        if (seen.has(draft.clientEventId)) {
          rejected.push({ clientEventId: draft.clientEventId, reason: '同一批次内出现重复的 clientEventId' });
          continue;
        }
        seen.add(draft.clientEventId);

        const validationError = validateDraft(draft, request.roster);
        if (validationError) {
          rejected.push({ clientEventId: draft.clientEventId, reason: validationError });
          continue;
        }
        if (totalExisting + createdEvents.length >= request.maxEventsPerMatch) {
          rejected.push({
            clientEventId: draft.clientEventId,
            reason: `单场比赛事件数已达上限 ${request.maxEventsPerMatch}`,
          });
          continue;
        }

        const clientTimestamp = normalizeClientTimestamp(draft.clientTimestamp, now);
        const clientId = draft.clientId;
        // 排名 = 1 + 排序键更小的事件数（严格小于，排序键包含 clientEventId，天然不重复）
        const smaller = await tx.gameEvent.count({
          where: {
            matchId: request.matchId,
            OR: [
              { clientTimestamp: { lt: new Date(clientTimestamp) } },
              { clientTimestamp: new Date(clientTimestamp), clientId: { lt: clientId } },
              {
                clientTimestamp: new Date(clientTimestamp),
                clientId,
                clientEventId: { lt: draft.clientEventId },
              },
            ],
          },
        });

        const points = draft.type === 'score' ? resolveEventPoints('score', draft.payload) : 0;
        const created = await tx.gameEvent.create({
          data: {
            matchId: request.matchId,
            eventType: draft.type,
            teamId: draft.teamId ?? null,
            playerId: draft.playerId ?? null,
            points,
            period: Number.isFinite(draft.period) && draft.period >= 1 ? Math.floor(draft.period) : 1,
            gameClockSeconds:
              draft.gameClockSeconds === null || draft.gameClockSeconds === undefined
                ? null
                : Math.max(0, Math.floor(draft.gameClockSeconds)),
            clientTimestamp: new Date(clientTimestamp),
            clientId,
            clientEventId: draft.clientEventId,
            seq: smaller + 1,
            payload: (draft.payload ?? {}) as object,
          },
        });

        const event = this.toEvent(created);
        createdEvents.push(event);
        accepted.push({ clientEventId: draft.clientEventId, eventId: event.id, seq: event.seq });
      }

      // 比赛状态推进（scheduled → live）
      if (accepted.length > 0) {
        const match = await tx.match.findUnique({ where: { id: request.matchId }, select: { status: true } });
        if (match && match.status === 'scheduled') {
          await tx.match.update({ where: { id: request.matchId }, data: { status: 'live' } });
        }
      }

      createdEvents.sort(compareBySortKey);
      const reordered =
        previousMaxSeq > 0 && createdEvents.some((event) => event.seq <= previousMaxSeq) && createdEvents.length > 0;

      return {
        events: createdEvents,
        accepted,
        duplicates,
        rejected,
        reordered,
        finalSeq: Math.max(previousMaxSeq, ...createdEvents.map((event) => event.seq), 0),
      } satisfies AppendEventsOutcome;
    });
  }

  async voidEvents(request: VoidEventsRequest): Promise<VoidEventsOutcome> {
    const appended = await this.appendEvents({
      matchId: request.matchId,
      clientId: request.voidDraft.clientId,
      events: [request.voidDraft],
      roster: request.roster,
      maxEventsPerMatch: Number.MAX_SAFE_INTEGER,
    });

    const voidEvent = appended.events[0];
    if (voidEvent) {
      await this.prisma.gameEvent.updateMany({
        where: { id: { in: request.targetEventIds }, matchId: request.matchId },
        data: { voidedByEventId: voidEvent.id },
      });
    }

    return {
      voidedEventIds: request.targetEventIds,
      voidEvents: voidEvent ? [voidEvent] : [],
      finalSeq: appended.finalSeq,
    };
  }

  async recordSyncBatch(record: SyncBatchRecord): Promise<void> {
    await this.prisma.syncBatch.create({
      data: {
        matchId: record.matchId,
        clientId: record.clientId,
        eventCount: record.eventCount,
        acceptedCount: record.acceptedCount,
        duplicateCount: record.duplicateCount,
        rejectedCount: record.rejectedCount,
        sinceSeq: record.sinceSeq,
        finalSeq: record.finalSeq,
        offlineSeconds: record.offlineSeconds,
      },
    });
  }

  async findExistingClientEventIds(matchId: string, clientEventIds: string[]): Promise<string[]> {
    if (clientEventIds.length === 0) return [];
    const rows = await this.prisma.gameEvent.findMany({
      where: { matchId, clientEventId: { in: clientEventIds } },
      select: { clientEventId: true },
    });
    return rows.map((row: { clientEventId: string }) => row.clientEventId);
  }

  async purgeArchived(before: Date): Promise<number> {
    const result = await this.prisma.gameEvent.deleteMany({
      where: { match: { status: 'archived', updatedAt: { lt: before } } },
    });
    return result.count;
  }
}
