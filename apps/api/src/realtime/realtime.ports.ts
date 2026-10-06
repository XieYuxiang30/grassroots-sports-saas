import type { GameEventDraft, MatchDetail, MatchState } from '@openhoopscore/contracts';
import type { SubmitOutcome, UndoOutcome } from '../scoring/scoring.types';

/**
 * 实时模块与业务模块之间的**端口**。
 *
 * 为什么要这么绕：`ScoringController` 需要 RealtimeService 来广播 REST 写入，
 * 而 RealtimeService 又需要 ScoringService / MatchesService 来读写业务数据。
 * 如果两边直接互相 import 模块，Nest 就会报循环依赖。
 *
 * 解决办法是「依赖倒置」：
 *   - RealtimeModule 谁都不依赖，只认识下面这两个接口；
 *   - ScoringModule / MatchesModule 在启动时通过 `RealtimeRegistry` 把自己注册进来；
 *   - 依赖方向变成单向：业务模块 → 实时模块。
 */
export interface ScorerPort {
  submit(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    events: GameEventDraft[];
  }): Promise<SubmitOutcome>;
  undo(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    targetEventId?: string;
    steps?: number;
  }): Promise<UndoOutcome>;
  requestState(params: { matchId: string; sinceSeq?: number; withFeed?: boolean }): Promise<{
    state: MatchState;
    events: import('@openhoopscore/contracts').GameEvent[];
    feed: import('@openhoopscore/contracts').LiveFeedItem[];
  }>;
  finishMatch(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    reason?: 'normal' | 'forfeit' | 'aborted';
  }): Promise<{ state: MatchState }>;
  setClock(params: {
    matchId: string;
    clientId: string;
    passcode?: string;
    period?: number;
    gameClockSeconds?: number | null;
    running?: boolean;
  }): Promise<{ state: MatchState }>;
}

export interface MatchesPort {
  getMatchDetail(matchId: string): Promise<MatchDetail>;
  onlineScorers?(matchId: string): Array<{ clientId: string; since: string }>;
}

/**
 * 启动期注册表。业务模块在自己的 `onModuleInit` 里调用 `register*`，
 * 之后 RealtimeService 就能拿到实现，而不需要在编译期 import 对方模块。
 */
export class RealtimeRegistry {
  private static scorer: ScorerPort | null = null;
  private static matches: MatchesPort | null = null;

  static registerScorer(port: ScorerPort): void {
    RealtimeRegistry.scorer = port;
  }

  static registerMatches(port: MatchesPort): void {
    RealtimeRegistry.matches = port;
  }

  static getScorer(): ScorerPort {
    if (!RealtimeRegistry.scorer) {
      throw new Error('ScorerPort 尚未注册：请确认 ScoringService 已启用（它会在 onModuleInit 中注册自己）');
    }
    return RealtimeRegistry.scorer;
  }

  static getMatches(): MatchesPort {
    if (!RealtimeRegistry.matches) {
      throw new Error('MatchesPort 尚未注册：请确认 MatchesService 已启用');
    }
    return RealtimeRegistry.matches;
  }

  static hasScorer(): boolean {
    return RealtimeRegistry.scorer !== null;
  }

  static reset(): void {
    RealtimeRegistry.scorer = null;
    RealtimeRegistry.matches = null;
  }
}
