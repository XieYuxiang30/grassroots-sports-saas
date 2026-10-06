import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectMatch } from '@openhoopscore/contracts';
import type { GameEvent } from '@openhoopscore/contracts';
import { committed, draft, makeFixture } from '../helpers/fixtures';

/**
 * 投影（比分推导）测试。
 *
 * 这些断言同时约束服务端与计分端本地：两边跑的是同一个 `projectMatch`，
 * 只要这里绿了，就不会出现「本地显示 12:10、服务器显示 10:10」。
 */
describe('projectMatch（比分投影）', () => {
  function contextOf(fixture: ReturnType<typeof makeFixture>) {
    return {
      matchId: fixture.matchId,
      homeTeam: { teamId: fixture.homeTeamId, side: 'home' as const },
      awayTeam: { teamId: fixture.awayTeamId, side: 'away' as const },
      regulationPeriods: 4,
    };
  }

  function build(fixture: ReturnType<typeof makeFixture>, drafts: Parameters<typeof draft>[1][]) {
    const events: GameEvent[] = drafts.map((options, index) => committed(draft(fixture, options), index + 1));
    return events;
  }

  it('累计得分 / 分节得分 / 球员得分', () => {
    const fixture = makeFixture();
    const events = build(fixture, [
      { type: 'game_start', period: 1, offsetSeconds: 1 },
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, period: 1, offsetSeconds: 2 },
      { type: 'score', teamId: fixture.awayTeamId, playerId: fixture.players.away[0], points: 3, period: 1, offsetSeconds: 3 },
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[1], points: 1, period: 2, offsetSeconds: 4 },
    ]);

    const tally = projectMatch(events, contextOf(fixture), { assumeSorted: true });

    assert.equal(tally.score.home, 3);
    assert.equal(tally.score.away, 3);
    assert.equal(tally.score.homeByPeriod[1], 2);
    assert.equal(tally.score.homeByPeriod[2], 1);
    assert.equal(tally.score.awayByPeriod[1], 3);
    assert.equal(tally.players[fixture.players.home[0]!]!.points, 2);
    assert.equal(tally.players[fixture.players.away[0]!]!.threePointersMade, 1);
    assert.equal(tally.status, 'live');
    assert.equal(tally.appliedEventCount, 4);
  });

  it('撤销：void 事件让被指向的事件不再计分（比分回退）', () => {
    const fixture = makeFixture();
    const first = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, offsetSeconds: 2 });
    const firstEvent = committed(first, 1);
    const second = committed(draft(fixture, { type: 'score', teamId: fixture.awayTeamId, points: 3, offsetSeconds: 3 }), 2);
    // 复用同一个 draft 对象：clientTimestamp / clientId / clientEventId 必须保持一致，
    // 否则「作废」指向的就是另一条事件（这正是计划外事件漂移的典型 bug）。
    const voidDraft = draft(fixture, { type: 'void', offsetSeconds: 4, payload: { targetEventId: firstEvent.id, reason: 'scorer_undo' } });
    const voidEvent = committed(voidDraft, 3);

    const before = projectMatch([firstEvent, second], contextOf(fixture), { assumeSorted: true });
    assert.equal(before.score.home, 2);

    const after = projectMatch([firstEvent, second, voidEvent], contextOf(fixture), { assumeSorted: true });
    assert.equal(after.score.home, 0, '被撤销的两分必须从比分里消失');
    assert.equal(after.score.away, 3, '其它事件不受影响');
    assert.deepEqual(after.voidedEventIds, [firstEvent.id]);
    // 语义说明：被作废的事件**整体**从投影里剔除（等价于没发生过），
    // 撤销动作本身（void 事件）计入审计。所以 3 条事件里有效的是 2 条。
    assert.equal(after.appliedEventCount, 2, '被作废事件不计入，void 事件本身计入审计');
  });

  it('撤销后再得分：新事件照常累计（历史不可变，只是被忽略）', () => {
    const fixture = makeFixture();
    const wrong = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 3, offsetSeconds: 2 }), 1);
    const voidDraft = draft(fixture, { type: 'void', offsetSeconds: 3, payload: { targetEventId: wrong.id } });
    const voidEvent = committed(voidDraft, 2);
    const correct = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 4 }), 3);

    const tally = projectMatch([wrong, voidEvent, correct], contextOf(fixture), { assumeSorted: true });
    assert.equal(tally.score.home, 2, '撤销三分后重新记两分，结果应为 2');
  });

  it('全队犯规按节累计，可判断是否进入罚球状态', () => {
    const fixture = makeFixture();
    const events = build(fixture, [
      { type: 'team_foul', teamId: fixture.homeTeamId, period: 1, offsetSeconds: 1 },
      { type: 'team_foul', teamId: fixture.homeTeamId, period: 1, offsetSeconds: 2 },
      { type: 'team_foul', teamId: fixture.homeTeamId, period: 2, offsetSeconds: 3 },
      { type: 'foul', teamId: fixture.awayTeamId, playerId: fixture.players.away[1], period: 1, offsetSeconds: 4 },
    ]);

    const tally = projectMatch(events, contextOf(fixture), { assumeSorted: true });
    assert.equal(tally.home.teamFouls, 3);
    assert.equal(tally.home.teamFoulsByPeriod[1], 2);
    assert.equal(tally.home.teamFoulsByPeriod[2], 1);
    assert.equal(tally.away.teamFouls, 0);
    assert.equal(tally.players[fixture.players.away[1]!]!.fouls, 1);
  });

  it('暂停次数被统计', () => {
    const fixture = makeFixture();
    const events = build(fixture, [
      { type: 'timeout', teamId: fixture.homeTeamId, offsetSeconds: 1 },
      { type: 'timeout', teamId: fixture.homeTeamId, offsetSeconds: 2 },
      { type: 'timeout', teamId: fixture.awayTeamId, offsetSeconds: 3 },
    ]);
    const tally = projectMatch(events, contextOf(fixture), { assumeSorted: true });
    assert.equal(tally.home.timeoutsUsed, 2);
    assert.equal(tally.away.timeoutsUsed, 1);
  });

  it('period_end 推进节次，game_end 把状态置为 finished', () => {
    const fixture = makeFixture();
    const events = build(fixture, [
      { type: 'game_start', period: 1, offsetSeconds: 1 },
      { type: 'period_end', period: 1, offsetSeconds: 2 },
      { type: 'period_end', period: 2, offsetSeconds: 3 },
      { type: 'game_end', period: 4, offsetSeconds: 4 },
    ]);
    const tally = projectMatch(events, contextOf(fixture), { assumeSorted: true });
    assert.equal(tally.period, 3);
    assert.equal(tally.status, 'finished');
  });

  it('未按 seq 排序的输入也会先按确定性时钟重排（计分端离线队列场景）', () => {
    const fixture = makeFixture();
    const late = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 3, offsetSeconds: 300 }), 2);
    const early = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 100 }), 1);

    const tally = projectMatch([late, early], contextOf(fixture));
    assert.equal(tally.score.home, 5);
    assert.equal(tally.lastSeq, 2);
  });

  it('空事件流得到 0:0 / scheduled 的初始状态', () => {
    const fixture = makeFixture();
    const tally = projectMatch([], contextOf(fixture), { assumeSorted: true });
    assert.equal(tally.score.home, 0);
    assert.equal(tally.score.away, 0);
    assert.equal(tally.period, 1);
    assert.equal(tally.status, 'scheduled');
    assert.equal(tally.lastSeq, 0);
    assert.equal(tally.updatedAt, null);
  });
});
