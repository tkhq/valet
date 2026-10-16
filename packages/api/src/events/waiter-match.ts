/**
 * Pure event-waiter clause matcher (spec 2026-10-15: event wakeups, Part E).
 * No IO — `ingestEvent` calls this after normalization, for every candidate
 * `findEventWaiters` returns.
 */
import type {
  DerivedEventDef,
  EventClause,
  EventMatchDigest,
  EventMatchSpec,
  NormalizedEvent,
} from "@valet/engine";
import { eventKeyMatches } from "./match.js";

export type ClauseResult = { matched: false } | { matched: true; derive?: string };

/** The subscription glob rule: an exact key, or a pattern with a trailing `.*`. */
export function keyMatches(pattern: string, key: string): boolean {
  return eventKeyMatches(key, [pattern]);
}

/** Whether a clause's key names the event directly, or through a derived def's sources. */
function matchedKey(
  clause: EventClause,
  event: NormalizedEvent,
  derived: readonly DerivedEventDef[],
): { ok: false } | { ok: true; derive?: string } {
  if (keyMatches(clause.key, event.key)) return { ok: true };
  const def = derived.find((d) => d.key === clause.key);
  if (def && def.sources.some((source) => keyMatches(source, event.key))) {
    return { ok: true, derive: clause.key };
  }
  return { ok: false };
}

/** One clause against one event (spec Part E, step 3). */
function evaluateClause(
  clause: EventClause,
  event: NormalizedEvent,
  derived: readonly DerivedEventDef[],
  self: readonly string[],
): ClauseResult {
  const key = matchedKey(clause, event, derived);
  if (!key.ok) return { matched: false };

  if (clause.status && (event.status === undefined || !clause.status.includes(event.status))) {
    return { matched: false };
  }
  if (
    clause.from_status &&
    (event.previousStatus === undefined || !clause.from_status.includes(event.previousStatus))
  ) {
    return { matched: false };
  }
  if (clause.actor !== undefined) {
    const actor = event.actor;
    if (!actor || (actor.login !== clause.actor && actor.externalId !== clause.actor)) {
      return { matched: false };
    }
  }
  if (clause.bots === false && event.actor?.bot === true) {
    return { matched: false };
  }
  if (!clause.include_self) {
    const actorId = event.actor?.externalId;
    if (actorId !== undefined && self.includes(actorId)) return { matched: false };
  }
  return key.derive !== undefined ? { matched: true, derive: key.derive } : { matched: true };
}

/**
 * Whether any clause of `spec` matches `event` (spec Part E, step 3). A
 * match through a derived key's `sources` carries that key as `derive`, so
 * the caller marks the digest for the WakeWatcher to resolve (Part B).
 */
export function matchClauses(
  spec: EventMatchSpec,
  event: NormalizedEvent,
  derived: readonly DerivedEventDef[],
): ClauseResult {
  for (const clause of spec.clauses) {
    const result = evaluateClause(clause, event, derived, spec.self);
    if (result.matched) return result;
  }
  return { matched: false };
}

/** True when a candidate clause names `from_status` (spec Part A4, Part E). */
export function needsPreviousStatus(spec: EventMatchSpec): boolean {
  return spec.clauses.some((clause) => clause.from_status !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The message or comment body for a digest's `text` (spec Part C). A small,
 * explicit lookup per service — an unrecognized shape yields no text.
 */
function textFromPayload(event: NormalizedEvent): string | undefined {
  const payload = asRecord(event.payload);
  if (!payload) return undefined;
  if (event.key.startsWith("slack.")) return stringField(payload.text);
  if (event.key.startsWith("github.")) {
    return (
      stringField(asRecord(payload.comment)?.body) ?? stringField(asRecord(payload.review)?.body)
    );
  }
  if (event.key.startsWith("linear.")) return stringField(asRecord(payload.data)?.body);
  return undefined;
}

/**
 * The digest's `url` (spec Part C). GitHub reads the first `html_url` the
 * payload carries, most specific first; Linear carries it on `refs.url`
 * (its `toEvent` puts the webhook `url` there). An unrecognized shape
 * yields no URL.
 */
function urlFromPayload(event: NormalizedEvent): string | undefined {
  if (event.key.startsWith("github.")) {
    const payload = asRecord(event.payload);
    if (!payload) return undefined;
    return (
      stringField(asRecord(payload.comment)?.html_url) ??
      stringField(asRecord(payload.review)?.html_url) ??
      stringField(asRecord(payload.pull_request)?.html_url) ??
      stringField(asRecord(payload.check_run)?.html_url) ??
      stringField(payload.html_url)
    );
  }
  if (event.key.startsWith("linear.")) return stringField(event.refs.url);
  return undefined;
}

/**
 * The buffered digest for a match (spec Part C). `derive` is the derived
 * key the WakeWatcher must resolve before delivery, when the clause
 * matched through a derived def's `sources` rather than the event's own
 * key.
 */
export function toDigest(event: NormalizedEvent, derive?: string): EventMatchDigest {
  const digest: EventMatchDigest = {
    key: event.key,
    subjects: event.subjects ?? [],
    summary: event.summary,
    occurredAt: event.occurredAt,
    dedupeKey: event.dedupeKey,
  };
  if (event.status !== undefined) digest.status = event.status;
  if (event.previousStatus !== undefined) digest.previousStatus = event.previousStatus;
  if (event.actor?.login !== undefined) digest.actor = event.actor.login;
  const url = urlFromPayload(event);
  if (url !== undefined) digest.url = url;
  const text = textFromPayload(event);
  if (text !== undefined) digest.text = text;
  if (derive !== undefined) digest.derive = derive;
  return digest;
}

/**
 * The Part E mention rule's predicate: a `slack.message` event mentions the
 * bot when its `text` contains `<@botUserId>`. Always false with no bot id.
 */
export function mentionsBot(event: NormalizedEvent, botUserId: string | undefined): boolean {
  if (!botUserId) return false;
  if (event.key !== "slack.message") return false;
  const text = asRecord(event.payload)?.text;
  return typeof text === "string" && text.includes(`<@${botUserId}>`);
}
