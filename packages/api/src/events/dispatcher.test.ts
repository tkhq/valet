/**
 * EventDispatcher unit tests (event-system plan Task 6): real PGlite rows
 * for events/subscriptions/deliveries, recording fakes at the two seams
 * (`RunHost`, `deliverToOrchestrator`). `pollOnce()` is driven directly —
 * no timers, no sleeps.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { RunHost, WorkflowTriggerPayload } from "@valet/workflow";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import {
  eventDeliveries,
  events,
  eventSubscriptions,
  workflowDefinitions,
  workflowRuns,
  workflowSignals,
} from "../schema/index.js";
import { EventDispatcher, type OrchestratorDeliverFn } from "./dispatcher.js";

const ORG = "org-1";

function fakeRunHost(overrides: Partial<RunHost> = {}): RunHost {
  return {
    start: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    scheduleWake: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    startHost: vi.fn(),
    stopHost: vi.fn(async () => {}),
    ...overrides,
  };
}

interface SeedOpts {
  target: unknown;
  ownerType?: "user" | "org";
  attempts?: number;
  status?: "pending" | "failed";
  eventKey?: string;
}

describe("EventDispatcher", () => {
  let tdb: TestPgDb;

  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  /** Seeds one event + subscription + due delivery; returns their ids. */
  async function seedDelivery(opts: SeedOpts) {
    const db = tdb.appDb;
    const now = Date.now();
    const eventId = randomUUID();
    const subscriptionId = randomUUID();
    const deliveryId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      orgId: ORG,
      service: "github",
      eventKey: opts.eventKey ?? "github.issues.opened",
      dedupeKey: randomUUID(),
      refs: { repo: "acme/site", installation_id: "42" },
      summary: "Issue #7 opened: broken build",
      payload: { action: "opened", issue: { number: 7 } },
      occurredAt: now - 5_000,
      receivedAt: now,
    });
    await db.insert(eventSubscriptions).values({
      id: subscriptionId,
      orgId: ORG,
      ownerType: opts.ownerType ?? "user",
      ownerId: "user-1",
      name: "test sub",
      eventKeys: ["github.issues.*"],
      filters: [],
      target: opts.target,
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
      nextAttemptAt: now - 1_000,
      createdAt: now,
    });
    return { eventId, subscriptionId, deliveryId };
  }

  async function getDelivery(id: string) {
    const rows = await tdb.appDb.select().from(eventDeliveries).where(eq(eventDeliveries.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`delivery ${id} vanished`);
    return row;
  }

  it("delivers a workflow-target delivery: RunHost.start gets the event trigger payload; row -> delivered", async () => {
    const db = tdb.appDb;
    const now = Date.now();
    const definition = { nodes: [], edges: [] };
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: ORG,
      ownerType: "user",
      ownerId: "user-1",
      name: "on issue",
      definition,
      createdAt: now,
      updatedAt: now,
    });
    const { eventId, subscriptionId, deliveryId } = await seedDelivery({
      target: { kind: "workflow", workflowId: "wf-1" },
    });

    const runHost = fakeRunHost();
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    });
    await dispatcher.pollOnce();

    expect(runHost.start).toHaveBeenCalledTimes(1);
    const [runId, params, def, owner] = vi.mocked(runHost.start).mock.calls[0];
    expect(runId).toMatch(/^wfrun_/);
    expect(def).toEqual(definition);
    expect(owner).toEqual({ ownerType: "user", ownerId: "user-1" });
    expect(params.workflowId).toBe("wf-1");
    expect(params.triggerId).toBe(subscriptionId);
    const trigger = params.input as WorkflowTriggerPayload;
    expect(trigger.type).toBe("event");
    expect(trigger.triggerId).toBe(subscriptionId);
    expect(trigger.data).toEqual({
      key: "github.issues.opened",
      summary: "Issue #7 opened: broken build",
      refs: { repo: "acme/site", installation_id: "42" },
      payload: { action: "opened", issue: { number: 7 } },
    });
    expect(trigger.metadata).toEqual({ eventId, service: "github" });

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).not.toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers an orchestrator-target delivery: seam gets SignalContent with signalType = event key; row -> delivered", async () => {
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "orchestrator" }, ownerType: "org" });

    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {});
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    });
    await dispatcher.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    const args = deliver.mock.calls[0][0];
    expect(args.orgId).toBe(ORG);
    expect(args.ownerType).toBe("org");
    expect(args.ownerId).toBe("user-1");
    expect(args.dispatchId).toBe(`event:${deliveryId}`);
    expect(args.signal.kind).toBe("signal");
    expect(args.signal.signalType).toBe("github.issues.opened");
    // jsonb round-trips reorder object keys, so parse the excerpt instead
    // of comparing the serialized string byte-for-byte.
    const [summary, excerpt] = args.signal.body.split("\n\n");
    expect(summary).toBe("Issue #7 opened: broken build");
    expect(JSON.parse(excerpt)).toEqual({ action: "opened", issue: { number: 7 } });
    expect(args.signal.attributes).toEqual({
      repo: "acme/site",
      installation_id: "42",
      eventId,
      service: "github",
    });

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
  });

  it("signal target: inserts workflow_signals for org runs parked on event:<key> and wakes them", async () => {
    const db = tdb.appDb;
    const now = Date.now();
    const signalType = "event:github.issues.opened";
    // Definition rows carry the org scoping; run-2 belongs to another org
    // and must NOT be signalled despite an identical wait condition.
    for (const [defId, orgId] of [
      ["wf-a", ORG],
      ["wf-b", "other-org"],
    ] as const) {
      await db.insert(workflowDefinitions).values({
        id: defId,
        orgId,
        ownerType: "user",
        ownerId: "user-1",
        name: defId,
        definition: { nodes: [] },
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const [runId, workflowId] of [
      ["run-1", "wf-a"],
      ["run-2", "wf-b"],
    ] as const) {
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId,
        definitionVersionId: "v1",
        definition: { nodes: [] },
        params: { workflowId, definitionVersionId: "v1" },
        status: "parked",
        waitingOn: [{ kind: "signal", nodeId: "wait-1", signalType, timeoutAt: now + 3_600_000 }],
        createdAt: now,
        updatedAt: now,
      });
    }
    const { eventId, deliveryId } = await seedDelivery({ target: { kind: "signal" } });

    const runHost = fakeRunHost();
    const dispatcher = new EventDispatcher({
      db,
      workflowRunHost: runHost,
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: vi.fn<OrchestratorDeliverFn>(async () => {}),
    });
    await dispatcher.pollOnce();

    const signals = await db.select().from(workflowSignals);
    expect(signals).toHaveLength(1);
    expect(signals[0].runId).toBe("run-1");
    expect(signals[0].signalId).toBe(`event:${eventId}:run-1`);
    expect(signals[0].signalType).toBe(signalType);
    expect(signals[0].payload).toEqual({
      key: "github.issues.opened",
      summary: "Issue #7 opened: broken build",
      refs: { repo: "acme/site", installation_id: "42" },
      payload: { action: "opened", issue: { number: 7 } },
    });
    expect(runHost.wake).toHaveBeenCalledTimes(1);
    expect(runHost.wake).toHaveBeenCalledWith("run-1");

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
  });

  it("failure increments attempts, sets next_attempt_at per backoff, records last_error", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {
      throw new Error("orchestrator boom");
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: deliver,
    });

    // Attempt 1 → 30s backoff.
    let before = Date.now();
    await dispatcher.pollOnce();
    let row = await getDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("orchestrator boom");
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 30_000);

    // Make it due again; attempt 2 → 2m backoff.
    await tdb.appDb
      .update(eventDeliveries)
      .set({ nextAttemptAt: Date.now() - 1 })
      .where(eq(eventDeliveries.id, deliveryId));
    before = Date.now();
    await dispatcher.pollOnce();
    row = await getDelivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("marks the delivery dead on the 5th failure", async () => {
    const { deliveryId } = await seedDelivery({
      target: { kind: "orchestrator" },
      status: "failed",
      attempts: 4,
    });
    const dispatcher = new EventDispatcher({
      db: tdb.appDb,
      workflowRunHost: fakeRunHost(),
      workflowStore: new PgWorkflowStore(tdb.pgdb),
      deliverToOrchestrator: vi.fn<OrchestratorDeliverFn>(async () => {
        throw new Error("still broken");
      }),
    });
    await dispatcher.pollOnce();

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(5);
    expect(row.lastError).toContain("still broken");

    // A dead row is never claimed again.
    await dispatcher.pollOnce();
    expect((await getDelivery(deliveryId)).attempts).toBe(5);
  });

  it("claimed rows are skipped by a concurrent pollOnce", async () => {
    const { deliveryId } = await seedDelivery({ target: { kind: "orchestrator" } });
    // The slow seam holds the first dispatcher's delivery open while the
    // second polls; the atomic claim must keep the row invisible to it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deliver = vi.fn<OrchestratorDeliverFn>(async () => {
      await gate;
    });
    const mkDispatcher = () =>
      new EventDispatcher({
        db: tdb.appDb,
        workflowRunHost: fakeRunHost(),
        workflowStore: new PgWorkflowStore(tdb.pgdb),
        deliverToOrchestrator: deliver,
      });
    const d1 = mkDispatcher();
    const d2 = mkDispatcher();

    const p1 = d1.pollOnce();
    // Give d1's claim a macrotask to land before d2 polls.
    await new Promise((r) => setImmediate(r));
    const p2 = d2.pollOnce();
    await p2; // d2 must complete without touching the claimed row
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await p1;

    expect(deliver).toHaveBeenCalledTimes(1);
    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
  });
});
