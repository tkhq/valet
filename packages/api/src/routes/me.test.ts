/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Distinct from `/api/auth/me` (session-probe shape, unchanged).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { users } from "../schema/index.js";
import type { MeResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/me", () => {
  it("returns the local user with orgRole admin and defaultModel null", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;

    expect(body).toMatchObject({
      id: "local-user",
      email: "local@dev",
      role: "admin",
      orgId: "local-org",
      orgRole: "admin",
      defaultModel: null,
    });
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/me`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });

  it("falls back to orgRole member when the caller has no org_members row", async () => {
    api = await bootTestApi();
    await api.providers.db
      .insert(users)
      .values({ id: "test-no-org", email: "noorg@dev", role: "member", createdAt: Date.now() });

    const res = await fetch(`${api.baseUrl}/api/me`, {
      headers: { "x-valet-test-user-id": "test-no-org" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;
    expect(body.orgRole).toBe("member");
  });
});

describe("PATCH /api/me", () => {
  it("updates name and round-trips it on GET", async () => {
    api = await bootTestApi();

    const patch = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as MeResponse;
    expect(patched.name).toBe("New Name");

    const res = await fetch(`${api.baseUrl}/api/me`);
    const body = (await res.json()) as MeResponse;
    expect(body.name).toBe("New Name");
  });

  it("accepts a known defaultModel id", async () => {
    api = await bootTestApi();

    const patch = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "claude-haiku-4-5" }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as MeResponse;
    expect(body.defaultModel).toBe("claude-haiku-4-5");
  });

  it("400s on an unknown defaultModel id, mentioning the unknown model", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "not-a-model" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not-a-model");
  });

  it("clears defaultModel when passed null", async () => {
    api = await bootTestApi();

    await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "claude-haiku-4-5" }),
    });

    const patch = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: null }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as MeResponse;
    expect(body.defaultModel).toBeNull();
  });

  it("rejects unknown fields with 400", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favoriteColor: "blue" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects email — not in the whitelist", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@dev" }),
    });
    expect(res.status).toBe(400);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});
