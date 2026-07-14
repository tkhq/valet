/**
 * Unit tests for `buildWorkflowEngineDeps`'s Task 7 seams: `invokeAction`
 * (Phase-6-deferred stub), `promptOrchestrator` (real `EngineHost`
 * orchestrator wiring, no LLM call required — `submitPrompt` returns before
 * the turn actually runs), and `llmComplete`'s no-network unknown-model
 * failure path. The key-gated real-Anthropic completion path is exercised
 * separately in `src/integration/workflow-engine-deps.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
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
      definition: JSON.stringify({ version: "dag/v1", nodes: [], edges: [] }),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await workflowStore.createRun(
    runId,
    { workflowId, definitionVersionId: "v1" },
    { version: "dag/v1", nodes: [], edges: [] },
    "v1",
    { ownerType: "user", ownerId: LOCAL_USER.id },
  );
}

describe("buildWorkflowEngineDeps: invokeAction", () => {
  it("returns the Phase-6-deferred stub shape regardless of the request", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

    const result = await deps.invokeAction({
      service: "github",
      action: "create_issue",
      params: { title: "test" },
      invocationId: "workflow:run1:node1",
    });

    expect(result).toEqual({
      ok: false,
      error: "no integrations are connected — the plugin system lands in Phase 6",
    });
  });
});

describe("buildWorkflowEngineDeps: promptOrchestrator", () => {
  it("ensures the owner's orchestrator session and admits a followup signal envelope", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore, workflowStore } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

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
    const { db, engineHost, engineStore, workflowStore } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

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
    const { db, engineHost, engineStore, workflowStore } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

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
    const { db, engineHost, engineStore, workflowStore } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

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
        definition: JSON.stringify({ version: "dag/v1", nodes: [], edges: [] }),
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
    const { db, engineHost, engineStore, workflowStore } = api.providers;
    const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

    await expect(
      deps.llmComplete({ model: "definitely-not-a-real-model-id", prompt: "hi" }),
    ).rejects.toThrow(/unknown model/);
  });
});
