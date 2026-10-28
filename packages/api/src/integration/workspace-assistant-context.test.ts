import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "@valet/engine/test-helpers";
import { eq } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { settingsActionPlugin } from "../services/settings-actions.js";
import { mintCliToken } from "../auth/cli-tokens.js";
import { writeSessionGrant } from "../policies/service.js";
import { orgMembers, orgs, teamMembers, teams, users } from "../schema/index.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; faux?.unregister(); faux = undefined; vi.unstubAllEnvs(); });

async function bootSettings(auth = false) {
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  api = await bootTestApi({ auth });
  const actions = settingsActionPlugin(api.providers.db, () => {
    if (!api) throw new Error("API closed");
    return api.providers.engineCredentials;
  });
  const plugin: ValetPlugin = { name: "settings-actions", version: "0.1.0", actions: [actions] };
  api.providers.plugins.push(plugin);
  api.providers.actionPluginByService.set("settings", { plugin, actionPlugin: actions });
  return { local: api, model: faux };
}

async function createThread(local: TestApi, workspace = "user", headers: Record<string, string> = {}) {
  const response = await fetch(`${local.baseUrl}/api/threads?workspace=${workspace}`, { method: "POST", headers });
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("sessionId" in value) || typeof value.sessionId !== "string") throw new Error("Missing thread address");
  return { threadId: value.id, sessionId: value.sessionId };
}

function settingsResponse(model: FauxProviderRegistration, toolId: string, args: { name: string }) {
  model.setResponses([
    fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: toolId, params: args, summary: "Change the requested settings" }, { id: "settings-call" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished."),
  ]);
}

async function submit(local: TestApi, threadId: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${local.baseUrl}/api/threads/${threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "Change my settings" }),
  });
  expect(response.status).toBe(202);
}

async function pendingGate(local: TestApi, sessionId: string) {
  return vi.waitFor(async () => {
    const gates = await local.providers.engineStore.listDecisionGates(sessionId, undefined, "pending");
    const gate = gates.find(item => item.context?.service === "settings");
    if (!gate) throw new Error("Waiting for settings approval");
    return gate;
  });
}

it("lets only the original human approve an organization change in a shared team thread", async () => {
  const { local, model } = await bootSettings();
  await local.providers.db.insert(teams).values({ id: "shared-team", orgId: "local-org", name: "Shared", createdAt: 1 });
  await local.providers.db.insert(teamMembers).values([
    { teamId: "shared-team", userId: "local-user", role: "admin" },
    { teamId: "shared-team", userId: "test-member", role: "member" },
  ]);
  const { threadId, sessionId } = await createThread(local, "shared-team");
  settingsResponse(model, "settings.update_organization", { name: "Approved organization" });
  await submit(local, threadId);
  const gate = await pendingGate(local, sessionId);
  const resolve = (userId: string) => fetch(`${local.baseUrl}/api/threads/${threadId}/decisions/${encodeURIComponent(gate.id)}/resolve`, {
    method: "POST", headers: { "content-type": "application/json", "x-valet-test-user-id": userId }, body: JSON.stringify({ actionId: "approve" }),
  });
  expect((await resolve("test-member")).status).toBe(403);
  expect((await local.providers.engineStore.getDecisionGate(sessionId, gate.id))?.status).toBe("pending");
  expect((await resolve("local-user")).status).toBe(200);
  await vi.waitFor(async () => {
    const [row] = await local.providers.db.select().from(orgs).where(eq(orgs.id, "local-org"));
    expect(row?.name).toBe("Approved organization");
  });
});

it("preserves the persisted human author when a pending settings approval replays after restart", async () => {
  const { local, model } = await bootSettings();
  const { threadId, sessionId } = await createThread(local);
  settingsResponse(model, "settings.update_account", { name: "Saved after restart" });
  await submit(local, threadId);
  const gate = await pendingGate(local, sessionId);
  await vi.waitFor(async () => expect((await local.providers.engineStore.getQueueItem(sessionId, gate.queueItemId))?.status).toBe("blocked_on_decision_gate"));
  local.providers.engineHost.evictCache(sessionId);
  const response = await fetch(`${local.baseUrl}/api/threads/${threadId}/decisions/${encodeURIComponent(gate.id)}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId: "approve" }),
  });
  expect(response.status).toBe(200);
  await vi.waitFor(async () => {
    const [row] = await local.providers.db.select().from(users).where(eq(users.id, "local-user"));
    expect(row?.name).toBe("Saved after restart");
  });
});

it("refuses a CLI-authored settings write even when that user has a lasting session grant", async () => {
  const { local, model } = await bootSettings(true);
  const signup = await fetch(`${local.baseUrl}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Person", email: "settings-agent@example.test", password: "correct-horse-battery" }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
  if (!cookie) throw new Error("Missing browser session cookie");
  const [person] = await local.providers.db.select().from(users).where(eq(users.email, "settings-agent@example.test"));
  if (!person) throw new Error("Missing signed-in person");
  const [membership] = await local.providers.db.select().from(orgMembers).where(eq(orgMembers.userId, person.id));
  if (!membership) throw new Error("Missing person organization");
  const token = await mintCliToken(local.providers.db, person.id, "agent repro");
  const headers = { "x-api-key": token.access_token };
  const { threadId, sessionId } = await createThread(local, "user", headers);
  expect((await fetch(`${local.baseUrl}/api/me`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Agent edit" }) })).status).toBe(403);
  await writeSessionGrant(local.providers.db, sessionId, { orgId: membership.orgId, service: "settings", actionId: "settings.update_account", grantedBy: person.id, now: Date.now() });
  settingsResponse(model, "settings.update_account", { name: "Agent edit" });
  await submit(local, threadId, headers);
  await vi.waitFor(async () => {
    const entries = await local.providers.engineStore.getEntries(sessionId, threadId);
    expect(entries.some(entry => entry.type === "message" && entry.role === "assistant" && entry.content === "Finished.")).toBe(true);
  });
  const [row] = await local.providers.db.select().from(users).where(eq(users.id, person.id));
  expect(row?.name).not.toBe("Agent edit");
  expect(await local.providers.engineStore.listDecisionGates(sessionId, undefined, "pending")).toHaveLength(0);
  settingsResponse(model, "settings.update_account", { name: "Browser edit" });
  await submit(local, threadId, { cookie });
  const gate = await pendingGate(local, sessionId);
  expect(gate.context?.approver).toEqual({ userId: person.id });
  expect(gate.actions.map(action => action.id)).toEqual(["approve", "deny"]);
  const [beforeApproval] = await local.providers.db.select().from(users).where(eq(users.id, person.id));
  expect(beforeApproval?.name).not.toBe("Browser edit");
  const approved = await fetch(`${local.baseUrl}/api/threads/${threadId}/decisions/${encodeURIComponent(gate.id)}/resolve`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ actionId: "approve" }),
  });
  expect(approved.status).toBe(200);
  await vi.waitFor(async () => {
    const [changed] = await local.providers.db.select().from(users).where(eq(users.id, person.id));
    expect(changed?.name).toBe("Browser edit");
  });
});

it("stores page hints per helper submission and drops unsupported or unsafe hints without blocking messages", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  faux.appendResponses(Array.from({ length: 5 }, () => () => fauxAssistantMessage("Ready.")));
  api = await bootTestApi();
  const local = api;
  const response = await fetch(`${local.baseUrl}/api/workspaces/user/conversation`, { method: "POST" });
  const conversation: unknown = await response.json();
  if (!conversation || typeof conversation !== "object" || !("sessionId" in conversation) || typeof conversation.sessionId !== "string" || !("threadId" in conversation) || typeof conversation.threadId !== "string") throw new Error("No helper conversation");
  const { sessionId, threadId } = conversation;
  const hints = [
    { pathname: "/settings/profile", workspace: "user" },
    { pathname: "/integrations", workspace: "user" },
    { pathname: "/settings/appearance", workspace: "user" },
    { pathname: "/unknown-route", workspace: "user" },
    { pathname: "/settings?token=secret", workspace: "user" },
  ];
  for (const [index, appPageHint] of hints.entries()) {
    const text = `Help ${index}`;
    const sent = await fetch(`${local.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, threadId, appPageHint }),
    });
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      const entries = await local.providers.engineStore.getEntries(sessionId, threadId);
      const entry = entries.find(e => e.type === "message" && e.role === "user" && e.content === text);
      expect(entry).toBeDefined();
      expect(entry?.metadata?.appPageHint).toEqual(index < 2 ? appPageHint : undefined);
    });
  }
});
