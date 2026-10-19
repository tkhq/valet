/**
 * The pure destination resolver (spec
 * 2026-10-16-delivery-threads-and-claims-design.md, Part B). It decides
 * which assistant thread one delivery lands in: a conversation binding and
 * a waiter claim outrank the rule's thread policy, in that order. No I/O:
 * the caller gathers the binding, the claim, and the event, then resolves a
 * thread only at delivery time (Part B step 3).
 */
import type { AssistantThreadPolicy } from "@valet/shared";

/** Where one assistant delivery lands: a resolved thread, a key to resolve at delivery, or a skip. */
export type Destination =
  | {
    kind: "target"; sessionId: string; threadId: string; reason: DestinationReason;
    /** The waiter that this claim redirect targets. A once-mode waiter ends
     * as matched after delivery (Part C step 5). */
    matchedWaiterId?: string;
    /** The waiters in a binding's thread whose digests ingest suppressed
     * (Part C step 4). A binding delivery never ends them. */
    suppressedWaiterIds?: string[];
  }
  | { kind: "key"; key: string; title: string; reason: DestinationReason; note?: string }
  | { kind: "skip"; reason: `claimed by thread ${string}` };

/** Why a destination resolved as it did (spec Part E's counter label). */
export type DestinationReason =
  | "policy_new"
  | "policy_subject"
  | "policy_own"
  | "policy_existing"
  | "conversation_follow"
  | "conversation_pull_request"
  | "claim_redirect";

export interface DestinationInput {
  rule: { id: string; kind: "subscription" | "schedule"; name: string; policy: AssistantThreadPolicy };
  event?: {
    deliveryId: string;
    summary: string;
    naturalSubject: { subject: string; label: string } | null;
    conversational: boolean;
  };
  fireAt?: number;
  binding: { sessionId: string; threadId: string; via: "follow" | "pull_request" } | null;
  claim: { sessionId: string; threadId: string; waiterId: string } | null;
}

type KeyDestination = Extract<Destination, { kind: "key" }>;

/** A `key` destination for the rule's own thread, by kind (spec Part B step 2). */
function ownDestination(rule: DestinationInput["rule"]): KeyDestination {
  const key = rule.kind === "subscription" ? `sub:${rule.id}` : `schedule:${rule.id}`;
  return { kind: "key", key, title: rule.name, reason: "policy_own" };
}

/** The `new`-mode destination for a subscription: one key per delivery. */
function newSubscriptionDestination(rule: DestinationInput["rule"], event: DestinationInput["event"]): Destination {
  if (event === undefined) {
    throw new Error("A new-mode destination for an event needs the event.");
  }
  return {
    kind: "key",
    key: `sub:${rule.id}:${event.deliveryId}`,
    title: summaryTitle(event.summary),
    reason: "policy_new",
  };
}

/** The `new`-mode destination for a schedule: one key per fire time. */
function newScheduleDestination(rule: DestinationInput["rule"], fireAt: number | undefined): Destination {
  if (fireAt === undefined) {
    throw new Error("A new-mode destination for a schedule needs fireAt.");
  }
  return {
    kind: "key",
    key: `schedule:${rule.id}:${fireAt}`,
    title: `${rule.name} · ${isoDateUTC(fireAt)}`,
    reason: "policy_new",
  };
}

/** The destination the rule's thread policy names, once no binding or claim applies. */
function resolveByPolicy(input: DestinationInput): Destination {
  const { rule, event, fireAt } = input;
  const policy = rule.policy;
  if (policy.mode === "existing") {
    return { kind: "target", sessionId: policy.sessionId, threadId: policy.threadId, reason: "policy_existing" };
  }
  if (policy.mode === "new") {
    return rule.kind === "subscription" ? newSubscriptionDestination(rule, event) : newScheduleDestination(rule, fireAt);
  }
  if (policy.mode === "subject") {
    const naturalSubject = event?.naturalSubject ?? null;
    if (naturalSubject !== null) {
      return { kind: "key", key: `subject:${naturalSubject.subject}`, title: naturalSubject.label, reason: "policy_subject" };
    }
    // No plugin named a subject for this event (or this is a schedule, which
    // carries no event at all). Fall back to the rule's own thread.
    // A stored stamp note that no reader shows.
    // copy-lint: allow subject
    return { ...ownDestination(rule), note: "subject mode with no natural subject" };
  }
  // policy.mode === "own"
  return ownDestination(rule);
}

/**
 * Resolve one assistant delivery's destination. Precedence (spec Part B
 * step 1): a conversation binding first, then a waiter claim, then the
 * rule's thread policy.
 */
export function resolveDestination(input: DestinationInput): Destination {
  const { event, binding, claim } = input;
  if (binding !== null) {
    return {
      kind: "target",
      sessionId: binding.sessionId,
      threadId: binding.threadId,
      reason: binding.via === "follow" ? "conversation_follow" : "conversation_pull_request",
    };
  }
  if (claim !== null) {
    // A schedule's `event` is always undefined, so `event?.conversational`
    // is never `true` for one: a claim paired with a schedule always skips.
    // That combination is reachable only through the type signature. In
    // practice a claim always pairs with a subscription's event.
    if (event?.conversational === true) {
      return { kind: "target", sessionId: claim.sessionId, threadId: claim.threadId, reason: "claim_redirect" };
    }
    return { kind: "skip", reason: `claimed by thread ${claim.threadId}` };
  }
  return resolveByPolicy(input);
}

/** A thread title from an event summary: trimmed, at most 80 characters. */
export function summaryTitle(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return "Event";
  if (trimmed.length <= 80) return trimmed;
  const cut = trimmed.slice(0, 80);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

function isoDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DESTINATION_REASONS: readonly DestinationReason[] = [
  "policy_new", "policy_subject", "policy_own", "policy_existing",
  "conversation_follow", "conversation_pull_request", "claim_redirect",
];

function isDestinationReason(value: unknown): value is DestinationReason {
  return typeof value === "string" && (DESTINATION_REASONS as readonly string[]).includes(value);
}

const CLAIM_SKIP_PREFIX = "claimed by thread ";

/**
 * The destination that ingest stamped on a delivery row (spec Part C step
 * 6), or null when the row has no stamp. The column is untyped jsonb, so
 * this checks the shape. A value of the wrong shape reads as no stamp: the
 * dispatcher then resolves by binding and policy (step 7), which can
 * duplicate a delivery but never loses one (INV-D6).
 */
export function readDestinationStamp(value: unknown): Destination | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  if (value.kind === "skip") {
    if (!("reason" in value) || typeof value.reason !== "string" || !value.reason.startsWith(CLAIM_SKIP_PREFIX)) return null;
    const threadId = value.reason.slice(CLAIM_SKIP_PREFIX.length);
    return threadId.length > 0 ? { kind: "skip", reason: `claimed by thread ${threadId}` } : null;
  }
  if (!("reason" in value) || !isDestinationReason(value.reason)) return null;
  if (value.kind === "target") {
    if (!("sessionId" in value) || typeof value.sessionId !== "string" || !("threadId" in value) || typeof value.threadId !== "string") return null;
    const matched = "matchedWaiterId" in value && typeof value.matchedWaiterId === "string" ? value.matchedWaiterId : undefined;
    const suppressed = "suppressedWaiterIds" in value && Array.isArray(value.suppressedWaiterIds)
      ? value.suppressedWaiterIds.filter((id): id is string => typeof id === "string") : [];
    return {
      kind: "target", sessionId: value.sessionId, threadId: value.threadId, reason: value.reason,
      ...(matched !== undefined ? { matchedWaiterId: matched } : {}),
      ...(suppressed.length > 0 ? { suppressedWaiterIds: suppressed } : {}),
    };
  }
  if (value.kind === "key") {
    if (!("key" in value) || typeof value.key !== "string" || !("title" in value) || typeof value.title !== "string") return null;
    const note = "note" in value && typeof value.note === "string" ? value.note : undefined;
    return { kind: "key", key: value.key, title: value.title, reason: value.reason, ...(note !== undefined ? { note } : {}) };
  }
  return null;
}

/**
 * The waiters whose digests ingest suppressed for this stamp: a claim
 * redirect's target, or the waiters in a binding's thread. The dispatcher
 * gives them the digest back when it skips the delivery after ingest.
 */
export function suppressedWaiters(destination: Destination): string[] {
  if (destination.kind !== "target") return [];
  return [
    ...(destination.matchedWaiterId !== undefined ? [destination.matchedWaiterId] : []),
    ...(destination.suppressedWaiterIds ?? []),
  ];
}

/** The thread that claimed a skipped delivery, from its stamp, or null. */
export function claimedThreadId(stamp: unknown): string | null {
  const destination = readDestinationStamp(stamp);
  return destination?.kind === "skip" ? destination.reason.slice(CLAIM_SKIP_PREFIX.length) : null;
}
