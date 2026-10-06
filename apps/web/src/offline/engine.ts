import { io, type Socket } from 'socket.io-client';
import {
  projectMatch,
  type GameEvent,
  type GameEventDraft,
  type JoinMatchAck,
  type LiveFeedItem,
  type MatchDetail,
  type MatchState,
  type Scoreboard,
  type SubmitEventsAck,
  type UndoableAction,
} from '@openhoopscore/contracts';
import { api, ApiError, socketUrl } from '@/services/api';
import { createQueueStorage, makePendingEntry, type QueueStorage } from './queue';
import { buildLocalVoidDraft, cryptoRandomId, deriveOfflineState, resolveClientId, type PendingEntry } from './derive';

/**
 * ============================================================================
 * 计分端同步引擎
 * ============================================================================
 * 这是「离线优先」的核心：把「点击 → 本地落库 → 乐观渲染 → 联网补传 → 权威收敛」
 * 串成一条不会丢数据的流水线，并对外只暴露一个可订阅的只读快照。
 *
 * 一条事件的完整生命周期：
 *   1. submit()：生成 clientEventId（幂等键）→ **先写本地队列** → 立刻重算比分（乐观 UI）
 *   2. flush()：把队列整批发给服务端（优先 Socket.IO，失败退回 REST）
 *   3. 服务端返回逐条结果：accepted / duplicate → 从队列移除；rejected → 保留并标注原因
 *   4. 服务端广播 events:committed → 合并进权威事件流（按 id 去重），队列清空后画面自然收敛
 *
 * 断网时：navigator.onLine=false 或 Socket 掉线 → flush 直接跳过，
 * UI 显示「离线记录中 · N 条待同步」，恢复后自动补传，服务端幂等去重保证不重复计分。
 */

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface ScorerSnapshot {
  ready: boolean;
  matchId: string | null;
  clientId: string;
  detail: MatchDetail | null;
  /** 服务端已确认的权威事件（按 seq 升序）。 */
  authorityEvents: GameEvent[];
  /** 本地待同步队列。 */
  pending: PendingEntry[];
  pendingCount: number;
  /** 离线乐观推导出的最新状态（含本地未同步事件）。 */
  state: MatchState | null;
  /** 服务端权威状态（不含本地未同步部分），用于校验是否发生「跳分」。 */
  authorityState: MatchState | null;
  feed: LiveFeedItem[];
  undoable: UndoableAction[];
  connection: ConnectionState;
  onlineScorers: Array<{ clientId: string; since: string }>;
  lastSyncedAt: string | null;
  lastError: string | null;
  storageKind: 'indexeddb' | 'localstorage' | 'memory' | 'unknown';
  /** 服务端提示本次补传导致时间线重排，UI 需要提示「正在重新对齐」。 */
  resyncing: boolean;
}

const initialState: ScorerSnapshot = {
  ready: false,
  matchId: null,
  clientId: '',
  detail: null,
  authorityEvents: [],
  pending: [],
  pendingCount: 0,
  state: null,
  authorityState: null,
  feed: [],
  undoable: [],
  connection: 'connecting',
  onlineScorers: [],
  lastSyncedAt: null,
  lastError: null,
  storageKind: 'unknown',
  resyncing: false,
};

export class ScorerEngine {
  private snapshot: ScorerSnapshot = { ...initialState };
  private listeners = new Set<() => void>();
  private socket: Socket | null = null;
  private storage: QueueStorage | null = null;
  private passcode = '';
  private flushPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** React 的 useSyncExternalStore 需要 getSnapshot 返回稳定引用。 */
  getSnapshot = (): ScorerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(patch: Partial<ScorerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------ 生命周期

  async connect(matchId: string, passcode: string): Promise<void> {
    this.disposed = false;
    this.passcode = passcode;
    const clientId = resolveClientId();

    if (!this.storage) {
      this.storage = await createQueueStorage();
      this.emit({ storageKind: this.storage.kind });
    }

    const [detail, live, pending] = await Promise.all([
      api.getMatch(matchId),
      api.live(matchId, 100),
      this.storage.load(matchId, clientId),
    ]);

    this.emit({
      ready: true,
      matchId,
      clientId,
      detail,
      authorityEvents: live.state ? await this.loadAuthorityEvents(matchId, live.state.lastSeq) : [],
      pending,
      pendingCount: pending.length,
      feed: live.feed,
      undoable: live.undoable,
      lastError: null,
    });
    this.recompute();

    // 上次没传完的队列：一连上就先补传（断网一整场也只会在这里同步一次）
    if (pending.length > 0) void this.flush();

    this.openSocket(matchId, clientId);
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.socket) {
      this.socket.emit('match:leave', { matchId: this.snapshot.matchId });
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.listeners.clear();
  }

  private handleOnline = (): void => {
    this.emit({ connection: this.socket?.connected ? 'online' : 'connecting' });
    void this.flush();
  };

  private handleOffline = (): void => {
    this.emit({ connection: 'offline' });
  };

  /** 拉取权威事件：先按状态里的 lastSeq 判断是否需要全量。 */
  private async loadAuthorityEvents(matchId: string, knownSeq: number): Promise<GameEvent[]> {
    if (knownSeq <= 0) return [];
    const response = await api.events(matchId, 0, 5000);
    return response.events;
  }

  // ------------------------------------------------------------------ Socket

  private openSocket(matchId: string, clientId: string): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }

    const socket = io(socketUrl(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      // 现场网络恢复后要尽快重连：上限压到 5 秒，而不是默认的指数退避
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.emit({ connection: 'online', lastError: null });
      socket.emit(
        'match:join',
        { matchId, role: 'scorer', passcode: this.passcode, clientId, lastSeq: this.maxAuthoritySeq() },
        (ack: JoinMatchAck) => {
          if (!ack?.ok) {
            this.emit({
              connection: 'offline',
              lastError: ack?.error === 'invalid_passcode' ? '计分口令不正确，请重新进入' : '加入比赛失败，请检查网络',
            });
            return;
          }
          if (ack.state) this.emit({ authorityState: ack.state });
          if (ack.onlineScorers) this.emit({ onlineScorers: ack.onlineScorers });
          if (ack.events?.length) this.mergeAuthorityEvents(ack.events);
          if (ack.feed) this.emit({ feed: ack.feed });
          // 重连成功 = 补传时机
          void this.flush();
        },
      );
    });

    socket.on('disconnect', () => {
      this.emit({ connection: 'offline' });
    });

    socket.on('connect_error', () => {
      this.emit({ connection: 'offline' });
    });

    socket.on('events:committed', (payload: { events: GameEvent[]; scoreboard: Scoreboard; reordered: boolean; finalSeq: number }) => {
      if (payload.reordered) {
        // 补传插入了历史中间：本地要重新拉一遍完整事件流才能保证顺序一致
        this.emit({ resyncing: true });
        void this.resyncFromServer();
        return;
      }
      this.mergeAuthorityEvents(payload.events);
      this.recompute();
    });

    socket.on('state:patch', (payload: { state: MatchState }) => {
      // 服务端权威状态总是优先：它可能包含时钟、节次、比赛状态的变化
      this.emit({ authorityState: payload.state });
      this.recompute();
    });

    socket.on('feed:appended', (payload: { items: LiveFeedItem[] }) => {
      const seen = new Set(this.snapshot.feed.map((item) => item.id));
      const merged = [...payload.items.filter((item) => !seen.has(item.id)).reverse(), ...this.snapshot.feed];
      this.emit({ feed: merged.slice(0, 200) });
    });

    socket.on('undo:applied', (payload: { voidedEventIds: string[]; undoable: UndoableAction[] }) => {
      void this.resyncFromServer();
      this.emit({ undoable: payload.undoable });
    });

    socket.on('scorers:presence', (payload: { online: Array<{ clientId: string; since: string }> }) => {
      this.emit({ onlineScorers: payload.online });
    });

    socket.on('match:finished', () => {
      void this.resyncFromServer();
    });

    socket.on('error', (payload: { message: string }) => {
      this.emit({ lastError: payload.message });
    });
  }

  private maxAuthoritySeq(): number {
    return this.snapshot.authorityEvents.reduce((max, event) => Math.max(max, event.seq), 0);
  }

  private mergeAuthorityEvents(incoming: readonly GameEvent[]): void {
    if (incoming.length === 0) return;
    const byId = new Map(this.snapshot.authorityEvents.map((event) => [event.id, event]));
    for (const event of incoming) byId.set(event.id, event);
    const merged = [...byId.values()].sort((a, b) => a.seq - b.seq || (a.clientTimestamp < b.clientTimestamp ? -1 : 1));
    this.emit({ authorityEvents: merged });
  }

  /** 重新拉取权威状态与事件流（补传重排、撤销、比赛结束时用）。 */
  async resyncFromServer(): Promise<void> {
    const matchId = this.snapshot.matchId;
    if (!matchId) return;
    try {
      const [live, events] = await Promise.all([
        api.live(matchId, 100),
        api.events(matchId, 0, 5000),
      ]);
      this.emit({
        authorityEvents: events.events,
        authorityState: live.state,
        feed: live.feed,
        undoable: live.undoable,
        resyncing: false,
        lastError: null,
      });
      this.recompute();
    } catch (error) {
      this.emit({ resyncing: false, lastError: `重新同步失败：${(error as Error).message}` });
    }
  }

  // ------------------------------------------------------------------ 本地推导

  /** 用「权威事件 + 本地队列」重算比分。每次点击/同步/广播后都调用。 */
  private recompute(): void {
    const { authorityEvents, pending } = this.snapshot;
    const detail = this.snapshot.detail;
    if (!detail) return;

    const homeTeamId = detail.teams.home.id;
    const awayTeamId = detail.teams.away.id;
    const playerTeamId: Record<string, string> = {};
    for (const team of [detail.teams.home, detail.teams.away]) {
      for (const player of team.players) playerTeamId[player.id] = team.id;
    }
    const context = {
      matchId: detail.match.id,
      homeTeam: { teamId: homeTeamId, side: 'home' as const },
      awayTeam: { teamId: awayTeamId, side: 'away' as const },
      regulationPeriods: detail.match.regulationPeriods,
    };

    // 与服务端完全同一套投影算法（同一个包、同一个函数）
    const project = (events: GameEvent[], assumeSorted = false): MatchState =>
      projectStateFromTally(detail, events, projectMatch(events, context, { assumeSorted }));

    const derived = deriveOfflineState(authorityEvents, pending, project);
    this.emit({
      state: derived.state,
      pendingCount: derived.pendingCount,
      authorityState: this.snapshot.authorityState ?? project(authorityEvents, true),
    });
  }

  // ------------------------------------------------------------------ 写操作

  /**
   * 计分：把一次点击变成一条事件。
   * **先把事件写进本地队列并立刻更新画面**，再去尝试网络。
   *
   * 参数里不需要（也不应该）出现 points / id / clientEventId：
   *   - points 由服务端根据 payload.points 推导，客户端传了也会被覆盖；
   *   - id / clientEventId 由这里统一生成，保证幂等键一定唯一且来自本地。
   */
  async record(
    draft: Omit<GameEventDraft, 'matchId' | 'clientId' | 'clientEventId' | 'id' | 'clientTimestamp' | 'points'> & {
      clientTimestamp?: string;
    },
  ): Promise<void> {
    const matchId = this.snapshot.matchId;
    if (!matchId || !this.storage) return;

    const event: GameEventDraft = {
      id: cryptoRandomId(),
      matchId,
      type: draft.type,
      teamId: draft.teamId ?? null,
      playerId: draft.playerId ?? null,
      points: 0,
      period: draft.period,
      gameClockSeconds: draft.gameClockSeconds ?? null,
      clientTimestamp: draft.clientTimestamp ?? new Date().toISOString(),
      clientId: this.snapshot.clientId,
      clientEventId: cryptoRandomId(),
      payload: (draft.payload ?? {}) as GameEventDraft['payload'],
    };

    const pending = [...this.snapshot.pending, makePendingEntry(event)];
    this.emit({ pending, pendingCount: pending.length, lastError: null });
    this.recompute();
    // 关键：落盘 await 之后才返回，保证「点击后立刻杀进程」也不会丢
    await this.storage.save(matchId, this.snapshot.clientId, pending);

    void this.flush();
  }

  /** 撤销：离线也能撤（本地追加 void 事件，联网后一并补传）。 */
  async undo(targetEventId?: string, steps = 1): Promise<string[]> {
    const matchId = this.snapshot.matchId;
    if (!matchId) return [];

    // 可撤销集合 = 权威事件 + 本地未同步事件，再排除已被撤销的
    const voided = new Set<string>();
    for (const event of this.snapshot.authorityEvents) {
      if (event.type === 'void') {
        const target = (event.payload as { targetEventId?: string }).targetEventId;
        if (target) voided.add(target);
      }
    }
    const localEvents = this.snapshot.pending
      .filter((entry) => entry.event.type !== 'void')
      .map((entry) => ({ id: entry.clientEventId, clientEventId: entry.clientEventId }));
    for (const entry of this.snapshot.pending) {
      if (entry.event.type === 'void') {
        const target = (entry.event.payload as { targetEventId?: string }).targetEventId;
        if (target) voided.add(target);
      }
    }

    const undoableAuthority = this.snapshot.authorityEvents
      .filter((event) => event.type !== 'void' && !voided.has(event.id))
      .sort((a, b) => b.seq - a.seq);
    const undoableLocal = this.snapshot.pending
      .filter((entry) => entry.event.type !== 'void' && !voided.has(entry.clientEventId))
      .reverse();

    const descriptions: string[] = [];
    const configuredSteps = Math.max(1, steps);
    let remaining = configuredSteps;

    // 先撤本地未同步的（它们排在时间线最后），再撤已确认的
    const localTargets = targetEventId
      ? undoableLocal.filter((entry) => entry.clientEventId === targetEventId)
      : undoableLocal.slice(0, remaining);
    const authorityTargets = targetEventId
      ? undoableAuthority.filter((event) => event.id === targetEventId)
      : undoableAuthority.slice(0, Math.max(0, remaining - localTargets.length));

    for (const entry of localTargets) {
      await this.recordLocalVoid(matchId, entry.clientEventId);
      descriptions.push(describeDraft(entry.event));
    }
    remaining -= localTargets.length;

    if (authorityTargets.length > 0) {
      if (this.snapshot.connection === 'online') {
        try {
          const result = await api.undo(
            matchId,
            { clientId: this.snapshot.clientId, targetEventId: authorityTargets[0]!.id, steps: authorityTargets.length },
            this.passcode,
          );
          descriptions.push(...result.descriptions);
          this.emit({ authorityState: result.state, undoable: result.undoable });
          await this.resyncFromServer();
        } catch (error) {
          // 网络中途断了：降级为「本地撤销」，联网后会随队列一起补传
          this.emit({ lastError: `撤销请求失败，已改为本地撤销：${(error as Error).message}` });
          for (const event of authorityTargets) {
            await this.recordLocalVoid(matchId, event.id);
            descriptions.push(describeEvent(event));
          }
        }
      } else {
        for (const event of authorityTargets) {
          await this.recordLocalVoid(matchId, event.id);
          descriptions.push(describeEvent(event));
        }
      }
    }

    this.recompute();
    return descriptions;
  }

  private async recordLocalVoid(matchId: string, targetEventId: string): Promise<void> {
    if (!this.storage) return;
    const draft = buildLocalVoidDraft(matchId, this.snapshot.clientId, targetEventId);
    const pending = [...this.snapshot.pending, makePendingEntry(draft)];
    this.emit({ pending, pendingCount: pending.length });
    await this.storage.save(matchId, this.snapshot.clientId, pending);
    void this.flush();
  }

  /** 手动触发补传（UI 上的「立即同步」按钮）。 */
  async flush(): Promise<void> {
    // 同一时刻只允许一个补传在跑，避免重复提交（服务端虽有幂等兜底，但没必要浪费流量）
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.doFlush().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    const matchId = this.snapshot.matchId;
    const storage = this.storage;
    if (!matchId || !storage || this.snapshot.pending.length === 0) return;

    const batch = [...this.snapshot.pending];
    const clientId = this.snapshot.clientId;
    const drafts = batch.map((entry) => entry.event);

    try {
      let accepted = new Set<string>();
      let rejected: Array<{ clientEventId: string; reason: string }> = [];

      if (this.socket?.connected) {
        // 在线：走 Socket.IO，延迟最低
        const ack = await new Promise<SubmitEventsAck>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('提交超时')), 30_000);
          this.socket!.emit(
            'scoring:submit',
            { matchId, clientId, passcode: this.passcode, batchId: cryptoRandomId(), events: drafts },
            (result: SubmitEventsAck) => {
              clearTimeout(timer);
              resolve(result);
            },
          );
        });

        if (!ack.ok) {
          throw new ApiError(0, ack.error ?? 'SUBMIT_FAILED', `提交失败：${ack.error ?? '未知原因'}`);
        }
        accepted = new Set(
          ack.rejected
            ? drafts
                .map((draft) => draft.clientEventId)
                .filter((id) => !ack.rejected!.some((item) => item.clientEventId === id))
            : drafts.map((draft) => draft.clientEventId),
        );
        rejected = ack.rejected ?? [];
      } else {
        // 离线恢复/降级：走 REST（长轮询也能用，且超时更宽容）
        const result = await api.submitEvents(
          matchId,
          { clientId, events: drafts, sinceSeq: this.maxAuthoritySeq() },
          this.passcode,
        );
        accepted = new Set(
          result.results.filter((item) => item.status === 'accepted' || item.status === 'duplicate').map((item) => item.clientEventId),
        );
        rejected = result.results
          .filter((item) => item.status === 'rejected')
          .map((item) => ({ clientEventId: item.clientEventId, reason: item.reason ?? '未知原因' }));
        this.emit({ authorityState: result.state });
      }

      // 被接受的移出队列；被拒绝的保留下来并把原因写进队列（UI 会让计分员看到并处理）
      const rejectedMap = new Map(rejected.map((item) => [item.clientEventId, item.reason]));
      const remaining = this.snapshot.pending
        .filter((entry) => !accepted.has(entry.clientEventId))
        .map((entry) =>
          rejectedMap.has(entry.clientEventId)
            ? { ...entry, attempts: entry.attempts + 1, lastError: rejectedMap.get(entry.clientEventId) }
            : entry,
        );

      this.emit({
        pending: remaining,
        pendingCount: remaining.length,
        lastSyncedAt: new Date().toISOString(),
        lastError: rejected.length > 0 ? `${rejected.length} 条事件被服务端拒绝，请检查后重试` : null,
      });
      await storage.save(matchId, clientId, remaining);

      // 补传成功后重新对齐，避免本地与服务端有细微差异
      await this.resyncFromServer();
    } catch (error) {
      // 网络失败：队列原样保留，指数退避后自动重试
      const message = (error as Error).message;
      const pending = this.snapshot.pending.map((entry) => ({
        ...entry,
        attempts: entry.attempts + 1,
        lastError: message,
      }));
      this.emit({ pending, pendingCount: pending.length, lastError: null });
      await storage.save(matchId, clientId, pending);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, 5000);
  }

  /** 结束比赛（需要联网：这是不可逆的权威状态变更）。 */
  async finish(reason: 'normal' | 'forfeit' | 'aborted' = 'normal'): Promise<void> {
    const matchId = this.snapshot.matchId;
    if (!matchId) return;
    if (this.snapshot.pending.length > 0) await this.flush();
    await api.finishMatch(matchId, { clientId: this.snapshot.clientId, reason }, this.passcode);
    await this.resyncFromServer();
  }

  /** 切换节次（需要联网：节次是权威事件）。 */
  async endPeriod(): Promise<void> {
    const matchId = this.snapshot.matchId;
    const state = this.snapshot.state;
    if (!matchId || !state) return;
    const response = await api.setClock(
      matchId,
      { clientId: this.snapshot.clientId, period: state.period + 1, gameClockSeconds: null },
      this.passcode,
    );
    this.emit({ authorityState: response.state });
    await this.resyncFromServer();
  }
}

/* ------------------------------ 辅助函数 ------------------------------ */

/**
 * 把投影结果装配成 MatchState。
 *
 * 这里刻意与后端 MatchEngine 保持同样的字段结构：前端不需要球员统计以外的信息，
 * 但字段名必须一致，否则观众端/计分端/socket 推送三处渲染会各不相同。
 */
function projectStateFromTally(
  detail: MatchDetail,
  events: readonly GameEvent[],
  tally: ReturnType<typeof projectMatch>,
): MatchState {
  const buildTeam = (team: MatchDetail['teams']['home'], side: 'home' | 'away'): MatchState['home'] => {
    const teamTally = side === 'home' ? tally.home : tally.away;
    return {
      teamId: team.id,
      side,
      name: team.name,
      shortName: team.shortName,
      color: team.color,
      score: teamTally.score,
      teamFouls: teamTally.teamFouls,
      teamFoulsByPeriod: teamTally.teamFoulsByPeriod,
      timeoutsUsed: teamTally.timeoutsUsed,
      players: team.players.map((player) => {
        const line = tally.players[player.id];
        return {
          playerId: player.id,
          teamId: team.id,
          name: player.name,
          jerseyNumber: player.jerseyNumber,
          points: line?.points ?? 0,
          fouls: line?.fouls ?? 0,
          madeByShotType: { layup: 0, mid: 0, three: 0, dunk: 0, free_throw: 0, other: 0 },
          threePointersMade: line?.threePointersMade ?? 0,
          turnovers: 0,
          steals: 0,
          blocks: 0,
          reboundsOffensive: 0,
          reboundsDefensive: 0,
          onCourt: player.isStarter,
        };
      }),
    };
  };

  const home = buildTeam(detail.teams.home, 'home');
  const away = buildTeam(detail.teams.away, 'away');
  const margin = Math.abs(tally.score.home - tally.score.away);
  const leader = tally.score.home === tally.score.away ? null : tally.score.home > tally.score.away ? 'home' : 'away';

  return {
    matchId: detail.match.id,
    status: tally.status,
    period: tally.period,
    gameClockSeconds: null,
    home,
    away,
    scoreboard: {
      matchId: detail.match.id,
      status: tally.status,
      period: tally.period,
      gameClockSeconds: null,
      home: { teamId: home.teamId, name: home.name, shortName: home.shortName, color: home.color, score: home.score },
      away: { teamId: away.teamId, name: away.name, shortName: away.shortName, color: away.color, score: away.score },
      leader,
      margin,
      blowout: false,
      updatedAt: tally.updatedAt ?? new Date().toISOString(),
    },
    lastSeq: tally.lastSeq,
    appliedEventCount: tally.appliedEventCount,
    voidedEventIds: tally.voidedEventIds,
    updatedAt: tally.updatedAt ?? new Date().toISOString(),
  };
}

function describeEvent(event: GameEvent): string {
  const points = event.points > 0 ? `（${event.points} 分）` : '';
  return `撤销第${event.period}节的一次${labelOf(event.type)}${points}`;
}

function describeDraft(draft: GameEventDraft): string {
  const points = draft.type === 'score' ? `（${(draft.payload as { points?: number }).points ?? 0} 分）` : '';
  return `撤销第${draft.period}节的一次${labelOf(draft.type)}${points}`;
}

function labelOf(type: GameEvent['type']): string {
  const labels: Record<string, string> = {
    score: '得分',
    foul: '犯规',
    team_foul: '全队犯规',
    timeout: '暂停',
    substitution: '换人',
    turnover: '失误',
    steal: '抢断',
    block: '盖帽',
    rebound: '篮板',
  };
  return labels[type] ?? '操作';
}

/** 单例：一个页面同时只会操作一场比赛。 */
let engineSingleton: ScorerEngine | null = null;

export function getScorerEngine(): ScorerEngine {
  if (!engineSingleton) engineSingleton = new ScorerEngine();
  return engineSingleton;
}
