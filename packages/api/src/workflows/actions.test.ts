import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryWorkflowStore, type RunHost } from "@valet/workflow";
import { workflowsActionPlugin, ownerFromContext } from "./actions.js";
import type { PluginActionContext } from "@valet/engine";
import { createWorkflowDefinition, type WorkflowServiceDeps } from "./service.js";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowRuns } from "../schema/index.js";

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
  it("exposes the five workflow actions with workflows.* ids", () => {
    const plugin = workflowsActionPlugin(noDeps);
    expect(plugin.service).toBe("workflows");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "workflows.cancel_run",
      "workflows.create_schedule",
      "workflows.create_trigger",
      "workflows.create_webhook",
      "workflows.delete_schedule",
      "workflows.delete_trigger",
      "workflows.delete_webhook",
      "workflows.delete_workflow",
      "workflows.get_node_result",
      "workflows.get_run",
      "workflows.get_webhook",
      "workflows.get_workflow",
      "workflows.list_event_types",
      "workflows.list_runs",
      "workflows.list_schedules",
      "workflows.list_triggers",
      "workflows.list_workflows",
      "workflows.patch_workflow",
      "workflows.resolve_approval",
      "workflows.save_workflow",
      "workflows.start_run",
    ]);
  });

  it("marks reads low-risk and writes medium-risk", () => {
    const plugin = workflowsActionPlugin(noDeps);
    const byId = new Map(plugin.actions.map((a) => [a.id, a.riskLevel]));
    expect(byId.get("workflows.list_workflows")).toBe("low");
    expect(byId.get("workflows.get_workflow")).toBe("low");
    expect(byId.get("workflows.get_run")).toBe("low");
    expect(byId.get("workflows.save_workflow")).toBe("medium");
    expect(byId.get("workflows.start_run")).toBe("medium");
    expect(byId.get("workflows.delete_workflow")).toBe("medium");
    expect(byId.get("workflows.list_runs")).toBe("low");
    expect(byId.get("workflows.cancel_run")).toBe("medium");
    // High → the plugin catalog's default policy gates it behind a human
    // decision — the agent cannot silently approve its own gates.
    expect(byId.get("workflows.resolve_approval")).toBe("high");
    // High → minting the hookId grants a new bearer credential that alone
    // authorizes starting runs, same reasoning as resolve_approval.
    expect(byId.get("workflows.create_webhook")).toBe("high");
    expect(byId.get("workflows.get_webhook")).toBe("low");
    expect(byId.get("workflows.delete_webhook")).toBe("medium");
  });
});

describe("ownerFromContext", () => {
  it("derives the owner from ctx.userId/orgId", () => {
    expect(ownerFromContext(ctx())).toEqual({ userId: "user1", orgId: "org1" });
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

// DB-backed: these actions go through the real services (unlike the
// pure-validation test above), so they need a real workflow_definitions
// round trip plus a run store.
describe("DB-backed actions", () => {
  let db: AppDb;
  let pglite: PGlite;
  let deps: WorkflowServiceDeps;

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
  });

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(async () => {
    await buildAppQueryable(pglite).query(
      `TRUNCATE workflow_webhooks, workflow_definitions, workflow_runs RESTART IDENTITY CASCADE`,
    );
    deps = { db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new StubRunHost() };
  });

  async function seedWorkflow(): Promise<string> {
    const created = await createWorkflowDefinition(
      deps,
      { userId: "user1", orgId: "org1" },
      { name: "hook-target", definition: { version: "dag/v1", nodes: [], edges: [] } },
    );
    return created.id;
  }

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
