/**
 * Plugin event handlers as a delivery target: the dispatcher runs the
 * handler beside its loop, hands it scoped threads and store, and records
 * the outcome on the delivery row.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PluginEventContext, PluginEventHandler, PluginThreads, ValetPlugin } from "@valet/engine";
import type { RunHost as WorkflowRunHost } from "@valet/workflow";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { eventDeliveries, eventSubscriptions, events } from "../schema/index.js";
import { EventDispatcher, type PluginHandlerHost } from "./dispatcher.js";

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
function pluginWith(handle: PluginEventHandler["handle"]): ValetPlugin {
  return {
    name: "reviewer",
    version: "0.0.1",
    credentials: [{ service: "github", type: "oauth2", configKeys: ["accessToken"] }],
    eventHandlers: [{ id: "review", description: "Review a pull request.", events: ["github.pull_request.*"], handle }],
  };
}

/** Threads that fail if a handler uses them; these tests do not. */
const noThreads: PluginThreads = {
  ensure: async () => { throw new Error("threads are not used in this test"); },
  post: async () => { throw new Error("threads are not used in this test"); },
  spawnChild: async () => { throw new Error("threads are not used in this test"); },
  awaitChild: async () => { throw new Error("threads are not used in this test"); },
  awaitReply: async () => { throw new Error("threads are not used in this test"); },
};

function handlerHost(appToken: PluginHandlerHost["appToken"] = async () => null): PluginHandlerHost {
  return { threads: () => noThreads, appToken, leaseRenewMs: 20 };
}

describe("EventDispatcher plugin target", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  async function seed(opts: { ownerType?: "user" | "team"; ownerId?: string; attempts?: number } = {}) {
    const db = tdb.appDb;
    const now = Date.now();
    const eventId = randomUUID();
    const subscriptionId = randomUUID();
    const deliveryId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: "github",
      eventKey: "github.pull_request.synchronize",
      dedupeKey: randomUUID(),
      actor: null,
      refs: { repo: "acme/site", pr_number: "7", head_sha: "abc" },
      summary: "PR #7 updated",
      payload: { action: "synchronize" },
      occurredAt: now - 5_000,
      receivedAt: now,
      subjects: ["github:acme/site#7"],
    });
    await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType: opts.ownerType ?? "user",
      ownerId: opts.ownerId ?? "user-1",
      name: "review PRs",
      eventKeys: ["github.pull_request.*"],
      filters: [],
      target: { kind: "plugin", plugin: "reviewer", handler: "review" },
      enabled: true,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(eventDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId,
      status: "pending",
      attempts: opts.attempts ?? 0,
      nextAttemptAt: now - 1,
      createdAt: now,
    });
    return { deliveryId, eventId };
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
      plugins: [plugin],
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
    const d = dispatcher(pluginWith(async (_event, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      throw new Error("stopped");
    }));
    await d.pollOnce();
    await tdb.appDb.update(eventSubscriptions).set({ enabled: false });
    const row = await settled(deliveryId);
    expect(row.status).toBe("skipped");
    expect(row.lastError).toContain("turned off");
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
});
