import { and, asc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { recordChildReplyFailure, recordChildReplyOverAgeWait } from "../observability/child-reply-metrics.js";
import { childReplyDeliveries, childWatches, eventDropLog } from "../schema/index.js";

type ChildReplyRow = typeof childReplyDeliveries.$inferSelect;

/**
 * One delivery pass for an intent. `done`: the reply was sent, or nothing
 * needs to be sent. `waiting`: the parent has not finished its reply yet.
 * `undeliverable`: the reply exists but has no route now. A thrown error is
 * a failed send.
 */
export type ChildReplyOutcome =
  | { kind: "done" }
  | { kind: "waiting" }
  | { kind: "undeliverable"; reason: string };

/**
 * After this many failed attempts, the intent fails terminally. With the
 * backoff below, the retries span about an hour, so a provider outage or a
 * channel restart shorter than that still delivers the reply.
 */
export const CHILD_REPLY_MAX_ATTEMPTS = 20;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 5 * 60_000;
/** First check interval while the parent update is admitted or runs. */
const WAITING_POLL_MS = 2_000;
const WAITING_POLL_CAP_MS = 60_000;
/** A wait longer than this is reported once per process. The intent stays open. */
export const CHILD_REPLY_WAIT_REPORT_MS = 60 * 60_000;
const LEASE_MS = 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Backoff before the next try after `attempts` failures: 1s doubling, capped at five minutes. */
export function childReplyRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Check interval for a waiting intent: a tenth of the time it has waited, from two seconds to one minute. */
export function childReplyWaitDelayMs(waitedMs: number): number {
  return Math.min(WAITING_POLL_CAP_MS, Math.max(WAITING_POLL_MS, Math.floor(waitedMs / 10)));
}

/** Durable retry queue for parent responses to delegated channel work. */
export class ChildReplyDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private lastPruneAt: number | undefined;
  /** Intents this process already reported as waiting too long. */
  private readonly reportedWaits = new Set<string>();

  constructor(private readonly deps: {
    db: AppDb;
    engineStore: SessionStore;
    resolveOrgId(): Promise<string>;
    deliver(row: ChildReplyRow): Promise<ChildReplyOutcome>;
    now(): number;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, 1_000);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    await this.running;
  }

  poll(): Promise<void> {
    if (this.running) return this.running;
    const running = this.run().catch((error: unknown) => {
      console.error("[channels] child reply retry failed", error);
    }).finally(() => { this.running = undefined; });
    this.running = running;
    return running;
  }

  private async run(): Promise<void> {
    const { db } = this.deps;
    const orgId = await this.deps.resolveOrgId();
    const now = this.deps.now();
    await this.prune(orgId, now);
    const due = and(eq(childReplyDeliveries.orgId, orgId), isNull(childReplyDeliveries.completedAt),
      isNull(childReplyDeliveries.failedAt), lte(childReplyDeliveries.nextAttemptAt, now));
    const rows = await db.select().from(childReplyDeliveries).where(due)
      .orderBy(asc(childReplyDeliveries.nextAttemptAt)).limit(20);
    for (const candidate of rows) {
      // A lease permits recovery after process death. The repeated predicate fences competing polls.
      const [row] = await db.update(childReplyDeliveries).set({ nextAttemptAt: this.deps.now() + LEASE_MS })
        .where(and(due, eq(childReplyDeliveries.id, candidate.id))).returning();
      if (!row) continue;
      const leased = and(eq(childReplyDeliveries.id, row.id), eq(childReplyDeliveries.orgId, orgId),
        eq(childReplyDeliveries.nextAttemptAt, row.nextAttemptAt));
      let outcome: ChildReplyOutcome;
      try {
        let queueItemId = row.queueItemId;
        if (!queueItemId) {
          // Admission can outlive both its caller and the mutable child watch.
          const item = await this.deps.engineStore.getQueueItemByDispatchId(row.sessionId, row.id);
          if (item && item.threadId !== row.threadId) throw new Error("Child reply submission thread mismatch");
          queueItemId = item?.id ?? null;
          if (queueItemId) await db.update(childReplyDeliveries).set({ queueItemId }).where(leased);
        }
        outcome = queueItemId ? await this.deps.deliver({ ...row, queueItemId }) : await this.unadmitted(row);
      } catch (error) {
        outcome = { kind: "undeliverable", reason: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.kind !== "waiting") this.reportedWaits.delete(row.id);
      if (outcome.kind === "done") {
        await db.update(childReplyDeliveries).set({ completedAt: this.deps.now(), lastError: null }).where(leased);
      } else if (outcome.kind === "waiting") {
        const waitedMs = this.deps.now() - (row.createdAt ?? this.deps.now());
        this.reportLongWait(row, waitedMs);
        await db.update(childReplyDeliveries).set({ nextAttemptAt: this.deps.now() + childReplyWaitDelayMs(waitedMs) }).where(leased);
      } else {
        await this.recordFailure(row, leased, outcome.reason);
      }
    }
  }

  /**
   * A wait has no time limit, because only the watcher or the parent turn
   * can end it. A long wait means one of them is stuck, so report it once
   * and leave the intent open for a human to look at.
   */
  private reportLongWait(row: ChildReplyRow, waitedMs: number): void {
    if (waitedMs <= CHILD_REPLY_WAIT_REPORT_MS || this.reportedWaits.has(row.id)) return;
    this.reportedWaits.add(row.id);
    recordChildReplyOverAgeWait();
    const minutes = Math.floor(waitedMs / 60_000);
    const stage = row.queueItemId ? `parent submission ${row.queueItemId} to finish` : "the child watcher to admit the parent update";
    console.error(`[channels] child reply ${row.id} has been waiting ${minutes} minutes for ${stage}. Check session ${row.sessionId}.`);
  }

  /**
   * An intent with no admitted parent update. The child watcher owns the
   * admission: it writes the intent, admits the update, and only then marks
   * its watch settled. It retries a failed admission, including on the next
   * boot. So the intent waits, with no time limit, while its watch still
   * reports this child submission and is open. A watch that moved to a later
   * child submission ends the intent: the parent hears about the later one.
   */
  private async unadmitted(row: ChildReplyRow): Promise<ChildReplyOutcome> {
    // Intents written before these columns existed cannot name their watch.
    if (!row.childSessionId || !row.childQueueItemId) return { kind: "waiting" };
    const [watch] = await this.deps.db.select({ queueItemId: childWatches.queueItemId, settled: childWatches.settled })
      .from(childWatches).where(and(eq(childWatches.childSessionId, row.childSessionId), eq(childWatches.orgId, row.orgId)))
      .limit(1);
    if (watch && !watch.settled && watch.queueItemId === row.childQueueItemId) return { kind: "waiting" };
    // The watcher admits before it settles or moves on, so check the
    // admission again after reading the watch.
    const item = await this.deps.engineStore.getQueueItemByDispatchId(row.sessionId, row.id);
    if (item) return { kind: "waiting" };
    if (watch?.settled && watch.queueItemId === row.childQueueItemId) {
      return { kind: "undeliverable", reason: "The child watch settled without admitting the parent update." };
    }
    return { kind: "done" };
  }

  /** Every failed attempt is recorded. The last one fails the intent and leaves an operator-visible problem. */
  private async recordFailure(row: ChildReplyRow, leased: ReturnType<typeof and>, reason: string): Promise<void> {
    const attempts = row.attempts + 1;
    const lastError = reason.slice(0, 1_000);
    const now = this.deps.now();
    if (attempts < CHILD_REPLY_MAX_ATTEMPTS) {
      const delay = childReplyRetryDelayMs(attempts);
      await this.deps.db.update(childReplyDeliveries)
        .set({ attempts, lastError, nextAttemptAt: now + delay }).where(leased);
      recordChildReplyFailure(false);
      console.error(`[channels] child reply ${row.id} attempt ${attempts} failed; retrying in ${delay} ms: ${lastError}`);
      return;
    }
    await this.deps.db.transaction(async (tx) => {
      const [failed] = await tx.update(childReplyDeliveries).set({ attempts, lastError, failedAt: now })
        .where(leased).returning({ id: childReplyDeliveries.id });
      if (!failed) return;
      // The terminal state and its problem record commit together.
      const detail = `Child reply ${row.id} for session ${row.sessionId} failed after ${attempts} attempts: ${lastError}. ` +
        "Repair the channel connection, then ask the agent to post the result again.";
      await tx.insert(eventDropLog).values({ id: `child-reply:${row.id}`, orgId: row.orgId,
        reason: "child_reply_failed", detail, createdAt: now })
        .onConflictDoUpdate({ target: eventDropLog.id, set: { detail, createdAt: now } });
    });
    recordChildReplyFailure(true);
    console.error(`[channels] child reply ${row.id} failed after ${attempts} attempts; giving up: ${lastError}`);
  }

  /** Finished intents are only an idempotency record for their admission window. */
  private async prune(orgId: string, now: number): Promise<void> {
    if (this.lastPruneAt !== undefined && now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    await this.deps.db.delete(childReplyDeliveries).where(and(eq(childReplyDeliveries.orgId, orgId), or(
      and(isNotNull(childReplyDeliveries.completedAt), lt(childReplyDeliveries.completedAt, now - COMPLETED_RETENTION_MS)),
      and(isNotNull(childReplyDeliveries.failedAt), lt(childReplyDeliveries.failedAt, now - FAILED_RETENTION_MS)),
    )));
  }
}
