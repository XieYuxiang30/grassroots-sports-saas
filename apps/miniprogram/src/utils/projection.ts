import type { GameEvent } from '@openhoopscore/contracts/events';
import type { TeamState } from '@openhoopscore/contracts/state';

/**
 * ============================================================================
 * 客户端本地投影（兜底）
 * ============================================================================
 * 权威状态一律以服务端为准（REST `/live` + Socket `state:patch`）。
 * 这里只在「服务端球员榜接口不可用」时，用已经拿到的状态做展示级近似，
 * 算法语义与 packages/contracts/src/score.ts 的 projectMatch 保持一致：
 *   - `void` 事件指向的事件被剔除；
 *   - score 事件按 teamId 归属累加，points === 3 记一次三分；
 *   - foul 累加个人犯规；
 *   - team_foul 累加全队犯规（按节）。
 *
 * 为什么不直接 import contracts 的 projectMatch：见 `src/contracts/index.ts` 头部说明。
 */

/** 按权威 seq 从状态里的球员行推导统计（服务端已投影过，这里只做排序/汇总）。 */
export interface FlatPlayerStat {
  playerId: string;
  teamId: string;
  teamName: string;
  side: 'home' | 'away';
  name: string;
  jerseyNumber: string;
  points: number;
  fouls: number;
  threePointersMade: number;
  onCourt: boolean;
}

export function flattenPlayers(home: TeamState, away: TeamState): FlatPlayerStat[] {
  const rows: FlatPlayerStat[] = [];
  const push = (team: TeamState, side: 'home' | 'away') => {
    for (const line of team.players ?? []) {
      rows.push({
        playerId: line.playerId,
        teamId: line.teamId,
        teamName: team.name,
        side,
        name: line.name,
        jerseyNumber: line.jerseyNumber,
        points: line.points,
        fouls: line.fouls,
        threePointersMade: line.threePointersMade,
        onCourt: line.onCourt,
      });
    }
  };
  push(home, 'home');
  push(away, 'away');
  return rows;
}

/**
 * 仅用于离线兜底：从事件流重放比分。
 * 返回 `{ home, away }` 两队得分。
 */
export function replayScore(
  events: readonly GameEvent[],
  homeTeamId: string,
  awayTeamId: string,
): { home: number; away: number; threePointers: Record<string, number> } {
  const voided = new Set<string>();
  for (const event of events) {
    if (event.type === 'void') {
      const target = (event.payload as { targetEventId?: string } | undefined)?.targetEventId;
      if (target) voided.add(target);
    } else if (event.voidedByEventId) {
      voided.add(event.id);
    }
  }

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let home = 0;
  let away = 0;
  const threePointers: Record<string, number> = {};

  for (const event of ordered) {
    if (event.type === 'void' || voided.has(event.id)) continue;
    if (event.type !== 'score') continue;
    const points = Number.isFinite(event.points) ? event.points : 0;
    if (event.teamId === homeTeamId) home += points;
    else if (event.teamId === awayTeamId) away += points;
    if (points === 3 && event.playerId) {
      threePointers[event.playerId] = (threePointers[event.playerId] ?? 0) + 1;
    }
  }
  return { home, away, threePointers };
}
