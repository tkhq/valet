/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Distinct from `/api/auth/me` (session-probe shape, unchanged).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
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
      modelPreferences: [],
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
      .values({ id: "test-no-org", email: "noorg@dev", name: "No Org", role: "member" });

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

  it("accepts a known defaultModel id (bare Anthropic back-compat, zero-config env fallback)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();

      const patch = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: "claude-haiku-4-5" }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as MeResponse;
      expect(body.defaultModel).toBe("claude-haiku-4-5");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts a known defaultModel id in namespaced form", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();

      const patch = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: "anthropic/claude-haiku-4-5" }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as MeResponse;
      expect(body.defaultModel).toBe("anthropic/claude-haiku-4-5");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("400s a known-shaped model id when it's inactive (no key, no env fallback)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    try {
      api = await bootTestApi();

      const res = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: "claude-haiku-4-5" }),
      });
      expect(res.status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
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
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
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
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("PATCH /api/me modelPreferences", () => {
  it("accepts an ordered list of known model ids (bare + namespaced) and returns it on GET", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();

      const patch = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPreferences: ["anthropic/claude-haiku-4-5", "claude-sonnet-4-5"],
        }),
      });
      expect(patch.status).toBe(200);
      const patched = (await patch.json()) as MeResponse;
      expect(patched.modelPreferences).toEqual([
        "anthropic/claude-haiku-4-5",
        "claude-sonnet-4-5",
      ]);

      const res = await fetch(`${api.baseUrl}/api/me`);
      const body = (await res.json()) as MeResponse;
      expect(body.modelPreferences).toEqual([
        "anthropic/claude-haiku-4-5",
        "claude-sonnet-4-5",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("writes name and modelPreferences in one request", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();

      const patch = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ada",
          modelPreferences: ["claude-haiku-4-5"],
        }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as MeResponse;
      expect(body.name).toBe("Ada");
      expect(body.modelPreferences).toEqual(["claude-haiku-4-5"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("clears the user list when passed []", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();

      await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPreferences: ["claude-haiku-4-5"] }),
      });

      const patch = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPreferences: [] }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as MeResponse;
      expect(body.modelPreferences).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("400s when modelPreferences is not an array", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelPreferences: "claude-haiku-4-5" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("array");
    expect(body.error).toContain("JSON array");
  });

  it("400s when a modelPreferences entry is not a string", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelPreferences: ["ok", 42] }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when a modelPreferences entry is unknown/inactive, naming the id", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelPreferences: ["not-a-model"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not-a-model");
    expect(body.error).toContain("GET /api/models");
  });

  it("400s when modelPreferences exceeds the 20-entry cap", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();
      const prefs = Array(21).fill("claude-haiku-4-5");

      const res = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPreferences: prefs }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("20");
      expect(body.error).toContain("Remove extra entries");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("400s when a modelPreferences entry exceeds 255 chars", async () => {
    api = await bootTestApi();
    const longId = "a".repeat(256);

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelPreferences: [longId] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("255");
    expect(body.error).toContain("GET /api/models");
  });
});
