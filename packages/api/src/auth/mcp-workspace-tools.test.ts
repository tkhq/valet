/**
 * Integration tests for the MCP workspace tools (`mcp-workspace-tools.ts`):
 * skills, memory, workflows, the approvals inbox, and artifacts. Each test
 * uses two users so it proves the route ownership rules hold for MCP
 * callers, and one test proves an MCP agent cannot approve an approval gate.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createPolicy } from "../policies/admin.js";
import { oauthAccessToken, orgMembers, orgs, skills, users } from "../schema/index.js";
import { createWorkflowDefinition } from "../workflows/service.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;

afterEach(async () => {
  faux?.unregister();
  faux = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

const ORG = "ws-org";

function demoPlugin(): ValetPlugin {
  const action = (id: string): PluginAction => ({
    id, name: id, description: `${id} for workspace tool tests.`, riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true, data: { ran: id } }),
  });
  return { name: "demo", version: "0.0.1", actions: [{ service: "demo", actions: [action("demo.ping"), action("demo.risky")] }] };
}

async function seedUser(testApi: TestApi, id: string): Promise<string> {
  const { db } = testApi.providers;
  const now = Date.now();
  await db.insert(orgs).values({ id: ORG, name: "WS Org", createdAt: now }).onConflictDoNothing();
  await db.insert(users).values({ id, name: `User ${id}`, email: `${id}@nowhere.test`, role: "member", createdAt: new Date(now), updatedAt: new Date(now) });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member", createdAt: now });
  await db.insert(oauthAccessToken).values({
    id: `oauth-${id}`, accessToken: `token-${id}`, refreshToken: `refresh-${id}`,
    accessTokenExpiresAt: new Date(now + 600_000), refreshTokenExpiresAt: new Date(now + 3_600_000),
    clientId: null, userId: id, scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now),
  });
  return `token-${id}`;
}

let rpcId = 0;
async function tool(baseUrl: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const { result, error } = (await res.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
  expect(error).toBeUndefined();
  const text = (result?.content ?? []).map((c) => c.text).join("\n");
  const isError = result?.isError === true;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function boot() {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  const testApi = await bootTestApi({ auth: true, plugins: [demoPlugin()] });
  api = testApi;
  return { testApi, alice: await seedUser(testApi, "alice"), bob: await seedUser(testApi, "bob") };
}

describe("MCP workspace tools", () => {
  it("lists and reads a person's own skills and fills placeholders", async () => {
    const { testApi, alice, bob } = await boot();
    const now = Date.now();
    await testApi.providers.db.insert(skills).values({
      id: "skill-1", orgId: ORG, ownerType: "user", ownerId: "alice", origin: "local", name: "deploy-check",
      description: "Checks a deploy before release.", content: "Check the {{service}} deploy, then report.",
      frontmatter: {}, contentSha: "sha-1", createdAt: now, updatedAt: now,
    });

    const listed = await tool(testApi.baseUrl, alice, "list_skills", { query: "deploy" });
    expect(listed.data.skills).toEqual([{ name: "deploy-check", description: "Checks a deploy before release." }]);
    const read = await tool(testApi.baseUrl, alice, "get_skill", { name: "deploy-check", args: { service: "api" } });
    expect(read.data.instructions).toBe("Check the api deploy, then report.");

    expect((await tool(testApi.baseUrl, bob, "list_skills", { query: "deploy" })).data.skills).toEqual([]);
    expect((await tool(testApi.baseUrl, bob, "get_skill", { name: "deploy-check" })).isError).toBe(true);
  });

  it("writes, reads, and searches personal memory without crossing users", async () => {
    const { testApi, alice, bob } = await boot();
    const written = await tool(testApi.baseUrl, alice, "write_memory", {
      path: "projects/valet/decisions.md", content: "# Decisions\n\nWe deploy on Tuesdays.", description: "Release decisions",
    });
    expect(written.isError).toBe(false);

    const read = await tool(testApi.baseUrl, alice, "read_memory", { path: "projects/valet/decisions.md" });
    expect(read.text).toContain("We deploy on Tuesdays.");
    const found = await tool(testApi.baseUrl, alice, "search_memory", { query: "Tuesdays" });
    expect(found.text).toContain("projects/valet/decisions.md");

    expect((await tool(testApi.baseUrl, bob, "search_memory", { query: "Tuesdays" })).text).not.toContain("decisions.md");
    const bobRead = await tool(testApi.baseUrl, bob, "read_memory", { path: "projects/valet/decisions.md" });
    expect(bobRead.isError).toBe(true);
  });

  it("runs a workflow to completion and shows a policy-gated run in the inbox", async () => {
    const { testApi, alice, bob } = await boot();
    const p = testApi.providers;
    await createPolicy(p.db, { orgId: ORG, type: "org", id: ORG }, { actionId: "demo.risky", mode: "require_approval", managedBy: "test", now: Date.now() });
    const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials, engineStore: p.engineStore };
    const owner = { userId: "alice", orgId: ORG };
    const definition = (action: string) => ({
      version: "dag/v1",
      nodes: [{ id: "trigger", type: "trigger" }, { id: "call", type: "tool", service: "demo", action, params: {} }, { id: "done", type: "stop" }],
      edges: [{ from: "trigger", to: "call" }, { from: "call", to: "done" }],
    });
    const ping = await createWorkflowDefinition(deps, owner, { name: "Ping", definition: definition("ping") });
    const risky = await createWorkflowDefinition(deps, owner, { name: "Risky", definition: definition("risky") });

    const listed = await tool(testApi.baseUrl, alice, "list_workflows");
    expect((listed.data.workflows as Array<{ name: string }>).map((w) => w.name).sort()).toEqual(["Ping", "Risky"]);
    expect((await tool(testApi.baseUrl, bob, "list_workflows")).data.workflows).toEqual([]);

    const done = await tool(testApi.baseUrl, alice, "run_workflow", { workflow_id: ping.id, wait_seconds: 30 });
    expect(done.data).toMatchObject({ workflow_id: ping.id, status: "settled", outcome: "completed" });

    const parked = await tool(testApi.baseUrl, alice, "run_workflow", { workflow_id: risky.id, wait_seconds: 30 });
    expect(parked.data).toMatchObject({ pending_approvals: [expect.objectContaining({ kind: "policy_gate", action: "demo.risky" })] });
    const inbox = await tool(testApi.baseUrl, alice, "list_inbox");
    expect(inbox.data.workflow_approvals).toEqual([expect.objectContaining({ run_id: parked.data.run_id, workflow: "Risky", action: "demo.risky" })]);
    expect((await tool(testApi.baseUrl, bob, "list_inbox")).data.workflow_approvals).toEqual([]);
    expect((await tool(testApi.baseUrl, bob, "get_workflow_run", { run_id: parked.data.run_id })).isError).toBe(true);
  });

  it("lists a thread approval in the inbox but refuses to let an MCP agent approve it", async () => {
    const { testApi, alice } = await boot();
    await createPolicy(testApi.providers.db, { orgId: ORG, type: "org", id: ORG }, { actionId: "demo.risky", mode: "require_approval", managedBy: "test", now: Date.now() });
    faux?.appendResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "demo.risky", params: {}, summary: "Run the risky action" }, { id: "tc-risky" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const started = await tool(testApi.baseUrl, alice, "start_thread", { prompt: "Run demo.risky.", wait_seconds: 30 });
    expect(started.data.status).toBe("waiting_for_decision");
    const [gate] = started.data.pending_decisions as Array<{ gate_id: string; type: string; options: Array<{ action_id: string }> }>;
    expect(gate?.type).toBe("approval");

    const inbox = await tool(testApi.baseUrl, alice, "list_inbox");
    expect(inbox.data.thread_decisions).toEqual([expect.objectContaining({ gate_id: gate?.gate_id, type: "approval", agent_can_answer: false })]);

    const refused = await tool(testApi.baseUrl, alice, "resolve_decision", {
      thread_id: started.data.thread_id, gate_id: gate?.gate_id, action_id: gate?.options[0]?.action_id, wait_seconds: 0,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("A person must approve this request");
    expect((await tool(testApi.baseUrl, alice, "list_decisions", { thread_id: started.data.thread_id })).data.decisions).toHaveLength(1);
  });

  it("publishes and lists artifacts per person", async () => {
    const { testApi, alice, bob } = await boot();
    const first = await tool(testApi.baseUrl, alice, "publish_artifact", { key: "reports/tests", title: "Test summary", content: "# All green" });
    expect(first.data).toMatchObject({ key: "reports/tests", version: 1, url: expect.stringContaining("http"), visible_to: "every member of your Valet organization" });
    const second = await tool(testApi.baseUrl, alice, "publish_artifact", { key: "reports/tests", content: "# Still green" });
    expect(second.data).toMatchObject({ version: 2, url: first.data.url });

    const listed = await tool(testApi.baseUrl, alice, "list_artifacts");
    // Without a title, a publish takes the first heading as the title.
    expect(listed.data.artifacts).toEqual([expect.objectContaining({ key: "reports/tests", title: "Still green", version: 2 })]);
    expect((await tool(testApi.baseUrl, bob, "list_artifacts")).data.artifacts).toEqual([]);
  });
});
