/**
 * Suite orchestration (TKAI-333): run a list of eval cases through the
 * runner, score each trajectory, compare to baselines, and optionally save
 * new baselines. `cli.ts` is a thin argv wrapper around `runSuite`.
 */
import type { Model } from "@valet/engine";
import {
  compareToBaseline,
  loadLatestBaseline,
  saveBaseline,
  type BaselineComparison,
  type BaselineRecord,
} from "./baseline.js";
import { runChecks, type JudgeRunner } from "./checks/index.js";
import { runCase } from "./runner.js";
import type { EvalCase, ScorecardEntry } from "./types.js";

/** Profiles the suite can run today. mock lands in TKAI-335, integration/full in TKAI-336. */
const SUPPORTED_PROFILES = new Set(["unit"]);

export interface SuiteOptions {
  /** Default model for cases without a pin. */
  model: string | Model<string>;
  /** Directory holding baseline files. */
  baselinesDir: string;
  /** Judge for judge_* checks. Absent → judge checks fail with a config detail. */
  judge?: JudgeRunner;
  /** Override every case's timeout. */
  timeoutMs?: number;
  /** Save each finished case's trajectory as a new baseline. */
  saveBaselines?: boolean;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Per-case progress callback (called before each case runs). */
  onCaseStart?: (evalCase: EvalCase, index: number, total: number) => void;
}

export interface SuiteResult {
  entries: ScorecardEntry[];
  comparisons: BaselineComparison[];
  wallMs: number;
  /** Baseline files written when `saveBaselines` is set. */
  savedBaselinePaths: string[];
}

export async function runSuite(cases: EvalCase[], opts: SuiteOptions): Promise<SuiteResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().getTime();
  const entries: ScorecardEntry[] = [];
  const comparisons: BaselineComparison[] = [];
  const savedBaselinePaths: string[] = [];

  for (const [index, evalCase] of cases.entries()) {
    opts.onCaseStart?.(evalCase, index, cases.length);

    const profile = evalCase.profile ?? "unit";
    if (!SUPPORTED_PROFILES.has(profile)) {
      entries.push({
        caseId: evalCase.id,
        status: "skip",
        skipReason: `profile ${profile} is not supported yet (mock: TKAI-335, integration/full: TKAI-336)`,
        durationMs: 0,
        checkResults: [],
      });
      continue;
    }

    let entry: ScorecardEntry;
    let baseline: BaselineRecord | null = null;
    try {
      const modelSpec =
        evalCase.model ??
        (typeof opts.model === "string" ? opts.model : `${opts.model.provider}/${opts.model.id}`);
      baseline = await loadLatestBaseline(opts.baselinesDir, evalCase.id, modelSpec);

      const caseForRun =
        opts.timeoutMs !== undefined ? { ...evalCase, timeout_ms: opts.timeoutMs } : evalCase;
      const result = await runCase(caseForRun, {
        model: evalCase.model ?? opts.model,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });

      const checkResults = await runChecks(evalCase.checks, result.trajectory, {
        ...(opts.judge !== undefined ? { judge: opts.judge } : {}),
        ...(baseline !== null ? { baseline: baseline.trajectory } : {}),
      });

      const completed = result.outcome === "completed";
      const allChecksPass = checkResults.every((r) => r.pass);
      entry = {
        caseId: evalCase.id,
        status: completed && allChecksPass ? "pass" : "fail",
        durationMs: result.trajectory.durationMs,
        ...(result.trajectory.cost !== undefined ? { costUsd: result.trajectory.cost.total } : {}),
        totalTokens: result.trajectory.usage.total,
        checkResults,
        trajectory: result.trajectory,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    } catch (err) {
      entry = {
        caseId: evalCase.id,
        status: "fail",
        durationMs: 0,
        checkResults: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    entries.push(entry);

    if (baseline !== null && entry.trajectory !== undefined) {
      comparisons.push(compareToBaseline(entry, baseline));
    }

    if (opts.saveBaselines === true && entry.trajectory !== undefined) {
      savedBaselinePaths.push(
        await saveBaseline(opts.baselinesDir, {
          caseId: evalCase.id,
          model: entry.trajectory.model,
          savedAt: now().toISOString(),
          status: entry.status === "pass" ? "pass" : "fail",
          trajectory: entry.trajectory,
        }),
      );
    }
  }

  return { entries, comparisons, wallMs: now().getTime() - startedAt, savedBaselinePaths };
}
