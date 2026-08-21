import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AttachmentState } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions } from "../schema/index.js";
import { HibernationReaper, type HibernationReaperDeps } from "./hibernation-reaper.js";

const RETENTION_MS = 60 * 60_000;
const NOW = 1_800_000_000_000;

type SessionSeed = {
  id?: string;
  status?: "active" | "hibernated" | "archived" | "deleted";
  hibernatedSandboxId?: string | null;
  sandboxReclaimedAt?: number | null;
  updatedAt?: number;
};

describe("HibernationReaper", () => {
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
      status: seedOpts.status ?? "hibernated",
      hibernatedSandboxId: seedOpts.hibernatedSandboxId === undefined ? `sbx-${id}` : seedOpts.hibernatedSandboxId,
      sandboxReclaimedAt: seedOpts.sandboxReclaimedAt ?? null,
      createdAt: NOW - 10 * RETENTION_MS,
      updatedAt: seedOpts.updatedAt ?? NOW - 2 * RETENTION_MS,
    });
    return id;
  }

  function fakeDeps(overrides: {
    live?: { state: AttachmentState; destroyed: string[] } | null;
    unsettled?: number;
    activityAt?: number | null;
    retentionMs?: number;
  } = {}) {
    const destroyedSandboxes: string[] = [];
    const evicted: string[] = [];
    const live = overrides.live ?? null;
    const deps: HibernationReaperDeps = {
      db,
      engineHost: {
        liveSession: () =>
          live
            ? {
                attachment: {
                  state: live.state,
                  destroy: async () => {
                    live.destroyed.push("destroyed");
                  },
                },
              }
            : null,
        destroySandbox: async (sandboxId) => {
          destroyedSandboxes.push(sandboxId);
        },
        evictCache: (sessionId) => {
          evicted.push(sessionId);
        },
      },
      engineStore: {
        listUnsettledSubmissions: async () => new Array(overrides.unsettled ?? 0).fill({}),
        latestActivityAt: async () => overrides.activityAt ?? null,
      },
      retentionMs: overrides.retentionMs ?? RETENTION_MS,
    };
    return { deps, destroyedSandboxes, evicted };
  }

  async function row(id: string) {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id));
    return rows[0];
  }

  it("destroys an uncached hibernated sandbox past the window via the recorded handle and stamps the reclaim", async () => {
    const id = await seed();
    const { deps, destroyedSandboxes } = fakeDeps();

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([`sbx-${id}`]);
    const after = await row(id);
    expect(after?.sandboxReclaimedAt).toBe(NOW);
    expect(after?.status).toBe("hibernated");
  });

  it("a stamped row stops sweeping: the second pass destroys nothing", async () => {
    await seed();
    const { deps, destroyedSandboxes } = fakeDeps();
    const reaper = new HibernationReaper(deps);

    await reaper.sweep(NOW);
    await reaper.sweep(NOW + 1);

    expect(destroyedSandboxes).toHaveLength(1);
  });

  it("skips rows still inside the retention window", async () => {
    await seed({ updatedAt: NOW - RETENTION_MS + 1 });
    const { deps, destroyedSandboxes } = fakeDeps();

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("skips non-hibernated rows regardless of age", async () => {
    await seed({ status: "active" });
    await seed({ id: "s2", status: "archived" });
    const { deps, destroyedSandboxes } = fakeDeps();

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("fresh engine activity wins over a stale updated_at", async () => {
    await seed();
    const { deps, destroyedSandboxes } = fakeDeps({ activityAt: NOW - RETENTION_MS + 1 });

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("unsettled submissions win", async () => {
    await seed();
    const { deps, destroyedSandboxes } = fakeDeps({ unsettled: 1 });

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });

  it("destroys a cached suspended session through its attachment and evicts it", async () => {
    const id = await seed();
    const live = { state: "suspended" as const, destroyed: [] as string[] };
    const { deps, destroyedSandboxes, evicted } = fakeDeps({ live });

    await new HibernationReaper(deps).sweep(NOW);

    expect(live.destroyed).toEqual(["destroyed"]);
    expect(evicted).toEqual([id]);
    // The recorded handle must not be double-destroyed.
    expect(destroyedSandboxes).toEqual([]);
    expect((await row(id))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("never touches a cached session that is not suspended (waking or awake)", async () => {
    const id = await seed();
    const live = { state: "ready" as const, destroyed: [] as string[] };
    const { deps, destroyedSandboxes } = fakeDeps({ live });

    await new HibernationReaper(deps).sweep(NOW);

    expect(live.destroyed).toEqual([]);
    expect(destroyedSandboxes).toEqual([]);
    expect((await row(id))?.sandboxReclaimedAt).toBeNull();
  });

  it("stamps a handleless uncached row as reclaimed without a destroy", async () => {
    const id = await seed({ hibernatedSandboxId: null });
    const { deps, destroyedSandboxes } = fakeDeps();

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
    expect((await row(id))?.sandboxReclaimedAt).toBe(NOW);
  });

  it("retentionMs <= 0 disables the sweep entirely", async () => {
    await seed();
    const { deps, destroyedSandboxes } = fakeDeps({ retentionMs: 0 });

    await new HibernationReaper(deps).sweep(NOW);

    expect(destroyedSandboxes).toEqual([]);
  });
});
