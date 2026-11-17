/**
 * Compare two code review eval runs case by case and decide whether the
 * candidate may ship:
 *
 *   pnpm --filter @valet/eval review-compare --base base.json --candidate candidate.json
 *
 * Both files are `--json` output of the eval CLI on the same cases, run on
 * the same day with the same `--runs`. The base is the current dev branch,
 * the candidate is the change under test. Comparing against an old number
 * mixes the change with model and data drift, so always run both.
 *
 * The decision uses a paired bootstrap over cases: each resample draws
 * cases with replacement and recomputes pooled recall, false findings per
 * review and cost per review for both sides. Defaults of the ship rule:
 * - recall: at most a 10% chance that the candidate loses more than 5 points;
 * - false findings per review: at most a 10% chance that they rise by more than 10%;
 * - cost per review: the candidate's mean is at most 25% above the base.
 * A recall interval wider than 20 points says the suite is too small to
 * decide; add cases or runs.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface RunMetrics {
  tp: number;
  fp: number;
  fn: number;
  costUsd: number;
}

/** The runs of one case, from one eval output. */
export type CaseRuns = Map<string, RunMetrics[]>;

export interface ShipRule {
  /** Recall points the candidate may lose (0.05 = 5 points). */
  recallMargin: number;
  /** Relative rise in false findings per review the candidate may have (0.1 = 10%). */
  fpMargin: number;
  /** Highest candidate/base ratio of mean cost per review. */
  costBudget: number;
  /** Highest chance of breaking a margin that still ships. */
  risk: number;
  resamples: number;
  seed: number;
}

export const DEFAULT_RULE: ShipRule = { recallMargin: 0.05, fpMargin: 0.1, costBudget: 1.25, risk: 0.1, resamples: 5000, seed: 1 };

interface Totals {
  tp: number;
  fp: number;
  fn: number;
  reviews: number;
  costUsd: number;
}

export interface Comparison {
  cases: number;
  base: Totals & { recall: number; precision: number };
  candidate: Totals & { recall: number; precision: number };
  /** Candidate minus base, pooled recall: point estimate and 90% interval. */
  recallDiff: { mean: number; low: number; high: number; pLoss: number };
  /** Candidate over base, false findings per review. */
  fpRatio: { mean: number; low: number; high: number; pRise: number };
  costRatio: number;
  verdict: "ship" | "hold" | "inconclusive";
  reasons: string[];
  /** Cases where the two sides found a different number of golden issues or false findings, largest change first. */
  changed: { id: string; tp: number; fp: number }[];
  /** Cases in only one of the two files. They are left out of the comparison. */
  unmatched: string[];
}

interface EvalEntry {
  caseId: string;
  costUsd?: number;
  checkResults?: { check?: { type?: string }; metrics?: Record<string, number> }[];
  sampling?: { metricsPerRun?: Record<string, number>[]; costPerRun?: number[] };
}

/** The per-run review metrics of each case in an eval `--json` output. Text before or after the JSON (logs) is skipped. */
export function parseEvalOutput(text: string): CaseRuns {
  const start = text.search(/\{\s*"entries"/);
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error('The file is not eval --json output: no "entries" object found. Run the eval CLI with --json.');
  // Logs can come before the JSON and a captured stderr line after it.
  const parsed = JSON.parse(text.slice(start, end + 1)) as { entries?: EvalEntry[] };
  const out: CaseRuns = new Map();
  for (const e of parsed.entries ?? []) {
    const review = e.checkResults?.find((c) => c.check?.type === "review_match")?.metrics;
    const perRun = e.sampling?.metricsPerRun ?? (review ? [review] : []);
    if (perRun.length === 0) continue;
    const costs = e.sampling?.costPerRun ?? perRun.map(() => (e.costUsd ?? 0) / perRun.length);
    out.set(e.caseId, perRun.map((m, i) => ({ tp: m.tp ?? 0, fp: m.fp ?? 0, fn: m.fn ?? 0, costUsd: costs[i] ?? 0 })));
  }
  return out;
}

function totals(runs: RunMetrics[][]): Totals {
  const t: Totals = { tp: 0, fp: 0, fn: 0, reviews: 0, costUsd: 0 };
  for (const c of runs) {
    for (const r of c) {
      t.tp += r.tp;
      t.fp += r.fp;
      t.fn += r.fn;
      t.costUsd += r.costUsd;
      t.reviews += 1;
    }
  }
  return t;
}

const recallOf = (t: Totals): number => (t.tp + t.fn === 0 ? 0 : t.tp / (t.tp + t.fn));
const fpPerReview = (t: Totals): number => (t.reviews === 0 ? 0 : t.fp / t.reviews);
const costPerReview = (t: Totals): number => (t.reviews === 0 ? 0 : t.costUsd / t.reviews);

/** A small seeded generator, so a comparison gives the same answer on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

export function compareRuns(base: CaseRuns, candidate: CaseRuns, rule: ShipRule = DEFAULT_RULE): Comparison {
  const ids = [...base.keys()].filter((id) => candidate.has(id)).sort();
  const unmatched = [...new Set([...base.keys(), ...candidate.keys()])].filter((id) => !(base.has(id) && candidate.has(id))).sort();
  if (ids.length === 0) throw new Error("The two files share no cases. Run the base and the candidate on the same suite.");
  const b = ids.map((id) => base.get(id) ?? []);
  const c = ids.map((id) => candidate.get(id) ?? []);
  const bt = totals(b);
  const ct = totals(c);

  const rand = mulberry32(rule.seed);
  const recallDiffs: number[] = [];
  const fpRatios: number[] = [];
  for (let s = 0; s < rule.resamples; s++) {
    const pick = ids.map(() => Math.floor(rand() * ids.length));
    const sb = totals(pick.map((i) => b[i]));
    const sc = totals(pick.map((i) => c[i]));
    recallDiffs.push(recallOf(sc) - recallOf(sb));
    const fb = fpPerReview(sb);
    fpRatios.push(fb === 0 ? (fpPerReview(sc) === 0 ? 1 : Infinity) : fpPerReview(sc) / fb);
  }
  recallDiffs.sort((x, y) => x - y);
  fpRatios.sort((x, y) => x - y);
  const pLoss = recallDiffs.filter((d) => d < -rule.recallMargin).length / recallDiffs.length;
  const pRise = fpRatios.filter((r) => r > 1 + rule.fpMargin).length / fpRatios.length;
  const recallDiff = { mean: recallOf(ct) - recallOf(bt), low: quantile(recallDiffs, 0.05), high: quantile(recallDiffs, 0.95), pLoss };
  const fbAll = fpPerReview(bt);
  const fpRatio = { mean: fbAll === 0 ? (fpPerReview(ct) === 0 ? 1 : Infinity) : fpPerReview(ct) / fbAll, low: quantile(fpRatios, 0.05), high: quantile(fpRatios, 0.95), pRise };
  const costRatio = costPerReview(bt) === 0 ? 1 : costPerReview(ct) / costPerReview(bt);

  const reasons: string[] = [];
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  if (pLoss > rule.risk) reasons.push(`recall: ${pct(pLoss)} chance of losing more than ${Math.round(rule.recallMargin * 100)} points (limit ${pct(rule.risk)})`);
  if (pRise > rule.risk) reasons.push(`false findings: ${pct(pRise)} chance of rising more than ${pct(rule.fpMargin)} (limit ${pct(rule.risk)})`);
  if (costRatio > rule.costBudget) reasons.push(`cost: ${costRatio.toFixed(2)}x the base per review (limit ${rule.costBudget.toFixed(2)}x)`);
  const wide = recallDiff.high - recallDiff.low > 0.2;
  if (wide) reasons.push(`recall interval is ${Math.round((recallDiff.high - recallDiff.low) * 100)} points wide: add cases or runs`);
  const verdict = reasons.length === 0 ? "ship" : wide && reasons.length === 1 ? "inconclusive" : "hold";

  const changed = ids
    .map((id, i) => {
      const tb = totals([b[i]]);
      const tc = totals([c[i]]);
      return { id, tp: tc.tp - tb.tp, fp: tc.fp - tb.fp };
    })
    .filter((x) => x.tp !== 0 || x.fp !== 0)
    .sort((x, y) => Math.abs(y.tp) * 10 + Math.abs(y.fp) - (Math.abs(x.tp) * 10 + Math.abs(x.fp)));

  const withRates = (t: Totals) => ({ ...t, recall: recallOf(t), precision: t.tp + t.fp === 0 ? 0 : t.tp / (t.tp + t.fp) });
  return { cases: ids.length, base: withRates(bt), candidate: withRates(ct), recallDiff, fpRatio, costRatio, verdict, reasons, changed, unmatched };
}

export function formatComparison(c: Comparison): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}`;
  const side = (name: string, t: Comparison["base"]): string =>
    `${name.padEnd(10)} reviews ${String(t.reviews).padStart(4)}  tp ${String(t.tp).padStart(4)}  fp ${String(t.fp).padStart(4)}  fn ${String(t.fn).padStart(4)}  recall ${pct(t.recall).padStart(5)}  precision ${pct(t.precision).padStart(5)}  fp/review ${(t.reviews ? t.fp / t.reviews : 0).toFixed(2)}  $/review ${(t.reviews ? t.costUsd / t.reviews : 0).toFixed(3)}`;
  const lines = [
    `REVIEW COMPARE (${c.cases} paired cases)`,
    side("base", c.base),
    side("candidate", c.candidate),
    "",
    `recall diff ${pct(c.recallDiff.mean)} points (90% interval ${pct(c.recallDiff.low)} to ${pct(c.recallDiff.high)})`,
    `false findings per review ${c.fpRatio.mean.toFixed(2)}x (90% interval ${c.fpRatio.low.toFixed(2)}x to ${c.fpRatio.high.toFixed(2)}x)`,
    `cost per review ${c.costRatio.toFixed(2)}x`,
    "",
    `VERDICT: ${c.verdict.toUpperCase()}${c.reasons.length ? ` (${c.reasons.join("; ")})` : ""}`,
  ];
  if (c.changed.length > 0) lines.push("", "Cases that changed (candidate minus base, all runs):", ...c.changed.map((x) => `  ${x.id}: tp ${x.tp >= 0 ? "+" : ""}${x.tp}, fp ${x.fp >= 0 ? "+" : ""}${x.fp}`));
  if (c.unmatched.length > 0) lines.push("", `Left out (in one file only): ${c.unmatched.join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      candidate: { type: "string" },
      "recall-margin": { type: "string" },
      "fp-margin": { type: "string" },
      "cost-budget": { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (!values.base || !values.candidate) {
    throw new Error("Usage: review-compare --base base.json --candidate candidate.json [--recall-margin 0.05] [--fp-margin 0.1] [--cost-budget 1.25] [--json]");
  }
  const num = (v: string | undefined, d: number): number => (v === undefined ? d : Number(v));
  const rule: ShipRule = { ...DEFAULT_RULE, recallMargin: num(values["recall-margin"], DEFAULT_RULE.recallMargin), fpMargin: num(values["fp-margin"], DEFAULT_RULE.fpMargin), costBudget: num(values["cost-budget"], DEFAULT_RULE.costBudget) };
  const result = compareRuns(parseEvalOutput(await readFile(values.base, "utf8")), parseEvalOutput(await readFile(values.candidate, "utf8")), rule);
  console.log(values.json ? JSON.stringify(result, null, 2) : formatComparison(result));
  if (result.verdict === "hold") process.exitCode = 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
