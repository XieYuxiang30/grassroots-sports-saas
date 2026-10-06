import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  GameEventDraft,
  JoinMatchAck,
  JoinMatchPayload,
  ServerToClientEvents,
  SetClockPayload,
  SubmitEventsAck,
  SubmitEventsPayload,
  UndoAck,
  UndoPayload,
} from '@openhoopscore/contracts';
import { CLIENT_EVENTS } from '@openhoopscore/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config.tokens';
import { RealtimeService } from './realtime.service';

/** Socket.IO 客户端与服务端的双向事件类型（与 @openhoopscore/contracts 完全一致）。 */
type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * ============================================================================
 * 实时网关（Socket.IO）
 * ============================================================================
 * 为什么选 Socket.IO 而不是原生 WebSocket：
 *   - 自带「WebSocket 失败自动降级长轮询」，场馆网络经常只放行 80/443，
 *     纯 WebSocket 被中间设备掐断时它会自动换传输方式；
 *   - 自带房间（room）语义，观众扫码即 join(`match:{id}`)，广播一行代码；
 *   - 自带重连与投递确认（ack 回调），计分端每次写操作都能拿到明确结果，
 *     离线队列才知道该不该把本地事件标记为已同步。
 *
 * 本网关只做协议翻译与鉴权，业务全部在 RealtimeService / ScoringService。
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  // 现场网络差：放宽心跳与超时，避免观众端频繁「掉线重连」
  pingInterval: 20_000,
  pingTimeout: 25_000,
  maxHttpBufferSize: 1e7,
  allowEIO3: true,
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: IoServer;

  constructor(
    private readonly realtime: RealtimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  afterInit(server: IoServer): void {
    // 用配置覆盖装饰器里的默认心跳（部署时通过环境变量调节，无需改代码）
    server.engine.opts.pingInterval = this.config.socket.pingInterval;
    server.engine.opts.pingTimeout = this.config.socket.pingTimeout;
    this.realtime.attachServer(server as unknown as Server);
    this.logger.log(`实时网关已启动（ping ${server.engine.opts.pingInterval}ms / timeout ${server.engine.opts.pingTimeout}ms）`);
  }

  handleConnection(client: IoSocket): void {
    this.logger.debug(`客户端接入 ${client.id}（transport=${client.conn.transport.name}）`);
  }

  handleDisconnect(client: IoSocket): void {
    this.realtime.handleDisconnect(client as unknown as Socket);
  }

  onModuleDestroy(): void {
    /* 由 Nest 统一关闭 HTTP 服务，Socket.IO 随之释放 */
  }

  // ------------------------------------------------------------------ 加入 / 离开

  @SubscribeMessage(CLIENT_EVENTS.join)
  async onJoin(
    @ConnectedSocket() client: IoSocket,
    @MessageBody() payload: JoinMatchPayload,
  ): Promise<JoinMatchAck> {
    try {
      const result = await this.realtime.join(client as unknown as Socket, payload);
      if (!result.ok) {
        client.emit('error', {
          code: result.error ?? 'join_failed',
          message:
            result.error === 'match_not_found'
              ? '比赛不存在或已删除'
              : result.error === 'invalid_passcode'
                ? '计分口令不正确'
                : '比赛已归档，无法计分',
          matchId: payload?.matchId,
        });
      }
      return result;
    } catch (error) {
      this.logger.error(`加入房间失败：${(error as Error).message}`);
      return {
        ok: false,
        role: payload?.role ?? 'audience',
        matchId: payload?.matchId ?? '',
        serverTime: new Date().toISOString(),
        error: 'match_not_found',
      };
    }
  }

  @SubscribeMessage(CLIENT_EVENTS.leave)
  onLeave(@ConnectedSocket() client: IoSocket, @MessageBody() payload: { matchId: string }): { ok: boolean } {
    if (payload?.matchId) this.realtime.leave(client as unknown as Socket, payload.matchId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ 计分

  @SubscribeMessage(CLIENT_EVENTS.submit)
  async onSubmit(
    @ConnectedSocket() client: IoSocket,
    @MessageBody() payload: SubmitEventsPayload,
  ): Promise<SubmitEventsAck> {
    if (!payload?.matchId || !Array.isArray(payload.events)) {
      return {
        ok: false,
        acceptedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        serverSeq: 0,
        error: 'invalid_event',
      };
    }
    if (payload.events.length > this.config.maxSyncBatch) {
      return {
        ok: false,
        batchId: payload.batchId,
        acceptedCount: 0,
        duplicateCount: 0,
        rejectedCount: payload.events.length,
        serverSeq: 0,
        error: 'too_many_events',
        rejected: [],
      };
    }
    return this.realtime.submitViaSocket({
      matchId: payload.matchId,
      clientId: payload.clientId ?? client.id,
      passcode: payload.passcode,
      events: payload.events as unknown as GameEventDraft[],
      batchId: payload.batchId,
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.undo)
  async onUndo(@ConnectedSocket() client: IoSocket, @MessageBody() payload: UndoPayload): Promise<UndoAck> {
    if (!payload?.matchId) {
      return { ok: false, voidedEventIds: [], descriptions: [], error: 'target_not_found' };
    }
    return this.realtime.undoViaSocket({
      matchId: payload.matchId,
      clientId: payload.clientId ?? client.id,
      passcode: payload.passcode,
      targetEventId: payload.targetEventId,
      steps: payload.steps,
    });
  }

  // ------------------------------------------------------------------ 状态 / 时钟 / 结束

  @SubscribeMessage(CLIENT_EVENTS.requestState)
  async onRequestState(
    @ConnectedSocket() _client: IoSocket,
    @MessageBody() payload: { matchId: string; sinceSeq?: number; withFeed?: boolean },
  ) {
    if (!payload?.matchId) return { ok: false, error: 'matchId 不能为空' };
    return this.realtime.requestState(payload);
  }

  @SubscribeMessage(CLIENT_EVENTS.setClock)
  async onSetClock(
    @ConnectedSocket() _client: IoSocket,
    @MessageBody() payload: SetClockPayload,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!payload?.matchId) return { ok: false, error: 'matchId 不能为空' };
    return this.realtime.setClockViaSocket({
      matchId: payload.matchId,
      clientId: payload.clientId,
      passcode: payload.passcode,
      period: payload.period,
      gameClockSeconds: payload.gameClockSeconds,
      running: payload.running,
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.finish)
  async onFinish(
    @ConnectedSocket() _client: IoSocket,
    @MessageBody() payload: { matchId: string; clientId: string; passcode?: string; reason?: 'normal' | 'forfeit' | 'aborted' },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!payload?.matchId) return { ok: false, error: 'matchId 不能为空' };
    return this.realtime.finishViaSocket({
      matchId: payload.matchId,
      clientId: payload.clientId,
      passcode: payload.passcode,
      reason: payload.reason,
    });
  }
}
