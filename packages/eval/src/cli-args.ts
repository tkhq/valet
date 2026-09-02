/**
 * CLI argument parsing and case filtering (TKAI-333), separated from
 * `cli.ts` so tests can exercise them without running the suite.
 */
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "./types.js";

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
  baselinesDir: string;
  /** Pull thumbs-rated sessions into the corpus instead of running cases. */
  pullFlagged: boolean;
  /** Rating to pull with --pull-flagged. Default positive. */
  pullRating: "positive" | "negative";
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
    },
  });
  const pullRating = values.rating ?? "positive";
  if (pullRating !== "positive" && pullRating !== "negative") {
    throw new Error(`--rating must be "positive" or "negative", got \`${values.rating}\``);
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
    casesDir: resolve(values.cases ?? resolve(REPO_ROOT, "evals/cases")),
    baselinesDir: resolve(values.baselines ?? resolve(REPO_ROOT, "evals/baselines")),
    pullFlagged: values["pull-flagged"],
    pullRating,
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
