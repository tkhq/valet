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
}

export async function ingestEvent(
  deps: IngestDeps,
  args: { orgId: string; service: string; event: NormalizedEvent },
): Promise<IngestResult> {
  const { orgId, service, event } = args;
  const now = Date.now();
  const eventId = randomUUID();
  const catalog = catalogForService(deps.plugins, service);

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
        occurredAt: Date.parse(event.occurredAt) || now,
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
