/**
 * Integration test: `buildWorkflowEngineDeps` (Phase 5 plan Task 10) over a
 * real `EngineHost` + real Anthropic call. Drives one trivial turn through
 * `createSession` -> `prompt` -> `awaitResult`, and asserts a duplicate
 * `prompt` call carrying the same `dispatchId` returns the original receipt
 * rather than dispatching a second submission (the engine's own
 * `dispatchId` idempotency contract, exercised end-to-end through the
 * workflow deps layer).
 *
 * Skipped without `ANTHROPIC_API_KEY`.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("api integration: workflow engine-deps", () => {
  it(
    "createSession -> prompt -> awaitResult round-trips a real turn; duplicate dispatchId returns the original receipt",
    async () => {
      const api = await bootTestApi();
      try {
        const { db, engineHost, engineStore, workflowStore } = api.providers;

        const workflowId = "wf_engine_deps_test";
        const runId = "wfrun_engine_deps_test";
        const now = Date.now();
        await db
          .insert(workflowDefinitions)
          .values({
            id: workflowId,
            orgId: LOCAL_ORG.id,
            ownerType: "user",
            ownerId: LOCAL_USER.id,
            name: "engine-deps-test",
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

        const deps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

        const sessionId = `wf:${runId}:node1`;
        const created = await deps.createSession({ id: sessionId, purpose: "workflow" });
        expect(created.id).toBe(sessionId);

        const dispatchId = `workflow:${runId}:node1`;
        const promptText = "Reply with exactly the single word 'noted' and nothing else.";
        const receiptA = await deps.prompt(sessionId, promptText, { dispatchId });
        expect(receiptA.threadId).toBeTruthy();
        expect(receiptA.queueItemId).toBeTruthy();

        // Duplicate dispatch: same dispatchId + same content (the real
        // crash-retry shape — a workflow executor re-issuing an identical
        // prompt after a crash between dispatch and checkpoint). Must
        // return the ORIGINAL receipt, not create a second submission.
        const receiptB = await deps.prompt(sessionId, promptText, { dispatchId });
        expect(receiptB).toEqual(receiptA);

        const result = await deps.awaitResult(sessionId, receiptA.threadId, receiptA.queueItemId);
        expect(result.outcome).toBe("completed");

        const settled = await deps.isSettled(sessionId, receiptA.queueItemId);
        expect(settled).toBe(true);
      } finally {
        await api.cleanup();
      }
    },
    45_000,
  );
});
