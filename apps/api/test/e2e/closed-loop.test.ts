import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import type {
  GameEventDraft,
  JoinMatchAck,
  MatchDetail,
  QueryEventsResponse,
  SubmitEventsResult,
  UndoResult,
} from '@openhoopscore/contracts';

/**
 * ============================================================================
 * 端到端测试：证明「计分记录 → 实时展示」这个核心闭环真的跑通了
 * ============================================================================
 * 用真实的 HTTP + 真实的 Socket.IO 通道，覆盖三件在真机上最容易出问题的事：
 *   1. 计分员写入后，**已连接的观众立刻收到新比分**（不靠轮询）；
 *   2. **断网 → 本地记录 → 恢复后批量补传**，比分正确且不重复计分；
 *   3. **撤销**后比分回退，且观众端也收到回退。
 *
 * 说明：测试进程内启动 Nest 应用并监听临时端口，用 fetch / socket.io-client 打真实网络。
 * 这样不需要任何 mock，暴露的失败就是真实失败。
 */
describe('端到端：计分 → 实时展示闭环', () => {
  let app: INestApplication;
  let baseUrl: string;
  let dataDir: string;
  const sockets: Socket[] = [];
  const PASSCODE = 'test-passcode';

  before(async () => {
    dataDir = await mkdtemp(joinPath(tmpdir(), 'hoop-e2e-'));
    process.env.STORAGE_DRIVER = 'json';
    process.env.DATA_DIR = dataDir;
    process.env.SCORER_PASSCODE = PASSCODE;
    process.env.NODE_ENV = 'test';
    process.env.SERVE_WEB_ASSETS = 'false';
    process.env.CORS_ORIGINS = '*';

    // 动态 import：保证上面的环境变量在加载 AppModule（会读取配置）之前就已就位
    const { AppModule } = await import('../../src/app.module');
    const { AllExceptionsFilter } = await import('../../src/common/all-exceptions.filter');

    app = await NestFactory.create(AppModule.register(), { logger: false, bodyParser: true });
    app.setGlobalPrefix('api', { exclude: ['docs', 'docs-json', 'healthz'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.enableCors({ origin: true, credentials: true });
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const socket of sockets) socket.disconnect();
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ HTTP 辅助

  async function api<T>(path: string, init?: RequestInit & { passcode?: string }): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init?.passcode) headers['x-scorer-passcode'] = init.passcode;
    const response = await fetch(`${baseUrl}/api${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body,
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async function createMatch(competition = '端到端测试赛'): Promise<MatchDetail> {
    const response = await api<MatchDetail>('/matches', {
      method: 'POST',
      body: JSON.stringify({
        competition,
        title: 'A 组第 1 轮',
        venue: '街道体育馆',
        periodFormat: 'quarters',
        periodSeconds: 600,
        home: {
          name: '东街猛虎',
          shortName: '猛虎',
          color: '#E4572E',
          players: [
            { name: '张三', jerseyNumber: '4', isStarter: true },
            { name: '李四', jerseyNumber: '5', isStarter: true },
          ],
        },
        away: {
          name: '西巷飞鹰',
          shortName: '飞鹰',
          color: '#2563EB',
          players: [{ name: '赵六', jerseyNumber: '7', isStarter: true }],
        },
      }),
    });
    assert.equal(response.status, 201, `创建比赛失败：${JSON.stringify(response.body)}`);
    return response.body;
  }

  function connect(): Socket {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  function joinMatch(socket: Socket, payload: unknown): Promise<JoinMatchAck> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('match:join 超时')), 6000);
      socket.emit('match:join', payload as never, (ack: JoinMatchAck) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  function draftOf(
    matchId: string,
    teamId: string,
    playerId: string | null,
    points: 1 | 2 | 3,
    options: { clientId?: string; offsetMs?: number; period?: number } = {},
  ): GameEventDraft {
    return {
      id: randomUUID(),
      matchId,
      type: 'score',
      teamId,
      playerId,
      points: 0,
      period: options.period ?? 1,
      gameClockSeconds: 480,
      clientTimestamp: new Date(Date.now() + (options.offsetMs ?? 0)).toISOString(),
      clientId: options.clientId ?? 'tablet-a',
      clientEventId: randomUUID(),
      payload: { points, shotType: points === 3 ? 'three' : points === 1 ? 'free_throw' : 'mid' },
    } as GameEventDraft;
  }

  // ------------------------------------------------------------------ 用例

  it('健康检查暴露存储驱动与投影内核版本', async () => {
    const { status, body } = await api<{ status: string; storageDriver: string; projectionVersion: string }>('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.storageDriver, 'json');
    assert.ok(body.projectionVersion, '投影版本号必须存在，多端排查不一致时靠它');
  });

  it('创建比赛返回分享码，且能用分享码扫码进房', async () => {
    const detail = await createMatch('分享码测试');
    assert.match(detail.match.shareCode, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    assert.equal(detail.teams.home.players.length, 2);

    // 小写 + 带空格的输入也要能进（现场手输场景）
    const byCode = await api<MatchDetail>(`/matches/by-code/${detail.match.shareCode.toLowerCase()}`);
    assert.equal(byCode.status, 200);
    assert.equal(byCode.body.match.id, detail.match.id);

    const missing = await api<{ code: string }>('/matches/by-code/ZZZZZZ');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SHARE_CODE_NOT_FOUND');
  });

  it('计分员写入后，已连接的观众立即收到新比分（实时闭环）', async () => {
    const detail = await createMatch('实时广播测试');
    const matchId = detail.match.id;
    const homeTeamId = detail.teams.home.id;
    const awayTeamId = detail.teams.away.id;

    const audience = connect();
    const audienceJoin = await joinMatch(audience, { matchId, role: 'audience' });
    assert.equal(audienceJoin.ok, true);
    assert.equal(audienceJoin.state?.scoreboard.home.score, 0);

    // 观众先挂上监听，再让计分员写
    const committed = new Promise<{ scoreboard: { home: { score: number }; away: { score: number } }; finalSeq: number }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('观众端没有收到 events:committed 广播')), 8000);
        audience.once('events:committed', (payload: any) => {
          clearTimeout(timer);
          resolve(payload);
        });
      },
    );

    const scorer = connect();
    const scorerJoin = await joinMatch(scorer, { matchId, role: 'scorer', passcode: PASSCODE, clientId: 'tablet-a' });
    assert.equal(scorerJoin.ok, true);
    assert.equal(scorerJoin.onlineScorers?.length, 1, '计分设备应出现在在线列表里');

    const submitted = await new Promise<{ ok: boolean; acceptedCount: number; serverSeq: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('scoring:submit 超时')), 8000);
      scorer.emit(
        'scoring:submit',
        {
          matchId,
          clientId: 'tablet-a',
          passcode: PASSCODE,
          batchId: 'batch-1',
          events: [draftOf(matchId, homeTeamId, detail.teams.home.players[0]!.id, 3)],
        } as never,
        (ack: any) => {
          clearTimeout(timer);
          resolve(ack);
        },
      );
    });

    assert.equal(submitted.ok, true);
    assert.equal(submitted.acceptedCount, 1);

    const broadcast = await committed;
    assert.equal(broadcast.scoreboard.home.score, 3, '观众端必须立刻看到 3 分');
    assert.equal(broadcast.scoreboard.away.score, 0);
    assert.ok(broadcast.finalSeq >= 1);

    // 观众端 REST 拉到的权威状态必须与广播一致（两条链路不能各说各话）
    const live = await api<{ state: { scoreboard: { home: { score: number } } }; feed: Array<{ text: string }> }>(
      `/matches/${matchId}/live`,
    );
    assert.equal(live.body.state.scoreboard.home.score, 3);
    assert.ok(
      live.body.feed.some((item) => item.text.includes('张三') && item.text.includes('三分')),
      `图文直播应出现「张三命中三分」，实际：${JSON.stringify(live.body.feed.map((f) => f.text))}`,
    );
  });

  it('离线优先：断网记录 → 恢复后批量补传 → 比分正确且不重复计分', async () => {
    const detail = await createMatch('离线补传测试');
    const matchId = detail.match.id;
    const homeTeamId = detail.teams.home.id;
    const homePlayers = detail.teams.home.players;

    // ---- 在线阶段：记 1 条 ----
    const online = await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({
        clientId: 'tablet-a',
        events: [draftOf(matchId, homeTeamId, homePlayers[0]!.id, 2, { offsetMs: 0 })],
      }),
    });
    assert.equal(online.status, 201);
    assert.equal(online.body.acceptedCount, 1);

    // ---- 断网阶段：本地攒 3 条（画面还在更新，但服务端不知道） ----
    const offlineBatch: GameEventDraft[] = [
      draftOf(matchId, homeTeamId, homePlayers[0]!.id, 3, { clientId: 'tablet-b', offsetMs: 60_000 }),
      draftOf(matchId, homeTeamId, homePlayers[1]!.id, 2, { clientId: 'tablet-b', offsetMs: 61_000 }),
      draftOf(matchId, homeTeamId, homePlayers[1]!.id, 1, { clientId: 'tablet-b', offsetMs: 62_000 }),
    ];

    // 网络恢复：一次批量补传
    const sync = await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-b', sinceSeq: online.body.state.lastSeq, events: offlineBatch }),
    });

    assert.equal(sync.status, 201);
    assert.equal(sync.body.acceptedCount, 3, '积压的 3 条都要被接受');
    assert.equal(sync.body.duplicateCount, 0);
    assert.equal(sync.body.rejectedCount, 0);
    // 2 + 3 + 2 + 1 = 8
    assert.equal(sync.body.state.scoreboard.home.score, 8, '补传后总分必须是 8');

    // ---- 幂等：断网客户端因为没收到 ack，把同一批又推了一遍 ----
    const retry = await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-b', events: offlineBatch }),
    });
    assert.equal(retry.body.acceptedCount, 0, '重推不能重复计分');
    assert.equal(retry.body.duplicateCount, 3, '三条都应判为幂等命中');
    assert.equal(retry.body.state.scoreboard.home.score, 8, '比分不能因为重推而变大');

    // ---- 本地队列对账：客户端可以据此安全清空本地积压 ----
    const reconcile = await api<{ acknowledged: string[]; unknown: string[] }>(`/matches/${matchId}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ clientEventIds: [...offlineBatch.map((event) => event.clientEventId), 'not-sent-yet'] }),
    });
    assert.equal(reconcile.body.acknowledged.length, 3);
    assert.deepEqual(reconcile.body.unknown, ['not-sent-yet']);

    // ---- 增量拉取：断线重连的客户端只补缺失的部分 ----
    const events = await api<QueryEventsResponse>(`/matches/${matchId}/events?sinceSeq=1`);
    assert.equal(events.body.events.length, 3);
    assert.ok(events.body.events.every((event) => event.seq > 1));
  });

  it('撤销：不删历史，只追加 void 事件，比分回退且观众端同步收到', async () => {
    const detail = await createMatch('撤销测试');
    const matchId = detail.match.id;
    const homeTeamId = detail.teams.home.id;

    await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({
        clientId: 'tablet-a',
        events: [
          draftOf(matchId, homeTeamId, detail.teams.home.players[0]!.id, 3, { offsetMs: 0 }),
          draftOf(matchId, homeTeamId, detail.teams.home.players[0]!.id, 2, { offsetMs: 1000 }),
        ],
      }),
    });

    const before = await api<{ state: { scoreboard: { home: { score: number } } }; undoable: Array<{ description: string }> }>(
      `/matches/${matchId}/live`,
    );
    assert.equal(before.body.state.scoreboard.home.score, 5);
    assert.equal(before.body.undoable.length, 2);
    // 撤销栈从上往下是「最近发生的先撤」：先写 3 分、再写 2 分，所以最上面是那条 2 分
    assert.match(before.body.undoable[0]!.description, /2 分/, '撤销栈最上面应是最近一次得分');
    assert.match(before.body.undoable[1]!.description, /3 分/);

    // 观众端挂上监听，验证撤销也会实时推给观众
    const audience = connect();
    await joinMatch(audience, { matchId, role: 'audience' });
    const undoBroadcast = new Promise<{ voidedEventIds: string[]; descriptions: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('观众端没有收到 undo:applied 广播')), 8000);
      audience.once('undo:applied', (payload: any) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    const undone = await api<UndoResult>(`/matches/${matchId}/undo`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a', steps: 2 }),
    });

    assert.equal(undone.body.voidedEventIds.length, 2);
    assert.equal(undone.body.descriptions.length, 2);
    assert.equal(undone.body.state.scoreboard.home.score, 0, '撤两步后比分必须回到 0');

    const broadcast = await undoBroadcast;
    assert.equal(broadcast.voidedEventIds.length, 2);
    assert.match(broadcast.descriptions[0]!, /2 分/);

    // 历史事件一条没少：2 条得分 + 2 条 void
    const events = await api<QueryEventsResponse>(`/matches/${matchId}/events`);
    assert.equal(events.body.events.length, 4, '撤销不删除历史事件');
    assert.equal(events.body.events.filter((event) => event.type === 'void').length, 2);

    // 再撤销就没有可撤销的了
    const nothing = await api<{ code: string }>(`/matches/${matchId}/undo`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a' }),
    });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.code, 'NO_UNDOABLE_EVENT');
  });

  it('鉴权：没有计分口令的写操作一律 403，观众端只读不受影响', async () => {
    const detail = await createMatch('鉴权测试');
    const matchId = detail.match.id;

    const noPasscode = await api<{ code: string }>(`/matches/${matchId}/events`, {
      method: 'POST',
      body: JSON.stringify({ clientId: 'attacker', events: [draftOf(matchId, detail.teams.home.id, null, 3)] }),
    });
    assert.equal(noPasscode.status, 403);
    assert.equal(noPasscode.body.code, 'INVALID_PASSCODE');

    // 伪造口令也不行
    const wrongPasscode = await api<{ code: string }>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: 'wrong',
      body: JSON.stringify({ clientId: 'attacker', events: [draftOf(matchId, detail.teams.home.id, null, 3)] }),
    });
    assert.equal(wrongPasscode.status, 403);

    // Socket.IO 侧同样拦截
    const scorer = connect();
    const ack = await joinMatch(scorer, { matchId, role: 'scorer', passcode: 'wrong', clientId: 'attacker' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'invalid_passcode');

    // 观众端不需要口令
    const audience = connect();
    const audienceAck = await joinMatch(audience, { matchId, role: 'audience' });
    assert.equal(audienceAck.ok, true);

    // 比分没有被篡改
    const live = await api<{ state: { scoreboard: { home: { score: number } } } }>(`/matches/${matchId}/live`);
    assert.equal(live.body.state.scoreboard.home.score, 0);
  });

  it('校验：球员不属于本场比赛会被拒绝，且不影响同批其它事件', async () => {
    const detail = await createMatch('校验测试');
    const matchId = detail.match.id;

    const invalid = draftOf(matchId, detail.teams.home.id, randomUUID(), 3);
    const valid = draftOf(matchId, detail.teams.home.id, detail.teams.home.players[0]!.id, 2, { offsetMs: 10 });

    const response = await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a', events: [invalid, valid] }),
    });

    assert.equal(response.body.acceptedCount, 1);
    assert.equal(response.body.rejectedCount, 1);
    assert.match(response.body.results.find((item) => item.status === 'rejected')!.reason!, /不属于本场比赛/);
    assert.equal(response.body.state.scoreboard.home.score, 2);
  });

  it('结束比赛后观众端收到 match:finished，且比赛状态变为 finished', async () => {
    const detail = await createMatch('结束比赛测试');
    const matchId = detail.match.id;

    await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a', events: [draftOf(matchId, detail.teams.home.id, null, 2)] }),
    });

    const audience = connect();
    await joinMatch(audience, { matchId, role: 'audience' });
    const finished = new Promise<{ reason: string; finalScoreboard: { home: { score: number } } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('观众端没有收到 match:finished')), 8000);
      audience.once('match:finished', (payload: any) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    const response = await api<{ state: { status: string } }>(`/matches/${matchId}/finish`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a', reason: 'normal' }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.state.status, 'finished');

    const broadcast = await finished;
    assert.equal(broadcast.reason, 'normal');
    assert.equal(broadcast.finalScoreboard.home.score, 2);

    const detailAfter = await api<MatchDetail>(`/matches/${matchId}`);
    assert.equal(detailAfter.body.match.status, 'finished');
  });

  it('无副作用试算与权威投影结果一致（防止两端算分不一致）', async () => {
    const detail = await createMatch('试算一致性测试');
    const matchId = detail.match.id;
    const home = detail.teams.home.id;

    const batch = [
      draftOf(matchId, home, detail.teams.home.players[0]!.id, 3, { offsetMs: 0 }),
      draftOf(matchId, home, detail.teams.home.players[1]!.id, 2, { offsetMs: 1000 }),
    ];

    const preview = await api<{ homeScore: number; awayScore: number; projectionVersion: string }>(
      `/matches/${matchId}/preview`,
      { method: 'POST', body: JSON.stringify({ events: batch }) },
    );
    assert.equal(preview.body.homeScore, 5);

    // 试算不能落库
    const liveBefore = await api<{ state: { scoreboard: { home: { score: number } } } }>(`/matches/${matchId}/live`);
    assert.equal(liveBefore.body.state.scoreboard.home.score, 0, 'preview 必须是只读的');

    const committed = await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a', events: batch }),
    });
    assert.equal(committed.body.state.scoreboard.home.score, preview.body.homeScore, '试算必须与服务端权威结果一致');
  });

  it('观众端带 lastSeq 加入房间时，直接拿到缺失的事件（省掉一次 REST 往返）', async () => {
    const detail = await createMatch('断线重连测试');
    const matchId = detail.match.id;

    await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({
        clientId: 'tablet-a',
        events: [draftOf(matchId, detail.teams.home.id, null, 2, { offsetMs: 0 })],
      }),
    });

    const reconnecting = connect();
    const ack = await joinMatch(reconnecting, { matchId, role: 'audience', lastSeq: 0 });
    assert.equal(ack.ok, true);
    assert.equal(ack.state?.scoreboard.home.score, 2, '必须带上权威状态');
    assert.equal(ack.events?.length, 1, '必须把缺失的事件一起推给客户端');
    assert.ok((ack.feed?.length ?? 0) >= 1, '必须带上图文直播流，观众中途进场也能看到上下文');
  });

  it('归档后的比赛拒绝继续计分', async () => {
    const detail = await createMatch('归档测试');
    const matchId = detail.match.id;

    const archived = await api<MatchDetail>(`/matches/${matchId}/archive`, { method: 'POST' });
    assert.equal(archived.body.match.status, 'archived');

    const rejected = await api<{ code: string }>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({ clientId: 'tablet-a', events: [draftOf(matchId, detail.teams.home.id, null, 2)] }),
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'MATCH_ARCHIVED');
  });

  it('球员榜按得分排序，且能从比赛详情里看到两队名单', async () => {
    const detail = await createMatch('球员榜测试');
    const matchId = detail.match.id;
    const homePlayers = detail.teams.home.players;

    await api<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      passcode: PASSCODE,
      body: JSON.stringify({
        clientId: 'tablet-a',
        events: [
          draftOf(matchId, detail.teams.home.id, homePlayers[0]!.id, 3, { offsetMs: 0 }),
          draftOf(matchId, detail.teams.home.id, homePlayers[1]!.id, 2, { offsetMs: 1000 }),
          draftOf(matchId, detail.teams.away.id, detail.teams.away.players[0]!.id, 1, { offsetMs: 2000 }),
        ],
      }),
    });

    const board = await api<{ entries: Array<{ name: string; points: number; rank: number }> }>(
      `/matches/${matchId}/leaderboard?sortedBy=points`,
    );
    assert.equal(board.body.entries[0]!.name, '张三');
    assert.equal(board.body.entries[0]!.points, 3);
    assert.equal(board.body.entries[0]!.rank, 1);
    assert.equal(board.body.entries[2]!.points, 1);
  });
});
