/**
 * Import Martian Code Review Bench's offline set as `pull_request` eval
 * cases: one YAML per PR in evals/cases/code-review.
 *
 *   pnpm --filter @valet/eval import:martian [--martian <checkout>] [--out <dir>]
 *
 * Source: github.com/withmartian/code-review-benchmark (MIT) at MARTIAN_SHA.
 * Without --martian the script clones it into a temp directory. Each case
 * gets the PR's base and head commits (read from one of Martian's public
 * fork PRs, so we never open PRs of our own), the golden comments, and the
 * published results of the reference tools under the Sonnet 4.5 judge.
 * Needs the `gh` CLI signed in to GitHub.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { stringify } from "yaml";
import type { GoldenComment } from "./types.js";

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const MARTIAN_REPO = "https://github.com/withmartian/code-review-benchmark.git";
export const MARTIAN_SHA = "e616e849755441da38f18bf3adba2c9583b03803";
/** Martian folder of published judgments that match DEFAULT_REVIEW_JUDGE_MODEL. */
const JUDGE_RESULTS = "anthropic_claude-sonnet-4-5-20250929";
/** Reference tools copied into each case: the current version of each vendor Martian lists. */
const REFERENCE_TOOLS = ["cubic-v2", "qodo-v2", "augment", "greptile-v5", "coderabbit", "copilot-v2", "bugbot", "devin", "claude-code"];

const FORK_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;
const PR_NUMBER_RE = /__PR(\d+)__/;

interface BenchmarkEntry {
  pr_title: string;
  source_repo: string;
  golden_comments: GoldenComment[];
  reviews: { tool: string; pr_url: string }[];
}

interface ToolEval {
  skipped?: boolean;
  errors_count?: number;
  true_positives: { golden_comment: string }[];
  fp: number;
}

async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function martianCheckout(path: string | undefined): Promise<string> {
  if (path !== undefined) {
    const head = (await sh("git", ["rev-parse", "HEAD"], path)).trim();
    if (head !== MARTIAN_SHA) throw new Error(`${path} is at ${head}. Check out ${MARTIAN_SHA} first.`);
    return path;
  }
  const dir = await mkdtemp(join(tmpdir(), "martian-"));
  await sh("git", ["clone", "--quiet", MARTIAN_REPO, dir]);
  await sh("git", ["checkout", "--quiet", MARTIAN_SHA], dir);
  return dir;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { martian: { type: "string" }, out: { type: "string" } } });
  const martian = await martianCheckout(values.martian);
  const out = resolve(REPO_ROOT, values.out ?? "evals/cases/code-review");
  await mkdir(out, { recursive: true });

  const offline = join(martian, "offline");
  const data = JSON.parse(await readFile(join(offline, "results/benchmark_data.json"), "utf8")) as Record<string, BenchmarkEntry>;
  const evalsPath = join(offline, "results", JUDGE_RESULTS, "evaluations.json");
  const evaluations = existsSync(evalsPath)
    ? (JSON.parse(await readFile(evalsPath, "utf8")) as Record<string, Record<string, ToolEval>>)
    : {};

  let written = 0;
  for (const [goldenUrl, entry] of Object.entries(data)) {
    const fork = entry.reviews.map((r) => r.pr_url).find((u) => FORK_URL_RE.test(u) && PR_NUMBER_RE.test(u));
    const [, forkRepo, forkPr] = (fork !== undefined ? FORK_URL_RE.exec(fork) : null) ?? [];
    const upstreamNumber = fork !== undefined ? PR_NUMBER_RE.exec(fork)?.[1] : undefined;
    if (forkRepo === undefined || upstreamNumber === undefined) {
      console.warn(`skip ${goldenUrl}: no fork PR url`);
      continue;
    }
    const source = entry.source_repo.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = `review-${source}-${upstreamNumber}`;
    const pull = JSON.parse(await sh("gh", ["api", `repos/${forkRepo}/pulls/${forkPr}`])) as {
      title: string;
      body: string | null;
      base: { sha: string };
      head: { sha: string };
    };

    const golden = entry.golden_comments.map((g) => ({
      comment: g.comment,
      category: g.category,
      ...(g.severity !== undefined ? { severity: g.severity } : {}),
    }));
    const reference: Record<string, { matched: number[]; fp: number }> = {};
    for (const tool of REFERENCE_TOOLS) {
      const e = evaluations[goldenUrl]?.[tool];
      if (e === undefined || e.skipped === true || (e.errors_count ?? 0) > 0) continue;
      const found = new Set(e.true_positives.map((t) => t.golden_comment));
      reference[tool] = { matched: golden.flatMap((g, i) => (found.has(g.comment) ? [i] : [])), fp: e.fp };
    }

    const doc = {
      id,
      description: `${entry.pr_title} (${goldenUrl})`,
      timeout_ms: 1_200_000,
      pull_request: {
        repo: source,
        remote: `https://github.com/${forkRepo}.git`,
        base: pull.base.sha,
        head: pull.head.sha,
        title: entry.pr_title || pull.title,
        ...(pull.body ? { body: pull.body } : {}),
      },
      checks: [{ type: "review_match", golden, ...(Object.keys(reference).length > 0 ? { reference } : {}) }],
    };
    const header =
      `# Generated by packages/eval/src/martian-import.ts. Do not edit by hand.\n` +
      `# Golden comments and reference results: Martian Code Review Bench (MIT),\n` +
      `# ${MARTIAN_REPO.replace(/\.git$/, "")} @ ${MARTIAN_SHA.slice(0, 7)}.\n`;
    await writeFile(join(out, `${id}.yaml`), header + stringify(doc, { lineWidth: 0 }));
    written++;
    process.stdout.write(`${id} ${pull.base.sha.slice(0, 8)}..${pull.head.sha.slice(0, 8)} golden=${golden.length}\n`);
  }
  console.log(`wrote ${written} cases to ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
