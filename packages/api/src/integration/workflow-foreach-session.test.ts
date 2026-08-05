/**
 * Integration tests: a `foreach` whose body dispatches engine work, driven
 * across more than one item.
 *
 * `SessionNode` and `OrchestratorNode` are both legal `ForeachBodyNode`s,
 * and both mint ids with a `:{iteration}` suffix for every item after the
 * first (`iterationSuffix`). Every method on the `WorkflowEngineDeps` port
 * resolves its run context by parsing one of those ids, so the 4-part form
 * must parse the same way the 3-part form does. These tests drive the real
 * interpreter over the real `EngineHost` and Postgres workflow store, so a
 * parser that rejects the 4-part form fails here exactly as a user hits it:
 * item 0 dispatches, item 1 throws.
 *
 * `wait.mode: 'none'` keeps the assertions on dispatch (session creation
 * plus prompt submission), which is where the ids are parsed. No model turn
 * has to settle, so these tests need no API key.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createDefaultNodeExecutors, driveUntilPark, type RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "./_setup.js";
import { buildWorkflowEngineDeps, ensureWorkflowSession } from "../workflows/engine-deps.js";
import { workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/**
 * Inert `RunHost`. These tests claim and drive the run themselves, so the
 * real `LocalRunHost` poll loop must never claim the same run in parallel
 * and fence the drive under test.
 */
function inertRunHost(): RunHost {
  return {
    start: async () => {},
    wake: async () => {},
    scheduleWake: async () => {},
    terminate: async () => {},
    startHost: () => {},
    stopHost: async () => {},
  };
}

const ITEMS = ["alpha", "beta"];

function foreachDefinition(body: Record<string, unknown>): unknown {
  return {
    version: "dag/v1",
    nodes: [
      { id: "t", type: "trigger" },
      { id: "fan", type: "foreach", items: "{{trigger.data.targets}}", body },
      { id: "e", type: "stop", outcome: "success" },
    ],
    edges: [
      { from: "t", to: "fan" },
      { from: "fan", to: "e" },
    ],
  };
}

/** Boots the api, seeds one definition plus one run against it, and drives that run to a park. */
async function driveForeachRun(opts: { workflowId: string; runId: string; body: Record<string, unknown> }) {
  api = await bootTestApi({ workflowRunHost: inertRunHost() });
  const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;

  const now = Date.now();
  const definition = foreachDefinition(opts.body);

  await db.insert(workflowDefinitions).values({
    id: opts.workflowId,
    orgId: LOCAL_ORG.id,
    ownerType: "user",
    ownerId: LOCAL_USER.id,
    name: opts.workflowId,
    definition,
    createdAt: now,
    updatedAt: now,
  });
  await workflowStore.createRun(
    opts.runId,
    {
      workflowId: opts.workflowId,
      definitionVersionId: "v1",
      input: { type: "manual", timestamp: new Date(now).toISOString(), data: { targets: ITEMS }, metadata: {} },
    },
    definition,
    "v1",
    { ownerType: "user", ownerId: LOCAL_USER.id },
  );

  const engineDepsOpts = {
    host: engineHost,
    store: workflowStore,
    db,
    engineStore,
    actionPluginByService,
    credentials: engineCredentials,
  };
  const engine = buildWorkflowEngineDeps(engineDepsOpts);

  const claim = await workflowStore.claimRun(opts.runId, "foreach-body-test", 60_000);
  if (!claim) throw new Error(`could not claim run ${opts.runId}`);

  const park = await driveUntilPark(opts.runId, claim.attempt, {
    store: workflowStore,
    engine,
    clock: () => Date.now(),
    executors: createDefaultNodeExecutors(),
  });

  return { park, engineDepsOpts, engineStore, workflowStore };
}

/** The body checkpoints for one foreach body id, ordered by iteration. */
async function bodyCheckpoints(store: TestApi["providers"]["workflowStore"], runId: string, bodyId: string) {
  const all = await store.getCheckpoints(runId);
  return all.filter((cp) => cp.nodeId === bodyId).sort((a, b) => a.iteration - b.iteration);
}

function stringField(source: unknown, field: string): string {
  if (!source || typeof source !== "object") {
    throw new Error(`expected an object with "${field}", got ${JSON.stringify(source)}`);
  }
  const value = (source as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new Error(`expected a string "${field}", got ${JSON.stringify(source)}`);
  }
  return value;
}

function receiptOf(effects: Record<string, unknown> | undefined): { threadId: string; queueItemId: string } {
  if (!effects) throw new Error("checkpoint has no effects");
  const receipt = effects.receipt;
  return { threadId: stringField(receipt, "threadId"), queueItemId: stringField(receipt, "queueItemId") };
}

describe("api integration: foreach with a session body", () => {
  it("dispatches a session for EVERY item, not only the first", async () => {
    const runId = "wfrun_foreach_session";
    const { park, engineDepsOpts, engineStore, workflowStore } = await driveForeachRun({
      workflowId: "wf_foreach_session",
      runId,
      body: { id: "work", type: "session", mode: "start", prompt: "Handle {{item}}.", wait: { mode: "none" } },
    });

    expect(park.status).toBe("settled");
    expect(park.outcome).toBe("completed");

    const checkpoints = await bodyCheckpoints(workflowStore, runId, "work");
    expect(checkpoints.map((cp) => cp.iteration)).toEqual([0, 1]);
    expect(checkpoints.map((cp) => cp.status)).toEqual(["completed", "completed"]);

    const sessionIds = checkpoints.map((cp) => stringField(cp.result, "sessionId"));
    expect(sessionIds).toEqual([`wf:${runId}:work`, `wf:${runId}:work:1`]);

    // Each iteration must land on its OWN engine session with its OWN
    // workspace — a collision would let item 1 overwrite item 0's work.
    const rows = await Promise.all(sessionIds.map((id) => engineStore.getSession(id)));
    for (const [i, row] of rows.entries()) {
      expect(row, `engine session row missing for ${sessionIds[i]}`).toBeTruthy();
    }
    const workspaces = rows.map((row) => row?.workspace);
    expect(new Set(workspaces).size).toBe(sessionIds.length);

    // Each iteration submitted its own prompt, under its own dispatchId.
    const queueItems = await Promise.all(
      checkpoints.map((cp) => engineStore.getQueueItem(stringField(cp.result, "sessionId"), receiptOf(cp.effects).queueItemId)),
    );
    expect(queueItems.map((item) => item?.dispatchId)).toEqual([
      `workflow:${runId}:work`,
      `workflow:${runId}:work:1`,
    ]);

    // Boot restore reaches these same sessions by id (`restoreOneSession`
    // routes every `wf:` id here), so the 4-part id must round-trip.
    for (const sessionId of sessionIds) {
      const restored = await ensureWorkflowSession(engineDepsOpts, sessionId);
      expect(restored.id).toBe(sessionId);
    }
  }, 60_000);
});

describe("api integration: workflow session id parsing", () => {
  it("rejects an id that is not wf:{runId}:{nodeId}[:{iteration}]", async () => {
    api = await bootTestApi({ workflowRunHost: inertRunHost() });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    const opts = {
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    };

    // `wf:invoke:{invocationId}` is the synthetic action-context id that
    // `plugins/action-invoker.ts` mints. It names no engine session, and it
    // is never 3 or 4 parts, so it stays rejected.
    await expect(ensureWorkflowSession(opts, "wf:invoke:workflow:run-1:tool-1")).rejects.toThrow(
      /not a workflow session id/,
    );
    await expect(ensureWorkflowSession(opts, "wf:run-1")).rejects.toThrow(/not a workflow session id/);

    // Iteration 0 carries no suffix, and a suffix must be a whole number.
    await expect(ensureWorkflowSession(opts, "wf:run-1:node-1:0")).rejects.toThrow(/invalid iteration suffix/);
    await expect(ensureWorkflowSession(opts, "wf:run-1:node-1:last")).rejects.toThrow(/invalid iteration suffix/);
  }, 60_000);
});

describe("api integration: foreach with an orchestrator body", () => {
  it("dispatches to the owner's orchestrator once per item", async () => {
    const runId = "wfrun_foreach_orch";
    const { park, engineStore, workflowStore } = await driveForeachRun({
      workflowId: "wf_foreach_orch",
      runId,
      body: { id: "ask", type: "orchestrator", prompt: "Handle {{item}}.", wait: { mode: "none" } },
    });

    expect(park.status).toBe("settled");
    expect(park.outcome).toBe("completed");

    const checkpoints = await bodyCheckpoints(workflowStore, runId, "ask");
    expect(checkpoints.map((cp) => cp.iteration)).toEqual([0, 1]);
    expect(checkpoints.map((cp) => cp.status)).toEqual(["completed", "completed"]);

    // An orchestrator node never mints a `wf:` id: both iterations dispatch
    // onto the owner's ONE orchestrator session, and only the dispatchId
    // carries the iteration.
    const sessionIds = checkpoints.map((cp) => stringField(cp.result, "sessionId"));
    expect(sessionIds).toEqual([
      `orchestrator:user:${LOCAL_USER.id}`,
      `orchestrator:user:${LOCAL_USER.id}`,
    ]);

    const receipts = checkpoints.map((cp) => receiptOf(cp.effects));
    expect(receipts[0].queueItemId).not.toBe(receipts[1].queueItemId);
    const queueItems = await Promise.all(
      receipts.map((receipt, i) => engineStore.getQueueItem(sessionIds[i], receipt.queueItemId)),
    );
    expect(queueItems.map((item) => item?.dispatchId)).toEqual([
      `workflow:${runId}:ask`,
      `workflow:${runId}:ask:1`,
    ]);
  }, 60_000);
});
