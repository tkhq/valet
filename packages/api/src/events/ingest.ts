/**
 * Event ingest: NormalizedEvent -> events row + matched event_deliveries
 * rows, one transaction. Callers (generic webhook route, github-app
 * forwarder) handle org resolution and signature verification first.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { EventCatalogEntry, NormalizedEvent, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import { subscriptionMatchesEvent, subscriptionNamesKey } from "./match.js";
import { writeDropLog } from "../orchestrator/signals.js";

export interface IngestDeps {
  db: AppDb;
  plugins: ValetPlugin[];
  /** In-process dispatcher nudge; wired in main.ts. */
  onIngest?: () => void;
}

export function catalogForService(plugins: ValetPlugin[], service: string): EventCatalogEntry[] {
  return plugins
    .flatMap((p) => p.triggers ?? [])
    .filter((t) => t.service === service)
    .flatMap((t) => t.catalog);
}

/** The merged catalog across every plugin and service. The one traversal the
 * subscription validator, the mention-scope gate, and the filter-options
 * lookup all share, so a catalog-shape change lands in one place. */
export function allCatalogEntries(plugins: ValetPlugin[]): EventCatalogEntry[] {
  return plugins.flatMap((p) => p.triggers ?? []).flatMap((t) => t.catalog);
}

/** The merged catalog with each entry's owning service — the scope gate
 * needs the service to resolve the creator's linked identity
 * (`identityForUser`). */
export function allCatalogEntriesWithService(
  plugins: ValetPlugin[],
): { service: string; entry: EventCatalogEntry }[] {
  return plugins
    .flatMap((p) => p.triggers ?? [])
    .flatMap((t) => t.catalog.map((entry) => ({ service: t.service, entry })));
}

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  deliveries: number;
  /** True when the event matched no enabled subscription and was not
   * persisted. Valet retains an event only when a subscription asked for it. */
  skipped?: boolean;
}

/**
 * Drop-logs the high-signal miss: a subscription NAMES this event key but its
 * filter excluded this occurrence — the "why didn't my trigger fire?" case.
 * Throttled per (org, event key): one row a minute is enough to diagnose a bad
 * filter without a busy key flooding the table. The row records only the event
 * KEY, never the payload or refs.
 *
 * An event no subscription names at all is NOT logged here — for a high-volume
 * key like slack.message that is every message, so logging it would re-flood
 * the drop-log the privacy design keeps small. The "last event received" signal
 * (`GET /api/events/drops`) answers "is anything arriving?" for that case.
 */
const FILTER_DROP_COOLDOWN_MS = 60_000;
const filterDropLoggedAt = new Map<string, number>();

/** Test-only: clears the per-process filter-drop throttle so a suite can assert
 * one row per key without the cooldown bleeding across cases. */
export function __resetIngestDropThrottle(): void {
  filterDropLoggedAt.clear();
}

async function logFilterExcludedDrop(db: AppDb, orgId: string, eventKey: string): Promise<void> {
  const throttleKey = `${orgId}:${eventKey}`;
  const now = Date.now();
  const last = filterDropLoggedAt.get(throttleKey);
  if (last !== undefined && now - last < FILTER_DROP_COOLDOWN_MS) return;
  filterDropLoggedAt.set(throttleKey, now);
  const detail = `A ${eventKey} event arrived, but every subscription for it excluded it by filter. Check the filters on your ${eventKey} subscription.`;
  try {
    await writeDropLog(db, { orgId, reason: "filter_excluded", detail });
  } catch (err) {
    console.error("[ingest] filter-excluded drop-log failed", err);
  }
}

export async function ingestEvent(
  deps: IngestDeps,
  args: { orgId: string; service: string; event: NormalizedEvent },
): Promise<IngestResult> {
  const { orgId, service, event } = args;
  const now = Date.now();
  const eventId = randomUUID();
  const catalog = catalogForService(deps.plugins, service);
  // Number.isFinite (not `|| now`): epoch-0 timestamps parse to 0, which is
  // falsy but valid — only an unparseable occurredAt falls back to receipt time.
  const parsedOccurredAt = Date.parse(event.occurredAt);
  const occurredAt = Number.isFinite(parsedOccurredAt) ? parsedOccurredAt : now;

  // Match-gated persistence, for every event. The event is matched against
  // the org's enabled subscriptions in ONE read; one that matches nothing is
  // dropped and never touches the events table. This is a privacy rule: Valet
  // retains event data only when a subscription asked for it, so an org that
  // watches one repo does not accumulate every other event its webhook happens
  // to deliver. Subscribing is what turns persistence on.
  //
  // The match is the full key + filter test, so an event a subscription
  // excludes by filter is dropped like one no subscription names at all — the
  // filter is a privacy boundary, not only a delivery boundary.
  //
  // The same matched set gates persistence and seeds the deliveries, so the
  // "store it" and "deliver it" decisions can never disagree. A subscription
  // changed between this read and the insert costs one boundary event (a new
  // one misses this event; a deleted one gets a harmless orphan delivery, safe
  // because `event_deliveries` holds no foreign key to the subscription). The
  // next event sees the change.
  const subs = await deps.db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
  const matched = subs.filter((sub) => subscriptionMatchesEvent(sub, event.key, event.payload, catalog));
  if (matched.length === 0) {
    // If a subscription NAMES this key but every one filtered this occurrence
    // out, record it so "my trigger didn't fire" is answerable. An event no
    // subscription names is ambient traffic and stays silent. Either way the
    // event itself is never persisted.
    if (subs.some((sub) => subscriptionNamesKey(sub, event.key))) {
      await logFilterExcludedDrop(deps.db, orgId, event.key);
    }
    return { eventId, duplicate: false, deliveries: 0, skipped: true };
  }

  const result = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(events)
      .values({
        id: eventId,
        orgId,
        service,
        eventKey: event.key,
        dedupeKey: event.dedupeKey,
        actor: event.actor ?? null,
        refs: event.refs,
        summary: event.summary,
        payload: event.payload,
        occurredAt,
        receivedAt: now,
      })
      .onConflictDoNothing({ target: [events.service, events.dedupeKey] })
      .returning({ id: events.id });
    if (inserted.length === 0) return { eventId, duplicate: true, deliveries: 0 };

    await tx.insert(eventDeliveries).values(
      matched.map((sub) => ({
        id: randomUUID(),
        eventId,
        subscriptionId: sub.id,
        status: "pending" as const,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })),
    );
    return { eventId, duplicate: false, deliveries: matched.length };
  });

  if (!result.duplicate && result.deliveries > 0) deps.onIngest?.();
  return result;
}
