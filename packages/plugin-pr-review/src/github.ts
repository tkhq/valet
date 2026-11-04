/**
 * The GitHub REST calls the review handler makes, with an installation
 * token. Only what the handler needs: read the pull request, compare
 * commits, list files, and post or edit the one review.
 */

export interface PullRequest {
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
}

export interface Comparison {
  /** `ahead`: base is an ancestor of head. */
  status: "ahead" | "behind" | "diverged" | "identical";
  merge_base_commit: { sha: string };
  files?: { filename: string }[];
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
}

export interface Review {
  id: number;
  body: string;
}

export interface NewReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
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
  compare(base: string, head: string): Promise<Comparison | null>;
  /** The unified diff from the merge-base of `base` and `head` to `head`, or null when GitHub will not render it. */
  compareDiff(base: string, head: string): Promise<string | null>;
  pullFiles(): Promise<PullFile[]>;
  /** The file's text at `ref`, or undefined when it is missing or binary. */
  fileText(path: string, ref: string): Promise<string | undefined>;
  review(id: number): Promise<Review | null>;
  createReview(input: { commitId: string; body: string; comments: NewReviewComment[] }): Promise<Review>;
  updateReview(id: number, body: string): Promise<Review>;
  reviewComments(): Promise<ReviewComment[]>;
  updateComment(id: number, body: string): Promise<void>;
}

const API = "https://api.github.com";
const PAGE = 100;
/** GitHub lists at most 3000 files for a pull request. */
const MAX_PAGES = 30;

export function githubClient(opts: { token: string; owner: string; repo: string; number: number; fetch?: typeof fetch; signal?: AbortSignal }): GitHubClient {
  const doFetch = opts.fetch ?? fetch;
  const repoPath = `/repos/${opts.owner}/${opts.repo}`;
  const pullPath = `${repoPath}/pulls/${opts.number}`;

  const call = async (method: string, path: string, init: { body?: unknown; accept?: string } = {}): Promise<Response> => {
    const res = await doFetch(`${API}${path}`, {
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
    async fileText(path, ref) {
      const res = await call("GET", `${repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, {
        accept: "application/vnd.github.raw+json",
      });
      if (!res.ok) return undefined;
      return res.text();
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
    async updateComment(id, body) {
      await json<unknown>("PATCH", `${repoPath}/pulls/comments/${id}`, "update review comment", { body });
    },
  };
}
