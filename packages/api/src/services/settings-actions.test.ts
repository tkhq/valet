import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { PluginActionContext, Principal } from "@valet/engine";
import { buildPluginCatalog, invokeAction } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgMembers, orgs, teamMembers, teams, users } from "../schema/index.js";
import { settingsActionPlugin } from "./settings-actions.js";

function context(overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  const unused = (): never => { throw new Error("Unexpected settings dependency"); };
  return {
    actionId: "settings.test", service: "settings", userId: "local-user", orgId: "local-org",
    sessionId: "assistant", threadId: "helper", sessionPurpose: "orchestrator",
    owner: { type: "user", id: "local-user" }, interactiveActor: { id: "local-user" },
    credentials: { get: async () => null, request: async () => unused() },
    sandbox: { id: "unused", readFile: async () => unused(), readBinary: async () => unused(),
      writeFile: async () => unused(), writeBinary: async () => unused(), readdir: async () => unused(),
      stat: async () => unused(), mkdir: async () => unused(), rm: async () => unused(), exec: async () => unused() },
    requestDecision: async () => unused(), signal: new AbortController().signal,
    threadRead: async () => unused(), listThreads: async () => unused(), setModel: async () => unused(), ...overrides,
  };
}

describe("settings actions", () => {
  let api: TestApi;
  beforeEach(async () => { api = await bootTestApi(); });
  afterEach(async () => { await api.cleanup(); });

  function action(id: string) {
    const found = settingsActionPlugin(api.providers.db, () => api.providers.engineCredentials).actions.find(a => a.id === `settings.${id}`);
    if (!found) throw new Error(`Missing settings action ${id}`);
    return found;
  }

  it("changes only the authenticated account and returns a safe settings projection", async () => {
    const result = await action("update_account").execute({ name: "Ada", timezone: "America/New_York", defaultModel: "m", defaultReasoning: null }, context());
    expect(result.success).toBe(true);
    const response = await fetch(`${api.baseUrl}/api/me`).then(r => r.json());
    expect(response).toMatchObject({ name: "Ada", timezone: "America/New_York", defaultModel: "m", defaultReasoning: null });
    expect(result.data).toMatchObject({ name: "Ada", timezone: "America/New_York", url: "/settings/profile" });
    expect(result.data).not.toHaveProperty("email");
    expect(result.data).not.toHaveProperty("role");
  });

  it.each([{ timezone: "bad-zone" }, { defaultModel: "missing-model" }, { defaultReasoning: "impossible" }])("shares route validation for %j", async (patch) => {
    const response = await fetch(`${api.baseUrl}/api/me`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("error" in body)) throw new Error("Missing route error");
    expect(await action("update_account").execute(patch, context())).toMatchObject({ success: false, error: body.error });
  });

  it.each([
    { interactiveActor: undefined }, { interactiveActor: { id: "test-member" } }, { externalSender: true },
    { sessionPurpose: "workflow" }, { sessionPurpose: "child" }, { orgId: "foreign-org" },
  ] satisfies Partial<PluginActionContext>[]) ("rejects noninteractive or foreign account context %j", async (overrides) => {
    expect((await action("update_account").execute({ name: "Unauthorized" }, context(overrides))).success).toBe(false);
    const [row] = await api.providers.db.select().from(users).where(eq(users.id, "local-user"));
    expect(row?.name).not.toBe("Unauthorized");
  });

  it("uses the current actor when the same team runtime serves another member", async () => {
    const db = api.providers.db;
    await db.insert(teams).values({ id: "team-a", orgId: "local-org", name: "A", createdAt: 1 });
    await db.insert(teamMembers).values([{ teamId: "team-a", userId: "local-user", role: "admin" }, { teamId: "team-a", userId: "test-member", role: "member" }]);
    const owner: Principal = { type: "team", id: "team-a" };
    expect((await action("update_account").execute({ name: "Second actor" }, context({ owner, userId: "test-member", interactiveActor: { id: "test-member" } }))).success).toBe(true);
    const [first] = await db.select().from(users).where(eq(users.id, "local-user"));
    const [second] = await db.select().from(users).where(eq(users.id, "test-member"));
    expect(first?.name).not.toBe("Second actor");
    expect(second?.name).toBe("Second actor");
  });

  it("edits only an authorized current team and rechecks a demotion before replay", async () => {
    const db = api.providers.db;
    await db.insert(teams).values([{ id: "team-a", orgId: "local-org", name: "A", createdAt: 1 }, { id: "team-b", orgId: "local-org", name: "B", createdAt: 1 }]);
    await db.insert(teamMembers).values({ teamId: "team-a", userId: "test-member", role: "admin" });
    const ctx = context({ userId: "test-member", interactiveActor: { id: "test-member" }, owner: { type: "team", id: "team-a" } });
    expect((await action("update_team").execute({ team_id: "team-a", defaultModel: "m" }, ctx)).success).toBe(true);
    expect((await action("update_team").execute({ team_id: "team-b", defaultModel: "l" }, ctx)).success).toBe(false);
    await db.update(teamMembers).set({ role: "member" }).where(and(eq(teamMembers.teamId, "team-a"), eq(teamMembers.userId, "test-member")));
    expect((await action("update_team").execute({ team_id: "team-a", defaultModel: "l" }, ctx)).success).toBe(false);
    const [row] = await db.select().from(teams).where(eq(teams.id, "team-a"));
    expect(row?.defaultModel).toBe("m");
  });

  it("requires current org-admin authority and never changes a foreign organization", async () => {
    expect((await action("update_organization").execute({ name: "Renamed", defaultTier: null }, context())).success).toBe(true);
    const [org] = await api.providers.db.select().from(orgs).where(eq(orgs.id, "local-org"));
    expect(org?.name).toBe("Renamed");
    await api.providers.db.update(orgMembers).set({ role: "member" }).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "local-user")));
    expect((await action("update_organization").execute({ name: "Denied" }, context())).success).toBe(false);
    expect((await action("update_organization").execute({ name: "Denied" }, context({ orgId: "foreign-org" }))).success).toBe(false);
  });

  it("keeps the catalog approval gate and rechecks authority after approval", async () => {
    const plugin = settingsActionPlugin(api.providers.db, () => api.providers.engineCredentials);
    let approvals = 0;
    const result = await invokeAction(buildPluginCatalog([plugin]), "settings.update_organization", { name: "Late edit" }, context({
      requestDecision: async () => {
        approvals++;
        await api.providers.db.update(orgMembers).set({ role: "member" }).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "local-user")));
        return { actionId: "approve", resolvedBy: "local-user", resolvedAt: Date.now() };
      },
    }), "Rename the organization");
    expect(approvals).toBe(1);
    expect(result).toMatchObject({ kind: "ok", result: { success: false } });
    const [row] = await api.providers.db.select().from(orgs).where(eq(orgs.id, "local-org"));
    expect(row?.name).not.toBe("Late edit");
  });

  it.each(["approve", "approve_session"])("rejects another member's %s before policy grant side effects", async (actionId) => {
    let grants = 0;
    const result = await invokeAction(buildPluginCatalog([settingsActionPlugin(api.providers.db, () => api.providers.engineCredentials)]),
      "settings.update_organization", { name: "Unauthorized approval" }, context({
        policyResolver: {
          resolve: async () => ({ mode: "require_approval", provenance: { baseMode: "require_approval", source: "risk_default" }, extraGateActions: [{ id: "approve_session", label: "Approve for this session", approves: true }] }),
          onResolution: async () => { grants++; },
        },
        requestDecision: async () => ({ actionId, resolvedBy: "test-member", resolvedAt: Date.now() }),
      }), "Rename organization");
    expect(result.kind).toBe("denied-approval");
    expect(grants).toBe(0);
    const [row] = await api.providers.db.select().from(orgs).where(eq(orgs.id, "local-org"));
    expect(row?.name).not.toBe("Unauthorized approval");
  });

  it("binds default catalog approval to the original verified human", async () => {
    const result = await invokeAction(buildPluginCatalog([settingsActionPlugin(api.providers.db, () => api.providers.engineCredentials)]),
      "settings.update_account", { name: "Unauthorized approval" }, context({
        requestDecision: async (request) => {
          expect(request.context?.approver).toEqual({ userId: "local-user" });
          return { actionId: "approve", resolvedBy: "test-member", resolvedAt: Date.now() };
        },
      }), "Change my name");
    expect(result.kind).toBe("denied-approval");
    const [row] = await api.providers.db.select().from(users).where(eq(users.id, "local-user"));
    expect(row?.name).not.toBe("Unauthorized approval");
  });

  it("rejects arbitrary account/org targets and privileged fields at the catalog boundary", async () => {
    const catalog = buildPluginCatalog([settingsActionPlugin(api.providers.db, () => api.providers.engineCredentials)]);
    for (const params of [{ name: "Oops", user_id: "test-member" }, { allowPublicArtifacts: true }, { credentials: "secret" }]) {
      const result = await invokeAction(catalog, "settings.update_account", params, context({ requestDecision: async () => ({ actionId: "approve", resolvedBy: "local-user", resolvedAt: Date.now() }) }), "Change settings");
      expect(result.kind).toBe("invalid-args");
    }
  });

  it("returns only safe organization fields even when credentials exist", async () => {
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "anthropic", { type: "api_key", apiKey: "must-not-appear" });
    const result = await action("get_settings").execute({ scope: "organization" }, context());
    expect(result.success).toBe(true);
    expect(Object.keys(result.data ?? {}).sort()).toEqual(["canEdit", "defaultTier", "modelsUrl", "name", "url"]);
    expect(JSON.stringify(result)).not.toContain("must-not-appear");
  });

  it("shares the organization default-tier validation with its HTTP route", async () => {
    const patch = { defaultTier: "not-a-tier" };
    const response = await fetch(`${api.baseUrl}/api/org/model-tiers`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("error" in body)) throw new Error("Missing route error");
    expect(await action("update_organization").execute(patch, context())).toMatchObject({ success: false, error: body.error });
  });
});
