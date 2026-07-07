import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';
import { useAnalyticsValue } from '@/api/analytics';
import type { ValueMetricsWindow } from '@valet/shared';

// The "Value metrics" panel: outcome metrics alongside the activity view.
// v1 renders the metrics computable from existing signals; every headline is
// a labeled proxy (see each card's tooltip). Metrics that need new
// instrumentation are shown as planned placeholders so the roadmap is
// visible instead of silently missing.

function formatCost(cost: number | null): string {
  if (cost === null) return 'N/A';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatPercent(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${Math.round(rate * 1000) / 10}%`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return 'N/A';
  if (minutes < 1) return '<1m';
  if (minutes < 90) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / (24 * 60)).toFixed(1)}d`;
}

/** Relative % change vs the prior window, for the delta badge. */
function pctDelta(current: number | null, previous: number | null): number | undefined {
  if (current === null || previous === null || previous === 0) return undefined;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

function DollarTaskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v12" />
      <path d="M15.5 9a3 3 0 0 0-3-2h-1a2.5 2.5 0 0 0 0 5h1a2.5 2.5 0 0 1 0 5h-1a3 3 0 0 1-3-2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  );
}

function ReworkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <circle cx="18" cy="5" r="3" />
    </svg>
  );
}

interface PlannedMetric {
  label: string;
  why: string;
  blocker: string;
}

const PLANNED_METRICS: PlannedMetric[] = [
  {
    label: 'True Accepted-Output Rate',
    why: 'Measures usable output per assistant message, not activity.',
    blocker: 'Needs per-message feedback (thumbs up/down) — not instrumented anywhere in Valet yet.',
  },
  {
    label: 'Cycle-Time Reduction',
    why: 'Tests whether Valet accelerated completion vs doing the work without it.',
    blocker: 'Needs a pre-Valet baseline per class of work; v1 shows absolute time-to-done only.',
  },
  {
    label: 'Defect Rate & Maintainability',
    why: 'Separates generation speed from long-term code quality.',
    blocker: 'Needs PR follow-up ingestion (reverts and hotfixes touching agent-authored code within 14/30d).',
  },
  {
    label: 'Customer Satisfaction & Repeat Contact',
    why: 'Prevents hollow support metrics that hide frustration and churn.',
    blocker: 'Valet is internal today; formal CSAT capture is a follow-up design conversation.',
  },
  {
    label: 'Revenue per AI-Assisted Employee',
    why: 'Measures commercial leverage and worker amplification.',
    blocker: 'Needs org-level revenue attribution; explicitly out of scope for the first pass.',
  },
];

export function ValueTab({ period }: { period: number }) {
  const { data, isLoading } = useAnalyticsValue(period);

  if (isLoading) {
    return <ValueSkeleton />;
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
        No value metrics available
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        First-pass outcome metrics. Every headline is a best-available proxy — hover a card for
        what it measures, why it matters, and which proxy it uses. Deltas compare against the
        prior window of equal length.
      </p>
      <ValueHeroMetrics current={data.current} previous={data.previous} />
      <PlannedMetrics />
    </div>
  );
}

function ValueHeroMetrics({ current, previous }: { current: ValueMetricsWindow; previous: ValueMetricsWindow }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <HeroMetricCard
        icon={<DollarTaskIcon />}
        label="Cost / Resolved Task"
        value={formatCost(current.costPerResolvedTask)}
        delta={pctDelta(current.costPerResolvedTask, previous.costPerResolvedTask)}
        deltaPolarity="lower-is-better"
        tooltip={`Connects spend to completed work rather than autonomous loops. Total LLM + sandbox cost (${formatCost(current.totalCost)}) ÷ resolved tasks (${current.resolvedTasks}: ${current.resolvedWorkflowRuns} completed workflow runs + ${current.resolvedSessions} sessions whose activity ended without error). Proxy: "resolved" = workflow completed, or session settled (hibernated/archived/terminated) error-free — no explicit task-completion signal exists yet. Sandbox spend is prorated across the windows a session's life overlaps.`}
        index={0}
      />
      <HeroMetricCard
        icon={<CheckIcon />}
        label="Accepted Output Rate"
        value={formatPercent(current.acceptedOutputRate)}
        delta={pctDelta(current.acceptedOutputRate, previous.acceptedOutputRate)}
        tooltip={`Measures usable output, not activity. Share of approval prompts a human explicitly decided that were accepted: ${current.approvalsAccepted} accepted vs ${current.approvalsDenied} denied (${current.approvalsExpired} expired, excluded; policy auto-allows/auto-denies excluded — no human decision). Proxy: counts action approvals + workflow gates only — Valet has no per-message feedback yet, so most assistant output carries no accept/reject signal.`}
        index={1}
      />
      <HeroMetricCard
        icon={<ReworkIcon />}
        label="Rework & Escalation"
        value={formatPercent(current.reworkEscalationRate)}
        delta={pctDelta(current.reworkEscalationRate, previous.reworkEscalationRate)}
        deltaPolarity="lower-is-better"
        tooltip={`Shows whether automation reduces labor or creates oversight work. ${current.reworkSessions} of ${current.endedSessions} ended sessions errored or sent an explicit escalation message (${current.escalationMessages} escalation messages in window). Workflows: ${current.failedWorkflowRuns} of ${current.terminalWorkflowRuns} runs failed. Proxy: same-intent re-prompting and informal "get a human" requests are not detected yet.`}
        index={2}
      />
      <HeroMetricCard
        icon={<ClockIcon />}
        label="Median Time to Done"
        value={formatMinutes(current.medianSessionMinutes)}
        delta={pctDelta(current.medianSessionMinutes, previous.medianSessionMinutes)}
        deltaPolarity="lower-is-better"
        tooltip={`Tests whether the tool accelerates completion. Median active lifespan (creation to last activity) of sessions that ended without error; completed workflow runs: ${formatMinutes(current.medianWorkflowMinutes)} median. Proxy: absolute time-to-done, NOT cycle-time reduction — no pre-Valet baseline exists to compare against.`}
        index={3}
      />
      <HeroMetricCard
        icon={<MergeIcon />}
        label="Agent PR Merge Rate"
        value={formatPercent(current.prMergeRate)}
        delta={pctDelta(current.prMergeRate, previous.prMergeRate)}
        tooltip={`Proxy for review burden: of agent-authored PRs that reached a decision, how many merged. ${current.prsMerged} merged vs ${current.prsClosedUnmerged} closed unmerged (${current.prsStillOpen} still open of ${current.prsOpened} opened; median ${current.medianHoursToMerge === null ? 'N/A' : `${Math.round(current.medianHoursToMerge)}h`} to merge). PR linkage collects forward from this panel's ship date — older PRs are not backfilled. True review burden (review rounds, requested changes) needs PR-review-event ingestion, which does not exist yet.`}
        index={4}
      />
      <HeroMetricCard
        icon={<RouteIcon />}
        label="Non-Frontier Token Share"
        value={formatPercent(current.nonFrontierTokenShare)}
        delta={pctDelta(current.nonFrontierTokenShare, previous.nonFrontierTokenShare)}
        tooltip={`Shows whether routine work is handled by cheaper models before expensive systems are used. Share of billable tokens on efficient/standard-tier models vs frontier; ${formatPercent(current.frontierFreeSessionShare)} of ${current.sessionsWithModelUsage} sessions never touched a frontier model. Tiers are classified by model name (haiku/mini/flash → efficient; sonnet/gpt-4 → standard; opus/fable/gpt-5 → frontier); unclassified models are excluded from the share (${formatTokenCount(current.unknownTokens)} tokens unclassified this window).`}
        index={5}
      />
    </div>
  );
}

function PlannedMetrics() {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
        Planned — needs instrumentation
      </h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLANNED_METRICS.map((m) => (
          <div
            key={m.label}
            className="rounded-lg border border-dashed border-neutral-200/80 bg-neutral-50/50 p-5 dark:border-neutral-800 dark:bg-surface-1/50"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="label-mono text-neutral-400">{m.label}</span>
              <span className="rounded-full bg-neutral-200/60 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                Planned
              </span>
            </div>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{m.why}</p>
            <p className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">{m.blocker}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ValueSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 rounded bg-neutral-100 dark:bg-surface-1" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-dashed border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
    </div>
  );
}
