/**
 * Suite orchestration (TKAI-333): run a list of eval cases through the
 * runner, score each trajectory, compare to baselines, and optionally save
 * new baselines. `cli.ts` is a thin argv wrapper around `runSuite`.
 */
import type { Model, SandboxProvider, ValetPlugin } from "@valet/engine";
import {
  compareToBaseline,
  loadLatestBaseline,
  saveBaseline,
  type BaselineComparison,
  type BaselineRecord,
} from "./baseline.js";
import { runChecks, type JudgeRunner } from "./checks/index.js";
import { runProductCase } from "./product-drive.js";
import { runCase } from "./runner.js";
import { aggregateUsage } from "./trajectory.js";
import type { EvalCase, ScorecardEntry } from "./types.js";

import { envKeyForService } from "./integration.js";

export interface SuiteOptions {
  /** Default model for cases without a pin. */
  model: string | Model<string>;
  /** Directory holding baseline files. */
  baselinesDir: string;
  /** Judge for judge_* checks. Absent → judge checks fail with a config detail. */
  judge?: JudgeRunner;
  /** Real plugin manifests backing `profile: mock` cases. */
  mockPlugins?: ValetPlugin[];
  /** Real plugin manifests backing `profile: integration`/`full` cases. */
  realPlugins?: ValetPlugin[];
  /** Live credentials keyed by credential service (see loadEvalCredentials). */
  credentials?: Record<string, string>;
  /** Result of the Docker probe. false → `profile: full` cases SKIP. */
  dockerAvailable?: boolean;
  /** Factory for the `profile: full` sandbox provider (a Docker provider). */
  fullSandboxProvider?: () => SandboxProvider;
  /** Override every case's timeout. */
  timeoutMs?: number;
  /** Override every case's `runs` (pass@k sample count). */
  runsOverride?: number;
  /** Save each finished case's trajectory as a new baseline. */
  saveBaselines?: boolean;
  /**
   * Permit saving baselines for integration/full cases. Off by default:
   * their trajectories carry LIVE API responses verbatim, and
   * `evals/baselines/` is git-tracked — an accidental save can commit
   * private data. Cases with these profiles are otherwise skipped from
   * saving, with a note in the result.
   */
  allowLiveBaselines?: boolean;
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
  /**
   * Integration/full cases whose baselines were NOT saved because
   * `allowLiveBaselines` was off (live API responses must not land in the
   * tracked baselines dir by accident).
   */
  skippedLiveBaselineCaseIds: string[];
}

export async function runSuite(cases: EvalCase[], opts: SuiteOptions): Promise<SuiteResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().getTime();
  const entries: ScorecardEntry[] = [];
  const comparisons: BaselineComparison[] = [];
  const savedBaselinePaths: string[] = [];
  const skippedLiveBaselineCaseIds: string[] = [];

  for (const [index, evalCase] of cases.entries()) {
    opts.onCaseStart?.(evalCase, index, cases.length);

    const profile = evalCase.profile ?? "unit";
    const skip = (skipReason: string): void => {
      entries.push({ caseId: evalCase.id, status: "skip", skipReason, durationMs: 0, checkResults: [] });
    };

    if (evalCase.drive === "product" && (process.env.ANTHROPIC_API_KEY ?? "") === "") {
      skip("drive: product boots the real api and makes real LLM calls. Set ANTHROPIC_API_KEY.");
      continue;
    }

    if (profile === "integration" || profile === "full") {
      // Missing credentials SKIP, never FAIL: an eval box without a GitHub
      // token has nothing to measure, and a red row would cry wolf.
      const missing = (evalCase.required_credentials ?? []).filter(
        (service) => opts.credentials?.[service] === undefined,
      );
      if (missing.length > 0) {
        const hints = missing.map((s) => envKeyForService(s) ?? s).join(", ");
        skip(`missing credential(s): ${missing.join(", ")}. Set ${hints} in .env.eval.`);
        continue;
      }
      if (profile === "full" && opts.dockerAvailable !== true) {
        skip("Docker is not available. Start the Docker daemon to run full-profile cases.");
        continue;
      }
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
      const runCount = Math.max(1, opts.runsOverride ?? evalCase.runs ?? 1);
      const threshold = evalCase.pass_threshold ?? 1;

      interface RunOutcome {
        pass: boolean;
        checkResults: Awaited<ReturnType<typeof runChecks>>;
        trajectory: NonNullable<ScorecardEntry["trajectory"]>;
        tokens: number;
        cost?: number;
        durationMs: number;
        error?: string;
      }
      const runOutcomes: RunOutcome[] = [];
      for (let runIndex = 0; runIndex < runCount; runIndex++) {
        const result =
          evalCase.drive === "product"
            ? await runProductCase(caseForRun, {
                model: modelSpec,
                ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
              })
            : await runCase(caseForRun, {
                model: evalCase.model ?? opts.model,
                ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
                ...(opts.mockPlugins !== undefined ? { mockPlugins: opts.mockPlugins } : {}),
                ...(opts.realPlugins !== undefined ? { realPlugins: opts.realPlugins } : {}),
                ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
                ...(profile === "full" && opts.fullSandboxProvider !== undefined
                  ? { sandboxProvider: opts.fullSandboxProvider() }
                  : {}),
              });
        const checkResults = await runChecks(evalCase.checks, result.trajectory, {
          ...(opts.judge !== undefined ? { judge: opts.judge } : {}),
          ...(baseline !== null ? { baseline: baseline.trajectory } : {}),
        });
        // Recursive totals: an orchestrator case's spend includes every
        // child session it spawned, not just the parent thread.
        const totals = aggregateUsage(result.trajectory);
        runOutcomes.push({
          pass: result.outcome === "completed" && checkResults.every((r) => r.pass),
          checkResults,
          trajectory: result.trajectory,
          tokens: totals.usage.total,
          ...(totals.cost !== undefined ? { cost: totals.cost.total } : {}),
          durationMs: result.trajectory.durationMs,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
      }

      const passes = runOutcomes.filter((r) => r.pass).length;
      const status: ScorecardEntry["status"] = passes / runCount >= threshold ? "pass" : "fail";
      // Report the first failing run when any failed (the one to debug),
      // else the last run.
      const reported = runOutcomes.find((r) => !r.pass) ?? runOutcomes[runOutcomes.length - 1];
      const tokensPerRun = runOutcomes.map((r) => r.tokens);
      const tokensMean = tokensPerRun.reduce((a, b) => a + b, 0) / runCount;
      const tokensStd = Math.sqrt(
        tokensPerRun.reduce((a, b) => a + (b - tokensMean) ** 2, 0) / runCount,
      );
      const anyCost = runOutcomes.some((r) => r.cost !== undefined);
      const totalCost = runOutcomes.reduce((a, r) => a + (r.cost ?? 0), 0);

      entry = {
        caseId: evalCase.id,
        status,
        durationMs: reported.durationMs,
        ...(anyCost ? { costUsd: totalCost } : {}),
        totalTokens: Math.round(tokensMean),
        checkResults: reported.checkResults,
        trajectory: reported.trajectory,
        ...(reported.error !== undefined ? { error: reported.error } : {}),
        ...(runCount > 1
          ? {
              sampling: {
                runs: runCount,
                passes,
                threshold,
                tokensPerRun,
                tokensMean,
                tokensStd,
                ...(anyCost ? { costPerRun: runOutcomes.map((r) => r.cost ?? 0) } : {}),
              },
            }
          : {}),
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

    const liveProfile = profile === "integration" || profile === "full";
    if (opts.saveBaselines === true && liveProfile && opts.allowLiveBaselines !== true) {
      skippedLiveBaselineCaseIds.push(evalCase.id);
    } else if (opts.saveBaselines === true && entry.trajectory !== undefined) {
      savedBaselinePaths.push(
        await saveBaseline(opts.baselinesDir, {
          caseId: evalCase.id,
          model: entry.trajectory.model,
          savedAt: now().toISOString(),
          status: entry.status === "pass" ? "pass" : "fail",
          trajectory: entry.trajectory,
          ...(entry.sampling !== undefined ? { sampling: entry.sampling } : {}),
        }),
      );
    }
  }

  return {
    entries,
    comparisons,
    wallMs: now().getTime() - startedAt,
    savedBaselinePaths,
    skippedLiveBaselineCaseIds,
  };
}
