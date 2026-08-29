/**
 * Plugin entitlement rail — route + create-gate integration
 * (docs/specs/2026-08-29-plugin-entitlements-design.md).
 *
 * Boots the real app. `local-user` is an org admin, `test-member` a plain
 * member (see `_setup.ts`). The security plugin is seeded by default, so
 * `isPluginLoaded("security")` is true and the create gate turns on the org
 * mode. One suite boots with `omitSecurityPlugin` to prove the
 * instance-disabled path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { bootTestApi, type TestApi } from "./_setup.js";
import { teamMembers, teams } from "../schema/index.js";
import type {
  OrgPluginsResponse,
  OrgResponse,
  PatchOrgPluginResponse,
} from "../wire/types.js";

const ADMIN = "local-user";
const MEMBER = "test-member";

async function asUser(
  api: TestApi,
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${api.baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-valet-test-user-id": userId, ...(init?.headers ?? {}) },
  });
}

async function patchPlugin(
  api: TestApi,
  userId: string,
  name: string,
  body: { mode: string; teamIds?: string[] },
): Promise<Response> {
  return asUser(api, userId, `/api/org/plugins/${name}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: FAKE_SHA };

async function createSecurity(api: TestApi, userId: string): Promise<Response> {
  return asUser(api, userId, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      workspace: `/tmp/valet-ent-${randomUUID()}`,
      kind: "security",
      repo: REPO,
    }),
  });
}

describe("plugin entitlement routes", () => {
  let api: TestApi;
  afterEach(async () => {
    await api?.cleanup();
  });

  it("PATCH /api/org/plugins/:name refuses a non-admin", async () => {
    api = await bootTestApi();
    const res = await patchPlugin(api, MEMBER, "security", { mode: "off" });
    expect(res.status).toBe(403);
  });

  it("PATCH accepts an admin and updates the entry", async () => {
    api = await bootTestApi();
    const res = await patchPlugin(api, ADMIN, "security", { mode: "off" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchOrgPluginResponse;
    expect(body.name).toBe("security");
    expect(body.entitlement).toEqual({ mode: "off", teamIds: [] });
    expect(body.instanceEnabled).toBe(true);
    expect(body.enabledForCaller).toBe(false);
  });

  it("PATCH 404s an unknown plugin name", async () => {
    api = await bootTestApi();
    const res = await patchPlugin(api, ADMIN, "does-not-exist", { mode: "all" });
    expect(res.status).toBe(404);
  });

  it("PATCH 400s a bad mode", async () => {
    api = await bootTestApi();
    const res = await patchPlugin(api, ADMIN, "security", { mode: "sometimes" });
    expect(res.status).toBe(400);
  });

  it("GET /api/org reports enabledForCaller for all / off / teams", async () => {
    api = await bootTestApi();

    // Default (unconfigured) → all → enabled for a plain member.
    let org = (await (await asUser(api, MEMBER, "/api/org")).json()) as OrgResponse;
    let sec = org.plugins.find((p) => p.name === "security");
    expect(sec?.enabledForCaller).toBe(true);
    expect(sec?.entitlement.mode).toBe("all");

    // off → disabled for the member.
    await patchPlugin(api, ADMIN, "security", { mode: "off" });
    org = (await (await asUser(api, MEMBER, "/api/org")).json()) as OrgResponse;
    sec = org.plugins.find((p) => p.name === "security");
    expect(sec?.enabledForCaller).toBe(false);

    // teams with a team the member is on → enabled; a member not on it → off.
    const teamId = `team_${randomUUID()}`;
    await api.providers.db.insert(teams).values({
      id: teamId,
      orgId: "local-org",
      name: "Sec Team",
      origin: "local",
      externalId: null,
      createdAt: Date.now(),
    });
    await api.providers.db.insert(teamMembers).values({ teamId, userId: MEMBER, role: "member" });
    const patched = await patchPlugin(api, ADMIN, "security", { mode: "teams", teamIds: [teamId] });
    expect(patched.status).toBe(200);

    org = (await (await asUser(api, MEMBER, "/api/org")).json()) as OrgResponse;
    sec = org.plugins.find((p) => p.name === "security");
    expect(sec?.enabledForCaller).toBe(true);

    // The admin is not on the team → off for them under teams mode.
    org = (await (await asUser(api, ADMIN, "/api/org")).json()) as OrgResponse;
    sec = org.plugins.find((p) => p.name === "security");
    expect(sec?.enabledForCaller).toBe(false);
  });

  it("GET /api/org/plugins is readable by a non-admin member", async () => {
    api = await bootTestApi();
    const res = await asUser(api, MEMBER, "/api/org/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgPluginsResponse;
    expect(body.plugins.some((p) => p.name === "security")).toBe(true);
  });
});

describe("plugin entitlement create gate", () => {
  let api: TestApi;
  afterEach(async () => {
    await api?.cleanup();
  });

  it("allows a security session when the org mode is all (default)", async () => {
    api = await bootTestApi();
    const res = await createSecurity(api, ADMIN);
    expect(res.status).toBe(201);
  });

  it("403s a security session when the org mode is off", async () => {
    api = await bootTestApi();
    await patchPlugin(api, ADMIN, "security", { mode: "off" });
    const res = await createSecurity(api, MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s a teams-mode caller who is not in a listed team", async () => {
    api = await bootTestApi();
    // A team the member is NOT on.
    const teamId = `team_${randomUUID()}`;
    await api.providers.db.insert(teams).values({
      id: teamId,
      orgId: "local-org",
      name: "Other Team",
      origin: "local",
      externalId: null,
      createdAt: Date.now(),
    });
    await patchPlugin(api, ADMIN, "security", { mode: "teams", teamIds: [teamId] });
    const res = await createSecurity(api, MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s a security session when the plugin is instance-disabled", async () => {
    api = await bootTestApi({ omitSecurityPlugin: true });
    const res = await createSecurity(api, ADMIN);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not enabled on this deployment");
  });
});
