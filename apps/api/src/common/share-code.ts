/**
 * 分享码生成。
 *
 * 现场的实际用法是：计分员把二维码投在大屏上，观众扫；或者口头报码让人手输。
 * 因此分享码要满足：
 *   - 短（6 位）：能念、能输；
 *   - 无歧义：去掉 0/O、1/I/L 等易混字符；
 *   - 大小写不敏感：用户输小写也能进。
 */

/** 去掉了 0 O 1 I L 的 32 字符表，6 位约 10 亿组合，足够单机部署使用。 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHARE_CODE_LENGTH = 6;

export function generateShareCode(random: () => number = Math.random): string {
  let code = '';
  for (let index = 0; index < SHARE_CODE_LENGTH; index += 1) {
    code += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? '2';
  }
  return code;
}

export function normalizeShareCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * 从任意文本里解析分享码。
 * 支持三种真实场景：纯 6 位码、含 ?code= 的链接、含 /m/CODE 的短链。
 */
export function parseShareCode(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  const queryMatch = /[?&]code=([0-9A-Za-z]{4,12})/.exec(trimmed);
  if (queryMatch?.[1]) return normalizeShareCode(queryMatch[1]);

  const pathMatch = /\/m\/([0-9A-Za-z]{4,12})/.exec(trimmed);
  if (pathMatch?.[1]) return normalizeShareCode(pathMatch[1]);

  const normalized = normalizeShareCode(trimmed);
  if (normalized.length === SHARE_CODE_LENGTH) return normalized;

  return null;
}

/** 生成比赛分享链接（小程序 / H5 / 大屏通用）。 */
export function buildShareUrl(baseUrl: string, shareCode: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/m/${shareCode}`;
}
