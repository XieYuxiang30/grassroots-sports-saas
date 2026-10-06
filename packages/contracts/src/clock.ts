import type { GameEventType } from './events';
import type { ClientId, EventId, IsoDateTime, MatchStatus, PlayerId, TeamId, TeamSide } from './ids';

/**
 * ============================================================================
 * 确定性时钟与冲突解决
 * ============================================================================
 * 基层赛事最大的痛点是**现场网络极差甚至没网**。
 * 计分员断网期间照常点击，事件先落本地；恢复网络后批量补传。
 * 补传的事件必须能与其他设备（例如另一台备用计分平板）的事件合并。
 *
 * 合并规则（全平台唯一实现，保证任何设备算出同样的比分）：
 *   1. 先比 `clientTimestamp`（ISO 字符串，等价于比时间先后）；
 *   2. 相同则比 `clientId`（字典序），让跨设备同刻事件有稳定归属；
 *   3. 再相同则比 `clientEventId`（字典序）。
 * 三条比较键全部与「事件到达服务器的顺序」无关，因此重放是确定性的。
 */

export interface OrderableEvent {
  seq: number;
  clientTimestamp: string;
  clientId: string;
  clientEventId: string;
}

export function compareEventsForOrder(a: OrderableEvent, b: OrderableEvent): number {
  if (a.clientTimestamp !== b.clientTimestamp) {
    return a.clientTimestamp < b.clientTimestamp ? -1 : 1;
  }
  if (a.clientId !== b.clientId) {
    return a.clientId < b.clientId ? -1 : 1;
  }
  if (a.clientEventId !== b.clientEventId) {
    return a.clientEventId < b.clientEventId ? -1 : 1;
  }
  return 0;
}

/** 现场时钟可能不准：超过该阈值的未来时间戳会被夹到服务端时间。 */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * 归一化客户端时间戳，防止设备时间明显错误导致事件被排到时间线末端。
 * 只做上界保护（未来时间），不修改过去时间——离线补传正是「过去时间」。
 */
export function normalizeClientTimestamp(input: string | undefined, now: Date): string {
  const nowMs = now.getTime();
  if (!input) return now.toISOString();
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return now.toISOString();
  if (parsed > nowMs + MAX_CLOCK_SKEW_MS) return now.toISOString();
  return new Date(parsed).toISOString();
}

/** 服务端分配 seq 时的排序器：先按时间线排序，再写回连续序号。 */
export function sortEventsForSubmission<T extends OrderableEvent>(events: readonly T[]): T[] {
  return [...events].sort(compareEventsForOrder);
}

/** 单场比赛的同步游标：客户端记住它，断线重连时只拉增量。 */
export interface EventCursor {
  matchId: string;
  /** 已经拿到的最大 seq；0 表示从零开始。 */
  seq: number;
}

export type { ClientId, EventId, GameEventType, IsoDateTime, MatchStatus, PlayerId, TeamId, TeamSide };
