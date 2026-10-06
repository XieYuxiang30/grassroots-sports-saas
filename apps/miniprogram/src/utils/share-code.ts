/**
 * 分享码解析。
 *
 * 后端 shareCode 约定为 6 位大写字母 + 数字（见 packages/contracts Match.shareCode）。
 * 现场传播形式很多，扫码可能拿到任何一种，这里统一归一化：
 *   1. 纯 6 位码：            `ABC123`
 *   2. 查询参数：             `http://host/m/xxx?code=ABC123`
 *   3. 路径形式：             `https://host/m/ABC123`
 *   4. 中文口令式文案：        `扫码看比分 ABC123`
 *   5. 微信小程序码里的 query: `code=ABC123&from=scan`
 *   6. 形如 `/pages/live/index?code=ABC123` 的小程序路径
 *
 * 返回 `null` 表示没解析出合法分享码，调用方应提示用户重扫或手输。
 */

/** 分享码字符集：去掉容易念错的 0/O/1/I（后端生成时也应遵循）。 */
export const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SHARE_CODE_PATTERN = /^[A-Z0-9]{6}$/;

const CODE_QUERY_KEYS = ['code', 'shareCode', 'share_code', 'c', 'sc', 'invite'];

function normalizeCandidate(raw: string): string {
  return raw.trim().toUpperCase();
}

function isLikelyCode(value: string): boolean {
  const candidate = normalizeCandidate(value);
  // 纯数字或含 0/O/1/I 的码在旧数据里可能存在，因此这里只校验长度与字符集，
  // 不用 SHARE_CODE_ALPHABET 做硬性拒绝，避免把历史数据判死。
  return SHARE_CODE_PATTERN.test(candidate);
}

/** 从 query string（可带前导 `?`）里找 code 参数。 */
function fromQueryString(input: string): string | null {
  const queryIndex = input.indexOf('?');
  const hashIndex = input.indexOf('#');
  let query = input;
  if (queryIndex >= 0) {
    query = input.slice(queryIndex + 1);
  } else if (hashIndex >= 0) {
    query = input.slice(hashIndex + 1);
  }
  if (!query.includes('=')) return null;

  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = decodeURIComponent(pair.slice(0, eq)).trim();
    const value = decodeURIComponent(pair.slice(eq + 1)).trim();
    if (!value) continue;
    if (CODE_QUERY_KEYS.includes(key) && isLikelyCode(value)) {
      return normalizeCandidate(value);
    }
  }
  return null;
}

/** 从路径段里找 code：`/m/ABC123`、`/match/ABC123`、`/live/ABC123`。 */
function fromPathSegments(input: string): string | null {
  const withoutQuery = input.split('?')[0]?.split('#')[0] ?? '';
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment && isLikelyCode(segment)) return normalizeCandidate(segment);
  }
  return null;
}

/**
 * 解析任意用户输入 / 扫码结果，返回 6 位分享码或 null。
 */
export function parseShareCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const input = String(raw).trim();
  if (!input) return null;

  // 1) 纯码优先（用户手输场景）。
  if (isLikelyCode(input)) return normalizeCandidate(input);

  // 2) query 参数。
  const fromQuery = fromQueryString(input);
  if (fromQuery) return fromQuery;

  // 3) 路径段。
  const fromPath = fromPathSegments(input);
  if (fromPath) return fromPath;

  // 4) 文案兜底：在任意位置找独立的 6 位码（例如「比分 ABC123 扫码」）。
  const tokens = input.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    if (isLikelyCode(token)) return token;
  }
  return null;
}

/** 判断是否是合法的 6 位分享码。 */
export function isValidShareCode(raw: string | null | undefined): boolean {
  return parseShareCode(raw) !== null;
}

/** 归一化用户正在输入的分享码：转大写、剔除非法字符、最多 6 位。 */
export function normalizeShareCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/**
 * 生成可分享的 H5 链接（用于「复制链接」按钮）。
 * 小程序内没有 window.location，直接基于传入的 web 站点地址拼接。
 */
export function buildShareUrl(webOrigin: string, code: string): string {
  const origin = webOrigin.replace(/\/+$/, '');
  return `${origin}/m/${encodeURIComponent(code.toUpperCase())}`;
}
