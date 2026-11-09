/**
 * CLI argument parsing and case filtering (TKAI-333), separated from
 * `cli.ts` so tests can exercise them without running the suite.
 */
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrivateCases } from "./private-pull-request.js";
import { REASONING_LEVELS, type EvalCase, type ReasoningLevel } from "./types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

export interface CliOptions {
  filter?: string;
  model: string;
  saveBaseline: boolean;
  json: boolean;
  verbose: boolean;
  timeoutMs?: number;
  casesDir: string;
  /** `--cases private:<suite>` whose suite is not on this machine: why the run SKIPs. */
  casesSkip?: string;
  baselinesDir: string;
  /** Pull thumbs-rated sessions into the corpus instead of running cases. */
  pullFlagged: boolean;
  /** Rating to pull with --pull-flagged. Default positive. */
  pullRating: "positive" | "negative";
  /** Override every case's `runs` (pass@k sample count). */
  runsOverride?: number;
  /** Permit saving integration/full baselines (live API responses). */
  allowLiveBaselines: boolean;
  /** Prune baselines instead of running: keep this many per case+model. */
  pruneBaselinesKeep?: number;
  /** Suite-level reasoning effort for the model under test. */
  reasoning?: ReasoningLevel;
  /** Cases in flight at once. */
  concurrency?: number;
  /** provider/model for code-review verifiers. Unset: the model under test. */
  verifyModel?: string;
  /** Code-review verification on or off for every case. Unset: each case's `pull_request.verify`. */
  verify?: boolean;
  /** Independent code-review passes per case. */
  reviewPasses?: number;
  /** Drop code-review findings rated below this confidence (0-1). */
  minConfidence?: number;
}

/** Parse argv (no process side effects; throws on invalid input). */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      filter: { type: "string" },
      model: { type: "string" },
      "save-baseline": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      timeout: { type: "string" },
      cases: { type: "string" },
      baselines: { type: "string" },
      "pull-flagged": { type: "boolean", default: false },
      rating: { type: "string" },
      runs: { type: "string" },
      "allow-live-baselines": { type: "boolean", default: false },
      "prune-baselines": { type: "string" },
      reasoning: { type: "string" },
      concurrency: { type: "string" },
      "verify-model": { type: "string" },
      verify: { type: "boolean", default: false },
      "review-passes": { type: "string" },
      "min-confidence": { type: "string" },
    },
  });
  const reasoning = values.reasoning;
  if (reasoning !== undefined && !(REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new Error(`--reasoning must be one of ${REASONING_LEVELS.join(", ")}, got \`${reasoning}\``);
  }
  let pruneBaselinesKeep: number | undefined;
  if (values["prune-baselines"] !== undefined) {
    pruneBaselinesKeep = Number.parseInt(values["prune-baselines"], 10);
    if (!Number.isInteger(pruneBaselinesKeep) || pruneBaselinesKeep < 1) {
      throw new Error(`--prune-baselines must be a positive integer (records to keep), got \`${values["prune-baselines"]}\``);
    }
  }
  let runsOverride: number | undefined;
  if (values.runs !== undefined) {
    runsOverride = Number.parseInt(values.runs, 10);
    if (!Number.isInteger(runsOverride) || runsOverride < 1 || runsOverride > 25) {
      throw new Error(`--runs must be an integer from 1 to 25, got \`${values.runs}\``);
    }
  }
  let reviewPasses: number | undefined;
  if (values["review-passes"] !== undefined) {
    reviewPasses = Number.parseInt(values["review-passes"], 10);
    if (!Number.isInteger(reviewPasses) || reviewPasses < 1 || reviewPasses > 5) {
      throw new Error(`--review-passes must be an integer from 1 to 5, got \`${values["review-passes"]}\``);
    }
  }
  let minConfidence: number | undefined;
  if (values["min-confidence"] !== undefined) {
    minConfidence = Number(values["min-confidence"]);
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new Error(`--min-confidence must be a number from 0 to 1, got \`${values["min-confidence"]}\``);
    }
  }
  const pullRating = values.rating ?? "positive";
  if (pullRating !== "positive" && pullRating !== "negative") {
    throw new Error(`--rating must be "positive" or "negative", got \`${values.rating}\``);
  }
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    concurrency = Number.parseInt(values.concurrency, 10);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error(`--concurrency must be an integer from 1 to 32, got \`${values.concurrency}\``);
    }
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number.parseInt(values.timeout, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`--timeout must be a positive integer of milliseconds, got \`${values.timeout}\``);
    }
  }
  return {
    ...(values.filter !== undefined ? { filter: values.filter } : {}),
    model: values.model ?? DEFAULT_MODEL,
    saveBaseline: values["save-baseline"],
    json: values.json,
    verbose: values.verbose,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    // Relative paths resolve against the repo root, not the process cwd:
    // `make eval` runs the CLI through pnpm with cwd packages/eval, so a
    // documented flag like `--cases evals/cases/hard` must not resolve there.
    ...privateCasesOrDir(values.cases ?? "evals/cases"),
    baselinesDir: resolve(REPO_ROOT, values.baselines ?? "evals/baselines"),
    pullFlagged: values["pull-flagged"],
    pullRating,
    ...(runsOverride !== undefined ? { runsOverride } : {}),
    allowLiveBaselines: values["allow-live-baselines"],
    ...(pruneBaselinesKeep !== undefined ? { pruneBaselinesKeep } : {}),
    ...(reasoning !== undefined ? { reasoning: reasoning as ReasoningLevel } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(values["verify-model"] !== undefined ? { verifyModel: values["verify-model"] } : {}),
    ...(values.verify ? { verify: true } : {}),
    ...(reviewPasses !== undefined ? { reviewPasses } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
  };
}

/** Filter cases by id: substring match, or regex when the pattern compiles. */
export function filterCases(cases: EvalCase[], pattern: string | undefined): EvalCase[] {
  if (pattern === undefined) return cases;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern);
  } catch {
    re = null;
  }
  return cases.filter((c) => c.id.includes(pattern) || (re !== null && re.test(c.id)));
}

/** `--cases private:<suite>` reads the suite from VALET_EVAL_PRIVATE_CASES; other values are repo-relative paths. */
function privateCasesOrDir(cases: string): { casesDir: string; casesSkip?: string } {
  const p = resolvePrivateCases(cases);
  if (p === undefined) return { casesDir: resolve(REPO_ROOT, cases) };
  return "dir" in p ? { casesDir: p.dir } : { casesDir: "", casesSkip: p.skip };
}
