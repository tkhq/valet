/**
 * Pure subscription-matching primitives for the event system. No IO — the
 * ingest transaction and the subscriptions CRUD validator both call these.
 */
import type { EventCatalogEntry } from "@valet/engine";

export interface SubscriptionFilter {
  field: string;
  op: "eq" | "in" | "prefix" | "contains" | "regex";
  value: string | string[];
}

/** Trailing-wildcard key match: "github.pull_request.*" matches
 * "github.pull_request.opened" but not "github.pull_request_review.x" —
 * the wildcard only crosses a `.` boundary. */
export function eventKeyMatches(eventKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === eventKey) return true;
    if (pattern.endsWith(".*")) return eventKey.startsWith(pattern.slice(0, -1));
    return false;
  });
}

export function resolvePath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

/**
 * Whether one subscription matches an event: its key patterns match AND its
 * filters pass. The single predicate the ingest gate, the delivery match, and
 * the redeliver route all share, so a change to match semantics cannot make
 * the "should we store it" and "should we deliver it" decisions diverge.
 *
 * The two casts narrow the `unknown` jsonb columns; their shapes are owned by
 * the subscriptions CRUD validator (`routes/events.ts`), the only writer of
 * these columns, which writes exactly these types.
 */
export function subscriptionMatchesEvent(
  sub: { eventKeys: unknown; filters: unknown },
  eventKey: string,
  payload: unknown,
  catalog: EventCatalogEntry[],
): boolean {
  return (
    eventKeyMatches(eventKey, sub.eventKeys as string[]) &&
    filtersMatch(payload, eventKey, sub.filters as SubscriptionFilter[], catalog)
  );
}

/**
 * Whether a subscription's key patterns name this event, ignoring its filters.
 * Ingest uses it to tell "no subscription wants this key" from "a subscription
 * wants it but a filter excluded this occurrence" when it drop-logs an
 * unmatched event.
 */
export function subscriptionNamesKey(sub: { eventKeys: unknown }, eventKey: string): boolean {
  return eventKeyMatches(eventKey, sub.eventKeys as string[]);
}

export function filtersMatch(
  payload: unknown,
  eventKey: string,
  filters: SubscriptionFilter[],
  catalog: EventCatalogEntry[],
): boolean {
  if (filters.length === 0) return true;
  // No catalog entry for this key → all field filters are undeclared → no match.
  const entry = catalog.find((e) => e.key === eventKey);
  return filters.every((filter) => {
    const declared = entry?.filters.find((f) => f.field === filter.field);
    if (!declared) return false;
    const actual = asString(resolvePath(payload, declared.path));
    if (actual === undefined) return false;
    switch (filter.op) {
      case "eq":
        return actual === filter.value;
      case "in":
        return Array.isArray(filter.value) && filter.value.includes(actual);
      case "prefix":
        return typeof filter.value === "string" && actual.startsWith(filter.value);
      case "contains":
        return typeof filter.value === "string" && actual.includes(filter.value);
      case "regex":
        // A bad pattern fails closed — it never matches and never throws, so a
        // malformed rule cannot break the ingest transaction.
        if (typeof filter.value !== "string") return false;
        try {
          return new RegExp(filter.value).test(actual);
        } catch {
          return false;
        }
    }
  });
}
