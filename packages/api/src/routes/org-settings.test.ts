/**
 * `PATCH /api/org/settings` — org-level bare-skill-commands toggle.
 * Admin-gated; non-admin 403; non-boolean 400.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eq } from "drizzle-orm";
import { orgs } from "../schema/index.js";

const ADMIN_HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function getOrgRow(api: TestApi) {
  const rows = await api.providers.db
    .select()
    .from(orgs)
    .where(eq(orgs.id, "local-org"))
    .limit(1);
  return rows[0];
}

describe("PATCH /api/org/settings", () => {
  it("org admin toggles bareSkillCommands to true and read-back reflects it", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ bareSkillCommands: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bareSkillCommands: boolean };
    expect(body.bareSkillCommands).toBe(true);

    const row = await getOrgRow(api);
    expect(row?.bareSkillCommands).toBe(true);
  });

  it("org admin toggles bareSkillCommands back to false", async () => {
    api = await bootTestApi();

    // Set to true first.
    await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ bareSkillCommands: true }),
    });

    const res = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ bareSkillCommands: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bareSkillCommands: boolean };
    expect(body.bareSkillCommands).toBe(false);

    const row = await getOrgRow(api);
    expect(row?.bareSkillCommands).toBe(false);
  });

  it("member cannot toggle bareSkillCommands (403)", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ bareSkillCommands: true }),
    });
    expect(res.status).toBe(403);
  });

  it("400s when bareSkillCommands is not a boolean", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ bareSkillCommands: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s with no recognized fields", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ unknown: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe("personal GitHub installations policy", () => {
  it("defaults on and lets only an org admin change it", async () => {
    api = await bootTestApi();
    const read = await fetch(`${api.baseUrl}/api/org`);
    expect(await read.json()).toMatchObject({ allowPersonalInstallations: true });
    for (const enabled of [false, true]) {
      const response = await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH", headers: ADMIN_HEADERS,
        body: JSON.stringify({ allowPersonalInstallations: enabled }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ allowPersonalInstallations: enabled });
    }
    const denied = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH", headers: MEMBER_HEADERS,
      body: JSON.stringify({ allowPersonalInstallations: false }),
    });
    expect(denied.status).toBe(403);
  });
});

describe("anonymous image bake policy", () => {
  it("defaults off and lets only an org admin change it", async () => {
    api = await bootTestApi();
    const read = await fetch(`${api.baseUrl}/api/org`);
    expect(await read.json()).toMatchObject({ allowAnonymousImageBakes: false });
    for (const enabled of [true, false]) {
      const response = await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH", headers: ADMIN_HEADERS,
        body: JSON.stringify({ allowAnonymousImageBakes: enabled }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ allowAnonymousImageBakes: enabled });
    }
    const denied = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH", headers: MEMBER_HEADERS,
      body: JSON.stringify({ allowAnonymousImageBakes: true }),
    });
    expect(denied.status).toBe(403);
    const invalid = await fetch(`${api.baseUrl}/api/org/settings`, {
      method: "PATCH", headers: ADMIN_HEADERS,
      body: JSON.stringify({ allowAnonymousImageBakes: "yes" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Send true or false");
  });

  it("stores a compaction window, rejects one out of range, and clears it with null", async () => {
    api = await bootTestApi();
    const patch = (body: unknown, headers = ADMIN_HEADERS) => fetch(`${api!.baseUrl}/api/org/settings`, {
      method: "PATCH", headers, body: JSON.stringify(body),
    });

    const set = await patch({ compactionWindowTokens: 150_000 });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { compactionWindowTokens: number }).compactionWindowTokens).toBe(150_000);
    expect((await getOrgRow(api))?.compactionWindowTokens).toBe(150_000);
    const org = (await (await fetch(`${api.baseUrl}/api/org`)).json()) as { compactionWindowTokens: number | null };
    expect(org.compactionWindowTokens).toBe(150_000);

    for (const bad of [10_000, 2_000_000, 150_000.5, "150000", -1]) {
      const res = await patch({ compactionWindowTokens: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/0 for no cap/);
    }
    expect((await patch({ compactionWindowTokens: 0 })).status).toBe(200);
    expect((await getOrgRow(api))?.compactionWindowTokens).toBe(0);
    expect((await patch({ compactionWindowTokens: null })).status).toBe(200);
    expect((await getOrgRow(api))?.compactionWindowTokens).toBeNull();

    expect((await patch({ compactionWindowTokens: 150_000 }, MEMBER_HEADERS)).status).toBe(403);
  });
});
