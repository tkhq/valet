/**
 * Inline-SVG bar chart of cost per day bucket. No chart library dependency.
 * Heights scale to the max bucket; empty data shows a flat baseline.
 */
/** Minimal bucket shape — both `ProxyDayBucket` and `UsageBreakdownResponse.byDay`
 * items satisfy this interface because both carry `dayMs` and `costUsd`. */
interface DayBucket {
  dayMs: number;
  costUsd: number;
}

interface SpendChartProps {
  buckets: DayBucket[];
}

const CHART_H = 80;
const BAR_W = 16;
const GAP = 6;
const PADDING_TOP = 8;
const LABEL_H = 16;
/** A "Mon 18" label at fontSize 9 is ~34px wide. Show at most one label per
 * this much horizontal space so adjacent labels never collide. */
const MIN_LABEL_PX = 34;
/** Label one bar in every LABEL_EVERY, so shown labels are at least
 * MIN_LABEL_PX apart. At the fixed BAR_W + GAP pitch this is a constant. */
const LABEL_EVERY = Math.max(1, Math.ceil(MIN_LABEL_PX / (BAR_W + GAP)));

/**
 * Whether bar `index` (of `count`) shows its date label. Labels are thinned to
 * one per `LABEL_EVERY` bars, because the bar pitch (BAR_W + GAP = 22px) is
 * narrower than a label, so labeling every bar overlaps them. Anchored to the
 * last bar (`count - 1`) so the most recent day is always labeled. Every bar
 * keeps its hover tooltip regardless.
 */
export function isLabeledBar(index: number, count: number): boolean {
  return (count - 1 - index) % LABEL_EVERY === 0;
}

/** Format a UTC-day-boundary epoch to a short day label, e.g. "Mon 18". The
 * bucket key is a UTC midnight (the byDay query floors to a UTC day), so format
 * in UTC too — otherwise a west-of-UTC viewer sees the previous day's label. */
function dayLabel(dayMs: number): string {
  return new Date(dayMs)
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" })
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
  // Natural width at the fixed bar pitch. The SVG fills its container (width
  // 100%) so few bars spread across the width instead of bunching left; this
  // is the floor below which it scrolls, so dense windows keep a >= 22px pitch.
  const minW = buckets.length * (BAR_W + GAP) - GAP;
  const svgH = CHART_H + LABEL_H;

  return (
    <div className="overflow-x-auto">
      <svg
        width="100%"
        height={svgH}
        role="img"
        aria-label="Daily spend chart"
        style={{ minWidth: `${minW}px` }}
      >
        {buckets.map((bucket, i) => {
          const label = dayLabel(bucket.dayMs);
          // A zero-spend day is a flat baseline, not a 2px stub — the 2px floor
          // only keeps a tiny-but-nonzero bar visible.
          const barH = bucket.costUsd <= 0 ? 0 : Math.max(2, (bucket.costUsd / maxCost) * (CHART_H - PADDING_TOP));
          const y = CHART_H - barH;
          // Slot center as a percentage of the (responsive) width, so bars
          // stay evenly spaced whatever the container width. The rect is
          // shifted left half a bar to center its fixed width on that point.
          const cx = `${((i + 0.5) / buckets.length) * 100}%`;
          return (
            <g key={bucket.dayMs}>
              <title>
                {label}: ${bucket.costUsd.toFixed(4)}
              </title>
              <rect
                x={cx}
                transform={`translate(${-BAR_W / 2}, 0)`}
                y={y}
                width={BAR_W}
                height={barH}
                rx={2}
                className="fill-moss opacity-80"
              />
              {isLabeledBar(i, buckets.length) && (
                <text
                  x={cx}
                  y={svgH - 2}
                  textAnchor="middle"
                  fontSize={9}
                  className="fill-muted"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
        {/* baseline */}
        <line x1={0} y1={CHART_H} x2="100%" y2={CHART_H} stroke="currentColor" strokeWidth={1} className="text-line" />
      </svg>
    </div>
  );
}
