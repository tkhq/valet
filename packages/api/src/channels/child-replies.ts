import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { childReplyDeliveries } from "../schema/index.js";

/** Durable retry queue for parent responses to delegated channel work. */
export class ChildReplyDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly deps: {
    db: AppDb;
    engineStore: SessionStore;
    resolveOrgId(): Promise<string>;
    deliver(row: typeof childReplyDeliveries.$inferSelect): Promise<boolean>;
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
    const due = and(eq(childReplyDeliveries.orgId, orgId), isNull(childReplyDeliveries.completedAt),
      lte(childReplyDeliveries.nextAttemptAt, now));
    const rows = await db.select().from(childReplyDeliveries).where(due)
      .orderBy(asc(childReplyDeliveries.nextAttemptAt)).limit(20);
    for (const candidate of rows) {
      // A lease permits recovery after process death. The repeated predicate fences competing polls.
      const [row] = await db.update(childReplyDeliveries).set({ nextAttemptAt: this.deps.now() + 60_000 })
        .where(and(due, eq(childReplyDeliveries.id, candidate.id))).returning();
      if (!row) continue;
      try {
        let queueItemId = row.queueItemId;
        if (!queueItemId) {
          // Admission can outlive both its caller and the mutable child watch.
          const item = await this.deps.engineStore.getQueueItemByDispatchId(row.sessionId, row.id);
          if (item && item.threadId !== row.threadId) throw new Error("Child reply submission thread mismatch");
          queueItemId = item?.id ?? null;
          if (queueItemId) {
            await db.update(childReplyDeliveries).set({ queueItemId })
              .where(and(eq(childReplyDeliveries.id, row.id), eq(childReplyDeliveries.orgId, orgId), eq(childReplyDeliveries.nextAttemptAt, row.nextAttemptAt)));
          }
        }
        const completed = queueItemId ? await this.deps.deliver({ ...row, queueItemId }) : false;
        await db.update(childReplyDeliveries).set(completed
          ? { completedAt: this.deps.now(), lastError: null }
          : { nextAttemptAt: this.deps.now() + 1_000 })
          .where(and(eq(childReplyDeliveries.id, row.id), eq(childReplyDeliveries.orgId, orgId), eq(childReplyDeliveries.nextAttemptAt, row.nextAttemptAt)));
      } catch (error) {
        const attempts = row.attempts + 1;
        const lastError = String(error).slice(0, 1_000);
        console.error(`[channels] child reply ${row.id} failed; retrying`, error);
        await db.update(childReplyDeliveries).set({ attempts, lastError,
          nextAttemptAt: this.deps.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts - 1, 6)),
        }).where(and(eq(childReplyDeliveries.id, row.id), eq(childReplyDeliveries.orgId, orgId), eq(childReplyDeliveries.nextAttemptAt, row.nextAttemptAt)));
      }
    }
  }
}
