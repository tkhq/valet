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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPlugins } from "@valet/api/plugins";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { loadCases } from "./case-loader.js";
import { filterCases, parseCliArgs } from "./cli-args.js";
import { buildJudgeRunner } from "./checks/judge.js";
import { dockerAvailable, loadEvalCredentials } from "./integration.js";
import { pullFlagged } from "./pull-flagged.js";
import { formatScorecard } from "./scorecard.js";
import { runSuite } from "./suite.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main(): Promise<number> {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.pullFlagged) {
    // Reads the database directly. On PGlite, the api must be stopped first
    // (single-owner data dir) — run `make dev-stop` before pulling.
    const dataDir = process.env.VALET_DATA_DIR ?? join(homedir(), ".valet");
    const result = await pullFlagged({
      ...(process.env.DATABASE_URL !== undefined ? { databaseUrl: process.env.DATABASE_URL } : {}),
      pgDataDir: resolve(dataDir, "pg"),
      rating: opts.pullRating,
      baselinesDir: opts.baselinesDir,
    });
    process.stdout.write(
      result.files.length > 0
        ? `pulled ${result.files.length} ${opts.pullRating}-rated session(s):\n${result.files.join("\n")}\n`
        : `no ${opts.pullRating}-rated sessions found. Rate sessions with 👍/👎 in the web UI first.\n`,
    );
    return 0;
  }

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

  const credentials = await loadEvalCredentials({ envFilePath: resolve(REPO_ROOT, ".env.eval") });
  const needsDocker = cases.some((c) => c.profile === "full");
  const hasDocker = needsDocker ? await dockerAvailable() : false;

  const result = await runSuite(cases, {
    model: opts.model,
    baselinesDir: opts.baselinesDir,
    judge: buildJudgeRunner(),
    mockPlugins: bundledPlugins,
    realPlugins: bundledPlugins,
    credentials,
    dockerAvailable: hasDocker,
    fullSandboxProvider: () => new DockerSandboxProvider(),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    saveBaselines: opts.saveBaseline,
    onCaseStart: (evalCase, index, total) => {
      if (!opts.json) console.error(`[eval] (${index + 1}/${total}) ${evalCase.id}`);
    },
  });

  const failed = result.entries.filter((e) => e.status === "fail").length;

  const out: string[] = [];
  if (opts.json) {
    out.push(
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
    out.push(formatScorecard(result.entries, { comparisons: result.comparisons, wallMs: result.wallMs }));
    if (result.savedBaselinePaths.length > 0) {
      out.push(`\nsaved ${result.savedBaselinePaths.length} baseline(s) to ${opts.baselinesDir}`);
    }
    if (opts.verbose) {
      for (const entry of result.entries) {
        if (entry.trajectory === undefined) continue;
        out.push(`\n--- trajectory: ${entry.caseId} ---`);
        out.push(JSON.stringify(entry.trajectory, null, 2));
      }
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);

  return failed > 0 ? 1 : 0;
}

/**
 * Exit only after stdout drains: sandbox providers and engine sessions can
 * hold live handles, so the process must exit explicitly — but a bare
 * process.exit truncates piped stdout and eats the scorecard.
 */
function exitAfterFlush(code: number): void {
  if (process.stdout.writableLength === 0) {
    process.exit(code);
  } else {
    process.stdout.once("drain", () => process.exit(code));
    // Backstop: never hang on a stalled pipe.
    setTimeout(() => process.exit(code), 2_000).unref();
  }
}

main().then(
  (code) => exitAfterFlush(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    exitAfterFlush(1);
  },
);
