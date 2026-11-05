import type { WorkflowRunOutcome, WorkflowRunStatus } from "@valet/api/wire";
import { Badge, StatusDot } from "~/components/primitives";
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

const OUTCOME_LABEL: Record<WorkflowRunOutcome, string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface RunStatusChipProps {
  status: WorkflowRunStatus;
  outcome?: WorkflowRunOutcome;
  needsApproval: boolean;
  className?: string;
}

/**
 * The one chip for a run's state, on the run page and in run lists:
 * - needsApproval (parked + gates): amber "Needs approval" with a dot
 * - parked, no gates: neutral "Waiting"
 * - running/pending/terminalizing: accent "Running" with a pulsing dot
 * - settled: the outcome, capitalized, in its OUTCOME_VARIANT color
 */
export function RunStatusChip({ status, outcome, needsApproval, className }: RunStatusChipProps) {
  if (needsApproval) {
    return (
      <Badge variant="warning" className={cn("gap-1.5", className)}>
        <StatusDot tone="warning" size="sm" />
        Needs approval
      </Badge>
    );
  }
  if (status === "settled") {
    return (
      <Badge variant={outcome ? OUTCOME_VARIANT[outcome] : "neutral"} className={className}>
        {outcome ? OUTCOME_LABEL[outcome] : "Finished"}
      </Badge>
    );
  }
  if (status === "parked") {
    return <Badge variant="neutral" className={className}>Waiting</Badge>;
  }
  return (
    <Badge variant="accent" className={cn("gap-1.5", className)}>
      <StatusDot tone="accent" size="sm" pulse />
      Running
    </Badge>
  );
}
