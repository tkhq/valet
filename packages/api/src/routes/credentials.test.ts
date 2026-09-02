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
import { orgMembers, users } from "../schema/index.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "../services/onepassword.js";
import type { ListCredentialsResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

class FakeOnePasswordService implements OnePasswordService {
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
      error: "github credentials cannot be 1Password references; use the GitHub connect flow",
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
      error: "onepassword.reference must be a string that starts with op://",
    });
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
