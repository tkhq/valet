/**
 * The latest run's answer, on the workflow row itself.
 *
 * The Workflows tab used to show only a status chip, so reading what five
 * workflows produced this morning took five trips through run detail. This
 * line brings the settled result to the list: outcome glyph, when it
 * settled, how long it took, and the stop node's message on one line.
 *
 * The result is not on the run summary — the run row has no result column
 * (`deriveRunResult` explains why) — so a settled run's detail is fetched
 * here per row. `useRunDetail` never polls a settled run and react-query
 * caches by run id, so each settled result costs one request total, not one
 * per render. An in-flight run skips the fetch entirely: its status line
 * needs nothing beyond the summary, and the row would otherwise poll once
 * per workflow.
 */
import { Link } from "@tanstack/react-router";
import type { WorkflowRunStatus, WorkflowRunSummary } from "@valet/api/wire";
import { useRunDetail } from "~/api/workflows";
import { relativeTime } from "~/lib/relative-time";
import {
  deriveRunResult,
  formatRunDuration,
  runResultSnippet,
  type RunResult,
} from "./run-detail-helpers";

/** Same glyph family the run canvas uses (`RUN_STATUS_GLYPH`), keyed by the
 * run's own states rather than a node's. */
const OUTCOME_GLYPH: Record<RunResult["outcome"], string> = {
  completed: "✓",
  failed: "✕",
  cancelled: "⊘",
};

/** Accents match `run-detail-result.tsx` so a color means the same thing on
 * the list and on the detail page. */
const OUTCOME_ACCENT: Record<RunResult["outcome"], string> = {
  completed: "text-success-600 dark:text-success-500",
  failed: "text-danger-500",
  cancelled: "text-muted",
};

/** What to say when the run settled but recorded nothing readable. Short
 * forms of the detail page's empty-state copy — a list row has no room to
 * explain the fix, the detail page (one click away) does. */
const EMPTY_SNIPPET: Record<RunResult["outcome"], string> = {
  completed: "Finished without a result message",
  failed: "Failed with no recorded reason",
  cancelled: "Cancelled",
};

const IN_FLIGHT_GLYPH: Record<Exclude<WorkflowRunStatus, "settled">, string> = {
  pending: "○",
  running: "◐",
  parked: "⏸",
  terminalizing: "◐",
};

const IN_FLIGHT_LABEL: Record<Exclude<WorkflowRunStatus, "settled">, string> = {
  pending: "Queued",
  running: "Running",
  parked: "Waiting",
  terminalizing: "Finishing",
};

export function LatestRunLine({ run }: { run: WorkflowRunSummary }) {
  const settled = run.status === "settled";
  const detailQ = useRunDetail(run.runId, { enabled: settled });

  let glyph: string;
  let accent: string;
  let body: string;
  let bodyMuted = false;

  if (!settled) {
    const status = run.status as Exclude<WorkflowRunStatus, "settled">;
    glyph = IN_FLIGHT_GLYPH[status];
    accent = status === "parked" ? "text-amber" : "text-moss";
    body = run.needsApproval ? "Waiting for approval" : IN_FLIGHT_LABEL[status];
  } else {
    const result = detailQ.data
      ? deriveRunResult(detailQ.data.run, detailQ.data.checkpoints)
      : undefined;
    // While detail is loading (or on a run settled with no known outcome)
    // the summary's own outcome still names the glyph, so the line never
    // flashes a wrong state.
    const outcome = result?.outcome ?? run.outcome ?? "completed";
    glyph = OUTCOME_GLYPH[outcome];
    accent = OUTCOME_ACCENT[outcome];
    const snippet = result ? runResultSnippet(result) : undefined;
    if (snippet !== undefined) {
      body = snippet;
    } else if (detailQ.isError) {
      // A failed detail fetch means the result couldn't be read — saying the
      // run "finished without a result message" would be a lie.
      body = "Result unavailable";
      bodyMuted = true;
    } else {
      body = detailQ.isLoading ? "…" : EMPTY_SNIPPET[outcome];
      bodyMuted = true;
    }
  }

  const duration = settled ? formatRunDuration(run.createdAt, run.updatedAt) : undefined;

  return (
    <Link
      to="/workflows/runs/$runId"
      params={{ runId: run.runId }}
      className="group/result flex min-w-0 items-baseline gap-2 text-xs"
      title="Open run detail"
    >
      <span aria-hidden className={`shrink-0 ${accent}`}>
        {glyph}
      </span>
      <span className="shrink-0 text-muted">
        {relativeTime(run.updatedAt)}
        {duration !== undefined && ` · ${duration}`}
      </span>
      <span
        className={`min-w-0 truncate group-hover/result:underline ${
          bodyMuted ? "text-muted italic" : "text-ink"
        }`}
      >
        {body}
      </span>
    </Link>
  );
}
