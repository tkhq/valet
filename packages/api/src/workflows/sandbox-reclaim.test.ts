import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AttachmentState } from "@valet/engine";
import type { NodeCheckpoint } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowRuns } from "../schema/index.js";
import { workflowSessionWorkspace } from "./engine-deps.js";
import { WorkflowSandboxReclaimer, type WorkflowSandboxReclaimerDeps } from "./sandbox-reclaim.js";

const NOW = 1_800_000_000_000;
/** Older than the sweep's settle grace (5 min). */
const SETTLED_AT = NOW - 60 * 60_000;

type RunSeed = {
  id?: string;
  status?: "pending" | "running" | "parked" | "terminalizing" | "settled";
  sandboxReclaimedAt?: number | null;
  updatedAt?: number;
};

describe("WorkflowSandboxReclaimer", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  async function seedRun(seed: RunSeed = {}): Promise<string> {
    const id = seed.id ?? "wfrun_1";
    await db.insert(workflowRuns).values({
      id,
      workflowId: "wf_1",
      definitionVersionId: "wfv_1",
      definition: { nodes: [] },
      params: { workflowId: "wf_1" },
      status: seed.status ?? "settled",
      outcome: "completed",
      sandboxReclaimedAt: seed.sandboxReclaimedAt ?? null,
      createdAt: SETTLED_AT - 60_000,
      updatedAt: seed.updatedAt ?? SETTLED_AT,
    });
    return id;
  }

  function checkpoint(runId: string, nodeId: string, sessionId?: string, iteration = 0): NodeCheckpoint {
    return {
      runId,
      nodeId,
      iteration,
      attempt: 0,
      status: "completed",
      ...(sessionId ? { effects: { sessionId, receipt: { queueItemId: "q1" }, repairAttempted: false } } : {}),
      createdAt: SETTLED_AT,
    };
  }

  function fakeDeps(overrides: {
    checkpoints?: NodeCheckpoint[];
    /** Per-run checkpoints; wins over `checkpoints` when set. */
    checkpointsFor?: (runId: string) => NodeCheckpoint[];
    /** Cached sessions by id. `destroyOk: false` models a provider destroy
     * failure (attachment.destroy resolves false). */
    live?: Map<string, { state: AttachmentState; destroyed: string[]; destroyOk?: boolean }>;
    /** Consumed per `listUnsettledSubmissions` call; empty → always settled. */
    unsettledQueue?: number[];
    /** null models a backend-assigned-id provider (docker/local). */
    deriveHandles?: boolean;
    /** Provider state for derived handles; default "ready" (a sandbox exists). */
    sandboxState?: "ready" | "released";
    destroyError?: Error;
  } = {}) {
    const destroyedSandboxes: string[] = [];
    const evicted: string[] = [];
    const deriveKeys: string[] = [];
    const unsettledQueue = [...(overrides.unsettledQueue ?? [])];
    const deps: WorkflowSandboxReclaimerDeps = {
      db,
      engineHost: {
        liveSession: (sessionId) => {
          const live = overrides.live?.get(sessionId);
          if (!live) return null;
          return {
            attachment: {
              state: live.state,
              destroy: async () => {
                live.destroyed.push(sessionId);
                return live.destroyOk ?? true;
              },
            },
          };
        },
        destroySandbox: async (sandboxId) => {
          if (overrides.destroyError) throw overrides.destroyError;
          destroyedSandboxes.push(sandboxId);
        },
        sandboxStatus: async (sandboxId) => ({
          id: sandboxId,
          state: overrides.sandboxState ?? ("ready" as const),
        }),
        deriveSandboxId: (sessionKey) => {
          deriveKeys.push(sessionKey);
          return overrides.deriveHandles === false ? null : `sbx:${sessionKey}`;
        },
        evictCache: (sessionId) => {
          evicted.push(sessionId);
        },
      },
      engineStore: {
        listUnsettledSubmissions: async () => new Array(unsettledQueue.shift() ?? 0).fill({}),
      },
      store: {
        getCheckpoints: async (runId) => overrides.checkpointsFor?.(runId) ?? overrides.checkpoints ?? [],
      },
    };
    return { deps, destroyedSandboxes, evicted, deriveKeys };
  }

  async function row(id: string) {
    const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
    return rows[0];
  }

  it("destroys the derived sandbox of every uncached session the run's checkpoints name and stamps the reclaim", async () => {
    const runId = await seedRun();
    const s1 = `wf:${runId}:step_a`;
    const s2 = `wf:${runId}:step_b:1`;
    const { deps, destroyedSandboxes, deriveKeys } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", s1), checkpoint(runId, "step_b", s2, 1)],
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(deriveKeys).toEqual([workflowSessionWorkspace(s1), workflowSessionWorkspace(s2)]);
    expect(destroyedSandboxes).toEqual(deriveKeys.map((k) => `sbx:${k}`));
    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("ignores checkpoint sessions that are not this run's wf: sessions (assistant ids, other runs)", async () => {
    const runId = await seedRun();
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [
        checkpoint(runId, "orch", "assistant:asst_1:u1"),
        checkpoint(runId, "stray", "wf:wfrun_other:step_a"),
      ],
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(destroyedSandboxes).toEqual([]);
    // Nothing of the run's own remains, so the stamp still lands.
    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("dedupes one session named by several checkpoints (attempts, intent + terminal)", async () => {
    const runId = await seedRun();
    const s1 = `wf:${runId}:step_a`;
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", s1), checkpoint(runId, "step_a", s1)],
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(destroyedSandboxes).toHaveLength(1);
  });

  it("unsettled submissions win: no destroy, no stamp, the sweep retries later", async () => {
    const runId = await seedRun();
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
      unsettledQueue: [1],
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect((await row(runId))?.sandboxReclaimedAt).toBeNull();
  });

  it("destroys a cached session through its attachment and evicts it", async () => {
    const runId = await seedRun();
    const s1 = `wf:${runId}:step_a`;
    const live = new Map([[s1, { state: "ready" as const, destroyed: [] as string[] }]]);
    const { deps, destroyedSandboxes, evicted } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", s1)],
      live,
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(live.get(s1)?.destroyed).toEqual([s1]);
    expect(evicted).toEqual([s1]);
    // The derived handle must not be double-destroyed.
    expect(destroyedSandboxes).toEqual([]);
    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("unsettled submissions spare a cached session's sandbox too", async () => {
    const runId = await seedRun();
    const s1 = `wf:${runId}:step_a`;
    const live = new Map([[s1, { state: "ready" as const, destroyed: [] as string[] }]]);
    const { deps } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", s1)],
      live,
      unsettledQueue: [1],
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(live.get(s1)?.destroyed).toEqual([]);
    expect((await row(runId))?.sandboxReclaimedAt).toBeNull();
  });

  it("stamps without a destroy on backends with no derivable handle (docker/local)", async () => {
    const runId = await seedRun();
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
      deriveHandles: false,
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("a failed cached destroy (attachment resolves false) evicts but leaves the stamp NULL", async () => {
    const runId = await seedRun();
    const s1 = `wf:${runId}:step_a`;
    const live = new Map([[s1, { state: "ready" as const, destroyed: [] as string[], destroyOk: false }]]);
    const { deps, evicted } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", s1)],
      live,
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(evicted).toEqual([s1]);
    expect((await row(runId))?.sandboxReclaimedAt).toBeNull();
  });

  it("a never-provisioned session (Tier 0) stamps without a destroy or a metric count", async () => {
    const runId = await seedRun();
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
      sandboxState: "released",
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("a failed destroy leaves the stamp NULL so the sweep retries", async () => {
    const runId = await seedRun();
    const { deps } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
      destroyError: new Error("provider unavailable"),
    });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect((await row(runId))?.sandboxReclaimedAt).toBeNull();
  });

  it("a run with no session nodes stamps immediately", async () => {
    const runId = await seedRun();
    const { deps } = fakeDeps({ checkpoints: [checkpoint(runId, "llm_only")] });

    await new WorkflowSandboxReclaimer(deps).reclaimRun(runId, NOW);

    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("sweep reclaims settled unstamped runs past the grace window", async () => {
    const runId = await seedRun();
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
    });

    await new WorkflowSandboxReclaimer(deps).sweep(NOW);

    expect(destroyedSandboxes).toHaveLength(1);
    expect((await row(runId))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("sweep skips unsettled runs, stamped runs, and runs inside the grace window", async () => {
    await seedRun({ id: "wfrun_running", status: "running" });
    await seedRun({ id: "wfrun_stamped", sandboxReclaimedAt: SETTLED_AT + 1 });
    await seedRun({ id: "wfrun_fresh", updatedAt: NOW - 1 });
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpointsFor: (runId) => [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
    });

    await new WorkflowSandboxReclaimer(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("a failed reclaim rotates the run to the back of the sweep queue (no starvation)", async () => {
    const runId = await seedRun();
    const { deps } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
      unsettledQueue: [1],
    });

    await new WorkflowSandboxReclaimer(deps).sweep(NOW);

    const after = await row(runId);
    expect(after?.sandboxReclaimedAt).toBeNull();
    // updated_at bumped to the sweep's `now`: the row leaves the oldest-100
    // window head and re-enters behind the settle grace, so newer leaked
    // runs get their turn on the next pass.
    expect(after?.updatedAt).toBe(NOW);
  });

  it("a stamped run stops sweeping: the second pass destroys nothing", async () => {
    const runId = await seedRun();
    const { deps, destroyedSandboxes } = fakeDeps({
      checkpoints: [checkpoint(runId, "step_a", `wf:${runId}:step_a`)],
    });
    const reclaimer = new WorkflowSandboxReclaimer(deps);

    await reclaimer.sweep(NOW);
    await reclaimer.sweep(NOW + 1);

    expect(destroyedSandboxes).toHaveLength(1);
  });
});
