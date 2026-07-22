/**
 * `/api/credentials` — manual token entry (plugin-system-v2 plan Task 15).
 * PUT→GET round trip never leaks token material; DELETE flips it back;
 * validation 400s for malformed bodies; unauth 401s (same pattern as
 * `plugins.test.ts` — flip `VALET_LOCAL_AUTH` off for one request).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordScope, type OnePasswordService } from "../services/onepassword.js";
import type { ListCredentialsResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

class FakeOnePasswordService implements OnePasswordService {
  resolveCalls: { scope: OnePasswordScope; reference: string }[] = [];
  /** Set to make `resolveReference` throw for the next/every call. */
  failWith: OnePasswordAuthError | undefined;

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

describe("PUT /api/credentials/:service — onepassword reference extension", () => {
  it("happy path: org-scoped by admin saves a reference row and calls resolveReference once", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
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

    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "github");
    expect(stored).toMatchObject({
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    });
    expect(stored?.apiKey).toBeUndefined();
    expect(stored?.accessToken).toBeUndefined();
  });

  it("bad reference: fake throws OnePasswordAuthError → 400, no row saved", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    fake.failWith = new OnePasswordAuthError("1Password resolution failed for op://vault/item/field: not found");
    api.providers.onePassword = fake;

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
      error: "1Password resolution failed for op://vault/item/field: not found",
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

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
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

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
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

  it("member creating an org-scoped credential still 403s (re-pinned with onepassword body present)", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
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

    await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });

    const get = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await get.json()) as ListCredentialsResponse;
    const summary = credentials.find((c) => c.service === "github");
    expect(summary).toMatchObject({ service: "github", type: "api_key", onepasswordRef: "op://vault/item/field" });

    const serialized = JSON.stringify(credentials);
    expect(serialized).not.toContain('"apiKey"');
    expect(serialized).not.toContain('"accessToken"');
  });
});

describe("PUT /api/credentials/:service — metadata.onepassword smuggle guard", () => {
  it("plain PUT with metadata.onepassword (no body.onepassword) 400s, no row saved", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
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

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored).toBeNull();
  });

  it("body.onepassword present ALONGSIDE a metadata.onepassword key 400s (unambiguous — reject, don't merge)", async () => {
    api = await bootTestApi();
    const fake = new FakeOnePasswordService();
    api.providers.onePassword = fake;

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
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

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored).toBeNull();
  });

  it("a legitimate body.onepassword request (no metadata.onepassword) still saves with metadata sourced from body.onepassword", async () => {
    api = await bootTestApi();
    api.providers.onePassword = new FakeOnePasswordService();

    const put = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        type: "api_key",
        metadata: { login: "someone" },
        onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
      }),
    });
    expect(put.status).toBe(200);

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored?.metadata).toEqual({
      login: "someone",
      onepassword: { reference: "op://vault/item/field", tokenScope: "org" },
    });
  });

  it("reserved service + body.onepassword + personal toggle off → 400 (reserved-service name), not 403", async () => {
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
