/**
 * Pure subscription-matching primitives for the event system. No IO — the
 * ingest transaction and the subscriptions CRUD validator both call these.
 */
import type { EventCatalogEntry } from "@valet/engine";

export interface SubscriptionFilter {
  field: string;
  op: "eq" | "in" | "prefix" | "contains";
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

export function filtersMatch(
  payload: unknown,
  eventKey: string,
  filters: SubscriptionFilter[],
  catalog: EventCatalogEntry[],
): boolean {
  if (filters.length === 0) return true;
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
    }
  });
}
