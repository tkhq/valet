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

/**
 * What the clauses of a waiter matched in one event (spec Part E, step 3).
 * `direct` is true when a clause on the event's own key matched. `derive`
 * lists, in clause order and without repeats, the derived keys whose
 * clauses matched through their `sources`. Both can hold for one event.
 */
export interface ClauseMatches {
  direct: boolean;
  derive: string[];
}

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

/**
 * The status, previous-status, actor, bot, and self filters of one clause
 * against one event. A direct clause applies them to the event at ingest.
 * A derived clause applies `status` and `from_status` to the derived event
 * in the WakeWatcher (`derivedClausesAccept`).
 */
function filtersAccept(clause: EventClause, event: NormalizedEvent, self: readonly string[]): boolean {
  if (clause.status && (event.status === undefined || !clause.status.includes(event.status))) return false;
  if (
    clause.from_status &&
    (event.previousStatus === undefined || !clause.from_status.includes(event.previousStatus))
  ) {
    return false;
  }
  if (clause.actor !== undefined) {
    const actor = event.actor;
    if (!actor || (actor.login !== clause.actor && actor.externalId !== clause.actor)) return false;
  }
  if (clause.bots === false && event.actor?.bot === true) return false;
  if (!clause.include_self) {
    const actorId = event.actor?.externalId;
    if (actorId !== undefined && self.includes(actorId)) return false;
  }
  return true;
}

/**
 * One clause against one event (spec Part E, step 3). A derived clause
 * matches a source event on its key alone: its filters describe the
 * derived event, so the WakeWatcher checks them after `derive` returns.
 * A direct clause matches only an event that carries the waiter's
 * `primarySubject`, when the spec has one: the waiter's other subjects
 * exist for derived sources only (spec Part C).
 */
function evaluateClause(
  clause: EventClause,
  event: NormalizedEvent,
  derived: readonly DerivedEventDef[],
  spec: EventMatchSpec,
): { matched: false } | { matched: true; derive?: string } {
  const key = matchedKey(clause, event, derived);
  if (!key.ok) return { matched: false };
  if (key.derive !== undefined) return { matched: true, derive: key.derive };
  if (spec.primarySubject !== undefined && !(event.subjects ?? []).includes(spec.primarySubject)) {
    return { matched: false };
  }
  return filtersAccept(clause, event, spec.self) ? { matched: true } : { matched: false };
}

/**
 * What the clauses of `spec` match in `event` (spec Part E, step 3). Every
 * clause is evaluated: a direct match and a derived match on one event
 * each produce a digest, so a mid-run failure goes out now and the derive
 * digest stays for the WakeWatcher (Part B).
 */
export function matchClauses(
  spec: EventMatchSpec,
  event: NormalizedEvent,
  derived: readonly DerivedEventDef[],
): ClauseMatches {
  const result: ClauseMatches = { direct: false, derive: [] };
  for (const clause of spec.clauses) {
    const one = evaluateClause(clause, event, derived, spec);
    if (!one.matched) continue;
    if (one.derive === undefined) result.direct = true;
    else if (!result.derive.includes(one.derive)) result.derive.push(one.derive);
  }
  return result;
}

/** True when `matches` asks for at least one digest. */
export function anyMatch(matches: ClauseMatches): boolean {
  return matches.direct || matches.derive.length > 0;
}

/**
 * Whether a derived event passes the `status` and `from_status` filters of
 * at least one clause on its derived key (spec Part F, step 1). The
 * WakeWatcher calls it after `derive` returns an event; a derived event
 * that no clause accepts sends no signal.
 */
export function derivedClausesAccept(spec: EventMatchSpec, deriveKey: string, derivedEvent: EventMatchDigest): boolean {
  return spec.clauses.some((clause) => {
    if (clause.key !== deriveKey) return false;
    if (clause.status && (derivedEvent.status === undefined || !clause.status.includes(derivedEvent.status))) return false;
    if (
      clause.from_status &&
      (derivedEvent.previousStatus === undefined || !clause.from_status.includes(derivedEvent.previousStatus))
    ) {
      return false;
    }
    return true;
  });
}

/**
 * True when a direct clause names `from_status` (spec Part A4, Part E). A
 * derived clause's `from_status` reads the derived event, not the source.
 */
export function needsPreviousStatus(spec: EventMatchSpec, derived: readonly DerivedEventDef[] = []): boolean {
  return spec.clauses.some((clause) => clause.from_status !== undefined && !derived.some((d) => d.key === clause.key));
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
 * key. A derive digest's `dedupeKey` is `derive:<derived key>:<event
 * dedupeKey>`, so it and the direct digest of the same event are both
 * buffered (INV-E4 holds per key).
 */
export function toDigest(event: NormalizedEvent, derive?: string): EventMatchDigest {
  const digest: EventMatchDigest = {
    key: event.key,
    subjects: event.subjects ?? [],
    summary: event.summary,
    occurredAt: event.occurredAt,
    dedupeKey: derive !== undefined ? `derive:${derive}:${event.dedupeKey}` : event.dedupeKey,
  };
  if (event.key === "child.settled" || event.key === "child.gate_opened") digest.refs = event.refs;
  if (typeof event.refs.head_sha === "string") digest.head_sha = event.refs.head_sha;
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

