/**
 * Integration test: a `foreach` whose body is a `session` node, driven
 * across more than one item.
 *
 * `SessionNode` is a legal `ForeachBodyNode`, and the `session` executor
 * mints `wf:{runId}:{nodeId}` at iteration 0 but `wf:{runId}:{nodeId}:
 * {iteration}` at every later iteration (`iterationSuffix`). Every method on
 * the `WorkflowEngineDeps` port resolves its run context by parsing that id,
 * so the 4-part form must parse the same way the 3-part form does. This test
 * drives the real interpreter over the real `EngineHost` + Postgres workflow
 * store, so a parser that rejects the 4-part id fails here exactly as a user
 * hits it: item 0 dispatches, item 1 throws.
 *
 * `wait.mode: 'none'` keeps the assertion on dispatch (session creation +
 * prompt submission), which is where the id is parsed. No model turn has to
 * settle, so this test needs no API key.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createDefaultNodeExecutors, driveUntilPark, type RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "./_setup.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/**
 * Inert `RunHost`. This test claims and drives the run itself, so the real
 * `LocalRunHost` poll loop must never claim the same run in parallel and
 * fence the drive under test.
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

const BODY_NODE_ID = "work";
const ITEMS = ["alpha", "beta"];

function foreachSessionDefinition(): unknown {
  return {
    version: "dag/v1",
    nodes: [
      { id: "t", type: "trigger" },
      {
        id: "fan",
        type: "foreach",
        items: "{{trigger.data.targets}}",
        body: {
          id: BODY_NODE_ID,
          type: "session",
          mode: "start",
          prompt: "Handle {{item}}.",
          wait: { mode: "none" },
        },
      },
      { id: "e", type: "stop", outcome: "success" },
    ],
    edges: [
      { from: "t", to: "fan" },
      { from: "fan", to: "e" },
    ],
  };
}

interface SessionDispatchResult {
  sessionId: string;
}

function sessionIdOf(result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new Error(`session checkpoint result is not an object: ${JSON.stringify(result)}`);
  }
  const sessionId = (result as Partial<SessionDispatchResult>).sessionId;
  if (typeof sessionId !== "string") {
    throw new Error(`session checkpoint result has no sessionId: ${JSON.stringify(result)}`);
  }
  return sessionId;
}

describe("api integration: foreach with a session body", () => {
  it("dispatches a session for EVERY item, not only the first", async () => {
    api = await bootTestApi({ workflowRunHost: inertRunHost() });
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;

    const workflowId = "wf_foreach_session";
    const runId = "wfrun_foreach_session";
    const now = Date.now();
    const definition = foreachSessionDefinition();

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      orgId: LOCAL_ORG.id,
      ownerType: "user",
      ownerId: LOCAL_USER.id,
      name: "foreach-session",
      definition,
      createdAt: now,
      updatedAt: now,
    });
    await workflowStore.createRun(
      runId,
      {
        workflowId,
        definitionVersionId: "v1",
        input: { type: "manual", timestamp: new Date(now).toISOString(), data: { targets: ITEMS }, metadata: {} },
      },
      definition,
      "v1",
      { ownerType: "user", ownerId: LOCAL_USER.id },
    );

    const engine = buildWorkflowEngineDeps({
      host: engineHost,
      store: workflowStore,
      db,
      engineStore,
      actionPluginByService,
      credentials: engineCredentials,
    });

    const claim = await workflowStore.claimRun(runId, "foreach-session-test", 60_000);
    if (!claim) throw new Error(`could not claim run ${runId}`);

    const park = await driveUntilPark(runId, claim.attempt, {
      store: workflowStore,
      engine,
      clock: () => Date.now(),
      executors: createDefaultNodeExecutors(),
    });

    expect(park.status).toBe("settled");
    expect(park.outcome).toBe("completed");

    const checkpoints = await workflowStore.getCheckpoints(runId);
    const bodyCheckpoints = checkpoints
      .filter((cp) => cp.nodeId === BODY_NODE_ID)
      .sort((a, b) => a.iteration - b.iteration);

    expect(bodyCheckpoints.map((cp) => cp.iteration)).toEqual([0, 1]);
    expect(bodyCheckpoints.map((cp) => cp.status)).toEqual(["completed", "completed"]);

    const sessionIds = bodyCheckpoints.map((cp) => sessionIdOf(cp.result));
    expect(sessionIds).toEqual([`wf:${runId}:${BODY_NODE_ID}`, `wf:${runId}:${BODY_NODE_ID}:1`]);

    // Both iterations must land on their OWN engine session — a collision
    // here would mean the second item overwrote the first item's work.
    for (const sessionId of sessionIds) {
      const row = await engineStore.getSession(sessionId);
      expect(row, `engine session row missing for ${sessionId}`).toBeDefined();
    }
    const workspaces = await Promise.all(
      sessionIds.map(async (sessionId) => (await engineStore.getSession(sessionId))?.workspace),
    );
    expect(new Set(workspaces).size).toBe(sessionIds.length);
  }, 60_000);
});
