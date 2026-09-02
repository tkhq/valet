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
    const skip = (skipReason: string): void => {
      entries.push({ caseId: evalCase.id, status: "skip", skipReason, durationMs: 0, checkResults: [] });
    };

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
      const result = await runCase(caseForRun, {
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

      const completed = result.outcome === "completed";
      const allChecksPass = checkResults.every((r) => r.pass);
      // Recursive totals: an orchestrator case's spend includes every child
      // session it spawned, not just the parent thread.
      const totals = aggregateUsage(result.trajectory);
      entry = {
        caseId: evalCase.id,
        status: completed && allChecksPass ? "pass" : "fail",
        durationMs: result.trajectory.durationMs,
        ...(totals.cost !== undefined ? { costUsd: totals.cost.total } : {}),
        totalTokens: totals.usage.total,
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
