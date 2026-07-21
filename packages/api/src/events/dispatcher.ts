/**
 * Event-delivery dispatcher: drains `event_deliveries` rows into their
 * subscription targets (workflow run start / orchestrator signal prompt /
 * parked-run workflow signals).
 *
 * Same lifecycle pattern as `LocalRunHost`: a poll loop (1s) that the
 * ingest path nudges in-process via `nudge()`, so the interval is a
 * staleness floor, not the delivery path.
 *
 * Claiming deviates from the design sketch's `SELECT ... FOR UPDATE SKIP
 * LOCKED`: a bare `FOR UPDATE` outside an enclosing transaction releases
 * its locks at statement end (autocommit), so it wouldn't fence anything
 * here — and this codebase's established row-claim pattern is a
 * single-statement CAS (`pg-store.ts` `claimRun`). The claim below is one
 * atomic `UPDATE ... WHERE id IN (<due subquery>) RETURNING id` that
 * pushes `next_attempt_at` forward by a lease, so a concurrent poll no
 * longer sees the rows as due. A crash mid-delivery leaves the row
 * pending; it becomes due again when the lease lapses.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { RunHost, RunParams, WorkflowStore, WorkflowTriggerPayload } from "@valet/workflow";
import type { SignalContent } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "../workflows/definition-version.js";

/** Retry backoff per failed attempt; a failure past the last entry is dead. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const POLL_MS = 1_000;
const BATCH = 20;
/** How long a claimed-but-unresolved row stays invisible to other polls. */
const CLAIM_LEASE_MS = 60_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_BODY_EXCERPT_CHARS = 4_000;

export interface OrchestratorDeliverFn {
  (args: {
    orgId: string;
    ownerType: "user" | "org";
    ownerId: string;
    signal: SignalContent;
    dispatchId: string;
  }): Promise<void>;
}

export interface EventDispatcherDeps {
  db: AppDb;
  workflowRunHost: RunHost;
  workflowStore: WorkflowStore;
  /** Seam over `ensureOrchestratorSession` + `thread("events").submitPrompt` — see `orchestrator-target.ts`. */
  deliverToOrchestrator: OrchestratorDeliverFn;
}

/** The `target` jsonb column's shape — written only by the subscriptions CRUD validator. */
interface SubscriptionTarget {
  kind: "workflow" | "orchestrator" | "signal";
  workflowId?: string;
}

export class EventDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(private readonly deps: EventDispatcherDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.draining) await new Promise((r) => setTimeout(r, 25));
  }

  /** In-process nudge from the ingest path. Arrow property so callers can pass it unbound. */
  nudge = (): void => {
    void this.pollOnce().catch((err) => console.error("event dispatcher poll failed:", err));
  };

  async pollOnce(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const now = Date.now();
      // Atomic claim (see file doc comment): lease the due rows by moving
      // next_attempt_at forward in the same statement that selects them.
      const due = this.deps.db
        .select({ id: eventDeliveries.id })
        .from(eventDeliveries)
        .where(and(inArray(eventDeliveries.status, ["pending", "failed"]), lte(eventDeliveries.nextAttemptAt, now)))
        .orderBy(asc(eventDeliveries.nextAttemptAt))
        .limit(BATCH);
      const claimed = await this.deps.db
        .update(eventDeliveries)
        .set({ nextAttemptAt: now + CLAIM_LEASE_MS })
        .where(inArray(eventDeliveries.id, due))
        .returning({ id: eventDeliveries.id });

      for (const row of claimed) {
        await this.deliverOne(row.id).catch((err) => console.error(`event dispatch ${row.id}:`, err));
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliverOne(deliveryId: string): Promise<void> {
    const { db } = this.deps;
    const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, deliveryId)).limit(1);
    if (!delivery || delivery.status === "delivered" || delivery.status === "dead") return;
    const [event] = await db.select().from(events).where(eq(events.id, delivery.eventId)).limit(1);
    const [sub] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, delivery.subscriptionId))
      .limit(1);
    if (!event || !sub) {
      await db
        .update(eventDeliveries)
        .set({ status: "dead", lastError: "event or subscription vanished" })
        .where(eq(eventDeliveries.id, deliveryId));
      return;
    }

    try {
      // Both jsonb shapes are owned by their writers: `target` by the
      // subscriptions CRUD validator, `refs` by ingest (NormalizedEvent.refs
      // is Record<string, string>). Same narrowing convention as ingest.ts.
      const target = sub.target as SubscriptionTarget;
      const refs = event.refs as Record<string, string>;
      if (target.kind === "workflow" && target.workflowId) {
        await this.startWorkflow(target.workflowId, sub.id, event, refs);
      } else if (target.kind === "orchestrator") {
        await this.deps.deliverToOrchestrator({
          orgId: event.orgId,
          ownerType: sub.ownerType,
          ownerId: sub.ownerId,
          signal: {
            kind: "signal",
            signalType: event.eventKey,
            body: `${event.summary}\n\n${JSON.stringify(event.payload).slice(0, MAX_BODY_EXCERPT_CHARS)}`,
            attributes: { ...refs, eventId: event.id, service: event.service },
          },
          dispatchId: `event:${delivery.id}`,
        });
      } else if (target.kind === "signal") {
        await this.signalParkedRuns(event, refs);
      } else {
        throw new Error(`unknown target kind: ${target.kind}`);
      }
      await db
        .update(eventDeliveries)
        .set({ status: "delivered", deliveredAt: Date.now(), attempts: delivery.attempts + 1 })
        .where(eq(eventDeliveries.id, deliveryId));
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const backoff = BACKOFF_MS[attempts - 1];
      await db
        .update(eventDeliveries)
        .set({
          status: backoff === undefined ? "dead" : "failed",
          attempts,
          nextAttemptAt: backoff === undefined ? delivery.nextAttemptAt : Date.now() + backoff,
          lastError: String(err).slice(0, MAX_ERROR_CHARS),
        })
        .where(eq(eventDeliveries.id, deliveryId));
    }
  }

  private async startWorkflow(
    workflowId: string,
    subscriptionId: string,
    event: typeof events.$inferSelect,
    refs: Record<string, string>,
  ): Promise<void> {
    // Mirrors routes/workflows.ts POST /:id/runs: same run-id scheme, same
    // definitionVersionId, owner resolved from the definition row. The org
    // check is defensive — subscription validation (Task 7) enforces
    // ownership at write time; a cross-org drift dead-letters here.
    const rows = await this.deps.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, workflowId), eq(workflowDefinitions.orgId, event.orgId)))
      .limit(1);
    const def = rows[0];
    if (!def) throw new Error(`workflow ${workflowId} not found in org ${event.orgId}`);

    const trigger: WorkflowTriggerPayload = {
      type: "event",
      triggerId: subscriptionId,
      timestamp: new Date(event.occurredAt).toISOString(),
      data: { key: event.eventKey, summary: event.summary, refs, payload: event.payload },
      metadata: { eventId: event.id, service: event.service },
    };
    const params: RunParams = {
      workflowId,
      definitionVersionId: definitionVersionId(def.definition),
      triggerId: subscriptionId,
      input: trigger,
    };
    const runId = `wfrun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await this.deps.workflowRunHost.start(runId, params, def.definition, {
      ownerType: def.ownerType,
      ownerId: def.ownerId,
    });
  }

  private async signalParkedRuns(event: typeof events.$inferSelect, refs: Record<string, string>): Promise<void> {
    const signalType = `event:${event.eventKey}`;
    // Parked runs in the event's org waiting on this signal type. Org
    // scoping goes through the run's parent definition; the jsonb
    // containment matches partial objects, so the stored condition's extra
    // fields (nodeId, timeoutAt) don't matter.
    const rows = await this.deps.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
      .where(
        and(
          eq(workflowDefinitions.orgId, event.orgId),
          eq(workflowRuns.status, "parked"),
          sql`${workflowRuns.waitingOn} @> ${JSON.stringify([{ kind: "signal", signalType }])}::jsonb`,
        ),
      );
    for (const row of rows) {
      await this.deps.workflowStore.insertSignal({
        runId: row.id,
        signalId: `event:${event.id}:${row.id}`,
        signalType,
        payload: { key: event.eventKey, summary: event.summary, refs, payload: event.payload },
        createdAt: Date.now(),
      });
      await this.deps.workflowRunHost.wake(row.id);
    }
  }
}
