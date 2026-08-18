/**
 * Files-changed projection (V1 port #4).
 *
 * V1 served `GET /sessions/:id/files-changed` from a sandbox that was always
 * up. V2 does not need the sandbox to answer the same question, because the
 * engine already runs the git command and keeps the result: when a
 * submission settles, `capturePatch` (packages/engine/src/patch-capture.ts)
 * runs `git diff <startRef>` inside the sandbox and writes the unified diff
 * to the blob store under `patches/{sessionId}/{queueItemId}.diff`. The
 * queue item keeps the blob key.
 *
 * So this module parses stored diffs. It never touches a sandbox, which is
 * what makes it testable and what makes it answer for a session whose
 * sandbox has since been released.
 *
 * The limit is honest and named on the wire: the capture only happens for a
 * session that has a start ref, which means a session with a repository.
 * For an assistant session with no clone there is nothing to diff, and the
 * route says that rather than showing an empty table.
 */
import type { ChangedFile, FilesChangedResponse, FilesChangedUnavailable } from "../wire/types.js";

/** A file's counts while the parser accumulates them. */
interface Accumulator {
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
}

/**
 * Strips one of git's `a/` or `b/` path prefixes. `git diff` writes them on
 * every header line; `/dev/null` has no prefix and means the file did not
 * exist on that side.
 */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/**
 * Unquotes a path from a `diff --git` header. Git quotes a path that holds a
 * space or a non-ASCII byte, and the quoted form uses C escapes.
 */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
  const body = path.slice(1, -1);
  return body.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
}

/**
 * Splits a `diff --git a/x b/y` header into its two paths.
 *
 * The naive split on " b/" is wrong for a path that itself contains " b/",
 * so this walks candidate split points and takes the one where both halves
 * carry their expected prefix. A header we cannot split returns null and the
 * `+++`/`---` lines that follow supply the path instead.
 */
function parseGitHeaderPaths(rest: string): { from: string; to: string } | null {
  if (rest.startsWith('"')) {
    // Quoted first path: it ends at the first unescaped closing quote.
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "\\") i += 2;
      else if (rest[i] === '"') break;
      else i += 1;
    }
    if (i >= rest.length) return null;
    const from = unquote(rest.slice(0, i + 1));
    const to = unquote(rest.slice(i + 2));
    return { from: stripPrefix(from), to: stripPrefix(to) };
  }
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== " ") continue;
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if ((left.startsWith("a/") || left === "/dev/null") && (right.startsWith("b/") || right === "/dev/null")) {
      return { from: stripPrefix(left), to: stripPrefix(right) };
    }
  }
  return null;
}

function emptyAccumulator(path: string): Accumulator {
  return { path, additions: 0, deletions: 0, added: false, deleted: false, renamed: false, binary: false };
}

function statusOf(acc: Accumulator): ChangedFile["status"] {
  if (acc.renamed) return "renamed";
  if (acc.added) return "added";
  if (acc.deleted) return "deleted";
  return "modified";
}

/** Lines still to read on each side of the hunk being parsed. */
interface HunkBudget {
  old: number;
  new: number;
}

/**
 * Reads the two line budgets out of a hunk header.
 *
 * `@@ -a,b +c,d @@` says the hunk covers b lines of the old file and d of
 * the new one. Git omits the count for a side that spans one line
 * (`@@ -1 +1,3 @@`), which means 1.
 *
 * The budgets are what makes the parse correct. A prefix alone cannot say
 * whether `--- x` is the header pair or a deleted line whose own text is
 * `-- x`, and both occur: `-- ` starts a SQL comment, and this repository
 * edits `.sql` migrations in place.
 */
export function parseHunkHeader(line: string): HunkBudget | null {
  const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  return {
    old: match[1] === undefined ? 1 : Number(match[1]),
    new: match[2] === undefined ? 1 : Number(match[2]),
  };
}

/**
 * Reads one line of hunk content and charges it to the budget.
 *
 * Returns false for a line that cannot be hunk content, which means the
 * hunk ended before its header promised — a truncated diff. The caller then
 * leaves the hunk and reads the line as structure.
 */
function consumeHunkLine(line: string, budget: HunkBudget, current: Accumulator | undefined): boolean {
  const marker = line[0];
  // "\ No newline at end of file" annotates the line above it and counts
  // against neither side.
  if (marker === "\\") return true;
  if (marker === "+") {
    if (current) current.additions += 1;
    budget.new = Math.max(0, budget.new - 1);
    return true;
  }
  if (marker === "-") {
    if (current) current.deletions += 1;
    budget.old = Math.max(0, budget.old - 1);
    return true;
  }
  // A context line carries one leading space. An empty string is a context
  // line for an empty source line whose trailing space was stripped in
  // transit, so it is read the same way.
  if (marker === " " || marker === undefined) {
    budget.old = Math.max(0, budget.old - 1);
    budget.new = Math.max(0, budget.new - 1);
    return true;
  }
  return false;
}

/**
 * Parses one unified diff into per-file counts.
 *
 * Counting rule: each hunk header declares how many lines it covers on each
 * side, and exactly that many lines are read as content. Only outside those
 * budgets is a line read as structure. Driving the parse off the budgets
 * rather than off the line prefix is what makes the counts agree with `git
 * diff --numstat`: a deleted `-- sql comment` reaches the parser as `--- sql
 * comment` and an added `++ i;` as `+++ i;`, and a prefix test alone would
 * take both for the `---`/`+++` header pair.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files = new Map<string, Accumulator>();
  let current: Accumulator | undefined;
  let budget: HunkBudget | null = null;

  for (const line of diff.split("\n")) {
    // Content first. Inside a hunk's declared budget every line belongs to
    // the file's body, whatever it starts with.
    if (budget !== null && (budget.old > 0 || budget.new > 0)) {
      if (consumeHunkLine(line, budget, current)) continue;
      budget = null;
    }
    if (line.startsWith("diff --git ")) {
      const paths = parseGitHeaderPaths(line.slice("diff --git ".length));
      // A header whose paths we cannot read still opens a file; the `+++`
      // line below names it. Until then `current` stays undefined so no
      // counts are attributed to the previous file.
      current = undefined;
      budget = null;
      if (paths) {
        const path = paths.to === "/dev/null" ? paths.from : paths.to;
        const existing = files.get(path);
        current = existing ?? emptyAccumulator(path);
        if (paths.to === "/dev/null") current.deleted = true;
        if (paths.from === "/dev/null") current.added = true;
        files.set(path, current);
      }
      continue;
    }
    if (current === undefined && !line.startsWith("--- ") && !line.startsWith("+++ ")) continue;

    if (line.startsWith("rename from ")) {
      if (current) {
        current.renamed = true;
        current.previousPath = unquote(line.slice("rename from ".length));
      }
      continue;
    }
    if (line.startsWith("rename to ")) {
      if (current) current.renamed = true;
      continue;
    }
    if (line.startsWith("new file mode")) {
      if (current) current.added = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      if (current) current.deleted = true;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      if (current) current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const from = stripPrefix(unquote(line.slice(4).split("\t")[0] ?? ""));
      if (current && from === "/dev/null") current.added = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const to = stripPrefix(unquote(line.slice(4).split("\t")[0] ?? ""));
      if (current === undefined && to !== "/dev/null" && to !== "") {
        const existing = files.get(to);
        current = existing ?? emptyAccumulator(to);
        files.set(to, current);
      }
      if (current && to === "/dev/null") current.deleted = true;
      budget = null;
      continue;
    }
    if (line.startsWith("@@")) {
      // An unreadable hunk header leaves the budget null, so the hunk's
      // lines fall through as structure and are not counted. That drops
      // counts rather than inventing them.
      budget = parseHunkHeader(line);
      continue;
    }
  }

  return [...files.values()].map((acc) => ({
    path: acc.path,
    ...(acc.previousPath !== undefined ? { previousPath: acc.previousPath } : {}),
    additions: acc.additions,
    deletions: acc.deletions,
    status: statusOf(acc),
    binary: acc.binary,
  }));
}

/**
 * Merges the per-submission diffs into one list for the session.
 *
 * Each stored patch is a diff of the WHOLE workspace against the session's
 * start ref, not a delta since the previous patch. So the newest patch
 * already holds the session's total change, and merging is last-one-wins per
 * file rather than a sum — summing would multiply every line by the number
 * of turns that touched it.
 *
 * `patches` must be ordered oldest first. A file that appears in an older
 * patch and not in the newest one was reverted, so it is dropped.
 */
export function mergePatches(patches: readonly string[]): ChangedFile[] {
  const newest = patches.at(-1);
  if (newest === undefined) return [];
  return parseUnifiedDiff(newest).sort((a, b) => a.path.localeCompare(b.path));
}

/** The sentence shown in place of an empty table, per reason. */
const UNAVAILABLE_MESSAGE: Readonly<Record<FilesChangedUnavailable, string>> = {
  no_repository:
    "This session has no repository, so there are no file changes to show. Start a session on a repository to see them.",
  // Said only when the session HAS a repository bound to it. The engine
  // captures the start-ref best-effort during the clone step and never
  // retries, so a repo-bound session can carry `no_start_ref` forever — and
  // every session created before start-ref capture landed does. Telling
  // that reader "this session has no repository" denies a fact its own
  // configuration contradicts.
  repository_unreadable:
    "The engine recorded no start point for this session's repository, so it cannot compare the files. Replace the sandbox to try again, or start a new session on the repository.",
  no_patches_yet:
    "No file changes yet. The list fills in when the agent completes its first message in this session.",
  capture_failed:
    "The engine could not read the file changes for this session. Open the Terminal tab and run `git status` to see the workspace.",
  storage_unavailable:
    "File-change storage is not configured on this deployment. Ask an administrator to configure the blob store.",
};

/**
 * The sentence shown above a file list that a later turn has outrun.
 *
 * It names the action, because the reader can take one: the list is right
 * for the turn it came from, and a fresh sandbox makes the next turn
 * capture again.
 */
const STALE_MESSAGE =
  "The latest turn did not record its file changes, so this list is from an earlier turn. Replace the sandbox to capture the current changes.";

/** Builds the response body, including the totals and the reason line. */
export function buildFilesChangedResponse(opts: {
  files: ChangedFile[];
  unavailable?: FilesChangedUnavailable;
  truncated: boolean;
  capturedAt?: number;
  stale?: boolean;
}): FilesChangedResponse {
  const { files, unavailable, truncated, capturedAt, stale } = opts;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return {
    files,
    additions,
    deletions,
    truncated,
    ...(capturedAt !== undefined ? { capturedAt } : {}),
    ...(stale === true ? { stale: true, staleMessage: STALE_MESSAGE } : {}),
    ...(unavailable !== undefined
      ? { unavailable, unavailableMessage: UNAVAILABLE_MESSAGE[unavailable] }
      : {}),
  };
}
