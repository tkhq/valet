import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workflowsActionPlugin, ownerFromContext } from "./actions.js";
import type { PluginActionContext } from "@valet/engine";
import type { WorkflowServiceDeps } from "./service.js";
import githubPlugin from "@valet/plugin-github/plugin";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventSubscriptions, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import type { AppDb } from "../lib/drizzle.js";

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
      "workflows.delete_schedule",
      "workflows.delete_trigger",
      "workflows.delete_workflow",
      "workflows.get_node_result",
      "workflows.get_run",
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
      "workflows.update_schedule",
      "workflows.update_trigger",
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

// ── update_schedule / update_trigger — DB-backed ─────────────────────────

let db: AppDb;
let dbCleanup: () => Promise<void>;

const DB_USER = { id: "user_1", orgId: "org_1" };
const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  dbCleanup = boot.cleanup;

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
  await dbCleanup();
});

function makeDeps(overrides: Partial<WorkflowServiceDeps> = {}): WorkflowServiceDeps {
  return {
    db,
    workflowStore: undefined as unknown as WorkflowServiceDeps["workflowStore"],
    workflowRunHost: undefined as unknown as WorkflowServiceDeps["workflowRunHost"],
    plugins: [githubPlugin],
    ...overrides,
  };
}

describe("workflows.update_schedule action", () => {
  it("updates an existing schedule and returns the summary", async () => {
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

    const deps = makeDeps();
    const plugin = workflowsActionPlugin(() => deps);
    const action = plugin.actions.find((a) => a.id === "workflows.update_schedule");
    if (!action) throw new Error("update_schedule action missing");

    const result = await action.execute(
      { schedule_id: schedId, name: "renamed" },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { name: string }).name).toBe("renamed");
    }
  });

  it("returns error for unknown schedule id", async () => {
    const deps = makeDeps();
    const plugin = workflowsActionPlugin(() => deps);
    const action = plugin.actions.find((a) => a.id === "workflows.update_schedule");
    if (!action) throw new Error("update_schedule action missing");

    const result = await action.execute(
      { schedule_id: "no_such_schedule" },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("workflows.update_trigger action", () => {
  it("updates an existing trigger and returns the summary", async () => {
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

    const deps = makeDeps();
    const plugin = workflowsActionPlugin(() => deps);
    const action = plugin.actions.find((a) => a.id === "workflows.update_trigger");
    if (!action) throw new Error("update_trigger action missing");

    const result = await action.execute(
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

  it("returns error for unknown trigger id", async () => {
    const deps = makeDeps();
    const plugin = workflowsActionPlugin(() => deps);
    const action = plugin.actions.find((a) => a.id === "workflows.update_trigger");
    if (!action) throw new Error("update_trigger action missing");

    const result = await action.execute(
      { trigger_id: "no_such_trigger" },
      ctx({ orgId: DB_USER.orgId, userId: DB_USER.id }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
