import type { GameEvent, GameEventDraft, MatchState } from '@openhoopscore/contracts';

/**
 * ============================================================================
 * 离线状态推导（计分端专用）
 * ============================================================================
 * 计分端与服务端的差别只有一点：**本地还有一批服务端尚未确认的事件**。
 * 所以「当前比分」= 服务端权威事件 + 本地待同步事件，再跑一次同样的投影。
 *
 * 这样做的好处：
 *   1. 计分员在断网时点一下，画面上立刻出现比分变化（乐观 UI），不用等网络；
 *   2. 用的算法与后端完全同一套（@openhoopscore/contracts 的 projectMatch），
 *      所以恢复网络后服务端算出来的结果与本地一致，不会出现「跳分」；
 *   3. 服务端返回的 reordered / 权威 state 一到，本地队列清空，画面平滑收敛。
 */

export interface PendingEntry {
  /** 本地生成、全局唯一：幂等键，也是本地队列的主键。 */
  clientEventId: string;
  /** 已确认发送过的次数，用于 UI 提示「重试中」。 */
  attempts: number;
  /** 最近一次失败原因（用于把队列里的事件标记为「需要人工处理」）。 */
  lastError?: string;
  /** 创建时间，用于展示「离线已记录 N 分钟」。 */
  createdAt: string;
  event: GameEventDraft;
}

export interface DerivedState {
  state: MatchState;
  /** 本地还没被服务端确认的事件条数。 */
  pendingCount: number;
  /** 本地投影是否包含未同步事件（UI 据此显示「离线记录中」）。 */
  optimistic: boolean;
}

/** 把本地待同步草稿补成「看起来像服务端事件」的形状，好参与同一套投影。 */
export function pendingToEvent(draft: GameEventDraft, index: number, baseSeq: number): GameEvent {
  const points =
    draft.type === 'score' ? Number((draft.payload as { points?: number } | undefined)?.points ?? 0) : 0;
  return {
    ...draft,
    points,
    // 给一个比服务端最大 seq 更大的占位序号；投影会先按确定性时钟重排，
    // 所以占位值不会影响最终比分，只影响内部排序的稳定性。
    seq: baseSeq + index + 1,
    createdAt: draft.clientTimestamp,
    voidedByEventId: null,
    payload: (draft.payload ?? {}) as GameEvent['payload'],
  };
}

/**
 * 用「权威事件 + 本地待同步事件」重新推导状态。
 *
 * @param authorityEvents 服务端已确认的事件（已按 seq 升序）
 * @param pending         本地待同步队列
 * @param project         由调用方注入的投影函数（来自 @openhoopscore/contracts）
 */
export function deriveOfflineState(
  authorityEvents: readonly GameEvent[],
  pending: readonly PendingEntry[],
  project: (events: GameEvent[], assumeSorted?: boolean) => MatchState,
): DerivedState {
  if (pending.length === 0) {
    return { state: project([...authorityEvents], true), pendingCount: 0, optimistic: false };
  }

  const baseSeq = authorityEvents.reduce((max, event) => Math.max(max, event.seq), 0);
  const merged = [
    ...authorityEvents,
    ...pending.map((entry, index) => pendingToEvent(entry.event, index, baseSeq)),
  ];

  // 本地队列的 clientTimestamp 可能与服务端事件交错，必须重新排序（assumeSorted = false）
  return { state: project(merged, false), pendingCount: pending.length, optimistic: true };
}

/**
 * 撤销的本地语义：把「要撤销的那条事件」在本地标记为作废。
 *
 * 与服务端保持一致——不删除，而是追加一条 void 事件。这样：
 *   - 本地与服务端的事件流结构完全相同，恢复网络后合并不会打架；
 *   - 撤销也能离线进行（现场常见：点错了要立刻改，但网还没恢复）。
 */
export function buildLocalVoidDraft(
  matchId: string,
  clientId: string,
  targetEventId: string,
  reason = 'scorer_undo_local',
): GameEventDraft {
  const now = new Date().toISOString();
  return {
    id: cryptoRandomId(),
    matchId,
    type: 'void',
    teamId: null,
    playerId: null,
    points: 0,
    period: 1,
    gameClockSeconds: null,
    clientTimestamp: now,
    clientId,
    clientEventId: cryptoRandomId(),
    payload: { targetEventId, reason },
  };
}

/** 生成本地唯一 id。优先用 crypto.randomUUID（HTTPS/localhost 才有），否则降级。 */
export function cryptoRandomId(): string {
  const globalCrypto = globalThis.crypto as Crypto | undefined;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  // 降级方案：时间戳 + 随机数，碰撞概率对本场景足够低（单机单场几百条事件）
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 设备标识：同一台平板固定一个 id，多设备冲突排查与幂等审计都依赖它。 */
export function resolveClientId(storageKey = 'hoop:clientId'): string {
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = `device-${cryptoRandomId().slice(0, 8)}`;
    window.localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return `device-${cryptoRandomId().slice(0, 8)}`;
  }
}
