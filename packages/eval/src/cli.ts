/**
 * Eval CLI entry point (TKAI-333). Run via `make eval` or
 * `pnpm --filter @valet/eval start`.
 *
 *   --filter <pattern>   run only cases whose id matches (substring or regex)
 *   --model <spec>       override the default model (case pins still win)
 *   --save-baseline      save trajectories as baselines after the run
 *   --json               JSON output instead of the human-readable scorecard
 *   --verbose            print full trajectories
 *   --timeout <ms>       override the per-case timeout
 *   --cases <dir>        cases directory (default: evals/cases)
 *   --baselines <dir>    baselines directory (default: evals/baselines)
 *
 * Exits 0 when every run case passes, 1 otherwise.
 */
import { loadCases } from "./case-loader.js";
import { filterCases, parseCliArgs } from "./cli-args.js";
import { buildJudgeRunner } from "./checks/judge.js";
import { formatScorecard } from "./scorecard.js";
import { runSuite } from "./suite.js";

async function main(): Promise<number> {
  const opts = parseCliArgs(process.argv.slice(2));
  const allCases = await loadCases(opts.casesDir);
  const cases = filterCases(allCases, opts.filter);
  if (cases.length === 0) {
    console.error(
      opts.filter !== undefined
        ? `no cases match --filter ${opts.filter}. Available: ${allCases.map((c) => c.id).join(", ")}`
        : `no cases found in ${opts.casesDir}. Add case YAML files first.`,
    );
    return 1;
  }

  const result = await runSuite(cases, {
    model: opts.model,
    baselinesDir: opts.baselinesDir,
    judge: buildJudgeRunner(),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    saveBaselines: opts.saveBaseline,
    onCaseStart: (evalCase, index, total) => {
      if (!opts.json) console.error(`[eval] (${index + 1}/${total}) ${evalCase.id}`);
    },
  });

  const failed = result.entries.filter((e) => e.status === "fail").length;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          entries: result.entries.map((e) => (opts.verbose ? e : { ...e, trajectory: undefined })),
          comparisons: result.comparisons,
          wallMs: result.wallMs,
          savedBaselinePaths: result.savedBaselinePaths,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatScorecard(result.entries, { comparisons: result.comparisons, wallMs: result.wallMs }));
    if (result.savedBaselinePaths.length > 0) {
      console.log(`\nsaved ${result.savedBaselinePaths.length} baseline(s) to ${opts.baselinesDir}`);
    }
    if (opts.verbose) {
      for (const entry of result.entries) {
        if (entry.trajectory === undefined) continue;
        console.log(`\n--- trajectory: ${entry.caseId} ---`);
        console.log(JSON.stringify(entry.trajectory, null, 2));
      }
    }
  }

  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
