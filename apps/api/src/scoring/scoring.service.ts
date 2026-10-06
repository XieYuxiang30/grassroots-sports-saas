import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  GameEvent,
  GameEventDraft,
  LiveFeedItem,
  MatchState,
  QueryEventsResponse,
  Scoreboard,
  SubmitEventsDto,
  SubmitEventsResult,
  UndoableAction,
  UndoResult,
} from '@openhoopscore/contracts';
import type { EventsCommittedEvent, UndoAppliedEvent } from '@openhoopscore/contracts';
import { APP_CONFIG, PROJECTION_VERSION, type AppConfig } from '../config/config.tokens';
import { STORE } from '../store/store.module';
import type { AppendEventsOutcome, MatchAggregate, StorePort } from '../store/store.port';
import { DomainError } from '../common/domain-error';
import { MatchEngine } from './match-engine';
import type { SubmitOutcome, UndoOutcome } from './scoring.types';
import { RealtimeRegistry } from '../realtime/realtime.ports';

export type { SubmitOutcome, UndoOutcome };

/**
 * ============================================================================
 * 计分服务 —— 事件写入 / 撤销的唯一入口
 * ============================================================================
 * REST 与 Socket.IO 两条链路都走这里，保证「不管从哪个入口点，规则完全一致」：
 *   - 幂等：重复的 clientEventId 只算一次；
 *   - 排序：补传事件按 clientTimestamp 插入正确的时间线位置；
 *   - 撤销：不删历史，追加 `void` 事件指向目标，比分自然回退；
 *   - 每次写操作都返回**广播载荷**，由调用方决定推给谁。
 */
@Injectable()
export class ScoringService implements OnModuleInit {
  private readonly logger = new Logger(ScoringService.name);
  /** 每场比赛的写队列：保证「读现状 → 决定撤销谁 → 写 void」这段不会被并发穿插。 */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(STORE) private readonly store: StorePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly engine: MatchEngine,
  ) {}

  /**
   * 启动时把自己注册到实时模块的端口注册表。
   * 这样 RealtimeService 不必 import ScoringModule（否则会出现循环依赖）。
   */
  onModuleInit(): void {
    RealtimeRegistry.registerScorer({
      submit: ({ matchId, clientId, passcode, events }) =>
        this.submitEvents({ matchId, clientId, passcode, events }),
      undo: ({ matchId, clientId, passcode, targetEventId, steps }) =>
        this.undo({ matchId, clientId, passcode, targetEventId, steps }),
      requestState: async ({ matchId, sinceSeq }) => {
        const live = await this.getLive(matchId, { feedLimit: 60 });
        // 注意用 `!== undefined` 而不是真值判断：sinceSeq=0 是「我什么都没有，请把全部事件给我」，
        // 这是观众首次进房最常见的取值，写成 `sinceSeq ? ...` 会把它当成「不用给」。
        const events = sinceSeq !== undefined ? (await this.getEvents(matchId, sinceSeq, 1000)).events : [];
        return { state: live.state, events, feed: live.feed };
      },
      finishMatch: ({ matchId, clientId, passcode, reason }) =>
        this.finishMatch({ matchId, clientId, passcode, reason }),
      setClock: ({ matchId, clientId, passcode, period, gameClockSeconds, running }) =>
        this.setClock({ matchId, clientId, passcode, period, gameClockSeconds, running }),
    });
  }

  /** 计分员口令校验：观众端只读，写操作必须带口令。 */
  assertScorer(passcode: string | undefined): void {
    if (!passcode || passcode !== this.config.scorerPasscode) {
      throw DomainError.forbidden('INVALID_PASSCODE', '计分口令不正确，请向赛事管理员索取');
    }
  }

  /** 按比赛 id 串行化写操作。 */
  private enqueue<T>(matchId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(matchId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.writeQueues.set(
      matchId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async requireAggregate(matchId: string): Promise<MatchAggregate> {
    const aggregate = await this.store.findMatchById(matchId);
    if (!aggregate) throw DomainError.notFound('MATCH_NOT_FOUND', `比赛不存在：${matchId}`);
    return aggregate;
  }

  private requireRoster(aggregate: MatchAggregate) {
    const context = this.engine.contextOf(aggregate);
    return {
      homeTeamId: context.homeTeam.teamId,
      awayTeamId: context.awayTeam.teamId,
      playerTeamId: context.playerTeamId,
    };
  }

  // ------------------------------------------------------------------ 读

  async getState(matchId: string, sinceSeq = 0): Promise<MatchState> {
    const aggregate = await this.requireAggregate(matchId);
    const events = await this.store.listEvents(matchId, { sinceSeq: 0 });
    void sinceSeq;
    return this.engine.buildState(aggregate, events);
  }

  async getLive(matchId: string, options: { feedLimit?: number; undoLimit?: number } = {}) {
    const aggregate = await this.requireAggregate(matchId);
    const events = await this.store.listEvents(matchId, { sinceSeq: 0 });
    const state = this.engine.buildState(aggregate, events);
    const feed = this.engine.buildFeed(aggregate, events, options.feedLimit ?? 200);
    return {
      state,
      feed,
      timeline: this.engine.buildTimeline(feed),
      undoable: this.engine.buildUndoStack(aggregate, events, options.undoLimit ?? 10),
    };
  }

  async getEvents(matchId: string, sinceSeq = 0, limit = 1000): Promise<QueryEventsResponse> {
    await this.requireAggregate(matchId);
    const events = await this.store.listEvents(matchId, { sinceSeq, limit: limit + 1 });
    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    return {
      matchId,
      events: page,
      nextSeq: page.length > 0 ? page[page.length - 1]!.seq : sinceSeq,
      hasMore,
    };
  }

  async getScoreboard(matchId: string): Promise<Scoreboard> {
    const state = await this.getState(matchId);
    return state.scoreboard;
  }

  async getLeaderboard(matchId: string, sortedBy: 'points' | 'fouls' | 'threePointersMade' = 'points') {
    const aggregate = await this.requireAggregate(matchId);
    const events = await this.store.listEvents(matchId, { sinceSeq: 0 });
    const state = this.engine.buildState(aggregate, events);
    return this.engine.buildLeaderboard(aggregate, state, sortedBy);
  }

  // ------------------------------------------------------------------ 写：提交事件

  /**
   * 提交一批事件。
   *
   * 这是「在线实时」与「离线补传」共用的入口：
   *   - 在线：一次 1 条，实时返回状态并广播；
   *   - 离线补传：一次几十上百条，服务端去重 + 重排 + 统一分配 seq，
   *     并回报 `reordered`，让客户端知道需要重拉直播流。
   */
  async submitEvents(dto: SubmitEventsDto & { passcode?: string }, options: { skipPasscode?: boolean } = {}): Promise<SubmitOutcome> {
    if (!options.skipPasscode) this.assertScorer(dto.passcode);

    if (!Array.isArray(dto.events) || dto.events.length === 0) {
      throw new DomainError('INVALID_EVENT', 'events 不能为空');
    }
    if (dto.events.length > this.config.maxSyncBatch) {
      throw new DomainError(
        'TOO_MANY_EVENTS',
        `单批最多 ${this.config.maxSyncBatch} 条事件，请分批补传（当前 ${dto.events.length} 条）`,
      );
    }

    return this.enqueue(dto.matchId, async () => {
      const aggregate = await this.requireAggregate(dto.matchId);
      if (aggregate.match.status === 'archived') {
        throw DomainError.conflict('MATCH_ARCHIVED', '比赛已归档，不能再计分');
      }

      const incoming: GameEventDraft[] = dto.events.map((draft) => ({
        ...draft,
        matchId: dto.matchId,
        clientId: draft.clientId || dto.clientId,
      }));

      const outcome = await this.store.appendEvents({
        matchId: dto.matchId,
        clientId: dto.clientId,
        events: incoming,
        roster: this.requireRoster(aggregate),
        maxEventsPerMatch: this.config.maxEventsPerMatch,
      });

      const previousAggregate = aggregate;
      const previousState = this.engine.buildState(previousAggregate, outcome.events.filter((event) => !outcome.accepted.some((item) => item.eventId === event.id)));

      const state = this.engine.buildState(previousAggregate, outcome.events);
      const acceptedIds = new Set(outcome.accepted.map((item) => item.eventId));
      const newEvents = outcome.events.filter((event) => acceptedIds.has(event.id));

      // 事件落库后比赛状态可能从 scheduled → live，同步写回比赛表
      if (newEvents.length > 0 && previousAggregate.match.status !== 'live' && state.status === 'live') {
        await this.store.updateMatch(dto.matchId, { status: 'live' });
      }

      const fullFeed = this.engine.buildFeed(previousAggregate, outcome.events, 200);
      const newEventIds = new Set(newEvents.map((event) => event.id));
      const feedItems = fullFeed
        .filter((item) => newEventIds.has(item.id))
        .reverse();

      const results: SubmitEventsResult['results'] = [
        ...outcome.accepted.map((item) => ({
          clientEventId: item.clientEventId,
          status: 'accepted' as const,
          eventId: item.eventId,
          seq: item.seq,
        })),
        ...outcome.duplicates.map((item) => ({
          clientEventId: item.clientEventId,
          status: 'duplicate' as const,
          eventId: item.eventId,
          seq: item.seq,
        })),
        ...outcome.rejected.map((item) => ({
          clientEventId: item.clientEventId,
          status: 'rejected' as const,
          reason: item.reason,
        })),
      ];

      const result: SubmitEventsResult = {
        matchId: dto.matchId,
        results,
        acceptedCount: outcome.accepted.length,
        duplicateCount: outcome.duplicates.length,
        rejectedCount: outcome.rejected.length,
        state,
        feed: feedItems,
        reordered: outcome.reordered,
      };

      const broadcast: EventsCommittedEvent = {
        matchId: dto.matchId,
        events: newEvents,
        scoreboard: state.scoreboard,
        finalSeq: outcome.finalSeq,
        reordered: outcome.reordered,
        at: new Date().toISOString(),
      };

      if (outcome.rejected.length > 0) {
        this.logger.warn(
          `比赛 ${dto.matchId} 有 ${outcome.rejected.length} 条事件被拒绝：${outcome.rejected
            .map((item) => `${item.clientEventId}(${item.reason})`)
            .join('；')}`,
        );
      }

      const highlights = this.engine
        .detectHighlights(aggregate, state, previousState)
        .map(({ playerId, teamId, teamSide, milestone, text }) => ({ playerId, teamId, teamSide, milestone, text }));

      return { result, broadcast, feedItems, highlights, state };
    });
  }

  // ------------------------------------------------------------------ 写：撤销

  /**
   * 撤销。
   *
   * 语义（非常重要，直接决定计分员能不能信任这个系统）：
   *   - 撤销**不删除**任何历史事件，而是追加一条 `void` 事件指向目标；
   *   - 默认撤销「最近一次可撤销操作」（`steps` 可指定连撤多步）；
   *   - 返回每一步的中文描述，UI 可以直接告诉计分员「已撤销：张三的两分」。
   */
  async undo(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    targetEventId?: string;
    steps?: number;
  }): Promise<UndoOutcome> {
    this.assertScorer(params.passcode);

    return this.enqueue(params.matchId, async () => {
      const aggregate = await this.requireAggregate(params.matchId);
      const events = await this.store.listEvents(params.matchId, { sinceSeq: 0 });
      const undoStack = this.engine.buildUndoStack(aggregate, events, 50);

      if (undoStack.length === 0) {
        throw new DomainError('NO_UNDOABLE_EVENT', '当前没有可以撤销的操作');
      }

      let targets: UndoableAction[];
      if (params.targetEventId) {
        const found = undoStack.find((item) => item.eventId === params.targetEventId);
        if (!found) {
          throw DomainError.notFound('NO_UNDOABLE_EVENT', '要撤销的事件不存在或已经被撤销');
        }
        targets = [found];
      } else {
        const steps = Math.min(Math.max(params.steps ?? 1, 1), undoStack.length);
        targets = undoStack.slice(0, steps);
      }

      const voidedEventIds: string[] = [];
      const descriptions: string[] = [];
      const createdVoids: GameEvent[] = [];

      for (const target of targets) {
        const targetEvent = events.find((event) => event.id === target.eventId);
        if (!targetEvent) continue;
        const draft = this.engine.buildVoidDraft(aggregate, targetEvent, params.clientId, 'scorer_undo');
        const outcome = await this.store.voidEvents({
          matchId: params.matchId,
          targetEventIds: [target.eventId],
          voidDraft: draft as GameEventDraft,
          roster: this.requireRoster(aggregate),
        });
        voidedEventIds.push(...outcome.voidedEventIds);
        createdVoids.push(...outcome.voidEvents);
        descriptions.push(target.description);
      }

      const updatedEvents = await this.store.listEvents(params.matchId, { sinceSeq: 0 });
      const state = this.engine.buildState(aggregate, updatedEvents);
      const undoable = this.engine.buildUndoStack(aggregate, updatedEvents, 10);

      // 撤销全部得分后比赛回到「未开始」状态
      if (state.status === 'scheduled' && aggregate.match.status === 'live') {
        await this.store.updateMatch(params.matchId, { status: 'scheduled' });
      }

      const broadcast: UndoAppliedEvent = {
        matchId: params.matchId,
        voidedEventIds,
        descriptions,
        scoreboard: state.scoreboard,
        undoable,
        clientId: params.clientId,
        at: new Date().toISOString(),
      };

      const result: UndoResult = {
        matchId: params.matchId,
        voidedEventIds,
        descriptions,
        state,
        undoable,
      };

      void createdVoids;
      return { result, broadcast, feedItems: [] };
    });
  }

  // ------------------------------------------------------------------ 写：比赛状态

  async finishMatch(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    reason?: 'normal' | 'forfeit' | 'aborted';
  }): Promise<{ state: MatchState; event: GameEvent }> {
    this.assertScorer(params.passcode);

    return this.enqueue(params.matchId, async () => {
      const aggregate = await this.requireAggregate(params.matchId);
      const now = new Date().toISOString();
      const draft: GameEventDraft = {
        id: randomUUID(),
        matchId: params.matchId,
        type: 'game_end',
        teamId: null,
        playerId: null,
        points: 0,
        period: aggregate.match.regulationPeriods,
        gameClockSeconds: 0,
        clientTimestamp: now,
        clientId: params.clientId,
        clientEventId: `finish-${randomUUID()}`,
        payload: params.reason ? { reason: params.reason } : {},
      };

      const outcome: AppendEventsOutcome = await this.store.appendEvents({
        matchId: params.matchId,
        clientId: params.clientId,
        events: [draft],
        roster: this.requireRoster(aggregate),
        maxEventsPerMatch: this.config.maxEventsPerMatch,
      });

      await this.store.updateMatch(params.matchId, { status: 'finished' });

      const events = await this.store.listEvents(params.matchId, { sinceSeq: 0 });
      const state = this.engine.buildState(aggregate, events);
      return { state, event: outcome.events.find((event) => event.type === 'game_end')! };
    });
  }

  /** 更新比赛时钟 / 节次（计分端计时器）。 */
  async setClock(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    period?: number;
    gameClockSeconds?: number | null;
    running?: boolean;
  }): Promise<{ state: MatchState; event: GameEvent | null }> {
    this.assertScorer(params.passcode);

    return this.enqueue(params.matchId, async () => {
      const aggregate = await this.requireAggregate(params.matchId);
      const events = await this.store.listEvents(params.matchId, { sinceSeq: 0 });
      const current = this.engine.buildState(aggregate, events);

      const nextPeriod = params.period ?? current.period;
      const periodChanged = nextPeriod !== current.period;

      // 只有「节次变化」需要写事件（事件溯源：节次也是事件推导出来的）；
      // 单纯的秒表走动是展示态，用 state:patch 广播即可，避免事件流被秒表刷爆。
      if (!periodChanged) {
        return { state: current, event: null };
      }

      const now = new Date().toISOString();
      const draft: GameEventDraft = {
        id: randomUUID(),
        matchId: params.matchId,
        type: periodChanged && nextPeriod > current.period ? 'period_end' : 'game_start',
        teamId: null,
        playerId: null,
        points: 0,
        period: Math.max(current.period, nextPeriod - (periodChanged && nextPeriod > current.period ? 1 : 0)),
        gameClockSeconds: params.gameClockSeconds ?? null,
        clientTimestamp: now,
        clientId: params.clientId,
        clientEventId: `period-${randomUUID()}`,
        payload:
          nextPeriod > current.period
            ? { homeScore: current.scoreboard.home.score, awayScore: current.scoreboard.away.score }
            : {},
      };

      await this.store.appendEvents({
        matchId: params.matchId,
        clientId: params.clientId,
        events: [draft],
        roster: this.requireRoster(aggregate),
        maxEventsPerMatch: this.config.maxEventsPerMatch,
      });

      const updated = await this.store.listEvents(params.matchId, { sinceSeq: 0 });
      return { state: this.engine.buildState(aggregate, updated), event: updated.find((event) => event.clientEventId === draft.clientEventId) ?? null };
    });
  }

  /** 无副作用试算：校验计分端本地投影与服务端是否一致。 */
  async previewCompute(params: { matchId: string; events: GameEventDraft[] }) {
    const aggregate = await this.requireAggregate(params.matchId);
    const roster = this.requireRoster(aggregate);
    const existing = await this.store.listEvents(params.matchId, { sinceSeq: 0 });

    // 复用规划器算法但不落库：临时构造 full event 列表
    const synthetic: GameEvent[] = params.events.map((draft, index) => ({
      ...draft,
      seq: 0,
      createdAt: new Date().toISOString(),
      payload: draft.payload ?? {},
      points: draft.type === 'score' ? ((draft.payload as { points?: number } | undefined)?.points ?? 0) : 0,
      id: `preview-${index}`,
    }));

    const merged = [...existing, ...synthetic].sort((a, b) => {
      const keyA = `${a.clientTimestamp}\u0000${a.clientId}\u0000${a.clientEventId}`;
      const keyB = `${b.clientTimestamp}\u0000${b.clientId}\u0000${b.clientEventId}`;
      return keyA === keyB ? 0 : keyA < keyB ? -1 : 1;
    });
    merged.forEach((event, index) => {
      event.seq = index + 1;
    });

    void roster;
    const state = this.engine.buildState(aggregate, merged);
    return {
      homeScore: state.scoreboard.home.score,
      awayScore: state.scoreboard.away.score,
      period: state.period,
      projectionVersion: PROJECTION_VERSION,
    };
  }

  /** 计分端启动/恢复时的「本地队列对账」：哪些本地事件其实服务端已经收到了。 */
  async reconcile(matchId: string, clientEventIds: string[]) {
    await this.requireAggregate(matchId);
    const found = await this.store.findExistingClientEventIds(matchId, clientEventIds);
    return { matchId, acknowledged: found, unknown: clientEventIds.filter((id) => !found.includes(id)) };
  }
}
