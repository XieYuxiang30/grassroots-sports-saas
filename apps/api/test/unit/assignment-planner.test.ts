import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AssignmentPlanner, sortKeyOf } from '../../src/store/assignment-planner';
import { committed, draft, makeFixture } from '../helpers/fixtures';
import type { GameEvent } from '@openhoopscore/contracts';

/**
 * 事件写入规划器测试 —— 这是整个平台最关键的 30 行逻辑所在。
 * 覆盖：幂等、批内去重、离线补传插入、确定性 seq、校验拒绝、容量上限。
 */
describe('AssignmentPlanner（事件写入算法）', () => {
  const planner = new AssignmentPlanner();
  let idCounter = 0;
  const newId = () => `srv-${++idCounter}`;

  function plan(existing: GameEvent[], incoming: Parameters<typeof planner.plan>[0]['incoming'], fixture: ReturnType<typeof makeFixture>) {
    idCounter = 0;
    return planner.plan({
      existing,
      incoming,
      matchId: fixture.matchId,
      roster: fixture.roster,
      maxEventsPerMatch: 20_000,
      now: new Date('2024-06-01T12:00:00.000Z'),
      newId,
    });
  }

  it('首次写入：按 clientTimestamp 升序分配 seq', () => {
    const fixture = makeFixture();
    const later = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, offsetSeconds: 20 });
    const earlier = draft(fixture, { type: 'score', teamId: fixture.awayTeamId, playerId: fixture.players.away[0], points: 3, offsetSeconds: 10 });

    // 故意乱序提交
    const result = plan([], [later, earlier], fixture);

    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]!.clientEventId, earlier.clientEventId, '更早的事件应排在第 1 位');
    assert.equal(result.events[0]!.seq, 1);
    assert.equal(result.events[1]!.seq, 2);
    assert.equal(result.finalSeq, 2);
    assert.equal(result.reordered, false, '首次写入不算重排');
    assert.equal(result.accepted.length, 2);
  });

  it('幂等：同一个 clientEventId 重复提交只接受一次', () => {
    const fixture = makeFixture();
    const one = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 5 });
    const first = plan([], [one], fixture);
    const firstEvent = first.events[0]!;

    // 断网重连后把同一条又推了一遍
    const second = plan(first.events, [one], fixture);

    assert.equal(second.accepted.length, 0);
    assert.equal(second.duplicates.length, 1);
    assert.equal(second.duplicates[0]!.eventId, firstEvent.id, '必须回传服务端真实事件 id');
    assert.equal(second.duplicates[0]!.seq, firstEvent.seq, '必须回传服务端真实 seq，客户端才能清本地队列');
    assert.equal(second.events.length, 1, '事件总数不能变');
    assert.equal(second.finalSeq, 1);
  });

  it('同一批次内出现重复幂等键：只接受第一条，其余判为幂等命中', () => {
    const fixture = makeFixture();
    const base = draft(fixture, { type: 'foul', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], offsetSeconds: 7 });
    const duplicateInBatch = { ...base };

    const result = plan([], [base, duplicateInBatch], fixture);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 0);
    // 语义说明：先出现的那条已经被接受并登记进幂等表，所以后面这条属于
    // 「幂等命中（duplicate）」而不是「参数非法（rejected）」。
    // 计分端据此把本地队列标记为已同步，而不是当失败无限重试。
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0]!.clientEventId, base.clientEventId);
    assert.equal(result.events.length, 1);
  });

  it('离线补传：旧事件插入时间线中间，后续事件整体后移 1 位', () => {
    const fixture = makeFixture();
    // 在线阶段记了 3 条
    const online = [
      draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 100 }),
      draft(fixture, { type: 'score', teamId: fixture.awayTeamId, points: 3, offsetSeconds: 200 }),
      draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 1, offsetSeconds: 300 }),
    ];
    const initial = plan([], online, fixture);
    const seqBefore = new Map(initial.events.map((event) => [event.id, event.seq]));
    assert.deepEqual([...seqBefore.values()], [1, 2, 3]);

    // 另一台断网的平板补传了一条「发生在 t=150」的事件
    const offlineEvent = draft(fixture, {
      type: 'score',
      teamId: fixture.awayTeamId,
      points: 2,
      offsetSeconds: 150,
      clientId: 'tablet-b',
    });
    const merged = plan(initial.events, [offlineEvent], fixture);

    assert.equal(merged.events.length, 4);
    assert.equal(merged.reordered, true, '补传插入必须标记 reordered，让客户端重拉直播流');

    // 这条补传事件排在原来第 1 条之后，于是它拿到 seq=2，原来的 2/3 顺延成 3/4。
    // 「整体后移恰好 1 位」是正确且必要的行为：seq 必须始终等于事件在时间线里的排名。
    const inserted = merged.events[1]!;
    assert.equal(inserted.clientEventId, offlineEvent.clientEventId);
    assert.equal(inserted.seq, 2);
    assert.equal(merged.events[0]!.seq, 1, '插入点之前的事件不受影响');
    for (const event of merged.events) {
      const before = seqBefore.get(event.id);
      if (before === undefined || event.id === inserted.id) continue;
      if (before >= 2) {
        assert.equal(event.seq, before + 1, `排在插入点之后的事件应整体后移 1 位（${event.id}）`);
      } else {
        assert.equal(event.seq, before, `插入点之前的事件不应改变（${event.id}）`);
      }
    }

    // 时间线顺序正确
    const ordered = merged.events.map((event) => event.clientTimestamp);
    assert.deepEqual([...ordered].sort(), ordered, '事件必须按 clientTimestamp 升序');
  });

  it('seq 由排序键唯一决定：同一事件在任何批次里都落在同一个名次上', () => {
    const fixture = makeFixture();
    const early = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 100 });
    const late = draft(fixture, { type: 'score', teamId: fixture.awayTeamId, points: 3, offsetSeconds: 200 });

    // 先落 late，再补传 early
    const step1 = plan([], [late], fixture);
    const step2 = plan(step1.events, [early], fixture);

    const earlySeqWhenAlone = plan([], [early], fixture).events[0]!.seq;
    const lateSeqWhenAlone = plan([], [late], fixture).events[0]!.seq;

    // early 单独看是第 1 名；late 单独看也是第 1 名，但两者同时存在时它必须让位到第 2 名。
    assert.equal(step2.events.find((event) => event.clientEventId === early.clientEventId)!.seq, earlySeqWhenAlone);
    assert.equal(step2.events.find((event) => event.clientEventId === late.clientEventId)!.seq, lateSeqWhenAlone + 1);
  });

  it('确定性：同一批事件以任意顺序提交，最终 seq 完全一致', () => {
    const fixture = makeFixture();
    const batch = [
      draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 30, clientId: 'tablet-a' }),
      draft(fixture, { type: 'score', teamId: fixture.awayTeamId, points: 3, offsetSeconds: 30, clientId: 'tablet-b' }),
      draft(fixture, { type: 'foul', teamId: fixture.homeTeamId, playerId: fixture.players.home[1], offsetSeconds: 30, clientId: 'tablet-a' }),
    ];

    const forward = plan([], batch, fixture);
    const backward = plan([], [...batch].reverse(), fixture);
    const shuffled = plan([], [batch[1]!, batch[2]!, batch[0]!], fixture);

    const seqOf = (events: GameEvent[]) =>
      events.map((event) => `${event.clientEventId}=${event.seq}`).sort().join('|');

    assert.equal(seqOf(forward.events), seqOf(backward.events));
    assert.equal(seqOf(forward.events), seqOf(shuffled.events));
  });

  it('同刻跨设备事件：按 clientId 稳定排序，不出现顺序抖动', () => {
    const fixture = makeFixture();
    const sameTime = '2024-06-01T10:05:00.000Z';
    const fromB = draft(fixture, { type: 'score', teamId: fixture.awayTeamId, points: 2, clientTimestamp: sameTime, clientId: 'tablet-b' });
    const fromA = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, clientTimestamp: sameTime, clientId: 'tablet-a' });

    const result = plan([], [fromB, fromA], fixture);

    assert.equal(result.events[0]!.clientId, 'tablet-a');
    assert.ok(sortKeyOf(result.events[0]!) < sortKeyOf(result.events[1]!));
  });

  it('校验：球员不属于该队 / 节次非法 / 得分值非法都会被拒绝且不影响其它事件', () => {
    const fixture = makeFixture();
    const wrongTeam = draft(fixture, {
      type: 'score',
      teamId: fixture.homeTeamId,
      playerId: fixture.players.away[0], // 客队球员却记在主队事件上
      points: 2,
      offsetSeconds: 1,
    });
    const badPeriod = { ...draft(fixture, { type: 'foul', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], offsetSeconds: 2 }), period: 99 };
    const badPoints = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 3, payload: { points: 4 } });
    const good = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 3, offsetSeconds: 4 });

    const result = plan([], [wrongTeam, badPeriod, badPoints, good], fixture);

    assert.equal(result.rejected.length, 3);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.events.length, 1);
    assert.match(result.rejected[0]!.reason, /不一致/);
    assert.match(result.rejected[1]!.reason, /period/);
    assert.match(result.rejected[2]!.reason, /points/);
  });

  it('容量上限：达到 maxEventsPerMatch 后拒绝新事件', () => {
    const fixture = makeFixture();
    const existing = [
      committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 1, offsetSeconds: 1 }), 1),
    ];
    idCounter = 0;
    const result = planner.plan({
      existing,
      incoming: [draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 2 })],
      matchId: fixture.matchId,
      roster: fixture.roster,
      maxEventsPerMatch: 1,
      now: new Date(),
      newId,
    });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /上限/);
  });

  it('rankOf 与 plan 的结果一致（两种实现同源）', () => {
    const fixture = makeFixture();
    const batch = [
      draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 10 }),
      draft(fixture, { type: 'score', teamId: fixture.awayTeamId, points: 3, offsetSeconds: 20 }),
    ];
    const result = plan([], batch, fixture);
    for (const event of result.events) {
      assert.equal(planner.rankOf(event, result.events), event.seq);
    }
  });

  it('客户端时间明显跑到未来时会被夹到服务端时间（防止时间线错乱）', () => {
    const fixture = makeFixture();
    const future = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, clientTimestamp: '2030-01-01T00:00:00.000Z' });
    const result = plan([], [future], fixture);
    assert.equal(result.events[0]!.clientTimestamp, '2024-06-01T12:00:00.000Z');
  });
});
