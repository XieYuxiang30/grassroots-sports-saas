import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { JsonFileStore } from '../../src/store/json-file.store';
import { draft, makeFixture } from '../helpers/fixtures';
import type { MatchAggregate } from '../../src/store/store.port';

/**
 * JSON 文件驱动测试（零基础设施模式的正确性）。
 *
 * 重点不是 CRUD，而是两条容易出错的工程约束：
 *   1. **并发写入不能丢数据**：计分端补传与观众端请求会同时打进来，
 *      所以写入必须经过队列串行化；
 *   2. **落盘必须原子**：断电/强杀不能留下半个 JSON 文件。
 */
describe('JsonFileStore（零依赖文件存储）', () => {
  let dir: string;
  let store: JsonFileStore;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hoop-store-'));
    store = new JsonFileStore(dir);
    await store.init();
  });

  after(async () => {
    await store.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function createMatch(competition = '社区联赛'): Promise<MatchAggregate> {
    return store.createMatch({
      seasonId: null,
      competition,
      title: 'A 组第 1 轮',
      venue: '街道体育馆',
      scheduledAt: null,
      periodFormat: 'quarters',
      periodSeconds: 600,
      regulationPeriods: 4,
      shareCode: `T${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      home: {
        name: '主队',
        shortName: '主',
        color: '#E4572E',
        players: [
          { name: '张三', jerseyNumber: '4', isStarter: true },
          { name: '李四', jerseyNumber: '5', isStarter: true },
        ],
      },
      away: {
        name: '客队',
        shortName: '客',
        color: '#2563EB',
        players: [{ name: '赵六', jerseyNumber: '7', isStarter: true }],
      },
    });
  }

  it('创建比赛后能按 id 与分享码两种方式读回', async () => {
    const aggregate = await createMatch();
    const byId = await store.findMatchById(aggregate.match.id);
    const byCode = await store.findMatchByShareCode(aggregate.match.shareCode.toLowerCase());

    assert.ok(byId);
    assert.equal(byId!.match.id, aggregate.match.id);
    assert.ok(byCode);
    assert.equal(byCode!.teams.home.players.length, 2);
    assert.equal(byCode!.teams.away.players.length, 1);
  });

  it('重名球衣号码被拒绝（同队唯一）', async () => {
    const aggregate = await createMatch();
    await assert.rejects(
      () => store.addPlayer(aggregate.match.id, 'home', { name: '重复号码', jerseyNumber: '4', isStarter: false }),
      /已存在/,
    );
  });

  it('并发追加 60 条事件：一条不丢，seq 互不重复', async () => {
    const fixture = makeFixture();
    const aggregate = await createMatch('并发测试');
    const roster = {
      homeTeamId: aggregate.teams.home.id,
      awayTeamId: aggregate.teams.away.id,
      playerTeamId: Object.fromEntries([
        ...aggregate.teams.home.players.map((player) => [player.id, aggregate.teams.home.id]),
        ...aggregate.teams.away.players.map((player) => [player.id, aggregate.teams.away.id]),
      ]),
    };

    // 60 个互不等待的写入请求同时打进来
    const requests = Array.from({ length: 60 }, (_, index) =>
      store.appendEvents({
        matchId: aggregate.match.id,
        clientId: index % 2 === 0 ? 'tablet-a' : 'tablet-b',
        events: [
          draft(fixture, {
            type: 'score',
            teamId: aggregate.teams.home.id,
            playerId: aggregate.teams.home.players[index % 2]!.id,
            points: (index % 3) + 1 > 3 ? 3 : (((index % 3) + 1) as 1 | 2 | 3),
            offsetSeconds: index,
          }),
        ],
        roster,
        maxEventsPerMatch: 20_000,
      }),
    );

    const results = await Promise.all(requests);
    const accepted = results.reduce((sum, item) => sum + item.accepted.length, 0);
    assert.equal(accepted, 60, '并发写入不能丢事件');

    const stored = await store.listEvents(aggregate.match.id, { sinceSeq: 0 });
    assert.equal(stored.length, 60);
    const seqs = new Set(stored.map((event) => event.seq));
    assert.equal(seqs.size, 60, 'seq 必须唯一');
    assert.deepEqual(
      stored.map((event) => event.seq),
      [...stored.map((event) => event.seq)].sort((a, b) => a - b),
      'listEvents 必须按 seq 升序返回',
    );
  });

  it('幂等：同一 clientEventId 重复提交不产生第二条事件', async () => {
    const fixture = makeFixture();
    const aggregate = await createMatch('幂等测试');
    const roster = {
      homeTeamId: aggregate.teams.home.id,
      awayTeamId: aggregate.teams.away.id,
      playerTeamId: {},
    };
    const one = draft(fixture, { type: 'score', teamId: aggregate.teams.home.id, points: 3, offsetSeconds: 1 });

    const first = await store.appendEvents({ matchId: aggregate.match.id, clientId: 'tablet-a', events: [one], roster, maxEventsPerMatch: 100 });
    const second = await store.appendEvents({ matchId: aggregate.match.id, clientId: 'tablet-a', events: [one], roster, maxEventsPerMatch: 100 });

    assert.equal(first.accepted.length, 1);
    assert.equal(second.accepted.length, 0);
    assert.equal(second.duplicates.length, 1);
    assert.equal((await store.listEvents(aggregate.match.id)).length, 1);
  });

  it('落盘后重新打开实例，数据仍在（原子写 + JSON 可解析）', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'hoop-reload-'));
    const first = new JsonFileStore(fresh);
    await first.init();
    const aggregate = await first.createMatch({
      seasonId: null,
      competition: '重启测试',
      title: '第 1 轮',
      venue: null,
      scheduledAt: null,
      periodFormat: 'quarters',
      periodSeconds: 600,
      regulationPeriods: 4,
      shareCode: 'ZZ9999',
      home: { name: '甲', shortName: '甲', color: '#111111', players: [{ name: '甲一', jerseyNumber: '1', isStarter: true }] },
      away: { name: '乙', shortName: '乙', color: '#222222', players: [{ name: '乙一', jerseyNumber: '2', isStarter: true }] },
    });
    await first.appendEvents({
      matchId: aggregate.match.id,
      clientId: 'tablet-a',
      events: [draft(makeFixture(), { type: 'score', teamId: aggregate.teams.home.id, points: 2, offsetSeconds: 1 })],
      roster: { homeTeamId: aggregate.teams.home.id, awayTeamId: aggregate.teams.away.id, playerTeamId: {} },
      maxEventsPerMatch: 100,
    });
    await first.dispose();

    // 模拟重启：同一目录新开一个实例
    const second = new JsonFileStore(fresh);
    await second.init();
    const reloaded = await second.findMatchByShareCode('ZZ9999');
    assert.ok(reloaded, '重启后比赛应仍然存在');
    assert.equal(reloaded!.match.competition, '重启测试');
    assert.equal((await second.listEvents(aggregate.match.id)).length, 1, '事件必须持久化');

    const raw = await readFile(join(fresh, 'hoop-store.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), '落盘内容必须是合法 JSON');
    await second.dispose();
    await rm(fresh, { recursive: true, force: true });
  });

  it('数据文件损坏时隔离旧文件并以空库启动（不静默丢数据）', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'hoop-corrupt-'));
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(join(fresh, 'hoop-store.json'), '{ 这不是合法 JSON', 'utf8');

    const store2 = new JsonFileStore(fresh);
    await store2.init();
    assert.equal((await store2.listMatches()).length, 0);

    const files = await readdir(fresh);
    assert.ok(
      files.some((name) => name.includes('corrupt')),
      '损坏的文件必须被改名保留，便于事后恢复',
    );
    await store2.dispose();
    await rm(fresh, { recursive: true, force: true });
  });

  it('撤销：void 事件把目标标记为已作废', async () => {
    const fixture = makeFixture();
    const aggregate = await createMatch('撤销测试');
    const roster = {
      homeTeamId: aggregate.teams.home.id,
      awayTeamId: aggregate.teams.away.id,
      playerTeamId: {},
    };
    const appended = await store.appendEvents({
      matchId: aggregate.match.id,
      clientId: 'tablet-a',
      events: [draft(fixture, { type: 'score', teamId: aggregate.teams.home.id, points: 3, offsetSeconds: 1 })],
      roster,
      maxEventsPerMatch: 100,
    });
    const target = appended.events[0]!;

    const voidDraft = draft(fixture, { type: 'void', offsetSeconds: 2, payload: { targetEventId: target.id } });
    const outcome = await store.voidEvents({
      matchId: aggregate.match.id,
      targetEventIds: [target.id],
      voidDraft,
      roster,
    });

    assert.equal(outcome.voidedEventIds.length, 1);
    const stored = await store.listEvents(aggregate.match.id);
    const marked = stored.find((event) => event.id === target.id)!;
    const voidEvent = stored.find((event) => event.type === 'void')!;
    assert.equal(marked.voidedByEventId, voidEvent.id);
  });

  it('findExistingClientEventIds 用于计分端本地队列对账', async () => {
    const fixture = makeFixture();
    const aggregate = await createMatch('对账测试');
    const roster = { homeTeamId: aggregate.teams.home.id, awayTeamId: aggregate.teams.away.id, playerTeamId: {} };
    const one = draft(fixture, { type: 'foul', teamId: aggregate.teams.home.id, offsetSeconds: 1 });
    await store.appendEvents({ matchId: aggregate.match.id, clientId: 'tablet-a', events: [one], roster, maxEventsPerMatch: 100 });

    const found = await store.findExistingClientEventIds(aggregate.match.id, [one.clientEventId, 'never-sent']);
    assert.deepEqual(found, [one.clientEventId]);
  });
});
