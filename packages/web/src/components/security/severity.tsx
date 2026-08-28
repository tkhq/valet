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

const STATUS_CLASS: Record<SecurityFindingStatus, string> = {
  open: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  verified: "bg-success-wash text-success-600 dark:text-success-500",
  refuted: "bg-neutral-100 text-muted line-through dark:bg-neutral-800",
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
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        STATUS_CLASS[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
