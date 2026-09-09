/**
 * `/api/credentials` — manual token entry (plugin-system-v2 plan Task 15).
 * PUT→GET round trip never leaks token material; DELETE flips it back;
 * validation 400s for malformed bodies; unauth 401s (same pattern as
 * `plugins.test.ts` — flip `VALET_LOCAL_AUTH` off for one request).
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { contentSources, orgMembers, users } from "../schema/index.js";
import { createContentSource } from "../services/content-sources.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "../services/onepassword.js";
import { addMember, createTeam } from "../services/teams.js";
import { startSlackFixture, type SlackFixture } from "../test-helpers/slack-fixture.js";
import type { ListCredentialsResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

class FakeOnePasswordService implements OnePasswordService {
  findCandidates = async (): Promise<never[]> => [];
  resolveCalls: { scope: OnePasswordScope; reference: string }[] = [];
  /** Set to make `resolveReference` throw for the next/every call. */
  failWith: Error | undefined;

  async tokenConnected(): Promise<boolean> {
    return true;
  }
  async listVaults() {
    return [];
  }
  async listItems() {
    return [];
  }
  async getItem(): Promise<never> {
    throw new Error("not used in credentials.test.ts");
  }
  async resolveReference(scope: OnePasswordScope, _ctx: OnePasswordCtx, reference: string): Promise<string> {
    this.resolveCalls.push({ scope, reference });
    if (this.failWith) throw this.failWith;
    return "resolved-secret";
  }
  async findCredentialForService(): Promise<string | null> {
    return null;
  }

  async resolveCredential(row: Parameters<OnePasswordService["resolveCredential"]>[0]) {
    return row;
  }
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("PUT /api/credentials/:service", () => {
  it("saves an api_key credential and GET reports it connected without leaking the token", async () => {
    api = await bootTestApi();

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "ghp_supersecret" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const get = await fetch(`${api.baseUrl}/api/credentials`);
    expect(get.status).toBe(200);
    const { credentials } = (await get.json()) as ListCredentialsResponse;
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ service: "github", type: "api_key" });
    expect(typeof credentials[0]?.connectedAt).toBe("string");

    expect(JSON.stringify(credentials)).not.toContain("ghp_supersecret");
  });

  it("saves an oauth2 credential with accessToken + refreshToken", async () => {
    api = await bootTestApi();

    const put = await fetch(`${api.baseUrl}/api/credentials/slack`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "oauth2", accessToken: "xoxb-token", refreshToken: "xoxr-refresh" }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await get.json()) as ListCredentialsResponse;
    expect(credentials.find((c) => c.service === "slack")).toMatchObject({ service: "slack", type: "oauth2" });
    expect(JSON.stringify(credentials)).not.toContain("xoxb-token");
    expect(JSON.stringify(credentials)).not.toContain("xoxr-refresh");
  });

  it("400s when neither accessToken nor apiKey is present", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when both accessToken and apiKey are present", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", accessToken: "a", apiKey: "b" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on an unrecognized type", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "carrier-pigeon", apiKey: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when refreshToken is present on a non-oauth2 credential", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "x", refreshToken: "y" }),
    });
    expect(res.status).toBe(400);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/credentials/github`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api_key", apiKey: "x" }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("DELETE /api/credentials/:service", () => {
  it("removes a saved credential — GET no longer lists it", async () => {
    api = await bootTestApi();

    await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "ghp_supersecret" }),
    });

    const del = await fetch(`${api.baseUrl}/api/credentials/github`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const get = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await get.json()) as ListCredentialsResponse;
    expect(credentials.find((c) => c.service === "github")).toBeUndefined();
  });

  it("200s (idempotent) deleting a service that was never connected", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/credentials/never-connected`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/credentials/github`, { method: "DELETE" });
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

describe("PUT/DELETE/GET /api/credentials — org scope", () => {
  it("PUT with scope:\"org\" as an admin saves under the org owner", async () => {
    api = await bootTestApi();

    const put = await fetch(`${api.baseUrl}/api/credentials/telegram`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bot_token", accessToken: "123:abc", scope: "org" }),
    });
    expect(put.status).toBe(200);

    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "telegram");
    expect(stored).toMatchObject({ type: "bot_token", accessToken: "123:abc" });
  });

  it("PUT with scope:\"org\" as a non-admin member 403s", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/credentials/telegram`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ type: "bot_token", accessToken: "123:abc", scope: "org" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("GET ?scope=org as admin includes the org credential; as member 403s", async () => {
    api = await bootTestApi();

    await fetch(`${api.baseUrl}/api/credentials/telegram`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bot_token", accessToken: "123:abc", scope: "org" }),
    });

    const asAdmin = await fetch(`${api.baseUrl}/api/credentials?scope=org`);
    expect(asAdmin.status).toBe(200);
    const { credentials } = (await asAdmin.json()) as ListCredentialsResponse;
    expect(credentials.map((c) => c.service)).toContain("telegram");

    const asMember = await fetch(`${api.baseUrl}/api/credentials?scope=org`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(asMember.status).toBe(403);
    expect(await asMember.json()).toEqual({ error: "org admin required" });
  });

  it("DELETE ?scope=org as admin removes the org credential", async () => {
    api = await bootTestApi();

    await fetch(`${api.baseUrl}/api/credentials/telegram`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bot_token", accessToken: "123:abc", scope: "org" }),
    });

    const del = await fetch(`${api.baseUrl}/api/credentials/telegram?scope=org`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "telegram");
    expect(stored).toBeNull();
  });

  it("org_members admin with users.role=member can write org credentials", async () => {
    api = await bootTestApi();
    await api.providers.db.update(users).set({ role: "member" }).where(eq(users.id, "test-admin"));
    const headers = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };

    const put = await fetch(`${api.baseUrl}/api/credentials/telegram`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ type: "bot_token", accessToken: "123:abc", scope: "org" }),
    });
    expect(put.status).toBe(200);

    const listed = await fetch(`${api.baseUrl}/api/credentials?scope=org`, { headers });
    expect(listed.status).toBe(200);
    const { credentials } = (await listed.json()) as ListCredentialsResponse;
    expect(credentials.map((c) => c.service)).toContain("telegram");

    const del = await fetch(`${api.baseUrl}/api/credentials/telegram?scope=org`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(200);
  });

  it("global operator who is not an org admin cannot write org credentials", async () => {
    api = await bootTestApi();
    await api.providers.db.update(users).set({ role: "admin" }).where(eq(users.id, "test-member"));
    await api.providers.db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.userId, "test-member"));
    const headers = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

    const put = await fetch(`${api.baseUrl}/api/credentials/telegram`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ type: "bot_token", accessToken: "123:abc", scope: "org" }),
    });
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "org admin required" });

    const listed = await fetch(`${api.baseUrl}/api/credentials?scope=org`, { headers });
    expect(listed.status).toBe(403);

    const del = await fetch(`${api.baseUrl}/api/credentials/telegram?scope=org`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(403);
  });

  it("PUT without scope still lands user-owned (regression pin)", async () => {
    api = await bootTestApi();

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "ghp_supersecret" }),
    });
    expect(put.status).toBe(200);

    const userOwned = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(userOwned).toMatchObject({ type: "api_key", apiKey: "ghp_supersecret" });
    const orgOwned = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "github");
    expect(orgOwned).toBeNull();
  });
});

describe("GET /api/credentials", () => {
  it("only lists the caller's own credentials", async () => {
    api = await bootTestApi();

    await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "mine" }),
    });
    await fetch(`${api.baseUrl}/api/credentials/slack`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ type: "api_key", apiKey: "theirs" }),
    });

    const res = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await res.json()) as ListCredentialsResponse;
    expect(credentials.map((c) => c.service)).toEqual(["github"]);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/credentials`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});

/**
 * Availability gate (integration-availability design): a user-scope save
 * for a service whose deployment/org prerequisite is missing is rejected,
 * because the credential could never power a working integration. The
 * org-scope save stays open — it IS the configuration step. Once it exists,
 * the org credential provides the service ("org" mode) and user-scope
 * saves stay rejected: there is nothing a personal token adds.
 */
describe("PUT /api/credentials/:service — unconfigured services", () => {
  const GATED_PLUGIN: ValetPlugin = {
    name: "gated",
    version: "0.1.0",
    credentials: [
      { type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } },
    ],
  };

  it("403s a user-scope save while the org credential is missing", async () => {
    api = await bootTestApi({ plugins: [GATED_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/credentials/gated`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bot_token", accessToken: "tok-1" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Settings → Organization");
  });

  it("accepts the org-scope save (that is the configuration step), then still 403s user-scope saves", async () => {
    api = await bootTestApi({ plugins: [GATED_PLUGIN] });

    const orgPut = await fetch(`${api.baseUrl}/api/credentials/gated`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bot_token", accessToken: "org-tok", scope: "org" }),
    });
    expect(orgPut.status).toBe(200);

    const userPut = await fetch(`${api.baseUrl}/api/credentials/gated`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bot_token", accessToken: "user-tok" }),
    });
    expect(userPut.status).toBe(403);
    const body = (await userPut.json()) as { error: string };
    expect(body.error).toContain("provided by your organization");
  });

  it("403s a user-scope save for an oauth service whose client env vars are unset", async () => {
    const oauthPlugin: ValetPlugin = {
      name: "gmail",
      version: "0.1.0",
      credentials: [{
        type: "oauth2", configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientIdEnv: "UNSET_TEST_ID", clientSecretEnv: "UNSET_TEST_SECRET",
        },
      }],
    };
    api = await bootTestApi({ plugins: [oauthPlugin] });

    const res = await fetch(`${api.baseUrl}/api/credentials/gmail`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "oauth2", accessToken: "ya29-token" }),
    });
    expect(res.status).toBe(403);
  });

  it("still accepts a service with no credential declaration at all", async () => {
    api = await bootTestApi({ plugins: [GATED_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/credentials/some-mcp-server`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "k-1" }),
    });
    expect(res.status).toBe(200);
  });

  // Both availability refusals name the service the way the product does,
  // not the way the route param spells it, and `github` is the case a
  // title-cased id gets wrong. The corrective sentence is asserted with the
  // label, because a rewrite that swallowed it would be the worse
  // regression.
  it("names the service by its product name in both availability refusals, and keeps the corrective action", async () => {
    const gatedGithub: ValetPlugin = {
      name: "gated-github",
      version: "0.1.0",
      credentials: [
        { service: "github", type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } },
      ],
    };
    api = await bootTestApi({ plugins: [gatedGithub] });

    const unconfigured = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "bot_token", accessToken: "user-tok" }),
    });
    expect(unconfigured.status).toBe(403);
    expect(((await unconfigured.json()) as { error: string }).error).toBe(
      "GitHub is not configured for this organization. An admin can set it up in Settings → Organization.",
    );

    const orgPut = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "bot_token", accessToken: "org-tok", scope: "org" }),
    });
    expect(orgPut.status).toBe(200);

    const provided = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "bot_token", accessToken: "user-tok" }),
    });
    expect(provided.status).toBe(403);
    expect(((await provided.json()) as { error: string }).error).toBe(
      "GitHub is provided by your organization and needs no personal token. An admin manages it in Settings → Organization.",
    );
  });
});

describe("PUT /api/credentials/:service — onepassword reference extension", () => {
  it("happy path: org-scoped by admin saves a reference row and calls resolveReference once", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        scope: "org",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(200);
    expect(fake.resolveCalls).toEqual([{ scope: "org", reference: "op://vault/item/field" }]);

    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "linear");
    expect(stored).toMatchObject({
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    });
    expect(stored?.apiKey).toBeUndefined();
    expect(stored?.accessToken).toBeUndefined();
  });

  it("typed OnePasswordAuthError stays 400 with the typed hint, no row saved", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.failWith = new OnePasswordAuthError(
      "This org has no organization 1Password service account token connected.",
    );
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "This org has no organization 1Password service account token connected.",
    });

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored).toBeNull();
  });

  it("raw SDK rejection maps to 502 without leaking the SDK text", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.failWith = new Error("item not found at op://vault/item/field");
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(502);
    const body = (await put.json()) as { error: string };
    expect(body).toEqual({ error: "1Password request failed" });
    expect(JSON.stringify(body)).not.toContain("item not found");
    expect(JSON.stringify(body)).not.toContain("op://vault/item/field");

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored).toBeNull();
  });

  it("github service 400s: reference credentials are silently ignored by the session resolver", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "GitHub credentials cannot be 1Password references; use the GitHub connect flow",
    });

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored).toBeNull();
  });

  it("reserved service name 'onepassword' 400s", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/onepassword`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "onepassword is a reserved service name" });
  });

  it("inline secret + onepassword reference are mutually exclusive → 400", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        apiKey: "inline-secret",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "onepassword reference and inline secret are mutually exclusive",
    });
  });

  it("member + tokenScope:\"personal\" with the toggle off 403s", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "personal" },
      }),
    });
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({
      error: "personal 1Password tokens are disabled by your organization",
    });
  });

  it("reference that does not start with op:// 400s", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "onepassword.reference must be an op://vault/item/field reference",
    });
  });

  // One op:// grammar for the write path, the sandbox broker, and the team
  // grant. A reference this route stores must be one a team admin can grant,
  // or a stored row can never be leased to a team.
  it("a reference with too few segments 400s, so every stored ref is grantable", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "onepassword.reference must be an op://vault/item/field reference",
    });
    expect(fake.resolveCalls).toEqual([]);
  });

  it("non-enum tokenScope 400s", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "shared" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "onepassword.tokenScope must be org or personal",
    });
  });

  it("scope=org with tokenScope=personal 400s", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        scope: "org",
        onepassword: { reference: "op://vault/item/field", tokenScope: "personal" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "An org-scoped credential cannot use a personal 1Password token. Set tokenScope to org.",
    });
  });

  it("member creating an org-scoped credential still 403s (re-pinned with onepassword body present)", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({
        type: "api_key",
        scope: "org",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "org admin required" });
  });

  it("plain token write to the reserved 'onepassword' service is 403'd when the personal toggle is off", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });

    const put = await fetch(`${api.baseUrl}/api/credentials/onepassword`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "ops_sometoken" }),
    });
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({
      error: "personal 1Password tokens are disabled by your organization",
    });
  });
  // The row's type decides which field the resolved secret lands in, and a
  // plugin's transport reads one fixed field. The declaration names the type
  // it consumes; a reference of another type verified green and then never
  // started the transport at boot.
  it("rejects a reference whose type differs from the plugin's declared type, naming the right one", async () => {
    const botPlugin: ValetPlugin = {
      name: "fakebot",
      version: "0",
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], connectLabel: "Connect", requires: { orgCredential: true } }],
    };
    api = await bootTestApi({ plugins: [botPlugin] });
    api.providers.onePassword = new FakeOnePasswordService();
    const put = await fetch(`${api.baseUrl}/api/credentials/fakebot`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", scope: "org", onepassword: { reference: "op://vault/item/field", tokenScope: "org" } }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("bot_token");
    expect(await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "fakebot")).toBeNull();
  });

  // The code that owns these services reads its row raw: an `llm:*` key
  // through model resolution, the App private key through the GitHub App
  // loader. A reference saved under one resolves at save time, replaces the
  // working row, and is then read as a credential with no secret in it.
  it.each(["llm:prov_1", "github_app"])("rejects a 1Password reference for the internal service %s", async (service) => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();
    const put = await fetch(`${api.baseUrl}/api/credentials/${service}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", scope: "org", onepassword: { reference: "op://vault/item/field", tokenScope: "org" } }),
    });
    expect(put.status).toBe(400);
    expect(await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, service)).toBeNull();
  });

  // Every refusal in this route spells the service the way the product
  // does. `github_app` is the internal id for the GitHub App, so it is
  // spelled, while `llm:prov_1` is a namespaced id the caller sent rather
  // than a product name, so it is echoed as it was sent.
  it("names the product in the 1Password refusals, and echoes a namespaced internal id unchanged", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();
    const onepassword = { reference: "op://vault/item/field", tokenScope: "org" };

    const github = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", onepassword }),
    });
    expect(github.status).toBe(400);
    expect(await github.json()).toEqual({
      error: "GitHub credentials cannot be 1Password references; use the GitHub connect flow",
    });

    const githubApp = await fetch(`${api.baseUrl}/api/credentials/github_app`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", scope: "org", onepassword }),
    });
    expect(githubApp.status).toBe(400);
    expect(await githubApp.json()).toEqual({
      error: "GitHub App credentials cannot be 1Password references; set them in their own settings page",
    });

    const llmKey = await fetch(`${api.baseUrl}/api/credentials/llm:prov_1`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", scope: "org", onepassword }),
    });
    expect(llmKey.status).toBe(400);
    expect(await llmKey.json()).toEqual({
      error: "llm:prov_1 credentials cannot be 1Password references; set them in their own settings page",
    });
  });

  it("names the product in the declared-type refusal, and keeps the corrective action", async () => {
    const calendarPlugin: ValetPlugin = {
      name: "google-calendar",
      version: "0",
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    api = await bootTestApi({ plugins: [calendarPlugin] });
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/google-calendar`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        scope: "org",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "Google Calendar credentials are bot_token. Set type to bot_token for this reference.",
    });
  });

  it("accepts a bot_token reference for a plugin that declares bot_token", async () => {
    const botPlugin: ValetPlugin = {
      name: "fakebot",
      version: "0",
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], connectLabel: "Connect", requires: { orgCredential: true } }],
    };
    api = await bootTestApi({ plugins: [botPlugin] });
    api.providers.onePassword = new FakeOnePasswordService();
    const put = await fetch(`${api.baseUrl}/api/credentials/fakebot`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "bot_token", scope: "org", onepassword: { reference: "op://vault/item/field", tokenScope: "org" } }),
    });
    expect(put.status).toBe(200);
    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "fakebot");
    expect(stored?.type).toBe("bot_token");
  });
});

describe("GET /api/credentials — onepasswordRef summary", () => {
  it("reports onepasswordRef and never leaks apiKey/accessToken", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });

    const get = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await get.json()) as ListCredentialsResponse;
    const summary = credentials.find((c) => c.service === "linear");
    expect(summary).toMatchObject({ service: "linear", type: "api_key", onepasswordRef: "op://vault/item/field" });

    const serialized = JSON.stringify(credentials);
    expect(serialized).not.toContain('"apiKey"');
    expect(serialized).not.toContain('"accessToken"');
  });
});

describe("PUT /api/credentials/:service — metadata.onepassword smuggle guard", () => {
  it("plain PUT with metadata.onepassword (no body.onepassword) 400s, no row saved", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        apiKey: "inline-secret",
        metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "metadata.onepassword is reserved; use the onepassword request field",
    });

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored).toBeNull();
  });

  it("rejects a request that carries both body.onepassword and metadata.onepassword", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
        metadata: { onepassword: { reference: "op://sneaky/other/field", tokenScope: "org" } },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({
      error: "metadata.onepassword is reserved; use the onepassword request field",
    });
    expect(fake.resolveCalls).toEqual([]); // rejected before save-time resolution is ever attempted

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored).toBeNull();
  });

  it("saves a body.onepassword request with the reference in metadata", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        metadata: { login: "someone" },
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(200);

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored?.metadata).toEqual({
      login: "someone",
      onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
    });
  });

  it("rejects the reserved service name before checking the personal toggle", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    await fetch(`${api.baseUrl}/api/onepassword/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ allowPersonal: false }),
    });

    const put = await fetch(`${api.baseUrl}/api/credentials/onepassword`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "personal" },
      }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "onepassword is a reserved service name" });
  });
});

describe("team credential scope (TKAI-205)", () => {
  async function teamWithMember(plugins: ValetPlugin[] = []) {
    api = await bootTestApi({ plugins });
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    return team;
  }

  it("lets a member read team scope and refuses a non-admin PUT with 404", async () => {
    const team = await teamWithMember();
    const putAdmin = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "team-lin", scope: "team", teamId: team.id }),
    });
    expect(putAdmin.status).toBe(200);

    const getMember = await fetch(
      `${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`,
      { headers: MEMBER_HEADERS },
    );
    expect(getMember.status).toBe(200);
    const { credentials: listed } = (await getMember.json()) as ListCredentialsResponse;
    expect(listed).toEqual([
      expect.objectContaining({ service: "linear", type: "api_key" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("team-lin");

    const putMember = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "nope", scope: "team", teamId: team.id }),
    });
    expect(putMember.status).toBe(404);
  });

  // An org admin manages every team in the org and already writes team
  // credentials through the admin override; the read gate admits them too,
  // the same way the team roster does. A plain org member off the team
  // still sees nothing.
  it("lets an org admin off the team list its credentials, and 404s a plain org member", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, {
      orgId: "local-org",
      name: "Platform",
      creatorUserId: "local-user",
    });
    await api.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", {
      type: "api_key",
      apiKey: "team-lin",
    });
    const adminHeaders = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };
    const asAdmin = await fetch(`${api.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, {
      headers: adminHeaders,
    });
    expect(asAdmin.status).toBe(200);
    const { credentials: listed } = (await asAdmin.json()) as ListCredentialsResponse;
    expect(listed).toEqual([expect.objectContaining({ service: "linear", type: "api_key" })]);
    expect(JSON.stringify(listed)).not.toContain("team-lin");

    const asMember = await fetch(`${api.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, {
      headers: MEMBER_HEADERS,
    });
    expect(asMember.status).toBe(404);
  });

  // A team credential write changes what the team's mirrored workflows may
  // arm, and no commit lands to make the sync notice. Each write marks the
  // team's workflow sources for a full pass at the unchanged head.
  describe("resyncs the team's workflow sources", () => {
    const later = Date.now() + 3_600_000;
    const primed = { nextAttemptAt: later, lastSha: "c1", discoveryScan: "1:c1", lastManifestHash: "m1" };

    async function workflowSource(teamId: string): Promise<string> {
      const source = await createContentSource(
        api!.providers.db,
        { userId: "local-user", orgId: "local-org" },
        { repo: "tkhq/automation", teamId, kinds: ["workflows"] },
      );
      await prime(source.id);
      return source.id;
    }

    async function prime(sourceId: string): Promise<void> {
      await api!.providers.db.update(contentSources).set(primed).where(eq(contentSources.id, sourceId));
    }

    async function marked(sourceId: string): Promise<boolean> {
      const [row] = await api!.providers.db
        .select()
        .from(contentSources)
        .where(eq(contentSources.id, sourceId));
      return row.nextAttemptAt <= Date.now() && row.discoveryScan === null && row.lastManifestHash === null;
    }

    it("on a team PUT and a team DELETE", async () => {
      const team = await teamWithMember();
      // The mark nudges the sweep; this test reads the row itself.
      await api!.providers.contentSync.stop();
      const sourceId = await workflowSource(team.id);

      const put = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ type: "api_key", apiKey: "team-lin", scope: "team", teamId: team.id }),
      });
      expect(put.status).toBe(200);
      expect(await marked(sourceId)).toBe(true);

      await prime(sourceId);
      const del = await fetch(`${api!.baseUrl}/api/credentials/linear?scope=team&teamId=${team.id}`, {
        method: "DELETE",
        headers: HEADERS,
      });
      expect(del.status).toBe(200);
      expect(await marked(sourceId)).toBe(true);
    });

    it("on a delegation, its revocation, and the source credential's deletion", async () => {
      const team = await teamWithMember();
      await api!.providers.contentSync.stop();
      const sourceId = await workflowSource(team.id);
      await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "PUT",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ type: "api_key", apiKey: "member-lin" }),
      });
      await prime(sourceId);

      const share = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ teamId: team.id }),
      });
      expect(share.status).toBe(201);
      expect(await marked(sourceId)).toBe(true);

      await prime(sourceId);
      const revoke = await fetch(`${api!.baseUrl}/api/credentials/linear/delegations/${team.id}`, {
        method: "DELETE",
        headers: MEMBER_HEADERS,
      });
      expect(revoke.status).toBe(200);
      expect(await marked(sourceId)).toBe(true);

      await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ teamId: team.id }),
      });
      await prime(sourceId);
      const gone = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "DELETE",
        headers: MEMBER_HEADERS,
      });
      expect(gone.status).toBe(200);
      expect(await marked(sourceId)).toBe(true);
    });
  });

  it("delegates and revokes a personal credential, and 409s an occupied slot", async () => {
    const team = await teamWithMember();
    await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "member-lin" }),
    });
    const share = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(share.status).toBe(201);

    const listed = (await (
      await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, { headers: HEADERS })
    ).json()) as ListCredentialsResponse;
    expect(listed.credentials).toEqual([
      expect.objectContaining({ service: "linear", delegatedFrom: "test-member", referenceBroken: false }),
    ]);

    // A caller with nothing to share is told to connect first; the slot
    // check only applies once the caller holds a source credential.
    const unconnected = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(unconnected.status).toBe(400);
    expect(((await unconnected.json()) as { error: string }).error).toContain("Connect Linear in Integrations first");

    await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "admin-lin" }),
    });
    const occupied = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(occupied.status).toBe(409);
    expect(((await occupied.json()) as { error: string }).error).toContain(
      "Ask a team admin to change it in Settings → Organization → Teams.",
    );

    const revoke = await fetch(
      `${api!.baseUrl}/api/credentials/linear/delegations/${team.id}`,
      { method: "DELETE", headers: MEMBER_HEADERS },
    );
    expect(revoke.status).toBe(200);
    const after = (await (
      await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, { headers: HEADERS })
    ).json()) as ListCredentialsResponse;
    expect(after.credentials).toEqual([]);
  });

  // The refusals name the service the way the product does, not the way
  // the route param spells it: the caller reads "Linear"/"GitHub", the
  // same spelling the connect UI and this file's own GitHub copy use.
  // Both halves are asserted together, because a label that swallowed the
  // corrective sentence would be the worse regression.
  //
  // The slot can hold either kind of team row, and the two are removed
  // under different labels ("Stop sharing" a delegated row, "Disconnect" a
  // direct one), so the refusal names neither verb. It sends the caller to
  // the page that shows which row is there, the same place the web
  // client's own 409 copy names.
  it("names the service by its product name in the occupied-slot refusal, and sends the caller to the page instead of one row kind's verb", async () => {
    const team = await teamWithMember();
    await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "linear", {
      type: "api_key",
      apiKey: "member-lin",
    });
    const shared = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(shared.status).toBe(201);
    const occupied = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(occupied.status).toBe(409);
    const occupiedError = ((await occupied.json()) as { error: string }).error;
    expect(occupiedError).toBe(
      "This team already has Linear. Ask a team admin to change it in Settings → Organization → Teams.",
    );
    // Neither removal verb: one of them is always wrong for the row that
    // holds the slot, and a caller outside the browser would hunt for a
    // control that row does not have.
    expect(occupiedError).not.toMatch(/disconnect/i);
    expect(occupiedError).not.toMatch(/stop sharing/i);

    // `github` is the case a first-letter capitalization gets wrong, and
    // the one this file already spells "GitHub" by hand two refusals up.
    await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "api_key",
      apiKey: "ghp_pat",
    });
    const sharedGithub = await fetch(`${api!.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(sharedGithub.status).toBe(201);
    const occupiedGithub = await fetch(`${api!.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(occupiedGithub.status).toBe(409);
    expect(((await occupiedGithub.json()) as { error: string }).error).toBe(
      "This team already has GitHub. Ask a team admin to change it in Settings → Organization → Teams.",
    );
  });

  // A team row is read with org-scoped 1Password tokens only, so a
  // personal-scope reference stored at team scope could never resolve.
  it("refuses a team-scope 1Password reference with a personal token, naming the fix", async () => {
    const team = await teamWithMember();
    const fake = new FakeOnePasswordService();
    api!.providers.onePassword = fake;
    const put = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        scope: "team",
        teamId: team.id,
        onepassword: { reference: "op://vault/item/field", tokenScope: "personal" },
      }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("tokenScope to org");
    expect(body.error).toContain("store the secret directly");
    expect(fake.resolveCalls).toEqual([]);
    expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toBeNull();
  });

  // `metadata.delegatedFrom` is what the team read follows to a member's
  // personal row. Only the delegate route may write it, because that route
  // runs as the member whose credential is being shared. A PUT that carries
  // it would let a team admin point the team at any member's token.
  describe("reserves the delegation metadata keys", () => {
    it("refuses a team-scope reference that names a member, and stores nothing", async () => {
      const team = await teamWithMember();
      const fake = new FakeOnePasswordService();
      api!.providers.onePassword = fake;
      await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "linear", {
        type: "api_key",
        apiKey: "member-lin",
      });
      const put = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({
          type: "api_key",
          scope: "team",
          teamId: team.id,
          onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
          metadata: { delegatedFrom: "test-member" },
        }),
      });
      expect(put.status).toBe(400);
      const { error } = (await put.json()) as { error: string };
      expect(error).toContain("metadata.delegatedFrom");
      expect(error).toContain("POST /api/credentials/linear/delegate");
      expect(fake.resolveCalls).toEqual([]);
      // The team read must not reach the member's row through a forged reference.
      expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toBeNull();
    });

    it("refuses the keys on every scope, with or without a secret", async () => {
      const team = await teamWithMember();
      const attempts: { scope?: string; teamId?: string; headers: Record<string, string> }[] = [
        { headers: HEADERS },
        { scope: "org", headers: HEADERS },
        { scope: "team", teamId: team.id, headers: HEADERS },
      ];
      for (const attempt of attempts) {
        for (const metadata of [{ delegatedFrom: "test-member" }, { sourceType: "api_key" }]) {
          const put = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
            method: "PUT",
            headers: attempt.headers,
            body: JSON.stringify({
              type: "api_key",
              apiKey: "some-secret",
              scope: attempt.scope,
              teamId: attempt.teamId,
              metadata,
            }),
          });
          expect(put.status).toBe(400);
        }
      }
      expect(await api!.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear")).toBeNull();
      expect(await api!.providers.engineCredentials.get({ type: "org", id: "local-org" }, "linear")).toBeNull();
      expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toBeNull();
    });
  });

  // The same scope rule holds for a delegated reference: the team read
  // runs on org-scoped tokens, so a personal reference on the source row
  // would never resolve for the team.
  it("refuses to delegate a personal-scope 1Password reference, naming the fix", async () => {
    const team = await teamWithMember();
    await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "personal" } },
    });
    const share = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(share.status).toBe(400);
    const { error } = (await share.json()) as { error: string };
    expect(error).toBe(
      "Linear is stored as a personal 1Password reference, which a team cannot read. " +
        "Store it again with tokenScope org, or store the secret directly, then share it.",
    );
    expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toBeNull();
  });

  // A delegation is a reference to the member's live row. Re-storing that
  // row as a personal-scope 1Password reference would leave every team
  // that rides it with a reference the team read cannot resolve, and
  // nothing would say so until a run failed.
  describe("a delegated source row and personal 1Password references", () => {
    async function delegatedLinear() {
      const team = await teamWithMember();
      await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "PUT",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ type: "api_key", apiKey: "member-lin" }),
      });
      const share = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ teamId: team.id }),
      });
      expect(share.status).toBe(201);
      return team;
    }

    it("refuses to re-store the source as a personal reference while shares exist, naming the fix", async () => {
      const team = await delegatedLinear();
      const fake = new FakeOnePasswordService();
      api!.providers.onePassword = fake;
      const put = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "PUT",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({
          type: "api_key",
          onepassword: { reference: "op://vault/item/field", tokenScope: "personal" },
        }),
      });
      expect(put.status).toBe(400);
      const { error } = (await put.json()) as { error: string };
      expect(error).toContain("shared with 1 team");
      expect(error).toContain("Revoke");
      expect(error).toContain("tokenScope to org");
      expect(fake.resolveCalls).toEqual([]);
      // The source row and the delegation are both untouched.
      expect(
        await api!.providers.engineCredentials.get({ type: "user", id: "test-member" }, "linear"),
      ).toMatchObject({ apiKey: "member-lin" });
      expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({
        metadata: { delegatedFrom: "test-member" },
      });

      // An org-scope reference is one the team read can use, so it is accepted.
      const orgRef = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
        method: "PUT",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({
          type: "api_key",
          onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
        }),
      });
      expect(orgRef.status).toBe(200);
    });

    it("marks the team reference broken when the source row is a personal reference", async () => {
      const team = await delegatedLinear();
      // Written through the store, the way a row that predates the PUT
      // check would sit in the table.
      await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "linear", {
        type: "api_key",
        metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "personal" } },
      });
      const listed = (await (
        await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, { headers: HEADERS })
      ).json()) as ListCredentialsResponse;
      expect(listed.credentials).toEqual([
        expect.objectContaining({ service: "linear", delegatedFrom: "test-member", referenceBroken: true }),
      ]);

      await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "linear", {
        type: "api_key",
        metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
      });
      const healthy = (await (
        await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, { headers: HEADERS })
      ).json()) as ListCredentialsResponse;
      expect(healthy.credentials).toEqual([
        expect.objectContaining({ service: "linear", delegatedFrom: "test-member", referenceBroken: false }),
      ]);
    });
  });

  // A github row that the user's own runs would refuse (identity-only
  // sign-in scopes, a failed refresh, an expired token with no refresh
  // token) is no better for a team. Sharing it would hand the team a
  // credential every run rejects.
  // The health rule reads the secret slot the row actually uses: a PAT
  // stored in `apiKey` and a 1Password reference (resolved by the team
  // read, so it cannot be checked here) both share.
  it("delegates a github PAT stored in the apiKey slot and a 1Password-referenced github row", async () => {
    api = await bootTestApi();
    const { engineCredentials } = api.providers;
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await engineCredentials.save({ type: "user", id: "local-user" }, "github", { type: "api_key", apiKey: "ghp_pat" });
    const pat = await fetch(`${api.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(pat.status).toBe(201);
    await fetch(`${api.baseUrl}/api/credentials/github/delegations/${team.id}`, { method: "DELETE" });
    await engineCredentials.save({ type: "user", id: "local-user" }, "github", {
      type: "oauth2",
      metadata: { onepassword: { reference: "op://Org/GitHub/token", tokenScope: "org" } },
    });
    const ref = await fetch(`${api.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(ref.status).toBe(201);
  });

  it("refuses to delegate an unhealthy github connection, naming the reconnect", async () => {
    const team = await teamWithMember();
    await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2",
      accessToken: "identity-tok",
      metadata: { login: "octocat", identityOnly: true },
    });
    const share = await fetch(`${api!.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(share.status).toBe(400);
    const { error } = (await share.json()) as { error: string };
    expect(error).toContain("Connect GitHub in Settings → Connected accounts");
    expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "github")).toBeNull();

    await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "oauth2",
      accessToken: "repo-tok",
      metadata: { login: "octocat" },
    });
    const healthy = await fetch(`${api!.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(healthy.status).toBe(201);
  });

  // A team may store its own Slack bot token. It is checked against Slack
  // the same way the org token is (bot token, required scopes), but it
  // needs no signing secret because Slack events route through the org app.
  describe("team Slack token", () => {
    const slackDeclaration: ValetPlugin = {
      name: "slack",
      version: "0",
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    let slack: SlackFixture | undefined;
    const savedApiBase = process.env.VALET_SLACK_API_BASE;

    afterEach(async () => {
      await slack?.close();
      slack = undefined;
      if (savedApiBase === undefined) delete process.env.VALET_SLACK_API_BASE;
      else process.env.VALET_SLACK_API_BASE = savedApiBase;
    });

    function useFixture(fixture: SlackFixture): void {
      slack = fixture;
      process.env.VALET_SLACK_API_BASE = fixture.url;
    }

    it("rejects a token Slack rejects, naming the fix, and stores nothing", async () => {
      const team = await teamWithMember([slackDeclaration]);
      useFixture(startSlackFixture({ body: { ok: false, error: "invalid_auth" } }));
      const put = await fetch(`${api!.baseUrl}/api/credentials/slack`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ type: "bot_token", accessToken: "xoxb-team", scope: "team", teamId: team.id }),
      });
      expect(put.status).toBe(400);
      const { error } = (await put.json()) as { error: string };
      expect(error).toContain("invalid_auth");
      expect(error).toContain("OAuth & Permissions");
      expect(slack?.calls).toEqual(["Bearer xoxb-team"]);
      expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "slack")).toBeNull();
    });

    it("stores a verified bot token without a signing secret and records the workspace", async () => {
      const team = await teamWithMember([slackDeclaration]);
      useFixture(startSlackFixture());
      const put = await fetch(`${api!.baseUrl}/api/credentials/slack`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ type: "bot_token", accessToken: "xoxb-team", scope: "team", teamId: team.id }),
      });
      expect(put.status).toBe(200);
      expect(slack?.calls).toEqual(["Bearer xoxb-team"]);
      const stored = await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "slack");
      expect(stored?.accessToken).toBe("xoxb-team");
      expect(stored?.metadata).toMatchObject({ teamId: "T0FIXTURE", teamName: "Fixture Workspace", botUserId: "U0BOTFIXTURE" });
      expect(stored?.metadata?.webhookSecret).toBeUndefined();
      expect(stored?.scopes).toContain("assistant:write");
    });

    // A personal Slack token is one person's identity. A team runs on a
    // verified bot token stored at team scope, or on the org bot; the
    // delegate route must refuse the personal row the way PUT already does.
    it("refuses to delegate a personal Slack connection, naming the team token path", async () => {
      const team = await teamWithMember([slackDeclaration]);
      await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "slack", {
        type: "bot_token",
        accessToken: "xoxp-personal",
      });
      const share = await fetch(`${api!.baseUrl}/api/credentials/slack/delegate`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ teamId: team.id }),
      });
      expect(share.status).toBe(400);
      const { error } = (await share.json()) as { error: string };
      expect(error).toBe(
        "Slack cannot be shared from a personal connection. " +
          "Store a team bot token in Settings → Organization → Teams, or use the organization's Slack.",
      );
      expect(await api!.providers.engineCredentials.get({ type: "team", id: team.id }, "slack")).toBeNull();
    });
  });

  it("lists a team row's health fields and 1Password reference like a user row", async () => {
    const team = await teamWithMember();
    api!.providers.onePassword = new FakeOnePasswordService();
    const putDirect = await fetch(`${api!.baseUrl}/api/credentials/github-team`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "oauth2",
        accessToken: "team-gh",
        scope: "team",
        teamId: team.id,
        metadata: { login: "octo", identityOnly: true, refreshFailedAt: 1700000000000 },
      }),
    });
    expect(putDirect.status).toBe(200);
    const putRef = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        scope: "team",
        teamId: team.id,
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(putRef.status).toBe(200);

    const listed = (await (
      await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, { headers: HEADERS })
    ).json()) as ListCredentialsResponse;
    expect(listed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "github-team",
          type: "oauth2",
          login: "octo",
          identityOnly: true,
          refreshFailedAt: 1700000000000,
        }),
        expect.objectContaining({ service: "linear", type: "api_key", onepasswordRef: "op://vault/item/field" }),
      ]),
    );
    expect(JSON.stringify(listed)).not.toContain("team-gh");
  });

  it("names the corrective action on a malformed delegate body and a non-shareable credential", async () => {
    const team = await teamWithMember();
    const malformed = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toContain("Send a JSON body with teamId.");

    await api!.providers.engineCredentials.save({ type: "user", id: "test-member" }, "github", {
      type: "app_install",
      accessToken: "ghs_install",
    });
    const unshareable = await fetch(`${api!.baseUrl}/api/credentials/github/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(unshareable.status).toBe(400);
    expect(((await unshareable.json()) as { error: string }).error).toContain("Ask a team admin to connect GitHub for the team instead.");
  });

  it("refuses to overwrite a direct team credential, even when a pre-read saw the slot empty", async () => {
    const team = await teamWithMember();
    const putDirect = await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "team-lin", scope: "team", teamId: team.id }),
    });
    expect(putDirect.status).toBe(200);
    await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "member-lin" }),
    });

    // Models the read-then-write window of a concurrent delegation or an
    // admin's direct PUT: whatever a pre-read reports, the write itself
    // must refuse an occupied slot.
    const store = api!.providers.engineCredentials;
    api!.providers.engineCredentials = {
      get: (owner, service) => store.get(owner, service),
      save: (owner, service, credential) => store.save(owner, service, credential),
      delete: (owner, service) => store.delete(owner, service),
      list: async () => [],
    };

    const share = await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(share.status).toBe(409);

    const direct = await store.get({ type: "team", id: team.id }, "linear");
    expect(direct).toMatchObject({ type: "api_key", apiKey: "team-lin" });
    expect(direct?.metadata).toBeUndefined();
  });

  it("deletes matching team references when the source user credential is deleted", async () => {
    const team = await teamWithMember();
    await fetch(`${api!.baseUrl}/api/credentials/linear`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "member-lin" }),
    });
    expect(
      (
        await fetch(`${api!.baseUrl}/api/credentials/linear/delegate`, {
          method: "POST",
          headers: MEMBER_HEADERS,
          body: JSON.stringify({ teamId: team.id }),
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await fetch(`${api!.baseUrl}/api/credentials/linear`, {
          method: "DELETE",
          headers: MEMBER_HEADERS,
        })
      ).status,
    ).toBe(200);

    const listed = (await (
      await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, { headers: HEADERS })
    ).json()) as ListCredentialsResponse;
    expect(listed.credentials).toEqual([]);
  });
});
