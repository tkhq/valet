/**
 * Plugin event handlers as a delivery target: the dispatcher runs the
 * handler beside its loop, hands it scoped threads and store, and records
 * the outcome on the delivery row.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PluginEventContext, PluginEventHandler, PluginThreads, ValetPlugin } from "@valet/engine";
import type { RunHost as WorkflowRunHost } from "@valet/workflow";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { eventDeliveries, eventSubscriptions, events } from "../schema/index.js";
import githubPlugin from "@valet/plugin-github/plugin";
import { EventDispatcher, type PluginHandlerHost } from "./dispatcher.js";
import type { PluginThreadsScope } from "../plugins/plugin-threads.js";

const ORG = "org-1";

function fakeRunHost(): WorkflowRunHost {
  return {
    start: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    scheduleWake: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    startHost: vi.fn(),
    stopHost: vi.fn(async () => {}),
  };
}

/** A plugin with one handler whose body the test supplies. */
function pluginWith(handle: PluginEventHandler["handle"], extra: Partial<PluginEventHandler> = {}): ValetPlugin {
  return {
    name: "reviewer",
    version: "0.0.1",
    credentials: [{ service: "github", type: "oauth2", configKeys: ["accessToken"] }],
    eventHandlers: [{ id: "review", description: "Review a pull request.", events: ["github.pull_request.*"], handle, ...extra }],
  };
}

/** Threads that fail if a handler uses them; these tests do not. */
const noThreads: PluginThreads = {
  ensure: async () => { throw new Error("threads are not used in this test"); },
  post: async () => { throw new Error("threads are not used in this test"); },
  record: async () => { throw new Error("threads are not used in this test"); },
  spawnChild: async () => { throw new Error("threads are not used in this test"); },
  awaitChild: async () => { throw new Error("threads are not used in this test"); },
  awaitReply: async () => { throw new Error("threads are not used in this test"); },
  stopChild: async () => { throw new Error("threads are not used in this test"); },
};

function handlerHost(appToken: PluginHandlerHost["appToken"] = async () => null): PluginHandlerHost {
  return { threads: () => noThreads, appToken, stopDeliveryChildren: vi.fn(async () => {}), leaseRenewMs: 20 };
}

describe("EventDispatcher plugin target", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  async function seed(opts: {
    ownerType?: "user" | "team"; ownerId?: string; attempts?: number;
    config?: Record<string, unknown>; subscriptionId?: string; occurredAt?: number; receivedAt?: number;
    /** The PR number, or null for a repo-level event such as a check suite on main. */
    pr?: string | null; status?: "pending" | "delivered";
  } = {}) {
    const db = tdb.appDb;
    const now = Date.now();
    const eventId = randomUUID();
    const subscriptionId = opts.subscriptionId ?? randomUUID();
    const deliveryId = randomUUID();
    const pr = opts.pr === undefined ? "7" : opts.pr;
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: "github",
      eventKey: "github.pull_request.synchronize",
      dedupeKey: randomUUID(),
      actor: null,
      refs: { repo: "acme/site", pr_number: pr ?? "", head_sha: "abc" },
      summary: pr === null ? "Check suite completed" : `PR #${pr} updated`,
      payload: { action: "synchronize" },
      occurredAt: opts.occurredAt ?? now - 5_000,
      receivedAt: opts.receivedAt ?? now,
      // As GitHub ingest stamps them: owner, repo, then the PR.
      subjects: ["github:acme", "github:acme/site", ...(pr === null ? [] : [`github:acme/site#${pr}`])],
    });
    if (!opts.subscriptionId) await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType: opts.ownerType ?? "user",
      ownerId: opts.ownerId ?? "user-1",
      name: "review PRs",
      eventKeys: ["github.pull_request.*"],
      filters: [],
      target: { kind: "plugin", plugin: "reviewer", handler: "review", ...(opts.config !== undefined ? { config: opts.config } : {}) },
      enabled: true,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(eventDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId,
      status: opts.status ?? "pending",
      attempts: opts.attempts ?? 0,
      nextAttemptAt: now - 1,
      createdAt: now,
    });
    return { deliveryId, eventId, subscriptionId };
  }

  async function delivery(id: string) {
    const [row] = await tdb.appDb.select().from(eventDeliveries).where(eq(eventDeliveries.id, id)).limit(1);
    return row;
  }

  function dispatcher(plugin: ValetPlugin, host: PluginHandlerHost | "none" = handlerHost()) {
    return new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToAssistant: vi.fn(async () => ({ sessionId: "s", threadId: "t" })),
      // The GitHub plugin gives events their natural subject (one pull request).
      plugins: [plugin, githubPlugin],
      ...(host !== "none" ? { pluginHandlers: host } : {}),
    });
  }

  /** Wait for the background run to record its outcome. */
  async function settled(id: string) {
    for (let i = 0; i < 200; i++) {
      const row = await delivery(id);
      if (row.status !== "pending") return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("delivery never settled");
  }

  it("runs the handler with the event and a context scoped to the owner, then marks the delivery delivered", async () => {
    const { deliveryId, eventId } = await seed({ ownerType: "team", ownerId: "team-1" });
    let seen: { id: string; key: string; refs: Record<string, string>; ctx: PluginEventContext } | undefined;
    const appToken = vi.fn(async () => "ghs_test");
    const d = dispatcher(pluginWith(async (event, ctx) => {
      seen = { id: event.id, key: event.key, refs: event.refs, ctx };
      expect(await ctx.appToken("github", { owner: "acme" })).toBe("ghs_test");
      await ctx.store.put("pr-state", "acme/site#7", { lastReviewedHead: event.refs.head_sha });
    }), handlerHost(appToken));
    await d.pollOnce();
    expect((await settled(deliveryId)).status).toBe("delivered");
    expect(seen?.id).toBe(eventId);
    expect(seen?.key).toBe("github.pull_request.synchronize");
    expect(seen?.ctx.owner).toEqual({ type: "team", id: "team-1" });
    // The handler acts as the team, not as the member who armed the line.
    expect(seen?.ctx.actorUserId).toBe("team:team-1");
    expect(appToken).toHaveBeenCalledWith(ORG, "github", { owner: "acme" });
    // The pointer landed in the plugin's team-scoped store.
    const stored = await seen?.ctx.store.get<{ lastReviewedHead: string }>("pr-state", "acme/site#7");
    expect(stored?.doc.lastReviewedHead).toBe("abc");
    await d.stop();
  });

  it("does not block the loop while a handler runs, and records a throw as a retryable failure", async () => {
    const { deliveryId } = await seed();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const d = dispatcher(pluginWith(async () => {
      await gate;
      throw new Error("review failed");
    }));
    await d.pollOnce();
    // pollOnce returned while the handler still waits.
    expect((await delivery(deliveryId)).status).toBe("pending");
    release();
    const row = await settled(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("review failed");
    await d.stop();
  });

  it("fails the delivery with a corrective error when plugin handlers are not configured", async () => {
    const { deliveryId } = await seed();
    const d = dispatcher(pluginWith(async () => {}), "none");
    await d.pollOnce();
    const row = await settled(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("Plugin handlers are not configured");
    await d.stop();
  });

  it("aborts running handlers on stop without recording a failure", async () => {
    const { deliveryId } = await seed();
    let aborted = false;
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => { aborted = true; resolve(); }));
      throw new Error("aborted");
    }));
    await d.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    await d.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
    // The row stays open for a later process; the attempt that started counts.
    const row = await delivery(deliveryId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  it("a run whose lease was re-claimed elsewhere writes no outcome over the new run", async () => {
    const { deliveryId } = await seed();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let aborted = false;
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      ctx.signal.addEventListener("abort", () => { aborted = true; });
      await gate;
    }));
    await d.pollOnce();
    // Wait until the run has taken its lease (attempts is written with it).
    for (let i = 0; i < 100 && (await delivery(deliveryId)).attempts === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // Another process re-claims the row after this run's lease lapsed.
    const otherClaim = Date.now() + 123_456;
    await tdb.appDb.update(eventDeliveries).set({ nextAttemptAt: otherClaim }).where(eq(eventDeliveries.id, deliveryId));
    // The next renewal finds the lease gone and aborts the stale run.
    for (let i = 0; i < 100 && !aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 100));
    const row = await delivery(deliveryId);
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt).toBe(otherClaim);
    await d.stop();
  });

  it("a stalled database never makes two renewals race and abandon a run it still owns", async () => {
    const { deliveryId } = await seed();
    let aborted = false;
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      ctx.signal.addEventListener("abort", () => { aborted = true; });
      await new Promise((r) => setTimeout(r, 300));
    }));
    await d.pollOnce();
    for (let i = 0; i < 100 && (await delivery(deliveryId)).attempts === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // An open transaction holds the one database connection for several
    // renewal intervals, so renewal ticks pile up behind it.
    await tdb.appDb.transaction(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    const row = await settled(deliveryId);
    expect(aborted).toBe(false);
    expect(row.status).toBe("delivered");
    await d.stop();
  });

  it("refuses an app token for a service the plugin does not declare", async () => {
    const { deliveryId } = await seed();
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      await ctx.appToken("slack");
    }));
    await d.pollOnce();
    const row = await settled(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("did not declare service slack");
    await d.stop();
  });

  it("skips the delivery when its line is turned off while the handler runs", async () => {
    const { deliveryId } = await seed();
    const host = handlerHost();
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      throw new Error("stopped");
    }), host);
    await d.pollOnce();
    await tdb.appDb.update(eventSubscriptions).set({ enabled: false });
    const row = await settled(deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.lastError).toContain("turned off");
    // The run's children stop with it.
    expect(host.stopDeliveryChildren).toHaveBeenCalledWith([deliveryId]);
    await d.stop();
  });

  it("stops the children of a delivery waiting to retry when its line is turned off", async () => {
    const { deliveryId } = await seed({ attempts: 1 });
    await tdb.appDb.update(eventSubscriptions).set({ enabled: false });
    const host = handlerHost();
    const handle = vi.fn(async () => {});
    const d = dispatcher(pluginWith(handle), host);
    await d.pollOnce();
    expect((await settled(deliveryId)).status).toBe("skipped");
    expect(handle).not.toHaveBeenCalled();
    expect(host.stopDeliveryChildren).toHaveBeenCalledWith([deliveryId]);
    await d.stop();
  });

  it("skips, not delivers, when a handler that ignores the signal returns after its line was turned off", async () => {
    const { deliveryId } = await seed();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let aborted = false;
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      ctx.signal.addEventListener("abort", () => { aborted = true; });
      await gate;
    }));
    await d.pollOnce();
    await tdb.appDb.update(eventSubscriptions).set({ enabled: false });
    for (let i = 0; i < 100 && !aborted; i++) await new Promise((r) => setTimeout(r, 10));
    release();
    const row = await settled(deliveryId);
    expect(row.status).toBe("skipped");
    await d.stop();
  });

  it("marks a delivery dead when its handler never finished across every attempt", async () => {
    const { deliveryId } = await seed({ attempts: 5 });
    const handle = vi.fn(async () => {});
    const d = dispatcher(pluginWith(handle));
    await d.pollOnce();
    const row = await settled(deliveryId);
    expect(row.status).toBe("dead");
    expect(handle).not.toHaveBeenCalled();
    await d.stop();
  });
  describe("line settings", () => {
    const schema = Type.Object({ instructions: Type.Optional(Type.String()), minSeverity: Type.String({ default: "low" }) });

    it("hands the handler its line's settings with defaults filled in", async () => {
      const { deliveryId } = await seed({ config: { instructions: "Check auth." } });
      let config: Record<string, unknown> | undefined;
      const d = dispatcher(pluginWith(async (_event, ctx) => { config = ctx.config; }, { configSchema: schema }));
      await d.pollOnce();
      expect((await settled(deliveryId)).status).toBe("delivered");
      expect(config).toEqual({ instructions: "Check auth.", minSeverity: "low" });
      await d.stop();
    });

    it("fails the delivery when the saved settings no longer match the handler's schema", async () => {
      const { deliveryId } = await seed({ config: { minSeverity: 3 } });
      const handle = vi.fn(async () => {});
      const d = dispatcher(pluginWith(handle, { configSchema: schema }));
      await d.pollOnce();
      const row = await settled(deliveryId);
      expect(row.status).toBe("failed");
      expect(row.lastError).toContain("This line's settings do not match reviewer/review: /minSeverity");
      expect(handle).not.toHaveBeenCalled();
      await d.stop();
    });
  });

  describe("supersede", () => {
    /** A handler that blocks until released, recording each run's event and cancel signal. */
    function gatedHandler() {
      const runs: { eventId: string; signal: AbortSignal; cancelChildren: AbortSignal | undefined }[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const scopes: PluginThreadsScope[] = [];
      const host: PluginHandlerHost = { ...handlerHost(), threads: (scope) => { scopes.push(scope); return noThreads; } };
      const handle: PluginEventHandler["handle"] = async (event, ctx) => {
        runs.push({ eventId: event.id, signal: ctx.signal, cancelChildren: scopes.at(-1)?.cancelChildren });
        await Promise.race([gate, new Promise((r) => ctx.signal.addEventListener("abort", r))]);
      };
      return { runs, host, handle, release: () => release() };
    }

    it("skips an older pending delivery and aborts an older run in this process, stopping its children", async () => {
      const now = Date.now();
      const first = await seed({ occurredAt: now - 30_000 });
      const { runs, host, handle, release } = gatedHandler();
      const d = dispatcher(pluginWith(handle, { concurrency: "supersede" }), host);
      await d.pollOnce();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      // A queued older event that has not run yet, and a newer push.
      const queued = await seed({ subscriptionId: first.subscriptionId, occurredAt: now - 20_000 });
      const newer = await seed({ subscriptionId: first.subscriptionId, occurredAt: now - 10_000 });
      // Only the newer delivery is due: the queued one waits behind it.
      await tdb.appDb.update(eventDeliveries).set({ nextAttemptAt: now + 600_000 }).where(eq(eventDeliveries.id, queued.deliveryId));
      await d.pollOnce();
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[0]?.signal.aborted).toBe(true);
      expect(runs[0]?.cancelChildren?.aborted).toBe(true);
      release();
      expect((await settled(newer.deliveryId)).status).toBe("delivered");
      for (const id of [first.deliveryId, queued.deliveryId]) {
        const row = await delivery(id);
        expect(row.status).toBe("skipped");
        expect(row.lastError).toBe("A newer event for acme/site#7 superseded this one.");
      }
      // Children stop for both, including the queued delivery no run holds.
      const stopped = vi.mocked(host.stopDeliveryChildren).mock.calls.flatMap(([ids]) => ids);
      expect(new Set(stopped)).toEqual(new Set([first.deliveryId, queued.deliveryId]));
      await d.stop();
    });

    it("never lets a repo-level event supersede a pull request's delivery, or the reverse", async () => {
      const now = Date.now();
      const prRun = await seed({ occurredAt: now - 20_000 });
      const { runs, host, handle, release } = gatedHandler();
      const d = dispatcher(pluginWith(handle, { concurrency: "supersede" }), host);
      await d.pollOnce();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      // A newer repo-level event (a check suite on main) arrives while the PR run is live.
      const repoEvent = await seed({ subscriptionId: prRun.subscriptionId, occurredAt: now - 10_000, pr: null });
      await d.pollOnce();
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[0]?.signal.aborted).toBe(false);
      release();
      expect((await settled(prRun.deliveryId)).status).toBe("delivered");
      expect((await settled(repoEvent.deliveryId)).status).toBe("delivered");
      expect(host.stopDeliveryChildren).not.toHaveBeenCalled();
      await d.stop();
    });

    it("breaks a same-second tie by receive time", async () => {
      const now = Date.now();
      const occurredAt = now - 10_000;
      const earlier = await seed({ occurredAt, receivedAt: now - 2_000 });
      const later = await seed({ subscriptionId: earlier.subscriptionId, occurredAt, receivedAt: now - 1_000 });
      const handle = vi.fn(async () => {});
      const d = dispatcher(pluginWith(handle, { concurrency: "supersede" }));
      await d.pollOnce();
      expect((await settled(later.deliveryId)).status).toBe("delivered");
      expect((await settled(earlier.deliveryId)).status).toBe("skipped");
      await d.stop();
    });

    it("skips a late older delivery when a newer event for the subject already ran", async () => {
      const now = Date.now();
      const newer = await seed({ occurredAt: now - 10_000, status: "delivered" });
      const older = await seed({ subscriptionId: newer.subscriptionId, occurredAt: now - 20_000 });
      const handle = vi.fn(async () => {});
      const d = dispatcher(pluginWith(handle, { concurrency: "supersede" }));
      await d.pollOnce();
      expect((await settled(older.deliveryId)).status).toBe("skipped");
      expect(handle).not.toHaveBeenCalled();
      await d.stop();
    });

    it("stops a run in another process at its next renewal, without writing an outcome", async () => {
      const { deliveryId } = await seed();
      const { runs, host, handle, release } = gatedHandler();
      const d = dispatcher(pluginWith(handle, { concurrency: "supersede" }), host);
      await d.pollOnce();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      // What a superseding run in another process writes.
      await tdb.appDb.update(eventDeliveries).set({ status: "skipped", lastError: "A newer event for acme/site#7 superseded this one." })
        .where(eq(eventDeliveries.id, deliveryId));
      await vi.waitFor(() => expect(runs[0]?.signal.aborted).toBe(true));
      expect(runs[0]?.cancelChildren?.aborted).toBe(true);
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect((await delivery(deliveryId)).lastError).toBe("A newer event for acme/site#7 superseded this one.");
      await d.stop();
    });

    it("runs every delivery for a parallel handler, and other subjects for a supersede handler", async () => {
      const now = Date.now();
      const a = await seed({ occurredAt: now - 20_000 });
      const b = await seed({ subscriptionId: a.subscriptionId, occurredAt: now - 10_000, pr: "8" });
      const handle = vi.fn(async () => {});
      const d = dispatcher(pluginWith(handle, { concurrency: "supersede" }));
      await d.pollOnce();
      expect((await settled(a.deliveryId)).status).toBe("delivered");
      expect((await settled(b.deliveryId)).status).toBe("delivered");
      await d.stop();

      const c = await seed({ occurredAt: now - 20_000 });
      const e = await seed({ subscriptionId: c.subscriptionId, occurredAt: now - 10_000 });
      const d2 = dispatcher(pluginWith(handle));
      await d2.pollOnce();
      expect((await settled(c.deliveryId)).status).toBe("delivered");
      expect((await settled(e.deliveryId)).status).toBe("delivered");
      await d2.stop();
    });
  });
});
