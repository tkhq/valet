/**
 * Integration tests for the MCP workspace tools (`mcp-workspace-tools.ts`):
 * skills, memory, workflows, the approvals inbox, and artifacts. Each test
 * uses two users so it proves the route ownership rules hold for MCP
 * callers, and one test proves an MCP agent cannot approve an approval gate.
 */
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "@valet/engine/test-helpers";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createPolicy } from "../policies/admin.js";
import { artifacts, oauthAccessToken, orgMembers, orgs, skills, users, teams, teamMembers, workflowDefinitions, workflowRuns, actionInvocations, externalCalls } from "../schema/index.js";
import { addArtifactComment } from "../services/artifacts.js";
import { eq } from "drizzle-orm";
import { seedMcpConsent } from "../integration/_mcp-consent.js";
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
  await seedMcpConsent(db, id, `client-${id}`);
  await db.insert(oauthAccessToken).values({
    id: `oauth-${id}`, accessToken: `token-${id}`, refreshToken: `refresh-${id}`,
    accessTokenExpiresAt: new Date(now + 600_000), refreshTokenExpiresAt: new Date(now + 3_600_000),
    clientId: `client-${id}`, userId: id, scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now),
  });
  return `token-${id}`;
}

let rpcId = 0;
async function tool(baseUrl: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: { [name === "call_tool" ? "summary" : "intent"]: "Exercise this tool in the integration test.", ...args } } }),
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

  it("patches, moves, and deletes personal memory without crossing users", async () => {
    const { testApi, alice, bob } = await boot();
    await tool(testApi.baseUrl, alice, "write_memory", { path: "notes/release.md", content: "# Release\n\nWe deploy on Tuesdays." });

    const patched = await tool(testApi.baseUrl, alice, "patch_memory", { path: "notes/release.md", old_string: "Tuesdays", new_string: "Wednesdays" });
    expect(patched.data).toMatchObject({ path: "notes/release.md", patched: true });
    const missing = await tool(testApi.baseUrl, alice, "patch_memory", { path: "notes/release.md", old_string: "Fridays", new_string: "x" });
    expect(missing.isError).toBe(true);
    // "e" appears many times: a first-match replace would edit the wrong passage.
    const ambiguous = await tool(testApi.baseUrl, alice, "patch_memory", { path: "notes/release.md", old_string: "e", new_string: "E" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("appears more than once");

    expect((await tool(testApi.baseUrl, alice, "move_memory", { from: "notes/release.md", to: "projects/release.md" })).data).toMatchObject({ moved: true });
    expect((await tool(testApi.baseUrl, alice, "read_memory", { path: "projects/release.md" })).text).toContain("Wednesdays");
    expect((await tool(testApi.baseUrl, alice, "read_memory", { path: "notes/release.md" })).isError).toBe(true);

    // Bob's personal scope has no such file, so his delete cannot reach Alice's.
    expect((await tool(testApi.baseUrl, bob, "delete_memory", { path: "projects/release.md" })).isError).toBe(true);
    expect((await tool(testApi.baseUrl, alice, "delete_memory", { path: "projects/release.md" })).data).toEqual({ path: "projects/release.md", deleted: true });
    expect((await tool(testApi.baseUrl, alice, "read_memory", { path: "projects/release.md" })).isError).toBe(true);
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
    await p.db.insert(teams).values({ id: "workflow-team", name: "Workflow team", orgId: ORG, createdAt: 1 });
    await p.db.insert(teamMembers).values({ teamId: "workflow-team", userId: "alice", role: "admin" });
    await p.db.update(workflowDefinitions).set({ ownerType: "team", ownerId: "workflow-team" }).where(eq(workflowDefinitions.id, risky.id));
    await p.engineCredentials.save({ type: "team", id: "workflow-team" }, "demo", { type: "api_key", apiKey: "fixture-only" });

    const listed = await tool(testApi.baseUrl, alice, "list_workflows");
    expect((listed.data.workflows as Array<{ name: string }>).map((w) => w.name).sort()).toEqual(["Ping", "Risky"]);
    expect((await tool(testApi.baseUrl, bob, "list_workflows")).data.workflows).toEqual([]);

    const done = await tool(testApi.baseUrl, alice, "run_workflow", { workflow_id: ping.id, wait_seconds: 30 });
    expect(done.data).toMatchObject({ workflow_id: ping.id, status: "settled", outcome: "completed" });

    const parked = await tool(testApi.baseUrl, alice, "run_workflow", { workflow_id: risky.id, wait_seconds: 30 });
    expect(parked.data).toMatchObject({ pending_approvals: [expect.objectContaining({ kind: "policy_gate", action: "demo.risky" })] });
    expect((await tool(testApi.baseUrl, alice, "get_workflow_run", { run_id: parked.data.run_id })).isError).toBe(false);
    const inbox = await tool(testApi.baseUrl, alice, "list_inbox");
    expect(inbox.data.workflow_approvals).toEqual([expect.objectContaining({ run_id: parked.data.run_id, workflow: "Risky", action: "demo.risky" })]);
    expect((await tool(testApi.baseUrl, bob, "list_inbox")).data.workflow_approvals).toEqual([]);
    expect((await tool(testApi.baseUrl, bob, "get_workflow_run", { run_id: parked.data.run_id })).isError).toBe(true);

    // Bob cannot stop Alice's run. Alice cancels it, then retries it, and the retry parks on the same gate.
    expect((await tool(testApi.baseUrl, bob, "cancel_workflow_run", { run_id: parked.data.run_id })).isError).toBe(true);
    const cancelled = await tool(testApi.baseUrl, alice, "cancel_workflow_run", { run_id: parked.data.run_id });
    expect(cancelled.data).toMatchObject({ run_id: parked.data.run_id, status: "settled", outcome: "cancelled" });
    const retried = await tool(testApi.baseUrl, alice, "retry_workflow_run", { run_id: parked.data.run_id, wait_seconds: 30 });
    expect(retried.isError).toBe(false);
    expect(retried.data).toMatchObject({ pending_approvals: [expect.objectContaining({ kind: "policy_gate", action: "demo.risky" })] });
    await vi.waitFor(async () => {
      const rows = await p.db.select().from(externalCalls);
      for (const name of ["run_workflow", "get_workflow_run", "cancel_workflow_run", "retry_workflow_run"]) {
        expect(rows.some(row => row.name === name && row.userId === "alice" && row.ownerType === "team" && row.ownerId === "workflow-team")).toBe(true);
      }
      expect(rows.filter(row => row.userId === "bob" && row.ownerType === "team")).toEqual([]);
    });
  });

  it("confirms changed-step retries through MCP and refuses a stale preview before any run starts", async () => {
    const { testApi, alice, bob } = await boot();
    const p = testApi.providers;
    const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost,
      actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials, engineStore: p.engineStore };
    const definition = (early: string, late: string) => ({
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" }, { id: "fetch", type: "set", values: { text: early } },
        { id: "call", type: "tool", service: "demo", action: "ping", params: {} },
        { id: "summary", type: "set", values: { text: late } }, { id: "done", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "fetch" }, { from: "fetch", to: "call" },
        { from: "call", to: "summary" }, { from: "summary", to: "done" }],
    });
    const created = await createWorkflowDefinition(deps, { userId: "alice", orgId: ORG },
      { name: "Confirmed rerun", definition: definition("v1", "v1") });
    const done = await tool(testApi.baseUrl, alice, "run_workflow", { workflow_id: created.id, wait_seconds: 30 });
    expect(done.data).toMatchObject({ status: "settled", outcome: "completed" });
    const run_id = done.data.run_id;
    await p.db.update(workflowDefinitions).set({ definition: definition("v1", "v2") }).where(eq(workflowDefinitions.id, created.id));
    const preview = await tool(testApi.baseUrl, alice, "get_workflow_run", { run_id });
    expect(preview.data).toMatchObject({
      rerun_steps: [{ node_id: "summary" }, { node_id: "done" }],
      rerun_definition_version_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const confirmed = { run_id, from: "changed_steps", rerun_definition_version_id: preview.data.rerun_definition_version_id, wait_seconds: 30 };
    const callsBefore = await p.db.select().from(actionInvocations);
    expect(callsBefore.filter((row) => row.actionId === "demo.ping")).toHaveLength(1);
    const retried = await tool(testApi.baseUrl, alice, "retry_workflow_run", confirmed);
    expect(retried.isError).toBe(false);
    expect(retried.data).toMatchObject({ status: "settled", outcome: "completed", rerun_steps: [{ node_id: "summary" }, { node_id: "done" }],
      rerun_definition_version_id: preview.data.rerun_definition_version_id });
    expect(await p.db.select().from(actionInvocations)).toHaveLength(callsBefore.length);

    // Another edit adds an unconfirmed tool action to the still-open preview.
    await p.db.update(workflowDefinitions).set({ definition: definition("v2", "v2") }).where(eq(workflowDefinitions.id, created.id));
    const runsBefore = await p.db.select().from(workflowRuns);
    const stale = await tool(testApi.baseUrl, alice, "retry_workflow_run", confirmed);
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("confirm its changed steps again");
    const fresh = await tool(testApi.baseUrl, alice, "get_workflow_run", { run_id });
    expect(fresh.data.rerun_steps).toEqual([
      { node_id: "fetch" }, { node_id: "call", action: "demo.ping" }, { node_id: "summary" }, { node_id: "done" },
    ]);
    expect(fresh.data.rerun_definition_version_id).not.toBe(preview.data.rerun_definition_version_id);
    expect((await tool(testApi.baseUrl, bob, "get_workflow_run", { run_id })).isError).toBe(true);
    expect((await tool(testApi.baseUrl, bob, "retry_workflow_run", { ...confirmed,
      rerun_definition_version_id: fresh.data.rerun_definition_version_id })).isError).toBe(true);
    expect(await p.db.select().from(workflowRuns)).toHaveLength(runsBefore.length);
    expect(await p.db.select().from(actionInvocations)).toHaveLength(callsBefore.length);
    const refreshed = await tool(testApi.baseUrl, alice, "retry_workflow_run", { ...confirmed,
      rerun_definition_version_id: fresh.data.rerun_definition_version_id });
    expect(refreshed.data).toMatchObject({ status: "settled", outcome: "completed" });
    // Each execution writes a policy audit row and a separate deduplication record.
    const pingCalls = await p.db.select().from(actionInvocations).where(eq(actionInvocations.actionId, "demo.ping"));
    expect(pingCalls).toHaveLength(2);
    expect(pingCalls.find((row) => row.workflowExecutionId === refreshed.data.run_id)).toMatchObject({ status: "completed" });
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

  // An org with a few hundred artifacts overflowed the output cap on every
  // call, and the tool had no argument to narrow the list.
  it("filters artifacts by query and caps the list with a limit", async () => {
    const { testApi, alice } = await boot();
    for (const key of ["reports/alpha", "reports/beta", "notes/gamma"]) {
      await tool(testApi.baseUrl, alice, "publish_artifact", { key, title: `Page ${key}`, content: "# x" });
    }
    const matched = await tool(testApi.baseUrl, alice, "list_artifacts", { query: "REPORTS/" });
    expect(matched.data.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "reports/alpha" }), expect.objectContaining({ key: "reports/beta" }),
    ]));
    expect(matched.data.artifacts).toHaveLength(2);
    expect(matched.data.more).toBeUndefined();

    const limited = await tool(testApi.baseUrl, alice, "list_artifacts", { limit: 1 });
    expect(limited.data.artifacts).toHaveLength(1);
    expect(limited.data.more).toContain("2 more artifacts match");
  });

  it("lists the comments on an artifact by its link", async () => {
    const { testApi, alice } = await boot();
    const published = await tool(testApi.baseUrl, alice, "publish_artifact", { key: "pages/plan", title: "Plan", content: "# Plan" });
    const [page] = await testApi.providers.db.select().from(artifacts).where(eq(artifacts.sourceMemoryPath, "pages/plan"));
    await addArtifactComment(testApi.providers.db, { artifactId: page!.id, version: 1, vdid: "a1b2c3d4", anchorLabel: "Plan", body: "Add dates", authorUserId: "bob" });

    const read = await tool(testApi.baseUrl, alice, "list_artifact_comments", { artifact: published.data.url });
    expect(read.data).toMatchObject({ artifact_id: page!.id, title: "Plan" });
    expect(read.data.threads).toEqual([expect.objectContaining({ author: "User bob", on: 'element "Plan"', status: "open", body: "Add dates", replies: [] })]);
  });

  it("unpublishes an artifact only for the person who can manage it", async () => {
    const { testApi, alice, bob } = await boot();
    await tool(testApi.baseUrl, alice, "publish_artifact", { key: "reports/oops", title: "Oops", content: "# leaked" });
    const listed = await tool(testApi.baseUrl, alice, "list_artifacts");
    const [item] = listed.data.artifacts as Array<{ artifact_id: string; key: string }>;
    expect(item).toMatchObject({ key: "reports/oops", artifact_id: expect.any(String) });

    expect((await tool(testApi.baseUrl, bob, "unpublish_artifact", { artifact_id: item?.artifact_id })).isError).toBe(true);
    // An org admin may revoke any artifact in the browser, but not through an agent.
    await testApi.providers.db.update(orgMembers).set({ role: "admin" }).where(eq(orgMembers.userId, "bob"));
    const asAdmin = await tool(testApi.baseUrl, bob, "unpublish_artifact", { artifact_id: item?.artifact_id });
    expect(asAdmin.isError).toBe(true);
    expect(asAdmin.text).toContain("An agent can unpublish only artifacts you published");
    expect((await tool(testApi.baseUrl, alice, "unpublish_artifact", { artifact_id: item?.artifact_id })).data).toMatchObject({ unpublished: true });
    expect((await tool(testApi.baseUrl, alice, "list_artifacts")).data.artifacts).toEqual([]);
  });
});
