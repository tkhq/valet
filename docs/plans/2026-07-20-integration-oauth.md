# Integration OAuth Connect Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users click "Connect" on `/integrations` and complete a real OAuth flow (MCP dynamic-registration or env-configured confidential client), with tokens stored server-side and lazily refreshed.

**Architecture:** Server-side OAuth modeled on `routes/github-connect.ts`: HMAC-signed stateless `state` (PKCE verifier rides inside it), server-side code exchange in a shared callback, tokens written directly into `PgCredentialStore`. Provider metadata comes from a new `CredentialDeclaration.oauth` manifest field. A decorator around the credential store refreshes near-expiry oauth2 tokens on read.

**Tech Stack:** Hono 4 (packages/api), `@valet/sdk`'s MCP OAuth helpers (RFC 8414/7591/7636), Drizzle/PGlite, React 19 + TanStack Query (packages/web), vitest.

Spec: `docs/specs/2026-07-20-integration-oauth-design.md` — read it before starting any task.

## Global Constraints

- Branch `feat/integration-oauth`, PR against `dev-v2`, title prefixed `v2:`. Never merge without user approval.
- Node 22 for all test runs: `source ~/.nvm/nvm.sh && nvm use 22`.
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place; NO new numbered migration files. After schema edits, `rm -rf ~/.valet/pg` locally.
- No `any`, no `as unknown as`, no `@ts-ignore` (CLAUDE.md Type Safety rules). Treat parsed JSON as `unknown` and narrow.
- No Co-Authored-By trailers. Terse commit messages (subject ≤72 chars).
- GitHub keeps its dedicated App flow: the `github` service must never route through the new connect surface or the refresh decorator.
- Secrets never transit the browser: callback persists server-side and redirects; JSON errors from providers are logged, never echoed to the client.

---

### Task 1: Engine — `OAuthDeclaration` manifest field + validation

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (interface at :18-28, validation at :288-300)
- Create: `packages/engine/src/valet-plugin.test.ts`
- Modify: `packages/engine/src/index.ts` (only if `OAuthDeclaration` isn't picked up by an existing `export *` — check `grep -n "valet-plugin" packages/engine/src/index.ts` first; `CredentialDeclaration` is already exported, follow the same path)

**Interfaces:**
- Produces: `OAuthDeclaration` type (exported from `@valet/engine`) and `CredentialDeclaration.oauth?: OAuthDeclaration`. All later tasks consume these exact shapes:

```ts
export type OAuthDeclaration =
  | { mode: "mcp"; serverUrl: string }
  | {
      mode: "authorization_code";
      authorizationUrl: string;
      tokenUrl: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      extraAuthParams?: Record<string, string>;
    };
```

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/valet-plugin.test.ts`:

```ts
/**
 * `validateValetPlugin` — the `CredentialDeclaration.oauth` shapes added by
 * the integration-OAuth design (docs/specs/2026-07-20-integration-oauth-design.md).
 * Base manifest validation is covered by the api's node-modules-loader tests;
 * this file owns only the oauth-field rules.
 */
import { describe, it, expect } from "vitest";
import { validateValetPlugin } from "./valet-plugin.js";

function manifestWith(credential: Record<string, unknown>): Record<string, unknown> {
  return { name: "fixture", version: "0.1.0", credentials: [credential] };
}

describe("validateValetPlugin credential.oauth", () => {
  it("accepts an mcp-mode declaration on an oauth2 credential", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: { mode: "mcp", serverUrl: "https://mcp.example.com/mcp" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an authorization_code-mode declaration with all required fields", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          clientIdEnv: "EXAMPLE_CLIENT_ID",
          clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
          extraAuthParams: { access_type: "offline" },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects oauth on a non-oauth2 credential", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "api_key",
        configKeys: ["apiKey"],
        oauth: { mode: "mcp", serverUrl: "https://mcp.example.com/mcp" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === "credentials[0].oauth")).toBe(true);
    }
  });

  it("rejects an unknown mode", () => {
    const result = validateValetPlugin(
      manifestWith({ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "implicit" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects mcp mode without serverUrl", () => {
    const result = validateValetPlugin(
      manifestWith({ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects authorization_code mode missing any of its four required strings", () => {
    for (const missing of ["authorizationUrl", "tokenUrl", "clientIdEnv", "clientSecretEnv"]) {
      const oauth: Record<string, unknown> = {
        mode: "authorization_code",
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        clientIdEnv: "X_ID",
        clientSecretEnv: "X_SECRET",
      };
      delete oauth[missing];
      const result = validateValetPlugin(
        manifestWith({ type: "oauth2", configKeys: ["accessToken"], oauth }),
      );
      expect(result.ok, `expected rejection when ${missing} missing`).toBe(false);
    }
  });

  it("rejects non-string extraAuthParams values", () => {
    const result = validateValetPlugin(
      manifestWith({
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          clientIdEnv: "X_ID",
          clientSecretEnv: "X_SECRET",
          extraAuthParams: { prompt: 42 },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/engine test -- valet-plugin`
Expected: FAIL — the "rejects" cases fail because `oauth` is currently ignored by validation (accept cases pass; reject cases get `ok: true`).

- [ ] **Step 3: Implement the type + validation**

In `packages/engine/src/valet-plugin.ts`, add above `CredentialDeclaration`:

```ts
/** How the connect UI obtains an oauth2 credential (integration-OAuth design). */
export type OAuthDeclaration =
  | {
      /** MCP OAuth: RFC 8414 discovery + RFC 7591 dynamic registration, PKCE public client. */
      mode: "mcp";
      /** The MCP server URL discovery runs against (same URL the plugin's mcpActionPlugin uses). */
      serverUrl: string;
    }
  | {
      /** Pre-registered confidential client; id/secret come from the host's env. */
      mode: "authorization_code";
      authorizationUrl: string;
      tokenUrl: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      /** Extra authorize-URL params, e.g. Google's access_type=offline&prompt=consent. */
      extraAuthParams?: Record<string, string>;
    };
```

Add to `CredentialDeclaration` (after `connectLabel`):

```ts
  /** How the connect UI obtains this credential via OAuth. Absent = manual token entry only. Only valid on `type: "oauth2"`. */
  oauth?: OAuthDeclaration;
```

In `validateValetPlugin`'s credentials `checkArray` block (after the existing `service` check at :297-299), add:

```ts
    if (cred.oauth !== undefined) {
      const oauth = asRecord(cred.oauth, `${path}.oauth`, issues);
      if (!oauth) return;
      if (cred.type !== "oauth2") {
        issues.push({ path: `${path}.oauth`, message: "only valid on type=\"oauth2\" declarations" });
        return;
      }
      if (oauth.mode === "mcp") {
        if (typeof oauth.serverUrl !== "string" || oauth.serverUrl.length === 0) {
          issues.push({ path: `${path}.oauth.serverUrl`, message: "required non-empty string" });
        }
      } else if (oauth.mode === "authorization_code") {
        for (const key of ["authorizationUrl", "tokenUrl", "clientIdEnv", "clientSecretEnv"] as const) {
          if (typeof oauth[key] !== "string" || oauth[key].length === 0) {
            issues.push({ path: `${path}.oauth.${key}`, message: "required non-empty string" });
          }
        }
        if (oauth.extraAuthParams !== undefined) {
          const params = asRecord(oauth.extraAuthParams, `${path}.oauth.extraAuthParams`, issues);
          if (params && Object.values(params).some((v) => typeof v !== "string")) {
            issues.push({ path: `${path}.oauth.extraAuthParams`, message: "values must be strings" });
          }
        }
      } else {
        issues.push({ path: `${path}.oauth.mode`, message: "must be \"mcp\" or \"authorization_code\"" });
      }
    }
```

Check `packages/engine/src/index.ts` exports `valet-plugin.js` types (it already exports `CredentialDeclaration`); add `OAuthDeclaration` to the same export statement if it enumerates names.

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/engine test -- valet-plugin`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @valet/engine typecheck` — expected clean.

```bash
git add packages/engine/src/valet-plugin.ts packages/engine/src/valet-plugin.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): CredentialDeclaration.oauth manifest field"
```

---

### Task 2: API — `mcp_oauth_clients` table + integration-oauth service

**Files:**
- Modify: `packages/api/src/schema/index.ts` (add table after `credentials` at :753-772)
- Modify: `packages/api/migrations/pg/0000_app.sql` (add table after the `credentials` CREATE TABLE)
- Create: `packages/api/src/services/integration-oauth.ts`
- Create: `packages/api/src/test-helpers/oauth-fixture.ts`
- Create: `packages/api/src/services/integration-oauth.test.ts`

**Interfaces:**
- Consumes: `OAuthDeclaration` from Task 1; `discoverAuthServer`, `registerClient`, `generatePkceChallenge`, `buildAuthorizationUrl`, `exchangeCodePkce`, `refreshTokenPkce`, `TokenResponse` from `@valet/sdk` (already a dependency — verify `@valet/sdk` is in `packages/api/package.json` dependencies; add `"@valet/sdk": "workspace:*"` if missing, plus the tsconfig reference).
- Produces (exact exports of `services/integration-oauth.ts`, used by Tasks 3 and 5):

```ts
import type { AppQueryable } from "../lib/drizzle.js"; // same dep typing as services/github-app.ts's GithubAppDeps.db
export interface OAuthDeps { db: AppQueryable }

export interface McpClientRow {
  service: string; clientId: string;
  authorizationEndpoint: string; tokenEndpoint: string;
}

export function findOAuthDeclaration(
  plugins: ValetPlugin[], service: string,
): { decl: CredentialDeclaration; oauth: OAuthDeclaration } | null

export async function ensureMcpOAuthClient(
  deps: OAuthDeps, service: string, serverUrl: string, redirectUri: string,
): Promise<McpClientRow>

export async function exchangeAuthorizationCode(params: {
  oauth: Extract<OAuthDeclaration, { mode: "authorization_code" }>;
  env: Record<string, string | undefined>;
  code: string; redirectUri: string;
}): Promise<TokenResponse>

export async function refreshAuthorizationCodeToken(params: {
  oauth: Extract<OAuthDeclaration, { mode: "authorization_code" }>;
  env: Record<string, string | undefined>;
  refreshToken: string;
}): Promise<TokenResponse>
```

- [ ] **Step 1: Add the table (schema + migration)**

In `packages/api/src/schema/index.ts`, after the `credentials` table:

```ts
// `mcp_oauth_clients` — one dynamically-registered OAuth client per MCP
// service, shared across all users (integration-OAuth design,
// docs/specs/2026-07-20-integration-oauth-design.md). Never deleted on
// disconnect; if the deployment's public URL changes the registered
// redirect URI goes stale and the recovery is deleting the row.
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  service: text("service").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: text("client_secret_enc"),
  authorizationEndpoint: text("authorization_endpoint").notNull(),
  tokenEndpoint: text("token_endpoint").notNull(),
  registrationEndpoint: text("registration_endpoint"),
  metadata: jsonb("metadata"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

In `packages/api/migrations/pg/0000_app.sql`, after the `credentials` CREATE TABLE block:

```sql
-- One dynamically-registered OAuth client per MCP service, shared across
-- users (integration-OAuth design). client_secret_enc is almost always
-- NULL — MCP registration uses public clients.
CREATE TABLE mcp_oauth_clients (
  service TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  metadata JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

- [ ] **Step 2: Write the fake OAuth provider fixture**

Create `packages/api/src/test-helpers/oauth-fixture.ts` (pattern: `test-helpers/github-fixture.ts` — Hono app on an ephemeral `@hono/node-server` port):

```ts
/**
 * Fake OAuth authorization server for integration-OAuth tests. Serves RFC
 * 8414 discovery, RFC 7591 registration, and a token endpoint that
 * validates PKCE (mcp mode) or client_secret (authorization_code mode).
 * The authorize endpoint is never hit — tests assert the 302 Location
 * instead of following it.
 */
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";

export interface FakeOAuthServer {
  url: string;                      // http://127.0.0.1:{port}
  registrations: Array<{ redirect_uris: string[] }>;
  tokenRequests: Array<Record<string, string>>;
  /** Next token response body (default below). */
  tokenResponse: Record<string, unknown>;
  /** When set, the token endpoint returns this HTTP status with an error body. */
  tokenFailure?: number;
  close(): Promise<void>;
}

export async function startFakeOAuthServer(opts?: { omitRegistration?: boolean }): Promise<FakeOAuthServer> {
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
    }),
  );
  app.post("/register", async (c) => {
    const body = (await c.req.json()) as { redirect_uris: string[] };
    registrations.push({ redirect_uris: body.redirect_uris });
    return c.json({ client_id: `client-${registrations.length}` }, 201);
  });
  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (typeof v === "string") entries[k] = v;
    tokenRequests.push(entries);
    if (state.tokenFailure) return c.json({ error: "invalid_grant" }, state.tokenFailure as 400);
    return c.json(state.tokenResponse);
  });

  const server: ServerType = await new Promise((resolveServer) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveServer(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake oauth server: no port");
  url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    registrations,
    tokenRequests,
    get tokenResponse() { return state.tokenResponse; },
    set tokenResponse(v) { state.tokenResponse = v; },
    get tokenFailure() { return state.tokenFailure; },
    set tokenFailure(v) { state.tokenFailure = v; },
    close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
  };
}
```

(Adjust the `serve` callback signature to exactly match how `test-helpers/github-fixture.ts` starts its server — copy that file's idiom, including its `listenAddress` helper if present.)

- [ ] **Step 3: Write the failing service tests**

Create `packages/api/src/services/integration-oauth.test.ts`:

```ts
/**
 * services/integration-oauth — MCP client registration (idempotent,
 * concurrent-safe) and authorization_code exchange/refresh against the
 * fake provider (test-helpers/oauth-fixture.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import {
  ensureMcpOAuthClient,
  exchangeAuthorizationCode,
  refreshAuthorizationCodeToken,
  findOAuthDeclaration,
} from "./integration-oauth.js";
import type { ValetPlugin } from "@valet/engine";

let fake: FakeOAuthServer;
let testDb: TestPgDb;

beforeEach(async () => {
  fake = await startFakeOAuthServer();
  testDb = await freshTestPgDb();
});
afterEach(async () => {
  await fake.close();
  await testDb.cleanup();
});

describe("ensureMcpOAuthClient", () => {
  it("discovers, registers, persists, and returns the client on first call", async () => {
    const row = await ensureMcpOAuthClient({ db: testDb.appDb }, "linear", fake.url, "https://valet.example/api/credentials/oauth/callback");
    expect(row.clientId).toBe("client-1");
    expect(row.tokenEndpoint).toBe(`${fake.url}/token`);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]?.redirect_uris).toEqual(["https://valet.example/api/credentials/oauth/callback"]);
  });

  it("returns the stored client without re-registering on subsequent calls", async () => {
    await ensureMcpOAuthClient({ db: testDb.appDb }, "linear", fake.url, "https://valet.example/cb");
    const again = await ensureMcpOAuthClient({ db: testDb.appDb }, "linear", fake.url, "https://valet.example/cb");
    expect(again.clientId).toBe("client-1");
    expect(fake.registrations).toHaveLength(1);
  });

  it("converges concurrent first calls onto one stored client", async () => {
    const [a, b] = await Promise.all([
      ensureMcpOAuthClient({ db: testDb.appDb }, "linear", fake.url, "https://valet.example/cb"),
      ensureMcpOAuthClient({ db: testDb.appDb }, "linear", fake.url, "https://valet.example/cb"),
    ]);
    expect(a.clientId).toBe(b.clientId);
  });

  it("throws when discovery reports no registration_endpoint", async () => {
    const bare = await startFakeOAuthServer({ omitRegistration: true });
    try {
      await expect(
        ensureMcpOAuthClient({ db: testDb.appDb }, "linear", bare.url, "https://valet.example/cb"),
      ).rejects.toThrow(/registration/i);
    } finally {
      await bare.close();
    }
  });
});

describe("exchangeAuthorizationCode / refreshAuthorizationCodeToken", () => {
  const oauth = (url: string) => ({
    mode: "authorization_code" as const,
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    clientIdEnv: "TEST_CLIENT_ID",
    clientSecretEnv: "TEST_CLIENT_SECRET",
  });
  const env = { TEST_CLIENT_ID: "cid", TEST_CLIENT_SECRET: "shh" };

  it("form-POSTs grant_type=authorization_code with client id+secret", async () => {
    const tokens = await exchangeAuthorizationCode({
      oauth: oauth(fake.url), env, code: "code-1", redirectUri: "https://valet.example/cb",
    });
    expect(tokens.access_token).toBe("at-1");
    expect(fake.tokenRequests[0]).toMatchObject({
      grant_type: "authorization_code", client_id: "cid", client_secret: "shh",
      code: "code-1", redirect_uri: "https://valet.example/cb",
    });
  });

  it("throws when env vars are missing", async () => {
    await expect(
      exchangeAuthorizationCode({ oauth: oauth(fake.url), env: {}, code: "c", redirectUri: "r" }),
    ).rejects.toThrow(/TEST_CLIENT_ID/);
  });

  it("refresh form-POSTs grant_type=refresh_token", async () => {
    const tokens = await refreshAuthorizationCodeToken({
      oauth: oauth(fake.url), env, refreshToken: "rt-old",
    });
    expect(tokens.access_token).toBe("at-1");
    expect(fake.tokenRequests[0]).toMatchObject({
      grant_type: "refresh_token", client_id: "cid", client_secret: "shh", refresh_token: "rt-old",
    });
  });

  it("throws on a non-2xx token response", async () => {
    fake.tokenFailure = 400;
    await expect(
      exchangeAuthorizationCode({ oauth: oauth(fake.url), env, code: "c", redirectUri: "r" }),
    ).rejects.toThrow(/400/);
  });
});

describe("findOAuthDeclaration", () => {
  const plugin: ValetPlugin = {
    name: "linear", version: "0.1.0",
    credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl: "https://mcp.linear.app/mcp" } }],
  };

  it("finds by defaulted service name and returns the oauth declaration", () => {
    const found = findOAuthDeclaration([plugin], "linear");
    expect(found?.oauth).toEqual({ mode: "mcp", serverUrl: "https://mcp.linear.app/mcp" });
  });

  it("returns null for services without an oauth declaration", () => {
    expect(findOAuthDeclaration([plugin], "slack")).toBeNull();
    expect(findOAuthDeclaration([{ name: "slack", version: "0", credentials: [{ type: "bot_token", configKeys: ["accessToken"] }] }], "slack")).toBeNull();
  });
});
```

Check `packages/api/src/test-helpers/pg-test-db.ts` for the real helper name/shape (it exists; adapt the import and `testDb.appDb`/`cleanup` usage to its actual exports — several service tests in `src/services/*.test.ts` show the idiom, e.g. `github-app.test.ts`).

- [ ] **Step 4: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- integration-oauth`
Expected: FAIL — module `./integration-oauth.js` not found.

- [ ] **Step 5: Implement `services/integration-oauth.ts`**

```ts
/**
 * Integration OAuth mechanics (docs/specs/2026-07-20-integration-oauth-design.md):
 * manifest lookup, MCP dynamic client registration (RFC 8414/7591 via
 * @valet/sdk), and confidential-client code exchange/refresh for
 * authorization_code-mode declarations. Route handling lives in
 * routes/credential-connect.ts; refresh-on-read in
 * plugins/oauth-refreshing-credential-store.ts.
 */
import { eq } from "drizzle-orm";
import type { CredentialDeclaration, OAuthDeclaration, ValetPlugin } from "@valet/engine";
import { discoverAuthServer, registerClient, type TokenResponse } from "@valet/sdk";
import { mcpOauthClients } from "../schema/index.js";

import type { AppQueryable } from "../lib/drizzle.js";

// Same dep typing as services/github-app.ts's GithubAppDeps.db.
export interface OAuthDeps { db: AppQueryable }

export interface McpClientRow {
  service: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** The GitHub service keeps its dedicated App flow (routes/github-connect.ts). */
export const OAUTH_EXCLUDED_SERVICES = new Set(["github"]);

export function findOAuthDeclaration(
  plugins: ValetPlugin[],
  service: string,
): { decl: CredentialDeclaration; oauth: OAuthDeclaration } | null {
  if (OAUTH_EXCLUDED_SERVICES.has(service)) return null;
  for (const plugin of plugins) {
    for (const decl of plugin.credentials ?? []) {
      if ((decl.service ?? plugin.name) !== service) continue;
      if (decl.oauth) return { decl, oauth: decl.oauth };
    }
  }
  return null;
}

export async function ensureMcpOAuthClient(
  deps: OAuthDeps,
  service: string,
  serverUrl: string,
  redirectUri: string,
): Promise<McpClientRow> {
  const existing = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (existing[0]) return toRow(existing[0]);

  const meta = await discoverAuthServer(serverUrl);
  if (!meta.registration_endpoint) {
    throw new Error(`MCP OAuth: ${service} discovery reported no registration_endpoint`);
  }
  const client = await registerClient(meta.registration_endpoint, {
    clientName: "Valet",
    redirectUris: [redirectUri],
  });
  const now = Date.now();
  await deps.db
    .insert(mcpOauthClients)
    .values({
      service,
      clientId: client.client_id,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      registrationEndpoint: meta.registration_endpoint,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  // Re-read: a concurrent registration may have won the insert race — both
  // callers must converge on the single stored client.
  const stored = await deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
  if (!stored[0]) throw new Error(`MCP OAuth: ${service} client row missing after insert`);
  return toRow(stored[0]);
}

function toRow(r: typeof mcpOauthClients.$inferSelect): McpClientRow {
  return {
    service: r.service,
    clientId: r.clientId,
    authorizationEndpoint: r.authorizationEndpoint,
    tokenEndpoint: r.tokenEndpoint,
  };
}

type AuthCodeDecl = Extract<OAuthDeclaration, { mode: "authorization_code" }>;

function resolveClientEnv(oauth: AuthCodeDecl, env: Record<string, string | undefined>): { clientId: string; clientSecret: string } {
  const clientId = env[oauth.clientIdEnv];
  const clientSecret = env[oauth.clientSecretEnv];
  const missing = [!clientId && oauth.clientIdEnv, !clientSecret && oauth.clientSecretEnv].filter(
    (v): v is string => typeof v === "string",
  );
  if (missing.length > 0) throw new Error(`OAuth client env vars not set: ${missing.join(", ")}`);
  // Narrowed by the check above.
  return { clientId: clientId as string, clientSecret: clientSecret as string };
}

export function authCodeEnvReady(oauth: AuthCodeDecl, env: Record<string, string | undefined>): boolean {
  return Boolean(env[oauth.clientIdEnv] && env[oauth.clientSecretEnv]);
}

async function tokenPost(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const payload = (await res.json()) as unknown;
  if (typeof payload !== "object" || payload === null || typeof (payload as { access_token?: unknown }).access_token !== "string") {
    throw new Error("OAuth token response missing access_token");
  }
  return payload as TokenResponse;
}

export async function exchangeAuthorizationCode(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveClientEnv(params.oauth, params.env);
  return tokenPost(params.oauth.tokenUrl, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

export async function refreshAuthorizationCodeToken(params: {
  oauth: AuthCodeDecl;
  env: Record<string, string | undefined>;
  refreshToken: string;
}): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveClientEnv(params.oauth, params.env);
  return tokenPost(params.oauth.tokenUrl, {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: params.refreshToken,
  });
}
```

Fill the `OAuthDeps.db` type from `services/github-app.ts`'s `GithubAppDeps` (same drizzle instance type — do NOT invent a new one). Verify `@valet/sdk`'s package exports: `discoverAuthServer` et al. may live under the `@valet/sdk` main export or a subpath — check `packages/sdk/package.json` `exports` and `packages/sdk/src/index.ts`; the legacy worker imports them from `@valet/sdk` directly (`packages/worker/src/routes/integrations.ts:5-12`). Note the `clientId as string` narrowing comments: keep the explicit missing-check so the assertions are provably safe, or restructure with early throws to avoid `as` entirely (preferred if simple).

- [ ] **Step 6: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- integration-oauth`
Expected: PASS (10 tests)

- [ ] **Step 7: Reset local PGlite (schema changed) and commit**

```bash
rm -rf ~/.valet/pg
git add packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql \
  packages/api/src/services/integration-oauth.ts packages/api/src/services/integration-oauth.test.ts \
  packages/api/src/test-helpers/oauth-fixture.ts packages/api/package.json
git commit -m "feat(api): mcp_oauth_clients table + integration-oauth service"
```

---

### Task 3: API — connect + callback routes

**Files:**
- Create: `packages/api/src/routes/credential-connect.ts`
- Create: `packages/api/src/routes/credential-connect.test.ts`
- Modify: `packages/api/src/app.ts` (mount at `/api/credentials` BEFORE `credentialsRouter`, i.e. above line 166)

**Interfaces:**
- Consumes: Task 2's `findOAuthDeclaration`, `ensureMcpOAuthClient`, `exchangeAuthorizationCode`, `authCodeEnvReady`; `signState`/`verifyState`/`isRecord`/`STATE_TTL_MS` from `lib/oauth-state.js`; `deriveSecretKey` from `lib/secret-crypto.js`; `generatePkceChallenge`/`buildAuthorizationUrl`/`exchangeCodePkce` from `@valet/sdk`; `publicUrlFromEnv` from `channels/host.js`; `c.var.providers.{plugins, engineCredentials, encryptionKey, db}` (same access pattern as `routes/github-connect.ts:65-67,119`).
- Produces: `GET /api/credentials/:service/connect` (302 to provider or JSON error), `GET /api/credentials/oauth/callback` (302 to `/integrations?...`).

State payload shape (signed with `deriveSecretKey(encryptionKey)`, TTL `STATE_TTL_MS`):

```ts
interface OAuthConnectState {
  userId: string;
  service: string;
  codeVerifier?: string; // mcp mode only
  nonce: string;
  exp: number;
}
```

- [ ] **Step 1: Write the failing route tests**

Create `packages/api/src/routes/credential-connect.test.ts`. Boot pattern: `bootTestApi({ plugins })` from `../integration/_setup.js` (see `routes/plugins.test.ts`), fake provider from `../test-helpers/oauth-fixture.js`. Fixture plugins:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import type { ListCredentialsResponse } from "../wire/types.js";

let api: TestApi | undefined;
let fake: FakeOAuthServer;

function mcpPlugin(serverUrl: string): ValetPlugin {
  return {
    name: "linear", version: "0.1.0",
    credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl } }],
  };
}
function authCodePlugin(url: string): ValetPlugin {
  return {
    name: "gmail", version: "0.1.0",
    credentials: [{
      type: "oauth2", configKeys: ["accessToken", "refreshToken"], scopes: ["scope-a"],
      oauth: {
        mode: "authorization_code",
        authorizationUrl: `${url}/authorize`, tokenUrl: `${url}/token`,
        clientIdEnv: "TEST_GOOGLE_ID", clientSecretEnv: "TEST_GOOGLE_SECRET",
        extraAuthParams: { access_type: "offline", prompt: "consent" },
      },
    }],
  };
}

beforeEach(async () => { fake = await startFakeOAuthServer(); });
afterEach(async () => {
  await api?.cleanup(); api = undefined;
  await fake.close();
  delete process.env.TEST_GOOGLE_ID; delete process.env.TEST_GOOGLE_SECRET;
});

describe("GET /api/credentials/:service/connect", () => {
  it("404s for a service with no oauth declaration", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/slack/connect`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("mcp mode: registers a client and 302s to the authorization endpoint with PKCE + signed state", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/linear/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${fake.url}/authorize`);
    expect(location.searchParams.get("client_id")).toBe("client-1");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toContain("/api/credentials/oauth/callback");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("authorization_code mode: 503s with the missing env var names when unconfigured", async () => {
    api = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/gmail/connect`, { redirect: "manual" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { missing?: string[] };
    expect(body.missing).toEqual(["TEST_GOOGLE_ID", "TEST_GOOGLE_SECRET"]);
  });

  it("authorization_code mode: 302s with client_id, scopes, and extraAuthParams", async () => {
    process.env.TEST_GOOGLE_ID = "gid"; process.env.TEST_GOOGLE_SECRET = "gsecret";
    api = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/gmail/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("client_id")).toBe("gid");
    expect(location.searchParams.get("scope")).toBe("scope-a");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("response_type")).toBe("code");
  });

  it("github is never connectable through this surface", async () => {
    api = await bootTestApi({ plugins: [] });
    const res = await fetch(`${api.baseUrl}/api/credentials/github/connect`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/credentials/oauth/callback", () => {
  async function startConnect(baseUrl: string, service: string): Promise<URL> {
    const res = await fetch(`${baseUrl}/api/credentials/${service}/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "");
  }

  it("mcp mode: exchanges the code with the stored PKCE verifier and persists the credential", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=linear");

    // PKCE verifier from the signed state reached the token endpoint.
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", code: "code-1" });
    expect(fake.tokenRequests[0]?.code_verifier).toBeTruthy();

    const list = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await list.json()) as ListCredentialsResponse;
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ service: "linear", type: "oauth2" });
    expect(typeof credentials[0]?.expiresAt).toBe("number"); // expires_in: 3600 mapped
    expect(JSON.stringify(credentials)).not.toContain("at-1");
  });

  it("provider error param redirects to /integrations with the error code", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";
    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=access_denied");
  });

  it("tampered state redirects with error=oauth_state and persists nothing", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    await startConnect(api.baseUrl, "linear");
    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=c&state=forged.state`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_state");
    const list = await fetch(`${api.baseUrl}/api/credentials`);
    expect(((await list.json()) as ListCredentialsResponse).credentials).toHaveLength(0);
  });

  it("token-exchange failure redirects with error=oauth_failed", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";
    fake.tokenFailure = 400;
    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=bad&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_failed");
  });
});
```

Note on the user-mismatch case: `bootTestApi` runs single-user local auth, so the state's `userId` always matches — cover the mismatch branch with a direct unit test of the state-guard function if `bootTestApi` can't produce a second user cheaply (check `_setup.ts` for multi-user options; if none, export the guard `verifyOAuthConnectState` from the route file and unit-test it in the same test file: valid payload, expired `exp`, wrong `userId` given expected).

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- credential-connect`
Expected: FAIL — 404s everywhere (routes not mounted).

- [ ] **Step 3: Implement the router**

Create `packages/api/src/routes/credential-connect.ts`:

```ts
/**
 * Generic integration OAuth connect (docs/specs/2026-07-20-integration-oauth-design.md).
 * Server-side flow modeled on routes/github-connect.ts: HMAC-signed
 * stateless state (lib/oauth-state.ts) carrying the PKCE verifier, code
 * exchange server-side, tokens straight into the credential store — never
 * through the browser. GitHub is excluded (dedicated App flow).
 *
 * Callback auth model matches github-connect: mounted behind the /api/*
 * auth gate (browser session cookie present), and the state's userId must
 * match the session user as defense against replayed state values.
 * Callback failures redirect to /integrations?error=… rather than JSON —
 * the user arrives via a browser navigation, not fetch.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  buildAuthorizationUrl,
  exchangeCodePkce,
  generatePkceChallenge,
} from "@valet/sdk";
import type { AppEnv } from "../env.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { publicUrlFromEnv } from "../channels/host.js";
import {
  authCodeEnvReady,
  ensureMcpOAuthClient,
  exchangeAuthorizationCode,
  findOAuthDeclaration,
} from "../services/integration-oauth.js";

export const credentialConnectRouter = new Hono<AppEnv>();

interface OAuthConnectState {
  userId: string;
  service: string;
  codeVerifier?: string;
  nonce: string;
  exp: number;
}

export function verifyOAuthConnectState(state: string, key: Buffer, nowMs: number): OAuthConnectState | null {
  return verifyState<OAuthConnectState>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, service, codeVerifier, nonce, exp } = payload;
    if (typeof userId !== "string" || typeof service !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (codeVerifier !== undefined && typeof codeVerifier !== "string") return null;
    if (exp < nowMs) return null;
    return { userId, service, codeVerifier, nonce, exp };
  });
}

function callbackUrl(reqUrl: string): string {
  const base = publicUrlFromEnv(process.env) ?? new URL(reqUrl).origin;
  return `${base.replace(/\/+$/, "")}/api/credentials/oauth/callback`;
}

credentialConnectRouter.get("/:service/connect", async (c) => {
  const service = c.req.param("service");
  const user = c.var.user;
  const { plugins, encryptionKey, db } = c.var.providers;

  const found = findOAuthDeclaration(plugins, service);
  if (!found) return c.json({ error: `no OAuth-capable declaration for service "${service}"` }, 404);

  const redirectUri = callbackUrl(c.req.url);
  const key = deriveSecretKey(encryptionKey);
  const base: Omit<OAuthConnectState, "codeVerifier"> = {
    userId: user.id,
    service,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };

  if (found.oauth.mode === "mcp") {
    let clientRow;
    try {
      clientRow = await ensureMcpOAuthClient({ db }, service, found.oauth.serverUrl, redirectUri);
    } catch (err) {
      console.error(`oauth connect: MCP client registration failed for ${service}:`, err);
      return c.redirect("/integrations?error=oauth_failed", 302);
    }
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    const state = signState<OAuthConnectState>({ ...base, codeVerifier }, key);
    const url = buildAuthorizationUrl({
      authorizationEndpoint: clientRow.authorizationEndpoint,
      clientId: clientRow.clientId,
      redirectUri,
      codeChallenge,
      state,
      scopes: found.decl.scopes,
    });
    return c.redirect(url, 302);
  }

  // authorization_code mode
  if (!authCodeEnvReady(found.oauth, process.env)) {
    const missing = [found.oauth.clientIdEnv, found.oauth.clientSecretEnv].filter((name) => !process.env[name]);
    return c.json({ error: "oauth not configured", missing }, 503);
  }
  const state = signState<OAuthConnectState>(base, key);
  const query = new URLSearchParams({
    client_id: process.env[found.oauth.clientIdEnv] ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(found.decl.scopes?.length ? { scope: found.decl.scopes.join(" ") } : {}),
    ...found.oauth.extraAuthParams,
  });
  return c.redirect(`${found.oauth.authorizationUrl}?${query}`, 302);
});

credentialConnectRouter.get("/oauth/callback", async (c) => {
  const user = c.var.user;
  const { plugins, engineCredentials, encryptionKey, db } = c.var.providers;
  const key = deriveSecretKey(encryptionKey);

  const stateParam = c.req.query("state");
  const verified = stateParam ? verifyOAuthConnectState(stateParam, key, Date.now()) : null;
  if (!verified || verified.userId !== user.id) {
    return c.redirect("/integrations?error=oauth_state", 302);
  }

  const providerError = c.req.query("error");
  if (providerError) {
    return c.redirect(`/integrations?error=${encodeURIComponent(providerError)}`, 302);
  }

  const code = c.req.query("code");
  const found = findOAuthDeclaration(plugins, verified.service);
  if (!code || !found) return c.redirect("/integrations?error=oauth_failed", 302);

  const redirectUri = callbackUrl(c.req.url);
  let tokens;
  try {
    if (found.oauth.mode === "mcp") {
      if (!verified.codeVerifier) return c.redirect("/integrations?error=oauth_state", 302);
      const clientRow = await ensureMcpOAuthClient({ db }, verified.service, found.oauth.serverUrl, redirectUri);
      tokens = await exchangeCodePkce({
        tokenEndpoint: clientRow.tokenEndpoint,
        clientId: clientRow.clientId,
        code,
        redirectUri,
        codeVerifier: verified.codeVerifier,
      });
    } else {
      tokens = await exchangeAuthorizationCode({
        oauth: found.oauth,
        env: process.env,
        code,
        redirectUri,
      });
    }
  } catch (err) {
    console.error(`oauth callback: token exchange failed for ${verified.service}:`, err);
    return c.redirect("/integrations?error=oauth_failed", 302);
  }

  const now = Date.now();
  await engineCredentials.save({ type: "user", id: user.id }, verified.service, {
    type: "oauth2",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
    scopes: found.decl.scopes,
    metadata: { connectedVia: "oauth" },
  });

  return c.redirect(`/integrations?connected=${encodeURIComponent(verified.service)}`, 302);
});
```

Mount in `packages/api/src/app.ts` — import `credentialConnectRouter` and add ABOVE the existing credentials mount at line 166:

```ts
app.route("/api/credentials", credentialConnectRouter);
app.route("/api/credentials", credentialsRouter);
```

(Order matters for clarity only — the connect router's routes are `GET /:service/connect` and `GET /oauth/callback`, which don't collide with `credentialsRouter`'s `GET /`, `PUT /:service`, `DELETE /:service` by method+path — but keep connect first so `/oauth/callback` is matched before any future `GET /:service` could shadow it.)

Check `c.var.providers` exposes `db` and `plugins` (it does — `routes/github-connect.ts:119` destructures `db`; `routes/plugins.ts:18` destructures `plugins`). If `verifyOAuthConnectState`'s userId-mismatch branch can't be reached through `bootTestApi`, add the direct unit tests described in Step 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- credential-connect`
Expected: PASS

Also run the neighbors to catch mount regressions:
`pnpm --filter @valet/api test -- src/routes/credentials.test.ts src/routes/plugins.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/credential-connect.ts packages/api/src/routes/credential-connect.test.ts packages/api/src/app.ts
git commit -m "feat(api): OAuth connect + callback routes for integrations"
```

---

### Task 4: API — `/api/plugins` reports `connect: "oauth" | "manual"`

**Files:**
- Modify: `packages/api/src/wire/types.ts` (`PluginServiceSummary` at :764-777)
- Modify: `packages/api/src/routes/plugins.ts` (:34-45)
- Modify: `packages/api/src/routes/plugins.test.ts`

**Interfaces:**
- Consumes: Task 2's `findOAuthDeclaration`, `authCodeEnvReady`.
- Produces: `PluginServiceSummary.connect: "oauth" | "manual"` — Task 6 (web) renders on this.

- [ ] **Step 1: Write the failing test**

In `packages/api/src/routes/plugins.test.ts`, add a describe block (reuse the file's existing `bootTestApi` + fixture-plugin idiom):

```ts
describe("GET /api/plugins connect mode", () => {
  it("reports oauth for mcp-mode declarations and manual otherwise", async () => {
    const plugins: ValetPlugin[] = [
      {
        name: "linear", version: "0.1.0",
        credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl: "https://mcp.linear.app/mcp" } }],
      },
      { name: "slack", version: "0.1.0", credentials: [{ type: "bot_token", configKeys: ["accessToken"] }] },
    ];
    api = await bootTestApi({ plugins });
    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins: summaries } = (await res.json()) as ListPluginsResponse;
    const linear = summaries.find((p) => p.name === "linear")?.services[0];
    const slack = summaries.find((p) => p.name === "slack")?.services[0];
    expect(linear?.connect).toBe("oauth");
    expect(slack?.connect).toBe("manual");
  });

  it("reports manual for authorization_code declarations whose env vars are unset", async () => {
    const plugins: ValetPlugin[] = [{
      name: "gmail", version: "0.1.0",
      credentials: [{
        type: "oauth2", configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientIdEnv: "UNSET_TEST_ID", clientSecretEnv: "UNSET_TEST_SECRET",
        },
      }],
    }];
    api = await bootTestApi({ plugins });
    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins: summaries } = (await res.json()) as ListPluginsResponse;
    expect(summaries.find((p) => p.name === "gmail")?.services[0]?.connect).toBe("manual");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- src/routes/plugins.test.ts`
Expected: FAIL — `connect` is `undefined`.

- [ ] **Step 3: Implement**

`packages/api/src/wire/types.ts` — add to `PluginServiceSummary`:

```ts
  /** How the connect UI obtains this credential: "oauth" renders a Connect
   * redirect button; "manual" renders token entry. authorization_code-mode
   * declarations report "manual" when their client env vars are unset so
   * the UI never renders a Connect button that would 503. */
  connect: "oauth" | "manual";
```

`packages/api/src/routes/plugins.ts` — import from `../services/integration-oauth.js` and compute inside the services map (:34-45):

```ts
    const services: PluginServiceSummary[] = (plugin.credentials ?? []).map((decl) => {
      const service = decl.service ?? plugin.name;
      const found = findOAuthDeclaration(plugins, service);
      const oauthReady =
        found !== null &&
        (found.oauth.mode === "mcp" || authCodeEnvReady(found.oauth, process.env));
      return {
        service,
        type: decl.type,
        scopes: decl.scopes,
        connectLabel: decl.connectLabel,
        configKeys: decl.configKeys,
        connected: connectedServices.has(service),
        dynamic: dynamicServices.has(service) ? true : undefined,
        connect: oauthReady ? "oauth" : "manual",
      };
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- src/routes/plugins.test.ts`
Expected: PASS (existing tests may need `connect` added to any exact-equality assertions — fix those, don't weaken them).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/wire/types.ts packages/api/src/routes/plugins.ts packages/api/src/routes/plugins.test.ts
git commit -m "feat(api): plugins route reports connect mode per service"
```

---

### Task 5: API — refresh-on-read credential store decorator

**Files:**
- Create: `packages/api/src/plugins/oauth-refreshing-credential-store.ts`
- Create: `packages/api/src/plugins/oauth-refreshing-credential-store.test.ts`
- Modify: `packages/api/src/providers/node.ts` (wrap `engineCredentials` after plugin assembly, ~:185-200)

**Interfaces:**
- Consumes: `CredentialStore`, `StoredCredential`, `CredentialOwner`, `ValetPlugin` from `@valet/engine`; Task 2's `findOAuthDeclaration`, `refreshAuthorizationCodeToken`; `refreshTokenPkce` from `@valet/sdk`; `mcpOauthClients` schema.
- Produces:

```ts
export class OAuthRefreshingCredentialStore implements CredentialStore {
  constructor(inner: CredentialStore, deps: {
    db: AppQueryable; // import type { AppQueryable } from "../lib/drizzle.js"
    plugins: ValetPlugin[];
    env: Record<string, string | undefined>;
    now?: () => number;           // test seam, defaults to Date.now
  })
}
```

Behavior contract:
- `get()` refreshes only when: stored `type === "oauth2"`, `refreshToken` present, `expiresAt` present and `expiresAt - now() < 60_000`, service has an oauth declaration (`findOAuthDeclaration` non-null — this also excludes `github` via `OAUTH_EXCLUDED_SERVICES`).
- Successful refresh persists via `inner.save` with new `accessToken`/`expiresAt`, preserving the old `refreshToken` when the response omits one and clearing any `metadata.refreshFailedAt`; returns the fresh credential.
- Failed refresh stamps `metadata.refreshFailedAt: now()` (persisted via `inner.save`) and returns the stored credential unchanged otherwise.
- `save`/`delete`/`list` delegate untouched.

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/plugins/oauth-refreshing-credential-store.test.ts`. Use an in-memory `CredentialStore` fake (a `Map`-backed literal implementing the four methods), the fake OAuth server for the token endpoint, and a fixed `now`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CredentialStore, CredentialOwner, StoredCredential, ValetPlugin } from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import { mcpOauthClients } from "../schema/index.js";
import { OAuthRefreshingCredentialStore } from "./oauth-refreshing-credential-store.js";

const OWNER: CredentialOwner = { type: "user", id: "u1" };
const NOW = 1_800_000_000_000;

function memoryStore(): CredentialStore & { rows: Map<string, StoredCredential> } {
  const rows = new Map<string, StoredCredential>();
  return {
    rows,
    async get(owner, service) { return rows.get(`${owner.type}:${owner.id}:${service}`) ?? null; },
    async save(owner, service, credential) { rows.set(`${owner.type}:${owner.id}:${service}`, credential); },
    async delete(owner, service) { rows.delete(`${owner.type}:${owner.id}:${service}`); },
    async list() { return []; },
  };
}

let fake: FakeOAuthServer;
let testDb: TestPgDb;
beforeEach(async () => { fake = await startFakeOAuthServer(); testDb = await freshTestPgDb(); });
afterEach(async () => { await fake.close(); await testDb.cleanup(); });

function mcpPlugins(): ValetPlugin[] {
  return [{
    name: "linear", version: "0.1.0",
    credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl: fake.url } }],
  }];
}

async function seedMcpClient(): Promise<void> {
  await testDb.appDb.insert(mcpOauthClients).values({
    service: "linear", clientId: "client-1",
    authorizationEndpoint: `${fake.url}/authorize`, tokenEndpoint: `${fake.url}/token`,
    createdAt: NOW, updatedAt: NOW,
  });
}

describe("OAuthRefreshingCredentialStore", () => {
  it("returns non-expiring credentials untouched", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "fresh", refreshToken: "rt", expiresAt: NOW + 3_600_000 });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("fresh");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refreshes an mcp credential expiring within 60s and persists the new tokens", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt-old", expiresAt: NOW + 30_000 });
    fake.tokenResponse = { access_token: "at-new", expires_in: 3600 }; // no refresh_token in response
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("at-new");
    expect(got?.refreshToken).toBe("rt-old"); // preserved when response omits one
    expect(got?.expiresAt).toBe(NOW + 3_600_000);
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-old", client_id: "client-1" });
    expect((await inner.get(OWNER, "linear"))?.accessToken).toBe("at-new"); // persisted
  });

  it("stamps metadata.refreshFailedAt and returns the stored credential on refresh failure", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt", expiresAt: NOW + 30_000 });
    fake.tokenFailure = 400;
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("stale");
    const persisted = await inner.get(OWNER, "linear");
    expect(persisted?.metadata?.refreshFailedAt).toBe(NOW);
  });

  it("never refreshes github (excluded service)", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "github", { type: "oauth2", accessToken: "gh", refreshToken: "rt", expiresAt: NOW + 1_000 });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    const got = await store.get(OWNER, "github");
    expect(got?.accessToken).toBe("gh");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("skips credentials without a refreshToken or without expiresAt", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "no-rt", expiresAt: NOW + 1_000 });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    expect((await store.get(OWNER, "linear"))?.accessToken).toBe("no-rt");
    expect(fake.tokenRequests).toHaveLength(0);
  });
});
```

Add one authorization_code-mode refresh test mirroring the mcp success case: plugin declared with `mode: "authorization_code"`, `env: { X_ID: "cid", X_SECRET: "shh" }` passed to the decorator, assert `client_secret: "shh"` reached the fake token endpoint.

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- oauth-refreshing`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the decorator**

Create `packages/api/src/plugins/oauth-refreshing-credential-store.ts`:

```ts
/**
 * CredentialStore decorator: lazily refreshes near-expiry oauth2
 * credentials on read (integration-OAuth design). Refresh routes by the
 * service's manifest declaration — mcp mode via the stored registered
 * client (mcp_oauth_clients) + refreshTokenPkce, authorization_code mode
 * via the declaration's tokenUrl + env client id/secret. GitHub never
 * routes through here (its refresh lives in services/github-tokens.ts) —
 * findOAuthDeclaration excludes it. Refresh failure stamps
 * metadata.refreshFailedAt (the health field the credential summary
 * already whitelists) and returns the stored credential: the caller gets
 * the provider's own 401 and the UI shows the unhealthy badge.
 */
import { eq } from "drizzle-orm";
import type { CredentialOwner, CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { refreshTokenPkce, type TokenResponse } from "@valet/sdk";
import { mcpOauthClients } from "../schema/index.js";
import { findOAuthDeclaration, refreshAuthorizationCodeToken } from "../services/integration-oauth.js";

const REFRESH_BUFFER_MS = 60_000;

interface Deps {
  db: AppQueryable;
  plugins: ValetPlugin[];
  env: Record<string, string | undefined>;
  now?: () => number;
}

export class OAuthRefreshingCredentialStore implements CredentialStore {
  constructor(private readonly inner: CredentialStore, private readonly deps: Deps) {}

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const stored = await this.inner.get(owner, service);
    if (!stored) return null;
    if (stored.type !== "oauth2" || !stored.refreshToken || stored.expiresAt === undefined) return stored;
    const now = (this.deps.now ?? Date.now)();
    if (stored.expiresAt - now >= REFRESH_BUFFER_MS) return stored;
    const found = findOAuthDeclaration(this.deps.plugins, service);
    if (!found) return stored;

    let tokens: TokenResponse;
    try {
      if (found.oauth.mode === "mcp") {
        const rows = await this.deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
        const client = rows[0];
        if (!client) throw new Error(`no registered MCP client for ${service}`);
        tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: stored.refreshToken,
        });
      } else {
        tokens = await refreshAuthorizationCodeToken({
          oauth: found.oauth,
          env: this.deps.env,
          refreshToken: stored.refreshToken,
        });
      }
    } catch (err) {
      console.error(`credential refresh failed for ${service}:`, err);
      const stamped: StoredCredential = {
        ...stored,
        metadata: { ...stored.metadata, refreshFailedAt: now },
      };
      await this.inner.save(owner, service, stamped);
      return stored;
    }

    const { refreshFailedAt: _cleared, ...restMetadata } = stored.metadata ?? {};
    const fresh: StoredCredential = {
      ...stored,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
      metadata: Object.keys(restMetadata).length > 0 ? restMetadata : undefined,
    };
    await this.inner.save(owner, service, fresh);
    return fresh;
  }

  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    return this.inner.save(owner, service, credential);
  }
  delete(owner: CredentialOwner, service: string): Promise<void> {
    return this.inner.delete(owner, service);
  }
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return this.inner.list(owner);
  }
}
```

- [ ] **Step 4: Wire into `providers/node.ts`**

Move the `const engineCredentials = new PgCredentialStore(...)` construction (currently ~:185) to AFTER the plugin assembly block (~:190-200), then wrap:

```ts
  const baseCredentials = new PgCredentialStore(pgdb, deriveSecretKey(opts.encryptionKey));
  // ... (plugin assembly unchanged, produces `plugins`) ...
  const engineCredentials = new OAuthRefreshingCredentialStore(baseCredentials, {
    db,
    plugins,
    env: process.env,
  });
```

Everything downstream (`EngineHost`, `ChannelHost`, workflow deps, prebuilds, `providers.engineCredentials`) keeps using `engineCredentials` unchanged. Do NOT wire the decorator into `integration/_setup.ts` — route tests exercise it only where a test opts in; the decorator is a no-op for credentials without `expiresAt`/`refreshToken` anyway.

- [ ] **Step 5: Run tests**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- oauth-refreshing && pnpm --filter @valet/api typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/plugins/oauth-refreshing-credential-store.ts \
  packages/api/src/plugins/oauth-refreshing-credential-store.test.ts packages/api/src/providers/node.ts
git commit -m "feat(api): lazy oauth2 refresh via credential store decorator"
```

---

### Task 6: Plugin manifests — declare `oauth` across the fleet

**Files:**
- Modify: `packages/plugin-linear/src/plugin.ts`, `packages/plugin-notion/src/plugin.ts`, `packages/plugin-sentry/src/plugin.ts`, `packages/plugin-stripe/src/plugin.ts`, `packages/plugin-cloudflare/src/plugin.ts`, `packages/plugin-figma/src/plugin.ts` (mcp mode)
- Modify: `packages/plugin-gmail/src/plugin.ts`, `packages/plugin-google-calendar/src/plugin.ts`, `packages/plugin-google-drive/src/plugin.ts`, `packages/plugin-google-sheets/src/plugin.ts` (authorization_code mode)

**Interfaces:**
- Consumes: Task 1's `OAuthDeclaration` via `CredentialDeclaration.oauth`.
- Produces: fleet manifests the connect routes and `/api/plugins` resolve at runtime.

- [ ] **Step 1: MCP plugins**

For each of the six MCP plugins, extend the credential declaration with an `oauth` field whose `serverUrl` is **exactly the same string** as the plugin's `mcpActionPlugin({ mcpUrl: ... })`. Example for linear (`packages/plugin-linear/src/plugin.ts`):

```ts
  credentials: [
    {
      type: 'oauth2',
      configKeys: ['accessToken'],
      oauth: { mode: 'mcp', serverUrl: 'https://mcp.linear.app/mcp' },
    },
  ],
```

The other five follow identically with their own URLs (`https://mcp.notion.com/mcp`, `https://mcp.sentry.dev/mcp`, `https://mcp.stripe.com/mcp`, `https://mcp.cloudflare.com/mcp`, `https://mcp.figma.com/mcp`). Figma: confirm its credential is `oauth2` (it is — plugin.ts:15). Do NOT touch typefully (api_key) or deepwiki (no credentials).

- [ ] **Step 2: Google plugins**

For each of the four Google plugins, add to the existing oauth2 credential declaration (keep each plugin's existing `scopes` list untouched):

```ts
      oauth: {
        mode: 'authorization_code',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      },
```

Check each file's actual credential array shape first (gmail declares scopes + `["accessToken","refreshToken"]` configKeys; the others vary) — add only the `oauth` key, change nothing else.

- [ ] **Step 3: Typecheck everything**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm typecheck`
Expected: clean. (Plugin packages typecheck against the rebuilt engine — if stale-dist errors appear, `pnpm --filter @valet/engine build` first.)

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-linear packages/plugin-notion packages/plugin-sentry packages/plugin-stripe \
  packages/plugin-cloudflare packages/plugin-figma packages/plugin-gmail packages/plugin-google-calendar \
  packages/plugin-google-drive packages/plugin-google-sheets
git commit -m "feat(plugins): declare oauth connect metadata across the fleet"
```

---

### Task 7: Web — Connect button, manual fallback, result toast

**Files:**
- Modify: `packages/web/src/components/integrations/integration-row.tsx` (`ServiceBlock` at :113-156, header comment at :10)
- Modify: `packages/web/src/routes/integrations.tsx` (header comment at :12-13, page component)
- Modify: `packages/web/src/routes/-integrations.test.tsx`

**Interfaces:**
- Consumes: `PluginServiceSummary.connect` from Task 4 (the type flows via `@valet/api/wire`).
- Produces: user-facing connect UX; no new exports.

- [ ] **Step 1: Write the failing tests**

Read `packages/web/src/routes/-integrations.test.tsx` first and extend its existing mock fixtures (it mocks `~/api/integrations`). Add tests:

```tsx
it("renders an anchor Connect button pointing at the connect route when connect is oauth", () => {
  // fixture service: { service: "linear", type: "oauth2", configKeys: ["accessToken"], connected: false, connect: "oauth" }
  render(<IntegrationsPage />);
  const link = screen.getByRole("link", { name: "Connect" });
  expect(link.getAttribute("href")).toBe("/api/credentials/linear/connect");
});

it("oauth services still offer manual token entry behind a secondary toggle", () => {
  render(<IntegrationsPage />);
  fireEvent.click(screen.getByRole("button", { name: "Enter token manually" }));
  expect(screen.getByText(/Access token/)).toBeTruthy();
});

it("manual services render the token-entry Connect button, not an anchor", () => {
  // fixture service with connect: "manual"
  render(<IntegrationsPage />);
  expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
});

it("shows a success notice for ?connected= and an error notice for ?error=", () => {
  // The page reads window.location.search — set it via history.replaceState
  window.history.replaceState(null, "", "/integrations?connected=linear");
  render(<IntegrationsPage />);
  expect(screen.getByText(/Connected linear/i)).toBeTruthy();
  window.history.replaceState(null, "", "/integrations?error=access_denied");
  render(<IntegrationsPage />);
  expect(screen.getByText(/access_denied/)).toBeTruthy();
});
```

Every existing fixture `PluginServiceSummary` in the test file gains the now-required `connect` field (`"manual"` unless the test says otherwise) — the wire type change makes this a compile error, which is the point.

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/web test -- integrations`
Expected: FAIL (new assertions; possibly compile errors from the required `connect` field — fix fixtures, keep new tests failing on behavior).

- [ ] **Step 3: Implement**

`integration-row.tsx` — in `ServiceBlock`, branch the not-connected affordance on `service.connect`:

```tsx
  const right = service.connected ? (
    /* unchanged Connected/Disconnect block */
  ) : service.connect === "oauth" ? (
    <Button size="sm" asChild>
      <a href={`/api/credentials/${encodeURIComponent(service.service)}/connect`}>Connect</a>
    </Button>
  ) : (
    <Button size="sm" onClick={() => setRevealed((r) => !r)}>
      Connect
    </Button>
  );
```

(If the `Button` primitive has no `asChild`, render a plain styled `<a>` — check `~/components/primitives`' Button implementation and match existing anchor-button usage elsewhere in the app, e.g. grep for `asChild` or `<a` inside Button.)

Below the heading, for oauth-mode unconnected services add the manual fallback toggle:

```tsx
  {!service.connected && service.connect === "oauth" && (
    <button
      type="button"
      className="mt-1 text-xs text-muted underline-offset-2 hover:underline"
      onClick={() => setRevealed((r) => !r)}
    >
      Enter token manually
    </button>
  )}
  {revealed && !service.connected && <ConnectForm service={service} onClose={() => setRevealed(false)} />}
```

Update the header comment (:10-13): manual-only note becomes "OAuth connect for services declaring `oauth` metadata; manual token entry remains the fallback."

`integrations.tsx` — read the search params once on mount, render a dismissible notice, strip params (TanStack Router's `useSearch` needs a `validateSearch` on the route; simpler and consistent with the test approach: read `window.location.search` in a `useState` initializer and `window.history.replaceState` to strip):

```tsx
function useConnectResult(): { kind: "connected" | "error"; value: string } | null {
  const [result] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return null;
    window.history.replaceState(null, "", window.location.pathname);
    return connected
      ? ({ kind: "connected", value: connected } as const)
      : ({ kind: "error", value: error ?? "" } as const);
  });
  return result;
}
```

Render above the sections:

```tsx
  {connectResult?.kind === "connected" && (
    <div className="mt-4 rounded border border-moss/30 bg-moss/10 px-3 py-2 text-sm text-ink">
      Connected {connectResult.value}.
    </div>
  )}
  {connectResult?.kind === "error" && (
    <div className="mt-4 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600">
      Connection failed: {connectResult.value}
    </div>
  )}
```

Also invalidate the plugins query when `connected` is present so the row shows Connected without a manual reload (`useQueryClient().invalidateQueries({ queryKey: qkIntegrations.plugins() })` in a `useEffect` gated on `connectResult`) — though the full-page navigation means the initial fetch is already fresh; add it only if the test proves staleness, otherwise skip (YAGNI).

- [ ] **Step 4: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/web test`
Expected: PASS (full web suite — the wire-type change touches other fixtures too; fix any compile fallout).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/integrations/integration-row.tsx \
  packages/web/src/routes/integrations.tsx packages/web/src/routes/-integrations.test.tsx
git commit -m "feat(web): OAuth Connect button + result notice on /integrations"
```

---

### Task 8: Full verification + spec cross-links

**Files:**
- Modify: `docs/specs/2026-07-14-auth-v2-design.md` (the section deferring integration OAuth — add a pointer to `2026-07-20-integration-oauth-design.md`)
- Modify: `docs/specs/2026-07-20-integration-oauth-design.md` (status → implemented; note any deviations discovered during implementation)
- Modify: `packages/api/src/routes/credentials.ts` + `packages/web/src/routes/integrations.tsx` header comments if any still claim "OAuth out of scope"

**Steps:**

- [ ] **Step 1: Full typecheck + test sweep**

```bash
source ~/.nvm/nvm.sh && nvm use 22
pnpm typecheck
pnpm --filter @valet/engine test
pnpm --filter @valet/api test
pnpm --filter @valet/web test
```

Expected: all clean/green. Fix anything that isn't before proceeding.

- [ ] **Step 2: Manual smoke against dev-local**

`rm -rf ~/.valet/pg` (schema changed), then `make dev-local`. On `http://localhost:5173/integrations`: Linear/Notion rows show a Connect button; Google rows show manual entry (no `GOOGLE_CLIENT_ID` set locally) — screenshot-level check only; the real end-to-end OAuth pass against a live provider is a human-in-the-loop item before merge.

- [ ] **Step 3: Update spec cross-links and stale comments, commit**

```bash
git add docs/specs packages/api/src/routes/credentials.ts packages/web/src/routes/integrations.tsx
git commit -m "docs(specs): integration oauth implemented; cross-link auth-v2"
```

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feat/integration-oauth
gh pr create --base dev-v2 --title "v2: Integration OAuth connect flow" --body "..."
```

PR body: link the spec, list the two modes, call out the schema change (`rm -rf ~/.valet/pg` needed locally after merge) and the owed live-provider browser pass. Do NOT merge — user decision.
