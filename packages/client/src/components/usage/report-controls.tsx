import { cn } from '@/lib/cn';
import type { UsagePeriod, UsageScope, UsageSelection } from '@/api/usage';

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultUsageSelection(): UsageSelection {
  return { scope: 'org', periodType: 'lookback', period: 720 };
}

function defaultMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function defaultRange(): Extract<UsagePeriod, { periodType: 'range' }> {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { periodType: 'range', start: utcDate(start), end: utcDate(end) };
}

interface UsageReportControlsProps {
  value: UsageSelection;
  onChange: (value: UsageSelection) => void;
  onExport: () => void;
  exporting?: boolean;
  scopes?: UsageScope[];
}

export function UsageReportControls({ value, onChange, onExport, exporting, scopes = ['personal', 'org'] }: UsageReportControlsProps) {
  const buttonClass = (active: boolean) => cn(
    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
    active ? 'bg-white text-neutral-900 shadow-sm dark:bg-surface-3 dark:text-neutral-100' : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200',
  );
  const setPeriod = (period: UsagePeriod) => onChange({ ...period, scope: value.scope });

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Usage report controls">
      <div className="inline-flex rounded-lg border border-neutral-200/80 bg-surface-1 p-0.5 dark:border-neutral-800" aria-label="Report scope">
        {scopes.map((scope) => (
          <button key={scope} className={buttonClass(value.scope === scope)} onClick={() => onChange({ ...value, scope })}>
            {scope === 'org' ? 'Organization' : scope[0].toUpperCase() + scope.slice(1)}
          </button>
        ))}
      </div>
      <div className="inline-flex rounded-lg border border-neutral-200/80 bg-surface-1 p-0.5 dark:border-neutral-800" aria-label="Report period">
        {([24, 168, 720] as const).map((period) => (
          <button key={period} className={buttonClass(value.periodType === 'lookback' && value.period === period)} onClick={() => setPeriod({ periodType: 'lookback', period })}>
            {period === 24 ? '1d' : period === 168 ? '7d' : '30d'}
          </button>
        ))}
        <button className={buttonClass(value.periodType === 'month')} onClick={() => setPeriod({ periodType: 'month', month: defaultMonth() })}>Month</button>
        <button className={buttonClass(value.periodType === 'range')} onClick={() => setPeriod(defaultRange())}>Custom</button>
      </div>
      {value.periodType === 'month' && (
        <input aria-label="Calendar month" type="month" value={value.month} max={defaultMonth()} onChange={(event) => setPeriod({ periodType: 'month', month: event.target.value })} className="rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs dark:border-neutral-700" />
      )}
      {value.periodType === 'range' && (
        <div className="flex items-center gap-1 text-xs text-neutral-500">
          <input aria-label="Start date inclusive" type="date" value={value.start} onChange={(event) => setPeriod({ ...value, start: event.target.value })} className="rounded-md border border-neutral-200 bg-transparent px-2 py-1 dark:border-neutral-700" />
          <span>to</span>
          <input aria-label="End date exclusive" type="date" value={value.end} onChange={(event) => setPeriod({ ...value, end: event.target.value })} className="rounded-md border border-neutral-200 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </div>
      )}
      <button onClick={onExport} disabled={exporting} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-surface-2">
        {exporting ? 'Exporting…' : 'Export CSV'}
      </button>
      <span className="basis-full text-[11px] text-neutral-400">UTC · start inclusive, end exclusive</span>
    </div>
  );
}
