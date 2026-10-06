import type { GameEvent, LiveFeedItem, MatchState } from '@openhoopscore/contracts';
import type { EventsCommittedEvent, UndoAppliedEvent } from '@openhoopscore/contracts';

/** 提交事件后的完整结果（REST 返回 + 实时广播载荷一起给出）。 */
export interface SubmitOutcome {
  result: import('@openhoopscore/contracts').SubmitEventsResult;
  broadcast: EventsCommittedEvent;
  feedItems: LiveFeedItem[];
  highlights: Array<
    Omit<import('@openhoopscore/contracts').PlayerHighlightEvent, 'matchId' | 'at'>
  >;
  state: MatchState;
}

/** 撤销后的完整结果。 */
export interface UndoOutcome {
  result: import('@openhoopscore/contracts').UndoResult;
  broadcast: UndoAppliedEvent;
  feedItems: LiveFeedItem[];
}

export type { GameEvent };
