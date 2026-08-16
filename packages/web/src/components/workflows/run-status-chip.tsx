import type { WorkflowRunOutcome, WorkflowRunStatus } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Maps a settled run's outcome to the Badge variant.
 * Exported so the run detail route can reference it directly.
 */
export const OUTCOME_VARIANT: Record<WorkflowRunOutcome, "success" | "danger" | "neutral"> = {
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
} as const;

export interface RunStatusChipProps {
  status: WorkflowRunStatus;
  outcome?: WorkflowRunOutcome;
  needsApproval: boolean;
}

/**
 * Inline chip that reflects the current run state:
 * - needsApproval (parked + gates): amber "Needs approval" with a static dot
 * - parked, no gates: neutral "Waiting"
 * - running/pending: moss "Running"
 * - settled: outcome Badge via OUTCOME_VARIANT
 */
export function RunStatusChip({ status, outcome, needsApproval }: RunStatusChipProps) {
  if (needsApproval) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">
        <span className={cn("h-2 w-2 rounded-full bg-amber-500 shrink-0")} aria-hidden="true" />
        Needs approval
      </span>
    );
  }

  if (status === "settled") {
    if (outcome) {
      return <Badge variant={OUTCOME_VARIANT[outcome]}>{outcome}</Badge>;
    }
    return <Badge variant="neutral">settled</Badge>;
  }

  if (status === "parked") {
    return <Badge variant="neutral">Waiting</Badge>;
  }

  // running | pending | terminalizing
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium bg-success-500/15 text-success-600 dark:text-success-500">
      Running
    </span>
  );
}
