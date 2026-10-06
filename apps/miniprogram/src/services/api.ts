import Taro from '@tarojs/taro';
import type {
  HealthResponse,
  ListMatchesResponse,
  MatchDetail,
  MatchLiveResponse,
  MatchSummary,
  PlayerLeaderboardEntry,
  PlayerLeaderboardResponse,
  QueryEventsResponse,
  ResolveShareCodeResponse,
} from '../contracts';

/**
 * ============================================================================
 * 观众端 REST 封装
 * ============================================================================
 * 后端接口（apps/api）：
 *   GET /api/health
 *   GET /api/matches
 *   GET /api/matches/:id
 *   GET /api/matches/:id/live
 *   GET /api/matches/:id/leaderboard
 *   GET /api/matches/:id/events?sinceSeq=
 *   GET /api/matches/by-code/:shareCode
 *
 * 统一处理 baseURL、超时、错误归一化。
 */

/** `API_BASE_URL` 由 config/index.ts 的 defineConstants 注入；H5 下可回退到同源。 */
declare const API_BASE_URL: string | undefined;

function readEnvApiBaseUrl(): string | undefined {
  try {
    // Taro 会把 TARO_APP_ 前缀的环境变量注入到 process.env
    if (typeof process !== 'undefined' && process.env && process.env.TARO_APP_API_BASE_URL) {
      return process.env.TARO_APP_API_BASE_URL;
    }
  } catch {
    // 小程序端 process 可能不存在，忽略。
  }
  return undefined;
}

export function resolveBaseUrl(): string {
  const fromEnv = readEnvApiBaseUrl();
  const raw =
    (fromEnv && fromEnv.trim()) ||
    (typeof API_BASE_URL === 'string' && API_BASE_URL.trim()) ||
    'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

/** 归一化后的接口错误，页面可以直接展示 `message`。 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string | undefined;
  readonly url: string;

  constructor(message: string, options: { statusCode?: number; code?: string; url: string }) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = options.statusCode ?? 0;
    this.code = options.code;
    this.url = options.url;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: Record<string, unknown>;
  timeoutMs?: number;
  /** 失败时的兜底中文提示。 */
  errorMessage?: string;
}

function describeNetworkError(url: string): string {
  const baseUrl = resolveBaseUrl();
  return [
    `无法连接后端（${baseUrl}）。`,
    '请确认：1) 后端已启动；2) TARO_APP_API_BASE_URL 指向手机/模拟器可访问的地址；',
    '3) 微信开发者工具已勾选「不校验合法域名」且未开启域名校验。',
    `请求地址：${url}`,
  ].join('');
}

/**
 * 统一请求入口。所有 REST 调用都必须走它，保证错误处理一致。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const { method = 'GET', data, timeoutMs = 8000, errorMessage } = options;

  let response: Taro.request.SuccessCallbackResult<TaroGeneral.IAnyObject>;
  try {
    response = await Taro.request({
      url,
      method,
      data,
      timeout: timeoutMs,
      header: { Accept: 'application/json' },
    });
  } catch (error) {
    // 原始错误（Taro 的 request:fail）信息通常对观众无意义，转成可操作的中文提示。
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError(errorMessage ? `${errorMessage}：${detail}` : describeNetworkError(url), {
      url,
      code: 'network_error',
      statusCode: 0,
    });
  }

  const statusCode = response.statusCode ?? 0;
  if (statusCode >= 200 && statusCode < 300) {
    return response.data as T;
  }

  const body = response.data as { message?: unknown; code?: unknown; error?: unknown } | undefined;
  const message =
    (typeof body?.message === 'string' && body.message) ||
    (typeof body?.error === 'string' && body.error) ||
    errorMessage ||
    `请求失败（HTTP ${statusCode}）`;
  throw new ApiError(message, {
    statusCode,
    code: typeof body?.code === 'string' ? body.code : undefined,
    url,
  });
}

/* ------------------------------ 健康检查 ------------------------------ */

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', {
    timeoutMs: 4000,
    errorMessage: '后端健康检查失败',
  });
}

/* ------------------------------ 比赛列表 / 详情 ------------------------------ */

export function listMatches(): Promise<ListMatchesResponse> {
  return request<ListMatchesResponse>('/api/matches', {
    errorMessage: '获取比赛列表失败',
  });
}

export function getMatch(matchId: string): Promise<MatchDetail> {
  return request<MatchDetail>(`/api/matches/${encodeURIComponent(matchId)}`, {
    errorMessage: '获取比赛详情失败',
  });
}

/** 扫码进房：分享码 → 比赛。code 大小写不敏感，这里统一转大写。 */
export function resolveShareCode(code: string): Promise<ResolveShareCodeResponse> {
  return request<ResolveShareCodeResponse>(
    `/api/matches/by-code/${encodeURIComponent(code.trim().toUpperCase())}`,
    {
      errorMessage: `没有找到分享码 ${code} 对应的比赛`,
    },
  );
}

/* ------------------------------ 实时直播数据 ------------------------------ */

export function getMatchLive(matchId: string): Promise<MatchLiveResponse> {
  return request<MatchLiveResponse>(`/api/matches/${encodeURIComponent(matchId)}/live`, {
    errorMessage: '获取实时比分失败',
  });
}

/** 增量拉取事件（断线重连兜底，Socket 不可用时用轮询）。 */
export function getMatchEvents(matchId: string, sinceSeq = 0): Promise<QueryEventsResponse> {
  const query = `?sinceSeq=${encodeURIComponent(String(Math.max(0, sinceSeq)))}`;
  return request<QueryEventsResponse>(
    `/api/matches/${encodeURIComponent(matchId)}/events${query}`,
    { errorMessage: '增量同步事件失败' },
  );
}

/* ------------------------------ 球员榜 ------------------------------ */

export type LeaderboardSort = PlayerLeaderboardResponse['sortedBy'];

export function getLeaderboard(
  matchId: string,
  sortedBy: LeaderboardSort = 'points',
): Promise<PlayerLeaderboardResponse> {
  const query = `?sortedBy=${encodeURIComponent(sortedBy)}`;
  return request<PlayerLeaderboardResponse>(
    `/api/matches/${encodeURIComponent(matchId)}/leaderboard${query}`,
    { errorMessage: '获取球员榜失败' },
  );
}

/* ------------------------------ 便捷聚合 ------------------------------ */

export function isLiveMatch(match: MatchSummary): boolean {
  return match.status === 'live';
}

/** 进行中的比赛排前面，其次按更新时间倒序。 */
export function sortMatchesForDisplay(items: readonly MatchSummary[]): MatchSummary[] {
  const weight = (status: MatchSummary['status']): number => {
    if (status === 'live') return 0;
    if (status === 'scheduled') return 1;
    if (status === 'finished') return 2;
    return 3;
  };
  return [...items].sort((a, b) => {
    const byStatus = weight(a.status) - weight(b.status);
    if (byStatus !== 0) return byStatus;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function sortLeaderboard(
  entries: readonly PlayerLeaderboardEntry[],
  sortedBy: LeaderboardSort,
): PlayerLeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    const primary = (b[sortedBy] ?? 0) - (a[sortedBy] ?? 0);
    if (primary !== 0) return primary;
    const byPoints = b.points - a.points;
    if (byPoints !== 0) return byPoints;
    return a.jerseyNumber.localeCompare(b.jerseyNumber);
  });
}
