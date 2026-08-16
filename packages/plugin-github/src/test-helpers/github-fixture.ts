/**
 * Fake GitHub API server for the plugin-github action suites.
 *
 * A real Hono app on port 0. The actions under test reach it because
 * `resolveGithubApiUrl` reads `GITHUB_API_URL`, so Octokit sends its requests
 * here instead of to api.github.com. This mirrors
 * `packages/api/src/test-helpers/github-fixture.ts`, which serves the same
 * purpose for the api package's own GitHub services. The two cannot be shared:
 * `@valet/api` depends on `@valet/plugin-github`, so an import in the other
 * direction makes a cycle.
 *
 * Every route is overridable through `handlers`; an unset route answers with a
 * minimal body of the correct shape. Every request is recorded to `calls`, so a
 * test can assert what the action actually sent — the request body of a review
 * POST, or the `per_page`/`page` values of a paginated file listing.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface GithubFixtureCall {
  method: string;
  path: string;
  params: Record<string, string>;
  /** Parsed query string. `c.req.path` drops it, so this is the only view of it. */
  query: Record<string, string>;
  authHeader?: string;
  body?: unknown;
}

export interface GithubFixtureResponse {
  status?: ContentfulStatusCode;
  body: unknown;
}

export interface PullRef {
  owner: string;
  repo: string;
  pullNumber: string;
}

export interface GithubFixtureHandlers {
  /** `GET /repos/:owner/:repo` */
  getRepo?: (owner: string, repo: string) => GithubFixtureResponse;
  /** `GET /repos/:owner/:repo/pulls/:pull_number` */
  getPull?: (ref: PullRef) => GithubFixtureResponse;
  /** `GET /repos/:owner/:repo/pulls/:pull_number/files` — receives the parsed
   * query so a fixture can serve real pages. */
  listPullFiles?: (ref: PullRef, query: Record<string, string>) => GithubFixtureResponse;
  /** `GET /repos/:owner/:repo/pulls/:pull_number/reviews` — receives the
   * parsed query so a fixture can serve real pages. */
  listReviews?: (ref: PullRef, query: Record<string, string>) => GithubFixtureResponse;
  /** `POST /repos/:owner/:repo/pulls/:pull_number/reviews` */
  createReview?: (ref: PullRef, body: unknown) => GithubFixtureResponse;
  /** `PUT /repos/:owner/:repo/pulls/:pull_number/reviews/:review_id` */
  updateReview?: (ref: PullRef, reviewId: string, body: unknown) => GithubFixtureResponse;
  /** `GET /repos/:owner/:repo/pulls/:pull_number/comments` */
  listReviewComments?: (ref: PullRef) => GithubFixtureResponse;
  /** `GET /repos/:owner/:repo/commits/:ref/check-runs` */
  listCheckRuns?: (owner: string, repo: string, ref: string) => GithubFixtureResponse;
  /** `GET /user/repos` — receives the auth header so a fixture can answer by
   * credential tier (an installation token 403s here on the real API). */
  listUserRepos?: (authHeader: string | undefined) => GithubFixtureResponse;
  /** `GET /installation/repositories` — same auth-header view; the real API
   * rejects user tokens on this endpoint. */
  listInstallationRepos?: (authHeader: string | undefined) => GithubFixtureResponse;
}

export interface GithubFixture {
  url: string;
  calls: GithubFixtureCall[];
  close(): Promise<void>;
}

const DEFAULTS: Required<GithubFixtureHandlers> = {
  getRepo: (owner, repo) => ({ body: { full_name: `${owner}/${repo}`, default_branch: "main" } }),
  getPull: (ref) => ({
    body: {
      number: Number(ref.pullNumber),
      title: "fixture pull request",
      state: "open",
      user: { login: "fixture-user" },
      html_url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.pullNumber}`,
      head: { ref: "feature", sha: "fixture-head-sha" },
      base: { ref: "main" },
      additions: 0,
      deletions: 0,
      changed_files: 0,
    },
  }),
  listPullFiles: () => ({ body: [] }),
  listReviews: () => ({ body: [] }),
  createReview: () => ({ status: 200, body: { id: 5001, state: "COMMENTED", html_url: "https://github.com/o/r/pull/1#pullrequestreview-5001" } }),
  updateReview: (_ref, reviewId) => ({
    body: { id: Number(reviewId), state: "COMMENTED", html_url: `https://github.com/o/r/pull/1#pullrequestreview-${reviewId}` },
  }),
  listReviewComments: () => ({ body: [] }),
  listCheckRuns: () => ({ body: { total_count: 0, check_runs: [] } }),
  listUserRepos: () => ({ body: [{ full_name: "fixture-user/repo" }] }),
  listInstallationRepos: () => ({
    body: { total_count: 1, repositories: [{ full_name: "fixture-org/repo" }] },
  }),
};

function listenPort(server: ServerType): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

/** Starts a fake GitHub API server on port 0. Callers MUST `await close()` in a
 * `finally` or `afterEach` — nothing else stops the listener. */
export function startGithubFixture(handlerOverrides: GithubFixtureHandlers = {}): GithubFixture {
  const handlers = { ...DEFAULTS, ...handlerOverrides };
  const calls: GithubFixtureCall[] = [];

  const app = new Hono();

  function record(
    c: {
      req: {
        method: string;
        path: string;
        header: (n: string) => string | undefined;
        query: () => Record<string, string>;
      };
    },
    params: Record<string, string>,
    body?: unknown,
  ): void {
    calls.push({
      method: c.req.method,
      path: c.req.path,
      params,
      query: c.req.query(),
      authHeader: c.req.header("authorization") ?? undefined,
      body,
    });
  }

  async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }

  function pullRef(c: { req: { param: (n: string) => string } }): PullRef {
    return {
      owner: c.req.param("owner"),
      repo: c.req.param("repo"),
      pullNumber: c.req.param("pull_number"),
    };
  }

  function asParams(ref: PullRef): Record<string, string> {
    return { owner: ref.owner, repo: ref.repo, pull_number: ref.pullNumber };
  }

  app.get("/repos/:owner/:repo/pulls/:pull_number/files", (c) => {
    const ref = pullRef(c);
    record(c, asParams(ref));
    const { status, body } = handlers.listPullFiles(ref, c.req.query());
    return c.json(body as object, status ?? 200);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/reviews", (c) => {
    const ref = pullRef(c);
    record(c, asParams(ref));
    const { status, body } = handlers.listReviews(ref, c.req.query());
    return c.json(body as object, status ?? 200);
  });

  app.post("/repos/:owner/:repo/pulls/:pull_number/reviews", async (c) => {
    const ref = pullRef(c);
    const body = await readJson(c);
    record(c, asParams(ref), body);
    const { status, body: respBody } = handlers.createReview(ref, body);
    return c.json(respBody as object, status ?? 200);
  });

  app.put("/repos/:owner/:repo/pulls/:pull_number/reviews/:review_id", async (c) => {
    const ref = pullRef(c);
    const reviewId = c.req.param("review_id");
    const body = await readJson(c);
    record(c, { ...asParams(ref), review_id: reviewId }, body);
    const { status, body: respBody } = handlers.updateReview(ref, reviewId, body);
    return c.json(respBody as object, status ?? 200);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/comments", (c) => {
    const ref = pullRef(c);
    record(c, asParams(ref));
    const { status, body } = handlers.listReviewComments(ref);
    return c.json(body as object, status ?? 200);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number", (c) => {
    const ref = pullRef(c);
    record(c, asParams(ref));
    const { status, body } = handlers.getPull(ref);
    return c.json(body as object, status ?? 200);
  });

  app.get("/repos/:owner/:repo/commits/:ref/check-runs", (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const ref = c.req.param("ref");
    record(c, { owner, repo, ref });
    const { status, body } = handlers.listCheckRuns(owner, repo, ref);
    return c.json(body as object, status ?? 200);
  });

  app.get("/user/repos", (c) => {
    record(c, {});
    const auth = c.req.header("authorization") ?? undefined;
    const { status, body } = handlers.listUserRepos(auth);
    return c.json(body as object, status ?? 200);
  });

  app.get("/installation/repositories", (c) => {
    record(c, {});
    const auth = c.req.header("authorization") ?? undefined;
    const { status, body } = handlers.listInstallationRepos(auth);
    return c.json(body as object, status ?? 200);
  });

  app.get("/repos/:owner/:repo", (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    record(c, { owner, repo });
    const { status, body } = handlers.getRepo(owner, repo);
    return c.json(body as object, status ?? 200);
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });

  return {
    url: `http://127.0.0.1:${listenPort(server)}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        // `close()` alone waits for every idle keep-alive socket to time out,
        // and fetch pools them between requests.
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
