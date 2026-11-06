/**
 * A completed run re-runs only the steps edited since the run and the steps
 * after them (`from: "changed_steps"`). The steps before the edit keep the
 * old run's results, so a prompt change on a late step does not repeat the
 * expensive early steps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { NodeCheckpoint, RunHost, RunStartOptions } from "@valet/workflow";
import { InMemoryCredentialStore, InMemorySessionStore } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowDefinitions } from "../schema/index.js";
import { PgWorkflowStore } from "./pg-store.js";
import { changedStepsToRerun, retryWorkflowRun, type WorkflowOwner, type WorkflowServiceDeps } from "./service.js";

/** The seed each start received. This suite runs no real run: the seed is what decides which steps run again. */
const started: Array<{ runId: string; seed?: RunStartOptions["seed"] }> = [];

const stubRunHost: RunHost = {
  async start(runId, _params, _definition, _owner, opts) {
    started.push({ runId, seed: opts?.seed });
  },
  async wake() {},
  async scheduleWake() {},
  async terminate() {},
  startHost() {},
  async stopHost() {},
};

const OWNER: WorkflowOwner = { userId: "user_1", orgId: "org_1" };
const WORKFLOW_ID = "wf_report";

/** trigger → fetch → summarize (session) → notify (tool) → done */
function report(prompt: string) {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "fetch", type: "set", values: { prs: [1, 2, 3] } },
      { id: "summarize", type: "session", mode: "start", prompt },
      { id: "notify", type: "tool", service: "slack", action: "send_message", params: { text: "{{nodes.summarize.output}}" } },
      { id: "done", type: "stop" },
    ],
    edges: [
      { from: "trigger", to: "fetch" },
      { from: "fetch", to: "summarize" },
      { from: "summarize", to: "notify" },
      { from: "notify", to: "done" },
    ],
  };
}

let cleanup: () => Promise<void>;
let deps: WorkflowServiceDeps;
let store: PgWorkflowStore;

beforeAll(async () => {
  const boot = await freshTestPgDb();
  cleanup = boot.cleanup;
  store = new PgWorkflowStore(boot.pgdb);
  deps = {
    db: boot.appDb,
    workflowStore: store,
    workflowRunHost: stubRunHost,
    engineStore: new InMemorySessionStore(),
    credentials: new InMemoryCredentialStore(),
  };
  await deps.db.insert(workflowDefinitions).values({
    id: WORKFLOW_ID, orgId: OWNER.orgId, ownerType: "user", ownerId: OWNER.userId,
    name: "Weekly report", definition: report("Summarize v1"), createdAt: 1, updatedAt: 1,
  });
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  started.length = 0;
  await saveDefinition(report("Summarize v1"));
});

async function saveDefinition(definition: ReturnType<typeof report>): Promise<void> {
  await deps.db.update(workflowDefinitions).set({ definition, updatedAt: Date.now() }).where(eq(workflowDefinitions.id, WORKFLOW_ID));
}

/** A settled run of `report("Summarize v1")` with every step finished. */
async function settledRun(runId: string, outcome: "completed" | "failed"): Promise<NodeCheckpoint[]> {
  await store.createRun(
    runId,
    { workflowId: WORKFLOW_ID, definitionVersionId: "v1", input: { type: "manual", timestamp: "t", data: {}, metadata: {} } },
    report("Summarize v1"),
    "v1",
    { ownerType: "user", ownerId: OWNER.userId },
  );
  const steps: Array<[string, NodeCheckpoint["status"]]> = outcome === "completed"
    ? [["trigger", "completed"], ["fetch", "completed"], ["summarize", "completed"], ["notify", "completed"], ["done", "completed"]]
    : [["trigger", "completed"], ["fetch", "completed"], ["summarize", "failed"]];
  for (const [nodeId, status] of steps) {
    await store.putIntent({ runId, nodeId, iteration: 0, status: "intent", attempt: 0, createdAt: 1 });
    await store.completeCheckpoint(runId, nodeId, 0, 0, {
      runId, nodeId, iteration: 0, status, attempt: 0, createdAt: 1,
      ...(status === "completed" ? { result: { from: nodeId } } : { error: "boom" }),
    });
  }
  await store.settleRun(runId, outcome);
  return store.getCheckpoints(runId);
}

describe("retryWorkflowRun from changed_steps", () => {
  it("reuses the steps before an edited session step and runs that step and every step after it again", async () => {
    const checkpoints = await settledRun("wfrun_done", "completed");
    await saveDefinition(report("Summarize v2, one line per PR"));
    const run = { runId: "wfrun_done", workflowId: WORKFLOW_ID, status: "settled", outcome: "completed", definition: report("Summarize v1") };
    const rerunSteps = [{ nodeId: "summarize" }, { nodeId: "notify", action: "slack.send_message" }, { nodeId: "done" }];
    expect(await changedStepsToRerun(deps, OWNER, run, checkpoints)).toEqual(rerunSteps);

    const result = await retryWorkflowRun(deps, OWNER, "wfrun_done", { from: "changed_steps" });

    // The tool step after the edit sends its message again, and the result says so.
    expect(result).toEqual({ runId: expect.any(String), rerunSteps });
    expect(started).toHaveLength(1);
    expect(started[0]?.seed?.map((cp) => [cp.nodeId, cp.result])).toEqual([
      ["trigger", { from: "trigger" }],
      ["fetch", { from: "fetch" }],
    ]);
  });

  it("refuses when no step changed since the run, and starts nothing", async () => {
    const checkpoints = await settledRun("wfrun_same", "completed");
    const run = { runId: "wfrun_same", workflowId: WORKFLOW_ID, status: "settled", outcome: "completed", definition: report("Summarize v1") };
    expect(await changedStepsToRerun(deps, OWNER, run, checkpoints)).toEqual([]);

    expect(await retryWorkflowRun(deps, OWNER, "wfrun_same", { from: "changed_steps" })).toBe("nothing_changed");
    expect(started).toHaveLength(0);
  });

  it("keeps each retry mode to its own run outcome", async () => {
    await settledRun("wfrun_ok", "completed");
    await settledRun("wfrun_failed", "failed");
    await saveDefinition(report("Summarize v2"));

    expect(await retryWorkflowRun(deps, OWNER, "wfrun_ok", { from: "failed_step" })).toBe("run_completed");
    expect(await retryWorkflowRun(deps, OWNER, "wfrun_ok")).toBe("run_completed");
    expect(await retryWorkflowRun(deps, OWNER, "wfrun_ok", { from: "changed_steps", input: { days: 1 } })).toBe("input_needs_start");
    expect(await retryWorkflowRun(deps, OWNER, "wfrun_failed", { from: "changed_steps" })).toBe("run_not_completed");
    expect(started).toHaveLength(0);
  });
});
