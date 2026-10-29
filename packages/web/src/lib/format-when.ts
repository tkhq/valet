/** Compact timestamp for list rows: "Aug 11, 09:00 PM". */
export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A date and a time without seconds: "Oct 19, 2026, 4:00 PM". `locale` and
 * `timeZone` default to the reader's; tests pin them. */
export function formatDateTime(ts: number, { locale, timeZone }: { locale?: string; timeZone?: string } = {}): string {
  return new Date(ts).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone !== undefined ? { timeZone } : {}) });
}

/** Request-log timestamp with seconds and a year only when it is not current. */
export function formatRequestDateTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Date-only variant for created-at rows: "Aug 11, 2026". */
export function formatDate(ts: number | Date): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** `formatDate`, but a missing timestamp reads as `fallback` instead of
 * throwing on `new Date(null)` (which renders "Invalid Date"). */
export function formatDateOr(ts: number | Date | null | undefined, fallback: string): string {
  return ts ? formatDate(ts) : fallback;
}
