import { and, asc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { recordChildReplyFailure } from "../observability/child-reply-metrics.js";
import { childReplyDeliveries, eventDropLog } from "../schema/index.js";

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

/** After this many failed attempts, the intent fails terminally. */
export const CHILD_REPLY_MAX_ATTEMPTS = 10;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 5 * 60_000;
/** Poll interval while the parent turn runs. The engine settles every submission, so this wait is bounded. */
const WAITING_POLL_MS = 2_000;
/** The parent's update is admitted right after its intent is written. An
 * intent with no admitted submission after this long lost its admission (a
 * crash between the two writes), and nothing else would ever finish it. */
export const CHILD_REPLY_ADMISSION_WINDOW_MS = 10 * 60_000;
const LEASE_MS = 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Backoff before the next try after `attempts` failures: 1s doubling, capped at five minutes. */
export function childReplyRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Durable retry queue for parent responses to delegated channel work. */
export class ChildReplyDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private lastPruneAt: number | undefined;

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
        const admissionLost = !queueItemId && row.createdAt !== null
          && this.deps.now() - row.createdAt > CHILD_REPLY_ADMISSION_WINDOW_MS;
        outcome = queueItemId ? await this.deps.deliver({ ...row, queueItemId })
          : admissionLost ? { kind: "undeliverable", reason: "The parent update was never admitted." }
          : { kind: "waiting" };
      } catch (error) {
        outcome = { kind: "undeliverable", reason: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.kind === "done") {
        await db.update(childReplyDeliveries).set({ completedAt: this.deps.now(), lastError: null }).where(leased);
      } else if (outcome.kind === "waiting") {
        await db.update(childReplyDeliveries).set({ nextAttemptAt: this.deps.now() + WAITING_POLL_MS }).where(leased);
      } else {
        await this.recordFailure(row, leased, outcome.reason);
      }
    }
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
