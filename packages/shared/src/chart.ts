/**
 * A chart in the shape of Slack's Block Kit `data_visualization` block
 * (https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block).
 * The model writes one chart; Slack draws it natively from
 * `slack.reply_to_origin`, and the web draws the same object in the
 * `show_widget` Chart card. The limits are Slack's, so a chart that passes
 * here posts in Slack.
 */

export type ChartPoint = { label: string; value: number };
export type ChartSeries = { name: string; data: ChartPoint[] };
export type ChartAxis = { categories: string[]; x_label?: string; y_label?: string };

export type ChartBody =
  | { type: "pie"; segments: ChartPoint[] }
  | { type: "bar" | "area" | "line"; series: ChartSeries[]; axis_config: ChartAxis };

export interface Chart {
  title: string;
  chart: ChartBody;
}

export const CHART_LIMITS = { title: 50, label: 20, axisLabel: 50, series: 12, points: 20, segments: 12, perMessage: 2 } as const;
const AXIS_TYPES = ["bar", "area", "line"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Why `value` is not a chart Slack accepts, or undefined. Each message names the fix. */
export function chartProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "A chart must be an object with title and chart.";
  if (!shortText(value.title, CHART_LIMITS.title)) return `Give the chart a title of 1 to ${CHART_LIMITS.title} characters.`;
  const body = value.chart;
  if (!isRecord(body)) return "Set chart to an object with a type: pie, bar, area, or line.";
  if (body.type === "pie") {
    const segments = body.segments;
    if (!Array.isArray(segments) || segments.length === 0 || segments.length > CHART_LIMITS.segments) {
      return `A pie chart needs 1 to ${CHART_LIMITS.segments} segments. Group the smallest ones into "Other".`;
    }
    for (const segment of segments) {
      if (!isRecord(segment) || !shortText(segment.label, CHART_LIMITS.label)) return `Give each segment a label of 1 to ${CHART_LIMITS.label} characters.`;
      if (typeof segment.value !== "number" || !Number.isFinite(segment.value) || segment.value <= 0) {
        return `Segment "${segment.label}" needs a value greater than 0. Leave out empty segments.`;
      }
    }
    return undefined;
  }
  if (!AXIS_TYPES.some((type) => type === body.type)) return "Set chart.type to pie, bar, area, or line.";
  const axis = body.axis_config;
  if (!isRecord(axis) || !Array.isArray(axis.categories) || axis.categories.length === 0 || axis.categories.length > CHART_LIMITS.points) {
    return `Set chart.axis_config.categories to 1 to ${CHART_LIMITS.points} x-axis labels in order. Aggregate the data into fewer buckets.`;
  }
  const categories = new Set<string>();
  for (const category of axis.categories) {
    if (!shortText(category, CHART_LIMITS.label)) return `Make each category 1 to ${CHART_LIMITS.label} characters.`;
    categories.add(category);
  }
  if (categories.size !== axis.categories.length) return "Make each category unique.";
  for (const key of ["x_label", "y_label"] as const) {
    if (axis[key] !== undefined && !shortText(axis[key], CHART_LIMITS.axisLabel)) return `Make ${key} 1 to ${CHART_LIMITS.axisLabel} characters, or leave it out.`;
  }
  const series = body.series;
  if (!Array.isArray(series) || series.length === 0 || series.length > CHART_LIMITS.series) {
    return `A ${String(body.type)} chart needs 1 to ${CHART_LIMITS.series} series. Draw two charts for more.`;
  }
  const names = new Set<string>();
  for (const one of series) {
    if (!isRecord(one) || !shortText(one.name, CHART_LIMITS.label)) return `Give each series a name of 1 to ${CHART_LIMITS.label} characters.`;
    if (names.has(one.name)) return `Series names must be unique; "${one.name}" repeats.`;
    names.add(one.name);
    if (!Array.isArray(one.data) || one.data.length !== categories.size) {
      return `Series "${one.name}" needs one point for each category (${categories.size}). Use 0 for a missing value.`;
    }
    const seen = new Set<string>();
    for (const point of one.data) {
      if (!isRecord(point) || typeof point.label !== "string" || !categories.has(point.label) || seen.has(point.label)) {
        return `Each point in series "${one.name}" needs a label from axis_config.categories, used once.`;
      }
      seen.add(point.label);
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) return `Point "${point.label}" in series "${one.name}" needs a numeric value.`;
    }
  }
  return undefined;
}

/** `value` as a Chart, or undefined when `chartProblem` finds a problem. */
export function readChart(value: unknown): Chart | undefined {
  // chartProblem checked every field of the shape above.
  return chartProblem(value) === undefined ? (value as Chart) : undefined;
}

/**
 * Chart text as one table cell: a line break becomes a space, and a pipe or
 * backslash is escaped. Otherwise a label such as `P|\n|x|9|` splits its row
 * and adds a forged row.
 */
function cell(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\\|]/g, "\\$&");
}

/** The chart as a Markdown table, for a Slack client that rejects the native block. */
export function chartAsMarkdown(chart: Chart): string {
  const body = chart.chart;
  const rows = body.type === "pie"
    ? ["| Segment | Value |", "| --- | ---: |", ...body.segments.map((s) => `| ${cell(s.label)} | ${s.value} |`)]
    : [
      `| ${cell(body.axis_config.x_label ?? "")} | ${body.series.map((s) => cell(s.name)).join(" | ")} |`,
      `| --- |${body.series.map(() => " ---: |").join("")}`,
      ...body.axis_config.categories.map((category) =>
        `| ${cell(category)} | ${body.series.map((s) => s.data.find((p) => p.label === category)?.value ?? "").join(" | ")} |`),
    ];
  return [`**${cell(chart.title)}**`, "", ...rows].join("\n");
}
