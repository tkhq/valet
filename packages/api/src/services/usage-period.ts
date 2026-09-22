const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

export const USAGE_WINDOWS = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
} as const;

export type UsageWindowKey = keyof typeof USAGE_WINDOWS;

export interface UsagePeriodQuery {
  window?: string;
  month?: string;
  start?: string;
  end?: string;
}

export interface ResolvedUsagePeriod {
  /** Inclusive UTC boundary. */
  startMs: number;
  /** Exclusive UTC boundary. */
  endMs: number;
  label: string;
  kind: "lookback" | "month" | "custom";
  /** Exact display duration for rolling lookbacks. */
  windowMs?: number;
  /** UTC calendar boundary used by daily agent metrics. */
  activityStartMs?: number;
  activityDays?: number;
}

export type UsagePeriodErrorCode =
  | "invalid_period"
  | "invalid_date"
  | "reversed_range"
  | "future_range"
  | "range_too_large";

export type UsagePeriodResult =
  | { ok: true; period: ResolvedUsagePeriod }
  | { ok: false; error: { code: UsagePeriodErrorCode; message: string } };

function utcDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const time = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== (month ?? 1) - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }
  return time;
}

function utcMonth(value: string): { startMs: number; endMs: number } | undefined {
  if (!/^\d{4}-\d{2}$/.test(value)) return undefined;
  const [year, month] = value.split("-").map(Number);
  if (year === undefined || month === undefined || month < 1 || month > 12) return undefined;
  const startMs = Date.UTC(year, month - 1, 1);
  const start = new Date(startMs);
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== 1) {
    return undefined;
  }
  return { startMs, endMs: Date.UTC(year, month, 1) };
}

function dateLabel(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Resolve one reporting period. Custom dates are inclusive in the request and
 * become a half-open UTC interval. The current month ends after the current
 * UTC day, so a report never requests a future date.
 */
export function resolveUsagePeriod(query: UsagePeriodQuery, now = Date.now()): UsagePeriodResult {
  const hasCustom = query.start !== undefined || query.end !== undefined;
  const selectedKinds = Number(query.window !== undefined) + Number(query.month !== undefined) + Number(hasCustom);
  if (selectedKinds > 1 || (hasCustom && (query.start === undefined || query.end === undefined))) {
    return { ok: false, error: { code: "invalid_period", message: "Choose one month or provide both start and end dates." } };
  }

  const todayMs = Math.floor(now / DAY_MS) * DAY_MS;
  const tomorrowMs = todayMs + DAY_MS;

  if (query.month !== undefined) {
    const month = utcMonth(query.month);
    if (!month) {
      return { ok: false, error: { code: "invalid_date", message: "Use YYYY-MM for the month." } };
    }
    if (month.startMs > todayMs) {
      return { ok: false, error: { code: "future_range", message: "Choose the current month or an earlier month." } };
    }
    return {
      ok: true,
      period: {
        startMs: month.startMs,
        endMs: Math.min(month.endMs, tomorrowMs),
        label: query.month,
        kind: "month",
      },
    };
  }

  if (query.start !== undefined && query.end !== undefined) {
    const startMs = utcDate(query.start);
    const inclusiveEndMs = utcDate(query.end);
    if (startMs === undefined || inclusiveEndMs === undefined) {
      return { ok: false, error: { code: "invalid_date", message: "Use valid YYYY-MM-DD start and end dates." } };
    }
    if (startMs > inclusiveEndMs) {
      return { ok: false, error: { code: "reversed_range", message: "Choose an end date on or after the start date." } };
    }
    if (inclusiveEndMs > todayMs) {
      return { ok: false, error: { code: "future_range", message: "Choose today or an earlier end date." } };
    }
    const endMs = inclusiveEndMs + DAY_MS;
    if ((endMs - startMs) / DAY_MS > MAX_RANGE_DAYS) {
      return { ok: false, error: { code: "range_too_large", message: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.` } };
    }
    return {
      ok: true,
      period: {
        startMs,
        endMs,
        label: `${dateLabel(startMs)}_to_${dateLabel(inclusiveEndMs)}`,
        kind: "custom",
      },
    };
  }

  const window = query.window && query.window in USAGE_WINDOWS ? query.window as UsageWindowKey : "30d";
  return {
    ok: true,
    period: {
      startMs: now - USAGE_WINDOWS[window],
      endMs: now + 1,
      label: window,
      kind: "lookback",
      windowMs: USAGE_WINDOWS[window],
      activityStartMs: todayMs - USAGE_WINDOWS[window] + DAY_MS,
      activityDays: USAGE_WINDOWS[window] / DAY_MS,
    },
  };
}
