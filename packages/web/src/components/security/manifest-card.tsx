import type {
  SecurityCostWire,
  SecurityCellWire,
  SecurityDiffWire,
  SecurityFindingSeverity,
  SecurityFindingWire,
} from "@valet/api/wire";
import { Button } from "~/components/primitives";
import { ReviewCostLine } from "./cost-chip";
import { RescanDiffBanner } from "./rescan-diff";
import { SEVERITY_ORDER, SeverityBadge } from "./severity";

/**
 * The closed engagement's summary, at the top of the panel (spec §engagement
 * panel: Manifest). The `sec_close` manifest exists only in the runner's
 * tool result text — no REST route returns it — so this card derives the
 * same numbers from the rows the panel already reads: distinct-fingerprint
 * counts by severity, the status breakdown, and the triage tallies (issues
 * filed, findings a human dismissed). Spec deviation recorded in
 * docs/specs/2026-08-27-valet-security-design.md.
 */

export interface ManifestSummary {
  distinctBySeverity: Record<SecurityFindingSeverity, number>;
  statusBreakdown: { open: number; verified: number; refuted: number };
  /** Findings with at least one filed issue link. */
  issuesFiled: number;
  /** Findings a human (status_actor `user:*`) verified or refuted. */
  humanReviewed: number;
  cellsCompleted: number;
  cellsTotal: number;
}

/** Pure: the card's numbers from the rows. Distinct = per fingerprint, the
 * severity of a fingerprint being its most severe member. */
export function summarizeManifest(
  cells: SecurityCellWire[],
  findings: SecurityFindingWire[],
): ManifestSummary {
  const byFingerprint = new Map<string, SecurityFindingSeverity>();
  const statusBreakdown = { open: 0, verified: 0, refuted: 0 };
  let issuesFiled = 0;
  let humanReviewed = 0;
  for (const f of findings) {
    const prev = byFingerprint.get(f.fingerprint);
    if (prev === undefined || SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(prev)) {
      byFingerprint.set(f.fingerprint, f.severity);
    }
    statusBreakdown[f.status] += 1;
    if ((f.links ?? []).length > 0) issuesFiled += 1;
    if (f.status !== "open" && f.statusActor?.startsWith("user:")) humanReviewed += 1;
  }
  const distinctBySeverity: Record<SecurityFindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const severity of byFingerprint.values()) distinctBySeverity[severity] += 1;
  return {
    distinctBySeverity,
    statusBreakdown,
    issuesFiled,
    humanReviewed,
    cellsCompleted: cells.filter((c) => c.status === "completed").length,
    cellsTotal: cells.length,
  };
}

export function ManifestCard({
  cells,
  findings,
  status,
  cost,
  diff,
  baseRef,
  changedPaths,
  onRescan,
  rescanPending,
}: {
  cells: SecurityCellWire[];
  findings: SecurityFindingWire[];
  /** The closed engagement's terminal status. */
  status: "completed" | "failed";
  /** The engagement's final spend (runner + cell children). */
  cost: SecurityCostWire;
  /** The re-scan diff, when this engagement re-scanned a prior one. */
  diff?: SecurityDiffWire;
  /** Diff-scoped re-scan: the prior review's SHA the sweeps diffed against. */
  baseRef?: string | null;
  /** Diff-scoped re-scan: the changed file paths the sweeps scoped to. */
  changedPaths?: string[] | null;
  /** Start a re-scan of this engagement (re-scan / iterate). Absent hides the
   * button (e.g. the caller cannot administer). */
  onRescan?: () => void;
  /** True while the re-scan create is in flight. */
  rescanPending?: boolean;
}) {
  const summary = summarizeManifest(cells, findings);
  return (
    <section className="border-b border-line px-4 py-3" aria-label="Engagement manifest">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-ink">
          Engagement {status === "completed" ? "complete" : "failed"}
        </span>
        <span className="text-muted">
          {summary.cellsCompleted}/{summary.cellsTotal} cells completed
        </span>
        {onRescan && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={rescanPending}
            onClick={onRescan}
          >
            {rescanPending ? "Starting re-scan…" : "Re-scan latest"}
          </Button>
        )}
      </div>
      {diff && (
        <RescanDiffBanner
          diff={diff}
          terminal
          baseRef={baseRef}
          changedPaths={changedPaths}
          className="mt-2"
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {SEVERITY_ORDER.map((severity) =>
          summary.distinctBySeverity[severity] > 0 ? (
            <span key={severity} className="inline-flex items-center gap-1">
              <SeverityBadge severity={severity} />
              <span className="tabular-nums text-ink">{summary.distinctBySeverity[severity]}</span>
            </span>
          ) : null,
        )}
        {findings.length === 0 && <span className="text-muted">No findings reported.</span>}
      </div>
      <div className="mt-1.5 text-[11px] text-muted">
        {summary.statusBreakdown.open} open · {summary.statusBreakdown.verified} verified ·{" "}
        {summary.statusBreakdown.refuted} refuted · {summary.issuesFiled} filed as issues ·{" "}
        {summary.humanReviewed} human-reviewed
      </div>
      <ReviewCostLine cost={cost} />
    </section>
  );
}
