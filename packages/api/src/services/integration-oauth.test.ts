/**
 * services/integration-oauth — MCP client registration (idempotent,
 * concurrent-safe) and authorization_code exchange/refresh against the
 * fake provider (test-helpers/oauth-fixture.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import {
  ensureMcpOAuthClient,
  exchangeAuthorizationCode,
  refreshAuthorizationCodeToken,
  findOAuthDeclaration,
  exchangeAuthorizationCodeRaw,
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

describe("exchangeAuthorizationCodeRaw", () => {
  const DECL = {
    mode: "authorization_code" as const,
    authorizationUrl: "https://slack.test/authorize",
    tokenUrl: "https://slack.test/oauth.v2.access",
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
  };
  const ENV = { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "secret" };

  afterEach(() => vi.unstubAllGlobals());

  it("returns the parsed JSON without requiring top-level access_token", async () => {
    const body = { ok: true, authed_user: { id: "U1", access_token: "xoxp-1", scope: "chat:write" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const raw = await exchangeAuthorizationCodeRaw({ oauth: DECL, env: ENV, code: "c", redirectUri: "https://api.test/cb" });
    expect(raw).toEqual(body);
  });

  it("throws on a non-2xx token response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(
      exchangeAuthorizationCodeRaw({ oauth: DECL, env: ENV, code: "c", redirectUri: "https://api.test/cb" }),
    ).rejects.toThrow(/token request failed/);
  });
});
