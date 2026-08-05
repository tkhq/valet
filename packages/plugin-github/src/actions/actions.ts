import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import { Octokit } from "octokit";
import { parseJobLog } from "./parse-job-log.js";
import {
  collectDirectoryEntries,
  contentsKind,
  wrongPathKindError,
  MAX_DIRECTORY_ENTRIES,
} from "./repo-directory.js";
import { resolveGithubApiUrl } from "./api.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getOctokit(ctx: PluginActionContext): Promise<Octokit> {
  const cred = await ctx.credentials.get();
  const token = cred?.accessToken;
  if (!token) {
    throw new Error(
      "Missing GitHub access token. Connect the GitHub integration in Settings.",
    );
  }
  return new Octokit({ auth: token, baseUrl: resolveGithubApiUrl() });
}

const PERMISSION_HINTS: Record<string, string> = {
  "github.list_workflow_runs": "actions:read",
  "github.get_workflow_run": "actions:read + checks:read",
  "github.get_job_logs": "actions:read",
  "github.rerun_workflow": "actions:write",
  "github.cancel_workflow_run": "actions:write",
  "github.list_workflows": "actions:read",
  "github.trigger_workflow": "actions:write",
  "github.create_issue": "issues:write",
  "github.update_issue": "issues:write",
  "github.create_comment": "issues:write",
  "github.create_review": "pull_requests:write",
  "github.create_pull_request": "pull_requests:write",
  "github.update_pull_request": "pull_requests:write",
  "github.merge_pull_request": "pull_requests:write + contents:write",
  "github.create_branch": "contents:write",
  "github.delete_branch": "contents:write",
  "github.create_release": "contents:write",
  "github.inspect_pull_request": "pull_requests:read (+ checks:read for check runs)",
  "github.fork_repository": "contents:write",
  "github.read_repo_file": "contents:read",
  "github.list_repo_directory": "contents:read",
};

function handleOctokitError(
  err: unknown,
  actionId: string,
  operation: string,
): PluginActionResult {
  const e = err as { status?: number; message?: string };
  const status = e.status ?? "unknown";
  const ghMessage = e.message || "";
  if (status === 403) {
    const hint = PERMISSION_HINTS[actionId];
    const permMsg = hint
      ? ` This action likely requires the "${hint}" permission on the GitHub App.`
      : "";
    return {
      success: false,
      error: `${operation}: GitHub returned 403 Forbidden. ${ghMessage}${permMsg}`,
    };
  }
  return { success: false, error: `${operation}: ${status} ${ghMessage}` };
}

/**
 * Curried action builder. The first call binds T from the parameters
 * schema; the second call types `execute`'s args via Static<T>. Splitting
 * the inference into two phases sidesteps TS's contextual-inference depth
 * limit, which otherwise gives up on `args: any` once the file gets long.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (
      args: Static<TParams>,
      ctx: PluginActionContext,
    ) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

// ─── Actions ────────────────────────────────────────────────────────────────

const getRepository = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
  }))({
  id: "github.get_repository",
  name: "Get Repository",
  description: "Get details of a GitHub repository by owner/name",
  riskLevel: "low",
  execute: async ({ owner, repo }, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      return { success: true, data };
    } catch (err) {
      return handleOctokitError(err, "github.get_repository", "Get repository");
    }
  },
});

const listRepos = action(Type.Object({
    scope: Type.Optional(
      Type.Union(
        [Type.Literal("auto"), Type.Literal("user"), Type.Literal("installation")],
        {
          description:
            'Which listing to use: "user" (GET /user/repos — needs a user OAuth credential), ' +
            '"installation" (GET /installation/repositories — the org\'s GitHub App grant), or ' +
            '"auto" (default: try user, fall back to installation on 403).',
        },
      ),
    ),
    sort: Type.Optional(
      Type.Union(
        [
          Type.Literal("created"),
          Type.Literal("updated"),
          Type.Literal("pushed"),
          Type.Literal("full_name"),
        ],
        { description: "Sort field (user scope only — the installation endpoint has no sort)" },
      ),
    ),
    perPage: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Results per page" }),
    ),
    page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number" })),
  }))({
  id: "github.list_repos",
  name: "List Repositories",
  description:
    "List repositories accessible to the authenticated credential — a user OAuth " +
    "credential lists the user's repos; the org's GitHub App installation token lists " +
    "the repos the App was granted.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const scope = args.scope ?? "auto";

    // GET /user/repos is user-token-only; an App installation token gets
    // "403 Resource not accessible by integration" there and must use
    // GET /installation/repositories instead. "auto" makes the tool work
    // regardless of which credential tier resolution handed us.
    async function listInstallation() {
      const { data } = await octokit.request("GET /installation/repositories", {
        per_page: args.perPage,
        page: args.page,
      });
      return { success: true as const, data: data.repositories };
    }

    try {
      if (scope === "installation") return await listInstallation();
      const { data } = await octokit.request("GET /user/repos", {
        sort: args.sort,
        per_page: args.perPage,
        page: args.page,
      });
      return { success: true, data };
    } catch (err) {
      if (scope === "auto" && isForbidden(err)) {
        try {
          return await listInstallation();
        } catch (fallbackErr) {
          return handleOctokitError(fallbackErr, "github.list_repos", "List repos (installation)");
        }
      }
      return handleOctokitError(err, "github.list_repos", "List repos");
    }
  },
});

/** Octokit request errors carry `status`; 403 from /user/repos with an
 * installation token means "wrong endpoint for this credential tier". */
function isForbidden(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 403
  );
}

const getIssue = action(Type.Object({
    owner: Type.String(),
    repo: Type.String(),
    issueNumber: Type.Integer(),
  }))({
  id: "github.get_issue",
  name: "Get Issue",
  description: "Get a specific issue by number",
  riskLevel: "low",
  execute: async ({ owner, repo, issueNumber }, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo, issue_number: issueNumber },
      );
      return { success: true, data };
    } catch (err) {
      return handleOctokitError(err, "github.get_issue", "Get issue");
    }
  },
});

const createIssue = action(Type.Object({
    owner: Type.String(),
    repo: Type.String(),
    title: Type.String(),
    body: Type.Optional(Type.String()),
  }))({
  id: "github.create_issue",
  name: "Create Issue",
  description: "Create a new issue in a repository",
  riskLevel: "medium",
  execute: async ({ owner, repo, title, body }, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request("POST /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        title,
        body: body || undefined,
      });
      return { success: true, data };
    } catch (err) {
      return handleOctokitError(err, "github.create_issue", "Create issue");
    }
  },
});

const getPullRequest = action(Type.Object({
    owner: Type.String(),
    repo: Type.String(),
    pullNumber: Type.Integer(),
  }))({
  id: "github.get_pull_request",
  name: "Get Pull Request",
  description: "Get a specific pull request by number",
  riskLevel: "low",
  execute: async ({ owner, repo, pullNumber }, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo, pull_number: pullNumber },
      );
      return { success: true, data };
    } catch (err) {
      return handleOctokitError(err, "github.get_pull_request", "Get pull request");
    }
  },
});

const createComment = action(Type.Object({
    owner: Type.String(),
    repo: Type.String(),
    issueNumber: Type.Integer(),
    body: Type.String(),
  }))({
  id: "github.create_comment",
  name: "Create Comment",
  description: "Create a comment on an issue or pull request",
  riskLevel: "medium",
  execute: async ({ owner, repo, issueNumber, body }, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: issueNumber, body },
      );
      return { success: true, data };
    } catch (err) {
      return handleOctokitError(err, "github.create_comment", "Create comment");
    }
  },
});

const listPullRequests = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    state: Type.Optional(
      Type.Union(
        [Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
        { description: "PR state filter (default: open)" },
      ),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: "Max results (default: 30, max 100)",
      }),
    ),
  }))({
  id: "github.list_pull_requests",
  name: "List Pull Requests",
  description: "List pull requests for a repository with optional state filter",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const state = args.state || "open";
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    try {
      const { data: pulls } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner: args.owner,
        repo: args.repo,
        state,
        sort: "updated",
        direction: "desc",
        per_page: limit,
      });
      return {
        success: true,
        data: pulls.map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          user: pr.user?.login,
          url: pr.html_url,
          draft: pr.draft,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          head: pr.head?.ref,
          base: pr.base?.ref,
        })),
      };
    } catch (err) {
      return handleOctokitError(err, "github.list_pull_requests", "List pull requests");
    }
  },
});

/** GitHub caps `per_page` at 100 on every list endpoint. A larger value is
 * silently clamped, so a single request can never return more than 100 files. */
const GITHUB_MAX_PER_PAGE = 100;

/** Default byte budget for the patches of one inspect call. 64 KiB is a few
 * thousand diff lines — large enough for a normal review, small enough to
 * leave room in an LLM prompt for the instructions and the reply. */
const PATCH_BYTES_DEFAULT = 65536;

const textEncoder = new TextEncoder();

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/** One entry of `GET /pulls/{n}/files`. `patch` is absent for binary files and
 * for files whose diff GitHub considers too large. */
interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Reads up to `limit` files, in pages of at most 100. The old single request
 * asked for `per_page: filesLimit`, so any limit above 100 returned 100 files
 * and the caller could not tell. A short file list makes `matched_file_count`
 * too low, which makes a workflow gate skip a pull request it should review.
 */
async function fetchPullRequestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  limit: number,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (let page = 1; files.length < limit; page++) {
    const perPage = Math.min(GITHUB_MAX_PER_PAGE, limit - files.length);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: pullNumber, per_page: perPage, page },
    );
    for (const file of data) {
      files.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      });
    }
    if (data.length < perPage) break;
  }
  return files;
}

/** Cuts a patch at the last whole line that fits in `budgetBytes`. Cutting on a
 * line boundary keeps every retained diff line readable and cannot split a
 * multi-byte character. */
function truncatePatch(patch: string, budgetBytes: number): { text: string; bytes: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of patch.split("\n")) {
    const cost = byteLength(line) + 1;
    if (used + cost > budgetBytes) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) return { text: "", bytes: 0 };
  return { text: kept.join("\n") + "\n", bytes: used };
}

interface InspectedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /** The patch is a prefix of the real diff. */
  patch_truncated?: true;
  /** Why this file has no patch. */
  patch_omitted?: "byte_budget" | "not_provided_by_github";
}

interface PatchSummary {
  limit_bytes: number;
  included_bytes: number;
  truncated_files: number;
  omitted_files: number;
}

/** Spends `limitBytes` on patches in file order and records every cut, so a
 * reader never mistakes a shortened diff for the whole one. */
function attachPatches(
  files: PullRequestFile[],
  limitBytes: number,
): { files: InspectedFile[]; summary: PatchSummary } {
  let remaining = limitBytes;
  let truncatedFiles = 0;
  let omittedFiles = 0;

  const withPatches = files.map((file): InspectedFile => {
    const base = {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    };
    if (file.patch === undefined) {
      omittedFiles++;
      return { ...base, patch_omitted: "not_provided_by_github" };
    }
    const size = byteLength(file.patch);
    if (size <= remaining) {
      remaining -= size;
      return { ...base, patch: file.patch };
    }
    const { text, bytes } = truncatePatch(file.patch, remaining);
    if (bytes === 0) {
      omittedFiles++;
      return { ...base, patch_omitted: "byte_budget" };
    }
    remaining -= bytes;
    truncatedFiles++;
    return {
      ...base,
      patch: `${text}[... patch truncated at the ${limitBytes}-byte budget: ${size - bytes} of ${size} bytes omitted. Raise patchBytesLimit or narrow pathPrefixes to see the rest ...]`,
      patch_truncated: true,
    };
  });

  return {
    files: withPatches,
    summary: {
      limit_bytes: limitBytes,
      included_bytes: limitBytes - remaining,
      truncated_files: truncatedFiles,
      omitted_files: omittedFiles,
    },
  };
}

const inspectPullRequest = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    pullNumber: Type.Integer({ description: "Pull request number" }),
    filesLimit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 300, description: "Max files (default: 100)" }),
    ),
    commentsLimit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 300, description: "Max review comments (default: 100)" }),
    ),
    includePatch: Type.Optional(
      Type.Boolean({
        description:
          "Include each file's unified diff in the `patch` field (default: false). " +
          "Needed to review the code itself; costs prompt space.",
      }),
    ),
    patchBytesLimit: Type.Optional(
      Type.Integer({
        minimum: 1024,
        maximum: 1048576,
        description:
          "Total byte budget for all patches (default: 65536). Files are filled in order. " +
          "Every cut is reported in `patch_truncated`, `patch_omitted`, and `patch_summary`.",
      }),
    ),
    pathPrefixes: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Keep only files whose path starts with one of these prefixes. " +
          'End a prefix with "/" to scope to a folder exactly — "source/rest" also matches ' +
          '"source/restore.go". The count of kept files is returned as `matched_file_count`.',
      }),
    ),
  }))({
  id: "github.inspect_pull_request",
  name: "Inspect Pull Request",
  description:
    "Get detailed PR info including files changed, review comments, and check status. " +
    "Set includePatch to read the diff, and pathPrefixes to scope to a folder; " +
    "`matched_file_count` is a scalar a workflow if-node can compare against a number.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const filesLimit = Math.min(Math.max(args.filesLimit ?? 100, 1), 300);
    const commentsLimit = Math.min(Math.max(args.commentsLimit ?? 100, 1), 300);
    const patchBytesLimit = Math.min(
      Math.max(args.patchBytesLimit ?? PATCH_BYTES_DEFAULT, 1024),
      1048576,
    );
    try {
      const [prResp, allFiles, reviewsResp, commentsResp] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: args.owner,
          repo: args.repo,
          pull_number: args.pullNumber,
        }),
        // Not wrapped in a catch, unlike the enrichment calls below: the file
        // list drives `matched_file_count`, and an empty list on failure reads
        // as "this pull request touches nothing I care about".
        fetchPullRequestFiles(octokit, args.owner, args.repo, args.pullNumber, filesLimit),
        octokit
          .request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
            owner: args.owner,
            repo: args.repo,
            pull_number: args.pullNumber,
          })
          .catch(() => ({ data: [] as unknown[] })),
        octokit
          .request("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
            owner: args.owner,
            repo: args.repo,
            pull_number: args.pullNumber,
            per_page: commentsLimit,
          })
          .catch(() => ({ data: [] as unknown[] })),
      ]);

      const pr = prResp.data;
      const prefixes = args.pathPrefixes ?? [];
      const matched =
        prefixes.length === 0
          ? allFiles
          : allFiles.filter((f) => prefixes.some((prefix) => f.filename.startsWith(prefix)));
      const patched = args.includePatch ? attachPatches(matched, patchBytesLimit) : undefined;
      const files: InspectedFile[] = patched?.files ?? matched.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      // `changed_files` is the repository's own count. A smaller fetched count
      // means `filesLimit` cut the list, so `matched_file_count` is a floor.
      const filesComplete =
        typeof pr.changed_files === "number" ? allFiles.length >= pr.changed_files : true;

      const reviews = reviewsResp.data as Array<{
        user?: { login: string };
        state: string;
        body?: string;
      }>;
      const comments = commentsResp.data as Array<{
        user?: { login: string };
        path: string;
        line?: number;
        original_line?: number;
        body?: string;
      }>;

      // Get check runs for the head SHA
      const headSha = pr.head?.sha || "";
      let checks: Array<{ name: string; status: string; conclusion: string | null }> = [];
      if (headSha) {
        try {
          const checksResp = await octokit.request(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            { owner: args.owner, repo: args.repo, ref: headSha },
          );
          checks = checksResp.data.check_runs.map((c) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
          }));
        } catch {
          // silently skip
        }
      }

      return {
        success: true,
        data: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          merged: pr.merged,
          draft: pr.draft,
          user: pr.user?.login,
          url: pr.html_url,
          head: { ref: pr.head?.ref, sha: headSha },
          base: { ref: pr.base?.ref },
          body: pr.body,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
          files,
          /** Files kept by `pathPrefixes`, or every fetched file when no prefix
           * was given. A scalar, so a workflow if-node can compare it with the
           * number operators — the GitHub pull_request webhook carries no
           * changed-file list, so folder scoping cannot happen at the
           * subscription filter. */
          matched_file_count: files.length,
          /** False when `filesLimit` cut the list short, which makes
           * `matched_file_count` a lower bound. */
          files_complete: filesComplete,
          ...(patched ? { patch_summary: patched.summary } : {}),
          reviews: reviews
            .filter((r) => r.state !== "DISMISSED")
            .map((r) => ({ user: r.user?.login, state: r.state, body: r.body })),
          comments: comments.map((c) => ({
            user: c.user?.login,
            path: c.path,
            line: c.line ?? c.original_line,
            body: c.body,
          })),
          checks,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.inspect_pull_request", "Inspect pull request");
    }
  },
});

/**
 * The tag this action writes into every review body it creates. HTML comments
 * do not render on GitHub, so it is invisible to a human reader.
 *
 * It is also the identity `updateExisting` matches on. The legacy action
 * matched `review.user.login` against a `botLogin` that the host put on the
 * action context, derived from the GitHub App slug as `{slug}[bot]`. V2's
 * PluginActionContext carries no such field, and that identity exists only for
 * an App installation credential: under a user OAuth token the legacy action
 * found no login and quietly created a second review instead of updating.
 * The tag needs no host identity, works under both credential tiers, and
 * `updateKey` keeps two review workflows on one pull request apart.
 */
function reviewMarker(updateKey: string): string {
  return `<!-- valet-review:${updateKey} -->`;
}

const REVIEW_COMMENT_SIDE = Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]);

interface ReviewCommentInput {
  path: string;
  body: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  position?: number;
}

/**
 * Rejects the anchor combinations GitHub answers with a 422. A review comment
 * uses either the legacy `position` (an offset from the first @@ hunk header)
 * or the line anchor (`line`, plus `side`/`startLine`/`startSide`), never both.
 * Returns an error message, or null when every comment is valid.
 */
function validateReviewComments(comments: ReviewCommentInput[]): string | null {
  for (const [index, comment] of comments.entries()) {
    const at = `comments[${index}] on "${comment.path}"`;
    const hasPosition = comment.position !== undefined;
    const hasLineAnchor =
      comment.line !== undefined ||
      comment.side !== undefined ||
      comment.startLine !== undefined ||
      comment.startSide !== undefined;

    if (hasPosition && hasLineAnchor) {
      return `Create review: ${at} sets both position and a line anchor. GitHub accepts one or the other. Remove position, or remove line/side/startLine/startSide.`;
    }
    if ((comment.startLine !== undefined || comment.startSide !== undefined) && comment.line === undefined) {
      return `Create review: ${at} sets startLine or startSide without line. Set line to the last line of the range.`;
    }
    if (!hasPosition && comment.line === undefined) {
      return `Create review: ${at} has no anchor. Set line to a line of the diff, or set position.`;
    }
  }
  return null;
}

const createReview = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    pullNumber: Type.Integer({ description: "Pull request number" }),
    body: Type.Optional(
      Type.String({
        description:
          "Review summary in markdown. GitHub requires it when event is COMMENT or REQUEST_CHANGES.",
      }),
    ),
    // Deliberate divergence: the legacy action accepted APPROVE as a third
    // event. An approving review can satisfy a branch-protection rule and let a
    // merge through, so it decides authorization rather than reporting a review
    // finding. Add it back only with an explicit decision on who may approve.
    event: Type.Optional(
      Type.Union([Type.Literal("COMMENT"), Type.Literal("REQUEST_CHANGES")], {
        description:
          "Review verdict. Omit it to leave the review PENDING, which stages the comments " +
          "until someone submits them. APPROVE is not available here: an approving review " +
          "can satisfy branch protection, which is a merge authorization and not a review remark.",
      }),
    ),
    commitId: Type.Optional(
      Type.String({
        description:
          "SHA the review applies to (defaults to the head commit at post time). Pass the SHA " +
          "the diff was read at — on a busy pull request a new push can land between the two " +
          "calls, which moves the line anchors.",
      }),
    ),
    comments: Type.Optional(
      Type.Array(
        Type.Object({
          path: Type.String({ description: "File path, relative to the repository root" }),
          body: Type.String({ description: "Comment text in markdown" }),
          line: Type.Optional(
            Type.Integer({
              description:
                "Line number in the file, as it appears in the pull request diff. " +
                "A line that is not in the diff makes GitHub reject the whole review.",
            }),
          ),
          side: Type.Optional(
            Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")], {
              description: 'LEFT for a removed line, RIGHT for an added or unchanged line (default: RIGHT)',
            }),
          ),
          startLine: Type.Optional(
            Type.Integer({ description: "First line of a multi-line comment. `line` is the last." }),
          ),
          startSide: Type.Optional(REVIEW_COMMENT_SIDE),
          position: Type.Optional(
            Type.Integer({
              description:
                "Legacy anchor: offset from the first @@ hunk header. Prefer line. " +
                "It cannot be combined with line, side, startLine, or startSide.",
            }),
          ),
        }),
        { description: "Inline comments, anchored to a file and a line of the diff" },
      ),
    ),
    updateExisting: Type.Optional(
      Type.Boolean({
        description:
          "Replace the body of this action's previous review on the pull request instead of " +
          "adding another one (default: false). Use it for a re-review, so repeated runs do " +
          "not stack duplicates. It cannot carry inline comments — GitHub's review-update " +
          "endpoint changes the summary body only.",
      }),
    ),
    updateKey: Type.Optional(
      Type.String({
        description:
          'Names the review stream `updateExisting` replaces (default: "default"). Give two ' +
          "review workflows on one repository different keys, so each updates only its own review.",
      }),
    ),
  }))({
  id: "github.create_review",
  name: "Create Pull Request Review",
  description:
    "Submit a review on a pull request, with an optional set of inline comments anchored to " +
    "diff lines. Omit event to leave the review pending. Set updateExisting to replace this " +
    "action's previous review instead of adding another one.",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const marker = reviewMarker(args.updateKey ?? "default");
    // A review with no body stays untouched: GitHub allows a bodyless PENDING
    // review, and a marker-only body would turn it into a visible remark.
    const body = args.body === undefined ? undefined : `${args.body}\n\n${marker}`;
    const inputComments: ReviewCommentInput[] = args.comments ?? [];
    const comments = inputComments.map((comment) => ({
      path: comment.path,
      body: comment.body,
      ...(comment.line === undefined ? {} : { line: comment.line }),
      ...(comment.side === undefined ? {} : { side: comment.side }),
      ...(comment.startLine === undefined ? {} : { start_line: comment.startLine }),
      ...(comment.startSide === undefined ? {} : { start_side: comment.startSide }),
      ...(comment.position === undefined ? {} : { position: comment.position }),
    }));

    if ((args.event === "COMMENT" || args.event === "REQUEST_CHANGES") && !args.body?.trim()) {
      return {
        success: false,
        error: `Create review: a ${args.event} review needs a body. Set body, or omit event to leave the review pending.`,
      };
    }
    if (args.updateExisting && args.body === undefined) {
      return {
        success: false,
        error:
          "Create review: updateExisting needs a body — it replaces the body of the previous " +
          "review, so there is nothing to write. Set body, or set updateExisting to false.",
      };
    }
    if (args.updateExisting && comments.length > 0) {
      return {
        success: false,
        error:
          "Create review: updateExisting cannot carry comments. GitHub's review-update " +
          "endpoint changes the summary body only, so the inline comments would be lost. " +
          "Set updateExisting to false, or move the findings into the body.",
      };
    }
    const commentError = validateReviewComments(inputComments);
    if (commentError) return { success: false, error: commentError };

    try {
      // The guard above already returned when a body is missing. Testing `body`
      // again is what narrows it to a string for the update endpoint, which
      // has no bodyless form.
      if (args.updateExisting && body !== undefined) {
        const { data: priorReviews } = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          { owner: args.owner, repo: args.repo, pull_number: args.pullNumber, per_page: 100 },
        );
        // Newest first: a re-review updates the latest of our reviews, not the
        // first one we ever left on this pull request.
        const previous = [...priorReviews]
          .reverse()
          .find((review) => typeof review.body === "string" && review.body.includes(marker));
        if (previous) {
          const { data: updated } = await octokit.request(
            "PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
            {
              owner: args.owner,
              repo: args.repo,
              pull_number: args.pullNumber,
              review_id: previous.id,
              body,
            },
          );
          return {
            success: true,
            data: {
              review_id: updated.id,
              state: updated.state,
              url: updated.html_url,
              updated: true,
              inline_comments: 0,
            },
          };
        }
      }

      const { data: review } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner: args.owner,
          repo: args.repo,
          pull_number: args.pullNumber,
          ...(body === undefined ? {} : { body }),
          // No event means GitHub keeps the review PENDING. Sending a default
          // would submit a review the caller never asked to publish.
          ...(args.event === undefined ? {} : { event: args.event }),
          ...(args.commitId === undefined ? {} : { commit_id: args.commitId }),
          ...(comments.length > 0 ? { comments } : {}),
        },
      );
      return {
        success: true,
        data: {
          review_id: review.id,
          state: review.state,
          url: review.html_url,
          updated: false,
          inline_comments: comments.length,
        },
      };
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 422 && comments.length > 0) {
        return {
          success: false,
          error:
            "Create review: GitHub rejected the review (422). Every inline comment must point " +
            'at a line that appears in the pull request diff for its "path". Run ' +
            "github.inspect_pull_request with includePatch, read the diff, and take the line " +
            "numbers from it.",
        };
      }
      return handleOctokitError(err, "github.create_review", "Create review");
    }
  },
});

const updatePullRequest = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    pullNumber: Type.Integer({ description: "Pull request number" }),
    title: Type.Optional(Type.String({ description: "New title" })),
    body: Type.Optional(Type.String({ description: "New body (markdown)" })),
    state: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("closed")], {
        description: "Set PR state",
      }),
    ),
    labels: Type.Optional(
      Type.Array(Type.String(), { description: "Labels to set (replaces existing)" }),
    ),
  }))({
  id: "github.update_pull_request",
  name: "Update Pull Request",
  description: "Update a pull request title, body, state, or labels",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const updateBody: Record<string, unknown> = {};
    if (args.title !== undefined) updateBody.title = args.title;
    if (args.body !== undefined) updateBody.body = args.body;
    if (args.state !== undefined) updateBody.state = args.state;
    try {
      const { data: prData } = await octokit.request(
        "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: args.owner,
          repo: args.repo,
          pull_number: args.pullNumber,
          ...updateBody,
        },
      );
      if (args.labels) {
        await octokit.request(
          "PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
          {
            owner: args.owner,
            repo: args.repo,
            issue_number: args.pullNumber,
            labels: args.labels,
          },
        );
      }
      return {
        success: true,
        data: {
          number: prData.number,
          url: prData.html_url,
          title: prData.title,
          state: prData.state,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.update_pull_request", "Update pull request");
    }
  },
});

const createRepository = action(Type.Object({
    name: Type.String({ description: "Repository name" }),
    description: Type.Optional(Type.String({ description: "Repository description" })),
    private: Type.Optional(
      Type.Boolean({ description: "Whether the repository is private (default: false)" }),
    ),
    autoInit: Type.Optional(
      Type.Boolean({ description: "Initialize with a README (default: false)" }),
    ),
    gitignoreTemplate: Type.Optional(
      Type.String({ description: 'Gitignore template (e.g. "Node", "Python")' }),
    ),
    licenseTemplate: Type.Optional(
      Type.String({ description: 'License keyword (e.g. "mit", "apache-2.0")' }),
    ),
  }))({
  id: "github.create_repository",
  name: "Create Repository",
  description: "Create a new GitHub repository for the authenticated user",
  riskLevel: "high",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data: repo } = await octokit.request("POST /user/repos", {
        name: args.name,
        description: args.description,
        private: args.private,
        auto_init: args.autoInit,
        gitignore_template: args.gitignoreTemplate,
        license_template: args.licenseTemplate,
      });
      return {
        success: true,
        data: {
          full_name: repo.full_name,
          url: repo.html_url,
          clone_url: repo.clone_url,
          private: repo.private,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.create_repository", "Create repository");
    }
  },
});

const listIssues = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    state: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
        description: "Issue state filter (default: open)",
      }),
    ),
    labels: Type.Optional(Type.String({ description: "Comma-separated label names" })),
    assignee: Type.Optional(
      Type.String({ description: 'Filter by assignee username, or "none"/"*"' }),
    ),
    sort: Type.Optional(
      Type.Union(
        [Type.Literal("created"), Type.Literal("updated"), Type.Literal("comments")],
        { description: "Sort field" },
      ),
    ),
    direction: Type.Optional(
      Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
        description: "Sort direction",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default: 30)" }),
    ),
  }))({
  id: "github.list_issues",
  name: "List Issues",
  description: "List issues for a repository with optional filters",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    try {
      const { data: issues } = await octokit.request("GET /repos/{owner}/{repo}/issues", {
        owner: args.owner,
        repo: args.repo,
        state: args.state,
        labels: args.labels,
        assignee: args.assignee,
        sort: args.sort,
        direction: args.direction,
        per_page: 100,
      });
      return {
        success: true,
        data: issues
          .filter((i) => !i.pull_request)
          .slice(0, limit)
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            user: i.user?.login,
            url: i.html_url,
            labels: (i.labels as Array<unknown>)?.map((l) =>
              typeof l === "string" ? l : (l as { name: string }).name,
            ),
            assignees: i.assignees?.map((a) => a.login),
            created_at: i.created_at,
            updated_at: i.updated_at,
          })),
      };
    } catch (err) {
      return handleOctokitError(err, "github.list_issues", "List issues");
    }
  },
});

const updateIssue = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    issueNumber: Type.Integer({ description: "Issue number" }),
    title: Type.Optional(Type.String({ description: "New title" })),
    body: Type.Optional(Type.String({ description: "New body (markdown)" })),
    state: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("closed")], {
        description: "Set issue state",
      }),
    ),
    labels: Type.Optional(
      Type.Array(Type.String(), { description: "Labels to set (replaces existing)" }),
    ),
    assignees: Type.Optional(
      Type.Array(Type.String(), { description: "Assignee usernames (replaces existing)" }),
    ),
  }))({
  id: "github.update_issue",
  name: "Update Issue",
  description: "Update an issue title, body, state, labels, or assignees",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const updateBody: Record<string, unknown> = {};
    if (args.title !== undefined) updateBody.title = args.title;
    if (args.body !== undefined) updateBody.body = args.body;
    if (args.state !== undefined) updateBody.state = args.state;
    if (args.labels !== undefined) updateBody.labels = args.labels;
    if (args.assignees !== undefined) updateBody.assignees = args.assignees;
    try {
      const { data: issue } = await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        {
          owner: args.owner,
          repo: args.repo,
          issue_number: args.issueNumber,
          ...updateBody,
        },
      );
      return {
        success: true,
        data: {
          number: issue.number,
          url: issue.html_url,
          title: issue.title,
          state: issue.state,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.update_issue", "Update issue");
    }
  },
});

const createPullRequest = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    title: Type.String({ description: "PR title" }),
    head: Type.String({
      description: 'Branch containing changes (or "user:branch" for cross-repo)',
    }),
    base: Type.String({ description: "Branch to merge into" }),
    body: Type.Optional(Type.String({ description: "PR description (markdown)" })),
    draft: Type.Optional(Type.Boolean({ description: "Create as draft PR" })),
  }))({
  id: "github.create_pull_request",
  name: "Create Pull Request",
  description: "Create a new pull request",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner: args.owner,
        repo: args.repo,
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body || undefined,
        draft: args.draft,
      });
      return {
        success: true,
        data: {
          number: pr.number,
          url: pr.html_url,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.create_pull_request", "Create pull request");
    }
  },
});

const mergePullRequest = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    pullNumber: Type.Integer({ description: "Pull request number" }),
    mergeMethod: Type.Optional(
      Type.Union(
        [Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")],
        { description: "Merge method (default: merge)" },
      ),
    ),
    commitTitle: Type.Optional(Type.String({ description: "Custom merge commit title" })),
    commitMessage: Type.Optional(Type.String({ description: "Custom merge commit message" })),
  }))({
  id: "github.merge_pull_request",
  name: "Merge Pull Request",
  description: "Merge a pull request",
  riskLevel: "high",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: args.owner,
          repo: args.repo,
          pull_number: args.pullNumber,
          merge_method: args.mergeMethod,
          commit_title: args.commitTitle,
          commit_message: args.commitMessage,
        },
      );
      return { success: true, data: { merged: data.merged, message: data.message, sha: data.sha } };
    } catch (err) {
      return handleOctokitError(err, "github.merge_pull_request", "Merge pull request");
    }
  },
});

const createBranch = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    branch: Type.String({ description: "New branch name" }),
    fromRef: Type.Optional(
      Type.String({
        description: "Source ref — branch, tag, or SHA (default: repo default branch)",
      }),
    ),
  }))({
  id: "github.create_branch",
  name: "Create Branch",
  description: "Create a new branch from a ref",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    let sha: string | undefined;
    try {
      if (args.fromRef) {
        try {
          const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            owner: args.owner,
            repo: args.repo,
            ref: `heads/${args.fromRef}`,
          });
          sha = data.object?.sha;
        } catch {
          try {
            const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
              owner: args.owner,
              repo: args.repo,
              ref: `tags/${args.fromRef}`,
            });
            sha = data.object?.sha;
          } catch {
            try {
              await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
                owner: args.owner,
                repo: args.repo,
                commit_sha: args.fromRef,
              });
              sha = args.fromRef;
            } catch {
              // none matched
            }
          }
        }
        if (!sha) return { success: false, error: `Could not resolve ref "${args.fromRef}"` };
      } else {
        const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
          owner: args.owner,
          repo: args.repo,
        });
        const defaultBranch = repoData.default_branch || "main";
        const { data: refData } = await octokit.request(
          "GET /repos/{owner}/{repo}/git/ref/{ref}",
          { owner: args.owner, repo: args.repo, ref: `heads/${defaultBranch}` },
        );
        sha = refData.object?.sha;
      }
      if (!sha) return { success: false, error: "Could not resolve source SHA" };

      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: args.owner,
        repo: args.repo,
        ref: `refs/heads/${args.branch}`,
        sha,
      });
      return { success: true, data: { branch: args.branch, sha } };
    } catch (err) {
      return handleOctokitError(err, "github.create_branch", "Create branch");
    }
  },
});

const deleteBranch = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    branch: Type.String({ description: "Branch name to delete" }),
  }))({
  id: "github.delete_branch",
  name: "Delete Branch",
  description: "Delete a branch from a repository",
  riskLevel: "high",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        owner: args.owner,
        repo: args.repo,
        ref: `heads/${args.branch}`,
      });
      return { success: true, data: { deleted: args.branch } };
    } catch (err) {
      return handleOctokitError(err, "github.delete_branch", "Delete branch");
    }
  },
});

const listCommits = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    sha: Type.Optional(Type.String({ description: "Branch name or commit SHA to list from" })),
    path: Type.Optional(Type.String({ description: "Only commits containing this file path" })),
    author: Type.Optional(
      Type.String({ description: "GitHub username or email to filter by" }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default: 30)" }),
    ),
  }))({
  id: "github.list_commits",
  name: "List Commits",
  description: "List commits on a branch or path",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const perPage = Math.min(Math.max(args.limit ?? 30, 1), 100);
    try {
      const { data: commits } = await octokit.request(
        "GET /repos/{owner}/{repo}/commits",
        {
          owner: args.owner,
          repo: args.repo,
          sha: args.sha,
          path: args.path,
          author: args.author,
          per_page: perPage,
        },
      );
      return {
        success: true,
        data: commits.map((c) => ({
          sha: c.sha,
          message: c.commit?.message?.split("\n")[0],
          author: c.commit?.author?.name,
          date: c.commit?.author?.date,
          url: c.html_url,
        })),
      };
    } catch (err) {
      return handleOctokitError(err, "github.list_commits", "List commits");
    }
  },
});

const searchCode = action(Type.Object({
    q: Type.String({
      description:
        'Search query (supports GitHub code search qualifiers like "repo:", "language:", "path:")',
    }),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default: 30)" }),
    ),
  }))({
  id: "github.search_code",
  name: "Search Code",
  description: "Search for code across GitHub repositories",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    try {
      const { data } = await octokit.request("GET /search/code", {
        q: args.q,
        per_page: limit,
      });
      return {
        success: true,
        data: {
          total_count: data.total_count,
          items: data.items.map((item) => ({
            name: item.name,
            path: item.path,
            repo: item.repository?.full_name,
            url: item.html_url,
          })),
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.search_code", "Search code");
    }
  },
});

const searchIssues = action(Type.Object({
    q: Type.String({
      description:
        'Search query (supports qualifiers like "repo:", "is:issue", "is:pr", "label:", "state:")',
    }),
    sort: Type.Optional(
      Type.Union(
        [Type.Literal("created"), Type.Literal("updated"), Type.Literal("comments")],
        { description: "Sort field" },
      ),
    ),
    order: Type.Optional(
      Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
        description: "Sort order",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default: 30)" }),
    ),
  }))({
  id: "github.search_issues",
  name: "Search Issues",
  description: "Search issues and pull requests across GitHub",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    try {
      const { data } = await octokit.request("GET /search/issues", {
        q: args.q,
        per_page: limit,
        sort: args.sort,
        order: args.order,
      });
      return {
        success: true,
        data: {
          total_count: data.total_count,
          items: data.items.map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            user: item.user?.login,
            url: item.html_url,
            is_pr: !!item.pull_request,
            labels: (item.labels as Array<unknown>)?.map((l) =>
              typeof l === "string" ? l : (l as { name: string }).name,
            ),
            created_at: item.created_at,
            updated_at: item.updated_at,
          })),
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.search_issues", "Search issues");
    }
  },
});

const createRelease = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    tagName: Type.String({ description: "Tag name for the release" }),
    name: Type.Optional(Type.String({ description: "Release title" })),
    body: Type.Optional(Type.String({ description: "Release notes (markdown)" })),
    targetCommitish: Type.Optional(
      Type.String({ description: "Branch or commit SHA to tag (default: default branch)" }),
    ),
    draft: Type.Optional(Type.Boolean({ description: "Create as draft release" })),
    prerelease: Type.Optional(Type.Boolean({ description: "Mark as pre-release" })),
    generateReleaseNotes: Type.Optional(
      Type.Boolean({ description: "Auto-generate release notes" }),
    ),
  }))({
  id: "github.create_release",
  name: "Create Release",
  description: "Create a new release (and optionally a tag)",
  riskLevel: "high",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data: release } = await octokit.request(
        "POST /repos/{owner}/{repo}/releases",
        {
          owner: args.owner,
          repo: args.repo,
          tag_name: args.tagName,
          name: args.name,
          body: args.body,
          target_commitish: args.targetCommitish,
          draft: args.draft,
          prerelease: args.prerelease,
          generate_release_notes: args.generateReleaseNotes,
        },
      );
      return {
        success: true,
        data: {
          id: release.id,
          tag: release.tag_name,
          url: release.html_url,
          draft: release.draft,
          prerelease: release.prerelease,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.create_release", "Create release");
    }
  },
});

const forkRepository = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    organization: Type.Optional(
      Type.String({ description: "Organization to fork to (default: authenticated user)" }),
    ),
    name: Type.Optional(Type.String({ description: "Custom name for the fork" })),
  }))({
  id: "github.fork_repository",
  name: "Fork Repository",
  description: "Fork a repository to the authenticated user or an organization",
  riskLevel: "high",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data: fork } = await octokit.request("POST /repos/{owner}/{repo}/forks", {
        owner: args.owner,
        repo: args.repo,
        organization: args.organization,
        name: args.name,
      });
      return {
        success: true,
        data: {
          full_name: fork.full_name,
          url: fork.html_url,
          clone_url: fork.clone_url,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.fork_repository", "Fork repository");
    }
  },
});

const listWorkflowRuns = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    branch: Type.Optional(Type.String({ description: "Filter by branch" })),
    status: Type.Optional(
      Type.Union(
        [
          Type.Literal("completed"),
          Type.Literal("action_required"),
          Type.Literal("cancelled"),
          Type.Literal("failure"),
          Type.Literal("neutral"),
          Type.Literal("skipped"),
          Type.Literal("stale"),
          Type.Literal("success"),
          Type.Literal("timed_out"),
          Type.Literal("in_progress"),
          Type.Literal("queued"),
          Type.Literal("requested"),
          Type.Literal("waiting"),
          Type.Literal("pending"),
        ],
        { description: "Filter by status" },
      ),
    ),
    event: Type.Optional(
      Type.String({ description: 'Filter by event type (e.g. "push", "pull_request")' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default: 30)" }),
    ),
  }))({
  id: "github.list_workflow_runs",
  name: "List Workflow Runs",
  description: "List GitHub Actions workflow runs for a repository",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    const perPage = Math.min(Math.max(args.limit ?? 30, 1), 100);
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
        owner: args.owner,
        repo: args.repo,
        branch: args.branch,
        status: args.status,
        event: args.event,
        per_page: perPage,
      });
      return {
        success: true,
        data: {
          total_count: data.total_count,
          runs: data.workflow_runs.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            branch: r.head_branch,
            event: r.event,
            url: r.html_url,
            created_at: r.created_at,
          })),
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.list_workflow_runs", "List workflow runs");
    }
  },
});

const getWorkflowRun = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    run_id: Type.Integer({ description: "Workflow run ID" }),
  }))({
  id: "github.get_workflow_run",
  name: "Get Workflow Run",
  description:
    "Get details of a workflow run including jobs, steps, and check annotations. Use this to triage failures before fetching logs.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const [runResp, jobsResp] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
          owner: args.owner,
          repo: args.repo,
          run_id: args.run_id,
        }),
        octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
          owner: args.owner,
          repo: args.repo,
          run_id: args.run_id,
          per_page: 100,
        }),
      ]);
      const run = runResp.data;
      const jobs = jobsResp.data.jobs;

      type Annotation = {
        path: string;
        start_line: number;
        end_line: number;
        annotation_level: string;
        message: string;
        title: string | null;
      };
      const annotations: Annotation[] = [];
      if (run.head_sha) {
        try {
          const checksResp = await octokit.request(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            {
              owner: args.owner,
              repo: args.repo,
              ref: run.head_sha,
              per_page: 100,
            },
          );
          for (const cr of checksResp.data.check_runs) {
            if (cr.output?.annotations_count && cr.output.annotations_count > 0) {
              try {
                const annResp = await octokit.request(
                  "GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
                  {
                    owner: args.owner,
                    repo: args.repo,
                    check_run_id: cr.id,
                  },
                );
                for (const a of annResp.data) {
                  annotations.push({
                    path: a.path,
                    start_line: a.start_line,
                    end_line: a.end_line ?? a.start_line,
                    annotation_level: a.annotation_level ?? "notice",
                    message: a.message ?? "",
                    title: a.title ?? null,
                  });
                }
              } catch {
                // skip
              }
            }
          }
        } catch {
          // skip
        }
      }

      const seen = new Set<string>();
      const errorAnnotations: Annotation[] = [];
      const warningAnnotations: Annotation[] = [];
      for (const a of annotations) {
        const key = `${a.annotation_level}:${a.path}:${a.start_line}:${a.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (a.annotation_level === "failure" || a.annotation_level === "error") {
          errorAnnotations.push(a);
        } else {
          warningAnnotations.push(a);
        }
      }

      return {
        success: true,
        data: {
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          event: run.event,
          branch: run.head_branch,
          commit_sha: run.head_sha,
          url: run.html_url,
          created_at: run.created_at,
          updated_at: run.updated_at,
          run_attempt: run.run_attempt,
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion,
            started_at: j.started_at,
            completed_at: j.completed_at,
            steps: (j.steps ?? []).map((s) => ({
              name: s.name,
              status: s.status,
              conclusion: s.conclusion,
              number: s.number,
            })),
          })),
          annotations: errorAnnotations,
          warnings:
            warningAnnotations.length > 0
              ? `${warningAnnotations.length} warning-level annotations omitted (use get_job_logs for details)`
              : undefined,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.get_workflow_run", "Get workflow run");
    }
  },
});

const getJobLogs = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    job_id: Type.Integer({ description: "Job ID (from get_workflow_run response)" }),
    failed_only: Type.Optional(
      Type.Boolean({
        default: true,
        description: "Only return failed step output (default: true)",
      }),
    ),
    step_name: Type.Optional(
      Type.String({ description: "Filter to a specific step by name (partial match)" }),
    ),
    tail_lines: Type.Optional(
      Type.Integer({
        minimum: 10,
        maximum: 5000,
        default: 500,
        description: "Max lines per step, tail-biased (default: 500)",
      }),
    ),
    include_timestamps: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Include ISO timestamp prefixes (default: false)",
      }),
    ),
  }))({
  id: "github.get_job_logs",
  name: "Get Job Logs",
  description:
    "Get log output from a specific workflow job. Parses logs into steps, filters to failed steps by default, strips noise, and truncates. Use after get_workflow_run to read failure details.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const jobResp = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
        { owner: args.owner, repo: args.repo, job_id: args.job_id },
      );

      // The logs endpoint returns a 302 redirect to an Azure Blob Storage
      // pre-signed URL. Bypass Octokit so the Authorization header doesn't
      // tag along on the cross-origin redirect.
      const cred = await ctx.credentials.get();
      const token = cred?.accessToken;
      if (!token) {
        return { success: false, error: "Missing GitHub access token" };
      }
      const logsApiUrl = `${resolveGithubApiUrl()}/repos/${args.owner}/${args.repo}/actions/jobs/${args.job_id}/logs`;
      const redirectResp = await fetch(logsApiUrl, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "valet-github-plugin",
        },
        redirect: "manual",
      });
      const logsUrl = redirectResp.headers.get("location");
      if (!logsUrl) {
        const body = await redirectResp.text().catch(() => "");
        return {
          success: false,
          error: `Expected 302 redirect for log download, got ${redirectResp.status}. ${body}`.trim(),
        };
      }
      const logsResponse = await fetch(logsUrl);
      if (!logsResponse.ok) {
        if (logsResponse.status === 410) {
          return {
            success: false,
            error: "Logs have expired. GitHub retains logs for 90 days by default.",
          };
        }
        return {
          success: false,
          error: `Log download failed: ${logsResponse.status} ${logsResponse.statusText}`,
        };
      }
      const job = jobResp.data;
      const rawLog = await logsResponse.text();
      const stepsMeta = (job.steps ?? []).map((s) => ({
        name: s.name,
        conclusion: s.conclusion ?? null,
      }));
      const parsed = parseJobLog(rawLog, stepsMeta, {
        failedOnly: args.failed_only ?? true,
        stepName: args.step_name,
        tailLines: args.tail_lines ?? 500,
        includeTimestamps: args.include_timestamps ?? false,
      });
      return {
        success: true,
        data: { job_id: job.id, job_name: job.name, steps: parsed },
      };
    } catch (err) {
      return handleOctokitError(err, "github.get_job_logs", "Get job logs");
    }
  },
});

const rerunWorkflow = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    run_id: Type.Integer({ description: "Workflow run ID to re-run" }),
    failed_only: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Only re-run failed jobs (default: false)",
      }),
    ),
  }))({
  id: "github.rerun_workflow",
  name: "Rerun Workflow",
  description: "Re-run a workflow run. Can re-run all jobs or only failed jobs.",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const endpoint = args.failed_only
        ? "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
        : "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun";
      await octokit.request(endpoint, {
        owner: args.owner,
        repo: args.repo,
        run_id: args.run_id,
      });
      const url = `https://github.com/${args.owner}/${args.repo}/actions/runs/${args.run_id}`;
      return {
        success: true,
        data: {
          message: args.failed_only
            ? `Re-running failed jobs for run ${args.run_id}`
            : `Re-running all jobs for run ${args.run_id}`,
          url,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.rerun_workflow", "Rerun workflow");
    }
  },
});

const cancelWorkflowRun = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    run_id: Type.Integer({ description: "Workflow run ID to cancel" }),
  }))({
  id: "github.cancel_workflow_run",
  name: "Cancel Workflow Run",
  description: "Cancel an in-progress workflow run.",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      await octokit.request(
        "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
        { owner: args.owner, repo: args.repo, run_id: args.run_id },
      );
      return { success: true, data: { message: `Cancelled workflow run ${args.run_id}` } };
    } catch (err) {
      return handleOctokitError(err, "github.cancel_workflow_run", "Cancel workflow run");
    }
  },
});

const listWorkflows = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
  }))({
  id: "github.list_workflows",
  name: "List Workflows",
  description:
    "List workflow definitions in a repository. Returns workflow names, file paths, and states.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/workflows",
        { owner: args.owner, repo: args.repo, per_page: 100 },
      );
      return {
        success: true,
        data: {
          total_count: data.total_count,
          workflows: data.workflows.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            state: w.state,
          })),
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.list_workflows", "List workflows");
    }
  },
});

const triggerWorkflow = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    workflow_id: Type.Union([Type.String(), Type.Integer()], {
      description: 'Workflow filename (e.g. "ci.yml") or numeric ID',
    }),
    ref: Type.String({ description: "Branch or tag to run the workflow on" }),
    inputs: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Workflow dispatch input values (key-value pairs)",
      }),
    ),
  }))({
  id: "github.trigger_workflow",
  name: "Trigger Workflow",
  description:
    "Manually trigger a workflow via workflow_dispatch event. The workflow must have a workflow_dispatch trigger configured.",
  riskLevel: "medium",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      await octokit.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          owner: args.owner,
          repo: args.repo,
          workflow_id: args.workflow_id,
          ref: args.ref,
          inputs: args.inputs,
        },
      );
      return {
        success: true,
        data: {
          message: `Workflow dispatch accepted for ${args.workflow_id} on ${args.ref}. Use list_workflow_runs to find the new run.`,
        },
      };
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 422) {
        return {
          success: false,
          error:
            "Workflow dispatch failed. Make sure the workflow has a workflow_dispatch trigger and the inputs match the expected schema.",
        };
      }
      return handleOctokitError(err, "github.trigger_workflow", "Trigger workflow");
    }
  },
});

const readRepoFile = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    path: Type.String({ description: "File path in the repository" }),
    ref: Type.Optional(
      Type.String({ description: "Git ref (branch, tag, or commit SHA)" }),
    ),
  }))({
  id: "github.read_repo_file",
  name: "Read Repository File",
  description: "Read a file from a GitHub repository without cloning it",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: args.owner, repo: args.repo, path: args.path, ref: args.ref },
      );
      if (Array.isArray(data) || data.type !== "file") {
        return { success: false, error: wrongPathKindError(contentsKind(data), "file") };
      }
      const raw = data.content ?? "";
      const content =
        data.encoding === "base64"
          ? new TextDecoder().decode(
              Uint8Array.from(atob(raw.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
            )
          : raw;
      return {
        success: true,
        data: {
          path: data.path,
          repo: `${args.owner}/${args.repo}`,
          ref: args.ref,
          size: data.size,
          content,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.read_repo_file", "Read repo file");
    }
  },
});

const listRepoDirectory = action(Type.Object({
    owner: Type.String({ description: "Repository owner" }),
    repo: Type.String({ description: "Repository name" }),
    path: Type.String({
      description: 'Directory path in the repository. Use "" for the repository root.',
    }),
    ref: Type.Optional(
      Type.String({ description: "Git ref (branch, tag, or commit SHA)" }),
    ),
  }))({
  id: "github.list_repo_directory",
  name: "List Repository Directory",
  description:
    "List one level of a directory in a GitHub repository without cloning it. Each entry reports its type, so a caller can tell a subdirectory from a file. This does not recurse — call it again with a subdirectory path.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const octokit = await getOctokit(ctx);
    try {
      const listing = await collectDirectoryEntries(
        (params) => octokit.request("GET /repos/{owner}/{repo}/contents/{path}", params),
        { owner: args.owner, repo: args.repo, path: args.path, ref: args.ref },
        MAX_DIRECTORY_ENTRIES,
      );
      if (listing.kind === "not_directory") {
        return { success: false, error: wrongPathKindError(listing.type, "directory") };
      }
      return {
        success: true,
        data: {
          repo: `${args.owner}/${args.repo}`,
          path: args.path,
          ref: args.ref,
          entries: listing.entries,
          entry_count: listing.entries.length,
          // False when the cap truncated the listing — there are more
          // entries in this directory than were returned.
          entries_complete: listing.complete,
        },
      };
    } catch (err) {
      return handleOctokitError(err, "github.list_repo_directory", "List repo directory");
    }
  },
});

// ─── Plugin export ───────────────────────────────────────────────────────────

export const githubPlugin: ActionPlugin = {
  service: "github",
  description:
    "GitHub integration: repos, issues, PRs, branches, commits, releases, workflows.",
  // Statically-listed actions, so without this flag list_tools would
  // advertise every GitHub tool even when no credential is connected.
  requiresCredential: true,
  actions: [
    getRepository,
    listRepos,
    getIssue,
    createIssue,
    listIssues,
    updateIssue,
    getPullRequest,
    createComment,
    listPullRequests,
    inspectPullRequest,
    createReview,
    updatePullRequest,
    createPullRequest,
    mergePullRequest,
    createRepository,
    forkRepository,
    createBranch,
    deleteBranch,
    listCommits,
    searchCode,
    searchIssues,
    createRelease,
    listWorkflowRuns,
    getWorkflowRun,
    getJobLogs,
    rerunWorkflow,
    cancelWorkflowRun,
    listWorkflows,
    triggerWorkflow,
    readRepoFile,
    listRepoDirectory,
  ],
};
