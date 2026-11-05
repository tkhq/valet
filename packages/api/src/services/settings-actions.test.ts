import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DecisionGateRequest, PluginActionContext, Principal } from "@valet/engine";
import { buildPluginCatalog, invokeAction } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies, agentSessions, orgMembers, orgs, runtimeGrants, teamMembers, teams, users } from "../schema/index.js";
import { buildPolicyResolver, writeSessionGrant } from "../policies/service.js";
import { settingsActionPlugin } from "./settings-actions.js";
import { DEFAULT_TIER_MAP, setOrgDefaultTier, setOrgTierMap } from "./model-tiers.js";
import { createLlmProvider } from "./llm-providers.js";

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
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await api.cleanup(); });

  function action(id: string) {
    const found = settingsActionPlugin(api.providers.db, () => api.providers.engineCredentials).actions.find(a => a.id === `settings.${id}`);
    if (!found) throw new Error(`Missing settings action ${id}`);
    return found;
  }

  async function sharedTeamPolicy() {
    const db = api.providers.db;
    await db.insert(teams).values({ id: "settings-team", orgId: "local-org", name: "Settings team", createdAt: 1 });
    await db.insert(teamMembers).values([
      { teamId: "settings-team", userId: "local-user", role: "admin" },
      { teamId: "settings-team", userId: "test-member", role: "admin" },
    ]);
    await db.update(orgMembers).set({ role: "admin" }).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "test-member")));
    await db.insert(agentSessions).values({ id: "assistant", userId: "local-user", orgId: "local-org", workspace: "test",
      ownerType: "team", ownerId: "settings-team", createdAt: 1, updatedAt: 1 });
    const owner: Principal = { type: "team", id: "settings-team" };
    return {
      owner,
      catalog: buildPluginCatalog([settingsActionPlugin(db, () => api.providers.engineCredentials)]),
      policyResolver: buildPolicyResolver({ db, actionPluginByService: api.providers.actionPluginByService }),
    };
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

  it.each(["", "   ", " \t\r\n", "\u00a0\u2003"])("rejects blank organization name %j without changing either setting", async (name) => {
    const db = api.providers.db;
    await setOrgDefaultTier(db, "local-org", "m");
    const [before] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, "local-org"));

    const result = await action("update_organization").execute({ name, defaultTier: null }, context());

    const [after] = await db.select({ name: orgs.name, defaultTier: orgs.defaultTier }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(after).toEqual({ name: before?.name, defaultTier: "m" });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/name.*blank|blank.*name/i) });
  });

  it("preserves surrounding whitespace in a nonblank organization name", async () => {
    const result = await action("update_organization").execute({ name: "  Named organization  " }, context());

    expect(result).toMatchObject({ success: true, data: { name: "  Named organization  " } });
    const [org] = await api.providers.db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(org?.name).toBe("  Named organization  ");
  });

  it("rejects a NUL in the organization name without clearing the saved default tier", async () => {
    const db = api.providers.db;
    await setOrgDefaultTier(db, "local-org", "m");
    const [before] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, "local-org"));

    const result = await action("update_organization").execute({ name: "Bad\u0000name", defaultTier: null }, context());

    const [after] = await db.select({ name: orgs.name, defaultTier: orgs.defaultTier }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(after).toEqual({ name: before?.name, defaultTier: "m" });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/name.*NUL|NUL.*name/i) });
  });

  it("rolls back the default tier when the database rejects the organization rename", async () => {
    const db = api.providers.db;
    await setOrgDefaultTier(db, "local-org", "m");
    const [before] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, "local-org"));
    await db.execute(sql`ALTER TABLE orgs ADD CONSTRAINT test_reject_rename CHECK (name <> 'Rejected organization')`);

    await expect(action("update_organization").execute({ name: "Rejected organization", defaultTier: null }, context()))
      .rejects.toMatchObject({ cause: { constraint: "test_reject_rename" } });

    const [after] = await db.select({ name: orgs.name, defaultTier: orgs.defaultTier }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(after).toEqual({ name: before?.name, defaultTier: "m" });
  });

  it("saves the organization name and a usable default tier together", async () => {
    const db = api.providers.db;
    const provider = await createLlmProvider(db, { orgId: "local-org", kind: "anthropic", name: "Anthropic" });
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, `llm:${provider.id}`, { type: "api_key", apiKey: "test-anthropic-key" });

    const result = await action("update_organization").execute({ name: "Renamed together", defaultTier: "m" }, context());

    expect(result).toMatchObject({ success: true, data: { name: "Renamed together", defaultTier: "m" } });
    const [after] = await db.select({ name: orgs.name, defaultTier: orgs.defaultTier, modelTiers: orgs.modelTiers }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(after).toEqual({ name: "Renamed together", defaultTier: "m", modelTiers: null });
  });

  it("keeps the organization name when a competing tier edit makes the requested default unusable", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    const db = api.providers.db;
    const [before] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, "local-org"));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await setOrgTierMap(db, "local-org", { ...DEFAULT_TIER_MAP, m: ["openai/gpt-4.1"] });
      return transaction(callback);
    });

    const result = await action("update_organization").execute({ name: "Invalid default", defaultTier: "m" }, context());

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('serves tier "m"') });
    const [after] = await db.select({ name: orgs.name, defaultTier: orgs.defaultTier }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(after).toEqual({ name: before?.name, defaultTier: null });
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

  it.each(["approve_session", "always_allow", "always_allow_owner"])("refuses actor %s grants before another teammate can reuse them", async (answer) => {
    const { catalog, owner, policyResolver } = await sharedTeamPolicy();
    const gates: DecisionGateRequest[] = [];
    const first = await invokeAction(catalog, "settings.update_account", { name: "First actor" }, context({
      owner, policyResolver, requestDecision: async (request) => {
        gates.push(request);
        return { actionId: answer, resolvedBy: "local-user", resolvedAt: 1 };
      },
    }), "Change my name");
    const second = await invokeAction(catalog, "settings.update_account", { name: "Unapproved teammate" }, context({
      owner, policyResolver, userId: "test-member", interactiveActor: { id: "test-member" },
      requestDecision: async (request) => {
        gates.push(request);
        return { actionId: "deny", resolvedBy: "test-member", resolvedAt: 2 };
      },
    }), "Change my name");

    const [person] = await api.providers.db.select({ name: users.name }).from(users).where(eq(users.id, "test-member"));
    expect(person?.name).not.toBe("Unapproved teammate");
    expect(first.kind).toBe("denied-approval");
    expect(second.kind).toBe("denied-approval");
    expect(gates).toHaveLength(2);
    expect(gates[0]?.actions?.map((action) => action.id)).toEqual(["approve", "deny"]);
    expect(await api.providers.db.select().from(runtimeGrants).where(eq(runtimeGrants.sessionId, "assistant"))).toEqual([]);
    expect(await api.providers.db.select().from(actionPolicies).where(eq(actionPolicies.actionId, "settings.update_account"))).toEqual([]);
  });

  it.each([
    { id: "settings.update_account", params: { name: "Unapproved teammate" }, expected: { name: "Unapproved teammate" } },
    { id: "settings.update_team", params: { team_id: "settings-team", defaultModel: "m" }, expected: { teamId: "settings-team", defaultModel: "m" } },
    { id: "settings.update_organization", params: { name: "Unapproved organization" }, expected: { name: "Unapproved organization" } },
  ])("requires fresh actor approval despite an existing session grant for $id", async ({ id, params, expected }) => {
    const { catalog, owner, policyResolver } = await sharedTeamPolicy();
    const db = api.providers.db;
    await writeSessionGrant(db, "assistant", { orgId: "local-org", service: "settings", actionId: id, grantedBy: "local-user", now: 1 });
    const gates: DecisionGateRequest[] = [];
    const result = await invokeAction(catalog, id, params, context({
      owner, policyResolver, userId: "test-member", interactiveActor: { id: "test-member" },
      requestDecision: async (request) => {
        gates.push(request);
        return { actionId: "deny", resolvedBy: "test-member", resolvedAt: 2 };
      },
    }), "Change settings");

    expect(result.kind).toBe("denied-approval");
    expect(gates).toHaveLength(1);
    expect(gates[0]?.context?.approver).toEqual({ userId: "test-member" });
    const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, "test-member"));
    const [team] = await db.select({ defaultModel: teams.defaultModel }).from(teams).where(eq(teams.id, "settings-team"));
    const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(person?.name).not.toBe("Unapproved teammate");
    expect(team?.defaultModel).toBeNull();
    expect(org?.name).toBe("Local Dev");

    const approved = await invokeAction(catalog, id, params, context({
      owner, policyResolver, userId: "test-member", interactiveActor: { id: "test-member" },
      requestDecision: async (request) => {
        gates.push(request);
        return { actionId: "approve", resolvedBy: "test-member", resolvedAt: 3 };
      },
    }), "Change settings");
    expect(approved).toMatchObject({ kind: "ok", result: { success: true, data: expected } });
    expect(gates).toHaveLength(2);
    expect(gates[1]?.context?.approver).toEqual({ userId: "test-member" });
  });

  it.each([false, true])("refuses an unverified actor before opening a gate (resolver: %s)", async (withResolver) => {
    const { catalog, policyResolver } = await sharedTeamPolicy();
    let gates = 0;
    const result = await invokeAction(catalog, "settings.update_account", { name: "Unverified" }, context({
      interactiveActor: undefined, ...(withResolver ? { policyResolver } : {}),
      requestDecision: async () => {
        gates++;
        return { actionId: "approve", resolvedBy: "local-user", resolvedAt: 1 };
      },
    }), "Change my name");

    expect(gates).toBe(0);
    expect(result).toMatchObject({ kind: "error", message: expect.stringMatching(/verified.*author/i) });
    const [person] = await api.providers.db.select({ name: users.name }).from(users).where(eq(users.id, "local-user"));
    expect(person?.name).not.toBe("Unverified");
  });

  it.each(["org", "team"] satisfies Array<"org" | "team">)("retains %s deny policies despite an actor's existing grant", async (scope) => {
    const { catalog, owner, policyResolver } = await sharedTeamPolicy();
    const db = api.providers.db;
    await writeSessionGrant(db, "assistant", { orgId: "local-org", service: "settings", actionId: "settings.update_account", grantedBy: "local-user", now: 1 });
    await db.insert(actionPolicies).values({ id: "settings-deny", orgId: "local-org", principalType: scope,
      principalId: scope === "org" ? "local-org" : "settings-team", actionId: "settings.update_account", mode: "deny",
      paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 1, updatedAt: 1 });
    let gates = 0;
    const result = await invokeAction(catalog, "settings.update_account", { name: "Denied" }, context({
      owner, policyResolver, requestDecision: async () => { gates++; return { actionId: "approve", resolvedBy: "local-user", resolvedAt: 2 }; },
    }), "Change my name");

    expect(result).toMatchObject({ kind: "denied-policy", ...(scope === "team" ? { scope: "team" } : {}) });
    expect(gates).toBe(0);
    const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, "local-user"));
    expect(person?.name).not.toBe("Denied");
  });

  it("keeps ordinary read grants reusable by teammates without actor approval", async () => {
    const { catalog, owner, policyResolver } = await sharedTeamPolicy();
    const db = api.providers.db;
    await db.insert(actionPolicies).values({ id: "settings-read-approval", orgId: "local-org", principalType: "org", principalId: "local-org",
      actionId: "settings.get_settings", mode: "require_approval", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 1, updatedAt: 1 });
    await writeSessionGrant(db, "assistant", { orgId: "local-org", service: "settings", actionId: "settings.get_settings", grantedBy: "local-user", now: 1 });
    const result = await invokeAction(catalog, "settings.get_settings", { scope: "organization" }, context({
      owner, policyResolver, userId: "test-member", interactiveActor: { id: "test-member" },
    }), "Read organization settings");
    expect(result).toMatchObject({ kind: "ok", result: { success: true, data: { name: "Local Dev" } } });
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
    const patch = { name: "Invalid default", defaultTier: "not-a-tier" };
    const response = await fetch(`${api.baseUrl}/api/org/model-tiers`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultTier: patch.defaultTier }) });
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("error" in body)) throw new Error("Missing route error");
    expect(await action("update_organization").execute(patch, context())).toMatchObject({ success: false, error: body.error });
    const [after] = await api.providers.db.select({ name: orgs.name, defaultTier: orgs.defaultTier }).from(orgs).where(eq(orgs.id, "local-org"));
    expect(after).toEqual({ name: "Local Dev", defaultTier: null });
  });
  async function preferences(): Promise<unknown[]> {
    const body: unknown = await fetch(`${api.baseUrl}/api/notifications/preferences`).then(r => r.json());
    if (!body || typeof body !== "object" || !("preferences" in body) || !Array.isArray(body.preferences)) throw new Error("Missing preferences");
    return body.preferences;
  }

  it("changes one notification kind for the person typing and keeps fields it was not asked to change", async () => {
    await fetch(`${api.baseUrl}/api/notifications/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "question", web: true, teamDm: true, channelGraceSeconds: 30 }) });
    const result = await action("update_notifications").execute({ kind: "question", web: false }, context());
    expect(result).toMatchObject({ success: true, data: { url: "/settings/notifications" } });
    const saved = await preferences();
    expect(saved).toContainEqual({ kind: "question", web: false, teamDm: true, channelGraceSeconds: 30 });
    expect(saved).toContainEqual({ kind: "approval", web: true, teamDm: false, channelGraceSeconds: 120 });
    const other = await action("get_settings").execute({ scope: "notifications" }, context({ userId: "test-member", interactiveActor: { id: "test-member" }, owner: { type: "user", id: "test-member" } }));
    expect(other).toMatchObject({ success: true, data: { preferences: expect.arrayContaining([{ kind: "question", web: true, teamDm: false, channelGraceSeconds: 120 }]) } });
  });

  it("refuses notification changes outside an interactive conversation", async () => {
    expect((await action("update_notifications").execute({ kind: "approval", web: false }, context({ sessionPurpose: "workflow" }))).success).toBe(false);
    expect(await preferences()).toContainEqual(expect.objectContaining({ kind: "approval", web: true }));
  });

  it("reads account settings by default and the current team when a team read names none", async () => {
    expect(await action("get_settings").execute({}, context())).toMatchObject({ success: true, data: { url: "/settings/profile" } });
    await api.providers.db.insert(teams).values({ id: "team-a", orgId: "local-org", name: "A", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values({ teamId: "team-a", userId: "local-user", role: "member" });
    const read = await action("get_settings").execute({ scope: "team" }, context({ owner: { type: "team", id: "team-a" } }));
    expect(read).toMatchObject({ success: true, data: { teamId: "team-a", name: "A" } });
    expect((await action("get_settings").execute({ scope: "team" }, context())).success).toBe(false);
  });
});
