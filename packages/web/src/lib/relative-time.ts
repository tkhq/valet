/**
 * Small relative-time formatter for notification timestamps — no
 * date-fns/dayjs dependency for one label. Pure function so it's testable
 * without mounting a component; `now` is injectable for deterministic
 * tests.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return "just now";
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m}m ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}h ago`;
  }
  const d = Math.floor(diff / DAY);
  return `${d}d ago`;
}
