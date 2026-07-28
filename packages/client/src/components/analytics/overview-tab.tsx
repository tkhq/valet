import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';
import { useAnalyticsAdoption, useAnalyticsValue } from '@/api/analytics';
import { useUsageStats } from '@/api/usage';
import { ChannelTrendChart } from './channel-trend-chart';
import { UserBreakdownTable } from '@/components/usage/user-breakdown-table';
import { ModelBreakdownTable } from '@/components/usage/model-breakdown-table';

const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'Schedule (recurring)',
  webhook: 'Webhook (event-driven)',
  manual: 'Manual',
};

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

function formatCost(cost: number | null): string {
  if (cost === null) return 'N/A';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// Shared wrapper for the 14x14 stroke-icon boilerplate every hero metric uses.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function UsersIcon() {
  return (
    <Icon>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

function BoxIcon() {
  return (
    <Icon>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </Icon>
  );
}

function GitPullRequestIcon() {
  return (
    <Icon>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </Icon>
  );
}

function DollarIcon() {
  return (
    <Icon>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </Icon>
  );
}

function BoltIcon() {
  return (
    <Icon>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </Icon>
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
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

export function OverviewTab({ period }: { period: number }) {
  const { data: adoptionData, isLoading: adoptionLoading } = useAnalyticsAdoption(period);
  const { data: valueData, isLoading: valueLoading } = useAnalyticsValue(period);
  const { data: usageData, isLoading: usageLoading } = useUsageStats(period);

  if (adoptionLoading || valueLoading || usageLoading) {
    return <OverviewSkeleton />;
  }

  if (!adoptionData || !valueData || !usageData) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
        No analytics data available
      </div>
    );
  }

  const { adoption, autonomy } = adoptionData;
  const conversations = adoption.channels.reduce((sum, c) => sum + c.turns, 0);

  const activeUsersTrendData = adoption.activeUsersByDay.map((d) => ({ date: d.bucket, 'Active Users': d.users }));

  const apDayMap = new Map<string, Record<string, number | null>>();
  for (const row of adoption.actionsPerPromptByChannel) {
    const bucket: Record<string, number | null> = apDayMap.get(row.day) ?? {};
    bucket[row.channel] = row.turns > 0 ? Math.round((row.toolExecs / row.turns) * 10) / 10 : null;
    apDayMap.set(row.day, bucket);
  }
  const apChannels = Array.from(new Set(adoption.actionsPerPromptByChannel.map((r) => r.channel)));
  const actionsPerPromptTrendData = Array.from(apDayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, series]) => ({ date, ...series }));

  const totalToolExecs = adoption.actionsPerPromptByChannel.reduce((sum, r) => sum + r.toolExecs, 0);
  const totalTurns = adoption.actionsPerPromptByChannel.reduce((sum, r) => sum + r.turns, 0);
  const orgActionsPerPrompt = totalTurns > 0 ? totalToolExecs / totalTurns : null;

  const dailyActiveUsers = adoption.activeUsersByDay.at(-1)?.users ?? 0;
  const weeklyActiveUsers = adoption.activeUsersByWeek.at(-1)?.users ?? 0;

  return (
    <div className="space-y-6">
      {/* Summary hero row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HeroMetricCard
          icon={<UsersIcon />}
          label="Weekly Active Users"
          value={weeklyActiveUsers.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="distinct analytics_events users in the most recent week bucket"
              numbers={`${weeklyActiveUsers} users this week of ${adoption.activeUsers} distinct across the full window`}
              caveat="Any attributed event counts as activity, including events from automations the user owns."
            />
          }
          index={0}
        />
        <HeroMetricCard
          icon={<BoxIcon />}
          label="Sessions Started"
          value={valueData.current.resolvedSessions.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="resolvedSessions from the Value tab's current window"
              numbers={`${valueData.current.resolvedSessions} sessions ended in this window`}
              caveat="Same figure the Value tab shows — not recomputed here."
            />
          }
          index={1}
        />
        <HeroMetricCard
          icon={<GitPullRequestIcon />}
          label="PRs Merged"
          value={valueData.current.prsMerged.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="agent-authored PRs merged in this window"
              numbers={`${valueData.current.prsMerged} merged of ${valueData.current.prsMerged + valueData.current.prsClosedUnmerged} resolved`}
              caveat="Reused from the Value tab, not recomputed."
            />
          }
          index={2}
        />
        <HeroMetricCard
          icon={<DollarIcon />}
          label="Total Spend"
          value={formatCost(usageData.hero.totalCost)}
          tooltip={
            <MetricHelp
              formula="LLM + sandbox cost for this window"
              numbers={`${formatCost(usageData.hero.totalCost)} total across ${usageData.hero.totalSessions} sessions`}
              caveat="Same total the Billing tab shows — not recomputed here."
            />
          }
          index={3}
        />
      </div>

      {/* Who's using Valet */}
      <ChannelTrendChart
        title="Active Users"
        data={activeUsersTrendData}
        seriesKeys={['Active Users']}
        emptyLabel="No attributed activity in this window"
      />
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-1">
        <UserBreakdownTable data={usageData.byUser} byUserModel={usageData.byUserModel} />
      </div>

      {/* How are they using it */}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card title="Adoption Level">
          <SimpleTable
            columns={['Cadence', 'Users']}
            rows={[
              ['All members', adoption.totalUsers],
              ['Monthly active', adoption.activeUsers],
              ['Weekly active', weeklyActiveUsers],
              ['Daily active', dailyActiveUsers],
            ]}
            empty="No user data"
          />
        </Card>
        <Card title="Stickiness by Channel (DAU/MAU)">
          <SimpleTable
            columns={['Channel', 'DAU', 'MAU', 'Stickiness']}
            rows={adoption.channelStickiness.map((c) => [c.channel, c.dau, c.mau, formatPercent(c.mau > 0 ? c.dau / c.mau : null)])}
            empty="No channel activity in this window"
          />
        </Card>
        <Card title="Connectors">
          <SimpleTable
            columns={['Service', 'Users', 'Reads', 'Writes']}
            rows={adoption.connectors.map((c) => [c.service, c.users, c.reads, c.writes])}
            empty="No action invocations in this window"
          />
        </Card>
        <Card title="Enabled Automations">
          <SimpleTable
            columns={['Trigger type', 'Enabled']}
            rows={adoption.enabledTriggers.map((t) => [TRIGGER_LABELS[t.type] ?? t.type, t.count])}
            empty="No enabled triggers"
          />
        </Card>
      </div>

      {/* How agentic is their work */}
      <HeroMetricCard
        icon={<BoltIcon />}
        label="Actions Per Prompt"
        value={orgActionsPerPrompt === null ? 'N/A' : orgActionsPerPrompt.toFixed(1)}
        tooltip={
          <MetricHelp
            formula="tool_exec count ÷ turn_complete count, org-wide"
            numbers={`${totalToolExecs} tool calls across ${totalTurns} turns`}
            caveat="Higher means more tool use is happening per user turn — not a claim about time saved."
          />
        }
        index={0}
      />
      <ChannelTrendChart
        title="Actions Per Prompt by Channel"
        data={actionsPerPromptTrendData}
        seriesKeys={apChannels}
        emptyLabel="No tool activity in this window"
        valueFormatter={(v) => v.toFixed(1)}
      />

      {/* What are the results */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HeroMetricCard
          icon={<GitPullRequestIcon />}
          label="PRs Merged"
          value={valueData.current.prsMerged.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="agent-authored PRs merged in this window"
              numbers={`${valueData.current.prsMerged} merged of ${valueData.current.prsMerged + valueData.current.prsClosedUnmerged} resolved`}
              caveat="Reused from the Value tab, not recomputed."
            />
          }
          index={0}
        />
        <HeroMetricCard
          icon={<BoxIcon />}
          label="Sessions"
          value={valueData.current.resolvedSessions.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="resolvedSessions from the Value tab's current window"
              numbers={`${valueData.current.resolvedSessions} sessions ended in this window`}
              caveat="Same figure the Value tab shows — not recomputed here."
            />
          }
          index={1}
        />
        <HeroMetricCard
          icon={<BoxIcon />}
          label="File Operations"
          value={adoption.filesChanged.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="COUNT(*) over session_files_changed, org-wide for this window"
              numbers={`${adoption.filesChanged} distinct (session, file) changes; ${adoption.linesChanged.toLocaleString()} total lines added+deleted`}
              caveat="Real diff totals, not an estimate."
            />
          }
          index={2}
        />
        <HeroMetricCard
          icon={<UsersIcon />}
          label="Conversations"
          value={conversations.toLocaleString()}
          tooltip={
            <MetricHelp
              formula="SUM(turns) across all channels"
              numbers={`${conversations} turns across ${adoption.channels.length} channel(s)`}
              caveat="A turn is one full user↔agent exchange (turn_complete event)."
            />
          }
          index={3}
        />
      </div>

      {/* What it costs */}
      <Card title="Spend by Model">
        <ModelBreakdownTable data={usageData.byModel} />
      </Card>

      {/* Outcomes tables — kept from the old Adoption tab, human-intervention data
          lives here now instead of as a hero card. */}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card title="Outcomes by Workflow">
          <SimpleTable
            columns={['Workflow', 'Completed', 'Failed', 'Cancelled']}
            rows={autonomy.outcomesByWorkflow.map((w) => [w.name, w.completed, w.failed, w.cancelled])}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Outcomes by Trigger Type">
          <SimpleTable
            columns={['Trigger type', 'Completed', 'Failed', 'Cancelled']}
            rows={autonomy.outcomesByTriggerType.map((t) => [TRIGGER_LABELS[t.triggerType] ?? t.triggerType, t.completed, t.failed, t.cancelled])}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Human Intervention">
          <SimpleTable
            columns={['Metric', 'Value']}
            rows={[
              ['Attended runs', autonomy.attendedRuns],
              ['Intervention rate', formatPercent(autonomy.interventionRate)],
              ['Median minutes blocked', formatMinutes(autonomy.medianBlockedMinutes)],
            ]}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Failure Reasons">
          <SimpleTable
            columns={['Reason', 'Failed runs']}
            rows={autonomy.failureReasons.map((f) => [f.reason, f.runs])}
            empty="No failed production runs in this window"
          />
        </Card>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="h-[280px] rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
    </div>
  );
}
