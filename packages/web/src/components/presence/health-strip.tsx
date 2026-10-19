/**
 * The health strip of a line's page and a routine's page
 * (docs/specs/2026-10-16-presence-hub-design.md Part D step 1.4, Part E
 * step 2): one ruled row that answers "is it working". It shows when Valet
 * last acted (or fired), how many times in 30 days, the fault when one
 * exists, and at the right a 30-day pulse: one bar per day, height by the
 * day's count, the last day emphasized. On a phone the pulse wraps under
 * the facts.
 */
import { cn } from "~/lib/cn";
import { relativeTime } from "~/lib/relative-time";

/** The number of days the strip covers. */
export const HEALTH_DAYS = 30;
const DAY_MS = 86_400_000;
const BAR_MAX = 32;
const BAR_MIN = 2;

/**
 * Counts per UTC day for the last 30 days, oldest first, today last, as the
 * api counts a line's `perDay`. A time outside the window does not count.
 */
export function perDayCounts(times: readonly number[], now: number = Date.now()): number[] {
  const today = Math.floor(now / DAY_MS);
  const first = today - (HEALTH_DAYS - 1);
  const counts = Array.from({ length: HEALTH_DAYS }, () => 0);
  for (const at of times) {
    const day = Math.floor(at / DAY_MS);
    if (day < first || day > today) continue;
    counts[day - first] = (counts[day - first] ?? 0) + 1;
  }
  return counts;
}

/** A bar's height in pixels: proportional to the busiest day, never under 2px. */
export function barHeight(count: number, max: number): number {
  if (count <= 0 || max <= 0) return BAR_MIN;
  return Math.max(BAR_MIN, Math.round((count / max) * BAR_MAX));
}

function Fact({ value, label, danger = false }: { value: string; label: string; danger?: boolean }) {
  return (
    <div className="min-w-0">
      <p className={cn("text-lg font-medium leading-tight", danger ? "text-danger-500" : "text-ink")}>{value}</p>
      <p className="text-[13px] text-muted [overflow-wrap:anywhere]">{label}</p>
    </div>
  );
}

export function HealthStrip({
  lastAt,
  count,
  perDay,
  fault,
  labels,
}: {
  lastAt: number | null;
  /** The count for `times in 30 days`. Null hides the fact, for a history the api does not record. */
  count: number | null;
  /** 30 counts, oldest first; the last is today. */
  perDay: readonly number[];
  fault?: { title: string; detail: string };
  labels: { last: "last acted" | "last fired" };
}) {
  // Always 30 bars: a short array pads with empty days at the start.
  const days = [...Array.from({ length: Math.max(0, HEALTH_DAYS - perDay.length) }, () => 0), ...perDay.slice(-HEALTH_DAYS)];
  const max = Math.max(0, ...days);
  const verb = labels.last === "last fired" ? "fired" : "acted";
  return (
    <section
      aria-label="Health"
      className="grid grid-cols-2 items-center gap-x-6 gap-y-3 border-y border-line py-3.5 text-sm sm:grid-cols-[auto_auto_auto_1fr]"
    >
      <Fact value={lastAt === null ? "never" : relativeTime(lastAt)} label={labels.last} />
      {count !== null && <Fact value={String(count)} label="times in 30 days" />}
      {fault !== undefined && <Fact value={fault.title} label={fault.detail} danger />}
      <div
        role="img"
        aria-label="Activity over the last 30 days"
        className="col-span-full flex h-8 items-end gap-[3px] justify-self-start sm:col-span-1 sm:col-start-4 sm:justify-self-end"
      >
        {days.map((n, day) => (
          // A fixed 30-slot array: the day's position is its identity, so the index is the key.
          <span
            key={day}
            data-day={day}
            title={`${n} ${verb}`}
            className={cn("block w-1.5 rounded-sm", day === HEALTH_DAYS - 1 ? "bg-moss" : "bg-moss-wash")}
            style={{ height: barHeight(n, max) }}
          />
        ))}
      </div>
    </section>
  );
}
