import { cn } from "~/lib/cn";

const LEVEL_CLASS: Record<string, string> = {
  low: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  critical: "bg-danger-500/15 text-danger-600 dark:text-danger-500",
};

const FALLBACK_CLASS = "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";

/**
 * Colour-coded badge for a gate's risk level (low / medium / high / critical).
 * Unknown levels fall back to neutral styling.
 */
export function RiskBadge({ level }: { level: string }) {
  const cls = LEVEL_CLASS[level] ?? FALLBACK_CLASS;
  return (
    <span
      className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium", cls)}
    >
      {level}
    </span>
  );
}
