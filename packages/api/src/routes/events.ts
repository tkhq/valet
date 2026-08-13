/**
 * Event feed, catalog, and subscriptions CRUD (event-system plan, Task 7).
 *
 * One router carrying both `/events*` and `/event-subscriptions*` path
 * families — mounted at `/api` in app.ts, after every more-specific router.
 * Everything is org-scoped off `c.var.user.orgId`; cross-org rows 404, never
 * 403 (same "an owned row and a missing row are indistinguishable" rule as
 * `routes/workflows.ts`). Subscription bodies are validated against the
 * merged plugin trigger catalog before any row is written — the ingest
 * matcher (`events/ingest.ts`) trusts the `event_keys`/`filters` jsonb
 * shapes this file writes.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { EventCatalogEntry, ValetPlugin } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import { catalogForService } from "../events/ingest.js";
import { eventKeyMatches, filtersMatch, type SubscriptionFilter } from "../events/match.js";
import { ownedDefinitionRow } from "../workflows/service.js";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  EventSubscriptionFilterWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  EventSummaryWire,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionRequest,
  PatchEventSubscriptionResponse,
  RedeliverEventResponse,
} from "../wire/types.js";

export const eventsRouter = new Hono<AppEnv>();

/**
 * A subscription is mutable by whoever can act on its owner: any member for
 * an org-owned one, or only the creator for a personal (`user`-owned) one.
 * Everyone in the org can still SEE every subscription in the list (shared
 * visibility into what automations exist) — this gate is mutation-only, so
 * an org member cannot toggle or delete a colleague's personal automation
 * even though they can see it exists.
 */
function canMutateSubscription(row: { ownerType: "user" | "org"; ownerId: string }, userId: string): boolean {
  return row.ownerType === "org" || row.ownerId === userId;
}

const FILTER_OPS = ["eq", "in", "prefix", "contains"] as const;
// `signal` (wake parked workflow runs) is deliberately NOT accepted yet:
// no workflow node parks on the `event:{key}` signal shape the dispatcher
// would emit, so a signal-target subscription would validate and then
// silently never fire. Re-add once a waitForEvent node exists.
const TARGET_KINDS = ["workflow", "orchestrator"] as const;

const FEED_DEFAULT_LIMIT = 50;
const FEED_MAX_LIMIT = 100;

function allCatalogEntries(plugins: ValetPlugin[]): EventCatalogEntry[] {
  return plugins.flatMap((p) => p.triggers ?? []).flatMap((t) => t.catalog);
}

/**
 * Validates a subscription body against the merged plugin catalog. Returns a
 * human-readable error naming the offending key/field/op, or `null` when
 * valid. Shared by POST (full body) and PATCH (existing row merged with the
 * patch, so partial updates re-validate in context). Workflow-target org
 * ownership is checked separately by the POST handler (needs the db).
 */
export function validateSubscription(
  plugins: ValetPlugin[],
  body: {
    name: unknown;
    eventKeys: unknown;
    filters: unknown;
    target: unknown;
  },
): string | null {
  const entries = allCatalogEntries(plugins);

  if (typeof body.name !== "string" || body.name.length === 0) {
    return "name must be a non-empty string";
  }

  if (!Array.isArray(body.eventKeys) || body.eventKeys.length === 0) {
    return "eventKeys must be a non-empty array";
  }
  // Catalog entries actually selected by the eventKeys patterns — filter
  // fields are validated against THESE, not the union across all services,
  // because the ingest matcher (`match.ts` filtersMatch) only consults the
  // arriving event's own entry. Validating against the union would accept
  // e.g. a GitHub-only `repo` filter on a `linear.issue.*` subscription,
  // which then silently never matches anything.
  const selectedEntries: EventCatalogEntry[] = [];
  for (const pattern of body.eventKeys) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      return "eventKeys entries must be non-empty strings";
    }
    const matches = pattern.endsWith(".*")
      ? entries.filter((e) => e.key.startsWith(pattern.slice(0, -1)))
      : entries.filter((e) => e.key === pattern);
    if (matches.length === 0) return `unknown event key: ${pattern}`;
    selectedEntries.push(...matches);
  }

  if (!Array.isArray(body.filters)) {
    return "filters must be an array";
  }
  for (const raw of body.filters) {
    if (typeof raw !== "object" || raw === null) return "filters entries must be objects";
    const f = raw as Record<string, unknown>;
    if (typeof f.field !== "string" || f.field.length === 0) {
      return "filter field must be a non-empty string";
    }
    if (typeof f.op !== "string" || !(FILTER_OPS as readonly string[]).includes(f.op)) {
      return `unknown filter op: ${String(f.op)}`;
    }
    if (f.op === "in") {
      if (
        !Array.isArray(f.value) ||
        (f.value as unknown[]).some((v) => typeof v !== "string")
      ) {
        return `filter value invalid for op in on field ${f.field}`;
      }
    } else {
      // eq / prefix / contains — value must be a non-empty string
      if (typeof f.value !== "string" || f.value.length === 0) {
        return `filter value invalid for op ${f.op} on field ${f.field}`;
      }
    }
    if (!selectedEntries.some((e) => e.filters.some((cf) => cf.field === f.field))) {
      return `filter field ${f.field} is not declared by any event selected by eventKeys`;
    }
  }

  if (typeof body.target !== "object" || body.target === null) {
    return "target must be an object";
  }
  const target = body.target as Record<string, unknown>;
  if (typeof target.kind !== "string" || !(TARGET_KINDS as readonly string[]).includes(target.kind)) {
    return `unknown target kind: ${String(target.kind)}`;
  }
  if (target.kind === "workflow" && (typeof target.workflowId !== "string" || target.workflowId.length === 0)) {
    return "workflow target requires workflowId";
  }
  if (
    target.kind === "orchestrator" &&
    target.orchestrator !== undefined &&
    target.orchestrator !== "user" &&
    target.orchestrator !== "org"
  ) {
    return `unknown target orchestrator: ${String(target.orchestrator)}`;
  }
  return null;
}

/** The jsonb columns come back `unknown`; their shapes are owned by
 * `validateSubscription` above, which gates every write to this table. */
function rowToSubscription(row: typeof eventSubscriptions.$inferSelect): EventSubscriptionWire {
  return {
    id: row.id,
    name: row.name,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    eventKeys: row.eventKeys as string[],
    filters: row.filters as EventSubscriptionFilterWire[],
    target: row.target as EventSubscriptionTargetWire,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `refs`/`actor` jsonb shapes are owned by the ingest writer
 * (`events/ingest.ts`), which only stores `NormalizedEvent` fields. */
function rowToEventSummary(row: typeof events.$inferSelect): EventSummaryWire {
  return {
    id: row.id,
    service: row.service,
    eventKey: row.eventKey,
    summary: row.summary,
    refs: row.refs as Record<string, string>,
    actor: (row.actor as EventSummaryWire["actor"]) ?? null,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
  };
}

// ── Catalog ─────────────────────────────────────────────────────────────────

eventsRouter.get("/events/catalog", (c) => {
  const { plugins } = c.var.providers;
  const services = [...new Set(plugins.flatMap((p) => p.triggers ?? []).map((t) => t.service))];
  const resp: GetEventCatalogResponse = {
    services: services.map((service) => ({ service, entries: catalogForService(plugins, service) })),
  };
  return c.json(resp);
});

// ── Feed ────────────────────────────────────────────────────────────────────

eventsRouter.get("/events", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const service = c.req.query("service");
  const key = c.req.query("key");
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, FEED_MAX_LIMIT) : FEED_DEFAULT_LIMIT;

  const conditions = [eq(events.orgId, user.orgId)];
  if (service) conditions.push(eq(events.service, service));
  if (key) conditions.push(eq(events.eventKey, key));

  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.receivedAt))
    .limit(limit);

  const resp: ListEventsResponse = { events: rows.map(rowToEventSummary) };
  return c.json(resp);
});

eventsRouter.get("/events/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.orgId, user.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "event not found" }, 404);

  // The join carries the subscription NAME onto each delivery, so a row can
  // say what it was trying to reach. It also does the org scoping the
  // previous `subscriptionId IN (org subscriptions)` subquery did, over the
  // same set: a delivery whose subscription row is deleted has no join
  // partner and stays hidden, exactly as before.
  const deliveryRows = await db
    .select({
      id: eventDeliveries.id,
      subscriptionId: eventDeliveries.subscriptionId,
      subscriptionName: eventSubscriptions.name,
      status: eventDeliveries.status,
      attempts: eventDeliveries.attempts,
      lastError: eventDeliveries.lastError,
      deliveredAt: eventDeliveries.deliveredAt,
      nextAttemptAt: eventDeliveries.nextAttemptAt,
    })
    .from(eventDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .where(and(eq(eventDeliveries.eventId, id), eq(eventSubscriptions.orgId, user.orgId)))
    .orderBy(desc(eventDeliveries.createdAt));

  const resp: GetEventResponse = {
    event: { ...rowToEventSummary(row), payload: row.payload },
    deliveries: deliveryRows.map((d) => ({
      id: d.id,
      subscriptionId: d.subscriptionId,
      subscriptionName: d.subscriptionName,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError,
      deliveredAt: d.deliveredAt,
      // `next_attempt_at` keeps its last value after a delivery settles: a
      // dead row holds the timestamp of the attempt that gave up, and a
      // delivered row holds its claim lease. Report it only while another
      // attempt is really coming, or the UI promises a retry that the
      // dispatcher will never make.
      nextAttemptAt: d.status === "pending" || d.status === "failed" ? d.nextAttemptAt : null,
    })),
  };
  return c.json(resp);
});

/**
 * `POST /api/events/:id/redeliver` — replay one event through the
 * subscriptions that match it NOW.
 *
 * Three decisions worth stating, because each one is load-bearing:
 *
 * 1. **New delivery rows, always.** The dispatcher derives a workflow run id
 *    from the delivery id (`wfrun_evt_${deliveryId}`) and returns early when
 *    that run exists, so a "retry" that reset an old row would report
 *    success and start nothing. Redelivery therefore INSERTs, and never
 *    revives, a delivery row. A dead row stays dead as the record of what
 *    happened.
 * 2. **The subscriptions that match now, not the ones that matched then.**
 *    Someone who repaired a broken subscription expects this event to reach
 *    it, so a subscription created or fixed after the event still gets a
 *    delivery. Someone who disabled a subscription does not, so
 *    `enabled = false` rows are skipped. The match itself is the ingest
 *    match (`eventKeyMatches` + `filtersMatch` over the service catalog),
 *    called here so the two paths cannot drift.
 * 3. **No de-duplication against deliveries still in flight.** A `pending`
 *    or `failed` row is still on the dispatcher's due list, so redelivering
 *    an event mid-backoff can start a second run. The caller decides that:
 *    the UI names the scheduled retries in its confirm step. Suppressing the
 *    new row instead would make an explicit press do nothing.
 *
 * Access follows the other event routes: org scope, and a cross-org event
 * answers 404 like a missing one. The fan-out is the same fan-out any
 * webhook for this event would cause, and every target is an enabled
 * subscription its owner chose to arm.
 */
eventsRouter.post("/events/:id/redeliver", async (c) => {
  const { db, plugins, eventDispatcher } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.orgId, user.orgId)))
    .limit(1);
  const event = rows[0];
  if (!event) return c.json({ error: "event not found" }, 404);

  const subs = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, user.orgId), eq(eventSubscriptions.enabled, true)));

  // Both jsonb columns come back `unknown`; their shapes are owned by
  // `validateSubscription` above, which gates every write to this table.
  const catalog = catalogForService(plugins, event.service);
  const matched = subs.filter(
    (sub) =>
      eventKeyMatches(event.eventKey, sub.eventKeys as string[]) &&
      filtersMatch(event.payload, event.eventKey, sub.filters as SubscriptionFilter[], catalog),
  );

  if (matched.length > 0) {
    const now = Date.now();
    await db.insert(eventDeliveries).values(
      matched.map((sub) => ({
        id: randomUUID(),
        eventId: event.id,
        subscriptionId: sub.id,
        status: "pending" as const,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })),
    );
    // Same in-process nudge the ingest path uses, so redelivery does not
    // wait for the next 1s poll tick.
    eventDispatcher.nudge();
  }

  const resp: RedeliverEventResponse = { created: matched.length };
  return c.json(resp);
});

// ── Subscriptions CRUD ──────────────────────────────────────────────────────

eventsRouter.post("/event-subscriptions", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;

  let body: CreateEventSubscriptionRequest;
  try {
    body = (await c.req.json()) as CreateEventSubscriptionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const filters = body.filters ?? [];
  const error = validateSubscription(plugins, { ...body, filters });
  if (error) return c.json({ error }, 400);

  // Workflow targets must be OWNED by the caller, not just exist in their
  // org — this is the same event_subscriptions row shape (and the same
  // ownership requirement) createWorkflowTrigger (workflows/trigger-
  // service.ts) enforces; this route is a second, parallel write path into
  // the same table and previously checked only orgId, letting any org
  // member wire event-driven automation onto a workflow they don't own. A
  // foreign, unowned, or missing id all fail identically (never reveals
  // whether the id exists at all).
  if (body.target.kind === "workflow") {
    const owned = await ownedDefinitionRow(db, { userId: user.id, orgId: user.orgId }, body.target.workflowId);
    if (!owned) {
      return c.json({ error: `unknown workflow: ${body.target.workflowId}` }, 400);
    }
  }

  // Orchestrator targets choose the owning orchestrator: the caller's user
  // orchestrator (default) or the org orchestrator.
  const orchestrator = body.target.kind === "orchestrator" ? (body.target.orchestrator ?? "user") : "user";
  const ownerType = orchestrator === "org" ? ("org" as const) : ("user" as const);
  const ownerId = orchestrator === "org" ? user.orgId : user.id;

  const now = Date.now();
  const id = randomUUID();
  const inserted = await db
    .insert(eventSubscriptions)
    .values({
      id,
      orgId: user.orgId,
      ownerType,
      ownerId,
      name: body.name,
      eventKeys: body.eventKeys,
      filters,
      target: body.target,
      enabled: body.enabled ?? true,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const resp: CreateEventSubscriptionResponse = rowToSubscription(inserted[0]);
  return c.json(resp, 201);
});

eventsRouter.get("/event-subscriptions", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.orgId, user.orgId))
    .orderBy(desc(eventSubscriptions.createdAt));

  const resp: ListEventSubscriptionsResponse = { subscriptions: rows.map(rowToSubscription) };
  return c.json(resp);
});

eventsRouter.patch("/event-subscriptions/:id", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)))
    .limit(1);
  const row = rows[0];
  // A personal subscription owned by someone else answers the same 404 as
  // a missing one — same "cross-owner access is indistinguishable from
  // not-found" convention as workflows/teams routes.
  if (!row || !canMutateSubscription(row, user.id)) {
    return c.json({ error: "subscription not found" }, 404);
  }

  let body: PatchEventSubscriptionRequest;
  try {
    body = (await c.req.json()) as PatchEventSubscriptionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  // Re-validate the row as it would exist after the patch — provided fields
  // get full validation in the context of the untouched ones.
  const merged = {
    name: body.name ?? row.name,
    eventKeys: body.eventKeys ?? row.eventKeys,
    filters: body.filters ?? row.filters,
    target: row.target,
  };
  const error = validateSubscription(plugins, merged);
  if (error) return c.json({ error }, 400);

  const updated = await db
    .update(eventSubscriptions)
    .set({
      name: merged.name,
      eventKeys: merged.eventKeys,
      filters: merged.filters,
      enabled: body.enabled ?? row.enabled,
      updatedAt: Date.now(),
    })
    .where(eq(eventSubscriptions.id, id))
    .returning();

  const resp: PatchEventSubscriptionResponse = rowToSubscription(updated[0]);
  return c.json(resp);
});

eventsRouter.delete("/event-subscriptions/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select({ ownerType: eventSubscriptions.ownerType, ownerId: eventSubscriptions.ownerId })
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row || !canMutateSubscription(row, user.id)) {
    return c.json({ error: "subscription not found" }, 404);
  }

  await db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, id));
  return c.body(null, 204);
});
