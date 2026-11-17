/**
 * Turn other reviewers' addressed comments into recall cases for our reviewer.
 *
 *   pnpm --filter @valet/eval review-misses --repo owner/name --since 2026-11-01 \
 *     --ours <login> --other <login> [--other <login>] --out-dir <suite dir> [--window 8]
 *
 * A miss is a comment by another reviewer (a bot or a person) on a merged pull
 * request commit that our reviewer also reviewed, where the author changed the
 * flagged code before the merge (`addressed`, as `review-outcomes` measures
 * it), and our reviewer left no comment on the same file within `--window`
 * lines. Each pull request commit with misses becomes one `pull_request` case
 * at that commit, with the comments as golden comments.
 *
 * `addressed` is a weak label: code can change for other reasons. Read each
 * case before it gates anything, fix the golden text and category by hand,
 * and delete the cases that are not real defects. The command never
 * overwrites a case file, so hand edits stay.
 *
 * `--with-ours` also writes our own addressed comments as `kept-` cases: a
 * regression suite of defects authors fixed after our reviewer raised them.
 * A reviewer change that stops finding them loses real recall.
 *
 * Cases name the repository and quote review comments, so the output
 * directory must be outside this repository. Run the suite with
 * `VALET_EVAL_PRIVATE_CASES` (see the README, "Private suites").
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { collectOutcomes, gh, loginKey, mergedPulls, type OutcomeRow, type PullNode } from "./review-outcomes.js";

/** Default distance in lines within which our comment counts as the same finding. */
export const MISS_WINDOW = 8;
const GOLDEN_CHARS = 600;
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/** The commits (as `repo#number@sha`) that `login` submitted a review on. */
export function reviewedBy(repo: string, pulls: readonly PullNode[], login: string): Set<string> {
  const key = loginKey(login);
  return new Set(pulls.flatMap((p) => p.reviews.nodes.flatMap((r) => (r.author && r.commit && loginKey(r.author.login) === key ? [`${repo}#${p.number}@${r.commit.oid}`] : []))));
}

/**
 * Other reviewers' addressed comments on commits our reviewer also reviewed,
 * with no comment of ours on the same file within `window` lines. A comment
 * on a commit ours never saw (a push before ours was on, a draft) is not a miss.
 */
export function findMisses(rows: readonly OutcomeRow[], opts: { ours: string; reviewed: ReadonlySet<string>; window?: number }): OutcomeRow[] {
  const ours = loginKey(opts.ours);
  const window = opts.window ?? MISS_WINDOW;
  const mine = rows.filter((r) => loginKey(r.bot) === ours);
  return rows.filter((r) =>
    loginKey(r.bot) !== ours
    && r.outcome === "addressed"
    && r.side === "RIGHT"
    && opts.reviewed.has(`${r.repo}#${r.pr}@${r.commit}`)
    && !mine.some((m) => m.repo === r.repo && m.pr === r.pr && m.path === r.path && Math.abs(m.line - r.line) <= window));
}

const ORIGINAL_FINDING = "<details><summary>Original finding</summary>";

/**
 * The finding a comment made. When the reviewer resolved the comment, it
 * rewrote the body to "Fixed in" or "Withdrawn" and kept the finding in an
 * "Original finding" block: read that block, not the resolution note.
 */
export function originalFinding(body: string): string {
  const start = body.indexOf(ORIGINAL_FINDING);
  if (start === -1) return body;
  const inner = body.slice(start + ORIGINAL_FINDING.length);
  const end = inner.lastIndexOf("</details>");
  return end === -1 ? inner : inner.slice(0, end);
}

/** A review comment as plain golden text: no HTML, collapsed details, code blocks or badges. */
export function goldenText(body: string): string {
  const text = originalFinding(body)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<details[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= GOLDEN_CHARS) return text;
  const cut = text.slice(0, GOLDEN_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), GOLDEN_CHARS / 2))}...`;
}

export interface MissGroup {
  repo: string;
  pr: number;
  commit: string;
  rows: OutcomeRow[];
}

/** Our own comments the author addressed: the defects a later reviewer must keep finding. */
export function keptFindings(rows: readonly OutcomeRow[], ours: string): OutcomeRow[] {
  const key = loginKey(ours);
  // A withdrawn finding is one our own recheck refuted: a later edit near its lines does not make it a kept finding.
  return rows.filter((r) => loginKey(r.bot) === key && r.outcome === "addressed" && r.side === "RIGHT" && r.botStatus !== "withdrawn");
}

/**
 * Our own comments people rejected: a thumbs-down, or a thread a person
 * resolved with no code change. A later review should not repeat them. A
 * comment our recheck withdrew is left out: that is the model's judgment, not
 * a person's.
 */
export function rejectedFindings(rows: readonly OutcomeRow[], ours: string): OutcomeRow[] {
  const key = loginKey(ours);
  return rows.filter((r) => loginKey(r.bot) === key && r.outcome === "rejected" && r.side === "RIGHT" && r.botStatus !== "withdrawn");
}

/** Misses grouped by pull request and the commit the comments were made on. */
export function groupMisses(misses: readonly OutcomeRow[]): MissGroup[] {
  const groups = new Map<string, MissGroup>();
  for (const m of misses) {
    const key = `${m.repo}#${m.pr}@${m.commit}`;
    const g = groups.get(key) ?? { repo: m.repo, pr: m.pr, commit: m.commit, rows: [] };
    g.rows.push(m);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export type CasePrefix = "miss" | "kept" | "rejected";

export function missCaseId(g: Pick<MissGroup, "repo" | "pr" | "commit">, prefix: CasePrefix = "miss"): string {
  return `${prefix}-${g.repo.split("/").pop() ?? g.repo}-${g.pr}-${g.commit.slice(0, 7)}`.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * The case document for one group. `base` is the merge base of the pull
 * request base and the group commit. `rejected` rows become the case's
 * `rejected` findings: ones a review at this commit should not repeat.
 */
export function missCase(g: MissGroup, base: string, isPrivate: boolean, prefix: CasePrefix = "miss", rejected: readonly OutcomeRow[] = []): Record<string, unknown> {
  const [first] = [...g.rows, ...rejected];
  const comment = (r: OutcomeRow) => ({
    comment: goldenText(r.body),
    category: r.category ?? "bug",
    ...(SEVERITIES.has(r.severity) ? { severity: r.severity[0]?.toUpperCase() + r.severity.slice(1) } : {}),
  });
  return {
    id: missCaseId(g, prefix),
    description: `${first?.prTitle ?? ""} (https://github.com/${g.repo}/pull/${g.pr}) at the commit ${prefix === "miss" ? "the other reviewers" : "our reviewer"} commented on`,
    timeout_ms: 1_200_000,
    pull_request: {
      repo: g.repo.replace("/", "-"),
      remote: `https://github.com/${g.repo}.git`,
      base,
      head: g.commit,
      title: first?.prTitle ?? "",
      number: g.pr,
      private: isPrivate,
    },
    checks: [{
      type: "review_match",
      golden: g.rows.map(comment),
      ...(rejected.length > 0 ? { rejected: rejected.map(comment) } : {}),
    }],
  };
}

function caseHeader(g: MissGroup, prefix: CasePrefix, rejected: readonly OutcomeRow[] = []): string {
  const lead = {
    kept: "# Kept: our reviewer's comments the author addressed. A later reviewer must keep finding them.",
    miss: "# A miss: other reviewers' comments the author addressed, where our reviewer left none nearby.",
    rejected: "# Rejected: our reviewer's comments people rejected. A later review should not repeat them.",
  }[prefix];
  return [
    lead,
    "# Generated by review-misses. Check each golden comment, its category and severity, before this case gates anything.",
    ...g.rows.map((r) => `# ${r.bot}: https://github.com/${r.repo}/pull/${r.pr}#discussion_r${r.commentId}`),
    ...rejected.map((r) => `# rejected, ${r.bot}: https://github.com/${r.repo}/pull/${r.pr}#discussion_r${r.commentId}`),
  ].join("\n");
}

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Whether `dir` is inside this repository's working tree. */
export function insideRepo(dir: string, root = REPO_ROOT): boolean {
  const rel = relative(resolve(root), resolve(dir));
  // `..cases` is a directory inside the repository; only `..` itself or a `../` prefix leaves it.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", multiple: true },
      since: { type: "string" },
      ours: { type: "string" },
      other: { type: "string", multiple: true },
      "out-dir": { type: "string" },
      window: { type: "string" },
      "with-ours": { type: "boolean" },
      "with-rejected": { type: "boolean" },
    },
  });
  const { repo: repos, since, ours, other } = values;
  const outDir = values["out-dir"];
  if (!repos?.length || !since || !ours || !other?.length || !outDir) {
    throw new Error("Usage: review-misses --repo owner/name --since YYYY-MM-DD --ours <login> --other <login> --out-dir <dir> [--window 8] [--with-ours] [--with-rejected]");
  }
  if (insideRepo(outDir)) throw new Error(`--out-dir ${outDir} is inside this repository. Cases quote review comments: write them outside the repository.`);
  const window = values.window === undefined ? MISS_WINDOW : Number(values.window);
  if (!Number.isInteger(window) || window < 0) throw new Error("--window must be a whole number of lines");
  await mkdir(outDir, { recursive: true });

  for (const repo of repos) {
    const pulls = await mergedPulls(repo, since);
    const rows = await collectOutcomes(repo, since, [ours, ...other], pulls);
    const reviewed = reviewedBy(repo, pulls, ours);
    const misses = findMisses(rows, { ours, reviewed, window });
    const isPrivate = (await gh(["api", `repos/${repo}`, "--jq", ".private"])).trim() === "true";
    const byNumber = new Map(pulls.map((p) => [p.number, p]));
    let written = 0;
    const kept = values["with-ours"] ? keptFindings(rows, ours) : [];
    // Rejected findings ride on the kept case at the same commit, or make a case of their own.
    const rejectedRows = values["with-rejected"] ? rejectedFindings(rows, ours) : [];
    const rejectedBy = new Map(groupMisses(rejectedRows).map((g) => [`${g.repo}#${g.pr}@${g.commit}`, g]));
    const keptGroups = groupMisses(kept);
    const keptKeys = new Set(keptGroups.map((g) => `${g.repo}#${g.pr}@${g.commit}`));
    const groups: { g: MissGroup; prefix: CasePrefix; rejected: OutcomeRow[] }[] = [
      ...groupMisses(misses).map((g) => ({ g, prefix: "miss" as const, rejected: [] })),
      ...keptGroups.map((g) => ({ g, prefix: "kept" as const, rejected: rejectedBy.get(`${g.repo}#${g.pr}@${g.commit}`)?.rows ?? [] })),
      ...[...rejectedBy.entries()].filter(([k]) => !keptKeys.has(k)).map(([, g]) => ({ g: { ...g, rows: [] }, prefix: "rejected" as const, rejected: g.rows })),
    ];
    for (const { g, prefix, rejected } of groups) {
      const file = join(outDir, `${missCaseId(g, prefix)}.yaml`);
      if (existsSync(file)) {
        // Keep a case someone may have edited, but say when it lacks rejected findings this run found.
        if (rejected.length > 0 && !(await readFile(file, "utf8")).includes("rejected:")) {
          console.warn(`${file} exists without the ${rejected.length} rejected finding(s) this run found. Delete it and run again to add them.`);
        }
        continue;
      }
      const baseRef = byNumber.get(g.pr)?.baseRefOid ?? [...g.rows, ...rejected][0]?.base ?? "";
      const base = (await gh(["api", `repos/${repo}/compare/${baseRef}...${g.commit}`, "--jq", ".merge_base_commit.sha"])).trim();
      await writeFile(file, `${caseHeader(g, prefix, rejected)}\n${stringify(missCase(g, base, isPrivate, prefix, rejected), { lineWidth: 0 })}`);
      written++;
    }
    const addressed = rows.filter((r) => loginKey(r.bot) !== loginKey(ours) && r.outcome === "addressed").length;
    console.log(`${repo}: ${reviewed.size} commit(s) we reviewed; ${addressed} addressed comment(s) by other reviewers; ${misses.length} miss(es)${values["with-ours"] ? `; ${kept.length} kept finding(s) of ours` : ""}${values["with-rejected"] ? `; ${rejectedRows.length} rejected finding(s) of ours` : ""}; ${written} new case(s)`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
