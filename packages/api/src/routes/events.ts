import { getLinearIngressStatus, linearEventArmBlock } from "../services/linear-ingress.js";
/**
 * Event feed, catalog, and subscriptions CRUD (event-system plan, Task 7).
 *
 * One router carrying both `/events*` and `/event-subscriptions*` path
 * families — mounted at `/api` in app.ts, after every more-specific router.
 * Everything is org-scoped off `c.var.user.orgId`; cross-org rows 404, never
 * 403 (same "an owned row and a missing row are indistinguishable" rule as
 * `routes/workflows.ts`). Inside that org scope, the feed and the
 * subscriptions list both take an optional `?ownerType=&ownerId=` pair that
 * narrows to one workspace plus the org's own rows. Subscription bodies are
 * validated against the merged plugin trigger catalog before any row is
 * written — the ingest matcher (`events/ingest.ts`) trusts the
 * `event_keys`/`filters` jsonb shapes this file writes.
 */
import type { FilterOption, FilterOptionResolver, Principal, StoredCredential, ValetPlugin } from "@valet/engine";
import { and, desc, eq, gte, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../env.js";
import { isPinUnavailableMessage } from "../events/assistant-delivery.js";
import { computeCollisions, type CollisionReport } from "../events/collisions.js";
import { claimedThreadId } from "../events/destination.js";
import { eventDeliveryDispatchId, eventDeliveryRunId } from "../events/dispatcher.js";
import { allCatalogEntries, catalogForService, subscribableEntries } from "../events/ingest.js";
import type { SubscriptionFilter } from "../events/match.js";
import { storedAnyChannelState } from "../events/mention-scope.js";
import { validateSubscriptionWrite } from "../events/subscription-write.js";
import { existingPinChannelError, existingThreadError } from "../events/thread-policy-write.js";
import { authorizedSubscriptionMatchesEvent, isTeamAssistantRule } from "../events/team-slack-gate.js";
import type { AppDb } from "../lib/drizzle.js";
import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError } from "../services/onepassword.js";
import { isTeamMember, withAuthorizedTeamOwnership } from "../services/teams.js";
import type {
  EventDeliveryThreadRef,
  EventDeliveryWire,
  EventLogItem,
  EventLogResponse,
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  EventSubscriptionCollisionErrorWire,
  EventSubscriptionCollisionsWire,
  EventSubscriptionFilterWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  EventSummaryWire,
  FilterOptionsResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  LineActivityResponse,
  ListEventSubscriptionsResponse,
  ListSubscriptionDeliveriesResponse,
  PatchEventSubscriptionRequest,
  PatchEventSubscriptionResponse,
  RedeliverEventResponse,
} from "../wire/types.js";
import { workflowRequestContext } from "../workflows/request-context.js";
import { armableDefinitionRow, canReadWorkflowRun } from "../workflows/service.js";
import { isOrgAdminUser } from "./_org-admin.js";
import { channelsVisibleTo, threadEntry, threadsVisibleTo, viewerOf } from "./_thread-access.js";
import { orgSlackCredential, slackEventChannel, storedThreadRef } from "../services/thread-access.js";
import { loadLineActivity } from "../services/line-activity.js";
import { slackChannelNames } from "./workspace-channels.js";
import { readOwnerFilter } from "./_owner-filter.js";
import { acceptAppearanceWrite, acceptTargetWrite, readStoredTarget } from "../events/target-names.js";
import { EVENT_LOG_WINDOW_MS, lastEventLogActivity, listEventLog, supersedingDeliveries } from "../services/event-log.js";
import { eventInPlace, eventPlace, eventPlaceName, isPlaceKey, listenerRowPlace, resolveSlackTeam } from "../services/presence-places.js";

export const eventsRouter = new Hono<AppEnv>();

/**
 * Who may change an existing subscription. The rule is "you can change what
 * you could have created": an org one is org-wide by construction, a team
 * one belongs to its members, and a personal one to its owner. A caller who
 * fails this gets the same 404 as a missing row, so a subscription id never
 * confirms a team the caller is not on.
 *
 * Mutation only. Visibility is a separate, wider rule — see the list route
 * below.
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

const FEED_DEFAULT_LIMIT = 50;
const FEED_MAX_LIMIT = 100;


/** The jsonb columns come back `unknown`; their shapes are owned by
 * `validateSubscriptionWrite` (`events/subscription-write.ts`), the one gate
 * in front of every write to this table. */
export function rowToSubscription(row: typeof eventSubscriptions.$inferSelect): EventSubscriptionWire {
  return {
    id: row.id,
    name: row.name,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    eventKeys: row.eventKeys as string[],
    filters: row.filters as EventSubscriptionFilterWire[],
    // Stored rows may carry the old names (spec 2026-10-16: presence hub,
    // Part H); reads emit the new ones.
    target: readStoredTarget(row.target) as EventSubscriptionTargetWire,
    // Only a team assistant rule has an audience, so only those rows carry
    // one on the wire. Filling it everywhere would hand a read-modify-write
    // client a field the write path refuses on its own target. Null on such a
    // row reads as `team`: the resolved value goes out, so no reader has to
    // know the default.
    ...(isTeamAssistantRule(row.ownerType, row.target)
      ? { audience: row.audience ?? ("team" as const) }
      : {}),
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Each listed rule's open problem, in one query (spec 2026-10-16: presence
 * hub, Part C step 5). The source is the rule's latest settled delivery
 * (`delivered` or `dead`) created since the rule's last edit. A rule has a
 * problem when that delivery dead-lettered on its pin. A later delivery that
 * landed, or an edit such as a new pin, answers it.
 */
export async function subscriptionProblems(db: AppDb, conditions: (SQL | undefined)[]): Promise<Map<string, string>> {
  const latest = await db
    .selectDistinctOn([eventDeliveries.subscriptionId], {
      subscriptionId: eventDeliveries.subscriptionId,
      status: eventDeliveries.status,
      lastError: eventDeliveries.lastError,
    })
    .from(eventDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .where(and(
      ...conditions,
      inArray(eventDeliveries.status, ["delivered", "dead"]),
      gte(eventDeliveries.createdAt, eventSubscriptions.updatedAt),
    ))
    .orderBy(eventDeliveries.subscriptionId, desc(eventDeliveries.createdAt), desc(eventDeliveries.id));
  const problems = new Map<string, string>();
  for (const d of latest) {
    if (d.status === "dead" && d.lastError !== null && isPinUnavailableMessage(d.lastError)) problems.set(d.subscriptionId, d.lastError);
  }
  return problems;
}

/**
 * A rule on the wire with its open problem and its `placeKey`: the overview
 * row the places read lists it at (`listenerRowPlace`). A Slack line gets no
 * `placeKey` while the org's Slack workspace is unknown, because its row key
 * names that workspace.
 */
export function subscriptionToWire(
  row: typeof eventSubscriptions.$inferSelect, problems: ReadonlyMap<string, string>, slackTeam: string | null,
): EventSubscriptionWire {
  const problem = problems.get(row.id);
  const placeKey = listenerRowPlace(row, slackTeam ?? "?");
  const known = placeKey !== null && !(slackTeam === null && placeKey.startsWith("slack:"));
  return { ...rowToSubscription(row), ...(problem ? { problem } : {}), ...(known ? { placeKey } : {}) };
}

/**
 * The org's Slack workspace id, from its bot credential, or null. A read
 * that fails reads as none, so a transient credential fault degrades a
 * Slack label or row key instead of failing the whole read.
 */
export async function orgSlackTeam(providers: Parameters<typeof orgSlackCredential>[0], orgId: string): Promise<string | null> {
  try {
    const teamId = (await orgSlackCredential(providers, orgId))?.metadata?.teamId;
    return typeof teamId === "string" && teamId !== "" ? teamId : null;
  } catch (err) {
    console.error("[events] reading the org's Slack credential failed", err);
    return null;
  }
}

/** `refs`/`actor` jsonb shapes are owned by the ingest writer
 * (`events/ingest.ts`), which only stores `NormalizedEvent` fields. */
export function rowToEventSummary(row: typeof events.$inferSelect): EventSummaryWire {
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

/** A stored row with its jsonb columns narrowed to the shapes the one write
 * gate (`validateSubscriptionWrite`) persists — what `computeCollisions`
 * compares against. */
type NarrowedSubscriptionRow = Omit<
  typeof eventSubscriptions.$inferSelect,
  "eventKeys" | "filters" | "target"
> & {
  eventKeys: string[];
  filters: SubscriptionFilter[];
  target: EventSubscriptionTargetWire;
};

/**
 * Why a replacement cannot turn on, and how the reviewer recovers. The
 * message never says to turn the replaced version back on: that version's
 * history (a successor, a later version that replaced the successor, a
 * rollback) decides whether doing so leaves two versions replying, and the
 * rows do not keep that history reliably. It sends the reviewer to the
 * version that replies now.
 */
function staleReplacement(replaced: { name: string } | undefined): string {
  if (replaced === undefined) {
    return "This proposal replaces a line that was removed. Delete this proposal, then ask the assistant for a new one.";
  }
  return `This proposal replaces "${replaced.name}", which is off, so enabling it could leave two versions replying. ` +
    "Delete this proposal. To change the version that replies now, ask the assistant for a new proposal that replaces it.";
}

/** Another enable turned the replaced version off first; rolls this enable back. */
class StaleReplacementError extends Error {}

/** After an enable turned `replacedId` off: the link is cleared and its ID
 * recorded as `replaced`, so the link acts once and a retry can see it did. */
function spendReplacement(target: EventSubscriptionTargetWire, replacedId: string | undefined): EventSubscriptionTargetWire {
  if (replacedId === undefined || target.kind !== "assistant") return target;
  const { replaces: _link, ...rest } = target;
  return { ...rest, replaced: replacedId };
}

/** The target without a replacement link or its record (`events.propose_subscription`'s `replaces`). */
function withoutReplaces(target: EventSubscriptionTargetWire): EventSubscriptionTargetWire {
  if (target.kind !== "assistant" || (target.replaces === undefined && target.replaced === undefined)) return target;
  const { replaces: _link, replaced: _record, ...rest } = target;
  return rest;
}

/**
 * The collision report for one candidate write (TKAI-294): the candidate
 * compared against every ENABLED subscription in the org, minus the rows the
 * write leaves off: the row being edited, and the row an enabled replacement
 * disables. Disabled rows do not fire, so they cannot collide; enabling
 * one later re-runs this check (see the PATCH route).
 */
async function collisionsForWrite(
  db: AppDb,
  plugins: ValetPlugin[],
  orgId: string,
  candidate: { ownerType?: string; eventKeys: string[]; filters: SubscriptionFilter[]; target: EventSubscriptionTargetWire },
  excludeIds: readonly string[] = [],
): Promise<CollisionReport<NarrowedSubscriptionRow>> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
  const existing: NarrowedSubscriptionRow[] = rows
    .filter((r) => !excludeIds.includes(r.id))
    .map((r) => ({
      ...r,
      eventKeys: r.eventKeys as string[],
      filters: r.filters as SubscriptionFilter[],
      target: readStoredTarget(r.target) as EventSubscriptionTargetWire,
    }));
  return computeCollisions(candidate, existing, allCatalogEntries(plugins));
}

function collisionsToWire(report: CollisionReport<NarrowedSubscriptionRow>): EventSubscriptionCollisionsWire {
  const toWire = (c: CollisionReport<NarrowedSubscriptionRow>["blocking"][number]) => ({
    subscription: rowToSubscription(c.subscription),
    relation: c.relation,
    sharedKeys: c.sharedKeys,
  });
  return { blocking: report.blocking.map(toWire), overlapping: report.overlapping.map(toWire) };
}

/** The 409 headline for a blocked write. Names the rules it steps on and the
 * two ways out, since `errorText` may be all a caller renders. `way` names the
 * write, so the text quotes the button the caller shows for it: a create's
 * "Create anyway", a switch's "Turn on anyway", an edit's "Save anyway". */
function collisionBlockMessage(
  report: CollisionReport<NarrowedSubscriptionRow>,
  way: "create" | "turn-on" | "save",
): string {
  const names = report.blocking.map((c) => `"${c.subscription.name}"`).join(", ");
  const out =
    way === "create" ? `choose "Create anyway" to keep both.`
    : way === "turn-on" ? `turn it on with "Turn on anyway".`
    : `save again with "Save anyway".`;
  return (
    `This line covers everything ${names} already ${report.blocking.length === 1 ? "handles" : "handle"} ` +
    `on the same events, so both would fire together. Narrow its filters, or ${out}`
  );
}

// ── Catalog ─────────────────────────────────────────────────────────────────

// The subscription editor reads this catalog, so it leaves out derived keys,
// which subscriptions do not accept (event wakeups spec, Part G).
eventsRouter.get("/events/catalog", async (c) => {
  const { plugins, db, engineCredentials } = c.var.providers;
  const services = [...new Set(plugins.flatMap((p) => p.triggers ?? []).map((t) => t.service))];
  const linear = services.includes("linear") ? await getLinearIngressStatus(db,engineCredentials,c.var.user.orgId) : undefined;
  const resp: GetEventCatalogResponse = {
    services: services.map((service) => ({ service, entries: subscribableEntries(catalogForService(plugins, service)), ...(service === "linear" && linear ? { readiness: { ready: linear.ready, ...(linear.reason ? { reason: linear.reason } : {}) } } : {}) })),
  };
  return c.json(resp);
});

// ── Filter options ────────────────────────────────────────────────────────

/** The plugin (its `name` is the credential service) and resolver for a source. */
function resolverForSource(
  plugins: ValetPlugin[],
  source: string,
): { plugin: ValetPlugin; resolver: FilterOptionResolver } | null {
  for (const plugin of plugins) {
    const resolver = plugin.filterOptionResolvers?.[source];
    if (resolver) return { plugin, resolver };
  }
  return null;
}

/** The `dependsOn` a catalog field declares for this source (`["repo"]`), or empty. */
function dependsOnForSource(plugins: ValetPlugin[], source: string): string[] {
  for (const entry of allCatalogEntries(plugins)) {
    for (const field of entry.filters) {
      if (field.options?.source === source) return field.options.dependsOn ?? [];
    }
  }
  return [];
}

/** Per-(org, source, deps, q) memo so a keystroke does not re-hit the provider. */
const FILTER_OPTIONS_TTL_MS = 60_000;
const FILTER_OPTIONS_CACHE_CAP = 500;
// The whole answer, `reason` included: a hit without the reason turned the
// picker into a search box with no free-text way out.
const filterOptionsCache = new Map<string, { resp: FilterOptionsResponse; expiresAt: number }>();

/**
 * Lists the options for one filter field's source, so a rule filters on a
 * looked-up name, not a raw id. Dispatches to the owning plugin's resolver,
 * scoped by the org's credential for that plugin's service, and memoized with a
 * short TTL. An unknown source, an unconnected integration, or a provider error
 * returns `{ options: [], reason }` (200) — never an error status — so the
 * picker degrades to free text instead of breaking the form.
 */
eventsRouter.get("/events/filter-options", async (c) => {
  const user = c.var.user;
  const { plugins, engineCredentials, onePassword } = c.var.providers;
  const source = c.req.query("source");
  if (!source) return c.json({ error: "source query parameter is required" }, 400);

  const found = resolverForSource(plugins, source);
  if (!found) {
    const resp: FilterOptionsResponse = { options: [], reason: `unknown option source: ${source}` };
    return c.json(resp);
  }

  const deps: Record<string, string> = {};
  for (const dep of dependsOnForSource(plugins, source)) {
    const value = c.req.query(dep);
    if (value) deps[dep] = value;
  }
  const q = c.req.query("q") || undefined;

  const cacheKey = `${user.orgId}:${source}:${JSON.stringify(deps)}:${q ?? ""}`;
  const cached = filterOptionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.resp);
  }

  // The plugin name is its credential service (slack/github/linear).
  // Through the resolver, not the raw row: an admin's 1Password reference
  // carries no secret until it is resolved, and a raw read handed the
  // resolver an empty credential and returned no options. A missing or
  // unresolvable credential is a normal outcome here (empty options), so a
  // typed 1Password failure reads as none.
  let credential: StoredCredential | null;
  try {
    credential = await resolveOrgCredentialRead(
      { credentials: engineCredentials, onePassword },
      { orgId: user.orgId, scopes: ["org"] },
      found.plugin.name,
    );
  } catch (err) {
    if (!(err instanceof OnePasswordAuthError)) throw err;
    credential = null;
  }

  let options: FilterOption[] = [];
  let reason: string | undefined;
  let failed = false;
  try {
    options = await found.resolver({ orgId: user.orgId, q, deps, credential });
  } catch (err) {
    console.error(`[events] filter-options resolver ${source} failed`, err);
    reason = "The provider could not list options right now. Type the value instead.";
    failed = true;
  }
  if (options.length === 0 && reason === undefined && credential === null) {
    reason = "Connect the integration on the Integrations page to choose from a list. Type the value instead.";
  }

  // Never memoize a failed lookup. A provider that rate-limits one keystroke
  // would otherwise answer the next minute of retries from an empty cache
  // entry, so the user sees a stable "no options" for a transient fault and
  // cannot retry their way out of it.
  //
  // Deliberately NOT replaced by a short negative TTL. Rate-limit backpressure
  // belongs to the provider read, not here: the Slack resolvers hold their
  // directory in a single-flight cache, so a scan that is failing has exactly
  // one attempt in flight per workspace no matter how fast the reader types
  // (`plugin-slack/src/transport/directory-cache.ts`). Caching the failure
  // here would only re-introduce the sticky "no matches" without adding a
  // bound the provider layer does not already give.
  const resp: FilterOptionsResponse = reason === undefined ? { options } : { options, reason };
  if (!failed) {
    // Evict the oldest single entry (Map preserves insertion order), not the
    // whole cache — one org's typeahead must not flush every other org's.
    if (filterOptionsCache.size >= FILTER_OPTIONS_CACHE_CAP) {
      const oldest = filterOptionsCache.keys().next().value;
      if (oldest !== undefined) filterOptionsCache.delete(oldest);
    }
    filterOptionsCache.set(cacheKey, { resp, expiresAt: Date.now() + FILTER_OPTIONS_TTL_MS });
  }

  return c.json(resp);
});

/**
 * `GET /api/events/log` — a workspace's stored events and the organization's
 * recorded problems in one timeline. `problems=1` keeps failed events and
 * problems only. `place=<key>` keeps the events whose place is that key or
 * inside it, and no problems. Registered before `/events/:id` so the literal path wins.
 */
eventsRouter.get("/events/log", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const limit = readLimit(c.req.query("limit"), FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
  if (limit === undefined) return c.json({ error: "limit must be a whole number of 1 or more" }, 400);
  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error || !filter.owner) return c.json({ error: filter.error ?? "Send ownerType and ownerId for the workspace whose Log to read." }, 400);
  const owner = filter.owner;
  const problemsOnly = c.req.query("problems") === "1";
  const diagnostics = c.req.query("diagnostics") === "1";
  const q = c.req.query("q")?.trim() || undefined;
  if (q && q.length > 200) return c.json({ error: "q must be 200 characters or fewer" }, 400);
  const place = c.req.query("place")?.trim() || undefined;
  if (place && !isPlaceKey(place)) {
    return c.json({ error: "place must be a place key, such as slack:T1/C1 or github:acme/api. Open the place in Presence and choose View all." }, 400);
  }
  const scopeKey = JSON.stringify([owner, problemsOnly, diagnostics, q ?? null, place ?? null]);
  const rawCursor = c.req.query("cursor");
  const decoded = rawCursor === undefined ? undefined : decodePageCursor(rawCursor);
  const before = decoded && decoded.orgId === user.orgId && decoded.scope === scopeKey &&
    typeof decoded.at === "number" && Number.isSafeInteger(decoded.at) && typeof decoded.id === "string"
    ? { at: decoded.at, id: decoded.id } : undefined;
  if (rawCursor !== undefined && !before) return c.json({ error: "The page cursor is not valid for these filters. Reload Activity and try again." }, 400);

  const admin = await isOrgAdminUser(c);
  const keepEvents = place
    ? async (ids: readonly string[]): Promise<ReadonlySet<string>> => {
      if (ids.length === 0) return new Set();
      // A scan reads up to 20 batches, so it leaves the payload column
      // behind. The place plugins' `naturalSubject` (GitHub, Linear, Slack)
      // reads only `subjects` and `refs`. A plugin that reads its payload
      // to name a place needs that column added here.
      const rows = await db.select({
        id: events.id, orgId: events.orgId, service: events.service, eventKey: events.eventKey, dedupeKey: events.dedupeKey,
        actor: events.actor, refs: events.refs, summary: events.summary, occurredAt: events.occurredAt,
        receivedAt: events.receivedAt, subjects: events.subjects,
      }).from(events).where(and(eq(events.orgId, user.orgId), inArray(events.id, [...ids])));
      return new Set(rows.filter((row) => eventInPlace(c.var.providers.plugins, { ...row, payload: null }, place)).map((row) => row.id));
    }
    : undefined;
  const { items, next } = await listEventLog(db, {
    // A problem names no place, so a place filter keeps events only.
    orgId: user.orgId, owner, admin, limit, problemsOnly, diagnostics: diagnostics && !place,
    ...(q ? { q } : {}), ...(before ? { before } : {}), ...(keepEvents ? { keepEvents } : {}),
    channelVisible: channelsVisibleTo(c),
  });
  const resp: EventLogResponse = {
    items: await withPlacesAndDeliveries(c, items, owner),
    // A page that scanned only rows this viewer may not see is empty, and
    // its cursor still reads on from where the scan stopped.
    nextCursor: next ? encodePageCursor({ orgId: user.orgId, scope: scopeKey, at: next.at, id: next.id }) : null,
    lastEventAt: await lastEventLogActivity(db, user.orgId, admin, diagnostics),
    windowDays: EVENT_LOG_WINDOW_MS / (24 * 60 * 60 * 1000),
  };
  return c.json(resp);
});

/**
 * Each stored event on a Log page with its place and its deliveries, so the
 * Activity tab reads the row as one sentence
 * (docs/specs/2026-10-16-presence-hub-design.md Part E step 1). The
 * deliveries are the ones the Log counts: this workspace's rules and the
 * org's. A problem row stays as it is.
 */
async function withPlacesAndDeliveries(c: Context<AppEnv>, items: EventLogItem[], owner: Principal): Promise<EventLogItem[]> {
  const ids = items.filter((item) => item.kind === "event").map((item) => item.id);
  if (ids.length === 0) return items;
  const { db, plugins } = c.var.providers;
  const orgId = c.var.user.orgId;
  const eventRows = await db.select().from(events).where(and(eq(events.orgId, orgId), inArray(events.id, ids)));
  const places = new Map<string, { key: string; label: string }>();
  for (const row of eventRows) {
    const place = eventPlace(plugins, row);
    if (place !== null) places.set(row.id, place);
  }
  const deliveryRows = await db
    .select({
      eventId: eventDeliveries.eventId,
      id: eventDeliveries.id,
      subscriptionId: eventDeliveries.subscriptionId,
      subscriptionName: eventSubscriptions.name,
      status: eventDeliveries.status,
      attempts: eventDeliveries.attempts,
      lastError: eventDeliveries.lastError,
      deliveredAt: eventDeliveries.deliveredAt,
      nextAttemptAt: eventDeliveries.nextAttemptAt,
      createdAt: eventDeliveries.createdAt,
      destination: eventDeliveries.destination,
      target: eventSubscriptions.target,
    })
    .from(eventDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .where(and(
      inArray(eventDeliveries.eventId, ids),
      eq(eventSubscriptions.orgId, orgId),
      or(and(eq(eventSubscriptions.ownerType, owner.type), eq(eventSubscriptions.ownerId, owner.id)), eq(eventSubscriptions.ownerType, "org")),
    ))
    .orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id));
  const wire = await deliveriesToWire(c, deliveryRows);
  // A dead row that a later delivery settled names it, so the web drops the fault.
  const superseded = supersedingDeliveries(deliveryRows);
  const byEvent = new Map<string, EventDeliveryWire[]>();
  deliveryRows.forEach((row, index) => {
    const list = byEvent.get(row.eventId) ?? [];
    const settledBy = superseded.get(row.id);
    list.push(settledBy !== undefined ? { ...wire[index]!, supersededBy: settledBy } : wire[index]!);
    byEvent.set(row.eventId, list);
  });
  // A skipped row's detail is one of its deliveries' raw skip text. A claim
  // names the claiming thread's id, so the detail takes the delivery's
  // shown text, which withholds a thread this request may not open.
  const shownDetail = new Map<string, string | null>();
  deliveryRows.forEach((row, index) => {
    if (row.lastError !== null) shownDetail.set(`${row.eventId}\n${row.lastError}`, wire[index]!.lastError);
  });
  return items.map((item) => {
    if (item.kind !== "event") return item;
    const place = places.get(item.id);
    const detail = item.detail === null ? null
      : shownDetail.get(`${item.id}\n${item.detail}`) ?? (CLAIM_DETAIL.test(item.detail) ? CLAIMED_ELSEWHERE : item.detail);
    return {
      ...item, detail, ...(place !== undefined ? { place: place.label, placeKey: place.key } : {}), deliveries: byEvent.get(item.id) ?? [],
    };
  });
}

/** The raw skip text of a claimed delivery, which names the claiming thread's id. */
const CLAIM_DETAIL = /^Skipped, claimed by thread /;

/** Whether this request may see an event. A Slack event from a private
 * channel shows only to the channel's members (`services/thread-access.ts`),
 * because its payload carries the message. Anyone else gets the same 404 as
 * a missing event. */
async function eventVisibleTo(c: Context<AppEnv>, row: { service: string; refs: unknown; payload: unknown }): Promise<boolean> {
  const channel = slackEventChannel(row);
  return channel === undefined || channelsVisibleTo(c)(`slack:${channel}`);
}

/**
 * The assistant thread each delivery was admitted to, by delivery id. The
 * dispatcher admits a delivery under `eventDeliveryDispatchId`, and the engine
 * keeps that id on the queue item, so one query finds every thread. A thread
 * stays only when this request may open it at `/threads/:threadId`
 * (`routes/threads.ts`), by the same two checks: `threadEntry` (a viewer of
 * the session, or a member the thread's share admits), then `threadsVisibleTo`
 * on the thread's key.
 */
async function deliveryThreads(
  c: Context<AppEnv>,
  readable: ThreadChecker,
  deliveryIds: string[],
): Promise<Map<string, EventDeliveryThreadRef>> {
  const found = new Map<string, EventDeliveryThreadRef>();
  if (deliveryIds.length === 0) return found;
  const { db } = c.var.providers;
  const byDispatchId = new Map(deliveryIds.map((id) => [eventDeliveryDispatchId(id), id]));
  const result = await db.execute(sql`
    SELECT q.dispatch_id, q.session_id, q.thread_id, t.key, s.org_id, s.status, s.user_id, s.owner_type, s.owner_id,
      st.title, (st.archived_at IS NOT NULL) AS archived
    FROM engine_queue_items q
    JOIN agent_sessions s ON s.id = q.session_id
    JOIN engine_threads t ON t.session_id = q.session_id AND t.id = q.thread_id
    LEFT JOIN session_threads st ON st.session_id = t.session_id AND st.id = t.id
    WHERE q.dispatch_id IN (${sql.join([...byDispatchId.keys()].map((id) => sql`${id}`), sql`, `)})
      AND s.org_id = ${c.var.user.orgId} AND s.status <> 'deleted'
    ORDER BY q.created_at`) as {
    rows: Array<ThreadAccessRow & { dispatch_id: string }>;
  };
  for (const row of result.rows) {
    const deliveryId = byDispatchId.get(row.dispatch_id);
    if (deliveryId === undefined || found.has(deliveryId)) continue;
    const ref = await readable(row);
    if (ref) found.set(deliveryId, ref);
  }
  return found;
}

/** A thread row with the session columns the thread access checks read,
 * and the thread's title and archived state. Raw SQL rows are untyped; the
 * SELECTs above name these columns. */
interface ThreadAccessRow {
  session_id: string; thread_id: string; key: string;
  org_id: string; status: string; user_id: string; owner_type: string; owner_id: string;
  title: string | null; archived: boolean | null;
}

/**
 * A checker that returns a thread's reference when this request may open it
 * at `/threads/:threadId` (`routes/threads.ts`), by the same two checks:
 * `threadEntry` (a viewer of the session, or a member the thread's share
 * admits), then `threadsVisibleTo` on the thread's key. It remembers each
 * thread's answer for the life of the checker.
 */
type ThreadChecker = (row: ThreadAccessRow) => Promise<EventDeliveryThreadRef | null>;

function readableThreads(c: Context<AppEnv>): ThreadChecker {
  const seen = new Map<string, Promise<EventDeliveryThreadRef | null>>();
  return (row) => {
    const key = `${row.session_id}:${row.thread_id}`;
    let answer = seen.get(key);
    if (!answer) {
      answer = (async () => {
        const session = { id: row.session_id, orgId: row.org_id, status: row.status, userId: row.user_id, ownerType: row.owner_type, ownerId: row.owner_id };
        if (!await threadEntry(c, session, row.thread_id)) return null;
        if (!await threadsVisibleTo(c, session)(await storedThreadRef(c.var.providers.db, row.session_id, row.thread_id, row.key))) return null;
        return {
          sessionId: row.session_id, threadId: row.thread_id,
          ...(row.title ? { title: row.title } : {}),
          ...(row.archived === true ? { archived: true as const } : {}),
        };
      })();
      seen.set(key, answer);
    }
    return answer;
  };
}

/** The skip text for a viewer who may not open the thread that claimed the delivery. */
const CLAIMED_ELSEWHERE = "Skipped, claimed by another thread.";

/**
 * The thread whose waiter claimed each skipped delivery, by delivery id
 * (spec 2026-10-16: delivery threads and claims, Part E step 2). The
 * delivery's destination stamp names the thread. A thread stays only when
 * this request may open it, by the shared `readableThreads` checker.
 */
async function claimThreads(
  c: Context<AppEnv>,
  check: ThreadChecker,
  claims: Array<{ deliveryId: string; threadId: string }>,
): Promise<Map<string, EventDeliveryThreadRef>> {
  const found = new Map<string, EventDeliveryThreadRef>();
  if (claims.length === 0) return found;
  const threadIds = [...new Set(claims.map((claim) => claim.threadId))];
  const result = await c.var.providers.db.execute(sql`
    SELECT t.id AS thread_id, t.session_id, t.key, s.org_id, s.status, s.user_id, s.owner_type, s.owner_id,
      st.title, (st.archived_at IS NOT NULL) AS archived
    FROM engine_threads t
    JOIN agent_sessions s ON s.id = t.session_id
    LEFT JOIN session_threads st ON st.session_id = t.session_id AND st.id = t.id
    WHERE t.id IN (${sql.join(threadIds.map((id) => sql`${id}`), sql`, `)})
      AND s.org_id = ${c.var.user.orgId} AND s.status <> 'deleted'`) as {
    rows: ThreadAccessRow[];
  };
  const readable = new Map<string, EventDeliveryThreadRef>();
  for (const row of result.rows) {
    const ref = await check(row);
    if (ref) readable.set(row.thread_id, ref);
  }
  for (const claim of claims) {
    const thread = readable.get(claim.threadId);
    if (thread) found.set(claim.deliveryId, thread);
  }
  return found;
}

/** The workflow run each delivery started, by delivery id, when this request
 * may open it: the check the run page applies (`canReadWorkflowRun`). A
 * delivery that started no run has no run to read. */
async function deliveryRuns(c: Context<AppEnv>, deliveryIds: string[]): Promise<Map<string, string>> {
  const { deps, owner } = workflowRequestContext(c);
  const runs = deliveryIds.map((id) => [id, eventDeliveryRunId(id)] as const);
  const readable = await Promise.all(runs.map(([, runId]) => canReadWorkflowRun(deps, owner, runId)));
  return new Map(runs.filter((_, index) => readable[index]));
}

/** The delivery columns `deliveriesToWire` reads, joined with the rule's
 * name and target. */
interface DeliveryRow {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  status: EventDeliveryWire["status"];
  attempts: number;
  lastError: string | null;
  deliveredAt: number | null;
  nextAttemptAt: number;
  destination: unknown;
  target: unknown;
}

/** Delivery rows on the wire, each with the thread, claiming thread, or run
 * it reached when this request may open it. Shared by the event page and a
 * listener's delivery list, so the two never drift. */
async function deliveriesToWire(c: Context<AppEnv>, deliveryRows: readonly DeliveryRow[]): Promise<EventDeliveryWire[]> {
  // `target` is validated jsonb, the same narrowing as `rowToSubscription`.
  const idsFor = (kind: EventSubscriptionTargetWire["kind"]) =>
    deliveryRows.filter((d) => (readStoredTarget(d.target) as EventSubscriptionTargetWire).kind === kind).map((d) => d.id);
  const claims = deliveryRows.flatMap((d) => {
    const threadId = d.status === "skipped" ? claimedThreadId(d.destination) : null;
    return threadId ? [{ deliveryId: d.id, threadId }] : [];
  });
  // A page repeats threads, and a claiming thread is often a delivery's
  // thread too, so one checker answers each thread once per request.
  const readable = readableThreads(c);
  const [threads, runs, claimed] = await Promise.all([
    deliveryThreads(c, readable, idsFor("assistant")),
    deliveryRuns(c, idsFor("workflow")),
    claimThreads(c, readable, claims),
  ]);
  return deliveryRows.map((d) => {
    const thread = threads.get(d.id);
    const claimedBy = claimed.get(d.id);
    const runId = runs.get(d.id);
    return {
      id: d.id,
      subscriptionId: d.subscriptionId,
      subscriptionName: d.subscriptionName,
      status: d.status,
      attempts: d.attempts,
      // A viewer who may not open the claiming thread does not see its id.
      lastError: claims.some((claim) => claim.deliveryId === d.id) && !claimed.has(d.id) ? CLAIMED_ELSEWHERE : d.lastError,
      deliveredAt: d.deliveredAt,
      // `next_attempt_at` keeps its last value after a delivery settles: a
      // dead row holds the timestamp of the attempt that gave up, and a
      // delivered row holds its claim lease. Report it only while another
      // attempt is really coming, or the UI promises a retry that the
      // dispatcher will never make.
      nextAttemptAt: d.status === "pending" || d.status === "failed" ? d.nextAttemptAt : null,
      ...(thread ? { thread } : {}),
      ...(claimedBy ? { claimedBy } : {}),
      ...(runId ? { runId } : {}),
    };
  });
}

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
  if (!row || !(await eventVisibleTo(c, row))) return c.json({ error: "event not found" }, 404);
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
      destination: eventDeliveries.destination,
      target: eventSubscriptions.target,
    })
    .from(eventDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .where(and(eq(eventDeliveries.eventId, id), eq(eventSubscriptions.orgId, user.orgId)))
    .orderBy(desc(eventDeliveries.createdAt));
  const place = eventPlaceName(c.var.providers.plugins, row);
  const resp: GetEventResponse = {
    event: { ...rowToEventSummary(row), payload: row.payload, ...(place !== null ? { place } : {}) },
    deliveries: await deliveriesToWire(c, deliveryRows),
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
  if (!event || !(await eventVisibleTo(c, event))) return c.json({ error: "event not found" }, 404);
  const subs = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, user.orgId), eq(eventSubscriptions.enabled, true)));

  const catalog = catalogForService(plugins, event.service);
  const matched: typeof subs = [];
  for (const sub of subs) {
    if (await authorizedSubscriptionMatchesEvent(db, sub, event.eventKey, event.payload, catalog, event.subjects ?? undefined)) matched.push(sub);
  }

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
  // Rename the old target names before anything reads the target (spec
  // 2026-10-16: presence hub, Part H). The cast is the same unchecked
  // narrowing as the body's: `validateSubscriptionWrite` below checks it.
  const renamedTarget = acceptTargetWrite(body.target);
  if (!renamedTarget.ok) return c.json({ error: renamedTarget.error }, 400);
  body = { ...body, target: renamedTarget.target as EventSubscriptionTargetWire };

  const write = await validateSubscriptionWrite(
    db,
    plugins,
    { ...body, filters: body.filters ?? [] },
    { creatorUserId: user.id, anyChannel: body.anyChannel === true, matchChanged: true },
  );
  if (!write.ok) return c.json({ error: write.error }, 400);
  const filters = write.filters;
  // Absent stays null in the row, so an untouched rule keeps reading as
  // team-only however the default is spelled later.
  const audience = write.audience ?? null;

  // A workflow target must be OWNED by the caller, not only exist in their
  // org: org scope alone lets any member wire automation onto another's.
  // Foreign, unowned and missing ids fail alike, so the error never shows
  // whether the id exists. Team membership is the bar, as it is for team
  // workflows and team sessions.
  let ownerType: "user" | "team" | "org" = "user";
  let ownerId = user.id;
  if (body.target.kind === "workflow") {
    const owned = await armableDefinitionRow(db, { userId: user.id, orgId: user.orgId }, body.target.workflowId);
    if (!owned) {
      return c.json({ error: `unknown workflow: ${body.target.workflowId}` }, 400);
    }
    // The owner names the workspace; `created_by` names who armed it. Team
    // only: `canMutateSubscription` lets any org member mutate an org-owned
    // row, so copying `owned.ownerType` wholesale fails open.
    if (owned.ownerType === "team") {
      ownerType = "team";
      ownerId = owned.ownerId;
    }
  } else if (body.target.kind === "assistant") {
    const who = body.target.assistant ?? "user";
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
    // `existing` names a thread, which must belong to the owner just resolved
    // and be one the caller can read.
    const threadError = await existingThreadError(c.var.providers, viewerOf(c),
      { type: ownerType, id: ownerId }, body.target.thread, { eventKeys: body.eventKeys, filters });
    if (threadError) return c.json({ error: threadError }, 400);
  }

  // Collision gate (TKAI-294). Checked over the FINAL filters (after the
  // mention gate's injected user filter), so two users' mention rules
  // compare as the disjoint rules they are. A disabled create skips the
  // check — the row cannot fire, and enabling it later re-runs it.
  const enabled = body.enabled ?? true;
  if (enabled) {
    const ingressBlocked = await linearEventArmBlock(db,c.var.providers.engineCredentials,user.orgId,body.eventKeys);
    if (ingressBlocked) return c.json({ error: ingressBlocked },400);
  }
  let collisions: EventSubscriptionCollisionsWire | undefined;
  if (enabled) {
    const report = await collisionsForWrite(db, plugins, user.orgId, {
      ownerType,
      eventKeys: body.eventKeys,
      filters,
      target: body.target,
    });
    if (report.blocking.length > 0 && body.allowCollision !== true) {
      const resp: EventSubscriptionCollisionErrorWire = {
        error: collisionBlockMessage(report, "create"),
        collisions: collisionsToWire(report),
      };
      return c.json(resp, 409);
    }
    if (report.blocking.length > 0) {
      // The audit trail for a knowing override — a doubled delivery later
      // should be traceable to who accepted it and over which rules.
      console.warn(
        `[events] collision override: user ${user.id} created a subscription over ` +
          report.blocking.map((b) => b.subscription.id).join(", "),
      );
    }
    if (report.blocking.length > 0 || report.overlapping.length > 0) {
      collisions = collisionsToWire(report);
    }
  }

  const now = Date.now();
  const values = {
    id: randomUUID(),
    orgId: user.orgId,
    ownerType,
    ownerId,
    name: body.name,
    eventKeys: body.eventKeys,
    filters,
    // Only an assistant's proposal carries `replaces`, and only its enable
    // spends it. A direct create stores no link.
    target: withoutReplaces(body.target),
    audience,
    enabled,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };

  let insertedRow: typeof eventSubscriptions.$inferSelect | undefined;
  if (ownerType === "team") {
    // `deleteTeam` deletes a team's own event_subscriptions rows, reaps its
    // workflows, and archives its assistants — all under this same lock
    // (services/teams.ts). Without it, a create that already passed the
    // ownership/membership/assistant checks above can still insert after
    // the team (or its target workflow/assistant) is gone, landing as a
    // permanent orphan — the race #709 closed for schedules.
    const rows = await withAuthorizedTeamOwnership(
      db,
      { teamId: ownerId, orgId: user.orgId, userId: user.id, principalTeamId: null, requireMembership: true },
      async (tx) => {
        if (body.target.kind === "workflow") {
          const [targetWorkflow] = await tx
            .select({ id: workflowDefinitions.id })
            .from(workflowDefinitions)
            .where(
              and(
                eq(workflowDefinitions.id, body.target.workflowId),
                eq(workflowDefinitions.orgId, user.orgId),
                eq(workflowDefinitions.ownerType, "team"),
                eq(workflowDefinitions.ownerId, ownerId),
              ),
            );
          if (!targetWorkflow) return [];
        }
        return tx.insert(eventSubscriptions).values(values).returning();
      },
    );
    if (!rows?.[0]) {
      return c.json(
        { error: "The team or target is no longer available. Refresh and select an active target." },
        400,
      );
    }
    insertedRow = rows[0];
  } else {
    const inserted = await db.insert(eventSubscriptions).values(values).returning();
    insertedRow = inserted[0];
  }

  const resp: CreateEventSubscriptionResponse = {
    ...rowToSubscription(insertedRow!),
    ...(collisions !== undefined ? { collisions } : {}),
  };
  return c.json(resp, 201);
});

/**
 * Every subscription in the org, or one workspace's plus the org's own when
 * the caller names an owner. Visibility is wider than the mutation gate on
 * purpose: these rows were always org-visible, and the filter answers
 * "whose automations am I looking at", not "what may I see".
 */
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
        // Org-owned rows join every workspace's list, bounded to the
        // caller's org by the outer `orgId` predicate.
        eq(eventSubscriptions.ownerType, "org"),
      ),
    );
  }

  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(...conditions))
    .orderBy(desc(eventSubscriptions.createdAt));
  // The places read picks the Slack workspace the same way, so a line's
  // `placeKey` here matches the row its place page lists it at.
  const [problems, slackTeam] = await Promise.all([
    subscriptionProblems(db, conditions), resolveSlackTeam(db, user.orgId, () => orgSlackTeam(c.var.providers, user.orgId)),
  ]);

  const resp: ListEventSubscriptionsResponse = {
    subscriptions: rows.map((row) => subscriptionToWire(row, problems, slackTeam)),
  };
  return c.json(resp);
});

/**
 * `GET /api/event-subscriptions/:id/deliveries`: one listener's latest
 * deliveries, newest first, each with its event (spec 2026-10-16: presence
 * hub, Part C step 4). The rule is org-visible, like the list. An event from
 * a Slack channel this request may not see is left out, as the event page
 * hides it.
 */
eventsRouter.get("/event-subscriptions/:id/deliveries", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");
  const limit = readLimit(c.req.query("limit"), 25, 100);
  if (limit === undefined) return c.json({ error: "Send a positive whole number for limit." }, 400);

  const subs = await db
    .select({ id: eventSubscriptions.id })
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)))
    .limit(1);
  if (subs.length === 0) return c.json({ error: "This line of presence does not exist. Open Presence and pick one from the list." }, 404);

  const rows = await db
    .select({
      id: eventDeliveries.id,
      subscriptionId: eventDeliveries.subscriptionId,
      subscriptionName: eventSubscriptions.name,
      status: eventDeliveries.status,
      attempts: eventDeliveries.attempts,
      lastError: eventDeliveries.lastError,
      deliveredAt: eventDeliveries.deliveredAt,
      nextAttemptAt: eventDeliveries.nextAttemptAt,
      destination: eventDeliveries.destination,
      target: eventSubscriptions.target,
      event: events,
    })
    .from(eventDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .innerJoin(events, and(eq(events.id, eventDeliveries.eventId), eq(events.orgId, user.orgId)))
    .where(eq(eventDeliveries.subscriptionId, id))
    .orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id))
    .limit(limit);
  const canSee = channelsVisibleTo(c);
  const visible: typeof rows = [];
  for (const row of rows) {
    const channel = slackEventChannel(row.event);
    if (channel === undefined || (await canSee(`slack:${channel}`))) visible.push(row);
  }
  const wire = await deliveriesToWire(c, visible);
  const resp: ListSubscriptionDeliveriesResponse = {
    deliveries: wire.map((d, index) => ({ ...d, event: rowToEventSummary(visible[index]!.event) })),
  };
  return c.json(resp);
});

/** The activity read's answer for a line that is missing or in another org. */
export const LINE_NOT_FOUND = "This line was not found. Refresh Presence and try again.";

/**
 * `GET /api/event-subscriptions/:id/activity`: one line's Activity, newest
 * first, and the counts its health strip shows (spec 2026-10-16: presence
 * hub, Part D step 4). It reads as the deliveries list does: the line is
 * org-visible, and an event from a Slack channel this request may not see is
 * left out. A skipped event outside the line's places shows only to an
 * organization admin (`services/line-activity.ts`).
 */
eventsRouter.get("/event-subscriptions/:id/activity", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");
  const limit = readLimit(c.req.query("limit"), 50, 100);
  if (limit === undefined) return c.json({ error: "Send a positive whole number for limit." }, 400);

  const [line] = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)))
    .limit(1);
  if (!line) return c.json({ error: LINE_NOT_FOUND }, 404);

  const scope = `line-activity:${id}`;
  const rawCursor = c.req.query("before");
  const decoded = rawCursor === undefined ? undefined : decodePageCursor(rawCursor);
  const before = decoded && decoded.orgId === user.orgId && decoded.scope === scope &&
    typeof decoded.at === "number" && Number.isSafeInteger(decoded.at) && typeof decoded.id === "string"
    ? { at: decoded.at, id: decoded.id } : undefined;
  if (rawCursor !== undefined && !before) return c.json({ error: "The page cursor is not valid for this line. Reload Activity and try again." }, 400);

  // A credential fault degrades Slack places to their ids, as the places read does.
  const page = await loadLineActivity({ db, plugins }, {
    orgId: user.orgId, line, admin: await isOrgAdminUser(c),
    slackTeam: await resolveSlackTeam(db, user.orgId, () => orgSlackTeam(c.var.providers, user.orgId)),
    ...(before ? { before } : {}), limit,
    channelVisible: channelsVisibleTo(c),
    deliveryLinks: (rows) => deliveriesToWire(c, rows),
    channelNames: slackChannelNames(c),
  });
  const resp: LineActivityResponse = {
    entries: page.entries,
    ...(page.next ? { nextCursor: encodePageCursor({ orgId: user.orgId, scope, at: page.next.at, id: page.next.id }) } : {}),
    lastActedAt: page.lastActedAt,
    actedLast30Days: page.actedLast30Days,
    perDay: page.perDay,
  };
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
    return c.json({ error: "This line was not found. Refresh Presence and try again." }, 404);
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

  // `assistantId: null` clears a retired selection; a value selects one,
  // which a single-assistant workspace does not support.
  if ("assistantId" in body && (body as { assistantId?: unknown }).assistantId !== null) {
    return c.json({ error: "Assistant selection is not supported. Choose the personal or team workspace instead." }, 400);
  }
  // Drop a retired selection from a row the boot repair has not reached yet,
  // so the merged row below validates.
  // Validated jsonb narrows to the wire union, as before; old rows may also carry `assistantId`.
  // Old rows may carry the old names; the patched row is stored with the new ones.
  const { assistantId: _retired, ...storedTarget } = readStoredTarget(row.target) as EventSubscriptionTargetWire & { assistantId?: unknown };
  let patchedTarget: EventSubscriptionTargetWire = storedTarget;
  const appearanceWrite = acceptAppearanceWrite(body);
  if (!appearanceWrite.ok) return c.json({ error: appearanceWrite.error }, 400);
  // The validator below checks the shape of a non-null value.
  const appearance = appearanceWrite.appearance as PatchEventSubscriptionRequest["appearance"];
  if (appearance === null) {
    const { appearance: _cleared, ...rest } = patchedTarget;
    patchedTarget = rest;
  } else if (appearance !== undefined) {
    patchedTarget = { ...patchedTarget, appearance };
  }
  if (body.deliveryPolicy !== undefined || body.pauseOnOverlap !== undefined) {
    if (row.ownerType !== "user" || patchedTarget.kind !== "assistant") return c.json({ error: "Only a line for your personal assistant can choose what happens when a team also listens. Remove that choice, or point the line at your personal assistant." }, 400);
    patchedTarget = { ...patchedTarget,
      ...(body.deliveryPolicy !== undefined ? { deliveryPolicy: body.deliveryPolicy } : {}),
      ...(body.pauseOnOverlap !== undefined ? { pauseOnOverlap: body.pauseOnOverlap } : {}),
    };
  }
  // `null` clears the policy, so the rule reads as `own` again. The merged
  // re-validation below checks a new policy's shape and subject mode.
  if (body.thread !== undefined) {
    if (patchedTarget.kind !== "assistant") {
      return c.json({ error: "A thread choice applies only when the assistant does the work. Remove the thread from this workflow line." }, 400);
    }
    if (body.thread === null) {
      const { thread: _cleared, ...rest } = patchedTarget;
      patchedTarget = rest;
    } else {
      patchedTarget = { ...patchedTarget, thread: body.thread };
    }
  }
  if (body.enabled === true && patchedTarget.kind === "assistant") {
    const { overlapPausedAt: _pause, ...rest } = patchedTarget;
    patchedTarget = rest;
  }


  // The prompt templates are the other part of `target` a patch may rewrite,
  // and only on an assistant target. `null` clears the field, so the rule
  // delivers the default body again; the merged re-validation below checks a
  // new template against the rule's events. Shape only here: the template
  // language is `events/prompt-template.ts`'s to judge.
  for (const field of ["systemPrompt", "userPromptTemplate"] as const) {
    const patched = body[field];
    if (patched === undefined) continue;
    if (patchedTarget.kind !== "assistant") {
      return c.json({ error: `${field} is only valid on an assistant target. Remove ${field}, or point the line at an assistant.` }, 400);
    }
    if (patched === null) {
      const { [field]: _cleared, ...rest } = patchedTarget;
      patchedTarget = rest;
    } else {
      patchedTarget = { ...patchedTarget, [field]: patched };
    }
  }

  // Re-validate the row as it would exist after the patch — provided fields
  // get full validation in the context of the untouched ones.
  const merged = {
    name: body.name ?? row.name,
    eventKeys: body.eventKeys ?? row.eventKeys,
    filters: body.filters ?? row.filters,
    target: patchedTarget,
    // An absent audience keeps the stored one, which must still be legal
    // against the patched target.
    audience: body.audience ?? row.audience ?? undefined,
  };
  // Mention scoping is keyed to the CREATOR and skipped for a patch that
  // does not change the match — so an enabled-only or name-only patch still
  // works after the creator unlinks Slack, and a colleague's patch of an
  // org-owned row cannot re-point the scope at themselves. The casts narrow
  // validated jsonb, same as `rowToSubscription`.
  const write = await validateSubscriptionWrite(db, plugins, merged, {
    creatorUserId: row.createdBy,
    ownerType: row.ownerType,
    anyChannel: body.anyChannel === true,
    matchChanged: body.filters !== undefined || body.eventKeys !== undefined,
    storedAnyChannel: storedAnyChannelState(
      row.eventKeys as string[],
      row.filters as SubscriptionFilter[],
    ),
    storedAudience: row.audience,
  });
  if (!write.ok) return c.json({ error: write.error }, 400);
  const filters = write.filters;
  const audience = write.audience ?? null;
  // Only a patch that sets the policy re-checks its thread. A rename of a rule
  // whose pinned thread was archived later must still work.
  // `merged.eventKeys` passed `validateSubscriptionWrite` above.
  const rule = { eventKeys: merged.eventKeys as string[], filters };
  if (body.thread != null && patchedTarget.kind === "assistant") {
    const threadError = await existingThreadError(c.var.providers, viewerOf(c),
      { type: row.ownerType, id: row.ownerId }, patchedTarget.thread, rule);
    if (threadError) return c.json({ error: threadError }, 400);
  } else if ((body.filters !== undefined || body.eventKeys !== undefined) && patchedTarget.kind === "assistant") {
    // A match edit can name a private channel that the pinned thread does
    // not gate on yet. Only that check runs, so the edit of a rule whose
    // pinned thread was archived later still works.
    const channelError = await existingPinChannelError(c.var.providers, row.orgId,
      { type: row.ownerType, id: row.ownerId }, patchedTarget.thread, rule);
    if (channelError) return c.json({ error: channelError }, 400);
  }

  // Collision gate (TKAI-294), against the row as it would exist after the
  // patch, minus itself. Runs when the result can fire AND the patch changes
  // what it fires on — a match edit, or flipping enabled on (the create-time
  // check said nothing about a row born disabled). A rename of a live
  // colliding row stays unchecked: the collision predates the patch.
  const willBeEnabled = body.enabled ?? row.enabled;
  const matchChanged = body.filters !== undefined || body.eventKeys !== undefined;
  const arming = body.enabled === true && !row.enabled;
  // Enabling a replacement proposal disables the subscription it replaces
  // (see the update below), so that row is not a collision peer. Same owner
  // only: a target written by hand must not reach another workspace's rule.
  const replaces = arming && patchedTarget.kind === "assistant" ? patchedTarget.replaces : undefined;
  // An assistant subscription only: a workflow trigger is not a version.
  const replaced = replaces === undefined ? undefined : (await db
    .select({ id: eventSubscriptions.id, name: eventSubscriptions.name, enabled: eventSubscriptions.enabled })
    .from(eventSubscriptions)
    .where(and(
      eq(eventSubscriptions.id, replaces), ne(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId),
      eq(eventSubscriptions.ownerType, row.ownerType), eq(eventSubscriptions.ownerId, row.ownerId),
      sql`${eventSubscriptions.target}->>'kind' IN ('assistant', 'orchestrator')`,
    ))
    .limit(1))[0];
  // A replacement turns off a version that still replies. If that version is
  // already off or gone (another replacement of it was enabled, or a person
  // removed it), enabling this one could leave two versions on.
  if (replaces !== undefined && !replaced?.enabled) return c.json({ error: staleReplacement(replaced) }, 409);
  const replacedId = replaced?.id;
  let collisions: EventSubscriptionCollisionsWire | undefined;
  if (willBeEnabled && (matchChanged || arming)) {
    const ingressBlocked = await linearEventArmBlock(db,c.var.providers.engineCredentials,user.orgId,merged.eventKeys as string[]);
    if (ingressBlocked) return c.json({ error: ingressBlocked },400);
    const report = await collisionsForWrite(
      db,
      plugins,
      user.orgId,
      {
        ownerType: row.ownerType,
        eventKeys: merged.eventKeys as string[],
        filters,
        // The PATCHED target: a patch that re-points the rule at a different
        // assistant changes who it collides with, and comparing the stored one
        // would answer for the rule as it was.
        target: patchedTarget,
      },
      replacedId !== undefined ? [id, replacedId] : [id],
    );
    if (report.blocking.length > 0 && body.allowCollision !== true) {
      const resp: EventSubscriptionCollisionErrorWire = {
        // A patch that turns the line on comes from its switch or a proposal's
        // Turn on; any other comes from the editor's Save.
        error: collisionBlockMessage(report, arming ? "turn-on" : "save"),
        collisions: collisionsToWire(report),
      };
      return c.json(resp, 409);
    }
    if (report.blocking.length > 0) {
      console.warn(
        `[events] collision override: user ${user.id} updated subscription ${id} over ` +
          report.blocking.map((b) => b.subscription.id).join(", "),
      );
    }
    if (report.blocking.length > 0 || report.overlapping.length > 0) {
      collisions = collisionsToWire(report);
    }
  }

  // The link is spent once the replaced version is off. Clearing it keeps a
  // later off-and-on of this version from disabling the old one again.
  const enabledTarget = spendReplacement(patchedTarget, replacedId);
  let updated: (typeof eventSubscriptions.$inferSelect)[];
  try {
    updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(eventSubscriptions)
        .set({
          name: merged.name,
          eventKeys: merged.eventKeys,
          filters,
          target: enabledTarget,
          audience,
          enabled: willBeEnabled,
          updatedAt: Math.max(Date.now(), row.updatedAt + 1),
        })
        .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId), eq(eventSubscriptions.updatedAt, row.updatedAt)))
        .returning();
      // One transaction, so the replacement and the version it replaces are
      // never both enabled. The version must still be on: of two replacements
      // of one version enabled at once, the second rolls back.
      if (rows[0] && replacedId !== undefined) {
        const off = await tx
          .update(eventSubscriptions)
          .set({ enabled: false, updatedAt: sql`greatest(${eventSubscriptions.updatedAt} + 1, ${Date.now()})` })
          .where(and(eq(eventSubscriptions.id, replacedId), eq(eventSubscriptions.orgId, user.orgId), eq(eventSubscriptions.enabled, true)))
          .returning({ id: eventSubscriptions.id });
        if (off.length === 0) throw new StaleReplacementError();
      }
      return rows;
    });
  } catch (err) {
    if (err instanceof StaleReplacementError) return c.json({ error: staleReplacement(replaced) }, 409);
    throw err;
  }

  if (!updated[0]) return c.json({ error: "This line changed while you were editing it. Refresh and try again." }, 409);

  const resp: PatchEventSubscriptionResponse = {
    ...rowToSubscription(updated[0]),
    ...(collisions !== undefined ? { collisions } : {}),
  };
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
    return c.json({ error: "This line was not found. Refresh Presence and try again." }, 404);
  }

  await db.delete(eventSubscriptions).where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)));
  return c.body(null, 204);
});
