import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { SandboxStatus } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions } from "../schema/index.js";
import { IdleHibernationSweep, type IdleHibernationSweepDeps } from "./idle-hibernation-sweep.js";

const IDLE_MS = 30 * 60_000;
const NOW = 1_800_000_000_000;
const STALE = NOW - 2 * IDLE_MS;

type SessionSeed = {
  id?: string;
  status?: "active" | "hibernated" | "archived" | "deleted";
  updatedAt?: number;
};

describe("IdleHibernationSweep", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  async function seed(seedOpts: SessionSeed = {}): Promise<string> {
    const id = seedOpts.id ?? "s1";
    await db.insert(agentSessions).values({
      id,
      userId: "u1",
      orgId: "org1",
      workspace: `/ws/${id}`,
      status: seedOpts.status ?? "active",
      createdAt: STALE - IDLE_MS,
      updatedAt: seedOpts.updatedAt ?? STALE,
    });
    return id;
  }

  function fakeDeps(overrides: {
    /** Session ids cached (or mid-build) in the host. */
    cachedSessions?: string[];
    /** Consumed per `listUnsettledSubmissions` call; empty → always settled. */
    unsettledQueue?: number[];
    activityAt?: number | null;
    /** Provider state for every sandbox; default "ready". */
    sandboxState?: SandboxStatus["state"];
    hibernationCapable?: boolean;
    /** deriveSandboxId result; default `sbx:<key>`. */
    deriveHandles?: boolean;
    suspendError?: Error;
    idleMs?: number;
  } = {}) {
    const suspended: string[] = [];
    const cached = new Set(overrides.cachedSessions ?? []);
    const unsettledQueue = [...(overrides.unsettledQueue ?? [])];
    const deps: IdleHibernationSweepDeps = {
      db,
      engineHost: {
        sessionLiveOrBuilding: (sessionId) => cached.has(sessionId),
        suspendSandbox: async (sandboxId) => {
          if (overrides.suspendError) throw overrides.suspendError;
          suspended.push(sandboxId);
        },
        sandboxStatus: async (sandboxId) => ({
          id: sandboxId,
          state: overrides.sandboxState ?? "ready",
        }),
        deriveSandboxId: (sessionKey) =>
          overrides.deriveHandles === false ? null : `sbx:${sessionKey}`,
        sandboxHibernationCapable: () => overrides.hibernationCapable ?? true,
      },
      engineStore: {
        listUnsettledSubmissions: async () => new Array(unsettledQueue.shift() ?? 0).fill({}),
        latestActivityAt: async () => overrides.activityAt ?? null,
      },
      idleMs: overrides.idleMs ?? IDLE_MS,
    };
    return { deps, suspended };
  }

  async function row(id: string) {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id));
    return rows[0];
  }

  it("suspends a stranded idle active session and stamps it hibernated with the derived handle", async () => {
    const id = await seed();
    const { deps, suspended } = fakeDeps();

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([`sbx:/ws/${id}`]);
    const after = await row(id);
    expect(after?.status).toBe("hibernated");
    expect(after?.hibernatedSandboxId).toBe(`sbx:/ws/${id}`);
    expect(after?.sandboxReclaimedAt).toBeNull();
  });

  it("a hibernated row stops sweeping: the second pass suspends nothing", async () => {
    await seed();
    const { deps, suspended } = fakeDeps();
    const sweep = new IdleHibernationSweep(deps);

    await sweep.sweep(NOW);
    await sweep.sweep(NOW + 1);

    expect(suspended).toHaveLength(1);
  });

  it("leaves cached or mid-build sessions to the in-memory idle sweep", async () => {
    const id = await seed();
    const { deps, suspended } = fakeDeps({ cachedSessions: [id] });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
    expect((await row(id))?.status).toBe("active");
  });

  it("skips rows inside the idle window (updated_at prefilter)", async () => {
    await seed({ updatedAt: NOW - IDLE_MS + 1 });
    const { deps, suspended } = fakeDeps();

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
  });

  it("fresh engine activity wins over a stale updated_at", async () => {
    await seed();
    const { deps, suspended } = fakeDeps({ activityAt: NOW - IDLE_MS + 1 });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
  });

  it("null activity falls back to createdAt — a fresh never-used session is protected", async () => {
    const id = "s-fresh";
    await db.insert(agentSessions).values({
      id,
      userId: "u1",
      orgId: "org1",
      workspace: `/ws/${id}`,
      status: "active",
      createdAt: NOW - 60_000, // young session; updated_at seeded stale below
      updatedAt: STALE,
    });
    const { deps, suspended } = fakeDeps({ activityAt: null });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
    expect((await row(id))?.status).toBe("active");
  });

  it("unsettled submissions win", async () => {
    await seed();
    const { deps, suspended } = fakeDeps({ unsettledQueue: [1] });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
  });

  it("a submission admitted between check and suspend wins (re-check race rule)", async () => {
    const id = await seed();
    const { deps, suspended } = fakeDeps({ unsettledQueue: [0, 1] });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
    expect((await row(id))?.status).toBe("active");
  });

  it("skips non-active rows regardless of age", async () => {
    await seed({ status: "hibernated" });
    await seed({ id: "s2", status: "archived" });
    const { deps, suspended } = fakeDeps();

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
  });

  it("stamps a sandbox-less session (provider reports released) without a suspend", async () => {
    const id = await seed();
    const { deps, suspended } = fakeDeps({ sandboxState: "released" });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
    expect((await row(id))?.status).toBe("hibernated");
  });

  it("finishes the stamp for an already-suspended sandbox (crash between suspend and stamp)", async () => {
    const id = await seed();
    const { deps, suspended } = fakeDeps({ sandboxState: "idle" });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
    expect((await row(id))?.status).toBe("hibernated");
  });

  it("a failed suspend leaves the row active so the next pass retries", async () => {
    const id = await seed();
    const { deps } = fakeDeps({ suspendError: new Error("apiserver down") });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect((await row(id))?.status).toBe("active");
  });

  it("no-ops without hibernation capability", async () => {
    await seed();
    const { deps, suspended } = fakeDeps({ hibernationCapable: false });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
  });

  it("idleMs <= 0 disables the sweep entirely", async () => {
    await seed();
    const { deps, suspended } = fakeDeps({ idleMs: 0 });

    await new IdleHibernationSweep(deps).sweep(NOW);

    expect(suspended).toEqual([]);
  });
});
