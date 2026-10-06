/**
 * 时间格式化工具。
 * 事件溯源场景下所有时间都是 ISO 字符串，观众端只需要「mm:ss / HH:mm / N 分钟前」三种展示。
 */

/** 剩余秒数 → `mm:ss`；无计时员时返回 `--:--`。 */
export function formatClock(seconds: number | null | undefined, fallback = '--:--'): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return fallback;
  const clamped = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(clamped / 60)
    .toString()
    .padStart(2, '0');
  const ss = (clamped % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 第几节的中文展示：1-4 节 + 加时。 */
export function formatPeriod(period: number, regulationPeriods = 4): string {
  if (!Number.isFinite(period) || period <= 0) return '未开始';
  if (period <= regulationPeriods) return `第 ${period} 节`;
  return `加时 ${period - regulationPeriods}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** ISO 字符串 → `HH:mm`。解析失败返回 `--:--`。 */
export function formatTimeOfDay(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '--:--';
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** ISO 字符串 → `HH:mm:ss`，图文直播流里更精确。 */
export function formatTimeOfDaySeconds(iso: string | null | undefined): string {
  if (!iso) return '--:--:--';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '--:--:--';
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** ISO 字符串 → `MM-DD`。 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '--';
  const date = new Date(ms);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** ISO 字符串 → `N 秒前 / N 分钟前 / N 小时前`。 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return '暂无数据';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '暂无数据';
  const diffSeconds = Math.floor((now - ms) / 1000);
  if (diffSeconds < 0) return '刚刚';
  if (diffSeconds < 10) return '刚刚';
  if (diffSeconds < 60) return `${diffSeconds} 秒前`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/** 秒数 → `mm:ss`（历史别名，保持与 contracts.formatGameClock 一致的语义）。 */
export function formatGameClockLocal(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return formatClock(seconds);
}
