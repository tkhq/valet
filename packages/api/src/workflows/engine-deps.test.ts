/**
 * Unit tests for `buildWorkflowEngineDeps`'s Task 7/Task 6 seams:
 * `invokeAction` (now a real headless `ActionInvoker` with durable dedup —
 * plugin-system-v2 plan Task 6), `promptOrchestrator` (real `EngineHost`
 * orchestrator wiring, no LLM call required — `submitPrompt` returns before
 * the turn actually runs), and `llmComplete`'s no-network unknown-model
 * failure path. The key-gated real-Anthropic completion path is exercised
 * separately in `src/integration/workflow-engine-deps.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import { workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function seedRun(a: TestApi, runId: string, workflowId: string): Promise<void> {
  const { db, workflowStore } = a.providers;
  const now = Date.now();
  await db
    .insert(workflowDefinitions)
    .values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "user",
      ownerId: LOCAL_USER.id,
      name: "engine-deps-unit-test",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });
  await workflowStore.createRun(
    runId,
    { workflowId, definitionVersionId: "v1" },
    { version: "dag/v1", nodes: [], edges: [] },
    "v1",
    { ownerType: "user", ownerId: LOCAL_USER.id },
  );
}

/** Fixture `demo.ping` action — counts invocations and echoes whether a credential was resolved, so tests can assert dedup (no re-invocation) and the missing-credential-still-executes contract. */
function makeFixturePlugin(): { plugin: ValetPlugin; actionPlugin: ActionPlugin; calls: () => number } {
  let count = 0;
  const action: PluginAction = {
    id: "demo.ping",
    name: "ping",
    description: "ping",
    riskLevel: "low",
    parameters: Type.Object({ msg: Type.String() }),
    execute: async (args, ctx) => {
      count += 1;
      const credential = await ctx.credentials.get();
      return {
        success: true,
        data: { echoed: (args as { msg: string }).msg, hasCredential: credential !== null },
      };
    },
  };
  const actionPlugin: ActionPlugin = { service: "demo", actions: [action] };
  const plugin: ValetPlugin = { name: "demo", version: "0.0.1", actions: [actionPlugin] };
  return { plugin, actionPlugin, calls: () => count };
}

// `seedRun` calls `workflowStore.createRun`, which is `notPortedStub`'d until
// Task 8 (WorkflowStore's Postgres port) of the postgres-backend plan — see
// `providers/not-ported-stub.ts`. Skipped rather than rewritten here since
// exercising this behavior is exactly what Task 8 owns.
describe.skip("buildWorkflowEngineDeps: invokeAction", () => {
  it("happy path: resolves the fixture action and returns {ok:true, result}", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_happy";
    await seedRun(api, runId, "wf_invoke_happy");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "hello" },
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result).toEqual({ ok: true, result: { echoed: "hello", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("is idempotent by invocationId: a duplicate call executes the action ONCE and returns the identical original result", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_dup";
    await seedRun(api, runId, "wf_invoke_dup");
    const req = {
      service: "demo",
      action: "ping",
      params: { msg: "dup" },
      invocationId: `workflow:${runId}:node1`,
    };

    const first = await deps.invokeAction(req);
    const second = await deps.invokeAction(req);

    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(1);
  });

  it("unknown action: returns a stable {ok:false} that is also deduped (never invokes execute)", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_unknown";
    await seedRun(api, runId, "wf_invoke_unknown");
    const req = {
      service: "demo",
      action: "does_not_exist",
      params: {},
      invocationId: `workflow:${runId}:node1`,
    };

    const first = await deps.invokeAction(req);
    const second = await deps.invokeAction(req);

    expect(first).toEqual({ ok: false, error: "unknown action: demo.does_not_exist" });
    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(0);
  });

  it("param validation failure: missing required param returns {ok:false} and never invokes execute", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_badparams";
    await seedRun(api, runId, "wf_invoke_badparams");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: {},
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("missing credential: the action still executes and sees credentials.get() === null", async () => {
    const fixture = makeFixturePlugin();
    api = await bootTestApi({ plugins: [fixture.plugin] });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_invoke_nocred";
    await seedRun(api, runId, "wf_invoke_nocred");

    const result = await deps.invokeAction({
      service: "demo",
      action: "ping",
      params: { msg: "no creds here" },
      invocationId: `workflow:${runId}:node1`,
    });

    expect(result).toEqual({ ok: true, result: { echoed: "no creds here", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });
});

// Same Task-8 `WorkflowStore` gap as the `invokeAction` describe block above
// (`seedRun` -> `workflowStore.createRun`).
describe.skip("buildWorkflowEngineDeps: promptOrchestrator", () => {
  it("ensures the owner's orchestrator session and admits a followup signal envelope", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_unit";
    await seedRun(api, runId, "wf_orch_unit");

    const dispatchId = `workflow:${runId}:node1`;
    const receipt = await deps.promptOrchestrator("please look into this", {
      dispatchId,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });

    expect(receipt.sessionId).toBe(`orchestrator:user:${LOCAL_USER.id}`);
    expect(receipt.threadId).toBeTruthy();
    expect(receipt.queueItemId).toBeTruthy();

    // The orchestrator session actually exists and is live.
    const session = engineHost.liveSession(receipt.sessionId);
    expect(session).not.toBeNull();

    // The queued item carries the followup queueMode and the SignalContent
    // envelope shape (kind/signalType/body) — never a raw string prompt.
    const item = await engineStore.getQueueItem(receipt.sessionId, receipt.queueItemId);
    expect(item).toBeDefined();
    expect(item?.dispatchId).toBe(dispatchId);
    expect(item?.content).toEqual({
      kind: "signal",
      signalType: "workflow.request",
      body: "please look into this",
      tagName: "signal",
    });
  });

  it("is idempotent by dispatchId: a duplicate dispatch returns the original receipt", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_dup";
    await seedRun(api, runId, "wf_orch_dup");

    const dispatchId = `workflow:${runId}:node1`;
    const opts = {
      dispatchId,
      queueMode: "followup" as const,
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    };

    const first = await deps.promptOrchestrator("noted please", opts);
    const second = await deps.promptOrchestrator("noted please", opts);

    expect(second).toEqual(first);
  });

  it("groups every prompt from the same run onto one thread", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_thread";
    await seedRun(api, runId, "wf_orch_thread");

    const first = await deps.promptOrchestrator("first node's ask", {
      dispatchId: `workflow:${runId}:node1`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });
    const second = await deps.promptOrchestrator("second node's ask", {
      dispatchId: `workflow:${runId}:node2`,
      queueMode: "followup",
      ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
    });

    expect(second.threadId).toBe(first.threadId);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("throws a descriptive error for a run with no recorded owner", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const runId = "wfrun_orch_no_owner";
    const workflowId = "wf_orch_no_owner";
    const now = Date.now();
    await db
      .insert(workflowDefinitions)
      .values({
        id: workflowId,
        orgId: LOCAL_ORG.id,
        ownerType: "user",
        ownerId: LOCAL_USER.id,
        name: "no-owner-run",
        definition: { version: "dag/v1", nodes: [], edges: [] },
        createdAt: now,
        updatedAt: now,
      });
    await workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] },
      "v1",
      // no owner passed
    );

    await expect(
      deps.promptOrchestrator("hello", {
        dispatchId: `workflow:${runId}:node1`,
        queueMode: "followup",
        ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id },
      }),
    ).rejects.toThrow(/no recorded owner/);
  });
});

describe("buildWorkflowEngineDeps: llmComplete", () => {
  it("throws descriptively for an unknown model id, without any network call", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const deps = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    await expect(
      deps.llmComplete({ model: "definitely-not-a-real-model-id", prompt: "hi" }),
    ).rejects.toThrow(/unknown model/);
  });
});
