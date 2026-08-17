/** Compact timestamp for list rows: "Aug 11, 09:00 PM". */
export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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
