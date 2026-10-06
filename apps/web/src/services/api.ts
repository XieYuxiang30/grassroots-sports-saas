import type {
  ApiErrorBody,
  EventCursor,
  GameEvent,
  GameEventDraft,
  MatchDetail,
  MatchSummary,
  PlayerLeaderboardResponse,
  QueryEventsResponse,
  SubmitEventsResult,
  UndoResult,
} from '@openhoopscore/contracts';

/**
 * ============================================================================
 * REST 客户端
 * ============================================================================
 * 三个原则：
 *   1. **相对路径优先**：生产环境由后端同源托管前端（只暴露一个地址、一个端口），
 *      开发环境由 Vite 代理 /api，所以默认 baseUrl 为空即可；
 *      仅在前后端分离部署（Vercel + 云服务器）时才需要 VITE_API_BASE_URL。
 *   2. **错误结构化**：后端统一返回 { statusCode, code, message }，
 *      这里抛出 ApiError 保留 code，UI 据此显示中文提示而不是 "Request failed 500"。
 *   3. **超时可控**：现场网络差，请求可能一直挂着。默认 15 秒超时，
 *      离线补传这种大请求单独放宽，避免「明明在传却被前端判成失败」。
 */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  /** 网络不通（不是服务端拒绝），离线逻辑据此决定「入队而不是报错」。 */
  get isNetworkError(): boolean {
    return this.statusCode === 0;
  }
}

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
  return `${BASE_URL}/api${path.startsWith('/') ? path : `/${path}`}`;
}

/** Socket.IO 连接地址：未配置时用当前源（生产同源 / 开发走 Vite 代理）。 */
export function socketUrl(): string {
  return BASE_URL || window.location.origin;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  passcode?: string;
  timeoutMs?: number;
  /** 允许调用方在请求发出后取消（页面卸载）。 */
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, passcode, timeoutMs = 15_000, signal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 同时尊重调用方传入的 signal
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(apiUrl(path), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(passcode ? { 'x-scorer-passcode': passcode } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      const errorBody = (parsed ?? {}) as Partial<ApiErrorBody>;
      throw new ApiError(
        response.status,
        errorBody.code ?? 'HTTP_ERROR',
        errorBody.message ?? `请求失败（HTTP ${response.status}）`,
      );
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', '请求超时：现场网络可能不稳定，稍后会自动重试');
    }
    // fetch 直接抛错 = 网络层不通（断网、DNS、混合内容），这是离线分支的入口
    throw new ApiError(0, 'NETWORK_ERROR', `无法连接服务器：${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 接口封装 ------------------------------ */

export const api = {
  health: () => request<{ status: string; version: string; storageDriver: string; projectionVersion: string }>('/health'),

  publicConfig: () =>
    request<{ projectionVersion: string; storageDriver: string; scorerPasscodeIsDefault: boolean; maxSyncBatch: number }>(
      '/config/public',
    ),

  listMatches: (params: { status?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.limit) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<{ items: MatchSummary[]; total: number }>(`/matches${query ? `?${query}` : ''}`);
  },

  getMatch: (matchId: string) => request<MatchDetail>(`/matches/${matchId}`),

  getMatchByCode: (code: string) => request<MatchDetail>(`/matches/by-code/${encodeURIComponent(code)}`),

  createMatch: (payload: unknown) => request<MatchDetail>('/matches', { method: 'POST', body: payload }),

  updateMatch: (matchId: string, payload: unknown) =>
    request<MatchDetail>(`/matches/${matchId}`, { method: 'PATCH', body: payload }),

  archiveMatch: (matchId: string) => request<MatchDetail>(`/matches/${matchId}/archive`, { method: 'POST' }),

  addPlayer: (matchId: string, payload: unknown) =>
    request<unknown>(`/matches/${matchId}/players`, { method: 'POST', body: payload }),

  deletePlayer: (matchId: string, playerId: string) =>
    request<{ deleted: boolean }>(`/matches/${matchId}/players/${playerId}`, { method: 'DELETE' }),

  createSeason: (payload: unknown) => request<unknown>('/seasons', { method: 'POST', body: payload }),

  listSeasons: () => request<{ items: Array<{ id: string; name: string; matchCount: number }> }>('/seasons'),

  /** 首屏：比分 + 图文直播 + 撤销栈一次拿全。 */
  live: (matchId: string, feedLimit = 100) =>
    request<{
      state: import('@openhoopscore/contracts').MatchState;
      feed: import('@openhoopscore/contracts').LiveFeedItem[];
      timeline: import('@openhoopscore/contracts').ScoreTimelinePoint[];
      undoable: import('@openhoopscore/contracts').UndoableAction[];
    }>(`/matches/${matchId}/live?feedLimit=${feedLimit}`),

  scoreboard: (matchId: string) =>
    request<import('@openhoopscore/contracts').Scoreboard>(`/matches/${matchId}/scoreboard`),

  leaderboard: (matchId: string, sortedBy: 'points' | 'fouls' | 'threePointersMade' = 'points') =>
    request<PlayerLeaderboardResponse>(`/matches/${matchId}/leaderboard?sortedBy=${sortedBy}`),

  events: (matchId: string, sinceSeq = 0, limit = 1000) =>
    request<QueryEventsResponse>(`/matches/${matchId}/events?sinceSeq=${sinceSeq}&limit=${limit}`),

  /** 提交事件：在线实时与离线补传共用。补传时超时放宽到 60 秒。 */
  submitEvents: (
    matchId: string,
    payload: { clientId: string; events: GameEventDraft[]; sinceSeq?: number },
    passcode: string,
  ) =>
    request<SubmitEventsResult>(`/matches/${matchId}/events`, {
      method: 'POST',
      body: { ...payload, passcode },
      passcode,
      timeoutMs: 60_000,
    }),

  undo: (
    matchId: string,
    payload: { clientId: string; targetEventId?: string; steps?: number; reason?: string },
    passcode: string,
  ) => request<UndoResult>(`/matches/${matchId}/undo`, { method: 'POST', body: { ...payload, passcode }, passcode }),

  setClock: (
    matchId: string,
    payload: { clientId: string; period?: number; gameClockSeconds?: number | null; running?: boolean },
    passcode: string,
  ) => request<{ state: import('@openhoopscore/contracts').MatchState }>(`/matches/${matchId}/clock`, {
    method: 'POST',
    body: { ...payload, passcode },
    passcode,
  }),

  finishMatch: (matchId: string, payload: { clientId: string; reason?: string }, passcode: string) =>
    request<{ state: import('@openhoopscore/contracts').MatchState }>(`/matches/${matchId}/finish`, {
      method: 'POST',
      body: { ...payload, passcode },
      passcode,
    }),

  /** 本地队列对账：返回服务端确实已经收到的 clientEventId。 */
  reconcile: (matchId: string, clientEventIds: string[]) =>
    request<{ acknowledged: string[]; unknown: string[] }>(`/matches/${matchId}/reconcile`, {
      method: 'POST',
      body: { clientEventIds },
    }),

  /** 无副作用试算，用于校验本地投影与服务端一致。 */
  preview: (matchId: string, events: GameEventDraft[]) =>
    request<{ homeScore: number; awayScore: number; period: number; projectionVersion: string }>(
      `/matches/${matchId}/preview`,
      { method: 'POST', body: { events }, timeoutMs: 30_000 },
    ),

  onlineScorers: (matchId: string) =>
    request<{ online: Array<{ clientId: string; since: string }> }>(`/matches/${matchId}/realtime/scorers`),
};

export type { GameEvent, GameEventDraft, EventCursor, MatchDetail, MatchSummary };
