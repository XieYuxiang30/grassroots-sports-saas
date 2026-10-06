import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { GameEvent, Match, Player, Season, Team } from '@openhoopscore/contracts';
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

/**
 * ============================================================================
 * JSON 文件驱动 —— 「零基础设施」开箱即用
 * ============================================================================
 * 基层赛事的现实是：很多场地只有一个便宜的学生机，运维不想为了一场比赛装 PostgreSQL。
 * 因此默认驱动就是它：`data/hoop-store.json` 一个文件装下全部数据，启动即用。
 *
 * 正确性与可靠性措施：
 *   1. **原子写**：先写 `*.tmp` 再 `rename` 覆盖，断电不会留下半个 JSON；
 *   2. **写串行化**：所有变更经过一条 Promise 队列（mutex），
 *      并发请求不会互相覆盖（Node 单线程 + await 交错时这是真实风险）；
 *   3. **写合并**：同一批突发请求只落盘一次（schedulePersist 去抖 + flush）；
 *   4. 复用 AssignmentPlanner，事件写入语义与 PostgreSQL 驱动完全一致。
 *
 * 容量边界（README 里明确写了）：适合单场几百到几千条事件、几十场比赛的规模。
 * 更大的量请切到 `STORAGE_DRIVER=prisma`。
 */

interface DatabaseShape {
  schemaVersion: number;
  seasons: Season[];
  matches: Match[];
  teams: Team[];
  players: Player[];
  /** matchId → 事件数组（按 seq 升序）。 */
  events: Record<string, GameEvent[]>;
  syncBatches: SyncBatchRecord[];
  updatedAt: string;
}

const SCHEMA_VERSION = 1;

function emptyDatabase(): DatabaseShape {
  return {
    schemaVersion: SCHEMA_VERSION,
    seasons: [],
    matches: [],
    teams: [],
    players: [],
    events: {},
    syncBatches: [],
    updatedAt: new Date().toISOString(),
  };
}

export class JsonFileStore implements StorePort {
  readonly driver = 'json' as const;

  private db: DatabaseShape = emptyDatabase();
  private loaded = false;
  /** 变更队列：保证「读-改-写」整体串行。 */
  private queue: Promise<unknown> = Promise.resolve();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;
  private dirty = false;

  private readonly planner = new AssignmentPlanner();
  private readonly filePath: string;

  constructor(dataDir: string) {
    const base = isAbsolute(dataDir) ? dataDir : resolve(process.cwd(), dataDir);
    this.filePath = join(base, 'hoop-store.json');
  }

  get location(): string {
    return this.filePath;
  }

  // ------------------------------------------------------------------ 生命周期

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DatabaseShape>;
      this.db = {
        ...emptyDatabase(),
        ...parsed,
        events: parsed.events ?? {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 首次启动：目录不存在就建好，写一个空库，保证后续读取路径始终存在
        await mkdir(dirname(this.filePath), { recursive: true });
        this.db = emptyDatabase();
        await this.persistNow();
      } else if (error instanceof SyntaxError) {
        // 文件损坏时不要静默清空：改名留证据，然后以空库启动
        const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
        await rename(this.filePath, quarantine).catch(() => undefined);
        // eslint-disable-next-line no-console
        console.error(`[JsonFileStore] 数据文件无法解析，已隔离到 ${quarantine}，以空库启动`);
        this.db = emptyDatabase();
        await this.persistNow();
      } else {
        throw error;
      }
    }
    this.loaded = true;
  }

  async dispose(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush();
  }

  /** 等待所有排队的变更落盘（测试与优雅退出使用）。 */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.dirty) await this.persistNow();
    if (this.persistPromise) await this.persistPromise;
  }

  /** 把一次变更排到队列尾部，返回该次变更的结果。 */
  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(task, task);
    // 队列本身吞掉异常，避免一次失败卡死后续所有请求
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow().catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[JsonFileStore] 落盘失败：', error);
      });
    }, 25);
    // 不阻止进程退出（写盘已由 flush/下一次 tick 兜底）
    this.persistTimer.unref?.();
  }

  private async persistNow(): Promise<void> {
    if (this.persistPromise) {
      await this.persistPromise;
      if (!this.dirty) return;
    }
    this.dirty = false;
    this.db.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(this.db, null, 2);
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.filePath);
    };
    const promise = write().finally(() => {
      this.persistPromise = null;
    });
    this.persistPromise = promise;
    await promise;
  }

  /** 构造函数里没加载时（例如单测直接调用）的兜底。 */
  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('JsonFileStore 尚未初始化：请先 await store.init()');
    }
  }

  // ------------------------------------------------------------------ 赛季

  async createSeason(input: CreateSeasonRecord): Promise<Season> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const season: Season = {
        id: randomUUID(),
        name: input.name,
        organizer: input.organizer,
        startDate: input.startDate,
        endDate: input.endDate,
        createdAt: new Date().toISOString(),
      };
      this.db.seasons.push(season);
      this.schedulePersist();
      return season;
    });
  }

  async listSeasons(): Promise<StoredSeason[]> {
    this.ensureLoaded();
    return [...this.db.seasons]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((season) => ({
        ...season,
        matchCount: this.db.matches.filter((match) => match.seasonId === season.id).length,
      }));
  }

  async findSeasonById(id: string): Promise<Season | null> {
    this.ensureLoaded();
    return this.db.seasons.find((season) => season.id === id) ?? null;
  }

  // ------------------------------------------------------------------ 比赛

  async createMatch(input: CreateMatchRecord): Promise<MatchAggregate> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const now = new Date().toISOString();
      const matchId = randomUUID();
      const defaultColors = ['#E4572E', '#2563EB', '#16A34A', '#9333EA', '#0891B2', '#DB2777'];

      const buildTeam = (side: 'home' | 'away', index: number): Team => {
        const source = side === 'home' ? input.home : input.away;
        const teamId = randomUUID();
        const players: Player[] = source.players.map((draft) => ({
          id: randomUUID(),
          teamId,
          jerseyNumber: draft.jerseyNumber,
          name: draft.name,
          isStarter: draft.isStarter,
          createdAt: now,
        }));
        const team: Team = {
          id: teamId,
          matchId,
          side,
          name: source.name,
          shortName: source.shortName,
          color: source.color || defaultColors[index % defaultColors.length]!,
          players,
        };
        this.db.teams.push(team);
        this.db.players.push(...players);
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
      this.db.matches.push(match);
      this.db.events[matchId] = [];
      this.schedulePersist();
      return { match, teams: { home, away } };
    });
  }

  async listMatches(filter: { seasonId?: string; status?: Match['status']; limit?: number } = {}): Promise<MatchAggregate[]> {
    this.ensureLoaded();
    return this.db.matches
      .filter((match) => (filter.seasonId ? match.seasonId === filter.seasonId : true))
      .filter((match) => (filter.status ? match.status === filter.status : true))
      .sort((a, b) => {
        const aKey = a.scheduledAt ?? a.createdAt;
        const bKey = b.scheduledAt ?? b.createdAt;
        return aKey < bKey ? 1 : -1;
      })
      .slice(0, filter.limit ?? 100)
      .map((match) => this.aggregate(match));
  }

  async findMatchById(id: string): Promise<MatchAggregate | null> {
    this.ensureLoaded();
    const match = this.db.matches.find((item) => item.id === id);
    return match ? this.aggregate(match) : null;
  }

  async findMatchByShareCode(code: string): Promise<MatchAggregate | null> {
    this.ensureLoaded();
    const match = this.db.matches.find((item) => item.shareCode.toUpperCase() === code.toUpperCase());
    return match ? this.aggregate(match) : null;
  }

  async updateMatch(id: string, patch: Partial<Match>): Promise<MatchAggregate | null> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const index = this.db.matches.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const current = this.db.matches[index]!;
      const updated: Match = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
      this.db.matches[index] = updated;
      this.schedulePersist();
      return this.aggregate(updated);
    });
  }

  async addPlayer(matchId: string, side: 'home' | 'away', input: PlayerDraftRecord): Promise<Player | null> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const match = this.db.matches.find((item) => item.id === matchId);
      if (!match) return null;
      const team = this.aggregate(match).teams[side];
      if (team.players.some((player) => player.jerseyNumber === input.jerseyNumber)) {
        throw new Error(`球衣号码 ${input.jerseyNumber} 在该队已存在`);
      }
      const player: Player = {
        id: randomUUID(),
        teamId: team.id,
        jerseyNumber: input.jerseyNumber,
        name: input.name,
        isStarter: input.isStarter,
        createdAt: new Date().toISOString(),
      };
      team.players.push(player);
      this.db.players.push(player);
      this.schedulePersist();
      return player;
    });
  }

  async deletePlayer(matchId: string, playerId: string): Promise<boolean> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const match = this.db.matches.find((item) => item.id === matchId);
      if (!match) return false;
      const aggregate = this.aggregate(match);
      for (const side of ['home', 'away'] as const) {
        const team = aggregate.teams[side];
        const index = team.players.findIndex((player) => player.id === playerId);
        if (index >= 0) {
          team.players.splice(index, 1);
          this.db.players = this.db.players.filter((player) => player.id !== playerId);
          this.schedulePersist();
          return true;
        }
      }
      return false;
    });
  }

  private aggregate(match: Match): MatchAggregate {
    const home = this.db.teams.find((team) => team.id === match.homeTeamId);
    const away = this.db.teams.find((team) => team.id === match.awayTeamId);
    if (!home || !away) {
      throw new Error(`比赛 ${match.id} 的队伍数据缺失，数据文件可能被外部修改过`);
    }
    return { match, teams: { home, away } };
  }

  // ------------------------------------------------------------------ 事件

  async listEvents(matchId: string, options: { sinceSeq?: number; limit?: number } = {}): Promise<GameEvent[]> {
    this.ensureLoaded();
    const all = (this.db.events[matchId] ?? []).filter((event) => event.seq > (options.sinceSeq ?? 0));
    return options.limit ? all.slice(0, options.limit) : all;
  }

  async countEvents(matchId: string): Promise<number> {
    this.ensureLoaded();
    return (this.db.events[matchId] ?? []).length;
  }

  async appendEvents(request: AppendEventsRequest): Promise<AppendEventsOutcome> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const existing = this.db.events[request.matchId] ?? [];
      const plan = this.planner.plan({
        existing,
        incoming: request.events,
        matchId: request.matchId,
        roster: request.roster,
        maxEventsPerMatch: request.maxEventsPerMatch,
        now: new Date(),
        newId: () => randomUUID(),
      });
      this.db.events[request.matchId] = plan.events;

      const match = this.db.matches.find((item) => item.id === request.matchId);
      if (match && plan.accepted.length > 0) {
        match.status = match.status === 'scheduled' ? 'live' : match.status;
        match.updatedAt = new Date().toISOString();
      }
      this.schedulePersist();

      return {
        events: plan.events,
        accepted: plan.accepted,
        duplicates: plan.duplicates,
        rejected: plan.rejected,
        reordered: plan.reordered,
        finalSeq: plan.finalSeq,
      };
    });
  }

  async voidEvents(request: VoidEventsRequest): Promise<VoidEventsOutcome> {
    this.ensureLoaded();
    return this.enqueue(() => {
      const existing = this.db.events[request.matchId] ?? [];
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
      this.db.events[request.matchId] = plan.events.map((event) =>
        targetIds.has(event.id) && voidEvent ? { ...event, voidedByEventId: voidEvent.id } : event,
      );

      const match = this.db.matches.find((item) => item.id === request.matchId);
      if (match) match.updatedAt = new Date().toISOString();
      if (request.voidDraft.type === 'game_end') {
        // 结束比赛由 voidDraft 之外的服务层处理；这里保持事件驱动
      }
      this.schedulePersist();

      return {
        voidedEventIds: request.targetEventIds,
        voidEvents: voidEvent ? [voidEvent] : [],
        finalSeq: plan.finalSeq,
      };
    });
  }

  async recordSyncBatch(record: SyncBatchRecord): Promise<void> {
    this.ensureLoaded();
    await this.enqueue(() => {
      this.db.syncBatches.push(record);
      // 只保留最近 2000 条审计记录，避免演示环境文件无限膨胀
      if (this.db.syncBatches.length > 2000) {
        this.db.syncBatches = this.db.syncBatches.slice(-2000);
      }
      this.schedulePersist();
    });
  }

  async findExistingClientEventIds(matchId: string, clientEventIds: string[]): Promise<string[]> {
    this.ensureLoaded();
    const wanted = new Set(clientEventIds);
    return (this.db.events[matchId] ?? [])
      .filter((event) => wanted.has(event.clientEventId))
      .map((event) => event.clientEventId);
  }

  async purgeArchived(before: Date): Promise<number> {
    this.ensureLoaded();
    return this.enqueue(() => {
      let removed = 0;
      for (const match of this.db.matches) {
        if (match.status !== 'archived') continue;
        if (new Date(match.updatedAt) >= before) continue;
        removed += (this.db.events[match.id] ?? []).length;
        this.db.events[match.id] = [];
      }
      this.schedulePersist();
      return removed;
    });
  }

  /** 运维用：导出当前全部数据（备份 / 迁移到 PostgreSQL）。 */
  exportSnapshot(): DatabaseShape {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.db)) as DatabaseShape;
  }
}
