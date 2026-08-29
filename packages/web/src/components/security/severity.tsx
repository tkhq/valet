import { Check } from "lucide-react";
import type { SecurityFindingSeverity, SecurityFindingStatus } from "@valet/api/wire";
import { cn } from "~/lib/cn";

/**
 * Severity + status marks for the findings surface and the `sec_*` tool
 * renderers — one spelling so a finding card in the thread and its row in
 * the review list cannot disagree.
 *
 * The palette maps to the theme's tokens, not the raw Tailwind rainbow:
 * critical rides the danger tokens, high/medium the amber scale (the only
 * warm full ramp the theme ships — see `tailwind.config.ts`; there is no
 * orange scale), low the accent (brand blue), info neutral.
 */

export const SEVERITY_ORDER: readonly SecurityFindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

/** Lower is more severe — the findings list's default sort key. */
export function severityRank(severity: SecurityFindingSeverity): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

const SEVERITY_CLASS: Record<SecurityFindingSeverity, string> = {
  critical: "bg-danger-wash text-danger-600 dark:text-danger-500",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300",
  medium: "bg-warning-wash text-warning-fg",
  low: "bg-accent-100 text-accent-700 dark:bg-accent-700 dark:text-accent-50",
  info: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

export function SeverityBadge({
  severity,
  className,
}: {
  severity: SecurityFindingSeverity;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        SEVERITY_CLASS[severity],
        className,
      )}
    >
      {severity}
    </span>
  );
}

/** Solid severity fills for the distribution bar and legend dots. Critical rides
 * danger; high/medium step down the amber ramp; low is the brand accent; info is
 * neutral. One spelling with `SEVERITY_CLASS` above. */
export const SEVERITY_FILL: Record<SecurityFindingSeverity, string> = {
  critical: "bg-danger-500",
  high: "bg-amber-500",
  medium: "bg-amber-300",
  low: "bg-accent-400 dark:bg-accent-500",
  info: "bg-neutral-300 dark:bg-neutral-600",
};

/** A one-line severity distribution: a segmented bar over the total plus a
 * count-per-severity legend. Renders nothing when the total is zero, so a
 * caller can drop it in unconditionally. */
export function SeverityBar({
  counts,
  className,
}: {
  counts: Partial<Record<SecurityFindingSeverity, number>>;
  className?: string;
}) {
  const total = SEVERITY_ORDER.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  if (total === 0) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden>
        {SEVERITY_ORDER.map((s) => {
          const c = counts[s] ?? 0;
          if (c === 0) return null;
          return (
            <div key={s} className={SEVERITY_FILL[s]} style={{ width: `${(c / total) * 100}%` }} />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {SEVERITY_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
          <span key={s} className="inline-flex items-center gap-1 text-muted">
            <span className={cn("h-2 w-2 rounded-full", SEVERITY_FILL[s])} aria-hidden />
            <span className="tabular-nums font-medium text-ink">{counts[s]}</span> {s}
          </span>
        ))}
      </div>
    </div>
  );
}

const STATUS_CLASS: Record<SecurityFindingStatus, string> = {
  open: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  verified: "bg-success-wash text-success-600 dark:text-success-500",
  refuted: "bg-neutral-100 text-muted line-through dark:bg-neutral-800",
  // Re-scan v2: a carried finding the reconcile pass confirmed is resolved.
  // Calm-positive, not an error — it reads differently from `verified` (a
  // still-open, human-confirmed issue) with a leading check mark. `verified`
  // fills the pill; `fixed` outlines it so the two never blur together.
  fixed:
    "bg-success-wash text-success-600 ring-1 ring-inset ring-success-600/40 dark:text-success-500",
};

export function FindingStatusChip({
  status,
  className,
}: {
  status: SecurityFindingStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        STATUS_CLASS[status],
        className,
      )}
    >
      {status === "fixed" && <Check className="h-2.5 w-2.5" aria-hidden />}
      {status}
    </span>
  );
}
