import { randomUUID } from 'node:crypto';
import type { GameEvent, GameEventDraft, GameEventType } from '@openhoopscore/contracts';

/**
 * 测试夹具：构造事件流。
 *
 * 计分系统的测试必须能精确控制「客户端时间戳」与「设备 id」，
 * 因为离线合并的正确性完全取决于它们，而不是取决于代码跑得多快。
 */

export interface Fixture {
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  players: {
    home: [string, string, string];
    away: [string, string, string];
  };
  roster: {
    homeTeamId: string;
    awayTeamId: string;
    playerTeamId: Record<string, string>;
  };
}

export function makeFixture(): Fixture {
  const matchId = randomUUID();
  const homeTeamId = randomUUID();
  const awayTeamId = randomUUID();
  const homePlayers: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
  const awayPlayers: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];

  const playerTeamId: Record<string, string> = {};
  for (const id of homePlayers) playerTeamId[id] = homeTeamId;
  for (const id of awayPlayers) playerTeamId[id] = awayTeamId;

  return {
    matchId,
    homeTeamId,
    awayTeamId,
    players: { home: homePlayers, away: awayPlayers },
    roster: { homeTeamId, awayTeamId, playerTeamId },
  };
}

let eventCounter = 0;

export interface DraftOptions {
  type: GameEventType;
  teamId?: string | null;
  playerId?: string | null;
  period?: number;
  points?: 1 | 2 | 3;
  clientTimestamp?: string;
  clientId?: string;
  clientEventId?: string;
  gameClockSeconds?: number | null;
  payload?: Record<string, unknown>;
  /** 距离基准时间偏移的秒数（正数=之后发生）。 */
  offsetSeconds?: number;
}

export function draft(fixture: Fixture, options: DraftOptions): GameEventDraft {
  eventCounter += 1;
  const base = Date.parse('2024-06-01T10:00:00.000Z');
  const timestamp =
    options.clientTimestamp ?? new Date(base + (options.offsetSeconds ?? eventCounter) * 1000).toISOString();

  const payload =
    options.payload ??
    (options.type === 'score' ? { points: options.points ?? 2 } : {});

  return {
    id: randomUUID(),
    matchId: fixture.matchId,
    type: options.type,
    teamId: options.teamId ?? null,
    playerId: options.playerId ?? null,
    points: 0,
    period: options.period ?? 1,
    gameClockSeconds: options.gameClockSeconds ?? null,
    clientTimestamp: timestamp,
    clientId: options.clientId ?? 'tablet-a',
    clientEventId: options.clientEventId ?? randomUUID(),
    payload: payload as GameEventDraft['payload'],
  };
}

/** 把草稿「落库」成带 seq 的事件（服务端视角）。 */
export function committed(draftInput: GameEventDraft, seq: number, createdAt = new Date().toISOString()): GameEvent {
  const points = draftInput.type === 'score' ? Number((draftInput.payload as { points?: number } | undefined)?.points ?? 0) : 0;
  return {
    ...draftInput,
    points,
    seq,
    createdAt,
    voidedByEventId: null,
    payload: (draftInput.payload ?? {}) as GameEvent['payload'],
  };
}

export function resetEventCounter(): void {
  eventCounter = 0;
}
