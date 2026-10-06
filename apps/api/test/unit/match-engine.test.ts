import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MatchEngine } from '../../src/scoring/match-engine';
import type { MatchAggregate } from '../../src/store/store.port';
import { committed, draft, makeFixture } from '../helpers/fixtures';
import type { GameEvent } from '@openhoopscore/contracts';

/**
 * 比赛引擎测试：图文直播文案、撤销栈、球员里程碑、排行榜。
 * 这些是「观众端看到的东西」，错一个字段现场就会尴尬。
 */
describe('MatchEngine（直播文案与统计）', () => {
  const engine = new MatchEngine();

  function aggregateOf(fixture: ReturnType<typeof makeFixture>): MatchAggregate {
    const now = new Date().toISOString();
    return {
      match: {
        id: fixture.matchId,
        seasonId: null,
        competition: '社区篮球联赛',
        title: 'A 组第 3 轮',
        venue: '街道体育馆',
        scheduledAt: null,
        status: 'live',
        periodFormat: 'quarters',
        periodSeconds: 600,
        regulationPeriods: 4,
        shareCode: 'AB12CD',
        homeTeamId: fixture.homeTeamId,
        awayTeamId: fixture.awayTeamId,
        createdAt: now,
        updatedAt: now,
      },
      teams: {
        home: {
          id: fixture.homeTeamId,
          matchId: fixture.matchId,
          side: 'home',
          name: '东街猛虎',
          shortName: '猛虎',
          color: '#E4572E',
          players: fixture.players.home.map((id, index) => ({
            id,
            teamId: fixture.homeTeamId,
            jerseyNumber: String(index + 4),
            name: ['张三', '李四', '王五'][index]!,
            isStarter: index === 0,
            createdAt: now,
          })),
        },
        away: {
          id: fixture.awayTeamId,
          matchId: fixture.matchId,
          side: 'away',
          name: '西巷飞鹰',
          shortName: '飞鹰',
          color: '#2563EB',
          players: fixture.players.away.map((id, index) => ({
            id,
            teamId: fixture.awayTeamId,
            jerseyNumber: String(index + 7),
            name: ['赵六', '钱七', '孙八'][index]!,
            isStarter: index === 0,
            createdAt: now,
          })),
        },
      },
    };
  }

  function eventsOf(fixture: ReturnType<typeof makeFixture>, drafts: Parameters<typeof draft>[1][]): GameEvent[] {
    return drafts.map((options, index) => committed(draft(fixture, options), index + 1));
  }

  it('图文直播：比分快照随时间累加，最新在最前', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const events = eventsOf(fixture, [
      { type: 'game_start', period: 1, offsetSeconds: 1 },
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, period: 1, gameClockSeconds: 330, offsetSeconds: 2 },
      { type: 'score', teamId: fixture.awayTeamId, playerId: fixture.players.away[0], points: 3, period: 1, gameClockSeconds: 300, offsetSeconds: 3 },
    ]);

    const feed = engine.buildFeed(aggregate, events);

    assert.equal(feed.length, 3);
    assert.equal(feed[0]!.text.includes('赵六'), true, '最新一条应是客队三分');
    assert.equal(feed[0]!.homeScore, 2);
    assert.equal(feed[0]!.awayScore, 3);
    assert.equal(feed[0]!.clock, '05:00');
    assert.equal(feed[0]!.tone, 'away');
    assert.equal(feed[2]!.text, '比赛开始，双方跳球');
  });

  it('图文直播：被撤销的事件不产生条目，且比分快照会回退', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const wrong = draft(fixture, { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 3, offsetSeconds: 2 });
    const wrongEvent = committed(wrong, 1);
    const right = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, offsetSeconds: 3 }), 2);
    const voidEvent = committed(draft(fixture, { type: 'void', offsetSeconds: 4, payload: { targetEventId: wrongEvent.id } }), 3);
    const feed = engine.buildFeed(aggregate, [wrongEvent, right, voidEvent]);

    assert.equal(feed.length, 1, '作废的事件与撤销事件本身都不该出现在直播流里');
    assert.equal(feed[0]!.points, 2);
    assert.equal(feed[0]!.homeScore, 2, '三分被撤销后，快照比分必须是 2 分');
  });

  it('比分时间线按时间正序，可用于观众端画走势图', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const events = eventsOf(fixture, [
      { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 1 },
      { type: 'score', teamId: fixture.awayTeamId, points: 3, offsetSeconds: 2 },
    ]);
    const feed = engine.buildFeed(aggregate, events);
    const timeline = engine.buildTimeline(feed);

    assert.equal(timeline.length, 2);
    assert.deepEqual(timeline[0]!.homeScore, 2);
    assert.deepEqual(timeline[1]!.awayScore, 3);
    assert.ok(timeline[0]!.seq < timeline[1]!.seq);
  });

  it('撤销栈：最近发生的排最前，且描述能看懂', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const events = eventsOf(fixture, [
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, offsetSeconds: 1 },
      { type: 'foul', teamId: fixture.awayTeamId, playerId: fixture.players.away[1], offsetSeconds: 2 },
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[1], points: 3, offsetSeconds: 3 },
    ]);

    const stack = engine.buildUndoStack(aggregate, events);

    assert.equal(stack.length, 3);
    assert.match(stack[0]!.description, /李四/);
    assert.match(stack[0]!.description, /3 分/);
    assert.match(stack[1]!.description, /钱七/);
    assert.match(stack[1]!.description, /犯规/);
    assert.ok(stack[0]!.seq > stack[1]!.seq);
  });

  it('撤销栈：已被撤销的事件不再出现（不能撤销一个已经撤销的操作）', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const first = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, offsetSeconds: 1 }), 1);
    const second = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, offsetSeconds: 2 }), 2);
    const voidEvent = committed(draft(fixture, { type: 'void', offsetSeconds: 3, payload: { targetEventId: second.id } }), 3);

    const stack = engine.buildUndoStack(aggregate, [first, second, voidEvent]);
    assert.equal(stack.length, 1);
    assert.equal(stack[0]!.eventId, first.id);
  });

  it('状态投影：球员统计、在场状态、罚球状态', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const events = eventsOf(fixture, [
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 2, period: 1, gameClockSeconds: 500, offsetSeconds: 1, payload: { points: 2, shotType: 'layup' } },
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 3, period: 1, gameClockSeconds: 400, offsetSeconds: 2, payload: { points: 3, shotType: 'three' } },
      { type: 'foul', teamId: fixture.homeTeamId, playerId: fixture.players.home[1], period: 1, offsetSeconds: 3 },
      { type: 'turnover', teamId: fixture.homeTeamId, playerId: fixture.players.home[2], period: 1, offsetSeconds: 4 },
      { type: 'substitution', teamId: fixture.homeTeamId, period: 1, offsetSeconds: 5, payload: { playerInId: fixture.players.home[1], playerOutId: fixture.players.home[0] } },
      { type: 'team_foul', teamId: fixture.homeTeamId, period: 1, offsetSeconds: 6 },
    ]);

    const state = engine.buildState(aggregate, events);

    assert.equal(state.scoreboard.home.score, 5);
    assert.equal(state.scoreboard.leader, 'home');
    assert.equal(state.scoreboard.margin, 5);
    assert.equal(state.gameClockSeconds, 400);

    const star = state.home.players.find((player) => player.playerId === fixture.players.home[0])!;
    assert.equal(star.points, 5);
    assert.equal(star.threePointersMade, 1);
    assert.equal(star.madeByShotType.layup, 1);
    assert.equal(star.madeByShotType.three, 1);
    assert.equal(star.onCourt, false, '被换下的球员不应在场');

    const sub = state.home.players.find((player) => player.playerId === fixture.players.home[1])!;
    assert.equal(sub.fouls, 1);
    assert.equal(sub.onCourt, true, '替补上场的球员应在场');

    assert.deepEqual(engine.penaltyStatus(state, 1), { home: false, away: false });
  });

  it('排行榜：按得分排序并处理并列名次', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const events = eventsOf(fixture, [
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 3, offsetSeconds: 1 },
      { type: 'score', teamId: fixture.awayTeamId, playerId: fixture.players.away[0], points: 3, offsetSeconds: 2 },
      { type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[1], points: 2, offsetSeconds: 3 },
    ]);

    const state = engine.buildState(aggregate, events);
    const board = engine.buildLeaderboard(aggregate, state, 'points');

    assert.equal(board.entries[0]!.points, 3);
    assert.equal(board.entries[0]!.rank, 1);
    assert.equal(board.entries[1]!.rank, 1, '并列第一');
    assert.equal(board.entries[2]!.points, 2);
    assert.equal(board.entries[2]!.rank, 3, '并列后名次跳号，符合体育惯例');
  });

  it('里程碑：球员得分突破 20 分、五次犯规会触发高亮', () => {
    const fixture = makeFixture();
    const aggregate = aggregateOf(fixture);
    const drafts: Parameters<typeof draft>[1][] = [];
    for (let index = 0; index < 7; index += 1) {
      drafts.push({ type: 'score', teamId: fixture.homeTeamId, playerId: fixture.players.home[0], points: 3, offsetSeconds: index + 1 });
    }
    for (let index = 0; index < 5; index += 1) {
      drafts.push({ type: 'foul', teamId: fixture.awayTeamId, playerId: fixture.players.away[2], offsetSeconds: 100 + index });
    }
    const events = eventsOf(fixture, drafts);

    // previousState 必须取「最后一次得分之前」的状态，才能验证跨越 20 分那一刻的检测。
    const twentyPointIndex = drafts.findIndex((item, index) => index >= 6);
    const previousState = engine.buildState(aggregate, events.slice(0, twentyPointIndex));
    const state = engine.buildState(aggregate, events);

    const highlights = engine.detectHighlights(aggregate, state, previousState);
    assert.equal(state.home.players[0]!.points, 21, '7 记三分 = 21 分');
    assert.ok(
      highlights.some((item) => item.milestone === 'twenty_points' && item.playerId === fixture.players.home[0]),
      '应检测到跨过 20 分里程碑',
    );
    assert.ok(
      highlights.some((item) => item.milestone === 'fouled_out' && item.playerId === fixture.players.away[2]),
      '应检测到五次犯规离场',
    );
  });

  it('撤销后状态回到未开始：可用于「撤销全部得分」的边界场景', () => {
    const fixture = makeFixture();
    const aggregate = { ...aggregateOf(fixture), match: { ...aggregateOf(fixture).match, status: 'scheduled' as const } };
    const score = committed(draft(fixture, { type: 'score', teamId: fixture.homeTeamId, points: 2, offsetSeconds: 1 }), 1);
    const voidEvent = committed(draft(fixture, { type: 'void', offsetSeconds: 2, payload: { targetEventId: score.id } }), 2);

    const state = engine.buildState(aggregate, [score, voidEvent]);
    assert.equal(state.scoreboard.home.score, 0);
    assert.equal(state.scoreboard.margin, 0);
    assert.equal(state.scoreboard.leader, null);
  });
});
