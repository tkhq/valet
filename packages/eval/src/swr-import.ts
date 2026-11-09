/**
 * Import a subset of SWR-Bench as `pull_request` eval cases: one YAML per
 * PR in evals/cases/swr-bench.
 *
 *   pnpm --filter @valet/eval import:swr [--swr <checkout>] [--out <dir>] [--planted 60] [--clean 20]
 *
 * SWR-Bench (Zeng et al., Peking University; arXiv 2509.01494, FSE 2026;
 * MIT; github.com/ZZR0/SWRench at SWR_SHA) holds 1,000 real PRs from 12
 * Python projects. 500 carry defects that a human reviewer raised and the
 * author then fixed; 500 are clean. Each defect has a category: F.* for a
 * functional defect, E.* for maintainability or style.
 *
 * Mapping:
 * - head is the last commit before the first human review (`pr_commits`).
 * - Each F.* change is a golden comment with category `bug`, so it counts
 *   toward recall. Each E.* change is a golden comment with category
 *   `style`: matching it is not a false positive, but it does not count
 *   toward recall (Martian's core profile treats style the same way).
 * - Golden text is the dataset's `discussion_summary`, the text its own
 *   judge matches against, with reviewer handles replaced by role words.
 *   The PR body gets the same scrub, and its @mentions become @user.
 * - A clean PR becomes a `kind: control` case with no golden comments.
 *
 * Subset: planted PRs with at least one F.* change, clean PRs, both capped
 * at MAX_DIFF_LINES, spread round-robin over the 12 repos, newest first.
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

export const SWR_REPO = "https://github.com/ZZR0/SWRench.git";
export const SWR_SHA = "67ae1d4395ac05f800d62b0e13678eadeb9fa5c7";
const DATA_FILE = "data/swr_datasets_d5c5.jsonl";
/** Larger PRs exceed one review's diff budget and dominate run cost. */
const MAX_DIFF_LINES = 1_500;

interface SwrChange {
  change_type: string;
  change_discussion: { discussion_summary: string };
}

interface SwrCommit {
  sha: string;
  diff_text: string;
}

export interface SwrInstance {
  repo: string;
  instance_id: string;
  pr_title: string;
  pr_statement: string;
  change_introduced: boolean;
  base_commit: string;
  created_at: string;
  changes: SwrChange[];
  pr_commits: SwrCommit[];
}

const ROLE = String.raw`(?:[Rr]eviewers?|[Aa]uthors?|[Mm]aintainers?|[Cc]ontributors?|[Uu]sers?|[Cc]ommenters?|[Dd]evelopers?|[Ss]ubmitters?|[Cc]ommitters?|[Cc]ore devs?)`;

/**
 * Replace GitHub handles in a summary with role words. `handles` holds the
 * backticked tokens the dataset ties to a person. Right after a role word
 * ("The author (`x`)") a token is always a handle. Elsewhere a token that
 * also appears in the case's own diff is code, not a handle, and stays.
 */
export function scrubHandles(text: string, handles: ReadonlySet<string>, diff: string): string {
  const escape = (p: string): string => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const everyone = [...handles].map(escape).join("|");
  const people = [...handles].filter((h) => !diff.includes(h)).map(escape).join("|");
  let out = text;
  if (everyone.length > 0) {
    out = out
      .replace(new RegExp(String.raw`(${ROLE})\s*\(\s*@?\`(?:${everyone})\`\s*\)`, "g"), "$1")
      .replace(new RegExp(String.raw`(${ROLE})\s+@?\`(?:${everyone})\``, "g"), "$1");
  }
  if (people.length > 0) {
    out = out
      .replace(new RegExp(String.raw`\s*\(\s*@?\`(?:${people})\`(?:,\s*[^)]*)?\)`, "g"), "")
      .replace(new RegExp(String.raw`@?\`(?:${people})\``, "g"), "a participant")
      // Summaries sometimes name a handle without backticks.
      .replace(new RegExp(String.raw`(?<![\w/.\`-])@?(?:${people})(?![\w/\`-])`, "g"), "a participant");
  }
  return out.replace(/\s*\(a participant\)/g, "");
}

/** Backticked tokens that summaries tie to a person: after a role word, before a timestamp, or before a speech verb. */
export function collectHandles(summaries: string[]): Set<string> {
  const handles = new Set<string>();
  const add = (re: RegExp, t: string): void => {
    for (const m of t.matchAll(re)) handles.add(m[1]);
  };
  for (const t of summaries) {
    add(new RegExp(String.raw`(?:${ROLE}|[Aa]nd|[Bb]y)\s*\(?\s*@?\`([A-Za-z0-9-]{2,39})\``, "g"), t);
    add(/`([A-Za-z0-9-]{2,39})`,\s*\d{4}-\d\d-\d\d/g, t);
    add(/`([A-Za-z0-9-]{2,39})`\s+(?:suggested|pointed|noted|asked|commented|replied|agreed|proposed|mentioned|questioned|raised|requested|confirmed)/g, t);
  }
  return handles;
}

function diffLines(x: SwrInstance): number {
  return x.pr_commits.reduce((n, c) => n + c.diff_text.split("\n").length, 0);
}

/** Round-robin over repos, newest PR first in each, until `count` are picked. */
export function spreadPick(pool: SwrInstance[], count: number): SwrInstance[] {
  const byRepo = new Map<string, SwrInstance[]>();
  for (const x of [...pool].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    byRepo.set(x.repo, [...(byRepo.get(x.repo) ?? []), x]);
  }
  const queues = [...byRepo.keys()].sort().map((k) => byRepo.get(k) ?? []);
  const picked: SwrInstance[] = [];
  while (picked.length < count && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next !== undefined && picked.length < count) picked.push(next);
    }
  }
  return picked;
}

export function selectSubset(all: SwrInstance[], planted: number, clean: number): SwrInstance[] {
  const small = all.filter((x) => x.pr_commits.length > 0 && diffLines(x) <= MAX_DIFF_LINES);
  const withDefect = small.filter((x) => x.change_introduced && x.changes.some((c) => c.change_type.startsWith("F.")));
  const cleanPool = small.filter((x) => !x.change_introduced && x.changes.length === 0);
  return [...spreadPick(withDefect, planted), ...spreadPick(cleanPool, clean)];
}

export function toCase(x: SwrInstance, handles: ReadonlySet<string>): Record<string, unknown> {
  const head = x.pr_commits[x.pr_commits.length - 1].sha;
  const diff = x.pr_commits.map((c) => c.diff_text).join("\n");
  const number = /-(\d+)$/.exec(x.instance_id)?.[1];
  const golden: GoldenComment[] = x.changes.map((c) => ({
    comment: scrubHandles(c.change_discussion.discussion_summary, handles, diff),
    category: c.change_type.startsWith("F.") ? "bug" : "style",
    severity: c.change_type,
  }));
  const kind = x.change_introduced ? "planted" : "control";
  return {
    id: `swr-${x.instance_id.replace(/__/g, "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`,
    description: `${x.pr_title} (https://github.com/${x.repo}/pull/${number ?? "?"}, ${kind})`,
    timeout_ms: 1_200_000,
    pull_request: {
      repo: x.repo.replace("/", "-"),
      remote: `https://github.com/${x.repo}.git`,
      base: x.base_commit,
      head,
      title: x.pr_title,
      body: scrubHandles(x.pr_statement, handles, diff).replace(/(?<![\w.])@[A-Za-z0-9-]{2,39}(?![\w.(-])/g, "@user"),
    },
    checks: [{ type: "review_match", kind, golden }],
  };
}

async function swrCheckout(path: string | undefined): Promise<string> {
  if (path !== undefined) return path;
  const dir = await mkdtemp(join(tmpdir(), "swr-bench-"));
  await run("git", ["clone", "--quiet", SWR_REPO, dir]);
  await run("git", ["checkout", "--quiet", SWR_SHA], { cwd: dir });
  return dir;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { swr: { type: "string" }, out: { type: "string" }, planted: { type: "string" }, clean: { type: "string" } },
  });
  const dir = await swrCheckout(values.swr);
  const dataPath = join(dir, DATA_FILE);
  if (!existsSync(dataPath)) throw new Error(`${dataPath} not found. Pass --swr with a checkout of ${SWR_REPO} at ${SWR_SHA}.`);
  const all = (await readFile(dataPath, "utf8"))
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SwrInstance);
  const handles = collectHandles(all.flatMap((x) => x.changes.map((c) => c.change_discussion.discussion_summary)));
  const subset = selectSubset(all, Number(values.planted ?? 60), Number(values.clean ?? 20));
  const outDir = resolve(REPO_ROOT, values.out ?? "evals/cases/swr-bench");
  await mkdir(outDir, { recursive: true });
  const header = [
    "# Generated by packages/eval/src/swr-import.ts. Do not edit by hand.",
    `# Source: SWR-Bench (MIT), ${SWR_REPO} @ ${SWR_SHA.slice(0, 7)}.`,
  ].join("\n");
  for (const x of subset) {
    const doc = toCase(x, handles);
    await writeFile(join(outDir, `${String(doc.id)}.yaml`), `${header}\n${stringify(doc, { lineWidth: 0 })}`);
  }
  console.error(`[swr] wrote ${subset.length} cases to ${outDir}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
