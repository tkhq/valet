import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { PeriodSelector } from '@/components/dashboard/period-selector';
import { useAuthStore } from '@/stores/auth';
import { downloadUsageCsv, useUsageStats, type UsageSelection } from '@/api/usage';
import { defaultUsageSelection, UsageReportControls } from '@/components/usage/report-controls';
import { UsageHeroMetrics } from '@/components/usage/hero-metrics';
import { CostChart } from '@/components/usage/cost-chart';
import { ModelBreakdownTable } from '@/components/usage/model-breakdown-table';
import { OriginBreakdownTable } from '@/components/usage/origin-breakdown-table';
import { UserBreakdownTable } from '@/components/usage/user-breakdown-table';
import { PerformanceTab } from '@/components/analytics/performance-tab';
import { EventsTab } from '@/components/analytics/events-tab';
import { ValueTab } from '@/components/analytics/value-tab';
import { OverviewTab } from '@/components/analytics/overview-tab';

export const Route = createFileRoute('/settings/usage')({
  component: UsagePage,
});

function UsagePage() {
  const user = useAuthStore((s) => s.user);
  const [period, setPeriod] = React.useState(720); // non-billing analytics keep rolling windows
  const [usageSelection, setUsageSelection] = React.useState<UsageSelection>(defaultUsageSelection);
  const [tab, setTab] = React.useState<'billing' | 'value' | 'overview' | 'performance' | 'events'>('billing');

  if (!user) return null;
  const isAdmin = user.role === 'admin';
  const reportSelection = isAdmin ? usageSelection : { ...usageSelection, scope: 'personal' as const };

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <PageHeader
            title="Analytics"
            description={isAdmin ? 'Usage, performance, and event analytics across your organization' : 'Your model and sandbox usage'}
          />
          {isAdmin && tab !== 'billing' && <PeriodSelector value={period} onChange={setPeriod} includeYear />}
        </div>

        {isAdmin && <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
          {(['billing', 'value', 'overview', 'performance', 'events'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? 'border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>}

        {tab === 'billing' && <BillingContent selection={reportSelection} onSelectionChange={setUsageSelection} isAdmin={isAdmin} />}
        {tab === 'value' && <ValueTab period={period} />}
        {tab === 'overview' && <OverviewTab period={period} />}
        {tab === 'performance' && <PerformanceTab period={period} />}
        {tab === 'events' && <EventsTab period={period} />}
      </div>
    </PageContainer>
  );
}

function BillingContent({ selection, onSelectionChange, isAdmin }: { selection: UsageSelection; onSelectionChange: (value: UsageSelection) => void; isAdmin: boolean }) {
  const { data, isLoading, error } = useUsageStats(selection);
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadUsageCsv(selection, data?.report.end);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'Usage export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <UsageReportControls value={selection} onChange={onSelectionChange} onExport={exportCsv} exporting={exporting || !data} scopes={isAdmin ? undefined : ['personal']} />
      {(error || exportError) && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {exportError ?? (error instanceof Error ? error.message : 'Invalid report selection')}
        </div>
      )}
      {isLoading && <UsageSkeleton />}
      {!isLoading && !data && !error && (
        <div className="flex h-64 items-center justify-center text-sm text-neutral-400">No usage data available</div>
      )}
      {data && <>
        <p className="text-xs text-neutral-400">{data.report.label} · {data.report.start} to {data.report.end}</p>
      <UsageHeroMetrics
        totalCost={data.hero.totalCost}
        totalInputTokens={data.hero.totalInputTokens}
        totalOutputTokens={data.hero.totalOutputTokens}
        totalSessions={data.hero.totalSessions}
        totalUsers={data.hero.totalUsers}
        sandboxCost={data.hero.sandboxCost}
        sandboxActiveSeconds={data.hero.sandboxActiveSeconds}
      />
      <CostChart data={data.costByDay} />
      <OriginBreakdownTable data={data.byPurpose} byWorkflow={data.byWorkflow} />
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <ModelBreakdownTable data={data.byModel} />
        <UserBreakdownTable data={data.byUser} byUserModel={data.byUserModel} />
      </div>
      </>}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="h-[320px] rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        <div className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      </div>
    </div>
  );
}
