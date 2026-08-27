/**
 * Inline-SVG bar chart of cost per day bucket. No chart library dependency.
 * Heights scale to the max bucket; empty data shows a flat baseline.
 */
import type { ProxyDayBucket } from "@valet/api/wire";

interface SpendChartProps {
  buckets: ProxyDayBucket[];
}

const CHART_H = 80;
const BAR_W = 16;
const GAP = 6;
const PADDING_TOP = 8;
const LABEL_H = 16;

/** Format epoch-ms to a short day label, e.g. "Mon 18". */
function dayLabel(dayMs: number): string {
  return new Date(dayMs)
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric" })
    .replace(",", "");
}

export function SpendChart({ buckets }: SpendChartProps) {
  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-sm text-muted rounded border border-line">
        No spend data for this window.
      </div>
    );
  }

  const maxCost = Math.max(...buckets.map((b) => b.costUsd), 0.0001);
  const svgW = buckets.length * (BAR_W + GAP) - GAP;
  const svgH = CHART_H + LABEL_H;

  return (
    <div className="overflow-x-auto">
      <svg
        width={svgW}
        height={svgH}
        role="img"
        aria-label="Daily spend chart"
        className="min-w-full"
        style={{ minWidth: `${svgW}px` }}
      >
        {buckets.map((bucket, i) => {
          const label = dayLabel(bucket.dayMs);
          const barH = Math.max(2, (bucket.costUsd / maxCost) * (CHART_H - PADDING_TOP));
          const x = i * (BAR_W + GAP);
          const y = CHART_H - barH;
          return (
            <g key={bucket.dayMs}>
              <title>
                {label}: ${bucket.costUsd.toFixed(4)}
              </title>
              <rect
                x={x}
                y={y}
                width={BAR_W}
                height={barH}
                rx={2}
                className="fill-moss opacity-80"
              />
              <text
                x={x + BAR_W / 2}
                y={svgH - 2}
                textAnchor="middle"
                fontSize={9}
                className="fill-muted"
              >
                {label}
              </text>
            </g>
          );
        })}
        {/* baseline */}
        <line x1={0} y1={CHART_H} x2={svgW} y2={CHART_H} stroke="currentColor" strokeWidth={1} className="text-line" />
      </svg>
    </div>
  );
}
