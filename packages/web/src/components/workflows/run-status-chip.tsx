import type { WorkflowRunOutcome, WorkflowRunStatus } from "@valet/api/wire";

// Token substitutions: `info-500` → `accent-500`, `warning-500` → `amber-500`.
// The project tailwind config has no `info` or `warning` scales; `accent` and
// `amber` are defined and used elsewhere for the same semantic roles.
const STYLES: Record<string, string> = {
  pending: "bg-muted/20 text-muted",
  running: "bg-accent-500/15 text-accent-500",
  parked: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  terminalizing: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  completed: "bg-moss/15 text-moss",
  failed: "bg-danger-500/15 text-danger-500",
  cancelled: "bg-muted/20 text-muted",
};

/** One chip for run state: outcome once settled, status until then. */
export function RunStatusChip({
  status,
  outcome,
}: {
  status: WorkflowRunStatus;
  outcome?: WorkflowRunOutcome;
}) {
  const label = status === "settled" ? (outcome ?? "settled") : status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[label] ?? "bg-muted/20 text-muted"}`}
    >
      {label}
    </span>
  );
}
