/**
 * Event feed, catalog, and subscriptions CRUD (event-system plan, Task 7).
 *
 * One router carrying both `/events*` and `/event-subscriptions*` path
 * families — mounted at `/api` in app.ts, after every more-specific router.
 * Everything is org-scoped off `c.var.user.orgId`; cross-org rows 404, never
 * 403 (same "an owned row and a missing row are indistinguishable" rule as
 * `routes/workflows.ts`). Inside that org scope, the feed and the
 * subscriptions list both take an optional `?ownerType=&ownerId=` pair that
 * narrows to one workspace — each of them to that workspace plus the org's
 * own rows, so a subscription the list shows and an event that subscription
 * received are never in different workspaces. See the two docstrings
 * below. Subscription bodies are validated against the merged plugin
 * trigger catalog before any row is written — the ingest matcher
 * (`events/ingest.ts`) trusts the `event_keys`/`filters` jsonb shapes this
 * file writes.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, desc, eq, exists, gte, or, sql, type SQL } from "drizzle-orm";
import type { EventCatalogEntry, ValetPlugin } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import { readOwnerFilter } from "./_owner-filter.js";
import { catalogForService } from "../events/ingest.js";
import { eventKeyMatches, filtersMatch, type SubscriptionFilter } from "../events/match.js";
import { ownedDefinitionRow } from "../workflows/service.js";
import { isTeamMember } from "../services/teams.js";
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
 * Who may change an existing subscription. The rule is "you can change what
 * you could have created": an org one is org-wide by construction, a team
 * one belongs to its members, and a personal one to its owner. A caller who
 * fails this gets the same 404 as a missing row, so a subscription id never
 * confirms a team the caller is not on.
 *
 * Visibility is a different rule, and it changed on 2026-08-24 (small-fixes
 * design, decision 1). The list scopes to the owner the caller names in
 * `?ownerType=&ownerId=`, which the web page fills from the nav's workspace
 * switcher, PLUS every org-owned row. The personal workspace lists your own
 * subscriptions and the org's; a team workspace lists that team's and the
 * org's. Org-owned rows join every workspace because an org-owned
 * subscription is org-wide by construction — this route creates one for a
 * target of `orchestrator: "org"` — and a row that appears in no workspace
 * could never be disabled or deleted from the page that created it. A
 * colleague's personal row still does not join, which is the point of the
 * filter. A caller who sends no owner gets every subscription in the org,
 * which is what the list did for every caller before that date. The
 * org-wide default is safe to keep because the rows were already
 * org-visible; the filter answers "whose automations am I looking at", not
 * "what may I see". This gate stays mutation-only, so a colleague's
 * personal subscription is still un-toggleable when an unscoped list shows
 * it.
 */
async function canMutateSubscription(
  db: AppDb,
  row: { ownerType: "user" | "team" | "org"; ownerId: string },
  userId: string,
): Promise<boolean> {
  if (row.ownerType === "org") return true;
  if (row.ownerType === "team") return isTeamMember(db, row.ownerId, userId);
  return row.ownerId === userId;
}

const FILTER_OPS = ["eq", "in", "prefix", "contains"] as const;
// `signal` (wake parked workflow runs) is deliberately NOT accepted yet:
// no workflow node parks on the `event:{key}` signal shape the dispatcher
// would emit, so a signal-target subscription would validate and then
// silently never fire. Re-add once a waitForEvent node exists.
const TARGET_KINDS = ["workflow", "orchestrator"] as const;

const FEED_DEFAULT_LIMIT = 50;
const FEED_MAX_LIMIT = 100;

/**
 * How far back the OWNER-FILTERED feed looks.
 *
 * The unfiltered feed needs no window: `events_org_received` covers
 * `(org_id, received_at)`, so `LIMIT 50` reads fifty index entries and
 * stops. The owner filter rejects candidates that no index can pre-select,
 * so a workspace whose subscriptions have matched nothing walks the org's
 * whole event history to fill a page it can never fill. Measured on 40,000
 * events: 40,000 semi-join loops and 200,689 buffer hits for one empty
 * page, against 1,001 loops and 5,026 hits with this bound.
 *
 * A lower bound on `received_at` joins the same index condition, which is
 * why it is the cheapest bound available. The cost is real and stated: a
 * workspace whose newest matching event is older than this window sees an
 * empty feed. `components/events/feed.tsx` names the window in its empty
 * state and beside a scoped list, and "All" carries no window at all.
 * Change the two together.
 */
const OWNER_FEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  if (target.kind === "orchestrator") {
    const who = target.orchestrator;
    if (who !== undefined && who !== "user" && who !== "team" && who !== "org") {
      return `unknown target orchestrator: ${String(who)}`;
    }
    // `orchestrator` and `teamId` are one choice expressed in two fields, so
    // each is refused without the other. A team target with no id names no
    // team; a teamId on a user or org target names a team the delivery would
    // never reach, and would read as if it did.
    if (who === "team" && (typeof target.teamId !== "string" || target.teamId.length === 0)) {
      return "team orchestrator target requires teamId";
    }
    if (who !== "team" && target.teamId !== undefined) {
      return "teamId is only valid when orchestrator is team";
    }
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

/**
 * The feed keeps its org-wide meaning and gains an optional owner filter
 * (small-fixes design, decision 2). The `events` table has no owner column
 * and gains none: an event is an org-level fact, and a row that matched
 * nothing you own is exactly the row you open to answer "why did my
 * subscription never fire". The web page therefore sends the owner for its
 * default "This workspace" state and drops it for "All".
 *
 * The filter reads ownership one join away, through the deliveries the
 * dispatcher wrote for this event. `event_deliveries_event` indexes the
 * join column and the subscription lookup is by primary key, so the
 * `EXISTS` costs one index probe per candidate row. An event with no
 * deliveries at all matches no owner, which is correct: nobody's
 * subscription acted on it.
 *
 * The owner predicate is the SAME union the subscriptions list uses: the
 * named owner's rows, or the org's own. The two surfaces are read side by
 * side — one tab lists the subscriptions, the other lists what they
 * received — so a difference between them reads as a bug in the page. Drop
 * the org branch here and an org-owned subscription is listed in a
 * workspace whose feed hides every event it acted on.
 *
 * The probe is cheap; the NUMBER of probes is not, because the `LIMIT` no
 * longer stops the scan early when nothing matches. The filtered query
 * therefore also carries the `OWNER_FEED_WINDOW_MS` lower bound — see that
 * constant for the measurement and for what the window costs the reader.
 */
eventsRouter.get("/events", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const service = c.req.query("service");
  const key = c.req.query("key");
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, FEED_MAX_LIMIT) : FEED_DEFAULT_LIMIT;

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);

  const conditions = [eq(events.orgId, user.orgId)];
  if (service) conditions.push(eq(events.service, service));
  if (key) conditions.push(eq(events.eventKey, key));
  if (filter.owner) {
    const owner = filter.owner;
    // Bounds the rows the semi-join examines. The unfiltered feed keeps
    // the org's whole history.
    conditions.push(gte(events.receivedAt, Date.now() - OWNER_FEED_WINDOW_MS));
    conditions.push(
      exists(
        db
          .select({ present: sql<number>`1` })
          .from(eventDeliveries)
          .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
          .where(
            and(
              eq(eventDeliveries.eventId, events.id),
              // The org predicate repeats the outer query's scope inside
              // the subquery, so the join cannot reach a subscription row
              // from another org even if a delivery ever crossed one.
              eq(eventSubscriptions.orgId, user.orgId),
              or(
                and(
                  eq(eventSubscriptions.ownerType, owner.type),
                  eq(eventSubscriptions.ownerId, owner.id),
                ),
                // Org-owned subscriptions belong to every workspace, so
                // the events they received do too.
                eq(eventSubscriptions.ownerType, "org"),
              ),
            ),
          ),
      ),
    );
  }

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

  // Orchestrator targets choose the owning orchestrator: the caller's own
  // (the default), a team they are on, or the org's. The owner decides which
  // default assistant the dispatcher delivers into, so a team target is the
  // whole reason a team can be event-driven at all.
  //
  // Membership, not team-admin, is the bar — the same bar team workflows and
  // team sessions already use. A subscription is automation the team shares,
  // and a member who can start a team workflow by hand can equally arrange
  // for an event to start it.
  let ownerType: "user" | "team" | "org" = "user";
  let ownerId = user.id;
  if (body.target.kind === "orchestrator") {
    const who = body.target.orchestrator ?? "user";
    if (who === "org") {
      ownerType = "org";
      ownerId = user.orgId;
    } else if (who === "team") {
      // `validateSubscription` already refused a team target with no teamId.
      const teamId = body.target.teamId as string;
      if (!(await isTeamMember(db, teamId, user.id))) {
        // 404, not 403: a team the caller is not on must be indistinguishable
        // from one that does not exist — same convention as the sessions,
        // workflows and teams routes.
        return c.json({ error: "team not found" }, 404);
      }
      ownerType = "team";
      ownerId = teamId;
    }
  }

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

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);

  const conditions: (SQL | undefined)[] = [eq(eventSubscriptions.orgId, user.orgId)];
  if (filter.owner) {
    const owner = filter.owner;
    conditions.push(
      or(
        and(
          eq(eventSubscriptions.ownerType, owner.type),
          eq(eventSubscriptions.ownerId, owner.id),
        ),
        // Org-owned rows join every workspace's list. The outer `orgId`
        // predicate bounds them to the caller's own org.
        eq(eventSubscriptions.ownerType, "org"),
      ),
    );
  }

  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(...conditions))
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
  if (!row || !(await canMutateSubscription(db, row, user.id))) {
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
  if (!row || !(await canMutateSubscription(db, row, user.id))) {
    return c.json({ error: "subscription not found" }, 404);
  }

  await db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, id));
  return c.body(null, 204);
});
