import { Inject, Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import type {
  GameEvent,
  IsoDateTime,
  JoinMatchAck,
  LiveFeedItem,
  MatchState,
  PlayerHighlightEvent,
  RealtimeRole,
  Scoreboard,
  SubmitEventsAck,
  UndoAck,
} from '@openhoopscore/contracts';
import { MATCH_ROOM, SCORER_ROOM, SERVER_EVENTS } from '@openhoopscore/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config.tokens';
import { DomainError } from '../common/domain-error';
import { RealtimeRegistry } from './realtime.ports';
import type { ScorerPort } from './realtime.ports';
import type { SubmitOutcome, UndoOutcome } from '../scoring/scoring.types';

interface ScorerPresence {
  clientId: string;
  socketId: string;
  since: IsoDateTime;
}

/**
 * ============================================================================
 * 实时服务 —— Socket.IO 房间管理 + 广播收口
 * ============================================================================
 * 只做三件事：谁在哪个房间、谁是在线计分设备、该广播什么。
 * 业务读写通过 `RealtimeRegistry`（启动期注册的端口）拿，避免循环依赖。
 *
 * 为什么广播要收口在这里：离线补传走 REST、在线计分走 Socket.IO，
 * 如果广播只写在 Socket 分支里，用 REST 补传的事件就不会出现在电视大屏上。
 *
 * 房间约定：
 *   - `match:{matchId}`          所有人（观众只读、计分员可写）都在
 *   - `match:{matchId}:scorers`  只有计分员在，接收撤销栈等计分端专属事件
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;
  /** matchId → 在线计分设备（按 socketId 维度，同一设备多标签页也能看到）。 */
  private readonly scorers = new Map<string, Map<string, ScorerPresence>>();
  /** socketId → 已加入的比赛集合，断线时精确清理。 */
  private readonly socketMatches = new Map<string, Set<string>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get scorer(): ScorerPort {
    return RealtimeRegistry.getScorer();
  }

  attachServer(server: Server): void {
    this.server = server;
    this.logger.log('Socket.IO 实时通道已就绪');
  }

  // ------------------------------------------------------------------ 权限

  /** 计分口令校验：观众端只读无需口令，任何写操作都必须带。 */
  assertScorer(passcode: string | undefined): void {
    if (!passcode || passcode !== this.config.scorerPasscode) {
      throw DomainError.forbidden('INVALID_PASSCODE', '计分口令不正确');
    }
  }

  roomOf(matchId: string): string {
    return MATCH_ROOM(matchId);
  }

  // ------------------------------------------------------------------ 加入 / 离开

  /**
   * 加入比赛房间。
   *
   * 观众端只读，**不需要口令**（这是扫码即看的前提）；
   * 计分员需要口令才能拿到写权限与撤销栈。
   * 带上 `lastSeq` 时会把缺失的事件与最新状态直接回给客户端，
   * 省掉一次 REST 往返 —— 现场网络差的时候这一步很关键。
   */
  async join(
    client: Socket,
    payload: {
      matchId: string;
      role: RealtimeRole;
      passcode?: string;
      clientId?: string;
      lastSeq?: number;
    },
  ): Promise<JoinMatchAck> {
    const serverTime = new Date().toISOString();
    const role: RealtimeRole = payload.role === 'scorer' || payload.role === 'display' ? payload.role : 'audience';

    const detail = await RealtimeRegistry.getMatches()
      .getMatchDetail(payload.matchId)
      .catch(() => null);
    if (!detail) {
      return { ok: false, role, matchId: payload.matchId, serverTime, error: 'match_not_found' };
    }

    if (role === 'scorer') {
      if (payload.passcode !== this.config.scorerPasscode) {
        return { ok: false, role, matchId: payload.matchId, serverTime, error: 'invalid_passcode' };
      }
      if (detail.match.status === 'archived') {
        return { ok: false, role, matchId: payload.matchId, serverTime, error: 'match_archived' };
      }
    }

    await client.join(MATCH_ROOM(payload.matchId));
    if (role === 'scorer') await client.join(SCORER_ROOM(payload.matchId));

    const joined = this.socketMatches.get(client.id) ?? new Set<string>();
    joined.add(payload.matchId);
    this.socketMatches.set(client.id, joined);

    if (role === 'scorer') {
      const clientId = payload.clientId ?? client.id;
      const map = this.scorers.get(payload.matchId) ?? new Map<string, ScorerPresence>();
      map.set(client.id, { clientId, socketId: client.id, since: serverTime });
      this.scorers.set(payload.matchId, map);
      this.broadcastScorerPresence(payload.matchId);
    }

    const state = await this.scorer.requestState({
      matchId: payload.matchId,
      sinceSeq: payload.lastSeq ?? 0,
      withFeed: true,
    });

    return {
      ok: true,
      role,
      matchId: payload.matchId,
      serverTime,
      state: state.state,
      events: state.events,
      feed: state.feed,
      onlineScorers: role === 'scorer' ? this.onlineScorers(payload.matchId) : undefined,
    };
  }

  leave(client: Socket, matchId: string): void {
    void client.leave(MATCH_ROOM(matchId));
    void client.leave(SCORER_ROOM(matchId));
    this.socketMatches.get(client.id)?.delete(matchId);
    if (this.scorers.get(matchId)?.delete(client.id)) {
      this.broadcastScorerPresence(matchId);
    }
  }

  handleDisconnect(client: Socket): void {
    const matches = this.socketMatches.get(client.id);
    if (matches) {
      for (const matchId of matches) {
        if (this.scorers.get(matchId)?.delete(client.id)) {
          this.broadcastScorerPresence(matchId);
        }
      }
    }
    this.socketMatches.delete(client.id);
  }

  /** 当前在线计分设备（现场「另一台平板也在计分」提示用）。 */
  onlineScorers(matchId: string): Array<{ clientId: string; since: IsoDateTime }> {
    return [...(this.scorers.get(matchId)?.values() ?? [])].map((item) => ({
      clientId: item.clientId,
      since: item.since,
    }));
  }

  private broadcastScorerPresence(matchId: string): void {
    if (!this.server) return;
    this.server.to(MATCH_ROOM(matchId)).emit(SERVER_EVENTS.scorersPresence, {
      matchId,
      online: this.onlineScorers(matchId),
      at: new Date().toISOString(),
    });
  }

  // ------------------------------------------------------------------ 广播

  /**
   * 事件写入后的广播（REST 与 Socket.IO 共用）。
   * 同时推三样东西：增量事件 + 比分牌、图文直播文案、球员里程碑弹幕。
   */
  async publishSubmit(outcome: SubmitOutcome): Promise<void> {
    if (!this.server) return;
    const { broadcast, feedItems, state, highlights } = outcome;
    const room = MATCH_ROOM(broadcast.matchId);

    this.server.to(room).emit(SERVER_EVENTS.committed, broadcast);

    if (feedItems.length > 0) {
      this.server.to(room).emit(SERVER_EVENTS.feedAppended, {
        matchId: broadcast.matchId,
        items: feedItems,
        at: new Date().toISOString(),
      });
    }

    for (const highlight of highlights) {
      const payload: PlayerHighlightEvent = {
        matchId: broadcast.matchId,
        ...highlight,
        at: new Date().toISOString(),
      };
      this.server.to(room).emit(SERVER_EVENTS.playerHighlight, payload);
    }

    // 比分变化可能同时带来节次变化，补一条状态补丁，客户端不必自己推断
    this.server.to(room).emit(SERVER_EVENTS.statePatch, {
      matchId: broadcast.matchId,
      state,
      reason: state.period > 1 ? 'period_change' : 'resync',
      at: new Date().toISOString(),
    });
  }

  async publishUndo(outcome: UndoOutcome): Promise<void> {
    if (!this.server) return;
    const room = MATCH_ROOM(outcome.broadcast.matchId);
    this.server.to(room).emit(SERVER_EVENTS.undoApplied, outcome.broadcast);
    this.server.to(room).emit(SERVER_EVENTS.statePatch, {
      matchId: outcome.broadcast.matchId,
      state: outcome.result.state,
      reason: 'undo',
      at: new Date().toISOString(),
    });
  }

  publishStatePatch(
    matchId: string,
    state: MatchState,
    reason: 'period_change' | 'clock' | 'match_status' | 'resync' | 'undo' | 'manual',
  ): void {
    if (!this.server) return;
    this.server.to(MATCH_ROOM(matchId)).emit(SERVER_EVENTS.statePatch, {
      matchId,
      state,
      reason,
      at: new Date().toISOString(),
    });
  }

  publishFinished(matchId: string, state: MatchState, reason: 'normal' | 'forfeit' | 'aborted'): void {
    if (!this.server) return;
    this.server.to(MATCH_ROOM(matchId)).emit(SERVER_EVENTS.matchFinished, {
      matchId,
      reason,
      finalScoreboard: state.scoreboard,
      at: new Date().toISOString(),
    });
  }

  publishError(matchId: string | null, code: string, message: string): void {
    if (!this.server) return;
    const payload = { code, message, ...(matchId ? { matchId } : {}) };
    if (matchId) this.server.to(MATCH_ROOM(matchId)).emit(SERVER_EVENTS.error, payload);
    else this.server.emit(SERVER_EVENTS.error, payload);
  }

  // ------------------------------------------------------------------ 网关调用入口

  /** Socket.IO 提交事件 → 转调注册进来的 ScorerPort，然后广播。 */
  async submitViaSocket(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    events: import('@openhoopscore/contracts').GameEventDraft[];
    batchId?: string;
  }): Promise<SubmitEventsAck> {
    try {
      this.assertScorer(params.passcode);
      const outcome = await this.scorer.submit({
        matchId: params.matchId,
        clientId: params.clientId,
        passcode: params.passcode,
        events: params.events,
      });
      await this.publishSubmit(outcome);
      return {
        ok: true,
        batchId: params.batchId,
        acceptedCount: outcome.result.acceptedCount,
        duplicateCount: outcome.result.duplicateCount,
        rejectedCount: outcome.result.rejectedCount,
        serverSeq: outcome.state.lastSeq,
        rejected: outcome.result.results
          .filter((item) => item.status === 'rejected')
          .map((item) => ({ clientEventId: item.clientEventId, reason: item.reason ?? '未知原因' })),
      };
    } catch (error) {
      const domain = error instanceof DomainError ? error : null;
      return {
        ok: false,
        batchId: params.batchId,
        acceptedCount: 0,
        duplicateCount: 0,
        rejectedCount: params.events.length,
        serverSeq: 0,
        error:
          domain?.code === 'INVALID_PASSCODE'
            ? 'invalid_passcode'
            : domain?.code === 'TOO_MANY_EVENTS'
              ? 'too_many_events'
              : domain?.code === 'MATCH_NOT_FOUND'
                ? 'match_not_found'
                : 'invalid_event',
        rejected: params.events.map((event) => ({
          clientEventId: event.clientEventId,
          reason: (error as Error).message,
        })),
      };
    }
  }

  /** Socket.IO 撤销 → 转调 ScorerPort，然后广播。 */
  async undoViaSocket(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    targetEventId?: string;
    steps?: number;
  }): Promise<UndoAck> {
    try {
      this.assertScorer(params.passcode);
      const outcome = await this.scorer.undo(params);
      await this.publishUndo(outcome);
      return {
        ok: true,
        voidedEventIds: outcome.result.voidedEventIds,
        descriptions: outcome.result.descriptions,
      };
    } catch (error) {
      const domain = error instanceof DomainError ? error : null;
      return {
        ok: false,
        voidedEventIds: [],
        descriptions: [],
        error:
          domain?.code === 'NO_UNDOABLE_EVENT'
            ? 'nothing_to_undo'
            : domain?.code === 'INVALID_PASSCODE'
              ? 'invalid_passcode'
              : 'target_not_found',
      };
    }
  }

  /** 主动请求状态（断线重连兜底）。 */
  async requestState(payload: { matchId: string; sinceSeq?: number; withFeed?: boolean }): Promise<{
    ok: boolean;
    state?: MatchState;
    events?: GameEvent[];
    feed?: LiveFeedItem[];
    error?: string;
  }> {
    try {
      const result = await this.scorer.requestState(payload);
      return {
        ok: true,
        state: result.state,
        events: result.events,
        feed: payload.withFeed === false ? undefined : result.feed,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Socket.IO 结束比赛。 */
  async finishViaSocket(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    reason?: 'normal' | 'forfeit' | 'aborted';
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.assertScorer(params.passcode);
      const outcome = await this.scorer.finishMatch(params);
      this.publishFinished(params.matchId, outcome.state, params.reason ?? 'normal');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Socket.IO 设置节次 / 时钟。 */
  async setClockViaSocket(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    period?: number;
    gameClockSeconds?: number | null;
    running?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.assertScorer(params.passcode);
      const outcome = await this.scorer.setClock(params);
      this.publishStatePatch(params.matchId, outcome.state, 'clock');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  scoreboardOf(state: MatchState): Scoreboard {
    return state.scoreboard;
  }
}
