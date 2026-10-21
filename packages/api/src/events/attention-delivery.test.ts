import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { notifications, pendingChannelDeliveries, userNotificationPreferences, workflowRuns, workflowCheckpoints, workflowSignals } from "../schema/index.js";
import { routeAttention as enqueueAttention, type AttentionChannelDeliverer, type AttentionEvent } from "../orchestrator/attention.js";
import { webPresence } from "../services/web-presence.js";
import { ATTENTION_SENDING_TIMEOUT_MS, drainAttentionDeliveries } from "./attention-delivery.js";

let db: AppDb;
const event: AttentionEvent = { kind: "question", owner: { type: "user", id: "u" }, title: "Choose", dedupeKey: "event-1" };
const deliver = vi.fn(async () => {});
const tier: AttentionChannelDeliverer = { id: "dm", order: 1, grace: "when-web-active", deliver };

beforeEach(async () => {
  db = (await freshTestPgDb()).appDb;
  deliver.mockClear();
});

async function pending() {
  const [job] = await db.select().from(pendingChannelDeliveries);
  expect(job).toBeDefined();
  return job!;
}

describe("personal attention outbox", () => {
  it("writes the web row now and recovers a due job with fresh dependencies", async () => {
    webPresence(db).report("u", "tab", true);
    const before = Date.now();
    await routeAttention({ db, channels: [tier] }, event);
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
    const job = await pending();
    expect(job.deliverAfter).toBeGreaterThanOrEqual(before + 120_000);
    expect(job.status).toBe("pending");
    await drainAttentionDeliveries({ db, channels: [{ ...tier }] }, job.deliverAfter - 1);
    expect(deliver).not.toHaveBeenCalled();
    // No in-memory job object or timer survives into this new drain invocation.
    await drainAttentionDeliveries({ db, channels: [{ ...tier }] }, job.deliverAfter);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each(["inactive", "web-disabled"])("delivers immediately when %s", async mode => {
    if (mode === "web-disabled") {
      webPresence(db).report("u", "tab", true);
      await db.insert(userNotificationPreferences).values({ userId: "u", kind: event.kind, web: false });
    }
    await routeAttention({ db, channels: [tier] }, event);
    expect(deliver).toHaveBeenCalledOnce();
    expect(await db.select().from(notifications)).toHaveLength(mode === "inactive" ? 1 : 0);
  });

  it.each(["row", "all", "missing"])("drops handled notifications: %s", async mode => {
    webPresence(db).report("u", "tab", true);
    await routeAttention({ db, channels: [tier] }, event);
    const job = await pending();
    if (mode === "missing") await db.delete(notifications);
    else await db.update(notifications).set({ readAt: Date.now() }).where(mode === "row" ? eq(notifications.id, job.notificationId ?? "") : undefined);
    await drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter);
    expect(deliver).not.toHaveBeenCalled();
    expect((await pending()).status).toBe("dropped");
  });

  it.each(["pending", "resolved", "expired", "withdrawn", "missing"])("rechecks an engine gate: %s", async status => {
    const gated: AttentionEvent = { ...event, kind: "approval", sessionId: "s", gate: { id: "g", actions: [] } };
    if (status !== "missing") {
      await db.execute(sql`INSERT INTO engine_decision_gates (id, session_id, thread_id, queue_item_id, resume_key, ordinal, type, status, title, body, actions, created_at, updated_at)
        VALUES ('g', 's', 't', 'q', 'resume', 0, 'tool_approval', ${status}, 'Approve', '', '[]', 1, 1)`);
    }
    webPresence(db).report("u", "tab", true);
    await routeAttention({ db, channels: [tier] }, gated);
    const job = await pending();
    await drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter);
    expect(deliver).toHaveBeenCalledTimes(status === "pending" ? 1 : 0);
  });

  it("deduplicates producer replay, concurrent drains, and later passes", async () => {
    webPresence(db).report("u", "tab", true);
    await routeAttention({ db, channels: [tier] }, event);
    await routeAttention({ db, channels: [tier] }, event);
    expect(await db.select().from(pendingChannelDeliveries)).toHaveLength(1);
    const job = await pending();
    await Promise.all([drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter), drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter)]);
    await routeAttention({ db, channels: [tier] }, event);
    await drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("uses ordered tiers and the user's grace", async () => {
    webPresence(db).report("u", "tab", true);
    await db.insert(userNotificationPreferences).values({ userId: "u", kind: event.kind, channelGraceSeconds: 10 });
    await routeAttention({ db, channels: [{ ...tier, id: "push", order: 2 }, tier] }, event);
    const jobs = await db.select().from(pendingChannelDeliveries);
    expect(jobs.find(job => job.tierId === "push")!.deliverAfter - jobs.find(job => job.tierId === "dm")!.deliverAfter).toBe(10_000);
  });

  it("keeps an unknown tier pending until its deliverer returns", async () => {
    webPresence(db).report("u", "tab", true);
    await routeAttention({ db, channels: [tier] }, event);
    const job = await pending();
    await drainAttentionDeliveries({ db, channels: [] }, job.deliverAfter);
    expect((await pending()).status).toBe("pending");
    await drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter);
    expect(deliver).toHaveBeenCalledOnce();
  });
});


describe("sending recovery", () => {
  it.each(["found", "missing", "failed", "unsupported"])("reconciles stale sending before retry: %s", async result => {
    const refs = [{ channelType: "slack", conversationKey: "slack:T:D:123.4", channelId: "D", messageId: "123.4" }];
    const reconcile = vi.fn(async () => {
      if (result === "failed") throw new Error("lookup failed");
      return result === "found" ? refs : undefined;
    });
    const send = vi.fn(async () => refs);
    const channel: AttentionChannelDeliverer = { ...tier, deliver: send, ...(result === "unsupported" ? {} : { reconcile }) };
    await db.insert(pendingChannelDeliveries).values({
      id: "after-crash", userId: "u", tierId: tier.id, event,
      status: "sending", sendingAt: 1_000, deliverAfter: 1_000 + ATTENTION_SENDING_TIMEOUT_MS,
    });
    await drainAttentionDeliveries({ db, channels: [channel] }, 1_000 + ATTENTION_SENDING_TIMEOUT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await drainAttentionDeliveries({ db, channels: [channel] }, 1_000 + ATTENTION_SENDING_TIMEOUT_MS);
    expect(reconcile).toHaveBeenCalledTimes(result === "unsupported" ? 0 : 1);
    expect(send).toHaveBeenCalledTimes(result === "found" ? 0 : 1);
    expect(await pending()).toMatchObject({ status: "sent", messageRefs: refs, attempts: 1 });
    await drainAttentionDeliveries({ db, channels: [channel] }, 1_000 + 2 * ATTENTION_SENDING_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(result === "found" ? 0 : 1);
  });

  it("persists sending before the provider call and retries a rejected send", async () => {
    const send = vi.fn(async () => {
      expect((await pending()).status).toBe("sending");
      throw new Error("provider unavailable");
    });
    await routeAttention({ db, channels: [{ ...tier, deliver: send }] }, event);
    const job = await pending();
    expect(job.status).toBe("sending");
    expect(job.lastError).toBe("provider unavailable");
    await drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter);
    expect(deliver).toHaveBeenCalledOnce();
    expect((await pending()).status).toBe("sent");
  });
});


describe("workflow gate recheck", () => {
  it.each(["pending", "answered", "settled", "next-occurrence"])("checks the durable approval occurrence: %s", async state => {
    await db.insert(workflowRuns).values({ id: "run", workflowId: "wf", definitionVersionId: "v1", definition: {}, params: {}, updatedAt: 1, ownerType: "user", ownerId: "u", status: state === "settled" ? "settled" : "parked", createdAt: 1 });
    await db.insert(workflowCheckpoints).values({ runId: "run", nodeId: "approve", iteration: 2, status: "intent", attempt: 1, createdAt: 1, effects: { gateId: state === "next-occurrence" ? "new-gate" : "gate" } });
    if (state === "answered") await db.insert(workflowSignals).values({ runId: "run", signalId: "signal", signalType: "approval:approve:2", payload: { gateId: "gate", approved: true }, createdAt: 1 });
    webPresence(db).report("u", "tab", true);
    await routeAttention({ db, channels: [tier] }, { ...event, kind: "approval", workflowGate: { runId: "run", nodeId: "approve", iteration: 2, gateId: "gate" } });
    const job = await pending();
    await drainAttentionDeliveries({ db, channels: [tier] }, job.deliverAfter);
    expect(deliver).toHaveBeenCalledTimes(state === "pending" ? 1 : 0);
  });

  it("gives transports in one tier the same deadline", async () => {
    webPresence(db).report("u", "tab", true);
    await routeAttention({ db, channels: [tier, { ...tier, id: "other-dm" }] }, event);
    const jobs = await db.select().from(pendingChannelDeliveries);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.deliverAfter).toBe(jobs[1]?.deliverAfter);
  });
});


describe("provider outage scheduling", () => {
  it("backs off repeated failures without losing a pending job", async () => {
    const send = vi.fn(async () => { throw new Error("provider unavailable"); });
    const channels = [{ ...tier, deliver: send }];
    await routeAttention({ db, channels }, { ...event, kind: "approval" });
    for (const delay of [240_000, 480_000, 960_000, 1_800_000, 1_800_000]) {
      const job = await pending();
      await drainAttentionDeliveries({ db, channels }, job.deliverAfter);
      const retry = await pending();
      expect(retry.status).toBe("sending");
      expect(retry.deliverAfter - job.deliverAfter).toBeGreaterThanOrEqual(delay);
      expect(retry.deliverAfter - job.deliverAfter).toBeLessThan(delay + 1_000);
    }
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("serves new approvals ahead of a backlog of failed jobs", async () => {
    await db.insert(pendingChannelDeliveries).values(Array.from({ length: 25 }, (_, n) => ({
      id: `old-${n}`, userId: "u", tierId: tier.id, event, status: "sending" as const, attempts: 10, sendingAt: 0, deliverAfter: 1,
    })));
    await db.insert(pendingChannelDeliveries).values({ id: "fresh", userId: "u", tierId: tier.id, event: { ...event, title: "Fresh approval", kind: "approval" }, deliverAfter: 2 });
    await drainAttentionDeliveries({ db, channels: [tier] }, 3);
    expect(deliver.mock.calls).toHaveLength(20);
    const [fresh] = await db.select().from(pendingChannelDeliveries).where(eq(pendingChannelDeliveries.id, "fresh"));
    expect(fresh?.status).toBe("sent");
  });
});

/** Flush detached sends only when this test needs their outcome. */
async function routeAttention(...args: Parameters<typeof enqueueAttention>): Promise<void> {
  await enqueueAttention(...args);
  await drainAttentionDeliveries(args[0]);
}


describe("isolated delivery execution", () => {
  it("returns after durable insertion while an immediate provider is blocked", async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(() => blocked);
    const deps = { db, channels: [{ ...tier, deliver: send }] };
    try {
      await enqueueAttention(deps, event);
      expect(await db.select().from(notifications)).toHaveLength(1);
      expect(await db.select().from(pendingChannelDeliveries)).toHaveLength(1);
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect((await pending()).status).toBe("sending");
    } finally {
      release();
      await drainAttentionDeliveries(deps);
    }
  });

  it("keeps a slow transport out of other transports' later batches", async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const slow = vi.fn(() => blocked);
    const fast = vi.fn(async () => {});
    const deps = { db, channels: [{ ...tier, id: "slack", deliver: slow }, { ...tier, id: "telegram", deliver: fast }] };
    await db.insert(pendingChannelDeliveries).values([
      { id: "slow", userId: "u", tierId: "slack", event, deliverAfter: 1 },
      { id: "fast", userId: "u", tierId: "telegram", event, deliverAfter: 1 },
    ]);
    const first = drainAttentionDeliveries(deps);
    let second: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(fast).toHaveBeenCalledOnce());
      await vi.waitFor(async () => {
        const [job] = await db.select().from(pendingChannelDeliveries).where(eq(pendingChannelDeliveries.id, "fast"));
        expect(job?.status).toBe("sent");
      });
      await db.insert(pendingChannelDeliveries).values({ id: "later", userId: "u", tierId: "telegram", event, deliverAfter: 1 });
      second = drainAttentionDeliveries(deps);
      await vi.waitFor(() => expect(fast).toHaveBeenCalledTimes(2));
      expect(slow).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });

  it("bounds concurrency and stamps leases when each row is claimed", async () => {
    await db.insert(pendingChannelDeliveries).values(Array.from({ length: 5 }, (_, n) => ({
      id: `claim-${n}`, userId: "u", tierId: tier.id, event, deliverAfter: 1,
    })));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let peak = 0;
    const send = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await blocked;
      active--;
    });
    const work = drainAttentionDeliveries({ db, channels: [{ ...tier, deliver: send }] }, 1_000);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
      clock.mockReturnValue(500_000);
      release();
      await work;
      expect(peak).toBe(4);
      const jobs = await db.select().from(pendingChannelDeliveries);
      const later = jobs.find(job => job.sendingAt === 500_000);
      expect(later?.deliverAfter).toBe(500_000 + ATTENTION_SENDING_TIMEOUT_MS);
    } finally {
      release();
      await work;
      clock.mockRestore();
    }
  });

  it("waits for channel startup without spending an attempt", async () => {
    await db.insert(pendingChannelDeliveries).values({ id: "boot", userId: "u", tierId: tier.id, event, deliverAfter: 1 });
    let ready = false;
    const deps = { db, channels: [{ ...tier, ready: () => ready }] };
    await drainAttentionDeliveries(deps);
    expect(await pending()).toMatchObject({ status: "pending", attempts: 0 });
    ready = true;
    await drainAttentionDeliveries(deps);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("scrubs terminal payloads while preserving dedupe keys and provider refs", async () => {
    const refs = [{ channelType: "slack", conversationKey: "dm", messageId: "1" }];
    await db.insert(pendingChannelDeliveries).values([
      { id: "old-sent", userId: "u", tierId: tier.id, event, deliverAfter: 1, status: "sent", messageRefs: refs },
      { id: "old-dropped", userId: "u", tierId: tier.id, event, deliverAfter: 1, status: "dropped" },
    ]);
    await routeAttention({ db, channels: [{ ...tier, deliver: async () => refs }] }, event);
    const jobs = await db.select().from(pendingChannelDeliveries);
    expect(jobs).toHaveLength(3);
    expect(jobs.every(job => job.event === null)).toBe(true);
    expect(jobs.find(job => job.id === "old-sent")?.messageRefs).toEqual(refs);
    await routeAttention({ db, channels: [tier] }, event);
    expect(deliver).not.toHaveBeenCalled();
  });
});
