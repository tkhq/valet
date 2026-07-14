/**
 * Integration test: `buildWorkflowEngineDeps` (Phase 5 plan Task 10, Task 7
 * of the node-completion plan) over a real `EngineHost` + real Anthropic
 * call.
 *
 *  - `createSession -> prompt -> awaitResult` round-trips one trivial
 *    session-node turn and asserts duplicate-`dispatchId` idempotency.
 *  - `llm node end-to-end through a run` drives a real
 *    `trigger -> llm -> stop` definition through the actual `LocalRunHost`
 *    (no stub), asserting the `llm` node's checkpoint carries a real
 *    completion with `outputSchema`-validated `output` — i.e. Task 7's
 *    `llmComplete` seam (pi-ai `getModel` + `completeSimple`) actually
 *    drives a node to completion, not just a bare API call.
 *
 * Skipped without `ANTHROPIC_API_KEY`.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import type {
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
const MODEL = "claude-haiku-4-5";

describeIfKey("api integration: workflow engine-deps", () => {
  it(
    "createSession -> prompt -> awaitResult round-trips a real turn; duplicate dispatchId returns the original receipt",
    async () => {
      const api = await bootTestApi();
      try {
        const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;

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

        const deps = buildWorkflowEngineDeps({
          host: engineHost,
          store: workflowStore,
          db,
          engineStore,
          actionPluginByService,
          credentials: engineCredentials,
        });

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

  it(
    "llm node end-to-end through a run: trigger -> llm -> stop, schema-validated output",
    async () => {
      const api = await bootTestApi();
      try {
        const definition = {
          version: "dag/v1",
          nodes: [
            { id: "trigger", type: "trigger" },
            {
              id: "llm1",
              type: "llm",
              model: MODEL,
              prompt:
                'Respond with ONLY JSON matching {"greeting": string} — a short one-word greeting. No other text.',
              outputSchema: {
                type: "object",
                properties: { greeting: { type: "string" } },
                required: ["greeting"],
              },
            },
            { id: "stop", type: "stop" },
          ],
          edges: [
            { from: "trigger", to: "llm1" },
            { from: "llm1", to: "stop" },
          ],
        };

        const createRes = await fetch(`${api.baseUrl}/api/workflows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "llm-node-e2e", definition }),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as CreateWorkflowResponse;

        const runRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(runRes.status).toBe(201);
        const { runId } = (await runRes.json()) as StartWorkflowRunResponse;

        const start = Date.now();
        let detail: GetWorkflowRunResponse | undefined;
        while (Date.now() - start < 30_000) {
          const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
          detail = (await res.json()) as GetWorkflowRunResponse;
          if (detail.run.status === "settled") break;
          await new Promise((r) => setTimeout(r, 500));
        }

        expect(detail?.run.status).toBe("settled");
        expect(detail?.run.outcome).toBe("completed");

        const llmCheckpoint = detail?.checkpoints.find((cp) => cp.nodeId === "llm1");
        expect(llmCheckpoint?.status).toBe("completed");
        const result = llmCheckpoint?.result as { text: string; output?: { greeting: string } } | undefined;
        expect(typeof result?.text).toBe("string");
        expect(result?.text.length).toBeGreaterThan(0);
        expect(typeof result?.output?.greeting).toBe("string");
        expect(result?.output?.greeting.length).toBeGreaterThan(0);
      } finally {
        await api.cleanup();
      }
    },
    45_000,
  );
});
