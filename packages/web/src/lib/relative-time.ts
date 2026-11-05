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

/** A future time as "in 14h", for next runs and expiries. A time that has
 * passed is "due now". */
export function timeUntil(ts: number, now: number = Date.now()): string {
  const delta = ts - now;
  if (delta <= 0) return "due now";
  const minutes = Math.round(delta / MINUTE);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
