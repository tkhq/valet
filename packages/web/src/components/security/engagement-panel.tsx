import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useEngagement,
  useSecurityCoverage,
  useSecurityFindings,
  useCancelEngagement,
  useRescanReview,
  flattenFindings,
  apiErrorText,
} from "~/api/security";
import { useMe, useTeams } from "~/api/settings";
import { useSession } from "~/api/queries";
import { workspaceForRepo } from "~/components/repo-combobox";
import { useStreamStore } from "~/stores/stream";
import { Button, ConfirmDialog, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { useResizablePane } from "~/lib/use-resizable-pane";
import { CellRail } from "./cell-rail";
import { ReviewSummary } from "./review-summary";
import { CoverageSection } from "./coverage-section";
import { NeedsSection } from "./needs-section";
import { CostChip } from "./cost-chip";
import { FindingsReview } from "./findings-review";
import { ManifestCard } from "./manifest-card";
import { ReportSection } from "./report-section";
import { RescanDiffBanner } from "./rescan-diff";

/**
 * The security engagement panel (valet-security design §engagement panel):
 * manifest card once closed, the cell rail, and the findings review. No
 * `host_event` wire events on this branch, so the engagement polls every
 * 5s while it runs and the findings review polls on the same cadence.
 */
export function EngagementPanel({
  sessionId,
  initialFindingId,
  onOpenChild,
}: {
  sessionId: string;
  /** From the `?finding=` permalink param. */
  initialFindingId?: string;
  /** Open a cell's persona child as the `?child=` slide-over instead of
   * navigating to its standalone page. */
  onOpenChild?: (childId: string) => void;
}) {
  // Poll until the engagement is terminal — NOT only while "running". Cells
  // are materialized at sec_start, when the status flips planning → running;
  // gating the poll on status === "running" deadlocks, because the query
  // that would observe that flip is the one told not to refetch during
  // planning. A missing status (first load) polls too.
  const engagementQ = useEngagement(sessionId, {
    refetchInterval: (query) => {
      const status = query.state.data?.engagement.status;
      return status === "completed" || status === "failed" ? false : 5_000;
    },
  });

  // Admin gating mirrors the session header's rule: personal sessions are
  // administered by their owner (who is the only viewer), team sessions by
  // team admins and org admins. The routes enforce the real check; this
  // only hides buttons that would 403.
  const session = useSession(sessionId);
  const me = useMe();
  const teams = useTeams();
  const owner = session.data?.owner;
  const teamId = owner?.type === "team" ? owner.id : null;
  const team = teamId !== null ? teams.data?.teams.find((t) => t.id === teamId) : undefined;
  const canAdminister =
    teamId === null || team?.callerRole === "admin" || me.data?.orgRole === "admin";

  // The manifest card derives its tallies from the full (unfiltered)
  // findings set — the sec_close manifest is not on any GET route. Only
  // fetched once the engagement is closed.
  const closed =
    engagementQ.data?.engagement.status === "completed" ||
    engagementQ.data?.engagement.status === "failed";
  const allFindingsQ = useSecurityFindings(closed ? sessionId : "", {});

  // The coverage ledger (NOT_ASSESSED, M-P2d). Poll while the engagement runs
  // so recorded gaps appear live; stop once terminal.
  const running = engagementQ.data?.engagement.status === "running";
  const coverageQ = useSecurityCoverage(sessionId, {
    refetchInterval: running ? 5_000 : false,
  });

  const cancelMutation = useCancelEngagement(sessionId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const navigate = useNavigate();
  const rescan = useRescanReview();

  if (engagementQ.isPending) {
    return (
      <div className="p-4 text-xs text-muted">
        <Spinner /> Loading engagement…
      </div>
    );
  }
  if (engagementQ.isError || !engagementQ.data) {
    return (
      <div className="p-4 text-xs text-danger-600">
        Failed to load the security engagement. Reload the page to retry.
      </div>
    );
  }

  const { engagement, cells, cost, diff, planCells, report, needs } = engagementQ.data;
  // The report is generating while a report-persona cell is running (M-P3).
  const reportGenerating = cells.some((c) => c.persona === "report" && c.status === "running");
  // The config + plan are finalized pre-creation on `/security/new`; the session
  // page shows a compact READ-ONLY summary, never the editor (spec Deviations).
  // The cancel action is a human-only stop for an in-flight review. Show it
  // only while the engagement can still be cancelled AND the caller can
  // administer — the route enforces both; this only hides a button that 403s.
  const cancellable =
    canAdminister && (engagement.status === "planning" || engagement.status === "running");
  const terminal = engagement.status === "completed" || engagement.status === "failed";
  // Re-scan is a create, gated the same way as cancel — the route's create
  // path is view-gated, but only an admin should re-run a team review, so hide
  // it from non-admins. A re-scan re-uses the prior repo binding, so the
  // workspace only needs a valid host path; derive it the same way the hub does.
  function startRescan() {
    rescan.mutate(
      { rescanOf: sessionId, workspace: workspaceForRepo(engagement.repoFullName) },
      { onSuccess: (created) => void navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } }) },
    );
  }
  return (
    // `[&>*]:shrink-0` keeps every section at its natural height so the panel
    // scrolls (the aside owns the scroll) instead of the flex column squeezing
    // the report and findings when the plan is long.
    <div className="flex flex-col min-h-0 [&>*]:shrink-0">
      {closed && (engagement.status === "completed" || engagement.status === "failed") && (
        <ManifestCard
          cells={cells}
          findings={flattenFindings(allFindingsQ.data?.pages)}
          status={engagement.status}
          cost={cost}
          diff={diff}
          baseRef={engagement.baseRef}
          changedPaths={engagement.changedPaths}
          onRescan={canAdminister ? startRescan : undefined}
          rescanPending={rescan.isPending}
        />
      )}
      {/* While the re-scan still runs, the diff banner lives above the header
          (the manifest card only renders once terminal). fixedCount is null
          until then. */}
      {diff && !terminal && (
        <RescanDiffBanner
          diff={diff}
          terminal={false}
          baseRef={engagement.baseRef}
          changedPaths={engagement.changedPaths}
          className="mx-4 mt-3"
        />
      )}
      {rescan.isError && (
        <div className="mx-4 mt-2 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
          {apiErrorText(rescan.error)}
        </div>
      )}
      <div className="border-b border-line px-4 py-2 text-xs text-muted flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-ink">{engagement.repoFullName}</span>
          {engagement.repoRef !== "" && (
            <span className="font-mono"> @ {engagement.repoRef.slice(0, 12)}</span>
          )}
          <span> · {engagement.status}</span>
          <CostChip cost={cost} className="ml-1" />
          <span className="block text-[11px] text-muted">
            {engagement.hasRepoConfig
              ? "Configured by .valet/security.yml"
              : "Preset: Code review"}
          </span>
        </div>
        {cancellable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmCancel(true)}
          >
            Cancel review
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={(open) => {
          setConfirmCancel(open);
          if (!open) cancelMutation.reset();
        }}
        title="Cancel this security review?"
        description="This stops the engagement and fails every unsettled cell. It cannot be resumed."
        confirmLabel="Cancel review"
        pendingLabel="Cancelling…"
        pending={cancelMutation.isPending}
        error={cancelMutation.isError ? apiErrorText(cancelMutation.error) : undefined}
        onConfirm={() => {
          cancelMutation.mutate(undefined, { onSuccess: () => setConfirmCancel(false) });
        }}
      />
      {/* The finalized config + plan, at-a-glance and read-only. The user
          configured this pre-creation on `/security/new`. */}
      {/* Config context; the plan list shows only before cells materialize —
          once they do, the live cell rail below is the single plan view. */}
      <ReviewSummary engagement={engagement} planCells={planCells} showPlan={cells.length === 0} />
      {/* Blocking asks the human must answer (pivot-coordinator) — kept near the
          top so they are not missed. */}
      {needs && needs.length > 0 && (
        <NeedsSection sessionId={sessionId} needs={needs} canAdminister={canAdminister} />
      )}

      {/* The engagement steps and their live status — the single plan view. A
          long plan (triads multiply the cells) is bounded here and scrolls on
          its own, so it never squeezes the report and findings below it. */}
      {cells.length > 0 && (
        <div className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 pb-2 pt-3">
          <h3 className="text-xs font-semibold text-ink">Steps</h3>
          <span className="text-[11px] tabular-nums text-muted">
            {cells.filter((c) => c.status === "completed").length}/{cells.length}
          </span>
        </div>
      )}
      <div className="max-h-80 shrink-0 overflow-y-auto">
        <CellRail cells={cells} onOpenChild={onOpenChild} />
      </div>

      {coverageQ.data && <CoverageSection rollup={coverageQ.data.rollup} />}

      {/* The report artifact (M-P3): shown once the engagement has started — a
          report exists, is generating, or is pending the report cell. Hidden
          while planning, where no report is possible yet. */}
      {engagement.status !== "planning" && (
        <ReportSection sessionId={sessionId} report={report} generating={reportGenerating} />
      )}

      <div className="border-t border-line" />
      <FindingsReview
        sessionId={sessionId}
        engagement={engagement}
        cells={cells}
        canAdminister={canAdminister}
        initialFindingId={initialFindingId}
        polling={engagement.status === "running"}
        onOpenChild={onOpenChild}
      />
    </div>
  );
}

type MobilePane = "chat" | "panel";

/**
 * Layout for `kind='security'` sessions: chat and panel side by side from
 * `md` up; below `md`, a Chat | Panel toggle — the chat pane holds the
 * decision gates, so the panel must never cover it without a way back
 * (spec §engagement panel). The Chat tab shows a dot while a gate is
 * pending anywhere in the session, from the same stream-store slice the
 * gate cards render from.
 */
export function SecuritySessionLayout({
  sessionId,
  initialFindingId,
  chat,
  onOpenChild,
}: {
  sessionId: string;
  initialFindingId?: string;
  /** The session view element — rendered once, shown/hidden responsively. */
  chat: ReactNode;
  /** Open a persona child as the `?child=` slide-over (threaded to the rail). */
  onOpenChild?: (childId: string) => void;
}) {
  const [pane, setPane] = useState<MobilePane>("chat");
  // The right-hand panel is the sized pane; chat fills the rest. 480px = the
  // previous fixed 30rem width.
  const panel = useResizablePane({
    storageKey: "valet:sec-panel-width",
    cssVar: "--sec-panel-w",
    defaultWidth: 480,
    min: 320,
    max: 900,
    side: "right",
    ariaLabel: "Resize security panel",
  });
  const gatePending = useStreamStore(
    (s) => Object.keys(s.bySession[sessionId]?.pendingGates ?? {}).length > 0,
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="md:hidden flex border-b border-line" role="tablist" aria-label="Session panes">
        <MobileTab
          label="Chat"
          active={pane === "chat"}
          dot={gatePending}
          onSelect={() => setPane("chat")}
        />
        <MobileTab label="Panel" active={pane === "panel"} onSelect={() => setPane("panel")} />
      </div>
      <div className="flex-1 flex min-h-0" style={panel.containerStyle}>
        <div
          className={cn(
            "flex-1 min-w-0 flex-col min-h-0",
            pane === "chat" ? "flex" : "hidden md:flex",
          )}
        >
          {chat}
        </div>
        {/* Resize handle: a 4px hit area between the panes, desktop only. */}
        <div
          {...panel.handleProps}
          className="hidden md:block w-1 shrink-0 cursor-col-resize bg-line hover:bg-moss/50 focus:bg-moss focus:outline-none"
        />
        <aside
          aria-label="Security panel"
          className={cn(
            "flex-col min-h-0 overflow-y-auto border-line",
            "md:w-[var(--sec-panel-w)] md:max-w-[70vw]",
            pane === "panel" ? "flex flex-1 md:flex-none" : "hidden md:flex",
          )}
        >
          <EngagementPanel
            sessionId={sessionId}
            initialFindingId={initialFindingId}
            onOpenChild={onOpenChild}
          />
        </aside>
      </div>
    </div>
  );
}

function MobileTab({
  label,
  active,
  dot,
  onSelect,
}: {
  label: string;
  active: boolean;
  dot?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "flex-1 px-3 py-2 text-xs font-medium inline-flex items-center justify-center gap-1.5",
        active ? "text-ink border-b-2 border-moss" : "text-muted",
      )}
    >
      {label}
      {dot && (
        <span
          data-testid="pending-gate-dot"
          aria-label="A decision gate is pending"
          className="h-1.5 w-1.5 rounded-full bg-amber-500"
        />
      )}
    </button>
  );
}
