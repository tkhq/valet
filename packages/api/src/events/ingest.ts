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
import { eventKeyMatches, filtersMatch, type SubscriptionFilter } from "./match.js";

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

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  deliveries: number;
  /** True when an `ephemeral` catalog key matched no subscription and the event was not persisted. */
  skipped?: boolean;
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

  // Match-gated persistence for high-volume keys: an `ephemeral` catalog
  // entry (e.g. slack.message) is matched against subscriptions BEFORE any
  // insert — zero matches means the event never touches the events table.
  // Subscribing is what turns the firehose on. The check and the in-tx match
  // read the subscription set at different instants, so a concurrent change
  // can produce at most one boundary artifact: a subscription created between
  // the two reads costs one skipped event; a subscription disabled between
  // them persists one event whose in-tx match finds nothing (an orphan row
  // with zero deliveries). Both are benign and self-correct on the next event.
  const entry = catalog.find((e) => e.key === event.key);
  if (entry?.ephemeral) {
    const subs = await deps.db
      .select()
      .from(eventSubscriptions)
      .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
    const anyMatch = subs.some(
      (sub) =>
        eventKeyMatches(event.key, sub.eventKeys as string[]) &&
        filtersMatch(event.payload, event.key, sub.filters as SubscriptionFilter[], catalog),
    );
    if (!anyMatch) return { eventId, duplicate: false, deliveries: 0, skipped: true };
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

    const subs = await tx
      .select()
      .from(eventSubscriptions)
      .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));

    // The two jsonb columns come back `unknown`; their shapes are owned by
    // the subscriptions CRUD validator (Task 7) which only writes these
    // exact types.
    const matched = subs.filter(
      (sub) =>
        eventKeyMatches(event.key, sub.eventKeys as string[]) &&
        filtersMatch(event.payload, event.key, sub.filters as SubscriptionFilter[], catalog),
    );
    if (matched.length > 0) {
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
    }
    return { eventId, duplicate: false, deliveries: matched.length };
  });

  if (!result.duplicate && result.deliveries > 0) deps.onIngest?.();
  return result;
}
