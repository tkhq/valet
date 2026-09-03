import { beforeEach, describe, expect, it } from "vitest";
import type { SandboxListing } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { SandboxReconcileSweep, type SandboxReconcileSweepDeps } from "./sandbox-reconcile-sweep.js";

const AGE_REPORT_MS = 7 * 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;
const FRESH = NOW - 60_000;
const OVER_AGE = NOW - AGE_REPORT_MS - 60_000;

describe("SandboxReconcileSweep", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  function listing(id: string, sessionId: string | null, createdAtMs: number | null): SandboxListing {
    return { id, sessionId, createdAtMs };
  }

  function fakeDeps(overrides: {
    listed?: SandboxListing[];
    /** Result of the confirm-phase re-list; defaults to `listed`. */
    listedSecond?: SandboxListing[];
    /** Provider without a list() seam (docker/local). */
    noList?: boolean;
    /** Session ids with an engine-store row. */
    knownSessions?: string[];
    /** Session ids cached in the host. */
    cachedSessions?: string[];
    /** Consumed per `listUnsettledSubmissions` call; empty → always settled. */
    unsettledQueue?: number[];
    /** Engine activity clock per session id; absent → null (never ran). */
    activityAt?: Record<string, number>;
    ageReportMs?: number;
  } = {}) {
    const destroyedSandboxes: string[] = [];
    const known = new Set(overrides.knownSessions ?? []);
    const cached = new Set(overrides.cachedSessions ?? []);
    const unsettledQueue = [...(overrides.unsettledQueue ?? [])];
    const deps: SandboxReconcileSweepDeps = {
      db,
      provider: overrides.noList
        ? { backend: "fake" }
        : (() => {
            let calls = 0;
            return {
              backend: "fake",
              list: async () => {
                calls += 1;
                if (calls > 1 && overrides.listedSecond) return overrides.listedSecond;
                return overrides.listed ?? [];
              },
            };
          })(),
      engineHost: {
        liveSession: (sessionId) => (cached.has(sessionId) ? {} : null),
        destroySandbox: async (sandboxId) => {
          destroyedSandboxes.push(sandboxId);
        },
      },
      engineStore: {
        getSession: async (sessionId) => (known.has(sessionId) ? { id: sessionId } : null),
        listUnsettledSubmissions: async () => new Array(unsettledQueue.shift() ?? 0).fill({}),
        latestActivityAt: async (sessionId) => overrides.activityAt?.[sessionId] ?? null,
      },
      ageReportMs: overrides.ageReportMs ?? AGE_REPORT_MS,
    };
    return { deps, destroyedSandboxes };
  }

  it("no-ops on providers without a list() seam", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({ noList: true });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect(report).toEqual({ orphansDestroyed: 0, overAge: 0, unowned: 0 });
  });

  it("destroys an orphaned sandbox whose session is gone from the store and the cache", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", FRESH)],
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual(["sbx-1"]);
    expect(report.orphansDestroyed).toBe(1);
  });

  it("leaves a sandbox with a live session row alone", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-1", FRESH)],
      knownSessions: ["sess-1"],
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect(report.orphansDestroyed).toBe(0);
  });

  it("a cached session counts as an owner even without a store row", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-1", FRESH)],
      cachedSessions: ["sess-1"],
    });

    await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("unsettled submissions win over the orphan rule", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", FRESH)],
      unsettledQueue: [1],
    });

    await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("a sandbox re-adopted by a new session between the pass and the destroy is spared", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", FRESH)],
      // The confirm-phase re-list shows a NEW owner annotation: a live
      // session adopted the deterministic CR name while the pass crawled.
      listedSecond: [listing("sbx-1", "sess-new", FRESH)],
    });

    await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("a sandbox already deleted by the confirm-phase re-list is skipped", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", FRESH)],
      listedSecond: [],
    });

    await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("reports over-age sandboxes without destroying them", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-old", "sess-1", OVER_AGE), listing("sbx-new", "sess-1", FRESH)],
      knownSessions: ["sess-1"],
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect(report.overAge).toBe(1);
  });

  it("an over-age sandbox with engine activity inside the window is healthy, not a violation", async () => {
    // A suspended CR survives every resume/suspend cycle, so a daily-used
    // assistant legitimately holds a months-old CR. Only stale over-age
    // sandboxes are the "owner failed to clean up" signal.
    const { deps } = fakeDeps({
      listed: [listing("sbx-busy", "sess-busy", OVER_AGE), listing("sbx-stale", "sess-stale", OVER_AGE)],
      knownSessions: ["sess-busy", "sess-stale"],
      activityAt: { "sess-busy": FRESH, "sess-stale": OVER_AGE },
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(report.overAge).toBe(1);
  });

  describe("soft-deleted owner", () => {
    async function insertSession(db: AppDb, id: string, status: "active" | "deleted"): Promise<void> {
      await db.insert(agentSessions).values({
        id,
        userId: "u1",
        orgId: "org1",
        workspace: `/root/.valet/assistants/${id}`,
        status,
        createdAt: FRESH,
        updatedAt: FRESH,
      });
    }

    it("destroys the sandbox of a soft-deleted session even when the engine row and cache survive", async () => {
      // The partial-destroy leak (observed live): a delete route's
      // engineHost.destroy misfired, leaving the engine row, a cached
      // ghost, and a Running pod. The soft-delete is the recorded intent
      // — the sweep must reclaim regardless of engine row or cache state.
      await insertSession(db, "sess-del", "deleted");
      const { deps, destroyedSandboxes } = fakeDeps({
        listed: [listing("sbx-del", "sess-del", FRESH)],
        knownSessions: ["sess-del"],
        cachedSessions: ["sess-del"],
      });

      const report = await new SandboxReconcileSweep(deps).sweep(NOW);

      expect(destroyedSandboxes).toEqual(["sbx-del"]);
      expect(report.orphansDestroyed).toBe(1);
    });

    it("unsettled submissions still win over the deleted-owner rule", async () => {
      await insertSession(db, "sess-del", "deleted");
      const { deps, destroyedSandboxes } = fakeDeps({
        listed: [listing("sbx-del", "sess-del", FRESH)],
        knownSessions: ["sess-del"],
        unsettledQueue: [1],
      });

      await new SandboxReconcileSweep(deps).sweep(NOW);

      expect(destroyedSandboxes).toEqual([]);
    });

    it("an active app row never triggers the deleted-owner rule", async () => {
      await insertSession(db, "sess-live", "active");
      const { deps, destroyedSandboxes } = fakeDeps({
        listed: [listing("sbx-live", "sess-live", FRESH)],
        knownSessions: ["sess-live"],
      });

      await new SandboxReconcileSweep(deps).sweep(NOW);

      expect(destroyedSandboxes).toEqual([]);
    });
  });

  it("reports unowned (pre-annotation) sandboxes without destroying them, at any age", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-old", null, OVER_AGE), listing("sbx-new", null, FRESH)],
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect(report.unowned).toBe(2);
    expect(report.overAge).toBe(1);
  });

  it("an over-age orphan is still destroyed — age never shields the orphan rule", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", OVER_AGE)],
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual(["sbx-1"]);
    expect(report).toEqual({ orphansDestroyed: 1, overAge: 1, unowned: 0 });
  });

  it("ageReportMs <= 0 disables the over-age report but keeps the orphan rule", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-owned", "sess-1", OVER_AGE), listing("sbx-orphan", "sess-gone", OVER_AGE)],
      knownSessions: ["sess-1"],
      ageReportMs: 0,
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual(["sbx-orphan"]);
    expect(report.overAge).toBe(0);
  });

  it("a sandbox with no reported creation time is never over-age", async () => {
    const { deps } = fakeDeps({
      listed: [listing("sbx-1", "sess-1", null)],
      knownSessions: ["sess-1"],
    });

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(report.overAge).toBe(0);
  });

  it("one bad sandbox never blocks the rest", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", FRESH), listing("sbx-2", "sess-gone-too", FRESH)],
    });
    const originalDestroy = deps.engineHost.destroySandbox;
    deps.engineHost.destroySandbox = async (id) => {
      if (id === "sbx-1") throw new Error("provider unavailable");
      await originalDestroy(id);
    };

    const report = await new SandboxReconcileSweep(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual(["sbx-2"]);
    expect(report.orphansDestroyed).toBe(1);
  });
});
