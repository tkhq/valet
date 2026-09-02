/**
 * Baseline save/load/compare (TKAI-332).
 *
 * `--save-baseline` writes each trajectory to
 * `evals/baselines/{case-id}/{model}_{date}.json` (the model spec's `/`
 * becomes `-` in the file name). A normal run loads the most recent
 * baseline for each case and model; when the model has no baseline, the
 * most recent baseline of any model is used and the comparison notes the
 * model difference.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SamplingStats, ScorecardEntry, Trajectory } from "./types.js";

/** One persisted baseline file. */
export interface BaselineRecord {
  caseId: string;
  model: string;
  /** ISO-8601 save time. */
  savedAt: string;
  status: "pass" | "fail";
  trajectory: Trajectory;
  /** Multi-run stats from a pass@k run, when the case ran more than once. */
  sampling?: SamplingStats;
}

/** Comparison of one case run against its baseline. */
export interface BaselineComparison {
  caseId: string;
  /** pass/fail movement between the baseline run and this run. */
  verdict: "regression" | "improvement" | "unchanged";
  baselineStatus: "pass" | "fail";
  currentStatus: "pass" | "fail";
  /** Total-token delta, percent of the baseline. Absent when either side reported no tokens. */
  tokenDeltaPct?: number;
  baselineTokens?: number;
  currentTokens?: number;
  /**
   * Whether the token delta clears the sampling noise band. Present only
   * when at least one side carries multi-run stats: "significant" means
   * |delta| > 2x the larger recorded std; "within_noise" means it does
   * not. Single-run-to-single-run comparisons stay unlabeled — there is
   * no variance estimate to judge them against.
   */
  tokenDeltaSignificance?: "significant" | "within_noise";
  /** Pass-rate movement, when either side ran pass@k. */
  baselinePassRate?: number;
  currentPassRate?: number;
  /** USD cost delta (current - baseline). Absent when either side is unpriced. */
  costDeltaUsd?: number;
  /** True when the tool call sequences differ. */
  toolSequenceChanged: boolean;
  baselineToolSequence: string[];
  currentToolSequence: string[];
  /** Set when the baseline came from a different model. */
  baselineModel?: string;
}

function modelSlug(model: string): string {
  return model.replace(/[/\\:]/g, "-");
}

function isBaselineRecord(v: unknown): v is BaselineRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.caseId === "string" &&
    typeof r.model === "string" &&
    typeof r.savedAt === "string" &&
    (r.status === "pass" || r.status === "fail") &&
    typeof r.trajectory === "object" &&
    r.trajectory !== null
  );
}

/** Write one baseline file and return its path. */
export async function saveBaseline(
  baselinesDir: string,
  record: BaselineRecord,
): Promise<string> {
  const caseDir = join(baselinesDir, record.caseId);
  await mkdir(caseDir, { recursive: true });
  const date = record.savedAt.slice(0, 10);
  const path = join(caseDir, `${modelSlug(record.model)}_${date}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

/** Read every valid baseline record for a case, unsorted. */
async function readCaseBaselines(baselinesDir: string, caseId: string): Promise<BaselineRecord[]> {
  const caseDir = join(baselinesDir, caseId);
  let files: string[];
  try {
    files = await readdir(caseDir);
  } catch {
    return [];
  }
  const records: BaselineRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(caseDir, file), "utf8"));
      if (isBaselineRecord(parsed)) records.push(parsed);
    } catch {
      // An unreadable baseline never fails the run; it is simply not compared.
    }
  }
  return records;
}

/**
 * Load the most recent baseline for a case: the newest record for `model`,
 * falling back to the newest record of any model.
 */
export async function loadLatestBaseline(
  baselinesDir: string,
  caseId: string,
  model: string,
): Promise<BaselineRecord | null> {
  const records = await readCaseBaselines(baselinesDir, caseId);
  if (records.length === 0) return null;
  const bySavedAtDesc = (a: BaselineRecord, b: BaselineRecord) => b.savedAt.localeCompare(a.savedAt);
  const sameModel = records.filter((r) => r.model === model).sort(bySavedAtDesc);
  if (sameModel.length > 0) return sameModel[0];
  return records.sort(bySavedAtDesc)[0];
}

function toolSequence(t: Trajectory): string[] {
  return t.toolCalls.map((c) => c.toolName);
}

/**
 * Compare one finished case against its baseline. Skipped cases and cases
 * without a trajectory are not comparable — the caller filters those out.
 */
export function compareToBaseline(entry: ScorecardEntry, baseline: BaselineRecord): BaselineComparison {
  const currentStatus: "pass" | "fail" = entry.status === "pass" ? "pass" : "fail";
  const verdict: BaselineComparison["verdict"] =
    baseline.status === currentStatus
      ? "unchanged"
      : currentStatus === "fail"
        ? "regression"
        : "improvement";

  const comparison: BaselineComparison = {
    caseId: entry.caseId,
    verdict,
    baselineStatus: baseline.status,
    currentStatus,
    toolSequenceChanged: false,
    baselineToolSequence: toolSequence(baseline.trajectory),
    currentToolSequence: entry.trajectory !== undefined ? toolSequence(entry.trajectory) : [],
  };
  comparison.toolSequenceChanged =
    comparison.baselineToolSequence.join("→") !== comparison.currentToolSequence.join("→");

  // Means when multi-run stats exist, single-run totals otherwise.
  const baseTokens = baseline.sampling?.tokensMean ?? baseline.trajectory.usage.total;
  const curTokens = entry.sampling?.tokensMean ?? entry.trajectory?.usage.total ?? entry.totalTokens;
  if (baseTokens > 0 && curTokens !== undefined && curTokens > 0) {
    comparison.baselineTokens = Math.round(baseTokens);
    comparison.currentTokens = Math.round(curTokens);
    comparison.tokenDeltaPct = ((curTokens - baseTokens) / baseTokens) * 100;
    // Noise band: 2x the larger recorded per-run std. Only computable when
    // at least one side ran pass@k and measured its own variance.
    const stds = [baseline.sampling?.tokensStd, entry.sampling?.tokensStd].filter(
      (v): v is number => v !== undefined,
    );
    if (stds.length > 0) {
      const band = 2 * Math.max(...stds);
      comparison.tokenDeltaSignificance =
        Math.abs(curTokens - baseTokens) > band ? "significant" : "within_noise";
    }
  }

  if (baseline.sampling !== undefined || entry.sampling !== undefined) {
    comparison.baselinePassRate =
      baseline.sampling !== undefined
        ? baseline.sampling.passes / baseline.sampling.runs
        : baseline.status === "pass"
          ? 1
          : 0;
    comparison.currentPassRate =
      entry.sampling !== undefined
        ? entry.sampling.passes / entry.sampling.runs
        : currentStatus === "pass"
          ? 1
          : 0;
  }

  const baseCost = baseline.trajectory.cost?.total;
  const curCost = entry.trajectory?.cost?.total ?? entry.costUsd;
  if (baseCost !== undefined && curCost !== undefined) {
    comparison.costDeltaUsd = curCost - baseCost;
  }

  if (baseline.model !== (entry.trajectory?.model ?? baseline.model)) {
    comparison.baselineModel = baseline.model;
  }

  return comparison;
}
