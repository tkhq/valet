/**
 * Scorecard formatting (TKAI-332): render per-case results, totals, and the
 * baseline comparison as plain text for stdout.
 */
import type { BaselineComparison } from "./baseline.js";
import type { ScorecardEntry } from "./types.js";

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtCost(usd: number | undefined): string {
  return usd === undefined ? "unpriced" : `$${usd.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtMetric(value: number | boolean): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
}

/** Reference-tool (`ref:<tool>:*`) and pre-verification (`draft:*`) metrics only feed the code-review totals table. */
function shownMetric(key: string): boolean {
  return !key.startsWith("ref:") && !key.startsWith("draft:");
}

/**
 * One line of check metrics. With per-run metrics, a boolean shows how
 * many runs had it, and a number shows its mean across runs.
 */
export function formatMetrics(entry: ScorecardEntry): string | undefined {
  const perRun = entry.sampling?.metricsPerRun;
  if (perRun !== undefined && perRun.length > 0) {
    const keys = [...new Set(perRun.flatMap((run) => Object.keys(run)))].filter(shownMetric);
    const parts = keys.map((key) => {
      const values = perRun.map((run) => run[key]).filter((v) => v !== undefined);
      if (values.every((v) => typeof v === "boolean")) {
        return `${key} ${values.filter((v) => v === true).length}/${values.length}`;
      }
      const numbers = values.filter((v): v is number => typeof v === "number");
      const mean = numbers.reduce((a, b) => a + b, 0) / Math.max(1, numbers.length);
      return `${key} mean ${Number.isInteger(mean) ? mean : mean.toFixed(1)}`;
    });
    return `per run: ${parts.join(", ")}`;
  }
  const merged = Object.assign({}, ...entry.checkResults.flatMap((r) => (r.metrics !== undefined ? [r.metrics] : []))) as Record<
    string,
    number | boolean
  >;
  const keys = Object.keys(merged).filter(shownMetric);
  if (keys.length === 0) return undefined;
  return keys.map((key) => `${key} ${fmtMetric(merged[key])}`).join(", ");
}

function statusLabel(entry: ScorecardEntry): string {
  return entry.status.toUpperCase().padEnd(4);
}

/** Render the scorecard. `wallMs` is the whole suite's wall-clock time. */
export function formatScorecard(
  entries: ScorecardEntry[],
  opts: { comparisons?: BaselineComparison[]; wallMs?: number } = {},
): string {
  const lines: string[] = ["EVAL SCORECARD", ""];

  const idWidth = Math.max(4, ...entries.map((e) => e.caseId.length));
  for (const entry of entries) {
    if (entry.status === "skip") {
      lines.push(`  SKIP ${entry.caseId.padEnd(idWidth)}  (${entry.skipReason ?? "skipped"})`);
      continue;
    }
    const passed = entry.checkResults.filter((r) => r.pass).length;
    const checks = `${passed}/${entry.checkResults.length}`;
    const sampling =
      entry.sampling !== undefined
        ? `  runs ${entry.sampling.passes}/${entry.sampling.runs} (±${Math.round(entry.sampling.tokensStd)} tok)`
        : "";
    lines.push(
      `  ${statusLabel(entry)} ${entry.caseId.padEnd(idWidth)}  ${fmtDuration(entry.durationMs).padStart(7)}  ${fmtCost(entry.costUsd).padStart(9)}  checks ${checks}${sampling}`,
    );
    if (entry.error !== undefined) {
      lines.push(`       ! ${entry.error}`);
    }
    for (const result of entry.checkResults.filter((r) => !r.pass)) {
      lines.push(`       x ${result.check.type}: ${result.detail ?? "failed"}`);
    }
    const metrics = formatMetrics(entry);
    if (metrics !== undefined) lines.push(`       · ${metrics}`);
  }

  const passed = entries.filter((e) => e.status === "pass").length;
  const failed = entries.filter((e) => e.status === "fail").length;
  const skipped = entries.filter((e) => e.status === "skip").length;
  // Skipped cases never ran; their (stale) cost and token fields stay out
  // of the totals.
  const ran = entries.filter((e) => e.status !== "skip");
  const totalCost = ran.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const anyPriced = ran.some((e) => e.costUsd !== undefined);
  const totalTokens = ran.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
  const wallMs = opts.wallMs ?? entries.reduce((sum, e) => sum + e.durationMs, 0);

  lines.push(
    "",
    `  totals: ${passed} passed, ${failed} failed, ${skipped} skipped` +
      ` | cost ${anyPriced ? `$${totalCost.toFixed(4)}` : "unpriced"}` +
      ` | tokens ${fmtTokens(totalTokens)}` +
      ` | wall ${fmtDuration(wallMs)}`,
  );

  const review = formatReviewSummary(entries);
  if (review !== undefined) lines.push("", review);

  const comparisons = opts.comparisons ?? [];
  if (comparisons.length > 0) {
    lines.push("", "BASELINE COMPARISON", "");
    for (const c of comparisons) {
      lines.push(`  ${formatComparison(c)}`);
    }
    const regressions = comparisons.filter((c) => c.verdict === "regression").length;
    const improvements = comparisons.filter((c) => c.verdict === "improvement").length;
    lines.push("", `  ${regressions} regression(s), ${improvements} improvement(s)`);
  }

  return lines.join("\n");
}

function formatComparison(c: BaselineComparison): string {
  const parts: string[] = [];
  const movement = `${c.baselineStatus} -> ${c.currentStatus}`;
  parts.push(
    c.verdict === "regression"
      ? `REGRESSION ${movement}`
      : c.verdict === "improvement"
        ? `improvement ${movement}`
        : movement,
  );
  if (c.tokenDeltaPct !== undefined && c.baselineTokens !== undefined && c.currentTokens !== undefined) {
    const sign = c.tokenDeltaPct >= 0 ? "+" : "";
    const significance =
      c.tokenDeltaSignificance === "within_noise"
        ? " [within noise]"
        : c.tokenDeltaSignificance === "significant"
          ? " [significant]"
          : "";
    parts.push(
      `tokens ${sign}${c.tokenDeltaPct.toFixed(1)}% (${fmtTokens(c.baselineTokens)} -> ${fmtTokens(c.currentTokens)})${significance}`,
    );
  }
  if (c.baselinePassRate !== undefined && c.currentPassRate !== undefined) {
    parts.push(`pass rate ${(c.baselinePassRate * 100).toFixed(0)}% -> ${(c.currentPassRate * 100).toFixed(0)}%`);
  }
  if (c.costDeltaUsd !== undefined) {
    const sign = c.costDeltaUsd >= 0 ? "+" : "-";
    parts.push(`cost ${sign}$${Math.abs(c.costDeltaUsd).toFixed(4)}`);
  }
  parts.push(
    c.toolSequenceChanged
      ? `tools changed (${c.baselineToolSequence.join(" -> ") || "none"} => ${c.currentToolSequence.join(" -> ") || "none"})`
      : "tools unchanged",
  );
  if (c.baselineModel !== undefined) {
    parts.push(`baseline model ${c.baselineModel}`);
  }
  return `${c.caseId}: ${parts.join(" | ")}`;
}

/**
 * Code-review benchmark totals: sum `review_match` tp/fp/fn over the cases
 * that ran, for the reviewer and for every reference tool on the same cases.
 * Precision = tp/(tp+fp), recall = tp/(tp+fn), as Martian computes them.
 */
export function formatReviewSummary(entries: ScorecardEntry[]): string | undefined {
  const totals = new Map<string, { tp: number; fp: number; fn: number; cases: number }>();
  const add = (tool: string, tp: number, fp: number, fn: number): void => {
    const t = totals.get(tool) ?? { tp: 0, fp: 0, fn: 0, cases: 0 };
    t.tp += tp;
    t.fp += fp;
    t.fn += fn;
    t.cases++;
    totals.set(tool, t);
  };
  let ran = 0;
  for (const entry of entries) {
    const m = entry.checkResults.find((r) => r.check.type === "review_match")?.metrics;
    if (m === undefined) continue;
    ran++;
    add("valet", num(m.tp), num(m.fp), num(m.fn));
    if (m["draft:tp"] !== undefined) add("valet (before verify)", num(m["draft:tp"]), num(m["draft:fp"]), num(m["draft:fn"]));
    for (const key of Object.keys(m)) {
      const tool = /^ref:(.+):tp$/.exec(key)?.[1];
      if (tool !== undefined) add(tool, num(m[key]), num(m[`ref:${tool}:fp`]), num(m[`ref:${tool}:fn`]));
    }
  }
  if (ran === 0) return undefined;
  const pct = (x: number): string => (x * 100).toFixed(1).padStart(5);
  const rows = [...totals.entries()].map(([tool, t]) => {
    const p = t.tp + t.fp > 0 ? t.tp / (t.tp + t.fp) : 0;
    const r = t.tp + t.fn > 0 ? t.tp / (t.tp + t.fn) : 0;
    const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
    const f2 = p + r > 0 ? (5 * p * r) / (4 * p + r) : 0;
    return { tool, t, p, r, f1, f2 };
  });
  const rank = (tool: string): number => (tool === "valet" ? 0 : tool.startsWith("valet ") ? 1 : 2);
  rows.sort((a, b) => rank(a.tool) - rank(b.tool) || b.f1 - a.f1);
  const width = Math.max(6, ...rows.map((x) => x.tool.length));
  const lines = [
    `CODE REVIEW (${ran} PRs scored)`,
    "",
    `  ${"tool".padEnd(width)}  cases      P      R     F1     F2    TP    FP    FN`,
  ];
  for (const x of rows) {
    lines.push(
      `  ${x.tool.padEnd(width)}  ${String(x.t.cases).padStart(5)}  ${pct(x.p)}  ${pct(x.r)}  ${pct(x.f1)}  ${pct(x.f2)}  ${String(x.t.tp).padStart(4)}  ${String(x.t.fp).padStart(4)}  ${String(x.t.fn).padStart(4)}`,
    );
  }
  return lines.join("\n");
}

function num(v: number | boolean | undefined): number {
  return typeof v === "number" ? v : 0;
}
