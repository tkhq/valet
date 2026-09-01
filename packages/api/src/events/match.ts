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

/** Longest regex pattern a subscription may carry. Bounds compile cost. */
export const MAX_REGEX_PATTERN_LENGTH = 200;
/** Longest input the regex is tested against, per event. Bounds backtracking cost. */
const MAX_REGEX_INPUT_LENGTH = 2_000;

/**
 * A regex pattern this event system refuses to store, or `null` when it is
 * safe. Node has no non-backtracking regex engine available here, so a
 * subscription's pattern is untrusted input that runs on every event. Three
 * write-time gates keep a single rule from stalling ingest:
 *
 * 1. length — a pattern over `MAX_REGEX_PATTERN_LENGTH` is refused.
 * 2. validity — a pattern that does not compile is refused.
 * 3. nesting — an unbounded quantifier applied to a group that itself holds an
 *    unbounded quantifier (`(a+)+`, `(.*)*`, `(a+)*`) is the classic
 *    catastrophic-backtracking shape; it is refused.
 *
 * This is a heuristic, not a proof: it does not catch every dangerous pattern
 * (nested groups slip past 3). At match time `filtersMatch` also caps the input
 * length and caches the compiled pattern. A full fix is a re2-class engine.
 */
export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `regex pattern is too long (max ${MAX_REGEX_PATTERN_LENGTH} characters). Shorten it.`;
  }
  try {
    new RegExp(pattern);
  } catch {
    return `invalid regular expression. Fix the pattern.`;
  }
  // A group (no nested parens) that contains `*`/`+`, immediately quantified by
  // `*`/`+` — the exponential-backtracking shape.
  if (/\([^()]*[*+][^()]*\)[*+]/.test(pattern)) {
    return `regex pattern nests unbounded quantifiers, which can hang matching. Simplify it.`;
  }
  return null;
}

/** Compiled-pattern memo so a rule's regex is built once, not per event. `null` = a pattern that will not compile. */
const compiledRegexCache = new Map<string, RegExp | null>();
const COMPILED_REGEX_CACHE_CAP = 500;

function compileRegexCached(pattern: string): RegExp | null {
  const hit = compiledRegexCache.get(pattern);
  if (hit !== undefined) return hit;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = null;
  }
  if (compiledRegexCache.size >= COMPILED_REGEX_CACHE_CAP) {
    const oldest = compiledRegexCache.keys().next().value;
    if (oldest !== undefined) compiledRegexCache.delete(oldest);
  }
  compiledRegexCache.set(pattern, compiled);
  return compiled;
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
  if (!eventKeyMatches(eventKey, sub.eventKeys as string[])) return false;
  // The match-time arm of the creator-pinning rule (events/subscription-scope.ts,
  // TKAI-299/TKAI-302). A subscription on a pinned key with no filter on the
  // pinned field predates the write-time gate and would fire for EVERY
  // user's events. It fails closed here — the miss is drop-logged as
  // `filter_excluded`, so the owner sees the rule stopped matching, edits
  // it, and the write gate scopes it. Channel scope has no such arm: a row
  // with no channel filter is indistinguishable from the legitimate
  // any-channel state.
  const pinField = catalog.find((e) => e.key === eventKey)?.scope?.creatorUserField;
  if (
    pinField !== undefined &&
    !(sub.filters as SubscriptionFilter[]).some((f) => f.field === pinField)
  ) {
    return false;
  }
  return filtersMatch(payload, eventKey, sub.filters as SubscriptionFilter[], catalog);
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
      case "regex": {
        // A bad pattern fails closed — it never matches and never throws, so a
        // malformed rule cannot break the ingest transaction. The pattern is
        // compiled once (cached) and tested against a bounded slice of the
        // input, so backtracking cost stays bounded per event.
        if (typeof filter.value !== "string") return false;
        const re = compileRegexCached(filter.value);
        if (re === null) return false;
        return re.test(actual.slice(0, MAX_REGEX_INPUT_LENGTH));
      }
    }
  });
}
