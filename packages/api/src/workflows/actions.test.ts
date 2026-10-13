import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowStore, type RunHost, type WorkflowDefinition } from "@valet/workflow";
import {
  findingKey,
  formatEditLintErrors,
  ownerFromContext,
  workflowsActionPlugin,
} from "./actions.js";
import type { ActionPlugin, PluginActionContext, SessionEntry, ValetPlugin } from "@valet/engine";
import { Type } from "typebox";
import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  workflowActionOrigin,
  type WorkflowServiceDeps,
} from "./service.js";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { actionPolicies, credentials, credentialShares, teams, teamMembers, eventSubscriptions, orgs, workflowDefinitions, workflowRuns, workflowSchedules } from "../schema/index.js";
import githubPlugin from "@valet/plugin-github/plugin";
import { InMemoryCredentialStore, InMemorySessionStore } from "@valet/engine";
import { OnePasswordAuthError } from "../services/onepassword.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { setApprovedModels } from "../services/approved-models.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const noDeps = (): WorkflowServiceDeps => {
  throw new Error("deps not needed for this test");
};

function ctx(overrides?: Partial<PluginActionContext>): PluginActionContext {
  return {
    userId: "user1",
    orgId: "org1",
    actionId: "workflows.list_workflows",
    service: "workflows",
    ...overrides,
  } as PluginActionContext;
}

describe("workflowsActionPlugin", () => {
  it("exposes every workflow action under a workflows.* id", () => {
    const plugin = workflowsActionPlugin(noDeps);
    expect(plugin.service).toBe("workflows");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "workflows.add_aggregate",
      "workflows.cancel_run",
      "workflows.copy_to_team",
      "workflows.create_schedule",
      "workflows.create_trigger",
      "workflows.create_webhook",
      "workflows.delete_schedule",
      "workflows.delete_trigger",
      "workflows.delete_webhook",
      "workflows.delete_workflow",
      "workflows.get_node_result",
      "workflows.get_node_transcript",
      "workflows.get_permissions",
      "workflows.get_run",
      "workflows.get_webhook",
      "workflows.get_workflow",
      "workflows.list_event_types",
      "workflows.list_runs",
      "workflows.list_schedules",
      "workflows.list_triggers",
      "workflows.list_workflows",
      "workflows.patch_workflow",
      "workflows.preview_workflow",
      "workflows.propose_schedule",
      "workflows.propose_trigger",
      "workflows.request_workflow_deletion",
      "workflows.resolve_approval",
      "workflows.save_workflow",
      "workflows.start_run",
      "workflows.update_model",
      "workflows.update_schedule",
      "workflows.update_trigger",
    ]);
  });

  it("describes the explicit source, destination, and collision rule for team copies", () => {
    const copy = workflowsActionPlugin(noDeps).actions.find((a) => a.id === "workflows.copy_to_team");
    expect(copy?.description).toContain("Leaves the original and its triggers unchanged");
    expect(copy?.parameters).toMatchObject({
      required: ["workflow_id", "team_id", "name"],
      properties: {
        workflow_id: { description: expect.stringContaining("personal workflow ID") },
        team_id: { description: expect.stringContaining("destination team ID") },
        name: { description: expect.stringContaining("Must not exist") },
      },
    });
  });

  it("marks reads low-risk and writes medium-risk", () => {
    const plugin = workflowsActionPlugin(noDeps);
    const byId = new Map(plugin.actions.map((a) => [a.id, a.riskLevel]));
    expect(byId.get("workflows.list_workflows")).toBe("low");
    expect(byId.get("workflows.get_workflow")).toBe("low");
    expect(byId.get("workflows.get_permissions")).toBe("low");
    expect(byId.get("workflows.get_run")).toBe("low");
    expect(byId.get("workflows.get_node_transcript")).toBe("low");
    expect(byId.get("workflows.preview_workflow")).toBe("low");
    expect(byId.get("workflows.save_workflow")).toBe("medium");
    expect(byId.get("workflows.start_run")).toBe("medium");
    expect(byId.get("workflows.delete_workflow")).toBe("medium");
    expect(byId.get("workflows.list_runs")).toBe("low");
    expect(byId.get("workflows.cancel_run")).toBe("medium");
    // Medium → the action asks a person itself on every call, so the
    // catalog's card would only repeat the question.
    expect(byId.get("workflows.resolve_approval")).toBe("medium");
    // High → minting the hookId grants a new bearer credential that alone
    // authorizes starting runs.
    expect(byId.get("workflows.create_webhook")).toBe("high");
    expect(byId.get("workflows.get_webhook")).toBe("low");
    expect(byId.get("workflows.delete_webhook")).toBe("medium");
  });
});

describe("ownerFromContext", () => {
  it("refuses a turn from a channel sender with no Valet account", () => {
    expect(ownerFromContext({ ...ctx(), externalSender: true })).toBeNull();
  });

  it("derives the owner from ctx.userId/orgId", () => {
    expect(ownerFromContext(ctx())).toEqual({ userId: "user1", orgId: "org1", agentEditor: true });
  });

  it("keeps the session owner as the workflow principal", () => {
    expect(ownerFromContext(ctx({ owner: { type: "team", id: "team1" } }))).toEqual({
      userId: "user1",
      orgId: "org1",
      principal: { type: "team", id: "team1" },
      requireTeamMembership: true,
      agentEditor: true,
    });
  });

  it("uses the current actor instead of the cached session creator", () => {
    expect(ownerFromContext(ctx({
      owner: { type: "team", id: "team1" }, actor: { id: "current-member" },
    }))).toEqual({
      userId: "current-member", orgId: "org1",
      principal: { type: "team", id: "team1" }, requireTeamMembership: true, agentEditor: true,
    });
  });

  it("trusts a workflow run's server-derived team principal", () => {
    expect(ownerFromContext(ctx({
      owner: { type: "team", id: "team1" },
      sessionPurpose: "workflow",
    }))).toEqual({
      userId: "user1",
      orgId: "org1",
      principal: { type: "team", id: "team1" },
      requireTeamMembership: false,
      agentEditor: true,
    });
  });

  it("rejects a mismatched user principal", () => {
    expect(ownerFromContext(ctx({ owner: { type: "user", id: "someone-else" } }))).toBeNull();
  });

  it("returns null when the context has no user", () => {
    expect(ownerFromContext(ctx({ userId: undefined }))).toBeNull();
  });
});

describe("save_workflow validation", () => {
  it("rejects a non-dag definition with success:false instead of throwing", async () => {
    const plugin = workflowsActionPlugin(noDeps);
    const save = plugin.actions.find((a) => a.id === "workflows.save_workflow");
    if (!save) throw new Error("save_workflow action missing");
    const result = await save.execute({ definition: { nodes: "nope" } }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("definition.nodes");
  });
});

/**
 * The web renderer reads this text back and splits it into a list
 * (`parseLintReport`, packages/web/src/components/session/tool-renderers/
 * workflow.tsx). It tells a validator message from api prose by the bullet
 * marker alone, so a message that loses its bullet is shown and counted as
 * prose, and prose that gains one is shown as a validator message.
 */
describe("the shape the lint report is read back by", () => {
  const lines = (text: string): string[] =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(1);

  it("bullets every validator message and nothing else", () => {
    const text = formatEditLintErrors(
      ["introduced one", "carried one", "carried two"],
      ["carried one", "carried two"],
    );
    const body = lines(text);
    expect(body.filter((line) => line.startsWith("- "))).toEqual([
      "- introduced one",
      "- carried one",
      "- carried two",
    ]);
    // Exactly one line is not a message: the sentence about the carried ones.
    expect(body.filter((line) => !line.startsWith("- "))).toHaveLength(1);
  });

  it("keeps the sentence above the errors it speaks for", () => {
    const body = lines(formatEditLintErrors(["introduced", "carried"], ["carried"]));
    const advice = body.findIndex((line) => !line.startsWith("- "));
    expect(body.slice(0, advice)).toEqual(["- introduced"]);
    expect(body.slice(advice + 1)).toEqual(["- carried"]);
  });

  it("bullets every message when nothing was carried in", () => {
    const body = lines(formatEditLintErrors(["introduced one", "introduced two"], []));
    expect(body.every((line) => line.startsWith("- "))).toBe(true);
  });
});

describe("findingKey", () => {
  it("reads a message and the same message with a near-match hint as one finding", () => {
    expect(findingKey('node "b": values.x references unknown node "clasify"')).toBe(
      findingKey('node "b": values.x references unknown node "clasify" — did you mean "classify"?'),
    );
  });

  it("reads an unknown root the same after an unrelated node adds an alias", () => {
    expect(findingKey('node "b": values.x references unknown root "foo" (available: trigger, nodes)')).toBe(
      findingKey('node "b": values.x references unknown root "foo" (available: trigger, nodes, item)'),
    );
  });

  it("survives an edge index that moved because an earlier edge went away", () => {
    expect(findingKey('edge[3]: unknown target node "notify"')).toBe(
      findingKey('edge[1]: unknown target node "notify"'),
    );
  });

  it("still tells two different findings apart", () => {
    expect(findingKey('node "a": values.x references unknown node "ghost"')).not.toBe(
      findingKey('node "b": values.x references unknown node "ghost"'),
    );
  });
});

// DB-backed: these actions go through the real services (unlike the
// pure-validation test above), so they need a real workflow_definitions
// round trip plus a run store.
describe("DB-backed actions", () => {
  let db: AppDb;
  let pglite: PGlite;
  let deps: WorkflowServiceDeps;
  let runHost: StubRunHost;

  class StubRunHost implements RunHost {
    readonly started: Array<Parameters<RunHost["start"]>> = [];
    async start(...args: Parameters<RunHost["start"]>): Promise<void> {
      this.started.push(args);
    }
    async wake(): Promise<void> {}
    async scheduleWake(): Promise<void> {}
    async terminate(): Promise<void> {}
    startHost(): void {}
    async stopHost(): Promise<void> {}
  }

  beforeAll(async () => {
    pglite = new PGlite();
    await applyAppMigrations(buildAppQueryable(pglite));
    db = buildAppDb(pglite);
  });

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(async () => {
    await buildAppQueryable(pglite).query(
      `TRUNCATE workflow_webhooks, workflow_definitions, workflow_runs, workflow_schedules, event_subscriptions, action_policies, credentials, credential_shares RESTART IDENTITY CASCADE`,
    );
    runHost = new StubRunHost();
    deps = {
      db,
      workflowStore: new InMemoryWorkflowStore(),
      workflowRunHost: runHost,
      engineStore: new InMemorySessionStore(),
      credentials: new InMemoryCredentialStore(),
    };
  });

  async function seedWorkflow(): Promise<string> {
    const created = await createWorkflowDefinition(
      deps,
      { userId: "user1", orgId: "org1" },
      { name: "hook-target", definition: { version: "dag/v1", nodes: [], edges: [] } },
    );
    return created.id;
  }

  it("proposes disabled schedules and preserves enabled records on concurrent retries", async () => {
    const tool = workflowsActionPlugin(() => deps).actions.find(a => a.id === "workflows.propose_schedule")!;
    const input = { proposal_key: "morning", name: "Morning", prompt: "Check work", cron: "0 9 * * *" };
    const results = await Promise.all([tool.execute(input, ctx()), tool.execute(input, ctx())]);
    for (const result of results) expect(result).toMatchObject({ success: true, data: { proposal: { kind: "schedule", enabled: false, reviewUrl: expect.stringContaining("/workflows?tab=scheduled&review=") } } });
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
    await db.update(workflowSchedules).set({ enabled: true });
    expect(await tool.execute(input, ctx())).toMatchObject({ success: true, data: { proposal: { enabled: true, config: { name: "Morning" } } } });
    expect(await tool.execute({ ...input, prompt: "Different work" }, ctx())).toMatchObject({ success: false, error: expect.stringContaining("new proposal_key") });
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
  });

  it("proposes disabled event triggers and refuses foreign workflows", async () => {
    deps.plugins = [githubPlugin];
    const workflowId = await seedWorkflow();
    const tool = workflowsActionPlugin(() => deps).actions.find(a => a.id === "workflows.propose_trigger")!;
    const input = { proposal_key: "pulls", workflow_id: workflowId, name: "Pulls", event_keys: ["github.pull_request.opened"], presence: { displayName: "PR helper" } };
    expect(await tool.execute(input, ctx({ userId: "other" }))).toMatchObject({ success: false });
    const results = await Promise.all([tool.execute(input, ctx()), tool.execute(input, ctx())]);
    for (const result of results) expect(result).toMatchObject({ success: true, data: { proposal: { enabled: false, config: { target: { kind: "workflow", workflowId, presence: input.presence } } } } });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
    await db.update(eventSubscriptions).set({ enabled: true });
    expect(await tool.execute(input, ctx())).toMatchObject({ success: true, data: { proposal: { enabled: true } } });
    expect(await tool.execute({ ...input, presence: { displayName: "Different" } }, ctx())).toMatchObject({ success: true, data: { proposal: { config: { target: { presence: input.presence } } } } });
  });

  it("keeps one proposal key separate per workflow", async () => {
    deps.plugins = [githubPlugin];
    const first = await seedWorkflow();
    const second = (await createWorkflowDefinition(deps, { userId: "user1", orgId: "org1" },
      { name: "second-target", definition: { version: "dag/v1", nodes: [], edges: [] } })).id;
    const tool = workflowsActionPlugin(() => deps).actions.find(a => a.id === "workflows.propose_trigger")!;
    const input = { proposal_key: "pulls", name: "Pulls", event_keys: ["github.pull_request.opened"] };
    expect(await tool.execute({ ...input, workflow_id: first }, ctx())).toMatchObject({ success: true, data: { proposal: { config: { target: { workflowId: first } } } } });
    expect(await tool.execute({ ...input, workflow_id: second }, ctx())).toMatchObject({ success: true, data: { proposal: { config: { target: { workflowId: second } } } } });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(2);
  });

  it("updates selected workflow models through the focused assistant action", async () => {
    // Size tiers only validate while a target provider holds a key.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    const created = await createWorkflowDefinition(
      deps,
      { userId: "user1", orgId: "org1" },
      {
        name: "model-target",
        definition: {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            { id: "draft", type: "llm", model: "s", prompt: "Draft" },
            { id: "review", type: "session", mode: "start", model: "m", prompt: "Review" },
            { id: "stop", type: "stop" },
          ],
          edges: [
            { from: "trigger", to: "draft" },
            { from: "draft", to: "review" },
            { from: "review", to: "stop" },
          ],
        },
      },
    );
    const update = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.update_model");
    if (!update) throw new Error("update_model action missing");

    const result = await update.execute(
      { workflow_id: created.id, model: "l", node_ids: ["review"] },
      ctx(),
    );
    expect(result).toEqual({
      success: true,
      data: { workflowId: created.id, model: "l", nodeIds: ["review"] },
    });
    const saved = await getWorkflowDefinition(deps, { userId: "user1", orgId: "org1" }, created.id);
    const definition = saved?.definition as WorkflowDefinition | undefined;
    expect(definition?.nodes
      .filter((node) => node.type === "llm" || node.type === "session")
      .map((node) => [node.id, node.model])).toEqual([["draft", "s"], ["review", "l"]]);
  });

  it("saves and updates custom catalog models through assistant actions", async () => {
    await db.insert(orgs).values({ id: "org1", name: "Test org", createdAt: Date.now() }).onConflictDoNothing();
    const provider = await createLlmProvider(db, {
      orgId: "org1", kind: "openai_compatible", name: "Custom",
      baseUrl: "https://models.example.test/v1", models: [{ id: "writer", name: "Writer" }],
    });
    await deps.credentials.save({ type: "org", id: "org1" }, `llm:${provider.id}`, {
      type: "api_key", apiKey: "test-custom-key",
    });
    const model = `${provider.id}/writer`;
    const definition = {
      version: "dag/v1", nodes: [
        { id: "trigger", type: "trigger" }, { id: "draft", type: "llm", model, prompt: "Draft" },
      ], edges: [{ from: "trigger", to: "draft" }],
    };
    const created = await createWorkflowDefinition(deps, { userId: "user1", orgId: "org1" }, {
      name: "custom-model", definition,
    });
    const actions = workflowsActionPlugin(() => deps).actions;
    const save = actions.find((action) => action.id === "workflows.save_workflow");
    const update = actions.find((action) => action.id === "workflows.update_model");
    if (!save || !update) throw new Error("Expected workflow actions");
    expect(await save.execute({ workflow_id: created.id, definition }, ctx())).toMatchObject({ success: true });
    expect(await update.execute({ workflow_id: created.id, model }, ctx())).toMatchObject({ success: true });
    const saved = await getWorkflowDefinition(deps, { userId: "user1", orgId: "org1" }, created.id);
    expect(saved?.definition).toMatchObject({ nodes: [{ id: "trigger" }, { id: "draft", model }] });
  });

  it("rejects invalid model choices and node targets through the focused assistant action", async () => {
    const created = await createWorkflowDefinition(
      deps,
      { userId: "user1", orgId: "org1" },
      {
        name: "invalid-model-target",
        definition: {
          version: "dag/v1",
          nodes: [{ id: "trigger", type: "trigger" }, { id: "stop", type: "stop" }],
          edges: [{ from: "trigger", to: "stop" }],
        },
      },
    );
    const workflowId = created.id;
    const update = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.update_model");
    if (!update) throw new Error("update_model action missing");
    expect(await update.execute({ workflow_id: workflowId, model: "not-a-model" }, ctx()))
      .toMatchObject({ success: false, error: expect.stringContaining("unknown or inactive model") });
    expect(await update.execute({ workflow_id: workflowId, model: "l", node_ids: ["stop"] }, ctx()))
      .toMatchObject({ success: false, error: expect.stringContaining("not an llm or session node") });
  });

  it("rejects a concrete model that the org did not approve", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    const created = await createWorkflowDefinition(
      deps,
      { userId: "user1", orgId: "org1" },
      {
        name: "approval-target",
        definition: {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            { id: "draft", type: "llm", model: "s", prompt: "Draft" },
          ],
          edges: [{ from: "trigger", to: "draft" }],
        },
      },
    );
    await db.insert(orgs).values({ id: "org1", name: "Test org", createdAt: Date.now() }).onConflictDoNothing();
    await setApprovedModels(db, "org1", []);
    const update = workflowsActionPlugin(() => deps).actions.find((action) => action.id === "workflows.update_model");
    if (!update) throw new Error("update_model action missing");
    const result = await update.execute(
      { workflow_id: created.id, model: "anthropic/claude-haiku-4-5" },
      ctx(),
    );
    await setApprovedModels(db, "org1", null);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("not approved") });
  });

  it.each(["wf:invoke:workflow:parent:tool", "wf:parent:agent", "wf:parent:agent:1"])(
    "chains originless workflows from %s without inventing a conversation", async (sessionId) => {
      const workflowId = await seedWorkflow();
      await db.insert(workflowRuns).values({ id: "parent", workflowId, definitionVersionId: "v",
        definition: {}, params: {}, ownerType: "user", ownerId: "user1", createdAt: 1, updatedAt: 1 });
      const start = workflowsActionPlugin(() => deps).actions.find(action => action.id === "workflows.start_run")!;
      expect(await start.execute({ workflow_id: workflowId }, ctx({ sessionId, threadId: "invoke" }))).toMatchObject({ success: true });
      expect(runHost.started.at(-1)?.[1].origin).toBeUndefined();
    },
  );

  it("inherits a stored workflow audience and rejects unknown or foreign parents", async () => {
    const workflowId = await seedWorkflow();
    const origin = { assistantSessionId: "private-runtime", threadId: "private-thread" };
    await db.insert(workflowRuns).values({ id: "parent", workflowId, definitionVersionId: "v", definition: {},
      params: { origin }, ownerType: "user", ownerId: "user1", createdAt: 1, updatedAt: 1 });
    expect(await workflowActionOrigin(deps, { orgId: "org1", userId: "user1" }, "wf:parent:agent", "t")).toEqual(origin);
    for (const owner of [{ orgId: "other", userId: "user1" }, { orgId: "org1", userId: "other" }]) {
      await expect(workflowActionOrigin(deps, owner, "wf:parent:agent", "t")).rejects.toThrow("parent workflow is unavailable");
    }
    await expect(workflowActionOrigin(deps, { orgId: "org1", userId: "user1" }, "wf:missing:agent", "t")).rejects.toThrow("parent workflow is unavailable");
  });

  it.each([undefined, { assistantSessionId: "runtime", threadId: "public" }])("does not widen a team Slack event audience when chaining (%j)", async (origin) => {
    const workflowId = await seedWorkflow();
    await db.insert(workflowRuns).values({ id: "parent", workflowId, definitionVersionId: "v", definition: {},
      params: { input: { data: { key: "slack.message" } }, ...(origin ? { origin } : {}) }, ownerType: "team", ownerId: "team", createdAt: 1, updatedAt: 1 });
    await expect(workflowActionOrigin(deps, { orgId: "org1", userId: "team:team", principal: { type: "team", id: "team" } },
      "wf:invoke:workflow:parent:tool", "invoke")).rejects.toThrow("channel audience can be preserved");
  });

  it("uses the execution owner for org-owned workflow parents", async () => {
    const workflowId = await seedWorkflow();
    await db.insert(workflowRuns).values({ id: "parent", workflowId, definitionVersionId: "v", definition: {},
      params: {}, ownerType: "org", ownerId: "org1", createdAt: 1, updatedAt: 1 });
    expect(await workflowActionOrigin(deps, { orgId: "org1", userId: "org:org1" },
      "wf:parent:agent", "t", { type: "org", id: "org1" })).toBeUndefined();
  });

  it("does not drop a chained workflow's missing private origin", async () => {
    const workflowId = await seedWorkflow();
    await db.insert(workflowRuns).values({ id: "parent", workflowId, definitionVersionId: "v", definition: {},
      params: { origin: { assistantSessionId: "missing-private", threadId: "private" } },
      ownerType: "user", ownerId: "user1", createdAt: 1, updatedAt: 1 });
    const start = workflowsActionPlugin(() => deps).actions.find(action => action.id === "workflows.start_run")!;
    await expect(start.execute({ workflow_id: workflowId }, ctx({ sessionId: "wf:parent:agent", threadId: "t" }))).rejects.toThrow("origin is unavailable");
    expect(runHost.started).toHaveLength(0);
  });

  it("stores team assistant workflows in the team scope and keeps personal creation personal", async () => {
    const teamId = "assistant-owner-team";
    await db.insert(teams).values({ id: teamId, orgId: "org1", name: "Assistant owner", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId, userId: "user1", role: "member" });

    const plugin = workflowsActionPlugin(() => deps);
    const save = plugin.actions.find((action) => action.id === "workflows.save_workflow");
    const list = plugin.actions.find((action) => action.id === "workflows.list_workflows");
    const start = plugin.actions.find((action) => action.id === "workflows.start_run");
    const schedule = plugin.actions.find((action) => action.id === "workflows.create_schedule");
    if (!save || !list || !start || !schedule) throw new Error("workflow action missing");
    const definition = {
      version: "dag/v1",
      nodes: [{ id: "trigger", type: "trigger" }, { id: "done", type: "stop" }],
      edges: [{ from: "trigger", to: "done" }],
    };
    const teamContext = ctx({ owner: { type: "team", id: teamId } });

    const teamSave = await save.execute({ name: "Team workflow", definition }, teamContext);
    if (!teamSave.success) throw new Error(teamSave.error);
    const teamWorkflowId = (teamSave.data as { workflowId: string }).workflowId;
    const personalSave = await save.execute(
      { name: "Personal workflow", definition },
      ctx({ owner: { type: "user", id: "user1" } }),
    );
    if (!personalSave.success) throw new Error(personalSave.error);
    const personalWorkflowId = (personalSave.data as { workflowId: string }).workflowId;

    const rows = await db.select().from(workflowDefinitions);
    expect(rows.find((row) => row.id === teamWorkflowId)).toMatchObject({ ownerType: "team", ownerId: teamId });
    expect(rows.find((row) => row.id === personalWorkflowId)).toMatchObject({ ownerType: "user", ownerId: "user1" });

    const teamList = await list.execute({}, teamContext);
    expect(teamList).toMatchObject({
      success: true,
      data: { workflows: [{ workflowId: teamWorkflowId, name: "Team workflow" }] },
    });

    const started = await start.execute({ workflow_id: teamWorkflowId }, teamContext);
    if (!started.success) throw new Error(started.error);
    const runId = (started.data as { runId: string }).runId;
    expect(runHost.started.at(-1)?.[0]).toBe(runId);
    expect(runHost.started.at(-1)?.[3]).toEqual({
      ownerType: "team",
      ownerId: teamId,
      actorUserId: "user1",
    });

    const scheduled = await schedule.execute(
      { prompt: "Review team work", name: "Team prompt", cron: "0 9 * * *" },
      teamContext,
    );
    if (!scheduled.success) throw new Error(scheduled.error);
    expect(await db.select().from(workflowSchedules)).toContainEqual(
      expect.objectContaining({ ownerType: "team", ownerId: teamId, targetKind: "orchestrator" }),
    );
  });

  it("rejects a channel-linked nonmember acting through a team assistant", async () => {
    const teamId = "channel-team";
    await db.insert(teams).values({ id: teamId, orgId: "org1", name: "Channel team", createdAt: 1 });
    const plugin = workflowsActionPlugin(() => deps);
    const save = plugin.actions.find((action) => action.id === "workflows.save_workflow")!;
    const schedule = plugin.actions.find((action) => action.id === "workflows.create_schedule")!;
    const definition = {
      version: "dag/v1",
      nodes: [{ id: "trigger", type: "trigger" }, { id: "done", type: "stop" }],
      edges: [{ from: "trigger", to: "done" }],
    };
    const nonmemberContext = ctx({ owner: { type: "team", id: teamId } });

    await expect(save.execute({ name: "Forbidden", definition }, nonmemberContext)).rejects.toThrow("not found");
    expect(await schedule.execute(
      { prompt: "Forbidden", name: "Forbidden", cron: "0 9 * * *" },
      nonmemberContext,
    )).toMatchObject({ success: false });
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("keeps team assistants out of other teams and personal workflow scopes", async () => {
    await db.insert(teams).values([
      { id: "scope-team-a", orgId: "org1", name: "Scope A", createdAt: 1 },
      { id: "scope-team-b", orgId: "org1", name: "Scope B", createdAt: 1 },
    ]);
    await db.insert(teamMembers).values({ teamId: "scope-team-a", userId: "user1", role: "member" });
    await db.insert(workflowDefinitions).values([
      {
        id: "scope-team-b-workflow", orgId: "org1", ownerType: "team", ownerId: "scope-team-b", name: "Team B",
        definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: 1, updatedAt: 1,
      },
      {
        id: "scope-personal-workflow", orgId: "org1", ownerType: "user", ownerId: "user1", name: "Personal",
        definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: 1, updatedAt: 1,
      },
    ]);
    const plugin = workflowsActionPlugin(() => deps);
    const teamContext = ctx({ owner: { type: "team", id: "scope-team-a" } });
    const definition = {
      version: "dag/v1",
      nodes: [{ id: "trigger", type: "trigger" }, { id: "done", type: "stop" }],
      edges: [{ from: "trigger", to: "done" }],
    };

    for (const workflowId of ["scope-team-b-workflow", "scope-personal-workflow"]) {
      for (const [actionId, args] of [
        ["workflows.get_workflow", { workflow_id: workflowId }],
        ["workflows.save_workflow", { workflow_id: workflowId, name: "Changed", definition }],
        ["workflows.start_run", { workflow_id: workflowId }],
        ["workflows.delete_workflow", { workflow_id: workflowId }],
      ] as const) {
        const action = plugin.actions.find((candidate) => candidate.id === actionId)!;
        expect(await action.execute(args, teamContext)).toMatchObject({ success: false });
      }
    }
    expect(await plugin.actions.find((action) => action.id === "workflows.list_workflows")!.execute({}, teamContext))
      .toMatchObject({ success: true, data: { workflows: [] } });
    expect(await db.select().from(workflowDefinitions)).toHaveLength(2);
    expect(runHost.started).toHaveLength(0);
  });

  it("copies a personal graph to a team through the agent action and rejects team assistant context", async () => {
    const workflowId = await seedWorkflow();
    await db.insert(teams).values({ id: "copy-team", orgId: "org1", name: "Copy team", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: "copy-team", userId: "user1", role: "member" });
    const copy = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.copy_to_team");
    if (!copy) throw new Error("copy_to_team action missing");
    const args = { workflow_id: workflowId, team_id: "copy-team", name: "Copy" };
    expect(await copy.execute(args, ctx({ owner: { type: "team", id: "copy-team" } }))).toMatchObject({ success: false });
    const result = await copy.execute(args, ctx());
    expect(result).toMatchObject({ success: true, data: { workflowId: expect.any(String), teamId: "copy-team", name: "Copy" } });
    expect(await copy.execute(args, ctx())).toMatchObject({ success: false, error: expect.stringContaining("already exists") });
  });

  it.each([false, true])("agent schedules and event triggers prefer team vaults and retain org fallback without a team token (team token: %s)", async (teamToken) => {
    const teamId = `vault-team-${teamToken}`;
    await db.insert(teams).values({ id: teamId, orgId: "org1", name: teamId, createdAt: 1 });
    await db.insert(teamMembers).values({ teamId, userId: "user1", role: "member" });
    await db.insert(workflowDefinitions).values({
      id: "vault-workflow", orgId: "org1", ownerType: "team", ownerId: teamId, name: "Vault workflow",
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "start", type: "trigger" },
          { id: "tool", type: "tool", service: "linear", action: "list_issues", params: {} },
        ],
        edges: [{ from: "start", to: "tool" }],
      },
      createdAt: 1, updatedAt: 1,
    });
    deps.plugins = [githubPlugin];
    const calls: string[] = [];
    const unused = () => { throw new Error("unexpected vault method"); };
    deps.onePassword = {
      tokenConnected: unused, listVaults: unused, resolveReference: unused,
      resolveCredential: unused, findCandidates: unused,
      findCredentialForService: async (scope, owner, service) => {
        expect(owner.orgId).toBe("org1");
        expect(owner.teamId).toBe(teamId);
        calls.push(`${scope}:${service}`);
        if (scope === "team" && !teamToken) throw new OnePasswordAuthError("No team token", "no_token");
        return `fixture-${scope}-value`;
      },
    };
    const plugin = workflowsActionPlugin(() => deps);
    for (const [id, args] of [
      ["workflows.create_schedule", { workflow_id: "vault-workflow", name: "Nightly", cron: "0 3 * * *" }],
      ["workflows.create_trigger", { workflow_id: "vault-workflow", name: "Opened", event_keys: ["github.pull_request.opened"] }],
    ] as const) {
      const action = plugin.actions.find((a) => a.id === id);
      if (!action) throw new Error(`missing ${id}`);
      expect(await action.execute(args, ctx({ owner: { type: "team", id: teamId } }))).toMatchObject({ success: true });
    }
    expect(calls).toEqual(teamToken
      ? ["team:linear", "team:linear"]
      : ["team:linear", "org:linear", "team:linear", "org:linear"]);
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
    expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
  });

  it("create_webhook mints a hookId and a path-only url (no VALET_PUBLIC_URL in tests)", async () => {
    const workflowId = await seedWorkflow();
    const plugin = workflowsActionPlugin(() => deps);
    const create = plugin.actions.find((a) => a.id === "workflows.create_webhook")!;

    const result = await create.execute({ workflow_id: workflowId }, ctx());
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { workflowId: string; hookId: string; url: string };
    expect(data.workflowId).toBe(workflowId);
    expect(data.hookId).toMatch(/^[0-9a-f]{64}$/);
    expect(data.url).toBe(`/api/hooks/workflows/${workflowId}/${data.hookId}`);
  });

  it("create_webhook called twice rotates — second hookId differs from the first", async () => {
    const workflowId = await seedWorkflow();
    const plugin = workflowsActionPlugin(() => deps);
    const create = plugin.actions.find((a) => a.id === "workflows.create_webhook")!;

    const first = await create.execute({ workflow_id: workflowId }, ctx());
    const second = await create.execute({ workflow_id: workflowId }, ctx());
    if (!first.success || !second.success) throw new Error("expected both mints to succeed");
    expect((second.data as { hookId: string }).hookId).not.toBe((first.data as { hookId: string }).hookId);
  });

  it("get_webhook returns webhook:null before minting, the summary after", async () => {
    const workflowId = await seedWorkflow();
    const plugin = workflowsActionPlugin(() => deps);
    const get = plugin.actions.find((a) => a.id === "workflows.get_webhook")!;
    const create = plugin.actions.find((a) => a.id === "workflows.create_webhook")!;

    const before = await get.execute({ workflow_id: workflowId }, ctx());
    expect(before).toEqual({ success: true, data: { webhook: null } });

    await create.execute({ workflow_id: workflowId }, ctx());
    const after = await get.execute({ workflow_id: workflowId }, ctx());
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect((after.data as { webhook: { workflowId: string } }).webhook.workflowId).toBe(workflowId);
  });

  it("get_node_result returns the checkpoint result verbatim when small, a truncation stub when huge", async () => {
    const plugin = workflowsActionPlugin(() => deps);
    const getNodeResult = plugin.actions.find((a) => a.id === "workflows.get_node_result")!;

    const owner = { ownerType: "user", ownerId: "user1" };
    const definition = { version: "dag/v1", nodes: [], edges: [] };
    const params = {
      workflowId: "wf-x",
      definitionVersionId: "v1",
      input: { type: "manual", timestamp: "2026-01-01T00:00:00Z", data: {}, metadata: {} },
    };
    await deps.workflowStore.createRun("run-x", params, definition, "v1", owner);
    const claim = await deps.workflowStore.claimRun("run-x", "host", 30_000);
    if (!claim) throw new Error("claim failed");
    const base = { runId: "run-x", attempt: claim.attempt, createdAt: 1 };
    await deps.workflowStore.putIntent({ ...base, nodeId: "small", iteration: 0, status: "intent" });
    await deps.workflowStore.completeCheckpoint("run-x", "small", 0, claim.attempt, {
      ...base, nodeId: "small", iteration: 0, status: "completed",
      result: { text: "hello", usage: { totalTokens: 2 } },
    });
    await deps.workflowStore.putIntent({ ...base, nodeId: "huge", iteration: 0, status: "intent" });
    await deps.workflowStore.completeCheckpoint("run-x", "huge", 0, claim.attempt, {
      ...base, nodeId: "huge", iteration: 0, status: "completed",
      result: { blob: "x".repeat(30_000) },
    });

    const small = await getNodeResult.execute({ run_id: "run-x", node_id: "small" }, ctx());
    expect(small.success).toBe(true);
    if (!small.success) return;
    const smallCp = (small.data as { checkpoints: Array<{ result: unknown }> }).checkpoints[0]!;
    expect(smallCp.result).toEqual({ text: "hello", usage: { totalTokens: 2 } });

    const huge = await getNodeResult.execute({ run_id: "run-x", node_id: "huge" }, ctx());
    expect(huge.success).toBe(true);
    if (!huge.success) return;
    const hugeCp = (huge.data as { checkpoints: Array<{ result: { truncated?: boolean; jsonPrefix?: string } }> })
      .checkpoints[0]!;
    expect(hugeCp.result.truncated).toBe(true);
    expect(typeof hugeCp.result.jsonPrefix).toBe("string");
  });

  it("get_run lists the steps that wait for approval and the teammate who must approve one", async () => {
    const plugin = workflowsActionPlugin(() => deps);
    const action = (id: string) => plugin.actions.find((a) => a.id === id)!;
    const params = {
      workflowId: "wf-g", definitionVersionId: "v1",
      input: { type: "manual", timestamp: "2026-01-01T00:00:00Z", data: {}, metadata: {} },
    };
    const definition = { version: "dag/v1", nodes: [
      { id: "post", type: "tool", service: "slack", action: "send_message", params: {} },
      { id: "check", type: "approval", prompt: "Ship it?" },
    ], edges: [] };
    await deps.workflowStore.createRun("run-g", params, definition, "v1", { ownerType: "user", ownerId: "user1" });
    const claim = await deps.workflowStore.claimRun("run-g", "host", 30_000);
    if (!claim) throw new Error("claim failed");
    await deps.workflowStore.putIntent({ runId: "run-g", nodeId: "post", iteration: 0, status: "intent", attempt: claim.attempt, createdAt: 1,
      effects: { gate: true, provenance: "shared_account", approver: { userId: "user2", name: "Teammate" } } });
    await deps.workflowStore.putIntent({ runId: "run-g", nodeId: "check", iteration: 0, status: "intent", attempt: claim.attempt, createdAt: 1 });
    await deps.workflowStore.parkRun("run-g", claim.attempt, [
      { kind: "signal", nodeId: "post", signalType: "approval:post" },
      { kind: "signal", nodeId: "check", signalType: "approval:check" },
    ]);

    const run = await action("workflows.get_run").execute({ run_id: "run-g" }, ctx());
    expect(run.success).toBe(true);
    if (!run.success) return;
    expect((run.data as { pendingGates: unknown[] }).pendingGates).toEqual([
      { nodeId: "post", kind: "policy_gate", service: "slack", action: "send_message", approver: { userId: "user2", name: "Teammate" } },
      { nodeId: "check", kind: "approval" },
    ]);
  });

  it("get_node_transcript reads a step's prompt, tool errors, and format repair, and get_run flags the repair", async () => {
    const plugin = workflowsActionPlugin(() => deps);
    const action = (id: string) => plugin.actions.find((a) => a.id === id)!;
    const owner = { ownerType: "user", ownerId: "user1" };
    const params = {
      workflowId: "wf-t", definitionVersionId: "v1",
      input: { type: "manual", timestamp: "2026-01-01T00:00:00Z", data: {}, metadata: {} },
    };
    await deps.workflowStore.createRun("run-t", params, { version: "dag/v1", nodes: [], edges: [] }, "v1", owner);
    const claim = await deps.workflowStore.claimRun("run-t", "host", 30_000);
    if (!claim) throw new Error("claim failed");
    const sessionId = "wf:run-t:verify";
    const threadId = "verify-thread";
    const base = { runId: "run-t", attempt: claim.attempt, createdAt: 1 };
    await deps.workflowStore.putIntent({ ...base, nodeId: "verify", iteration: 0, status: "intent" });
    await deps.workflowStore.completeCheckpoint("run-t", "verify", 0, claim.attempt, {
      ...base, nodeId: "verify", iteration: 0, status: "completed", result: { output: { notification_text: "Review incomplete." } },
      effects: {
        sessionId, repairAttempted: true, firstError: "no fenced json block in the reply",
        receipt: { sessionId, threadId, queueItemId: "q1" },
      },
    });
    await deps.engineStore.saveSession({ id: sessionId, orgId: "org1", userId: "user1", owner: { type: "user", id: "user1" }, workspace: "/tmp", purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1 });
    await deps.engineStore.saveThread(sessionId, { id: threadId, sessionId, key: "workflow", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    const entry = { sessionId, threadId, parentId: null, type: "message" as const, createdAt: 1 };
    await deps.engineStore.appendEntries(sessionId, threadId, [
      { ...entry, id: "e1", role: "user", content: "Use this research result as the draft: {...}" },
      { ...entry, id: "e2", role: "assistant", content: "", parts: [{ type: "tool_call", callId: "c1", toolName: "github.list_pull_requests", status: "error", args: { repo: "tkhq/gitops" }, error: "GitHub App installation is not connected for this team." }] },
      { ...entry, id: "e3", role: "user", content: "Your previous response did not match the required JSON schema." },
      { ...entry, id: "e4", role: "assistant", content: "The release review is incomplete.", stopReason: "end_turn" },
    ]);

    const run = await action("workflows.get_run").execute({ run_id: "run-t" }, ctx());
    expect(run.success).toBe(true);
    if (!run.success) return;
    expect((run.data as { checkpoints: unknown[] }).checkpoints).toEqual([
      expect.objectContaining({ nodeId: "verify", repairAttempted: true, schemaError: "no fenced json block in the reply" }),
    ]);

    const transcript = await action("workflows.get_node_transcript").execute({ run_id: "run-t", node_id: "verify" }, ctx());
    expect(transcript.success).toBe(true);
    if (!transcript.success) return;
    const data = transcript.data as { total: number; repairAttempted: boolean; messages: Array<{ index: number; role: string; text?: string; toolCalls?: Array<{ tool: string; status: string; error?: string }> }> };
    expect(data.total).toBe(4);
    expect(data.repairAttempted).toBe(true);
    expect(data.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(data.messages[0]?.text).toContain("Use this research result as the draft");
    expect(data.messages[1]?.toolCalls).toEqual([expect.objectContaining({
      tool: "github.list_pull_requests", status: "error", error: "GitHub App installation is not connected for this team.",
    })]);
    expect(data.messages[2]?.text).toContain("did not match the required JSON schema");

    const older = await action("workflows.get_node_transcript").execute({ run_id: "run-t", node_id: "verify", before: 2, limit: 1 }, ctx());
    expect(older.success && (older.data as { messages: Array<{ index: number }> }).messages.map((m) => m.index)).toEqual([1]);

    const notSession = await action("workflows.get_node_transcript").execute({ run_id: "run-t", node_id: "missing" }, ctx());
    expect(notSession).toMatchObject({ success: false, error: expect.stringContaining("no checkpoint") });
  });

  it("get_node_transcript pages by message index, bounds every page, keeps an orchestrator step to its own turn, and asks for an iteration", async () => {
    const plugin = workflowsActionPlugin(() => deps);
    const transcript = plugin.actions.find((a) => a.id === "workflows.get_node_transcript")!;
    const owner = { ownerType: "user", ownerId: "user1" };
    const params = {
      workflowId: "wf-p", definitionVersionId: "v1",
      input: { type: "manual", timestamp: "2026-01-01T00:00:00Z", data: {}, metadata: {} },
    };
    await deps.workflowStore.createRun("run-p", params, { version: "dag/v1", nodes: [], edges: [] }, "v1", owner);
    const claim = await deps.workflowStore.claimRun("run-p", "host", 30_000);
    if (!claim) throw new Error("claim failed");
    const base = { runId: "run-p", attempt: claim.attempt, createdAt: 1 };
    const checkpoint = async (nodeId: string, iteration: number, effects: Record<string, unknown>) => {
      await deps.workflowStore.putIntent({ ...base, nodeId, iteration, status: "intent" });
      await deps.workflowStore.completeCheckpoint("run-p", nodeId, iteration, claim.attempt, { ...base, nodeId, iteration, status: "completed", result: {}, effects });
    };
    const seed = async (sessionId: string, threadId: string, entries: SessionEntry[]) => {
      await deps.engineStore.saveSession({ id: sessionId, orgId: "org1", userId: "user1", owner: { type: "user", id: "user1" }, workspace: "/tmp", purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1 });
      await deps.engineStore.saveThread(sessionId, { id: threadId, sessionId, key: threadId, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
      await deps.engineStore.appendEntries(sessionId, threadId, entries);
    };
    const message = (sessionId: string, threadId: string, id: string, content: string, queueItemId?: string): SessionEntry =>
      ({ id, sessionId, threadId, parentId: null, type: "message", role: "assistant", content, createdAt: 1, ...(queueItemId ? { queueItemId } : {}) });

    // A session step whose thread holds a non-message entry among 6 messages.
    const stepSession = "wf:run-p:verify";
    await seed(stepSession, "t-step", [
      message(stepSession, "t-step", "m0", "zero"), message(stepSession, "t-step", "m1", "one"),
      { id: "cmd", sessionId: stepSession, threadId: "t-step", parentId: null, type: "command_result", command: "/status", source: "builtin", ok: true, output: "ok", createdAt: 1 },
      message(stepSession, "t-step", "m2", "two"), message(stepSession, "t-step", "m3", "three"),
      message(stepSession, "t-step", "m4", "four"), message(stepSession, "t-step", "m5", "five"),
    ]);
    await checkpoint("verify", 0, { sessionId: stepSession, receipt: { sessionId: stepSession, threadId: "t-step", queueItemId: "q" } });
    const page = async (args: Record<string, unknown>) => {
      const r = await transcript.execute({ run_id: "run-p", node_id: "verify", ...args }, ctx());
      if (!r.success) throw new Error(r.error);
      return r.data as { total: number; messages: Array<{ index: number; text?: string }> };
    };
    const latest = await page({ limit: 2 });
    expect(latest.total).toBe(6);
    expect(latest.messages.map((m) => [m.index, m.text])).toEqual([[4, "four"], [5, "five"]]);
    const older = await page({ limit: 2, before: latest.messages[0]!.index });
    expect(older.messages.map((m) => m.text)).toEqual(["two", "three"]);
    expect((await page({ limit: 2, before: -1 })).messages).toEqual([]);

    // An orchestrator step shares its thread; it reads only its own submission.
    const shared = "assistant-session";
    await seed(shared, "t-shared", [
      message(shared, "t-shared", "o1", "another step's turn", "q-other"),
      message(shared, "t-shared", "o2", "this step's turn", "q-mine"),
    ]);
    await checkpoint("summarize", 0, { sessionId: shared, receipt: { sessionId: shared, threadId: "t-shared", queueItemId: "q-mine" } });
    const mine = await transcript.execute({ run_id: "run-p", node_id: "summarize" }, ctx());
    expect(mine.success && (mine.data as { messages: Array<{ text?: string }> }).messages.map((m) => m.text)).toEqual(["this step's turn"]);

    // After a format repair the receipt names the repair; both turns load.
    await deps.engineStore.appendEntries(shared, "t-shared", [
      message(shared, "t-shared", "r1", "first try with the tool error", "q-first"),
      message(shared, "t-shared", "r2", "a later step's turn", "q-later"),
      message(shared, "t-shared", "r3", "repaired reply", "q-repair"),
    ]);
    await checkpoint("repaired", 0, {
      sessionId: shared, repairAttempted: true, firstError: "no json block", firstQueueItemId: "q-first",
      receipt: { sessionId: shared, threadId: "t-shared", queueItemId: "q-repair" },
    });
    const repaired = await transcript.execute({ run_id: "run-p", node_id: "repaired" }, ctx());
    expect(repaired.success && (repaired.data as { messages: Array<{ text?: string }> }).messages.map((m) => m.text))
      .toEqual(["first try with the tool error", "repaired reply"]);

    // A foreach body has one checkpoint per iteration.
    await checkpoint("each", 0, { sessionId: stepSession, receipt: { sessionId: stepSession, threadId: "t-step", queueItemId: "q" } });
    await checkpoint("each", 1, { sessionId: stepSession, receipt: { sessionId: stepSession, threadId: "t-step", queueItemId: "q" } });
    expect(await transcript.execute({ run_id: "run-p", node_id: "each" }, ctx()))
      .toMatchObject({ success: false, error: expect.stringContaining("Pass iteration") });
    expect((await transcript.execute({ run_id: "run-p", node_id: "each", iteration: 1 }, ctx())).success).toBe(true);
  });

  it("list_runs names a parked run's waitingOn conditions", async () => {
    const workflowId = await seedWorkflow();
    const plugin = workflowsActionPlugin(() => deps);
    const listRuns = plugin.actions.find((a) => a.id === "workflows.list_runs")!;

    const owner = { ownerType: "user", ownerId: "user1" };
    const definition = { version: "dag/v1", nodes: [], edges: [] };
    const params = {
      workflowId,
      definitionVersionId: "v1",
      input: { type: "manual", timestamp: "2026-01-01T00:00:00Z", data: {}, metadata: {} },
    };
    await deps.workflowStore.createRun("run-parked", params, definition, "v1", owner);
    const claim = await deps.workflowStore.claimRun("run-parked", "host", 30_000);
    if (!claim) throw new Error("claim failed");
    await deps.workflowStore.parkRun("run-parked", claim.attempt, [
      { kind: "signal", nodeId: "get_pr", signalType: "approval:get_pr" },
    ]);
    // listWorkflowRuns discovers run ids through the app db table.
    await db.insert(workflowRuns).values({
      id: "run-parked",
      workflowId,
      definitionVersionId: "v1",
      definition,
      params,
      status: "parked",
      waitingOn: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const result = await listRuns.execute({ workflow_id: workflowId }, ctx());
    expect(result.success).toBe(true);
    if (!result.success) return;
    const runs = (result.data as { runs: Array<{ runId: string; needsApproval?: boolean; waitingOn?: unknown }> }).runs;
    const parked = runs.find((r) => r.runId === "run-parked");
    expect(parked?.needsApproval).toBe(true);
    expect(parked?.waitingOn).toEqual([
      { kind: "signal", nodeId: "get_pr", signalType: "approval:get_pr" },
    ]);
  });

  /** A static catalog with two high-risk actions, so a step gates unless a
   * policy allows it. */
  function chatCatalog(): NonNullable<WorkflowServiceDeps["actionPluginByService"]> {
    const fixture = (id: string) => ({
      id, name: id, description: `fixture action ${id}`, riskLevel: "high" as const,
      parameters: Type.Object({}), execute: async () => ({ success: true, data: {} }),
    });
    const actionPlugin: ActionPlugin = { service: "chat", actions: [fixture("send_message"), fixture("deploy")] };
    const plugin: ValetPlugin = { name: "chat", version: "0.0.1", actions: [actionPlugin] };
    return new Map([["chat", { plugin, actionPlugin }]]);
  }

  async function seedToolWorkflow(id: string, owner: { ownerType: "user" | "team"; ownerId: string }): Promise<void> {
    await db.insert(workflowDefinitions).values({
      id, orgId: "org1", ...owner, name: "Release", createdAt: 1, updatedAt: 1,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "post", type: "tool", service: "chat", action: "send_message", params: {} },
          { id: "ship", type: "tool", service: "chat", action: "deploy", params: {} },
        ],
        edges: [{ from: "trigger", to: "post" }, { from: "post", to: "ship" }],
      },
    });
  }

  it("get_permissions reports an org allow policy as allow and an uncovered high-risk step as require_approval", async () => {
    deps.actionPluginByService = chatCatalog();
    await seedToolWorkflow("perm-wf", { ownerType: "user", ownerId: "user1" });
    await db.insert(actionPolicies).values({
      id: "org-allow-post", orgId: "org1", principalType: "org", principalId: "org1",
      actionId: "chat.send_message", mode: "allow", paramMatchers: [], appliesIn: "any",
      origin: "settings", createdAt: 1, updatedAt: 1,
    });
    const get = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.get_permissions")!;

    const result = await get.execute({ workflow_id: "perm-wf" }, ctx());

    expect(result).toEqual({
      success: true,
      data: {
        workflowId: "perm-wf",
        nodes: [
          { nodeId: "post", service: "chat", action: "send_message", actionId: "chat.send_message", riskLevel: "high", mode: "allow", provenance: "org_policy" },
          { nodeId: "ship", service: "chat", action: "deploy", actionId: "chat.deploy", riskLevel: "high", mode: "require_approval", provenance: "risk_default" },
        ],
        unchecked: [],
      },
    });
  });

  it("get_permissions reads templates literally and flags a rule that keys on one", async () => {
    deps.actionPluginByService = chatCatalog();
    await db.insert(workflowDefinitions).values({
      id: "perm-tpl", orgId: "org1", ownerType: "user", ownerId: "user1", name: "Templated", createdAt: 1, updatedAt: 1,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "post", type: "tool", service: "chat", action: "send_message", params: { channel: "{{trigger.data.channel}}" } },
          { id: "note", type: "tool", service: "chat", action: "send_message", params: { text: "{{trigger.data.text}}" } },
        ],
        edges: [{ from: "trigger", to: "post" }, { from: "post", to: "note" }],
      },
    });
    await db.insert(actionPolicies).values({
      id: "org-deny-general", orgId: "org1", principalType: "org", principalId: "org1", actionId: "chat.send_message", mode: "deny",
      paramMatchers: [{ path: "channel", op: "eq", value: "#general" }], appliesIn: "any", origin: "settings", createdAt: 1, updatedAt: 1,
    });
    const get = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.get_permissions")!;
    const result = await get.execute({ workflow_id: "perm-tpl" }, ctx());
    // The mode stays what a workflow grant reads; only the channel step is
    // flagged, because the deny keys on the channel it renders at run time.
    expect(result).toMatchObject({
      success: true,
      data: { nodes: [
        { nodeId: "post", mode: "require_approval", provenance: "risk_default", runtimeParams: true },
        { nodeId: "note", mode: "require_approval", provenance: "risk_default" },
      ] },
    });
    expect(JSON.stringify(result)).toContain('"nodeId":"note","service":"chat","action":"send_message","actionId":"chat.send_message","riskLevel":"high","mode":"require_approval","provenance":"risk_default"}');
  });

  it("get_permissions flags a team step that a member's shared account would answer, and lists agent steps", async () => {
    deps.actionPluginByService = chatCatalog();
    await db.insert(teams).values({ id: "perm-team-share", orgId: "org1", name: "Share", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: "perm-team-share", userId: "user1", role: "member" });
    await db.insert(workflowDefinitions).values({
      id: "perm-share", orgId: "org1", ownerType: "team", ownerId: "perm-team-share", name: "Shared", createdAt: 1, updatedAt: 1,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "draft", type: "session", prompt: "Draft it." },
          { id: "each", type: "foreach", items: "{{trigger.data.items}}", body: { id: "child", type: "workflow", workflowId: "wf-child" } },
          { id: "post", type: "tool", service: "chat", action: "send_message", params: {} },
        ],
        edges: [{ from: "trigger", to: "draft" }, { from: "draft", to: "each" }, { from: "each", to: "post" }],
      },
    });
    await db.insert(teamMembers).values({ teamId: "perm-team-share", userId: "user2", role: "member" });
    await db.insert(credentialShares).values({ teamId: "perm-team-share", service: "chat", userId: "user2", createdAt: 1 });
    const get = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.get_permissions")!;
    const teamCtx = ctx({ owner: { type: "team", id: "perm-team-share" } });

    expect(await get.execute({ workflow_id: "perm-share" }, teamCtx)).toMatchObject({
      success: true,
      data: {
        nodes: [{ nodeId: "post", sharedAccount: true }],
        unchecked: [{ nodeId: "draft", type: "session" }, { nodeId: "each", type: "workflow" }],
      },
    });
    // A share from someone who left the team is not one a run would use.
    await db.delete(teamMembers).where(eq(teamMembers.userId, "user2"));
    const former = await get.execute({ workflow_id: "perm-share" }, teamCtx);
    expect(JSON.stringify(former)).not.toContain("sharedAccount");
    await db.insert(teamMembers).values({ teamId: "perm-team-share", userId: "user2", role: "member" });
    // With a connection of its own, the team does not borrow the share.
    await db.insert(credentials).values({ ownerType: "team", ownerId: "perm-team-share", service: "chat", type: "api_key", createdAt: 1, updatedAt: 1 });
    const own = await get.execute({ workflow_id: "perm-share" }, teamCtx);
    expect(own).toMatchObject({ success: true });
    expect(JSON.stringify(own)).not.toContain("sharedAccount");
    // A dead team connection does not answer: the run falls through to the share.
    await db.update(credentials).set({ type: "oauth2", expiresAt: 1, metadata: { refreshRefused: true } })
      .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, "perm-team-share")));
    expect(await get.execute({ workflow_id: "perm-share" }, teamCtx)).toMatchObject({
      success: true, data: { nodes: [{ nodeId: "post", sharedAccount: true }] },
    });
  });

  it("get_permissions reads matcher paths the way the matcher does", async () => {
    deps.actionPluginByService = chatCatalog();
    await db.insert(workflowDefinitions).values({
      id: "perm-paths", orgId: "org1", ownerType: "user", ownerId: "user1", name: "Paths", createdAt: 1, updatedAt: 1,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "dm", type: "tool", service: "chat", action: "send_message", params: { to: "{{trigger.data.who}}" } },
          { id: "note", type: "tool", service: "chat", action: "send_message", params: { text: "{{trigger.data.text}}" } },
        ],
        edges: [{ from: "trigger", to: "dm" }, { from: "dm", to: "note" }],
      },
    });
    const policy = (id: string, path: string): typeof actionPolicies.$inferInsert => ({
      id, orgId: "org1", principalType: "org", principalId: "org1", actionId: "chat.send_message", mode: "deny",
      paramMatchers: [{ path, op: "exists" }], appliesIn: "any", origin: "settings", createdAt: 1, updatedAt: 1,
    });
    await db.insert(actionPolicies).values(policy("org-deny-first", "to[0]"));
    const get = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.get_permissions")!;
    const flagged = async () => ((await get.execute({ workflow_id: "perm-paths" }, ctx())) as { data: { nodes: Array<{ nodeId: string; runtimeParams?: true }> } })
      .data.nodes.filter((node) => node.runtimeParams).map((node) => node.nodeId);
    expect(await flagged()).toEqual(["dm"]);
    // The whole-object path reads every parameter.
    await db.insert(actionPolicies).values(policy("org-deny-any", ""));
    expect(await flagged()).toEqual(["dm", "note"]);
  });

  it("get_permissions refuses a workflow the caller cannot read", async () => {
    deps.actionPluginByService = chatCatalog();
    await db.insert(teams).values({ id: "perm-other-team", orgId: "org1", name: "Other", createdAt: 1 });
    await seedToolWorkflow("perm-personal", { ownerType: "user", ownerId: "user1" });
    await seedToolWorkflow("perm-team", { ownerType: "team", ownerId: "perm-other-team" });
    const get = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.get_permissions")!;

    // The owner reads it, so each refusal below is the access check.
    expect(await get.execute({ workflow_id: "perm-personal" }, ctx())).toMatchObject({ success: true });
    expect(await get.execute({ workflow_id: "perm-personal" }, ctx({ userId: "someone-else" })))
      .toEqual({ success: false, error: "workflow not found: perm-personal" });
    // user1 is not a member of the owning team.
    expect(await get.execute({ workflow_id: "perm-team" }, ctx({ owner: { type: "team", id: "perm-other-team" } })))
      .toEqual({ success: false, error: "workflow not found: perm-team" });
    expect(await get.execute({ workflow_id: "perm-team" }, ctx()))
      .toEqual({ success: false, error: "workflow not found: perm-team" });
  });

  it("get_webhook fails for a workflow the caller doesn't own", async () => {
    const workflowId = await seedWorkflow();
    const plugin = workflowsActionPlugin(() => deps);
    const get = plugin.actions.find((a) => a.id === "workflows.get_webhook")!;

    const result = await get.execute({ workflow_id: workflowId }, ctx({ userId: "someone-else" }));
    expect(result.success).toBe(false);
  });

  it("delete_webhook: deleted:true after minting, deleted:false when nothing was configured, fails for an unowned workflow", async () => {
    const workflowId = await seedWorkflow();
    const plugin = workflowsActionPlugin(() => deps);
    const create = plugin.actions.find((a) => a.id === "workflows.create_webhook")!;
    const del = plugin.actions.find((a) => a.id === "workflows.delete_webhook")!;

    await create.execute({ workflow_id: workflowId }, ctx());
    const deleted = await del.execute({ workflow_id: workflowId }, ctx());
    expect(deleted).toEqual({ success: true, data: { workflowId, deleted: true } });

    const nothingToDelete = await del.execute({ workflow_id: workflowId }, ctx());
    expect(nothingToDelete).toEqual({ success: true, data: { workflowId, deleted: false } });

    const unowned = await del.execute({ workflow_id: workflowId }, ctx({ userId: "someone-else" }));
    expect(unowned.success).toBe(false);
  });

  /**
   * A workflow saved before the trigger-path rule holds a path the validator
   * now refuses. Both actions here edit WITHOUT re-sending the definition,
   * so they revalidate the merged whole and the stale path blocks them. The
   * edit stays blocked — that is the point of the rule — but the caller must
   * be able to tell the stale path from a mistake of its own.
   */
  describe("an edit blocked by a path the workflow already held", () => {
    /** Written through the service, which does not validate, the same way a
     * workflow saved before the rule sits in the table today. */
    async function seedLegacyWorkflow(): Promise<string> {
      const created = await createWorkflowDefinition(
        deps,
        { userId: "user1", orgId: "org1" },
        {
          name: "saved-before-the-rule",
          definition: {
            version: "dag/v1",
            nodes: [
              { id: "trigger", type: "trigger", dataSchema: { email: { type: "string" } } },
              { id: "build", type: "set", values: { to: "{{trigger.email}}" } },
            ],
            edges: [{ from: "trigger", to: "build" }],
          },
        },
      );
      return created.id;
    }

    const findWorkflowAction = (id: string) => {
      const found = workflowsActionPlugin(() => deps).actions.find((a) => a.id === id);
      if (!found) throw new Error(`action missing: ${id}`);
      return found;
    };

    /** Appends a node that reads nothing, so nothing about it can fail. */
    const cleanPatch = (workflowId: string) => ({
      workflow_id: workflowId,
      upsert_nodes: [{ id: "note", type: "set", values: { n: "1" } }],
      add_edges: [{ from: "build", to: "note" }],
    });

    it("patch_workflow stays blocked, and says the error is not the caller's", async () => {
      const workflowId = await seedLegacyWorkflow();

      const result = await findWorkflowAction("workflows.patch_workflow").execute(
        cleanPatch(workflowId),
        ctx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("already held");
      expect(result.error).toContain("this edit did not cause them");
      // The blocking error is still reported in full, correction and all.
      expect(result.error).toContain('did you mean "trigger.data.email"');
      // And it names where to go when the caller cannot fix it in place.
      expect(result.error).toContain("editor");
    });

    it("patch_workflow renames a workflow the stale path would otherwise block", async () => {
      const workflowId = await seedLegacyWorkflow();

      const result = await findWorkflowAction("workflows.patch_workflow").execute(
        { workflow_id: workflowId, name: "renamed" },
        ctx(),
      );

      // `PUT /api/workflows/:id` renames this same workflow, because it
      // validates only a request that carries a definition. The agent path
      // must not refuse an edit the HTTP path allows.
      expect(result.success).toBe(true);

      // And the rename leaves the definition exactly as it was, stale path
      // included — a rename is not a quiet chance to rewrite the graph.
      const after = await getWorkflowDefinition(deps, { userId: "user1", orgId: "org1" }, workflowId);
      expect(after?.name).toBe("renamed");
      expect(after?.definition).toEqual({
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger", dataSchema: { email: { type: "string" } } },
          { id: "build", type: "set", values: { to: "{{trigger.email}}" } },
        ],
        edges: [{ from: "trigger", to: "build" }],
      });
    });

    it("patch_workflow separates the caller's own new error from the stale one", async () => {
      const workflowId = await seedLegacyWorkflow();

      const result = await findWorkflowAction("workflows.patch_workflow").execute(
        {
          workflow_id: workflowId,
          upsert_nodes: [{ id: "note", type: "set", values: { n: "{{nodes.ghost.result.x}}" } }],
          add_edges: [{ from: "build", to: "note" }],
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      const preExisting = result.error?.indexOf("already held") ?? -1;
      const introduced = result.error?.indexOf('unknown node "ghost"') ?? -1;
      expect(introduced).toBeGreaterThan(-1);
      expect(preExisting).toBeGreaterThan(-1);
      // The caller's own error is read first: it is the one to fix now.
      expect(introduced).toBeLessThan(preExisting);
    });

    it("patch_workflow on a valid workflow blames nothing on the past", async () => {
      const created = await createWorkflowDefinition(
        deps,
        { userId: "user1", orgId: "org1" },
        {
          name: "valid",
          definition: {
            version: "dag/v1",
            nodes: [
              { id: "trigger", type: "trigger", dataSchema: { email: { type: "string" } } },
              { id: "build", type: "set", values: { to: "{{trigger.data.email}}" } },
            ],
            edges: [{ from: "trigger", to: "build" }],
          },
        },
      );
      const workflowId = created.id;

      const result = await findWorkflowAction("workflows.patch_workflow").execute(
        {
          workflow_id: workflowId,
          upsert_nodes: [{ id: "note", type: "set", values: { n: "{{trigger.email}}" } }],
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('did you mean "trigger.data.email"');
      expect(result.error).not.toContain("already held");
    });

    it("add_aggregate says the stored definition is what blocks it", async () => {
      const workflowId = await seedLegacyWorkflow();

      const result = await findWorkflowAction("workflows.add_aggregate").execute(
        { workflow_id: workflowId },
        ctx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("already held");
      expect(result.error).toContain('did you mean "trigger.data.email"');
    });

    /**
     * The validator writes its near-match hint from the WHOLE definition, so
     * adding a node REWRITES the message of an error in a node the patch
     * never touched. The split must survive that: an error whose only change
     * is a hint is the same error, and the caller did not cause it.
     */
    describe("when the patch rewrites the hint on an error it did not touch", () => {
      type WorkflowNodeSeed = WorkflowDefinition["nodes"][number];

      /** `clasify` is 1 edit from `classify`, and no node is named either
       * until the patch adds one. So the stored definition holds the error
       * WITHOUT a hint, and the patched one holds it WITH a hint. */
      async function seedNearMissWorkflow(extraNodes: WorkflowNodeSeed[] = []): Promise<string> {
        const created = await createWorkflowDefinition(
          deps,
          { userId: "user1", orgId: "org1" },
          {
            name: "near-miss",
            definition: {
              version: "dag/v1",
              nodes: [
                { id: "trigger", type: "trigger", dataSchema: { email: { type: "string" } } },
                { id: "b", type: "set", values: { x: "{{nodes.clasify.result.text}}" } },
                ...extraNodes,
              ],
              edges: [
                { from: "trigger", to: "b" },
                ...extraNodes.map((n) => ({ from: "trigger", to: n.id })),
              ],
            },
          },
        );
        return created.id;
      }

      /** Adds the node whose id turns the stale reference into a near miss. */
      const addNearMatch = (workflowId: string) => ({
        workflow_id: workflowId,
        upsert_nodes: [{ id: "classify", type: "set", values: { q: "2" } }],
        add_edges: [{ from: "b", to: "classify" }],
      });

      it("still reads the rewritten error as pre-existing, not as the caller's", async () => {
        // A second stale error that no hint touches, so the pre-existing
        // notice would be printed either way — what is under test is which
        // side of it the rewritten error lands on.
        const workflowId = await seedNearMissWorkflow([
          { id: "c", type: "set", values: { y: "{{trigger.email}}" } },
        ]);

        const result = await findWorkflowAction("workflows.patch_workflow").execute(
          addNearMatch(workflowId),
          ctx(),
        );

        expect(result.success).toBe(false);
        if (result.success) return;
        const notice = result.error?.indexOf("already held") ?? -1;
        const rewritten = result.error?.indexOf('unknown node "clasify"') ?? -1;
        expect(notice).toBeGreaterThan(-1);
        expect(rewritten).toBeGreaterThan(-1);
        // Below the notice is the pre-existing side. Above it is the
        // caller's own — which is where a raw string compare put this one.
        expect(rewritten).toBeGreaterThan(notice);
      });

      it("keeps the pre-existing notice when the rewritten error is the only one", async () => {
        const workflowId = await seedNearMissWorkflow();

        const result = await findWorkflowAction("workflows.patch_workflow").execute(
          addNearMatch(workflowId),
          ctx(),
        );

        expect(result.success).toBe(false);
        if (result.success) return;
        // A raw string compare found nothing pre-existing here and dropped
        // the notice altogether, with nothing to say it had.
        expect(result.error).toContain("already held");
        expect(result.error).toContain("this edit did not cause them");
        expect(result.error).toContain('did you mean "classify"');
      });
    });
  });

  describe("patch_workflow removed-edge hint", () => {
    /** Valid workflow: trigger -> build -> done, so nothing pre-existing
     * drowns the reachability lint (it only runs on an otherwise-clean
     * graph). */
    async function seedCleanChain(): Promise<string> {
      const created = await createWorkflowDefinition(
        deps,
        { userId: "user1", orgId: "org1" },
        {
          name: "clean-chain",
          definition: {
            version: "dag/v1",
            nodes: [
              { id: "trigger", type: "trigger" },
              { id: "build", type: "set", values: { n: "1" } },
              { id: "done", type: "stop" },
            ],
            edges: [
              { from: "trigger", to: "build" },
              { from: "build", to: "done" },
            ],
          },
        },
      );
      return created.id;
    }

    const findWorkflowAction = (id: string) => {
      const found = workflowsActionPlugin(() => deps).actions.find((a) => a.id === id);
      if (!found) throw new Error(`action missing: ${id}`);
      return found;
    };

    it("names the removed edges when the lint reports unreachable nodes", async () => {
      const workflowId = await seedCleanChain();

      const result = await findWorkflowAction("workflows.patch_workflow").execute(
        { workflow_id: workflowId, remove_edges: [{ from: "trigger", to: "build" }] },
        ctx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("is unreachable");
      expect(result.error).toContain("hint: this patch removed edge(s) trigger->build");
      expect(result.error).toContain("add a replacement edge in the same patch");
    });

    it("appends no hint when the failing patch removed no edges", async () => {
      const workflowId = await seedCleanChain();

      // Upserting a broken node fails the lint, but no edge was removed —
      // the hint would only mislead.
      const result = await findWorkflowAction("workflows.patch_workflow").execute(
        {
          workflow_id: workflowId,
          upsert_nodes: [{ id: "bad", type: "llm", prompt: "hi" }],
          add_edges: [{ from: "build", to: "bad" }],
        },
        ctx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).not.toContain("hint: this patch removed edge(s)");
    });
  });

  // The agent's batch tracker (batch-fanout design decision 5). An
  // orchestrator watching a 250-item fan-out reads it through this action,
  // so the reach and the guards need their own coverage.
  describe("list_runs", () => {
    interface RunPage {
      runs: { runId: string; parentRunId?: string }[];
      nextCursor?: string;
    }

    async function seedRun(workflowId: string, runId: string, parentRunId?: string): Promise<void> {
      await deps.workflowStore.createRun(
        runId,
        { workflowId, definitionVersionId: "v1", parentRunId },
        { version: "dag/v1", nodes: [], edges: [] },
        "v1",
        { ownerType: "user", ownerId: "user1" },
      );
    }

    it("lists every reachable workflow's runs when workflow_id is omitted", async () => {
      const first = await seedWorkflow();
      const second = await seedWorkflow();
      await seedRun(first, "wfrun_a");
      await seedRun(second, "wfrun_b");
      const list = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.list_runs")!;

      const result = await list.execute({}, ctx());
      expect(result.success).toBe(true);
      if (!result.success) return;
      const page = result.data as RunPage;
      expect(new Set(page.runs.map((r) => r.runId))).toEqual(new Set(["wfrun_a", "wfrun_b"]));

      // Another user reaches neither workflow, so the same call sees nothing.
      const other = await list.execute({}, ctx({ userId: "someone-else" }));
      expect(other.success).toBe(true);
      if (!other.success) return;
      expect((other.data as RunPage).runs).toEqual([]);
    });

    it("returns one batch parent's children for parent_run_id", async () => {
      const workflowId = await seedWorkflow();
      await seedRun(workflowId, "wfrun_parent");
      await seedRun(workflowId, "wfrun_child_1", "wfrun_parent");
      await seedRun(workflowId, "wfrun_child_2", "wfrun_parent");
      await seedRun(workflowId, "wfrun_other_child", "wfrun_elsewhere");
      const list = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.list_runs")!;

      const result = await list.execute({ parent_run_id: "wfrun_parent" }, ctx());
      expect(result.success).toBe(true);
      if (!result.success) return;
      const page = result.data as RunPage;
      expect(new Set(page.runs.map((r) => r.runId))).toEqual(new Set(["wfrun_child_1", "wfrun_child_2"]));
      expect(page.runs.every((r) => r.parentRunId === "wfrun_parent")).toBe(true);
    });

    it("pages, and names the corrective action for a bad status or cursor", async () => {
      const workflowId = await seedWorkflow();
      await seedRun(workflowId, "wfrun_p1");
      await seedRun(workflowId, "wfrun_p2");
      const list = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.list_runs")!;

      const first = await list.execute({ workflow_id: workflowId, limit: 1 }, ctx());
      if (!first.success) throw new Error("expected the first page to succeed");
      const firstPage = first.data as RunPage;
      expect(firstPage.runs).toHaveLength(1);
      expect(firstPage.nextCursor).toBeDefined();

      const second = await list.execute({ workflow_id: workflowId, limit: 1, cursor: firstPage.nextCursor }, ctx());
      if (!second.success) throw new Error("expected the second page to succeed");
      const secondPage = second.data as RunPage;
      expect(secondPage.runs).toHaveLength(1);
      expect(secondPage.runs[0]?.runId).not.toBe(firstPage.runs[0]?.runId);

      const badStatus = await list.execute({ status: ["nope"] }, ctx());
      expect(badStatus.success).toBe(false);
      expect(badStatus.error).toContain("pending, running, parked, terminalizing, settled");

      const badCursor = await list.execute({ cursor: "nonsense" }, ctx());
      expect(badCursor.success).toBe(false);
      expect(badCursor.error).toContain("nextCursor");
    });
  });
});

// ── update_schedule / update_trigger — DB-backed ─────────────────────────

describe("update actions", () => {
  let db: AppDb;
  let pglite: PGlite;
  let deps: WorkflowServiceDeps;

  const DB_USER = { id: "user_1", orgId: "org_1" };
  const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);

  class StubRunHost implements RunHost {
    async start(): Promise<void> {}
    async wake(): Promise<void> {}
    async scheduleWake(): Promise<void> {}
    async terminate(): Promise<void> {}
    startHost(): void {}
    async stopHost(): Promise<void> {}
  }

  beforeAll(async () => {
    pglite = new PGlite();
    await applyAppMigrations(buildAppQueryable(pglite));
    db = buildAppDb(pglite);
    deps = {
      db,
      workflowStore: new InMemoryWorkflowStore(),
      workflowRunHost: new StubRunHost(),
      engineStore: new InMemorySessionStore(),
      credentials: new InMemoryCredentialStore(),
      plugins: [githubPlugin],
    };

    await db.insert(workflowDefinitions).values({
      id: "wf_actions_1",
      orgId: DB_USER.orgId,
      ownerType: "user",
      ownerId: DB_USER.id,
      name: "test workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterAll(async () => {
    await pglite.close();
  });

  function findAction(id: string) {
    const plugin = workflowsActionPlugin(() => deps);
    const found = plugin.actions.find((a) => a.id === id);
    if (!found) throw new Error(`${id} action missing`);
    return found;
  }

  it("update_schedule updates an existing schedule and returns the summary", async () => {
    const schedId = `sched_act_${Date.now()}`;
    await db.insert(workflowSchedules).values({
      id: schedId,
      orgId: DB_USER.orgId,
      ownerType: "user",
      ownerId: DB_USER.id,
      targetKind: "orchestrator",
      workflowId: null,
      prompt: "hello",
      name: "original name",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: NOW + 3600_000,
      lastFiredAt: null,
      createdBy: DB_USER.id,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await findAction("workflows.update_schedule").execute(
      { schedule_id: schedId, name: "renamed" },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { name: string }).name).toBe("renamed");
    }
  });

  it("update_schedule returns error for unknown schedule id", async () => {
    const result = await findAction("workflows.update_schedule").execute(
      { schedule_id: "no_such_schedule" },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("update_trigger updates an existing trigger and returns the summary", async () => {
    const trigId = `trig_act_${Date.now()}`;
    await db.insert(eventSubscriptions).values({
      id: trigId,
      orgId: DB_USER.orgId,
      ownerType: "user",
      ownerId: DB_USER.id,
      name: "original trigger",
      eventKeys: ["github.pull_request.opened"],
      filters: [],
      target: { kind: "workflow", workflowId: "wf_actions_1" },
      enabled: true,
      createdBy: DB_USER.id,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await findAction("workflows.update_trigger").execute(
      { trigger_id: trigId, name: "renamed trigger", enabled: false },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { name: string; enabled: boolean };
      expect(data.name).toBe("renamed trigger");
      expect(data.enabled).toBe(false);
    }
  });

  it("update_trigger returns error for unknown trigger id", async () => {
    const result = await findAction("workflows.update_trigger").execute(
      { trigger_id: "no_such_trigger" },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("standing automations need a person by default", () => {
  it("rates schedule and event-trigger creation and updates high, so the risk default requires approval", async () => {
    // A schedule or trigger keeps prompting the assistant after the thread
    // ends, and an agent can steer the assistant through a thread.
    const { workflowsActionPlugin } = await import("./actions.js");
    const plugin = workflowsActionPlugin(() => {
      throw new Error("not called when listing actions");
    });
    const risk = (id: string) => plugin.actions.find((a) => a.id === id)?.riskLevel;
    for (const id of ["workflows.create_schedule", "workflows.update_schedule", "workflows.create_trigger", "workflows.update_trigger", "workflows.create_webhook"]) {
      expect(risk(id), id).toBe("high");
    }
    // A proposal does nothing until a person accepts it.
    expect(risk("workflows.propose_schedule")).toBe("low");
  });
});
