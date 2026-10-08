/**
 * Shared fake Linear API server (event-system plan, Task 9). Same shape as
 * `startGithubFixture` (`test-helpers/github-fixture.ts`): a real Hono app
 * on port 0 that records every request to `calls`, with per-route
 * overridable handlers falling back to shape-correct defaults.
 *
 * One server plays both Linear hosts: `POST /oauth/token` (the token
 * endpoint on Linear's API host, `client_credentials` grant) and
 * `POST /graphql`. GraphQL requests are
 * routed by inspecting the query string for `webhookDelete` (legacy cleanup),
 * else treated as the workspace/organization query. Tests point `LINEAR_API_URL` here.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface LinearFixtureCall {
  method: string;
  path: string;
  authHeader?: string;
  /** Parsed body — JSON for /graphql, URL-decoded form fields for /oauth/token. */
  body?: unknown;
}

export interface LinearFixtureResponse {
  status?: ContentfulStatusCode;
  body: unknown;
}

export interface LinearFixtureHandlers {
  /** `POST /oauth/token` — receives the parsed form fields. */
  oauthToken?: (form: Record<string, string>) => LinearFixtureResponse;
  /** `POST /graphql` with the workspace/organization query. */
  organization?: () => LinearFixtureResponse;
  /** `POST /graphql` with the webhookDelete mutation — receives `variables`. */
  webhookDelete?: (variables: Record<string, unknown>) => LinearFixtureResponse;
}

export interface LinearFixture {
  url: string;
  calls: LinearFixtureCall[];
  close(): Promise<void>;
}

function listenAddress(server: ServerType): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

const DEFAULTS: Required<LinearFixtureHandlers> = {
  oauthToken: () => ({
    body: { access_token: "lin_app_token", token_type: "Bearer", expires_in: 2591999, scope: "read,write" },
  }),
  organization: () => ({
    body: { data: { organization: { id: "lin-org-1", name: "Turnkey" }, viewer: { id: "u1" } } },
  }),
  webhookDelete: () => ({ body: { data: { webhookDelete: { success: true } } } }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Starts a fake Linear API server on port 0. Callers MUST `await close()`
 * (e.g. in `finally`/`afterEach`) — nothing else stops the listener. */
export function startLinearFixture(overrides: LinearFixtureHandlers = {}): LinearFixture {
  const handlers = { ...DEFAULTS, ...overrides };
  const calls: LinearFixtureCall[] = [];

  const app = new Hono();

  app.post("/oauth/token", async (c) => {
    const raw = await c.req.text();
    const form: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
    calls.push({ method: "POST", path: "/oauth/token", authHeader: c.req.header("authorization"), body: form });
    const { status, body } = handlers.oauthToken(form);
    return c.json(body as object, status ?? 200);
  });

  app.post("/graphql", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    calls.push({ method: "POST", path: "/graphql", authHeader: c.req.header("authorization"), body });

    const query = isRecord(body) && typeof body.query === "string" ? body.query : "";
    const variables = isRecord(body) && isRecord(body.variables) ? body.variables : {};
    const { status, body: respBody } = query.includes("webhookDelete")
      ? handlers.webhookDelete(variables)
      : handlers.organization();
    return c.json(respBody as object, status ?? 200);
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const port = listenAddress(server);

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
