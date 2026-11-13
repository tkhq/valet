/**
 * The GitHub REST calls the review handler makes, with an installation
 * token. Only what the handler needs: read the pull request, compare
 * commits, list files, and post or edit the one review.
 */

export interface PullRequest {
  state: "open" | "closed";
  merged?: boolean;
  merge_commit_sha?: string | null;
  draft: boolean;
  title: string;
  body: string | null;
  /**
   * The author's relation to the base repository, such as `MEMBER`, `COLLABORATOR` or `NONE`.
   * GitHub computes it for the caller: an app token sees a private org member as `CONTRIBUTOR`.
   */
  author_association?: string;
  user: { login: string } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
}

export interface Comparison {
  /** `ahead`: base is an ancestor of head. */
  status: "ahead" | "behind" | "diverged" | "identical";
  merge_base_commit: { sha: string };
  /** The changed files, as the pull request files endpoint returns them. At most 300. */
  files?: PullFile[];
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and for diffs GitHub will not render. */
  patch?: string;
}

export interface ReviewComment {
  id: number;
  body: string;
  pull_request_review_id: number | null;
  user?: { login: string; type?: string } | null;
  /** The comment this one replies to. Absent or null: it starts a thread. */
  in_reply_to_id?: number | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  /** The commit the comment was made on. */
  original_commit_id?: string;
  html_url?: string;
}

/** One emoji reaction on a review comment. */
export interface Reaction {
  content: string;
  user?: { login: string } | null;
}

export interface Review {
  id: number;
  body: string;
}

export interface NewReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

/** A review thread on the pull request, keyed to its first comment. */
export interface ReviewThread {
  /** GraphQL node id, for resolveReviewThread. */
  id: string;
  isResolved: boolean;
  /** Database id of the thread's first comment. */
  commentId: number | null;
  /** Logins distinguish a person's dismissal from the comment author's automatic resolution. */
  author?: string;
  resolvedBy?: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubClient {
  pull(): Promise<PullRequest>;
  /** The user's role on the repository (`admin`, `maintain`, `write`, `triage` or `read`), or undefined when GitHub gives none. */
  permission(user: string): Promise<string | undefined>;
  compare(base: string, head: string): Promise<Comparison | null>;
  /** The unified diff from the merge-base of `base` and `head` to `head`, or null when GitHub will not render it. */
  compareDiff(base: string, head: string): Promise<string | null>;
  pullFiles(): Promise<PullFile[]>;
  /** The parent shas of a commit, first parent first, or null when GitHub has no such commit. */
  commitParents(sha: string): Promise<string[] | null>;
  /** The file's text at `ref`, or undefined when it is missing or binary. */
  fileText(path: string, ref: string): Promise<string | undefined>;
  review(id: number): Promise<Review | null>;
  createReview(input: { commitId: string; body: string; comments: NewReviewComment[] }): Promise<Review>;
  updateReview(id: number, body: string): Promise<Review>;
  reviewComments(): Promise<ReviewComment[]>;
  /** Emoji reactions on one review comment. */
  commentReactions(commentId: number): Promise<Reaction[]>;
  updateComment(id: number, body: string): Promise<void>;
  reviewThreads(): Promise<ReviewThread[]>;
  /** Resolve or unresolve a review thread. Needs the App's pull requests write permission. */
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
}

/**
 * The GitHub API base URL. `GITHUB_API_URL` retargets it to a GitHub
 * Enterprise Server host (`https://<host>/api/v3`), with the same name and
 * default as `resolveGithubApiUrl` in the api and the GitHub plugin.
 */
export function githubApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

/** GraphQL lives at `/graphql` on github.com and at `/api/graphql` on Enterprise Server, beside `/api/v3`. */
export function githubGraphqlUrl(api: string): string {
  return api.endsWith("/api/v3") ? `${api.slice(0, -"/v3".length)}/graphql` : `${api}/graphql`;
}
const PAGE = 100;
/** GitHub lists at most 3000 files for a pull request. */
const MAX_PAGES = 30;

export function githubClient(opts: { token: string; owner: string; repo: string; number: number; fetch?: typeof fetch; signal?: AbortSignal; apiUrl?: string }): GitHubClient {
  const doFetch = opts.fetch ?? fetch;
  const api = opts.apiUrl ?? githubApiUrl();
  const repoPath = `/repos/${opts.owner}/${opts.repo}`;
  const pullPath = `${repoPath}/pulls/${opts.number}`;

  const call = async (method: string, path: string, init: { body?: unknown; accept?: string } = {}): Promise<Response> => {
    const res = await doFetch(path === "/graphql" ? githubGraphqlUrl(api) : `${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "valet-pr-review",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return res;
  };
  const failed = async (res: Response, what: string): Promise<GitHubError> => {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // Not JSON: keep the text.
    }
    return new GitHubError(res.status, `GitHub ${what} failed (${res.status}): ${message}`);
  };
  const json = async <T>(method: string, path: string, what: string, body?: unknown): Promise<T> => {
    const res = await call(method, path, body !== undefined ? { body } : {});
    if (!res.ok) throw await failed(res, what);
    return (await res.json()) as T;
  };
  const graphql = async <T>(query: string, variables: Record<string, unknown>, what: string): Promise<T> => {
    const res = await call("POST", "/graphql", { body: { query, variables } });
    if (!res.ok) throw await failed(res, what);
    const out = (await res.json()) as { data?: T; errors?: { type?: string; message: string }[] };
    if (out.errors?.length) {
      const first = out.errors[0];
      throw new GitHubError(first.type === "FORBIDDEN" ? 403 : 422, `GitHub ${what} failed: ${first.message}`);
    }
    if (!out.data) throw new GitHubError(502, `GitHub ${what} returned no data.`);
    return out.data;
  };
  const pages = async <T>(path: string, what: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await json<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`, what);
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    return all;
  };

  return {
    pull: () => json<PullRequest>("GET", pullPath, "read pull request"),
    async permission(user) {
      const res = await call("GET", `${repoPath}/collaborators/${encodeURIComponent(user)}/permission`);
      // Not a collaborator, or a token that may not read it: no role.
      if (res.status === 404 || res.status === 403) return undefined;
      if (!res.ok) throw await failed(res, `read the repository permission of ${user}`);
      const body = (await res.json()) as { role_name?: string; permission?: string };
      return body.role_name ?? body.permission;
    },
    async compare(base, head) {
      const res = await call("GET", `${repoPath}/compare/${base}...${head}?per_page=${PAGE}`);
      // A commit that a force-push dropped is gone: there is nothing to compare.
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res, "compare commits");
      return (await res.json()) as Comparison;
    },
    async compareDiff(base, head) {
      const res = await call("GET", `${repoPath}/compare/${base}...${head}`, { accept: "application/vnd.github.diff" });
      // Too large or too slow for GitHub to render: the child reads the diff with git.
      if (res.status === 404 || res.status === 406 || res.status === 422 || res.status >= 500) return null;
      if (!res.ok) throw await failed(res, "read diff");
      return res.text();
    },
    pullFiles: () => pages<PullFile>(`${pullPath}/files`, "list pull request files"),
    async commitParents(sha) {
      const res = await call("GET", `${repoPath}/commits/${sha}`);
      if (res.status === 404 || res.status === 422) return null;
      if (!res.ok) throw await failed(res, "read commit");
      const commit = (await res.json()) as { parents?: { sha: string }[] };
      return (commit.parents ?? []).map((p) => p.sha);
    },
    async fileText(path, ref) {
      const res = await call("GET", `${repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, {
        accept: "application/vnd.github.raw+json",
      });
      if (res.status === 404) return undefined;
      // Auth, rate-limit and server errors throw: a caller must not read them as a missing file.
      if (!res.ok) throw await failed(res, `read ${path} at ${ref.slice(0, 7)}`);
      const text = await res.text();
      return text.slice(0, 8192).includes("\0") ? undefined : text;
    },
    async review(id) {
      const res = await call("GET", `${pullPath}/reviews/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res, "read review");
      return (await res.json()) as Review;
    },
    createReview: (input) =>
      json<Review>("POST", `${pullPath}/reviews`, "create review", {
        commit_id: input.commitId,
        event: "COMMENT",
        body: input.body,
        comments: input.comments,
      }),
    updateReview: (id, body) => json<Review>("PUT", `${pullPath}/reviews/${id}`, "update review", { body }),
    reviewComments: () => pages<ReviewComment>(`${pullPath}/comments`, "list review comments"),
    commentReactions: (commentId) => pages<Reaction>(`${repoPath}/pulls/comments/${commentId}/reactions`, "list review comment reactions"),
    async updateComment(id, body) {
      await json<unknown>("PATCH", `${repoPath}/pulls/comments/${id}`, "update review comment", { body });
    },
    async reviewThreads() {
      const threads: ReviewThread[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        type Page = { repository: { pullRequest: { reviewThreads: {
          nodes: { id: string; isResolved: boolean; resolvedBy: { login: string } | null; comments: { nodes: { databaseId: number | null; author: { login: string } | null }[] } }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        } } } };
        const data: Page = await graphql<Page>(
          `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
            repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes { id isResolved resolvedBy { login } comments(first: 1) { nodes { databaseId author { login } } } }
                pageInfo { hasNextPage endCursor }
              }
            } }
          }`,
          { owner: opts.owner, repo: opts.repo, number: opts.number, after },
          "list review threads",
        );
        const conn = data.repository.pullRequest.reviewThreads;
        for (const t of conn.nodes) {
          const first = t.comments.nodes[0];
          threads.push({
            id: t.id,
            isResolved: t.isResolved,
            commentId: first?.databaseId ?? null,
            ...(first?.author ? { author: first.author.login } : {}),
            ...(t.resolvedBy ? { resolvedBy: t.resolvedBy.login } : {}),
          });
        }
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return threads;
    },
    async setThreadResolved(threadId, resolved) {
      const mutation = resolved
        ? "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }"
        : "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }";
      await graphql<unknown>(mutation, { id: threadId }, resolved ? "resolve review thread" : "unresolve review thread");
    },
  };
}
