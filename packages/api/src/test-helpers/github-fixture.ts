/**
 * Shared fake GitHub API server (GitHub/repo integration plan, Task 3).
 * A real Hono app on port 0 — mirrors the `startFakeModelsServer` pattern in
 * `routes/llm-providers.test.ts` (real HTTP server the code under test hits
 * instead of a live upstream), but promoted to `test-helpers/` because
 * Tasks 4-7 need the same fixture, not just this one test file.
 *
 * Every route is overridable via `overrides`; unset routes fall back to a
 * generic 200 with a minimal-but-shape-correct body. Every request is
 * recorded to `calls` (method, path, params, the `authorization` header, and
 * the parsed JSON body when present) so tests can assert on what the
 * service under test actually sent — e.g. that `discoverInstallations`
 * authenticates with the App JWT, not an installation token.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface GithubFixtureCall {
  method: string;
  path: string;
  params: Record<string, string>;
  /** Parsed query string (e.g. `{ per_page: "100", page: "2" }`) — `c.req.path`
   * drops the query string, so this is the only way tests can assert on it. */
  query: Record<string, string>;
  authHeader?: string;
  body?: unknown;
}

export interface GithubFixtureResponse {
  status?: ContentfulStatusCode;
  body: unknown;
  /** Extra response headers, e.g. `Link` for pagination. */
  headers?: Record<string, string>;
}

export interface GithubFixtureHandlers {
  /** `GET /app/installations`. Receives the request's parsed query string so
   * multi-page fixtures can branch on `page`/`per_page`. */
  listInstallations?: (query: Record<string, string>) => GithubFixtureResponse;
  /** `POST /app/installations/:id/access_tokens` */
  createInstallationToken?: (installationId: string) => GithubFixtureResponse;
  /** `GET /user` */
  getUser?: () => GithubFixtureResponse;
  /** `POST /login/oauth/access_token` */
  oauthAccessToken?: () => GithubFixtureResponse;
  /** `GET /user/repos` */
  listUserRepos?: () => GithubFixtureResponse;
  /** `GET /installation/repositories` */
  listInstallationRepositories?: () => GithubFixtureResponse;
  /** `POST /app-manifests/:code/conversions` */
  convertManifest?: (code: string) => GithubFixtureResponse;
}

export interface GithubFixture {
  url: string;
  calls: GithubFixtureCall[];
  close(): Promise<void>;
}

function listenAddress(server: ServerType): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

const DEFAULTS: Required<GithubFixtureHandlers> = {
  listInstallations: () => ({ body: [] }),
  createInstallationToken: () => ({
    body: { token: "fixture-installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() },
  }),
  getUser: () => ({ body: { login: "fixture-user", id: 1 } }),
  oauthAccessToken: () => ({ body: { access_token: "fixture-oauth-token", token_type: "bearer", scope: "" } }),
  listUserRepos: () => ({ body: [] }),
  listInstallationRepositories: () => ({ body: { total_count: 0, repositories: [] } }),
  convertManifest: () => ({
    body: {
      id: 1,
      slug: "fixture-app",
      name: "Fixture App",
      client_id: "fixture-client-id",
      client_secret: "fixture-client-secret",
      webhook_secret: "fixture-webhook-secret",
      pem: "fixture-pem",
      html_url: "https://github.com/apps/fixture-app",
    },
  }),
};

/** Starts a fake GitHub API server on port 0. Callers MUST `await close()`
 * (e.g. in `finally`/`afterEach`) — nothing else stops the listener. */
export function startGithubFixture(overrides: GithubFixtureHandlers = {}): GithubFixture {
  const handlers = { ...DEFAULTS, ...overrides };
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
  ) {
    calls.push({
      method: c.req.method,
      path: c.req.path,
      params,
      query: c.req.query(),
      authHeader: c.req.header("authorization") ?? undefined,
      body,
    });
  }

  app.get("/app/installations", (c) => {
    const query = c.req.query();
    record(c, {});
    const { status, body, headers } = handlers.listInstallations(query);
    if (headers) {
      for (const [name, value] of Object.entries(headers)) c.header(name, value);
    }
    return c.json(body as object, status ?? 200);
  });

  app.post("/app/installations/:id/access_tokens", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    record(c, { id }, body);
    const { status, body: respBody } = handlers.createInstallationToken(id);
    return c.json(respBody as object, status ?? 201);
  });

  app.get("/user", (c) => {
    record(c, {});
    const { status, body } = handlers.getUser();
    return c.json(body as object, status ?? 200);
  });

  app.post("/login/oauth/access_token", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    record(c, {}, body);
    const { status, body: respBody } = handlers.oauthAccessToken();
    return c.json(respBody as object, status ?? 200);
  });

  app.get("/user/repos", (c) => {
    record(c, {});
    const { status, body } = handlers.listUserRepos();
    return c.json(body as object, status ?? 200);
  });

  app.get("/installation/repositories", (c) => {
    record(c, {});
    const { status, body } = handlers.listInstallationRepositories();
    return c.json(body as object, status ?? 200);
  });

  app.post("/app-manifests/:code/conversions", (c) => {
    const code = c.req.param("code");
    record(c, { code });
    const { status, body } = handlers.convertManifest(code);
    return c.json(body as object, status ?? 200);
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const port = listenAddress(server);

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
