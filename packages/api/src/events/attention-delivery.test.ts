import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { notifications, pendingChannelDeliveries, userNotificationPreferences, workflowRuns, workflowCheckpoints, workflowSignals } from "../schema/index.js";
import { routeAttention, type AttentionChannelDeliverer, type AttentionEvent } from "../orchestrator/attention.js";
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
