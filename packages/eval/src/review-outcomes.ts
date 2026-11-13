/**
 * Measure what happened to review comments: for each bot comment on a merged
 * pull request, did the author change the flagged code before the merge?
 *
 *   pnpm --filter @valet/eval review-outcomes --repo owner/name --since 2026-11-01 \
 *     --bot <login> [--bot <login>] [--out outcomes.jsonl]
 *
 * The measure needs no labels. A comment is `addressed` when the lines it
 * flagged (two lines of context each side) are gone from the file at the
 * merged head. It is `rejected` when the code stayed and a person showed
 * disagreement: a thumbs-down, or a thread a person resolved, or a
 * withdrawal by the reviewer itself. Every other comment is `ignored`. The
 * address rate is addressed comments over all rated comments.
 *
 * A changed line is not proof that the comment was right: a refactor can
 * move code for other reasons. Use the rate to compare reviewers and
 * reviewer versions on the same pull requests, not as a precision score.
 *
 * Each output row also carries the pull request title, description, base and
 * the comment's commit, so a verifier replay can use the rows as labeled
 * cases. Rows from private repositories stay on the machine that made them.
 * Needs the `gh` CLI signed in with read access to the repository.
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { parseFindings } from "@valet/plugin-pr-review";

const run = promisify(execFile);

/** Lines of context on each side of the flagged line. */
export const FLAG_RADIUS = 2;

export type CodeChange = "changed" | "unchanged" | "unknown";
export type Outcome = "addressed" | "rejected" | "ignored" | "unknown";

export interface CommentFacts {
  changed: CodeChange;
  /** The reviewer marked its own comment fixed or withdrawn. */
  botStatus?: "fixed" | "withdrawn";
  /** A person other than the bot resolved the thread. */
  resolvedByPerson: boolean;
  thumbsUp: number;
  thumbsDown: number;
  replies: number;
}

export interface OutcomeRow extends CommentFacts {
  repo: string;
  pr: number;
  prTitle: string;
  prBody: string;
  base: string;
  /** The PR head at merge. */
  mergedHead: string;
  bot: string;
  commentId: number;
  /** The commit the comment was made on. */
  commit: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: string;
  category?: string;
  title?: string;
  body: string;
  outcome: Outcome;
}

/** The flagged lines with their context, or undefined when the line is not in the file. */
export function flaggedWindow(text: string, line: number, radius = FLAG_RADIUS): string[] | undefined {
  const lines = text.split("\n").map((l) => l.trimEnd());
  if (line < 1 || line > lines.length) return undefined;
  return lines.slice(Math.max(0, line - 1 - radius), Math.min(lines.length, line + radius));
}

/**
 * Whether the flagged code changed between the comment's commit and the merged head.
 * The window may move: a block found anywhere in the merged file is unchanged.
 */
export function codeChange(before: string | undefined, after: string | undefined, line: number): CodeChange {
  if (before === undefined) return "unknown";
  const window = flaggedWindow(before, line);
  if (window === undefined) return "unknown";
  if (after === undefined) return "changed";
  const lines = after.split("\n").map((l) => l.trimEnd());
  for (let i = 0; i + window.length <= lines.length; i++) {
    if (window.every((w, j) => lines[i + j] === w)) return "unchanged";
  }
  return "changed";
}

export function botStatus(body: string): CommentFacts["botStatus"] {
  if (body.startsWith("**Fixed in ")) return "fixed";
  if (body.startsWith("**Withdrawn.**")) return "withdrawn";
  return undefined;
}

export function classifyOutcome(f: CommentFacts): Outcome {
  if (f.changed === "changed") return "addressed";
  if (f.changed === "unknown") return "unknown";
  if (f.thumbsDown > 0 || f.resolvedByPerson || f.botStatus === "withdrawn") return "rejected";
  return "ignored";
}

export interface OutcomeSummary {
  bot: string;
  severity: string;
  comments: number;
  addressed: number;
  rejected: number;
  ignored: number;
  unknown: number;
  /** addressed / (comments - unknown) */
  addressRate: number;
}

export function summarizeOutcomes(rows: readonly OutcomeRow[]): OutcomeSummary[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) {
    for (const key of [`${r.bot}\u0000all`, `${r.bot}\u0000${r.severity}`]) groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [bot = "", severity = ""] = key.split("\u0000");
    const count = (o: Outcome) => rs.filter((r) => r.outcome === o).length;
    const rated = rs.length - count("unknown");
    return {
      bot, severity, comments: rs.length,
      addressed: count("addressed"), rejected: count("rejected"), ignored: count("ignored"), unknown: count("unknown"),
      addressRate: rated === 0 ? 0 : count("addressed") / rated,
    };
  }).sort((a, b) => a.bot.localeCompare(b.bot) || SEVERITY_RANK(a.severity) - SEVERITY_RANK(b.severity));
}

const SEVERITY_RANK = (s: string): number => ["all", "critical", "high", "medium", "low", "unrated"].indexOf(s);

/** The severity, category and title of a Valet finding comment; other bots are unrated. */
export function findingFields(body: string): Pick<OutcomeRow, "severity" | "category" | "title"> {
  const [f] = parseFindings(body).values();
  return f ? { severity: f.severity, category: f.category, title: f.title } : { severity: "unrated" };
}

interface ThreadNode {
  isResolved: boolean;
  resolvedBy: { login: string } | null;
  diffSide: "LEFT" | "RIGHT";
  comments: {
    nodes: {
      databaseId: number;
      author: { login: string } | null;
      body: string;
      path: string;
      originalLine: number | null;
      originalCommit: { oid: string } | null;
      reactionGroups: { content: string; users: { totalCount: number } }[];
    }[];
  };
}

interface PullNode {
  number: number;
  title: string;
  body: string;
  baseRefOid: string;
  headRefOid: string;
  reviewThreads: { nodes: ThreadNode[] };
}

const PULLS_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title body baseRefOid headRefOid
      reviewThreads(first: 100) { nodes {
        isResolved resolvedBy { login } diffSide
        comments(first: 30) { nodes {
          databaseId author { login } body path originalLine originalCommit { oid }
          reactionGroups { content users { totalCount } }
        } }
      } }
    } }
  }
}`;

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function mergedPulls(repo: string, since: string): Promise<PullNode[]> {
  const out: PullNode[] = [];
  let after: string | undefined;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${PULLS_QUERY}`, "-f", `q=repo:${repo} is:pr is:merged merged:>=${since}`];
    if (after) args.push("-f", `after=${after}`);
    const page = JSON.parse(await gh(args)) as { data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PullNode[] } } };
    out.push(...page.data.search.nodes.filter((n) => typeof n.number === "number"));
    if (!page.data.search.pageInfo.hasNextPage) return out;
    after = page.data.search.pageInfo.endCursor;
  }
}

/** Whether a failed `gh api` read means the file is not at that ref, as opposed to a read that failed. */
export function notFound(err: unknown): boolean {
  const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
  const text = err instanceof Error ? `${err.message}\n${stderr}` : String(err);
  return /HTTP 404|Not Found/.test(text);
}

/** Reads a file at a ref: its text, undefined when the file is not there, or a rejection when the read failed. */
function fileReader(repo: string): (path: string, ref: string) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  return (path, ref) => {
    const key = `${ref}:${path}`;
    let hit = cache.get(key);
    if (!hit) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      hit = gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${encoded}?ref=${ref}`]).catch((err: unknown) => {
        if (notFound(err)) return undefined;
        throw err;
      });
      cache.set(key, hit);
    }
    return hit;
  };
}

/** GitHub shows an app as `name` when it writes and as `name[bot]` when it resolves a thread. */
export function loginKey(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

export async function collectOutcomes(repo: string, since: string, bots: readonly string[]): Promise<OutcomeRow[]> {
  const read = fileReader(repo);
  const botSet = new Set(bots.map(loginKey));
  const rows: OutcomeRow[] = [];
  for (const pr of await mergedPulls(repo, since)) {
    for (const t of pr.reviewThreads.nodes) {
      const [root, ...rest] = t.comments.nodes;
      const bot = root?.author?.login;
      if (!root || !bot || !botSet.has(loginKey(bot)) || root.originalLine === null || !root.originalCommit) continue;
      const commit = root.originalCommit.oid;
      const line = root.originalLine;
      // A read that fails (rate limit, network) leaves the outcome unknown; only a file missing at the merged head counts as a change.
      const changed: CodeChange = t.diffSide === "LEFT"
        ? "unknown"
        : await Promise.all([read(root.path, commit), read(root.path, pr.headRefOid)]).then(
          ([before, after]) => codeChange(before, after, line),
          () => "unknown" as const,
        );
      const reactions = (content: string) => root.reactionGroups.find((g) => g.content === content)?.users.totalCount ?? 0;
      const facts: CommentFacts = {
        changed,
        ...(botStatus(root.body) ? { botStatus: botStatus(root.body) } : {}),
        resolvedByPerson: t.isResolved && t.resolvedBy !== null && !botSet.has(loginKey(t.resolvedBy.login)),
        thumbsUp: reactions("THUMBS_UP"),
        thumbsDown: reactions("THUMBS_DOWN"),
        replies: rest.filter((c) => c.author && !botSet.has(loginKey(c.author.login))).length,
      };
      rows.push({
        repo, pr: pr.number, prTitle: pr.title, prBody: pr.body, base: pr.baseRefOid, mergedHead: pr.headRefOid,
        bot, commentId: root.databaseId, commit, path: root.path, line: root.originalLine, side: t.diffSide,
        ...findingFields(root.body), body: root.body, ...facts, outcome: classifyOutcome(facts),
      });
    }
  }
  return rows;
}

export function formatSummary(summary: readonly OutcomeSummary[]): string {
  const head = "bot\tseverity\tcomments\taddressed\trejected\tignored\tunknown\taddress rate";
  return [head, ...summary.map((s) => [s.bot, s.severity, s.comments, s.addressed, s.rejected, s.ignored, s.unknown, `${Math.round(s.addressRate * 100)}%`].join("\t"))].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", multiple: true },
      since: { type: "string" },
      bot: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  if (!values.repo?.length || !values.since || !values.bot?.length) {
    throw new Error("Usage: review-outcomes --repo owner/name --since YYYY-MM-DD --bot <login> [--out file.jsonl]");
  }
  const rows: OutcomeRow[] = [];
  for (const repo of values.repo) {
    const got = await collectOutcomes(repo, values.since, values.bot);
    console.error(`[outcomes] ${repo}: ${got.length} comment(s)`);
    rows.push(...got);
  }
  if (values.out) await writeFile(values.out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(formatSummary(summarizeOutcomes(rows)));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
