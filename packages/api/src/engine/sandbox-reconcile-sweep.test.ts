import { beforeEach, describe, expect, it } from "vitest";
import type { SandboxListing } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
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
    /** Provider without a list() seam (docker/local). */
    noList?: boolean;
    /** Session ids with an engine-store row. */
    knownSessions?: string[];
    /** Session ids cached in the host. */
    cachedSessions?: string[];
    /** Consumed per `listUnsettledSubmissions` call; empty → always settled. */
    unsettledQueue?: number[];
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
        : {
            backend: "fake",
            list: async () => overrides.listed ?? [],
          },
      engineHost: {
        liveSession: (sessionId) => (cached.has(sessionId) ? {} : null),
        destroySandbox: async (sandboxId) => {
          destroyedSandboxes.push(sandboxId);
        },
      },
      engineStore: {
        getSession: async (sessionId) => (known.has(sessionId) ? { id: sessionId } : null),
        listUnsettledSubmissions: async () => new Array(unsettledQueue.shift() ?? 0).fill({}),
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

  it("a submission admitted between check and destroy wins (re-check race rule)", async () => {
    const { deps, destroyedSandboxes } = fakeDeps({
      listed: [listing("sbx-1", "sess-gone", FRESH)],
      unsettledQueue: [0, 1],
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
