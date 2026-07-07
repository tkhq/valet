import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';
import { useAnalyticsValue } from '@/api/analytics';
import { formatCost, formatTokenCount } from '@/lib/format';
import type { ValueMetricsWindow } from '@valet/shared';

function formatPercent(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${Math.round(rate * 1000) / 10}%`;
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

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

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
      <ValueHeroMetrics current={data.current} previous={data.previous} />
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <SideEffectsTable rows={data.current.sideEffects} />
        <SessionSourcesTable rows={data.current.sessionSources} />
      </div>
    </div>
  );
}

// Tooltip body for a metric card: the derivation formula, this window's
// actual numbers plugged into it, and the proxy caveat.
function MetricHelp({ formula, numbers, caveat }: { formula: string; numbers: string; caveat: string }) {
  return (
    <div className="space-y-1.5 py-1">
      <p className="font-mono text-[11px] leading-snug">{formula}</p>
      <p>{numbers}</p>
      <p className="opacity-60">{caveat}</p>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  pr: 'From a pull request',
  issue: 'From an issue',
  branch: 'From a branch',
  manual: 'Manual repo work',
  none: 'No git context',
};

function SideEffectsTable({ rows }: { rows: ValueMetricsWindow['sideEffects'] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">Side Effects by Service</h3>
        <p className="text-sm text-neutral-300">No external actions executed in this window</p>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '300ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">Side Effects by Service</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 dark:border-neutral-800">
              <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">Service</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Executed</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">High-risk</th>
              <th className="pb-2 pl-4 text-right font-mono text-2xs font-medium text-neutral-400">Gated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.service} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                <td className="py-2.5 pr-4 font-medium text-neutral-900 dark:text-neutral-100">{r.service}</td>
                <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{r.executed.toLocaleString()}</td>
                <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{r.highRisk.toLocaleString()}</td>
                <td className="py-2.5 pl-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                  {r.highRisk > 0 ? formatPercent(r.highRiskGated / r.highRisk) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SessionSourcesTable({ rows }: { rows: ValueMetricsWindow['sessionSources'] }) {
  const total = rows.reduce((sum, r) => sum + r.sessions, 0);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">Session Sources</h3>
        <p className="text-sm text-neutral-300">No sessions ended in this window</p>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '350ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">Session Sources</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 dark:border-neutral-800">
              <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">Started from</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Sessions</th>
              <th className="pb-2 pl-4 text-right font-mono text-2xs font-medium text-neutral-400">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sourceType} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                <td className="py-2.5 pr-4 font-medium text-neutral-900 dark:text-neutral-100">{SOURCE_LABELS[r.sourceType] ?? r.sourceType}</td>
                <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{r.sessions.toLocaleString()}</td>
                <td className="py-2.5 pl-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                  {total > 0 ? formatPercent(r.sessions / total) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ValueHeroMetrics({ current, previous }: { current: ValueMetricsWindow; previous: ValueMetricsWindow }) {
  const highRiskGated = current.sideEffects.reduce((sum, r) => sum + r.highRiskGated, 0);
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <HeroMetricCard
        icon={<DollarTaskIcon />}
        label="Cost / Resolved Task"
        value={formatCost(current.costPerResolvedTask)}
        delta={pctDelta(current.costPerResolvedTask, previous.costPerResolvedTask)}
        deltaPolarity="lower-is-better"
        tooltip={
          <MetricHelp
            formula="(LLM tokens × models.dev price + sandbox seconds × Modal rate) ÷ (completed workflow runs + sessions ended without error)"
            numbers={`${formatCost(current.totalCost)} ÷ ${current.resolvedTasks} resolved (${current.resolvedWorkflowRuns} workflow runs + ${current.resolvedSessions} sessions)`}
            caveat={`"Resolved" is a proxy — workflow reached completed, or session settled (hibernated/archived/terminated) error-free; no explicit task-completion signal exists yet. Sandbox spend prorated across overlapping windows.`}
          />
        }
        index={0}
      />
      <HeroMetricCard
        icon={<CheckIcon />}
        label="Accepted Output Rate"
        value={formatPercent(current.acceptedOutputRate)}
        delta={pctDelta(current.acceptedOutputRate, previous.acceptedOutputRate)}
        tooltip={
          <MetricHelp
            formula="human-approved prompts ÷ (human-approved + human-denied)"
            numbers={`${current.approvalsAccepted} accepted ÷ ${current.approvalsAccepted + current.approvalsDenied} decided (${current.approvalsExpired} expired, excluded)`}
            caveat="Counts only action approvals + workflow gates a human explicitly decided; policy auto-allows/denies are excluded. No per-message feedback exists yet, so most assistant output carries no accept/reject signal."
          />
        }
        index={1}
      />
      <HeroMetricCard
        icon={<ReworkIcon />}
        label="Rework & Escalation"
        value={formatPercent(current.reworkEscalationRate)}
        delta={pctDelta(current.reworkEscalationRate, previous.reworkEscalationRate)}
        deltaPolarity="lower-is-better"
        tooltip={
          <MetricHelp
            formula="sessions errored or escalated ÷ sessions ended"
            numbers={`${current.reworkSessions} ÷ ${current.endedSessions} sessions (${current.escalationMessages} escalation messages); workflows: ${current.failedWorkflowRuns}/${current.terminalWorkflowRuns} failed`}
            caveat={`Escalation = explicit escalate-to-human message. Same-intent re-prompting and informal "get a human" requests are not detected yet.`}
          />
        }
        index={2}
      />
      <HeroMetricCard
        icon={<ClockIcon />}
        label="Median Time to Done"
        value={formatMinutes(current.medianSessionMinutes)}
        delta={pctDelta(current.medianSessionMinutes, previous.medianSessionMinutes)}
        deltaPolarity="lower-is-better"
        tooltip={
          <MetricHelp
            formula="median(last activity − created) over sessions ended without error"
            numbers={`${formatMinutes(current.medianSessionMinutes)} across ${current.resolvedSessions} sessions; workflow runs: ${formatMinutes(current.medianWorkflowMinutes)} median`}
            caveat="Wall-clock span including waiting-on-user time. Absolute time-to-done, NOT cycle-time reduction — no pre-Valet baseline exists."
          />
        }
        index={3}
      />
      <HeroMetricCard
        icon={<MergeIcon />}
        label="Agent PR Merge Rate"
        value={formatPercent(current.prMergeRate)}
        delta={pctDelta(current.prMergeRate, previous.prMergeRate)}
        tooltip={
          <MetricHelp
            formula="merged ÷ (merged + closed unmerged) agent-authored PRs"
            numbers={`${current.prsMerged} ÷ ${current.prsMerged + current.prsClosedUnmerged} decided; ${current.prsStillOpen} still open of ${current.prsOpened} opened; median ${current.medianHoursToMerge === null ? 'N/A' : `${Math.round(current.medianHoursToMerge)}h`} to merge`}
            caveat="Proxy for review burden. PR linkage collects forward from ship date (no backfill); true review burden (review rounds, requested changes) needs PR-review-event ingestion."
          />
        }
        index={4}
      />
      <HeroMetricCard
        icon={<RouteIcon />}
        label="Non-Frontier Token Share"
        value={formatPercent(current.nonFrontierTokenShare)}
        delta={pctDelta(current.nonFrontierTokenShare, previous.nonFrontierTokenShare)}
        tooltip={
          <MetricHelp
            formula="(efficient + standard tokens) ÷ (efficient + standard + frontier tokens)"
            numbers={`${formatPercent(current.frontierFreeSessionShare)} of ${current.sessionsWithModelUsage} sessions never touched a frontier model; ${formatTokenCount(current.unknownTokens)} unclassified tokens excluded`}
            caveat="Tiers by model name: haiku/mini/flash → efficient; sonnet/gpt-4 → standard; opus/fable/gpt-5 → frontier. Billable = input + cache + output + reasoning."
          />
        }
        index={5}
      />
      <HeroMetricCard
        icon={<BoltIcon />}
        label="External Actions"
        value={current.totalSideEffects.toLocaleString()}
        delta={pctDelta(current.totalSideEffects, previous.totalSideEffects)}
        tooltip={
          <MetricHelp
            formula="count(executed action invocations)"
            numbers={`${current.totalSideEffects} executed, ${current.highRiskSideEffects} high-risk; per-service breakdown below`}
            caveat="Side effects = actions with impact outside Valet (emails, messages, PRs, issues). Test-mode workflow runs excluded."
          />
        }
        index={6}
      />
      <HeroMetricCard
        icon={<ShieldIcon />}
        label="High-Risk Gate Coverage"
        value={formatPercent(current.highRiskGateCoverage)}
        delta={pctDelta(current.highRiskGateCoverage, previous.highRiskGateCoverage)}
        tooltip={
          <MetricHelp
            formula="human-decided high-risk executions ÷ all high-risk executions"
            numbers={`${highRiskGated} gated ÷ ${current.highRiskSideEffects} high-risk executed`}
            caveat={`The remainder ran under policy auto-allow ("Always Allow" grants or low-friction policies on high-risk actions).`}
          />
        }
        index={7}
      />
    </div>
  );
}

function ValueSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="h-12 rounded bg-neutral-100 dark:bg-surface-1" />
    </div>
  );
}
