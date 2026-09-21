export const USAGE_REPORTING_TIMEZONE = 'UTC' as const;
export const USAGE_LOOKBACK_HOURS = [1, 24, 168, 720, 8760] as const;

export type UsageScope = 'personal' | 'team' | 'org';
export type UsagePeriodSelection =
  | { kind: 'lookback'; hours: (typeof USAGE_LOOKBACK_HOURS)[number] }
  | { kind: 'month'; month: string }
  | { kind: 'range'; start: string; end: string };

export interface ResolvedUsagePeriod {
  selection: UsagePeriodSelection;
  start: string;
  end: string;
  label: string;
  timezone: typeof USAGE_REPORTING_TIMEZONE;
}

export class UsagePeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsagePeriodError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function parseUtcDate(value: string, field: string): Date {
  if (!DATE_RE.test(value)) throw new UsagePeriodError(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new UsagePeriodError(`${field} is not a valid calendar date`);
  }
  return date;
}

function parseMonth(value: string): Date {
  if (!MONTH_RE.test(value)) throw new UsagePeriodError('month must use YYYY-MM');
  const date = new Date(`${value}-01T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 7) !== value) {
    throw new UsagePeriodError('month is not a valid calendar month');
  }
  return date;
}

export function parseUsageScope(value: string | undefined): UsageScope {
  const scope = value ?? 'org';
  if (scope !== 'personal' && scope !== 'team' && scope !== 'org') {
    throw new UsagePeriodError('scope must be personal, team, or org');
  }
  return scope;
}

/** Resolve a report to an exact [start, end) interval in the reporting timezone (UTC). */
export function resolveUsagePeriod(params: URLSearchParams, now = new Date()): ResolvedUsagePeriod {
  const kind = params.get('periodType') ?? 'lookback';
  if (!Number.isFinite(now.getTime())) throw new UsagePeriodError('current time is invalid');

  if (kind === 'lookback') {
    const rawHours = params.get('period') ?? '720';
    const hours = Number(rawHours);
    if (!USAGE_LOOKBACK_HOURS.includes(hours as (typeof USAGE_LOOKBACK_HOURS)[number])) {
      throw new UsagePeriodError('period must be one of 1, 24, 168, 720, or 8760 hours');
    }
    const asOf = params.get('asOf');
    const endDate = asOf ? new Date(asOf) : now;
    if (!Number.isFinite(endDate.getTime()) || (asOf !== null && endDate.toISOString() !== asOf)) {
      throw new UsagePeriodError('asOf must be an ISO 8601 UTC timestamp');
    }
    if (endDate > now) throw new UsagePeriodError('asOf cannot be in the future');
    const end = endDate.toISOString();
    const start = new Date(endDate.getTime() - hours * 3_600_000).toISOString();
    return {
      selection: { kind: 'lookback', hours: hours as (typeof USAGE_LOOKBACK_HOURS)[number] },
      start,
      end,
      label: `rolling-${hours === 1 ? '1h' : `${hours / 24}d`}_${start}_${end}_UTC`,
      timezone: USAGE_REPORTING_TIMEZONE,
    };
  }

  if (kind === 'month') {
    const month = params.get('month') ?? '';
    const startDate = parseMonth(month);
    const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (startDate >= currentMonth) {
      throw new UsagePeriodError('month must be a completed calendar month');
    }
    const endDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
    return {
      selection: { kind: 'month', month },
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      label: `calendar-month_${month}_UTC`,
      timezone: USAGE_REPORTING_TIMEZONE,
    };
  }

  if (kind === 'range') {
    const startValue = params.get('start') ?? '';
    const endValue = params.get('end') ?? '';
    const startDate = parseUtcDate(startValue, 'start');
    const endDate = parseUtcDate(endValue, 'end');
    if (startDate >= endDate) throw new UsagePeriodError('start must be before end');
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    if (startDate > now || endDate > tomorrow) {
      throw new UsagePeriodError('range cannot extend beyond the next UTC day boundary');
    }
    return {
      selection: { kind: 'range', start: startValue, end: endValue },
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      label: `date-range_${startValue}_${endValue}_UTC`,
      timezone: USAGE_REPORTING_TIMEZONE,
    };
  }

  throw new UsagePeriodError('periodType must be lookback, month, or range');
}
