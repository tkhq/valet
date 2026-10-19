/**
 * One line's Activity (spec 2026-10-16: presence hub, Part D steps 1.4, 1.7,
 * and 4). The timeline merges two sources, newest first:
 *
 * - The line's deliveries are `acted` entries. A dead delivery that a later
 *   delivery for the same event settled is left out (Part F step 4). A
 *   delivery that the dispatcher skipped (a waiter claim, the line was off,
 *   another path owns it) is a `skipped` entry.
 * - The receipt decisions that did not match the line (`filter_excluded`,
 *   `authorization_denied`, `disabled`, `key_mismatch`) are `skipped`
 *   entries. A receipt records an event even when no line stored it.
 *
 * A skipped entry for an event outside the places the line names shows only
 * to an organization admin. A line with no condition on a place field names
 * the whole of each service. A pattern on a place field, or a place named
 * for one service only, gives the other places nothing (`lineNamedPlaces`). `mergeLineActivity` is the pure core; `loadLineActivity`
 * reads both sources for one line.
 */
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { claimedThreadId } from "../events/destination.js";
import { sanitizeReceiptSubscriptions } from "../events/receipts.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import type { ChannelNames } from "./channels.js";
import { slackEventChannel } from "./thread-access.js";
import { supersedingDeliveries } from "./event-log.js";
import {
  eventPlace, isServiceRoot, lineNamedPlaces, placeCovers, placeLabel, placeOfSubject, serviceOf, type PresenceDeps,
} from "./presence-places.js";
import type {
  EventDeliveryThreadRef, EventDeliveryWire, LineActivityEntryWire, LineActivitySkipReason, ReceiptSubscriptionDecision,
} from "../wire/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The health strip's window, in UTC days, today included. */
export const LINE_ACTIVITY_DAYS = 30;

/** A place: its key and its concrete name. */
export interface ActivityPlace { key: string; label: string }

/** One of the line's deliveries, with its event's key and place. */
export interface LineDeliveryInput {
  id: string;
  eventId: string;
  subscriptionId: string;
  status: EventDeliveryWire["status"];
  createdAt: number;
  deliveredAt: number | null;
  /** The delivery attempts the dispatcher recorded. */
  attempts: number;
  lastError: string | null;
  /** The destination stamp. A claim stamp marks a delivery a waiter claimed. */
  destination: unknown;
  eventKey: string;
  place: ActivityPlace | null;
  /** The thread or run the delivery reached, when the viewer may open it. */
  thread?: EventDeliveryThreadRef;
  runId?: string;
}

/** One receipt decision about the line. */
export interface LineDecisionInput {
  receiptId: string;
  at: number;
  eventId: string | null;
  eventKey: string;
  place: ActivityPlace | null;
  decision: ReceiptSubscriptionDecision;
}

export interface MergeLineActivityOptions {
  /** The exact places the line names (`lineNamedPlaces`), never a parent
   * that several of them share. */
  linePlaces: readonly string[];
  /** An organization admin sees skipped entries outside the line's places. */
  admin: boolean;
}

/**
 * Whether an event is in one of the line's places. A service's top row
 * covers every event of that service, also one whose place is unknown. The
 * org connects one Slack workspace, so a Slack top row covers every Slack place.
 */
export function inLinePlaces(linePlaces: readonly string[], eventKey: string, place: string | null): boolean {
  const service = serviceOf(place ?? eventKey);
  return linePlaces.some((named) => {
    if (isServiceRoot(named)) return serviceOf(named) === service;
    return place !== null && placeCovers(named, place);
  });
}

/** The words for one filter field, for a skipped entry's reason. */
function filterInWords(field: string): string {
  if (field === "repo") return "the repository filter";
  if (field === "channel" || field === "channel_name") return "the channel filter";
  if (field === "branch" || field.endsWith("_branch")) return "the branch filter";
  return `the ${field.replace(/_/g, " ")} filter`;
}

/** A receipt decision's reason, or null for a decision that matched. */
function decisionReason(decision: ReceiptSubscriptionDecision): { reason: LineActivitySkipReason; reasonText?: string } | null {
  switch (decision.outcome) {
    case "matched": return null;
    case "filter_excluded": {
      const first = decision.failedFilters?.find((filter) => filter.field !== "");
      return { reason: "filters", reasonText: first ? filterInWords(first.field) : "its filters" };
    }
    case "authorization_denied": return { reason: "sender" };
    case "disabled": return { reason: "off" };
    default: return { reason: "other" };
  }
}

/** The dispatcher's text for a delivery it skipped because the line was off.
 * Rows written before the line wording read "Skipped — subscription is disabled." */
const LINE_OFF_SKIP = /^(?:This line is off\.|Skipped — subscription is disabled\.$)/;

/** The dispatcher's text for a personal delivery that a team line took. */
const TEAM_SKIP_TEXT = "The team already listens for this.";
/** The same skip as written before the line wording. */
const LEGACY_TEAM_SKIP = "Skipped — matching team subscription.";

/** A skipped delivery's reason. A claim names the claiming thread's id, so
 * its text stays off the wire. An old row's text reads as today's text. */
function deliverySkipReason(delivery: LineDeliveryInput): { reason: LineActivitySkipReason; reasonText?: string } {
  if (claimedThreadId(delivery.destination) !== null) return { reason: "claimed" };
  if (delivery.lastError !== null && LINE_OFF_SKIP.test(delivery.lastError)) return { reason: "off" };
  if (delivery.lastError === LEGACY_TEAM_SKIP) return { reason: "other", reasonText: TEAM_SKIP_TEXT };
  return delivery.lastError ? { reason: "other", reasonText: delivery.lastError } : { reason: "other" };
}

/** Newest first by `at`, then by id, as the page cursor orders them. */
export function compareEntries(a: { at: number; id: string }, b: { at: number; id: string }): number {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * The line's entries from its deliveries and its receipt decisions, newest
 * first. Superseded dead deliveries and matched decisions are left out. A
 * skipped entry outside the line's places stays only for an admin.
 */
export function mergeLineActivity(
  deliveries: readonly LineDeliveryInput[],
  decisions: readonly LineDecisionInput[],
  opts: MergeLineActivityOptions,
): LineActivityEntryWire[] {
  const superseded = supersedingDeliveries(deliveries);
  const visibleSkip = (eventKey: string, place: ActivityPlace | null) =>
    opts.admin || inLinePlaces(opts.linePlaces, eventKey, place?.key ?? null);
  const entries: LineActivityEntryWire[] = [];
  for (const d of deliveries) {
    if (superseded.has(d.id)) continue;
    const common = {
      id: d.id, at: d.createdAt, eventId: d.eventId, eventKey: d.eventKey,
      place: d.place?.key ?? null, placeLabel: d.place?.label ?? null,
    };
    if (d.status === "skipped") {
      if (visibleSkip(d.eventKey, d.place)) entries.push({ ...common, kind: "skipped", ...deliverySkipReason(d) });
      continue;
    }
    entries.push({
      ...common, kind: "acted",
      outcome: {
        status: d.status,
        attempts: d.attempts,
        ...(d.thread ? { thread: d.thread } : {}),
        ...(d.runId ? { runId: d.runId } : {}),
        ...(d.status === "dead" && d.lastError ? { deadText: d.lastError } : {}),
      },
      ...(d.status === "delivered" && d.deliveredAt !== null ? { tookMs: Math.max(0, d.deliveredAt - d.createdAt) } : {}),
    });
  }
  for (const r of decisions) {
    const why = decisionReason(r.decision);
    if (why === null || !visibleSkip(r.eventKey, r.place)) continue;
    entries.push({
      id: `receipt:${r.receiptId}`, kind: "skipped", at: r.at, eventId: r.eventId, eventKey: r.eventKey,
      place: r.place?.key ?? null, placeLabel: r.place?.label ?? null, ...why,
    });
  }
  return entries.sort(compareEntries);
}

/**
 * The health strip's counts from the times of the line's acted entries: one
 * count per UTC day for the last 30 days (today last), and their sum.
 */
export function lineActivityCounts(deliveredAts: readonly number[], now: number): { perDay: number[]; actedLast30Days: number } {
  const today = Math.floor(now / DAY_MS);
  const first = today - (LINE_ACTIVITY_DAYS - 1);
  const perDay = new Array<number>(LINE_ACTIVITY_DAYS).fill(0);
  for (const at of deliveredAts) {
    const day = Math.floor(at / DAY_MS);
    if (day < first || day > today) continue;
    perDay[day - first]! += 1;
  }
  return { perDay, actedLast30Days: perDay.reduce((sum, count) => sum + count, 0) };
}

/** The receipt outcomes that skip a line. */
const SKIP_OUTCOMES = ["filter_excluded", "authorization_denied", "disabled", "key_mismatch"] as const;

/** How many batches one page reads past entries the viewer may not see. */
const MAX_SCAN_BATCHES = 20;

type SubscriptionRow = typeof eventSubscriptions.$inferSelect;
type EventRow = typeof events.$inferSelect;

/** The delivery columns the route's link reader (`deliveriesToWire`) takes. */
export interface LineDeliveryRow {
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

export interface LineActivityQuery {
  orgId: string;
  line: SubscriptionRow;
  admin: boolean;
  /** The org's Slack workspace id, or null when it has none connected. */
  slackTeam: string | null;
  before?: { at: number; id: string };
  limit: number;
  now?: number;
  /** Whether the viewer may see a Slack channel (`slack:<id>`). An entry from
   * a channel the viewer may not see is left out, as the deliveries list does. */
  channelVisible: (channelKey: string) => Promise<boolean>;
  /** The thread or run each delivery reached, when the viewer may open it. */
  deliveryLinks: (rows: readonly LineDeliveryRow[]) => Promise<ReadonlyArray<Pick<EventDeliveryWire, "thread" | "runId">>>;
  /** Slack channel names by channel id, as the places read resolves them.
   * A failed read leaves each unnamed channel as its id. */
  channelNames?: ChannelNames;
}

export interface LineActivityPage {
  entries: LineActivityEntryWire[];
  /** The sort key after the last entry, when more entries may follow. */
  next: { at: number; id: string } | null;
  lastActedAt: number | null;
  actedLast30Days: number;
  perDay: number[];
}

/** An event's place from a receipt's metadata, for an event that was not
 * stored: the recorded `place` key, or a Slack receipt's channel. A receipt
 * written before ingest recorded `place` has no place for other services. */
function receiptPlace(service: string, metadata: unknown, slackTeam: string | null): ActivityPlace | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  if ("place" in metadata && typeof metadata.place === "string") {
    const key = placeOfSubject(metadata.place);
    if (key) return { key, label: placeLabel(key, new Map()) };
  }
  if (service !== "slack") return null;
  const channel = "channelId" in metadata && typeof metadata.channelId === "string" ? metadata.channelId : "";
  const workspace = "workspaceId" in metadata && typeof metadata.workspaceId === "string" ? metadata.workspaceId : slackTeam;
  if (!channel || !workspace) return null;
  const key = placeOfSubject(`slack:${workspace}/${channel}`);
  return key ? { key, label: placeLabel(key, new Map()) } : null;
}

/** The Slack channel id of a channel place key (`slack:T1/C900`), or null. */
function slackChannelOfPlace(place: string | null): string | null {
  return place === null ? null : /^slack:[^/]+\/([^/]+)$/.exec(place)?.[1] ?? null;
}

/**
 * The entries with each Slack channel's name as its place label (`#incidents`),
 * as the places read and a page title show it. A channel the names do not
 * hold keeps the label it has.
 */
export function withChannelLabels(entries: readonly LineActivityEntryWire[], names: ReadonlyMap<string, string>): LineActivityEntryWire[] {
  return entries.map((entry) => {
    const channel = slackChannelOfPlace(entry.place);
    if (channel === null || entry.place === null || !names.has(channel)) return entry;
    return { ...entry, placeLabel: placeLabel(entry.place, names) };
  });
}

/** Reads one line's Activity page and its health strip counts. */
export async function loadLineActivity(deps: Pick<PresenceDeps, "db" | "plugins">, query: LineActivityQuery): Promise<LineActivityPage> {
  const { db, plugins } = deps;
  const { orgId, line, limit } = query;
  const take = limit + 1;
  const now = query.now ?? Date.now();

  // A dead delivery that a later delivery settled is not a fault (Part F step 4).
  const notSuperseded = sql`NOT (${eventDeliveries.status} = 'dead' AND EXISTS (SELECT 1 FROM event_deliveries later
    WHERE later.event_id = ${eventDeliveries.eventId} AND later.subscription_id = ${eventDeliveries.subscriptionId}
      AND later.status = 'delivered' AND later.created_at > ${eventDeliveries.createdAt}))`;

  const deliveryBatch = (before: { at: number; id: string } | undefined) => {
    const where: (SQL | undefined)[] = [
      eq(eventDeliveries.subscriptionId, line.id),
      notSuperseded,
      before ? sql`(${eventDeliveries.createdAt}, ${eventDeliveries.id}) < (${before.at}, ${before.id})` : undefined,
    ];
    return db.select({
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
      event: events,
    })
      .from(eventDeliveries)
      .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
      .innerJoin(events, and(eq(events.id, eventDeliveries.eventId), eq(events.orgId, orgId)))
      .where(and(...where))
      .orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id))
      .limit(take);
  };

  // Cost: receipts have no index on a line, so each batch walks the org's
  // receipts newest first and filters each row's `subscriptions` jsonb in a
  // LATERAL subquery. A page reads at most MAX_SCAN_BATCHES (20) batches.
  // Retention caps the table at 10,000 receipts or 7 days per organization
  // (events/receipts.ts), which bounds the worst case. If the cap grows,
  // index the decisions instead of raising the batch count.
  const receiptBatch = async (before: { at: number; id: string } | undefined) => {
    const cursor = before ? sql`AND (r.created_at, 'receipt:' || r.id) < (${before.at}, ${before.id})` : sql``;
    const result = await db.execute(sql`
      SELECT r.id, r.service, r.metadata, r.event_key, r.event_id, r.created_at, d.decision
      FROM event_receipts r
      CROSS JOIN LATERAL (
        SELECT item AS decision FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.subscriptions) = 'array' THEN r.subscriptions ELSE '[]'::jsonb END) item
        WHERE item->>'id' = ${line.id} AND item->>'outcome' IN (${sql.join(SKIP_OUTCOMES.map((o) => sql`${o}`), sql`, `)})
        LIMIT 1
      ) d
      WHERE r.org_id = ${orgId} ${cursor}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${take}`) as { rows: Array<{
        id: string; service: string; metadata: unknown; event_key: string | null; event_id: string | null;
        created_at: string | number; decision: unknown;
      }> };
    return result.rows.map((row) => ({ ...row, at: Number(row.created_at), key: `receipt:${row.id}` }));
  };

  type DeliveryBatch = Awaited<ReturnType<typeof deliveryBatch>>;
  type ReceiptBatch = Awaited<ReturnType<typeof receiptBatch>>;

  // The exact places the line names. A Slack channel filter names a channel
  // without its workspace, so the org's workspace completes it. The gate
  // reads the named places, not the row the line lists at: two repositories
  // list at `github:*`, which would admit every repository's skips.
  let slackTeam = query.slackTeam;
  const placesFor = () => lineNamedPlaces(line, slackTeam ?? "?");

  const entries: LineActivityEntryWire[] = [];
  let frontier = query.before;
  let deliveriesDone = false;
  let receiptsDone = false;
  let next: { at: number; id: string } | null = null;
  for (let batch = 0; entries.length < take; batch++) {
    if (deliveriesDone && receiptsDone) break;
    if (batch === MAX_SCAN_BATCHES) { next = frontier ?? null; break; }
    const [deliveryRows, receiptRows]: [DeliveryBatch, ReceiptBatch] = await Promise.all([
      deliveriesDone ? [] : deliveryBatch(frontier),
      receiptsDone ? [] : receiptBatch(frontier),
    ]);
    // A source that filled its batch may hold rows older than its last one,
    // so only rows at or after the newer of the two tails are safe to merge.
    const tails: Array<{ at: number; id: string }> = [];
    const lastDelivery = deliveryRows.at(-1);
    if (deliveryRows.length === take && lastDelivery) tails.push({ at: lastDelivery.createdAt, id: lastDelivery.id });
    const lastReceipt = receiptRows.at(-1);
    if (receiptRows.length === take && lastReceipt) tails.push({ at: lastReceipt.at, id: lastReceipt.key });
    const boundary = tails.sort(compareEntries)[0];
    const safe = (key: { at: number; id: string }) => boundary === undefined || compareEntries(key, boundary) <= 0;

    const keptDeliveries = deliveryRows.filter((row) => safe({ at: row.createdAt, id: row.id }));
    const keptReceipts = receiptRows.filter((row) => safe({ at: row.at, id: row.key }));
    // A source is done when it returned a short batch and kept every row of it.
    if (deliveryRows.length < take && keptDeliveries.length === deliveryRows.length) deliveriesDone = true;
    if (receiptRows.length < take && keptReceipts.length === receiptRows.length) receiptsDone = true;

    const storedIds = [...new Set(keptReceipts.map((row) => row.event_id).filter((id): id is string => id !== null))];
    const stored = storedIds.length === 0 ? new Map<string, EventRow>()
      : new Map((await db.select().from(events).where(and(eq(events.orgId, orgId), inArray(events.id, storedIds)))).map((row) => [row.id, row]));

    const visibleChannel = async (channel: string | undefined) => channel === undefined || query.channelVisible(`slack:${channel}`);
    const deliveries: LineDeliveryInput[] = [];
    const shownDeliveryRows: DeliveryBatch = [];
    for (const row of keptDeliveries) {
      if (!(await visibleChannel(slackEventChannel(row.event)))) continue;
      shownDeliveryRows.push(row);
    }
    const links = await query.deliveryLinks(shownDeliveryRows);
    shownDeliveryRows.forEach((row, index) => {
      const place = eventPlace(plugins, row.event);
      if (slackTeam === null && place?.key.startsWith("slack:")) slackTeam = place.key.slice("slack:".length).split("/")[0] ?? null;
      const link = links[index];
      deliveries.push({
        id: row.id, eventId: row.event.id, subscriptionId: row.subscriptionId, status: row.status,
        createdAt: row.createdAt, deliveredAt: row.deliveredAt, attempts: row.attempts, lastError: row.lastError, destination: row.destination,
        eventKey: row.event.eventKey, place,
        ...(link?.thread ? { thread: link.thread } : {}), ...(link?.runId ? { runId: link.runId } : {}),
      });
    });
    const decisions: LineDecisionInput[] = [];
    for (const row of keptReceipts) {
      const decision = sanitizeReceiptSubscriptions([row.decision])[0];
      if (!decision) continue;
      const event = row.event_id !== null ? stored.get(row.event_id) : undefined;
      const channel = event ? slackEventChannel(event)
        : row.service === "slack" && typeof row.metadata === "object" && row.metadata !== null
          && "channelId" in row.metadata && typeof row.metadata.channelId === "string" ? row.metadata.channelId : undefined;
      if (!(await visibleChannel(channel))) continue;
      decisions.push({
        receiptId: row.id, at: row.at, eventId: event ? event.id : row.event_id, eventKey: row.event_key ?? event?.eventKey ?? row.service,
        place: event ? eventPlace(plugins, event) : receiptPlace(row.service, row.metadata, slackTeam), decision,
      });
    }
    entries.push(...mergeLineActivity(deliveries, decisions, { linePlaces: placesFor(), admin: query.admin }));
    if (boundary === undefined) break;
    frontier = boundary;
  }
  if (entries.length > limit) {
    const last = entries[limit - 1]!;
    next = { at: last.at, id: last.id };
  }

  // The strip counts what the timeline lists as acted (spec Part D step
  // 1.4): every delivery that is not skipped and not superseded, whatever
  // its status. Each counts on the day it landed, or was created if it has
  // not landed.
  const windowStart = (Math.floor(now / DAY_MS) - (LINE_ACTIVITY_DAYS - 1)) * DAY_MS;
  const actedAt = sql<number>`COALESCE(${eventDeliveries.deliveredAt}, ${eventDeliveries.createdAt})`;
  const acted = and(eq(eventDeliveries.subscriptionId, line.id), ne(eventDeliveries.status, "skipped"), notSuperseded);
  const [recent, latest] = await Promise.all([
    db.select({ at: actedAt }).from(eventDeliveries).where(and(acted, sql`${actedAt} >= ${windowStart}`)),
    db.select({ at: sql<number | null>`MAX(${actedAt})` }).from(eventDeliveries).where(acted),
  ]);
  const counts = lineActivityCounts(recent.map((row) => Number(row.at)), now);
  const lastActedAt = latest[0]?.at;
  const page = entries.slice(0, limit);
  const channels = [...new Set(page.map((entry) => slackChannelOfPlace(entry.place)).filter((id): id is string => id !== null))];
  const names = channels.length === 0 || !query.channelNames ? new Map<string, string>()
    : await query.channelNames(channels).catch((err: unknown) => {
      console.error("[line-activity] reading Slack channel names failed", err);
      return new Map<string, string>();
    });
  return {
    entries: withChannelLabels(page, names),
    next,
    lastActedAt: lastActedAt === null || lastActedAt === undefined ? null : Number(lastActedAt),
    ...counts,
  };
}
