/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Distinct from `/api/auth/me` (session-probe shape, unchanged).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { users } from "../schema/index.js";
import { setApprovedModels } from "../services/approved-models.js";
import { setOrgReasoningSettings } from "../services/reasoning.js";
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
      newThreadBehavior: "keep_current",
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
  it.each(["keep_current", "use_defaults"] as const)(
    "updates newThreadBehavior to %s",
    async (newThreadBehavior) => {
      api = await bootTestApi();

      const patch = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newThreadBehavior }),
      });
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as MeResponse;
      expect(body.newThreadBehavior).toBe(newThreadBehavior);
    },
  );

  it("rejects an unknown newThreadBehavior with a corrective error", async () => {
    api = await bootTestApi();

    const patch = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newThreadBehavior: "copy_model_only" }),
    });
    expect(patch.status).toBe(400);
    const body = (await patch.json()) as { error: string };
    expect(body.error).toContain("Select keep_current or use_defaults");
  });

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

  it("400s a catalog-valid but unapproved defaultModel for a plain member; org admin bypasses", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-stub");
    try {
      api = await bootTestApi();
      // Approve only opus; haiku is catalog-valid but not on the list.
      await setApprovedModels(api.providers.db, "local-org", ["anthropic/claude-opus-4-7"]);

      const memberRes = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
        body: JSON.stringify({ defaultModel: "anthropic/claude-haiku-4-5" }),
      });
      expect(memberRes.status).toBe(400);
      const body = (await memberRes.json()) as { error: string };
      expect(body.error).toMatch(/approved list/);

      // The default identity (`local-user`) is an org admin and bypasses the gate.
      const adminRes = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: "anthropic/claude-haiku-4-5" }),
      });
      expect(adminRes.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts a defaultReasoning level within the org cap, normalizing case", async () => {
    api = await bootTestApi();
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "high" });

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultReasoning: "Medium" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;
    expect(body.defaultReasoning).toBe("medium");
  });

  it("400s a defaultReasoning level exceeding the org cap", async () => {
    api = await bootTestApi();
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "medium" });

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultReasoning: "high" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exceeds the org max/);
  });

  it("400s an unknown defaultReasoning level", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultReasoning: "not-a-level" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown reasoning level/);
  });

  it("clears defaultReasoning when passed null, even above the org cap", async () => {
    api = await bootTestApi();
    await setOrgReasoningSettings(api.providers.db, "local-org", { max: "minimal" });

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultReasoning: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeResponse;
    expect(body.defaultReasoning).toBeNull();
  });

  it("rejects JSON-valid non-object bodies with 400, not 500", async () => {
    api = await bootTestApi();

    for (const body of ["null", "42", '"x"', "[]"]) {
      const res = await fetch(`${api.baseUrl}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
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
