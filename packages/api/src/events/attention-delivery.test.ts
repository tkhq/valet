import { ChannelDeliveryRejectedError, InMemoryCredentialStore } from "@valet/engine";
import * as attention from "../orchestrator/attention.js";
import * as deliveryMetrics from "../observability/delivery-metrics.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { notifications, pendingChannelDeliveries, userNotificationPreferences, workflowRuns, workflowCheckpoints, workflowSignals, teams, teamMembers, orgMembers, slackChannelPrivacy, userIdentityLinks } from "../schema/index.js";
import { routeAttention as enqueueAttention, type AttentionChannelDeliverer, type AttentionEvent } from "../orchestrator/attention.js";
import { resetThreadAccessCache } from "../services/thread-access.js";
import { webPresence } from "../services/web-presence.js";
import { ATTENTION_BATCH_TIMEOUT_MS, ATTENTION_IMMEDIATE_GATE_GRACE_MS, ATTENTION_SENDING_TIMEOUT_MS, ATTENTION_STARTUP_GRACE_MS, drainAttentionDeliveries } from "./attention-delivery.js";

let db: AppDb;
const event: AttentionEvent = { kind: "question", owner: { type: "user", id: "u" }, title: "Choose", dedupeKey: "event-1" };
const deliver = vi.fn(async () => {});
const tier: AttentionChannelDeliverer = { id: "dm", order: 1, grace: "when-web-active", deliver };

beforeEach(async () => {
  db = (await freshTestPgDb()).appDb;
  deliver.mockClear();
  resetThreadAccessCache();
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

  it.each(["read", "gate-resolved", "link-off", "team-dm-off", "still-active"])("checks local state before a failing audience lookup: %s", async condition => {
    const gated: AttentionEvent = { ...event, owner: { type: "team", id: "team" }, sessionId: "s", gate: { id: "g", actions: [] } };
    await db.execute(sql`INSERT INTO engine_decision_gates (id, session_id, thread_id, queue_item_id, resume_key, ordinal, type, status, title, body, actions, created_at, updated_at)
      VALUES ('g', 's', 't', 'q', 'resume', 0, 'tool_approval', ${condition === "gate-resolved" ? "resolved" : "pending"}, 'Approve', '', '[]', 1, 1)`);
    await db.insert(notifications).values({ id: "local-terminal", userId: "u", kind: event.kind, urgency: "normal", title: "Choose", createdAt: 1, readAt: condition === "read" ? 2 : null });
    await db.insert(userNotificationPreferences).values({ userId: "u", kind: event.kind, teamDm: condition !== "team-dm-off" });
    await db.insert(pendingChannelDeliveries).values({ id: "terminal-test", userId: "u", tierId: tier.id, event: gated, notificationId: "local-terminal", deliverAfter: 1 });
    const lookup = vi.spyOn(attention, "attentionRecipientAllowed").mockRejectedValue(new Error("Slack membership lookup failed"));
    const failure = vi.spyOn(deliveryMetrics, "recordAttentionDeliveryFailure");
    try {
      await drainAttentionDeliveries({ db, channels: [{ ...tier, recipientEnabled: async () => condition !== "link-off" }] });
      if (condition === "still-active") {
        expect(lookup).toHaveBeenCalledOnce();
        expect(await pending()).toMatchObject({ status: "sending", lastError: "Slack membership lookup failed" });
        expect(failure).toHaveBeenCalledWith(false);
      } else {
        expect(lookup).not.toHaveBeenCalled();
        expect(await pending()).toMatchObject({ status: "dropped", event: null, lastError: null });
        expect(failure).not.toHaveBeenCalled();
      }
      expect(deliver).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); failure.mockRestore(); }
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
    expect((await pending()).deliveryToken).toBe(job.deliveryToken);
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

  it("retains the first unreconciled send time across a failed readiness claim", async () => {
    const firstSend = 1_000;
    const intermediate = Date.now();
    await db.insert(pendingChannelDeliveries).values({ id: "landed-before-crash", userId: "u", tierId: tier.id, event, status: "sending", sendingAt: firstSend, deliverAfter: 1 });
    let ready = false;
    const ref = [{ channelType: "slack", conversationKey: "dm", messageId: "landed" }];
    const reconcile = vi.fn(async (_user: string, _event: AttentionEvent, attempt: { sendingAt: number; deliveryId: string }) => attempt.sendingAt === firstSend ? ref : undefined);
    const channel = { ...tier, ready: () => ready, reconcile };
    const deps = { db, channels: [channel] };
    await drainAttentionDeliveries(deps, intermediate);
    await drainAttentionDeliveries(deps, intermediate + ATTENTION_STARTUP_GRACE_MS);
    const failed = await pending();
    expect(failed).toMatchObject({ firstSendingAt: firstSend, attempts: 1, status: "sending" });
    expect(failed.sendingAt).toBeGreaterThan(firstSend);
    ready = true;
    await drainAttentionDeliveries(deps, failed.deliverAfter);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[2].deliveryId).toBe(failed.deliveryToken);
    expect(deliver).not.toHaveBeenCalled();
    expect(await pending()).toMatchObject({ status: "sent", firstSendingAt: firstSend, messageRefs: ref });
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

  it.each(["bot_blocked", "user_deactivated", "user_not_found", "cannot_dm_bot", "channel_not_found"])("drops a definite %s rejection on the first drain", async reason => {
    const channel = reason === "bot_blocked" || reason === "user_deactivated" ? "telegram" : "slack";
    const rejected = vi.spyOn(deliveryMetrics, "recordAttentionDeliveryRejected");
    const failure = vi.spyOn(deliveryMetrics, "recordAttentionDeliveryFailure");
    try {
      await db.insert(userNotificationPreferences).values({ userId: "u", kind: "notification", web: false });
      const send = vi.fn(async () => { throw new AggregateError([new ChannelDeliveryRejectedError(channel, reason)]); });
      const deps = { db, channels: [{ ...tier, deliver: send }] };
      await routeAttention(deps, { ...event, kind: "notification" });
      expect(await pending()).toMatchObject({ status: "dropped", attempts: 1, event: null, lastError: null });
      expect(rejected).toHaveBeenCalledWith(channel, reason);
      expect(failure).not.toHaveBeenCalled();
      await drainAttentionDeliveries(deps, Date.now() + 86_400_000);
      expect(send).toHaveBeenCalledOnce();
    } finally { rejected.mockRestore(); failure.mockRestore(); }
  });

  it("retries mixed permanent and transient failures instead of dropping uncertain sends", async () => {
    const send = vi.fn(async () => { throw new AggregateError([new ChannelDeliveryRejectedError("slack", "user_not_found"), new Error("provider unavailable")]); });
    await routeAttention({ db, channels: [{ ...tier, deliver: send }] }, event);
    expect(await pending()).toMatchObject({ status: "sending", attempts: 1 });
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

  it("releases a tier after a batch deadline and prevents its abandoned workers claiming more jobs", async () => {
    await db.insert(pendingChannelDeliveries).values(Array.from({ length: 5 }, (_, n) => ({ id: `hung-${n}`, userId: "u", tierId: tier.id, event, deliverAfter: 1 })));
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let started = () => {};
    const allStarted = new Promise<void>(resolve => { started = resolve; });
    const send = vi.fn(async () => { if (send.mock.calls.length === 4) started(); await blocked; });
    const failure = vi.spyOn(deliveryMetrics, "recordAttentionDeliveryFailure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = drainAttentionDeliveries({ db, channels: [{ ...tier, deliver: send }] });
    try {
      await allStarted;
      await vi.advanceTimersByTimeAsync(ATTENTION_BATCH_TIMEOUT_MS);
      await work;
      expect(failure).toHaveBeenCalledWith(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
      const jobs = await db.select().from(pendingChannelDeliveries);
      expect(jobs.filter(job => job.status === "sending")).toHaveLength(4);
      expect(jobs.filter(job => job.status === "pending")).toHaveLength(1);
      await drainAttentionDeliveries({ db, channels: [tier] });
      expect(deliver).toHaveBeenCalledOnce();
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(4);
    } finally { release(); vi.useRealTimers(); failure.mockRestore(); log.mockRestore(); }
  });

  it("contains the second claim failure, retains re-drains, and never exceeds four sends", async () => {
    await db.insert(pendingChannelDeliveries).values(Array.from({ length: 10 }, (_, n) => ({ id: `claim-failure-${n}`, userId: "u", tierId: tier.id, event, deliverAfter: 1 })));
    await db.execute(sql`CREATE SEQUENCE attention_claim_count`);
    await db.execute(sql`CREATE FUNCTION fail_second_attention_claim() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'sending' AND NEW.attempts = 1 AND nextval('attention_claim_count') = 2 THEN
          RAISE EXCEPTION 'second claim failed';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER attention_claim_failure BEFORE UPDATE ON pending_channel_deliveries FOR EACH ROW EXECUTE FUNCTION fail_second_attention_claim()`);
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let active = 0; let peak = 0;
    const send = vi.fn(async () => { active++; peak = Math.max(peak, active); await blocked; active--; });
    const deps = { db, channels: [{ ...tier, deliver: send }] };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const work = drainAttentionDeliveries(deps);
    let queued: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
      queued = drainAttentionDeliveries(deps);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(active).toBe(4);
      expect(peak).toBe(4);
      release();
      await Promise.all([work, queued]);
      expect(peak).toBe(4);
      expect(send).toHaveBeenCalledTimes(10);
      expect((await db.select().from(pendingChannelDeliveries)).every(row => row.status === "sent")).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.any(Error));
    } finally {
      release(); await Promise.all([work, queued]); log.mockRestore();
      await db.execute(sql`DROP TRIGGER attention_claim_failure ON pending_channel_deliveries`);
      await db.execute(sql`DROP FUNCTION fail_second_attention_claim()`);
      await db.execute(sql`DROP SEQUENCE attention_claim_count`);
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
    await routeAttention({ db, channels: [{ ...tier, deliver: async () => refs }] }, event);
    const jobs = await db.select().from(pendingChannelDeliveries);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ event: null, status: "sent", messageRefs: refs });
    await routeAttention({ db, channels: [tier] }, event);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("counts failed readiness after startup grace, including recovery failures", async () => {
    const failure = vi.spyOn(deliveryMetrics, "recordAttentionDeliveryFailure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.insert(pendingChannelDeliveries).values({ id: "unready", userId: "u", tierId: tier.id, event, deliverAfter: 1 });
      const deps = { db, channels: [{ ...tier, ready: () => false }] };
      for (let n = 0; n < 5; n++) await drainAttentionDeliveries(deps, 1_000 + n);
      expect(await pending()).toMatchObject({ status: "pending", attempts: 0 });
      expect(failure).not.toHaveBeenCalled();
      await drainAttentionDeliveries(deps, 1_000 + ATTENTION_STARTUP_GRACE_MS);
      expect(await pending()).toMatchObject({ status: "sending", attempts: 1, lastError: expect.stringContaining("not ready") });
      await drainAttentionDeliveries(deps, (await pending()).deliverAfter);
      expect((await pending()).attempts).toBe(2);
      expect(failure.mock.calls).toEqual([[false], [true]]);
      expect(deliver).not.toHaveBeenCalled();
    } finally { failure.mockRestore(); log.mockRestore(); }
  });

  it.each([false, true])("re-drains new jobs after a running batch, immediate IDs: %s", async immediate => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await blocked; });
    const deps = { db, channels: [{ ...tier, deliver: send }] };
    await db.insert(pendingChannelDeliveries).values({ id: "first", userId: "u", tierId: tier.id, event, deliverAfter: 1 });
    const first = drainAttentionDeliveries(deps);
    let second: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await db.insert(pendingChannelDeliveries).values({ id: "later", userId: "u", tierId: tier.id, event, deliverAfter: 1 });
      second = drainAttentionDeliveries(deps, Date.now(), immediate ? ["later"] : undefined);
      release();
      await Promise.all([first, second]);
      expect(send).toHaveBeenCalledTimes(2);
      expect((await db.select().from(pendingChannelDeliveries)).every(job => job.status === "sent")).toBe(true);
    } finally { release(); await Promise.all([first, second]); }
  });

  it("rechecks a workflow approval that settles while its immediate request waits behind a batch", async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await blocked; });
    const deps = { db, channels: [{ ...tier, deliver: send }] };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await db.insert(workflowRuns).values({ id: "waiting-run", workflowId: "wf", definitionVersionId: "v1", definition: {}, params: {}, updatedAt: now, ownerType: "user", ownerId: "u", status: "parked", createdAt: now });
    await db.insert(pendingChannelDeliveries).values({ id: "first", userId: "u", tierId: tier.id, event, deliverAfter: 1 });
    const first = drainAttentionDeliveries(deps);
    let immediate: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      // No web row exists: only the durable workflow state can suppress this notification.
      await db.insert(pendingChannelDeliveries).values({ id: "settled-while-waiting", userId: "u", tierId: tier.id, createdAt: now,
        event: { ...event, kind: "approval", workflowGate: { runId: "waiting-run", nodeId: "approve", iteration: 0 } }, deliverAfter: now });
      immediate = drainAttentionDeliveries(deps, now, ["settled-while-waiting"]);
      await db.update(workflowRuns).set({ status: "settled" }).where(eq(workflowRuns.id, "waiting-run"));
      clock.mockReturnValue(now + ATTENTION_IMMEDIATE_GATE_GRACE_MS + 1);
      release();
      await Promise.all([first, immediate]);
      expect(send).toHaveBeenCalledOnce();
      const [job] = await db.select().from(pendingChannelDeliveries).where(eq(pendingChannelDeliveries.id, "settled-while-waiting"));
      expect(job).toMatchObject({ status: "dropped", event: null });
    } finally { release(); await Promise.all([first, immediate]); clock.mockRestore(); }
  });

  it("keeps immediate gate events trusted when a full rail request also queues a re-drain", async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await blocked; });
    const deps = { db, channels: [{ ...tier, deliver: send }] };
    await db.insert(pendingChannelDeliveries).values({ id: "first", userId: "u", tierId: tier.id, event, deliverAfter: 1 });
    const first = drainAttentionDeliveries(deps);
    let rail: Promise<void> | undefined;
    let immediate: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await db.insert(pendingChannelDeliveries).values({ id: "parking", userId: "u", tierId: tier.id,
        event: { ...event, workflowGate: { runId: "not-yet-parked", nodeId: "approve", iteration: 0 } }, deliverAfter: 1 });
      rail = drainAttentionDeliveries(deps);
      immediate = drainAttentionDeliveries(deps, Date.now(), ["parking"]);
      release();
      await Promise.all([first, rail, immediate]);
      expect(send).toHaveBeenCalledTimes(2);
      const [job] = await db.select().from(pendingChannelDeliveries).where(eq(pendingChannelDeliveries.id, "parking"));
      expect(job?.status).toBe("sent");
    } finally { release(); await Promise.all([first, rail, immediate]); }
  });

  it("drops a JSON-null event without rejecting other rows", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.insert(pendingChannelDeliveries).values([
        { id: "corrupt", userId: "u", tierId: tier.id, event: sql`'null'::jsonb`, deliverAfter: 1 },
        { id: "valid", userId: "u", tierId: tier.id, event, deliverAfter: 1 },
      ]);
      await drainAttentionDeliveries({ db, channels: [tier] });
      const jobs = await db.select().from(pendingChannelDeliveries);
      expect(jobs.find(job => job.id === "corrupt")?.status).toBe("dropped");
      expect(jobs.find(job => job.id === "valid")?.status).toBe("sent");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
    } finally { log.mockRestore(); }
  });
});


describe("outbox authorization dependencies", () => {
  async function privateApproval() {
    const engineCredentials = new InMemoryCredentialStore();
    await engineCredentials.save({ type: "org", id: "o" }, "slack", { type: "oauth2", accessToken: "test-bot" });
    await db.insert(teams).values({ id: "private-team", orgId: "o", name: "Private", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: "private-team", userId: "u", role: "admin" });
    await db.insert(orgMembers).values({ orgId: "o", userId: "u", role: "admin" });
    await db.insert(userIdentityLinks).values({ id: "slack-u", provider: "slack", externalId: "UMEMBER", userId: "u", createdAt: 1 });
    await db.insert(slackChannelPrivacy).values({ orgId: "o", channelId: "CPRIVATE", isPrivate: true, checkedAt: Date.now() });
    await db.insert(userNotificationPreferences).values({ userId: "u", kind: "approval", web: false, teamDm: true });
    await db.execute(sql`INSERT INTO engine_decision_gates (id, session_id, thread_id, queue_item_id, resume_key, ordinal, type, status, title, body, actions, created_at, updated_at)
      VALUES ('private-gate', 's', 't', 'q', 'resume', 0, 'tool_approval', 'pending', 'Approve', '', '[]', 1, 1)`);
    const approval: AttentionEvent = { kind: "approval", owner: { type: "team", id: "private-team" }, title: "Private approval", audienceKey: "slack:CPRIVATE:1.1", sessionId: "s", gate: { id: "private-gate", actions: [] } };
    return { access: { engineCredentials }, approval };
  }

  function slackMembership(allowed = true) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = url.pathname.endsWith("conversations.members") ? { ok: true, members: allowed ? ["UMEMBER"] : [] }
        : { ok: true, channel: { is_private: true } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
  }

  it("keeps shared team notifications independent of remote authorization providers", async () => {
    const { approval } = await privateApproval();
    await db.insert(pendingChannelDeliveries).values({ id: "shared-team", userId: "u", tierId: tier.id, event: { ...approval, audienceKey: "web:default" }, deliverAfter: 1 });
    await drainAttentionDeliveries({ db, channels: [tier] });
    expect(await pending()).toMatchObject({ status: "sent" });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("delivers only this recipient even when another member's membership lookup is rate-limited", async () => {
    const { access, approval } = await privateApproval();
    for (const userId of ["other-1", "other-2", "other-3", "other-4"]) {
      await db.insert(teamMembers).values({ teamId: "private-team", userId, role: "member" });
      await db.insert(orgMembers).values({ orgId: "o", userId, role: "member" });
      await db.insert(userIdentityLinks).values({ id: userId, provider: "slack", externalId: userId, userId, createdAt: 1 });
    }
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith("conversations.members")
        ? url.searchParams.has("cursor") ? { ok: false, error: "ratelimited" }
          : { ok: true, members: ["UMEMBER"], response_metadata: { next_cursor: "other-members" } }
        : { ok: true, channel: { is_private: true } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    try {
      await db.insert(pendingChannelDeliveries).values({ id: "recipient-only", userId: "u", tierId: tier.id, event: approval, deliverAfter: 1 });
      await drainAttentionDeliveries({ db, channels: [tier], access });
      expect(await pending()).toMatchObject({ status: "sent", lastError: null });
      expect(deliver).toHaveBeenCalledOnce();
      expect(fetch.mock.calls.filter(([input]) => String(input).includes("conversations.members"))).toHaveLength(1);
      expect(fetch.mock.calls.some(([input]) => String(input).includes("cursor="))).toBe(false);
    } finally { fetch.mockRestore(); resetThreadAccessCache(); }
  });

  it.each(["access-first", "access-last", "running-access"])("retains private-channel access when merging queued drains: %s", async order => {
    const { access, approval } = await privateApproval();
    const fetch = slackMembership();
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async (_userId: string, delivered: AttentionEvent) => { if (delivered.title === "Blocking") await blocked; });
    const deps = { db, channels: [{ ...tier, deliver: send }] };
    await db.insert(pendingChannelDeliveries).values({ id: "blocking", userId: "u", tierId: tier.id, event: { ...event, title: "Blocking" }, deliverAfter: 1 });
    const first = drainAttentionDeliveries({ ...deps, ...(order === "running-access" ? { access } : {}) });
    let full: Promise<void> | undefined;
    let immediate: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await db.insert(pendingChannelDeliveries).values([
        { id: "private", userId: "u", tierId: tier.id, event: approval, deliverAfter: 1 },
        { id: "security", userId: "u", tierId: tier.id, event, deliverAfter: 1 },
      ]);
      const fullDeps = { ...deps, ...(order === "running-access" ? {} : { access }) };
      if (order === "access-last") {
        immediate = drainAttentionDeliveries(deps, Date.now(), ["security"]);
        full = drainAttentionDeliveries(fullDeps);
      } else {
        full = drainAttentionDeliveries(fullDeps);
        immediate = drainAttentionDeliveries(deps, Date.now(), ["security"]);
      }
      release();
      await Promise.all([first, full, immediate]);
      const jobs = await db.select().from(pendingChannelDeliveries);
      expect(jobs.find(job => job.id === "private")).toMatchObject({ status: "sent", lastError: null });
      expect(jobs.every(job => job.status === "sent")).toBe(true);
      expect(send).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.some(([input]) => String(input).includes("conversations.members"))).toBe(true);
      // The providers also survive after the merged batch completes, not just during its merge.
      resetThreadAccessCache();
      await db.insert(pendingChannelDeliveries).values({ id: "later-private", userId: "u", tierId: tier.id, event: approval, deliverAfter: 1 });
      await drainAttentionDeliveries(deps);
      expect(send).toHaveBeenCalledTimes(4);
    } finally { release(); await Promise.all([first, full, immediate]); fetch.mockRestore(); resetThreadAccessCache(); }
  });

  it.each([true, false])("retries missing private-thread authorization, then rechecks real access: allowed=%s", async allowed => {
    const { access, approval } = await privateApproval();
    const fetch = slackMembership(allowed);
    const failure = vi.spyOn(deliveryMetrics, "recordAttentionDeliveryFailure");
    try {
      const deps = { db, channels: [tier] };
      await db.insert(pendingChannelDeliveries).values({ id: "private", userId: "u", tierId: tier.id, event: approval, deliverAfter: 1 });
      await drainAttentionDeliveries(deps);
      const job = await pending();
      expect(job).toMatchObject({ status: "sending", attempts: 1, event: approval, lastError: expect.stringContaining("access checks are unavailable") });
      expect(failure).toHaveBeenCalledWith(false);
      expect(deliver).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      await drainAttentionDeliveries({ ...deps, access }, job.deliverAfter);
      expect(await pending()).toMatchObject({ status: allowed ? "sent" : "dropped", attempts: 2, event: null, lastError: null });
      expect(deliver).toHaveBeenCalledTimes(allowed ? 1 : 0);
    } finally { fetch.mockRestore(); failure.mockRestore(); resetThreadAccessCache(); }
  });
});
