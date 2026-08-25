/**
 * Fake OAuth authorization server for integration-OAuth tests (Task 2).
 * A real Hono app on port 0 — mirrors `test-helpers/github-fixture.ts`'s
 * pattern. Serves RFC 8414 discovery, RFC 7591 registration, and a token
 * endpoint that records every request. The authorize endpoint is never hit —
 * tests assert the 302 Location instead of following it.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface FakeOAuthServer {
  url: string; // http://127.0.0.1:{port}
  registrations: Array<{ redirect_uris: string[]; scope?: string }>;
  tokenRequests: Array<Record<string, string>>;
  /** Next token response body (default below). */
  tokenResponse: Record<string, unknown>;
  /** When set, the token endpoint returns this HTTP status with an error body. */
  tokenFailure?: number;
  close(): Promise<void>;
}

function listenAddress(server: ServerType): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

/** Starts a fake OAuth authorization server on port 0. Callers MUST `await
 * close()` (e.g. in `finally`/`afterEach`) — nothing else stops the listener. */
export function startFakeOAuthServer(opts?: {
  omitRegistration?: boolean;
  /** When set, discovery advertises these as `scopes_supported`. */
  scopesSupported?: string[];
}): FakeOAuthServer {
  const registrations: FakeOAuthServer["registrations"] = [];
  const tokenRequests: FakeOAuthServer["tokenRequests"] = [];
  const state: { tokenResponse: Record<string, unknown>; tokenFailure?: number } = {
    tokenResponse: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "bearer" },
  };

  const app = new Hono();
  let url = "";

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      authorization_endpoint: `${url}/authorize`,
      token_endpoint: `${url}/token`,
      ...(opts?.omitRegistration ? {} : { registration_endpoint: `${url}/register` }),
      ...(opts?.scopesSupported ? { scopes_supported: opts.scopesSupported } : {}),
    }),
  );

  app.post("/register", async (c) => {
    const body = (await c.req.json()) as { redirect_uris: string[]; scope?: string };
    registrations.push({
      redirect_uris: body.redirect_uris,
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    });
    return c.json({ client_id: `client-${registrations.length}` }, 201);
  });

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (typeof v === "string") entries[k] = v;
    tokenRequests.push(entries);
    if (state.tokenFailure) {
      return c.json({ error: "invalid_grant" }, state.tokenFailure as ContentfulStatusCode);
    }
    return c.json(state.tokenResponse);
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const port = listenAddress(server);
  url = `http://127.0.0.1:${port}`;

  return {
    url,
    registrations,
    tokenRequests,
    get tokenResponse() {
      return state.tokenResponse;
    },
    set tokenResponse(v) {
      state.tokenResponse = v;
    },
    get tokenFailure() {
      return state.tokenFailure;
    },
    set tokenFailure(v) {
      state.tokenFailure = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
