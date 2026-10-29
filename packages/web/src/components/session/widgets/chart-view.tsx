import { useEffect, useRef, useState } from "react";
import type { Chart, ChartSeries } from "@valet/shared";

/**
 * The widget catalog's Chart card: the same `{ title, chart }` object that
 * `slack.reply_to_origin` posts as a native Slack chart, drawn here as
 * inline SVG. Each mark has a native hover title, and a hidden table gives
 * screen readers the numbers.
 */

/** Reference categorical palette, light and dark steps, in its CVD-checked order. */
const SERIES = [
  "light-dark(#2a78d6, #3987e5)", "light-dark(#eb6834, #d95926)", "light-dark(#1baf7a, #199e70)", "light-dark(#eda100, #c98500)",
  "light-dark(#e87ba4, #d55181)", "light-dark(#008300, #008300)", "light-dark(#6250d6, #9085e9)", "light-dark(#e34948, #e66767)",
];
const color = (index: number) => SERIES[index % SERIES.length];

const H = 220;
const PAD = { top: 8, right: 8, bottom: 24, left: 44 };
const PLOT_H = H - PAD.top - PAD.bottom;

/** The element's width in pixels, so the SVG draws at 1:1 and its text stays 11px in a narrow card. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** About four round tick values that cover [min, max], always including 0. */
export function niceTicks(min: number, max: number): number[] {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  if (low === high) return [0, 1];
  const raw = (high - low) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  // Near Number.MAX_VALUE the loop bound overflows to Infinity and never ends; use the bare range.
  if (!Number.isFinite(high - low + step)) return [low, high];
  const ticks: number[] = [];
  for (let t = Math.floor(low / step) * step; t <= high + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  if (ticks[ticks.length - 1]! < high) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

const format = (value: number) => Intl.NumberFormat(undefined, { notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(value);

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
    {names.map((name, i) => <li key={name} className="flex items-center gap-1.5">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: color(i) }} />{name}
    </li>)}
  </ul>;
}

function AxisChart({ type, series, categories }: { type: "bar" | "line" | "area"; series: ChartSeries[]; categories: string[] }) {
  const [ref, W] = useWidth(560);
  const PLOT_W = W - PAD.left - PAD.right;
  const valueAt = (s: ChartSeries, category: string) => s.data.find((p) => p.label === category)?.value ?? 0;
  const values = series.flatMap((s) => s.data.map((p) => p.value));
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const y = (v: number) => PAD.top + PLOT_H * (1 - (v - lo) / (hi - lo));
  const band = PLOT_W / categories.length;
  const x = (i: number) => PAD.left + band * (i + 0.5);
  const barW = Math.max(2, (band * 0.7) / series.length - 2);
  // Show every category label when they fit, otherwise every nth one.
  const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(PLOT_W / 56))));
  return <div ref={ref} className="min-w-0"><svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block overflow-visible" aria-hidden>
    {ticks.map((t) => <g key={t}>
      <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="currentColor" className={t === 0 ? "text-muted" : "text-line"} strokeWidth={1} />
      <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">{format(t)}</text>
    </g>)}
    {categories.map((c, i) => i % every === 0 && <text key={c} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted text-[11px]">{c}</text>)}
    {type === "bar" && series.map((s, si) => categories.map((c, i) => {
      const v = valueAt(s, c);
      const left = x(i) - (barW + 2) * series.length / 2 + si * (barW + 2) + 1;
      return <rect key={`${s.name}-${c}`} x={left} width={barW} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={Math.min(3, barW / 2)} style={{ fill: color(si) }}>
        <title>{`${s.name} · ${c}: ${format(v)}`}</title>
      </rect>;
    }))}
    {type !== "bar" && series.map((s, si) => {
      const points = categories.map((c, i) => `${x(i)},${y(valueAt(s, c))}`);
      return <g key={s.name}>
        {type === "area" && <polygon points={[`${x(0)},${y(0)}`, ...points, `${x(categories.length - 1)},${y(0)}`].join(" ")} style={{ fill: color(si) }} opacity={0.25} />}
        <polyline points={points.join(" ")} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: color(si) }} />
        {categories.map((c, i) => <circle key={c} cx={x(i)} cy={y(valueAt(s, c))} r={categories.length > 12 ? 2 : 3} style={{ fill: color(si) }}>
          <title>{`${s.name} · ${c}: ${format(valueAt(s, c))}`}</title>
        </circle>)}
      </g>;
    })}
  </svg></div>;
}

function Pie({ segments }: { segments: { label: string; value: number }[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const r = 80;
  const inner = 48;
  let angle = -Math.PI / 2;
  const point = (a: number, radius: number) => `${100 + radius * Math.cos(a)},${100 + radius * Math.sin(a)}`;
  return <svg viewBox="0 0 200 200" className="h-40 w-40 shrink-0" aria-hidden>
    {segments.map((s, i) => {
      const sweep = (s.value / total) * Math.PI * 2;
      const start = angle;
      angle += sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const d = segments.length === 1
        ? `M ${point(0, r)} A ${r} ${r} 0 1 1 ${point(Math.PI, r)} A ${r} ${r} 0 1 1 ${point(0, r)} M ${point(0, inner)} A ${inner} ${inner} 0 1 0 ${point(Math.PI, inner)} A ${inner} ${inner} 0 1 0 ${point(0, inner)} Z`
        : `M ${point(start, r)} A ${r} ${r} 0 ${large} 1 ${point(angle, r)} L ${point(angle, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`;
      return <path key={s.label} d={d} fillRule="evenodd" stroke="var(--paper)" strokeWidth={2} style={{ fill: color(i) }}>
        <title>{`${s.label}: ${format(s.value)} (${Math.round((s.value / total) * 100)}%)`}</title>
      </path>;
    })}
  </svg>;
}

export function ChartView({ title, chart }: Chart) {
  const rows = chart.type === "pie"
    ? chart.segments.map((s) => [s.label, format(s.value)])
    : chart.axis_config.categories.map((c) => [c, ...chart.series.map((s) => format(s.data.find((p) => p.label === c)?.value ?? 0))]);
  const head = chart.type === "pie" ? ["Segment", "Value"] : [chart.axis_config.x_label ?? "", ...chart.series.map((s) => s.name)];
  return <figure className="min-w-0 space-y-2">
    <figcaption className="text-sm font-medium text-ink">{title}</figcaption>
    {chart.type === "pie"
      ? <div className="flex flex-wrap items-center gap-4">
        <Pie segments={chart.segments} />
        <ul className="space-y-1 text-xs text-muted">
          {chart.segments.map((s, i) => <li key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: color(i) }} />{s.label}
            <span className="tabular-nums text-ink">{format(s.value)}</span>
          </li>)}
        </ul>
      </div>
      : <>
        <Legend names={chart.series.map((s) => s.name)} />
        {chart.axis_config.y_label && <p className="text-xs text-muted">{chart.axis_config.y_label}</p>}
        <AxisChart type={chart.type} series={chart.series} categories={chart.axis_config.categories} />
        {chart.axis_config.x_label && <p className="text-center text-xs text-muted">{chart.axis_config.x_label}</p>}
      </>}
    <table className="sr-only">
      <caption>{title}</caption>
      <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row[0]}>{row.map((cell, i) => i === 0 ? <th key={i} scope="row">{cell}</th> : <td key={i}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </figure>;
}
