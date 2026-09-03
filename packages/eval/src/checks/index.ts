/**
 * Check dispatch (TKAI-330): given a `Check` and a `Trajectory`, call the
 * right handler and return a `CheckResult`.
 *
 * Deterministic checks run inline. Judge checks need an LLM client and
 * (for `judge_equivalence`) a baseline trajectory, both supplied through
 * `CheckContext`; the handlers land in TKAI-331. A judge check without a
 * judge in context fails with an explanatory detail instead of crashing.
 */
import type { Check, CheckResult, JudgeCheck, Trajectory } from "../types.js";
import { runDeterministicCheck } from "./deterministic.js";

const JUDGE_TYPES = new Set<Check["type"]>(["judge_output", "judge_trajectory", "judge_equivalence"]);

/**
 * Runs one judge check. Implementations live in checks/judge.ts (TKAI-331);
 * the runner wires one in when a grading model is available.
 */
export type JudgeRunner = (
  check: JudgeCheck,
  trajectory: Trajectory,
  baseline: Trajectory | undefined,
) => Promise<CheckResult>;

export interface CheckContext {
  /** Baseline trajectory for `judge_equivalence`. */
  baseline?: Trajectory;
  /** Judge handler; absent → judge checks fail with a configuration detail. */
  judge?: JudgeRunner;
}

function isJudgeCheck(check: Check): check is JudgeCheck {
  return JUDGE_TYPES.has(check.type);
}

/** Run one check of any type against a trajectory. */
export async function runCheck(
  check: Check,
  trajectory: Trajectory,
  ctx: CheckContext = {},
): Promise<CheckResult> {
  if (isJudgeCheck(check)) {
    if (ctx.judge === undefined) {
      return {
        check,
        pass: false,
        detail: `${check.type} needs a judge model. Configure the judge in the runner (TKAI-331).`,
      };
    }
    return ctx.judge(check, trajectory, ctx.baseline);
  }
  return runDeterministicCheck(check, trajectory);
}

/** Run every check of a case and return results in case order. */
export async function runChecks(
  checks: Check[],
  trajectory: Trajectory,
  ctx: CheckContext = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check, trajectory, ctx));
  }
  return results;
}
