/**
 * One commit that creates or updates one or more files on a branch, through
 * the Git Data API (blob → tree → commit → update ref).
 *
 * WHY the Git Data API and not the contents endpoint
 * (`PUT /repos/{owner}/{repo}/contents/{path}`): the contents endpoint writes
 * ONE file per call and each call is its own commit. An agent that writes a
 * document plus an index plus a test writes three files, so the contents
 * endpoint gives three commits, and GitHub rejects concurrent writes to the
 * same repository, so those three calls must also run one after another. A
 * failure part way through leaves a branch that carries some of the change
 * set and looks finished. Rewriting that away is a force push, which this
 * package does not do, so the only repair is more commits.
 *
 * The Git Data API has one commit point. The blobs, the tree, and the commit
 * are all created BEFORE any branch points at them, and
 * `PATCH /repos/{owner}/{repo}/git/refs/heads/<branch>` is what makes them
 * reachable. A failure before that step leaves objects that no branch, no
 * commit list, no diff, and no pull request shows. Nothing needs a revert.
 * (GitHub documents no schedule for removing unreferenced objects, so the
 * claim here is only that they are unreferenced, not that they are deleted.)
 *
 * The request count is also flat: six requests for any number of text files,
 * against two or three per file.
 *
 * The branch update is never forced. `PATCH .../git/refs` without `force`
 * accepts only a fast-forward, so a branch that moved after this action read
 * its head rejects the update instead of dropping the other commit.
 */
import type { Octokit } from "octokit";

/**
 * Files in one commit. A change set larger than this is a repository import
 * rather than an agent edit, and the inline tree body grows with it.
 */
export const MAX_COMMIT_FILES = 100;

/**
 * Total decoded content in one commit. GitHub answers an oversized request
 * body with a status that explains nothing, so the cap is enforced here
 * where the message can say what to do about it.
 */
export const MAX_COMMIT_CONTENT_BYTES = 5_000_000;

/**
 * Git file modes this action writes. Octokit types the tree entry `mode` as
 * a closed set, so the two modes are literal types and not plain strings.
 */
export type FileMode = "100644" | "100755";

/** Regular file. Used for every path this action creates. */
const MODE_FILE: FileMode = "100644";
/** Executable file. Preserved when the path already has it. */
const MODE_EXECUTABLE: FileMode = "100755";

export type CommitFileEncoding = "utf-8" | "base64";

export interface CommitFileInput {
  path: string;
  content: string;
  encoding?: CommitFileEncoding;
  /**
   * Blob SHA the caller last read for this path. Present means "replace the
   * file I read"; absent means "create a file that is not there yet".
   */
  expectedSha?: string;
}

export interface CommitFilesInput {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: CommitFileInput[];
  allowDefaultBranch?: boolean;
}

export interface CommittedFile {
  path: string;
  status: "created" | "updated";
  /** Blob SHA after the commit. Pass it back as `expectedSha` to edit again. */
  sha: string;
}

export interface CommitFilesSuccess {
  ok: true;
  commitSha: string;
  commitUrl: string;
  parentSha: string;
  treeSha: string;
  files: CommittedFile[];
}

export interface CommitFilesFailure {
  ok: false;
  /** Text for the caller. Every one of these names the corrective action. */
  error: string;
}

export type CommitFilesOutcome = CommitFilesSuccess | CommitFilesFailure;

/** What one path looks like on the branch this commit is built on. */
export type ExistingPath =
  | { kind: "blob"; sha: string; mode: string }
  | { kind: "other"; description: string };

export interface PlannedFile {
  path: string;
  mode: FileMode;
  status: "created" | "updated";
  content: string;
  encoding: CommitFileEncoding;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function fail(error: string): CommitFilesFailure {
  return { ok: false, error };
}

/** Whitespace is legal inside a base64 payload; the length check ignores it. */
const BASE64_BODY = /^[A-Za-z0-9+/\s]*={0,2}$/;

function isBase64(value: string): boolean {
  if (!BASE64_BODY.test(value)) return false;
  return value.replace(/\s/g, "").length % 4 === 0;
}

/**
 * Rejects a path Git itself cannot hold, before any request goes out. A tree
 * entry path is relative to the repository root and holds no `.` or `..`
 * segment, and `.git` is reserved.
 */
function pathProblem(path: string): string | null {
  if (path.length === 0) return "the path is empty";
  if (path.startsWith("/")) return "the path starts with a slash — make it relative to the repository root";
  if (path.endsWith("/")) return "the path ends with a slash, so it names a directory and not a file";
  const segments = path.split("/");
  if (segments.some((s) => s === "")) return "the path holds an empty segment";
  if (segments.some((s) => s === "." || s === "..")) return 'the path holds a "." or ".." segment';
  if (segments[0] === ".git") return '".git" is reserved by Git';
  return null;
}

/**
 * Rejects a branch name Git itself refuses, before any request goes out.
 *
 * This is a security check and not only a convenience one. The two git-data
 * routes expand the branch with the RFC-6570 `{+branch}` form, so the value
 * reaches the URL unencoded — that is what lets `feat/notes` route as a
 * path and not as one escaped segment. The URL parser then removes `.` and
 * `..` segments, so a name such as `../heads/main` addresses a DIFFERENT
 * ref than the name the default-branch guard compared. Refusing the name is
 * what keeps the guard, the head read, and the ref update on one branch.
 *
 * The rules below are `git check-ref-format`, plus `%` and `#`. Git accepts
 * those two in a ref name, but `%` starts a percent escape and `#` starts a
 * fragment, so both make the URL parser read a different path.
 */
function branchProblem(branch: string): string | null {
  // A code-point scan rather than a regex: a control character written into
  // a character class is invisible in the source and easy to break later.
  for (const char of branch) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return "it holds a space or a control character";
  }
  if (/[~^:?*[\\]/.test(branch)) return "it holds one of the characters ~ ^ : ? * [ \\";
  if (/[%#]/.test(branch)) return 'it holds "%" or "#", which change how the address is read';
  if (branch.includes("..")) return 'it holds ".."';
  if (branch.includes("@{")) return 'it holds "@{"';
  if (branch === "@") return 'a branch cannot be named "@"';
  if (branch.endsWith(".")) return 'it ends with "."';
  const segments = branch.split("/");
  if (segments.some((s) => s === "")) return "it holds an empty path segment";
  if (segments.some((s) => s.startsWith("."))) return 'a path segment starts with "."';
  if (segments.some((s) => s.endsWith(".lock"))) return 'a path segment ends with ".lock"';
  return null;
}

/**
 * Checks the request on its own, with no view of the repository. Returns the
 * error text, or null when the input is usable.
 */
export function validateInput(input: CommitFilesInput): string | null {
  if (input.branch.trim().length === 0) {
    return "Commit files: no branch given. Name the branch to commit to — this action never picks one for you.";
  }
  const branchIssue = branchProblem(input.branch);
  if (branchIssue !== null) {
    return `Commit files: "${input.branch}" is not a usable branch name — ${branchIssue}. Pass the branch name exactly as github.create_branch made it.`;
  }
  if (input.message.trim().length === 0) {
    return "Commit files: the commit message is empty. Pass a message that says what the change does.";
  }
  if (input.files.length === 0) {
    return "Commit files: no files given. Pass at least one file with a path and content.";
  }
  if (input.files.length > MAX_COMMIT_FILES) {
    return `Commit files: ${input.files.length} files is more than this action commits at once (limit ${MAX_COMMIT_FILES}). Split the change into smaller commits.`;
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of input.files) {
    const problem = pathProblem(file.path);
    if (problem !== null) {
      return `Commit files: cannot write "${file.path}" — ${problem}.`;
    }
    if (seen.has(file.path)) {
      return `Commit files: "${file.path}" is listed twice. One commit writes each path once — merge the two entries into the content you want the file to end with.`;
    }
    seen.add(file.path);

    const encoding = file.encoding ?? "utf-8";
    if (encoding === "base64" && !isBase64(file.content)) {
      return `Commit files: the content for "${file.path}" is marked base64 but is not valid base64. Send text with encoding "utf-8", or base64-encode the bytes.`;
    }
    totalBytes +=
      encoding === "base64"
        ? Math.floor((file.content.replace(/\s/g, "").length * 3) / 4)
        : new TextEncoder().encode(file.content).length;
  }

  if (totalBytes > MAX_COMMIT_CONTENT_BYTES) {
    return `Commit files: the commit carries about ${totalBytes} bytes, over the ${MAX_COMMIT_CONTENT_BYTES} byte limit for one call. Commit the large files separately, or keep them out of Git.`;
  }
  return null;
}

// ─── Planning against what is already on the branch ─────────────────────────

/**
 * Decides create-or-update for each file and reports every conflict at once.
 *
 * The rule both ways round is that the caller must have seen what it
 * replaces. `expectedSha` absent means the caller believes the path is free,
 * so a path that IS taken is a conflict and not an overwrite. `expectedSha`
 * present means the caller read the file, so a blob SHA that moved on is a
 * conflict as well. Reporting every conflicting file together lets a caller
 * repair the whole change set in one more round trip.
 */
export function planFiles(
  input: CommitFilesInput,
  existing: Map<string, ExistingPath>,
): { ok: true; plan: PlannedFile[] } | { ok: false; error: string } {
  const plan: PlannedFile[] = [];
  const conflicts: string[] = [];

  for (const file of input.files) {
    const current = existing.get(file.path);
    const encoding = file.encoding ?? "utf-8";

    if (current !== undefined && current.kind === "other") {
      conflicts.push(
        `"${file.path}" is ${current.description} on this branch, not a regular file. Choose another path.`,
      );
      continue;
    }

    if (file.expectedSha === undefined) {
      if (current === undefined) {
        plan.push({ path: file.path, mode: MODE_FILE, status: "created", content: file.content, encoding });
        continue;
      }
      conflicts.push(
        `"${file.path}" already exists at blob SHA ${current.sha}. Read it with github.read_repo_file, fold your change into what is there, then pass expectedSha "${current.sha}" for that file.`,
      );
      continue;
    }

    if (current === undefined) {
      conflicts.push(
        `"${file.path}" has no file on this branch, so expectedSha "${file.expectedSha}" matches nothing. Drop expectedSha for that file to create it, or correct the path.`,
      );
      continue;
    }

    if (current.sha !== file.expectedSha) {
      conflicts.push(
        `"${file.path}" is now at blob SHA ${current.sha}, not the ${file.expectedSha} you passed. Somebody changed the file after you read it. Read it again with github.read_repo_file, apply your change to the new content, then pass expectedSha "${current.sha}".`,
      );
      continue;
    }

    plan.push({
      path: file.path,
      // Keep the executable bit. Writing a shell script back as 100644 makes
      // it stop running, and nothing in the request says to change the mode.
      mode: current.mode === MODE_EXECUTABLE ? MODE_EXECUTABLE : MODE_FILE,
      status: "updated",
      content: file.content,
      encoding,
    });
  }

  if (conflicts.length > 0) {
    const head =
      conflicts.length === 1
        ? "Commit files: nothing was committed."
        : `Commit files: nothing was committed. ${conflicts.length} files conflict.`;
    return { ok: false, error: `${head} ${conflicts.join(" ")}` };
  }
  return { ok: true, plan };
}

// ─── Reading untyped responses ──────────────────────────────────────────────

/**
 * A branch name holds slashes (`feat/github-writes`), and Octokit's typed
 * ref routes percent-encode the whole `{ref}` value into one path segment.
 * The `{+branch}` form expands the slash as a slash, which is the path
 * GitHub routes on. It also expands `.` and `%` unchanged, so `branchProblem`
 * above refuses the names that would make the URL parser address a different
 * ref than the one the guards checked. Those two routes are outside Octokit's
 * typed route table, so their bodies arrive untyped and the readers below are
 * the only place that decides what came back.
 */
function readRefSha(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  // Narrowing an unknown body from the API: `typeof === "object"` cannot
  // express indexability in TS, so the record cast is the read seam.
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== "object" || object === null) return null;
  const sha = (object as Record<string, unknown>).sha;
  return typeof sha === "string" ? sha : null;
}

// ─── The commit ─────────────────────────────────────────────────────────────

/** Describes a tree entry that is not a regular file, for the conflict text. */
function describeEntry(type: string, mode: string): string {
  if (type === "tree") return "a directory";
  if (type === "commit") return "a submodule";
  if (mode === "120000") return "a symbolic link";
  return `a ${type} entry`;
}

/**
 * Creates one commit on `input.branch` and moves the branch to it.
 *
 * Order matters. The default-branch guard and every conflict check run
 * before the first object is created, so a rejected request writes nothing
 * at all.
 */
export async function commitFiles(
  octokit: Octokit,
  input: CommitFilesInput,
): Promise<CommitFilesOutcome> {
  const inputProblem = validateInput(input);
  if (inputProblem !== null) return fail(inputProblem);

  const slug = `${input.owner}/${input.repo}`;

  // 1. The default-branch guard. An agent that meant to write to its feature
  // branch and landed on the default branch is the worst outcome here, so
  // the default branch needs the caller to opt in for that repository.
  let defaultBranch: string;
  try {
    const { data: repository } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: input.owner,
      repo: input.repo,
    });
    defaultBranch = repository.default_branch;
  } catch (err) {
    if (isStatus(err, 404)) {
      // GitHub answers 404 for a repository the token cannot see as well as
      // for one that is not there, and a write needs more access than a
      // read, so the message offers both fixes.
      return fail(
        `Commit files: ${slug} is not there, or the connected GitHub account cannot see it. Correct the owner and the repo name, or give that account write access to the repository.`,
      );
    }
    throw err;
  }
  if (input.branch === defaultBranch && input.allowDefaultBranch !== true) {
    return fail(
      `Commit files: "${input.branch}" is the default branch of ${slug}, and this action does not write it by accident. Commit to a feature branch and open a pull request with github.create_pull_request, or set allowDefaultBranch to true if writing the default branch is what you mean.`,
    );
  }

  // 2. Head of the branch. This SHA becomes the parent of the new commit and
  // the fast-forward base for the ref update at the end.
  let parentSha: string | null;
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/heads/{+branch}",
      { owner: input.owner, repo: input.repo, branch: input.branch },
    );
    parentSha = readRefSha(response.data);
  } catch (err) {
    if (isStatus(err, 404)) {
      return fail(
        `Commit files: ${slug} has no branch "${input.branch}". Create it with github.create_branch first, or name a branch that is already there.`,
      );
    }
    throw err;
  }
  if (parentSha === null) {
    return fail(
      `Commit files: GitHub did not report a head commit for "${input.branch}" in ${slug}. Try the action again.`,
    );
  }

  // 3. What the branch holds today: the base tree to build on, and the blob
  // SHA and file mode of every target path.
  const { data: baseTree } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { owner: input.owner, repo: input.repo, tree_sha: parentSha, recursive: "1" },
  );
  const wanted = new Set(input.files.map((f) => f.path));
  const existing = new Map<string, ExistingPath>();
  for (const entry of baseTree.tree) {
    if (entry.path === undefined || !wanted.has(entry.path)) continue;
    const type = entry.type ?? "";
    const mode = entry.mode ?? "";
    if (type === "blob" && mode !== "120000" && entry.sha !== undefined) {
      existing.set(entry.path, { kind: "blob", sha: entry.sha, mode });
    } else {
      existing.set(entry.path, { kind: "other", description: describeEntry(type, mode) });
    }
  }
  if (baseTree.truncated) {
    // A truncated listing proves what it shows and nothing about what it
    // leaves out, so a path missing from it may still hold a file. Writing
    // anyway would overwrite content this action never read.
    const unproven = input.files.map((f) => f.path).filter((p) => !existing.has(p));
    if (unproven.length > 0) {
      return fail(
        `Commit files: GitHub truncated the file listing for ${slug} at branch "${input.branch}", so this action cannot tell whether ${unproven.join(", ")} already exist, and it does not overwrite what it has not read. Commit to this repository with the git CLI instead.`,
      );
    }
  }

  const planned = planFiles(input, existing);
  if (!planned.ok) return fail(planned.error);

  // 4. Blobs for content that is not utf-8 text. A tree entry writes inline
  // `content` as utf-8, so bytes have to become a blob first.
  const treeEntries: Array<{
    path: string;
    mode: FileMode;
    type: "blob";
    content?: string;
    sha?: string;
  }> = [];
  for (const file of planned.plan) {
    if (file.encoding === "base64") {
      const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner: input.owner,
        repo: input.repo,
        content: file.content,
        encoding: "base64",
      });
      treeEntries.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
    } else {
      treeEntries.push({ path: file.path, mode: file.mode, type: "blob", content: file.content });
    }
  }

  // 5. The new tree. `base_tree` carries every path this commit does not
  // name; without it the commit would delete the rest of the repository.
  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: input.owner,
    repo: input.repo,
    base_tree: baseTree.sha,
    tree: treeEntries,
  });

  const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: input.owner,
    repo: input.repo,
    message: input.message,
    tree: newTree.sha,
    parents: [parentSha],
  });

  // 6. The one commit point. No `force`, so GitHub accepts this only while
  // the branch still points at the commit read in step 2. Everything above
  // is unreferenced until this succeeds.
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/{+branch}", {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      sha: commit.sha,
      force: false,
    });
  } catch (err) {
    const moved = await headMovedTo(octokit, input, parentSha);
    if (moved !== null) {
      return fail(
        `Commit files: branch "${input.branch}" moved from ${parentSha} to ${moved} while this commit was being prepared, so GitHub refused the update. Nothing was committed and the branch is unchanged. Read the files again with github.read_repo_file and run this action again with the new blob SHAs.`,
      );
    }
    throw err;
  }

  const shaByPath = new Map<string, string>();
  for (const entry of newTree.tree) {
    if (entry.path !== undefined && entry.sha !== undefined) shaByPath.set(entry.path, entry.sha);
  }

  return {
    ok: true,
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    parentSha,
    treeSha: newTree.sha,
    files: planned.plan.map((file) => ({
      path: file.path,
      status: file.status,
      sha: shaByPath.get(file.path) ?? "",
    })),
  };
}

/** Octokit puts the response status on the thrown error, so no cast is needed. */
function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === status;
}

/**
 * The head the branch carries now, when it is no longer the one the commit
 * was built on. GitHub does not document which status a rejected
 * non-fast-forward update returns, so the branch is re-read and compared
 * rather than the status code being read as a cause.
 */
async function headMovedTo(
  octokit: Octokit,
  input: CommitFilesInput,
  parentSha: string,
): Promise<string | null> {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/heads/{+branch}",
      { owner: input.owner, repo: input.repo, branch: input.branch },
    );
    const head = readRefSha(response.data);
    return head !== null && head !== parentSha ? head : null;
  } catch {
    return null;
  }
}
