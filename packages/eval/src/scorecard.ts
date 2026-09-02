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
