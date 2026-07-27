import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// Cycled per series in the order seriesKeys is given. Matches the
// blue/emerald palette already used in activity-chart.tsx / latency-trend-chart.tsx.
const SERIES_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

interface ChannelTrendChartProps {
  title: string;
  /** Each row must have a `date` key plus one numeric (or null) key per entry in seriesKeys. */
  data: Array<{ date: string; [seriesKey: string]: string | number | null }>;
  seriesKeys: string[];
  emptyLabel: string;
  valueFormatter?: (v: number) => string;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function CustomLegend({ payload }: { payload?: Array<{ value: string; color: string }> }) {
  if (!payload?.length) return null;
  return (
    <div className="flex items-center justify-end gap-4 pt-2">
      {payload.map((entry) => (
        <div key={entry.value} className="flex items-center gap-1.5">
          <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="font-mono text-2xs text-neutral-400">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function CustomTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number | null; color: string }>;
  label?: string;
  valueFormatter: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-neutral-200/80 bg-white px-3 py-2.5 shadow-[0_4px_12px_-4px_rgb(0_0_0/0.1)] dark:border-neutral-700 dark:bg-surface-2">
      <p className="mb-1.5 font-mono text-2xs text-neutral-400">{formatDateLabel(String(label))}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{entry.name}</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {entry.value === null ? 'N/A' : valueFormatter(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ChannelTrendChart({ title, data, seriesKeys, emptyLabel, valueFormatter = (v) => String(v) }: ChannelTrendChartProps) {
  if (data.length === 0 || seriesKeys.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">{title}</h3>
        <div className="flex h-[240px] items-center justify-center text-[13px] text-neutral-300">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
      <h3 className="label-mono text-neutral-400 mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            {seriesKeys.map((key, i) => {
              const slug = key.replace(/[^a-zA-Z0-9_-]/g, '_');
              return (
                <linearGradient key={key} id={`grad-${slug}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.12} />
                  <stop offset="100%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(245 245 245)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateLabel}
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            width={45}
          />
          <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
          <Legend content={<CustomLegend />} />
          {seriesKeys.map((key, i) => {
            const slug = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            return (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={1.5}
                fill={`url(#grad-${slug})`}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 2, fill: 'white', stroke: SERIES_COLORS[i % SERIES_COLORS.length] }}
                connectNulls
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
