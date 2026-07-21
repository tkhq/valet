import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';
import { useAnalyticsAdoption } from '@/api/analytics';
import type { AnalyticsAdoptionResponse } from '@valet/shared';

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

function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
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

function RobotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 4v4" />
      <circle cx="12" cy="3" r="1" />
      <path d="M9 13h.01M15 13h.01" />
      <path d="M9 17h6" />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
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

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

// Tooltip body: derivation, this window's numbers, and the honest caveat.
function MetricHelp({ formula, numbers, caveat }: { formula: string; numbers: string; caveat: string }) {
  return (
    <div className="space-y-1.5 py-1">
      <p className="font-mono text-[11px] leading-snug">{formula}</p>
      <p>{numbers}</p>
      <p className="opacity-60">{caveat}</p>
    </div>
  );
}

function Card({ title, children, delay = 0 }: { title: string; children: React.ReactNode; delay?: number }) {
  return (
    <div
      className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none"
      style={{ animationDelay: `${delay}ms` }}
    >
      <h3 className="label-mono text-neutral-400 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function SimpleTable({
  columns,
  rows,
  empty,
}: {
  columns: [string, string, ...string[]];
  rows: Array<Array<string | number>>;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-300">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-100 dark:border-neutral-800">
            {columns.map((c, i) => (
              <th
                key={c}
                className={`pb-2 font-mono text-2xs font-medium text-neutral-400 ${i === 0 ? 'pr-4 text-left' : 'px-4 text-right last:pl-4 last:pr-0'}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className={
                    ci === 0
                      ? 'py-2.5 pr-4 font-medium text-neutral-900 dark:text-neutral-100'
                      : 'py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 last:pl-4 last:pr-0 dark:text-neutral-300'
                  }
                >
                  {typeof cell === 'number' ? cell.toLocaleString() : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'Schedule (recurring)',
  webhook: 'Webhook (event-driven)',
  manual: 'Manual',
};

export function AdoptionTab({ period }: { period: number }) {
  const { data, isLoading } = useAnalyticsAdoption(period);

  if (isLoading) {
    return <AdoptionSkeleton />;
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
        No adoption metrics available
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AdoptionHeroMetrics data={data} />
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card title="Enabled Automations" delay={350}>
          <SimpleTable
            columns={['Trigger type', 'Enabled']}
            rows={data.adoption.enabledTriggers.map((t) => [TRIGGER_LABELS[t.type] ?? t.type, t.count])}
            empty="No enabled triggers"
          />
          <p className="mt-3 text-xs text-neutral-400">
            Live schedule/webhook triggers are the strongest adoption signal: they run without anyone opening Valet.
          </p>
        </Card>
        <Card title="Workflow Runs / Day" delay={400}>
          <SimpleTable
            columns={['Day', 'Runs started']}
            rows={data.adoption.workflowRunsByDay.map((d) => [d.day, d.runs])}
            empty="No production workflow runs in this window"
          />
        </Card>
        <Card title="Active Users by Week" delay={450}>
          <SimpleTable
            columns={['Week', 'Active users']}
            rows={data.adoption.activeUsersByWeek.map((w) => [w.bucket, w.users])}
            empty="No attributed activity in this window"
          />
        </Card>
        <Card title="Active Users by Day" delay={500}>
          <SimpleTable
            columns={['Day', 'Active users']}
            rows={data.adoption.activeUsersByDay.map((d) => [d.bucket, d.users])}
            empty="No attributed activity in this window"
          />
        </Card>
        <Card title="Channels Exercised" delay={550}>
          <SimpleTable
            columns={['Channel', 'Turns']}
            rows={data.adoption.channels.map((c) => [c.channel, c.turns])}
            empty="No channel-attributed turns in this window"
          />
        </Card>
        <Card title="Integration Services Exercised" delay={600}>
          <SimpleTable
            columns={['Service', 'Invocations']}
            rows={data.adoption.services.map((s) => [s.service, s.invocations])}
            empty="No action invocations in this window"
          />
        </Card>
        <Card title="Outcomes by Workflow" delay={650}>
          <SimpleTable
            columns={['Workflow', 'Completed', 'Failed', 'Cancelled']}
            rows={data.autonomy.outcomesByWorkflow.map((w) => [w.name, w.completed, w.failed, w.cancelled])}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Outcomes by Trigger Type" delay={700}>
          <SimpleTable
            columns={['Trigger type', 'Completed', 'Failed', 'Cancelled']}
            rows={data.autonomy.outcomesByTriggerType.map((t) => [TRIGGER_LABELS[t.triggerType] ?? t.triggerType, t.completed, t.failed, t.cancelled])}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Failure Reasons" delay={750}>
          <SimpleTable
            columns={['Reason', 'Failed runs']}
            rows={data.autonomy.failureReasons.map((f) => [f.reason, f.runs])}
            empty="No failed production runs in this window"
          />
          <p className="mt-3 text-xs text-neutral-400">
            Coarse keyword buckets over each run's stored error text.
          </p>
        </Card>
      </div>
    </div>
  );
}

function AdoptionHeroMetrics({ data }: { data: AnalyticsAdoptionResponse }) {
  const { adoption, autonomy } = data;
  const recurringTriggers = adoption.enabledTriggers
    .filter((t) => t.type === 'schedule' || t.type === 'webhook')
    .reduce((sum, t) => sum + t.count, 0);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <HeroMetricCard
        icon={<UsersIcon />}
        label="Active Users"
        value={adoption.activeUsers.toLocaleString()}
        tooltip={
          <MetricHelp
            formula="COUNT(DISTINCT user_id) over analytics_events in the window"
            numbers={`${adoption.activeUsers} users across ${adoption.activeUsersByWeek.length} week bucket(s)`}
            caveat="Any attributed event counts as activity, including events from automations the user owns."
          />
        }
        index={0}
      />
      <HeroMetricCard
        icon={<RepeatIcon />}
        label="Returning Users"
        value={`${adoption.returningUsers.toLocaleString()} (${formatPercent(adoption.returningUserRate)})`}
        tooltip={
          <MetricHelp
            formula="users active in MORE than one distinct week ÷ active users"
            numbers={`${adoption.returningUsers} of ${adoption.activeUsers} active users`}
            caveat="A retention proxy within the selected window; short windows (under two weeks) cannot show returners."
          />
        }
        index={1}
      />
      <HeroMetricCard
        icon={<BoltIcon />}
        label="Recurring Automations Live"
        value={recurringTriggers.toLocaleString()}
        tooltip={
          <MetricHelp
            formula="enabled triggers with type schedule or webhook (present state)"
            numbers={adoption.enabledTriggers.map((t) => `${t.count} ${t.type}`).join(', ') || 'none enabled'}
            caveat="Present-state count, not windowed: these run without anyone opening Valet — the strongest embeddedness signal."
          />
        }
        index={2}
      />
      <HeroMetricCard
        icon={<RobotIcon />}
        label="Unattended Completion Rate"
        value={formatPercent(autonomy.unattendedCompletionRate)}
        tooltip={
          <MetricHelp
            formula="runs completed with ZERO human decisions ÷ terminal production runs"
            numbers={`${autonomy.unattendedCompletedRuns} of ${autonomy.terminalRuns} terminal runs completed start-to-finish without a person`}
            caveat="A human decision is an invocation with resolved_by set — policy auto-allows don't count as human. Closest honest proxy to labor handled; NOT a labor-savings figure."
          />
        }
        index={3}
      />
      <HeroMetricCard
        icon={<HandIcon />}
        label="Human Intervention Rate"
        value={formatPercent(autonomy.interventionRate)}
        deltaPolarity="lower-is-better"
        tooltip={
          <MetricHelp
            formula="runs with ≥1 human-resolved invocation ÷ terminal production runs"
            numbers={`${autonomy.attendedRuns} of ${autonomy.terminalRuns} runs needed a person; median ${formatMinutes(autonomy.medianBlockedMinutes)} blocked on the human decision`}
            caveat="Blocked time is invocation created → resolved on human-resolved rows only. Expired approvals carry no resolver and are not counted as decisions."
          />
        }
        index={4}
      />
      <HeroMetricCard
        icon={<CheckIcon />}
        label="Workflow Success Rate"
        value={formatPercent(autonomy.successRate)}
        tooltip={
          <MetricHelp
            formula="completed ÷ (completed + failed + cancelled) production runs"
            numbers={`${autonomy.completedRuns} completed, ${autonomy.failedRuns} failed, ${autonomy.cancelledRuns} cancelled`}
            caveat="Windowed by when the run reached a terminal state; test-mode runs excluded everywhere."
          />
        }
        index={5}
      />
      <HeroMetricCard
        icon={<ClockIcon />}
        label="Run Duration (Absolute)"
        value={formatMinutes(autonomy.medianRunMinutes)}
        tooltip={
          <MetricHelp
            formula="median(terminal time − started_at) over terminal production runs; p95 alongside"
            numbers={`median ${formatMinutes(autonomy.medianRunMinutes)}, p95 ${formatMinutes(autonomy.p95RunMinutes)} across ${autonomy.measuredRuns} measured runs`}
            caveat="ABSOLUTE wall-clock duration, including any time blocked on approvals. No pre-Valet baseline exists, so no time-saved or reduction figure is derivable from this data."
          />
        }
        index={6}
      />
    </div>
  );
}

function AdoptionSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
    </div>
  );
}
