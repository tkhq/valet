/**
 * `/api/credentials` — manual token entry (plugin-system-v2 plan Task 15).
 * PUT→GET round trip never leaks token material; DELETE flips it back;
 * validation 400s for malformed bodies; unauth 401s (same pattern as
 * `plugins.test.ts` — flip `VALET_LOCAL_AUTH` off for one request).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListCredentialsResponse } from "../wire/types.js";

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
