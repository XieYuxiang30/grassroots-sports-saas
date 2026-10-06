/** 所有对外暴露的 ID 都是字符串。默认由服务端生成 UUID v4，见 backend。 */
export type MatchId = string;
export type TeamId = string;
export type PlayerId = string;
export type EventId = string;
export type SeasonId = string;

/** 计分端设备标识：离线事件靠它回溯来源，便于排查多设备冲突。 */
export type ClientId = string;

/**
 * 客户端事件幂等键。
 * 离线计分时每次点击都会先在本地生成一个 clientEventId，
 * 断网重连后重复推送同一个 ID，服务端只接受第一次，其余返回 duplicate。
 */
export type ClientEventId = string;

export type IsoDateTime = string;

/** 比赛状态机的取值。 */
export const MATCH_STATUSES = ['scheduled', 'live', 'finished', 'archived'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** 比赛阶段：基层赛事常见为 4 节制，也支持 2 节制（上下半场）。 */
export type GamePeriodFormat = 'quarters' | 'halves';

export type TeamSide = 'home' | 'away';

/** 得分方式，用于图文直播的措辞与后续的投篮热区统计。 */
export const SHOT_TYPES = ['layup', 'mid', 'three', 'dunk', 'free_throw', 'other'] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
