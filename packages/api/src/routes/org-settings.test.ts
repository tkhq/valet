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
