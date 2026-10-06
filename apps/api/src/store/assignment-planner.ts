import type { GameEvent, GameEventDraft } from '@openhoopscore/contracts';
import { GAME_EVENT_TYPES, normalizeClientTimestamp, resolveEventPoints } from '@openhoopscore/contracts';

/**
 * ============================================================================
 * 事件写入规划器 —— 全平台唯一的「离线补传 + 幂等 + 排序」算法
 * ============================================================================
 *
 * 三个存储驱动（memory / json / prisma）都调用它，保证任何驱动下行为一致。
 *
 * ## 为什么 `seq` 用「排名」而不是「自增 id」
 * 计分员断网 10 分钟，本地攒了 20 条事件；与此同时备用平板上也记了几条。
 * 恢复网络后先到的可能是**后发生**的事件。如果 seq 按「到达顺序」自增，
 * 那么落后的那批补传进来就会插在中间，导致**所有后续事件的 seq 都要改**：
 *   - 关系库上会撞 `(match_id, seq)` 唯一约束；
 *   - 已经推给观众端的增量游标全部作废，只能全量重推。
 *
 * 因此这里把 seq 定义成**确定性排名**：
 *     seq(E) = 1 + |{ F : F 的排序键 < E 的排序键 }|
 * 排序键 = (clientTimestamp, clientId, clientEventId)，与「何时到达服务器」完全无关。
 * 于是：
 *   - 同一个事件无论在什么时候、以什么顺序到达，算出来的 seq 都一样（幂等）；
 *   - 补传旧事件只需插入一个空位，**已有事件一列都不动**；
 *   - 观众端可以放心用 seq 作为游标做增量拉取。
 * 代价是 seq 可能出现空洞（例如 1,2,3,7,8），这对增量同步没有影响。
 *
 * ## 幂等
 * 以 `(matchId, clientEventId)` 为幂等键。同一批里重复的、库里已存在的，
 * 一律判为 duplicate 并回传其真实 seq，计分端据此把本地队列标记为已同步。
 */

export interface MatchRoster {
  homeTeamId: string;
  awayTeamId: string;
  /** playerId → teamId，用于校验事件里的球员归属。 */
  playerTeamId: Record<string, string>;
}

export interface PlanInput {
  existing: readonly GameEvent[];
  incoming: readonly GameEventDraft[];
  matchId: string;
  roster: MatchRoster;
  maxEventsPerMatch: number;
  now: Date;
  /** 生成事件 id 的方式（默认由调用方注入，保证可测）。 */
  newId: () => string;
}

export interface PlanResult {
  /** 落库后的**全部**事件，按排序键升序（即 seq 升序）。 */
  events: GameEvent[];
  /** 本次新接受的事件（含 seq）。 */
  accepted: Array<{ clientEventId: string; eventId: string; seq: number }>;
  /** 幂等命中的事件。 */
  duplicates: Array<{ clientEventId: string; eventId: string; seq: number }>;
  /** 校验失败被拒绝的事件。 */
  rejected: Array<{ clientEventId: string; reason: string }>;
  /** 是否发生「补传导致的时间线插入」，客户端需要重拉直播流。 */
  reordered: boolean;
  finalSeq: number;
  /** 新接受的完整事件对象，按 seq 升序，供实时广播使用。 */
  createdEvents: GameEvent[];
}

/** 排序键的字符串形式，便于比较与二分。 */
export function sortKeyOf(event: { clientTimestamp: string; clientId: string; clientEventId: string }): string {
  return `${event.clientTimestamp}\u0000${event.clientId}\u0000${event.clientEventId}`;
}

export class AssignmentPlanner {
  /**
   * 计算一批事件插入后的完整事件流。
   *
   * 纯函数：不读写任何外部状态，因此可以直接单测「补传 + 乱序 + 重复」的组合场景。
   */
  plan(input: PlanInput): PlanResult {
    const { existing, incoming, matchId, roster, maxEventsPerMatch, now } = input;

    const accepted: PlanResult['accepted'] = [];
    const duplicates: PlanResult['duplicates'] = [];
    const rejected: PlanResult['rejected'] = [];
    const createdEvents: GameEvent[] = [];

    // 已存在的幂等键 → 服务端事件（回传真实 seq，便于客户端清理本地队列）
    const byClientEventId = new Map<string, GameEvent>();
    for (const event of existing) byClientEventId.set(event.clientEventId, event);

    // 本批内的去重：同一个 clientEventId 只接受第一条
    const seenInBatch = new Set<string>();

    for (const draft of incoming) {
      const clientEventId = draft.clientEventId;
      if (!clientEventId) {
        rejected.push({ clientEventId: String(clientEventId), reason: 'clientEventId 不能为空（幂等键缺失）' });
        continue;
      }
      const duplicateOf = byClientEventId.get(clientEventId);
      if (duplicateOf) {
        duplicates.push({ clientEventId, eventId: duplicateOf.id, seq: duplicateOf.seq });
        continue;
      }
      if (seenInBatch.has(clientEventId)) {
        rejected.push({ clientEventId, reason: '同一批次内出现重复的 clientEventId' });
        continue;
      }
      seenInBatch.add(clientEventId);

      const validationError = validateDraft(draft, roster);
      if (validationError) {
        rejected.push({ clientEventId, reason: validationError });
        continue;
      }

      if (existing.length + createdEvents.length >= maxEventsPerMatch) {
        rejected.push({
          clientEventId,
          reason: `单场比赛事件数已达上限 ${maxEventsPerMatch}，请结束本场或联系管理员`,
        });
        continue;
      }

      const clientTimestamp = normalizeClientTimestamp(draft.clientTimestamp, now);
      const payload = (draft.payload ?? {}) as GameEvent['payload'];
      const points = draft.type === 'score' ? resolveEventPoints('score', payload) : 0;

      const event: GameEvent = {
        id: input.newId(),
        matchId,
        type: draft.type,
        teamId: draft.teamId ?? null,
        playerId: draft.playerId ?? null,
        points,
        period: Number.isFinite(draft.period) && draft.period >= 1 ? Math.floor(draft.period) : 1,
        gameClockSeconds:
          draft.gameClockSeconds === null || draft.gameClockSeconds === undefined
            ? null
            : Math.max(0, Math.floor(draft.gameClockSeconds)),
        clientTimestamp,
        clientId: draft.clientId,
        clientEventId,
        // 占位，稍后统一按排名写入
        seq: 0,
        createdAt: now.toISOString(),
        voidedByEventId: null,
        payload,
      };

      createdEvents.push(event);
      byClientEventId.set(clientEventId, event);
    }

    // 合并后统一排序：现有事件也参与排序，保证「补传插入」得到正确位置
    const merged = [...existing, ...createdEvents].sort(compareBySortKey);

    // 分配确定性排名
    const rankByEventId = new Map<string, number>();
    merged.forEach((event, index) => {
      const seq = index + 1;
      rankByEventId.set(event.id, seq);
      event.seq = seq;
    });

    for (const event of createdEvents) {
      accepted.push({ clientEventId: event.clientEventId, eventId: event.id, seq: event.seq });
    }

    // 补传判定：新事件的 seq 落在「原有最大 seq」之前 → 时间线被插入，需要重排提示。
    // 首次写入（现有为空）不算重排。
    const previousMaxSeq = existing.reduce((max, event) => Math.max(max, event.seq), 0);
    const reordered =
      existing.length > 0 &&
      createdEvents.some((event) => event.seq <= previousMaxSeq) &&
      createdEvents.length > 0;

    // createdEvents 需要按 seq 升序返回，直播间广播才是正确的时间线
    createdEvents.sort((a, b) => a.seq - b.seq && compareBySortKey(a, b));

    return {
      events: merged,
      accepted,
      duplicates,
      rejected,
      reordered,
      finalSeq: merged.length,
      createdEvents,
    };
  }

  /**
   * 只计算 seq 的方式（供 Prisma 驱动使用）：
   * 不把整场事件读进内存，而是用 COUNT 查询算出排名。
   * 这里提供纯函数版本，方便单测对齐两种实现。
   */
  rankOf(target: { clientTimestamp: string; clientId: string; clientEventId: string }, pool: readonly GameEvent[]): number {
    const key = sortKeyOf(target);
    let rank = 1;
    for (const event of pool) {
      if (sortKeyOf(event) < key) rank += 1;
    }
    return rank;
  }
}

/** 排序键比较：clientTimestamp → clientId → clientEventId。 */
export function compareBySortKey(
  a: { clientTimestamp: string; clientId: string; clientEventId: string },
  b: { clientTimestamp: string; clientId: string; clientEventId: string },
): number {
  const keyA = sortKeyOf(a);
  const keyB = sortKeyOf(b);
  if (keyA === keyB) return 0;
  return keyA < keyB ? -1 : 1;
}

/**
 * 事件合法性校验。
 * 现场最常见的错误是「点了客队球员但事件标成主队」，这里直接拦掉，
 * 避免脏数据进入事件流后污染比分与球员榜。
 */
export function validateDraft(draft: GameEventDraft, roster: MatchRoster): string | null {
  if (!(GAME_EVENT_TYPES as readonly string[]).includes(draft.type)) {
    return `未知事件类型：${String(draft.type)}`;
  }
  if (!draft.clientId) return 'clientId 不能为空';

  const teamScoped = new Set([
    'score',
    'foul',
    'team_foul',
    'timeout',
    'turnover',
    'steal',
    'block',
    'rebound',
  ]);
  if (teamScoped.has(draft.type)) {
    if (!draft.teamId) return `${draft.type} 事件必须指定 teamId`;
    if (draft.teamId !== roster.homeTeamId && draft.teamId !== roster.awayTeamId) {
      return `teamId ${draft.teamId} 不属于本场比赛`;
    }
  }

  if (draft.playerId) {
    const playerTeamId = roster.playerTeamId[draft.playerId];
    if (!playerTeamId) return `playerId ${draft.playerId} 不属于本场比赛`;
    if (draft.teamId && playerTeamId !== draft.teamId) {
      return `球员 ${draft.playerId} 属于球队 ${playerTeamId}，与事件的 teamId ${draft.teamId} 不一致`;
    }
  }

  if (draft.type === 'score') {
    if (draft.teamId && !draft.playerId) {
      // 允许：只记队伍得分（基层赛事常常不记具体球员）
    }
    const payload = draft.payload as { points?: unknown } | undefined;
    if (payload?.points !== 1 && payload?.points !== 2 && payload?.points !== 3) {
      return 'score 事件的 payload.points 必须为 1、2 或 3';
    }
  }

  if (draft.type === 'substitution') {
    const payload = draft.payload as { playerInId?: string; playerOutId?: string } | undefined;
    if (!payload?.playerInId || !payload?.playerOutId) {
      return 'substitution 事件必须同时提供 playerInId 与 playerOutId';
    }
    for (const id of [payload.playerInId, payload.playerOutId]) {
      const teamId = roster.playerTeamId[id!];
      if (!teamId) return `换人球员 ${id} 不属于本场比赛`;
      if (draft.teamId && teamId !== draft.teamId) return `换人球员 ${id} 不在事件所属球队`;
    }
  }

  if (draft.type === 'void' && !(draft.payload as { targetEventId?: string } | undefined)?.targetEventId) {
    return 'void 事件必须提供 payload.targetEventId';
  }

  const period = Number(draft.period);
  if (!Number.isFinite(period) || period < 1 || period > 20) {
    return `period 取值非法：${String(draft.period)}（应为 1..20）`;
  }

  return null;
}
