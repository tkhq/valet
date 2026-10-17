/**
 * Claim resolution at ingest (spec
 * docs/specs/2026-10-16-delivery-threads-and-claims-design.md, Part C).
 *
 * Per owner, one event reaches one assistant thread, and it reaches it
 * once (INV-D1). Ingest evaluates the waiter candidates first, then calls
 * `resolveClaims` before it inserts the deliveries. The result says which
 * deliveries carry a destination stamp and which waiters append their
 * digests. Workflow and `signal` targets never yield to a claim (INV-D7).
 */
import type { EventCatalogEntry, NormalizedEvent, Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ConversationBinding } from "./conversation-binding.js";
import type { Destination } from "./destination.js";
import { subscriptionMatchesEvent } from "./match.js";
import { isTeamAssistantMention, mentionSenderActor } from "./team-slack-gate.js";
import type { WaiterCandidate, WaiterDecision } from "./waiters.js";

/** The subscription fields claim resolution reads. */
export interface ClaimSubscription {
  id: string;
  ownerType: Principal["type"];
  ownerId: string;
  target: unknown;
}

export interface ClaimDecision {
  /** The destination stamp per subscription id. A subscription with no entry is unstamped. */
  deliveries: Map<string, Destination>;
  /** The decision per waiter id. A waiter with no entry appends. */
  waiters: Map<string, WaiterDecision>;
  /** The number of owners whose resolution threw. Their deliveries are unstamped and their waiters append (INV-D6). */
  failedOwners: number;
}

export interface ClaimDeps {
  /** True when the thread can receive an assistant delivery of `owner` (`isDeliverableTarget`). */
  isDeliverable(owner: Principal, target: { sessionId: string; threadId: string }): Promise<boolean>;
  /**
   * True when an enabled assistant subscription of `owner` matches the
   * `slack.app_mention` twin and its sender gate admits the sender
   * (`mentionSenderActor`, without a drop log). Part C step 8.
   */
  mentionCovered(owner: Principal, twin: NormalizedEvent): Promise<boolean>;
  /**
   * True when the dispatcher skips this personal subscription for `event`
   * because a team rule covers it (`hasTeamCoverage`). A covered rule
   * delivers nothing, so it claims nothing.
   */
  teamCovered(subscriptionId: string, event: NormalizedEvent): Promise<boolean>;
}

export interface ResolveClaimsArgs {
  orgId: string;
  event: NormalizedEvent;
  /** The subscriptions the event matched, every target kind. */
  matched: ReadonlyArray<ClaimSubscription>;
  candidates: ReadonlyArray<WaiterCandidate>;
  /** The other half of a Slack mention, from the plugin's `conversationalTwin` hook, or null. */
  twin: NormalizedEvent | null;
  /** The owner's conversation binding for the event. Called once per owner that has a candidate. */
  binding(owner: Principal): Promise<ConversationBinding | null>;
  /** Whether the event is conversational for an owner with this binding. */
  conversational(binding: ConversationBinding | null): boolean;
}

/** True for an assistant target. The stored discriminator is still the legacy value `orchestrator`. */
export function isAssistantTarget(target: unknown): boolean {
  return typeof target === "object" && target !== null && "kind" in target && target.kind === "orchestrator";
}

function isPrincipalType(value: string): value is Principal["type"] {
  return value === "user" || value === "team" || value === "org";
}

function ownerKey(owner: { type: string; id: string }): string {
  return `${owner.type}\u0000${owner.id}`;
}

/** The length of the longest subject that the waiter and the event share. */
function specificity(candidate: WaiterCandidate, event: NormalizedEvent): number {
  const eventSubjects = new Set(event.subjects ?? []);
  let best = 0;
  for (const subject of candidate.waiter.subjects ?? []) {
    if (eventSubjects.has(subject) && subject.length > best) best = subject.length;
  }
  return best;
}

/**
 * True when `b` is newer than `a`. A `createdAt` tie breaks on the waiter id,
 * so both Slack halves choose the same candidate in any input order.
 */
function isNewer(b: WaiterCandidate, a: WaiterCandidate): boolean {
  if (b.waiter.createdAt !== a.waiter.createdAt) return b.waiter.createdAt > a.waiter.createdAt;
  return b.waiter.id > a.waiter.id;
}

/** The newest candidate. */
function newest(candidates: ReadonlyArray<WaiterCandidate>): WaiterCandidate {
  return candidates.reduce((a, b) => (isNewer(b, a) ? b : a));
}

/** The redirect target: the most specific matching subject, newest on a tie (Part C step 3). */
function redirectTarget(candidates: ReadonlyArray<WaiterCandidate>, event: NormalizedEvent): WaiterCandidate {
  return candidates.reduce((a, b) => {
    const sa = specificity(a, event);
    const sb = specificity(b, event);
    if (sb !== sa) return sb > sa ? b : a;
    return isNewer(b, a) ? b : a;
  });
}

function sameThread(candidate: WaiterCandidate, thread: { sessionId: string; threadId: string }): boolean {
  return candidate.waiter.sessionId === thread.sessionId && candidate.waiter.threadId === thread.threadId;
}

interface OwnerResult {
  destination: Destination | null;
  waiters: Map<string, WaiterDecision>;
}

/**
 * Merges the candidates that accept an event's Slack twin into the event's
 * own candidates (Part C step 8). Both halves of a mention then choose a
 * redirect target over the same set. A twin candidate can be the redirect
 * target, but it carries no digests: the twin is a prediction, and the
 * waiter's digest comes from the ingest of the real event.
 */
export function withTwinCandidates(
  own: ReadonlyArray<WaiterCandidate>,
  twin: ReadonlyArray<WaiterCandidate>,
): WaiterCandidate[] {
  const merged = new Map(own.map((c) => [c.waiter.id, c]));
  for (const candidate of twin) {
    if (!candidate.accepted) continue;
    const existing = merged.get(candidate.waiter.id);
    if (existing?.accepted) continue;
    merged.set(candidate.waiter.id, { ...candidate, digests: existing?.digests ?? [] });
  }
  return [...merged.values()];
}

async function resolveOwner(
  deps: ClaimDeps,
  args: ResolveClaimsArgs,
  owner: Principal,
  hasAssistantDelivery: boolean,
): Promise<OwnerResult | null> {
  const mine = args.candidates.filter((c) => c.accepted && c.session.ownerType === owner.type && c.session.ownerId === owner.id);
  const claims: WaiterCandidate[] = [];
  for (const candidate of mine) {
    const target = { sessionId: candidate.waiter.sessionId, threadId: candidate.waiter.threadId };
    if (await deps.isDeliverable(owner, target)) claims.push(candidate);
  }
  if (claims.length === 0) return null;

  // At a `slack.message` ingest, the mention twin decides the digests when
  // a subscription of this owner will deliver the mention.
  const twin = args.twin;
  const mentionComing = args.event.key === "slack.message" && twin?.key === "slack.app_mention"
    && await deps.mentionCovered(owner, twin);
  if (!hasAssistantDelivery && !mentionComing) return null;

  const binding = await args.binding(owner);
  const waiters = new Map<string, WaiterDecision>(claims.map((c) => [c.waiter.id, "append"]));
  let destination: Destination | null = null;

  if (binding?.via === "legacy_follow") {
    // A legacy follow names no thread, so no candidate can be matched to it.
    // The dispatcher resolves the delivery from the binding (Part C step 7).
    return { destination: null, waiters };
  }
  if (binding) {
    // The binding wins (Part B step 1). A candidate in its thread appends no
    // digest (Part C step 4).
    for (const c of claims) if (sameThread(c, binding)) waiters.set(c.waiter.id, "suppress");
    destination = {
      kind: "target", sessionId: binding.sessionId, threadId: binding.threadId,
      reason: binding.via === "follow" ? "conversation_follow" : "conversation_pull_request",
    };
  } else if (args.conversational(binding)) {
    const target = redirectTarget(claims, args.event);
    waiters.set(target.waiter.id, "suppress");
    // The stamp names the waiter, so the dispatcher can give it the digest
    // back when the delivery is skipped later, and can end a once-mode waiter
    // after the delivery lands (Part C step 5).
    destination = {
      kind: "target", sessionId: target.waiter.sessionId, threadId: target.waiter.threadId, reason: "claim_redirect",
      matchedWaiterId: target.waiter.id,
    };
  } else {
    if (mentionComing) {
      // The mention reaches the redirect target through the subscription.
      // The same choice runs at the mention's ingest.
      waiters.set(redirectTarget(claims, args.event).waiter.id, "suppress");
    }
    destination = { kind: "skip", reason: `claimed by thread ${newest(claims).waiter.threadId}` };
  }
  return { destination: hasAssistantDelivery ? destination : null, waiters };
}

/**
 * Resolves the claims for one event (Part C steps 1 to 5 and 8). Per owner
 * of a matched assistant subscription, the claim candidates are the
 * owner's accepted waiters whose thread can receive a delivery.
 *
 * - Ambient event: every candidate appends. The delivery is skipped and
 *   names the newest candidate.
 * - Conversational event: the delivery targets the candidate with the most
 *   specific matching subject, newest on a tie. That candidate appends no
 *   digest. The others append.
 * - A binding wins. A candidate in the binding's thread appends no digest.
 *
 * A failure for one owner leaves that owner unstamped with every waiter
 * appending (INV-D6), and the other owners still resolve.
 */
export async function resolveClaims(deps: ClaimDeps, args: ResolveClaimsArgs): Promise<ClaimDecision> {
  const decision: ClaimDecision = { deliveries: new Map(), waiters: new Map(), failedOwners: 0 };
  const owners = new Map<string, { owner: Principal; subscriptions: ClaimSubscription[] }>();
  for (const sub of args.matched) {
    if (!isAssistantTarget(sub.target)) continue;
    const owner: Principal = { type: sub.ownerType, id: sub.ownerId };
    const entry = owners.get(ownerKey(owner)) ?? { owner, subscriptions: [] };
    entry.subscriptions.push(sub);
    owners.set(ownerKey(owner), entry);
  }
  // The mention twin can suppress a digest for an owner whose rules did not
  // match the message itself (Part C step 8).
  if (args.event.key === "slack.message" && args.twin?.key === "slack.app_mention") {
    for (const c of args.candidates) {
      if (!c.accepted || !isPrincipalType(c.session.ownerType)) continue;
      const owner: Principal = { type: c.session.ownerType, id: c.session.ownerId };
      if (!owners.has(ownerKey(owner))) owners.set(ownerKey(owner), { owner, subscriptions: [] });
    }
  }

  for (const { owner, subscriptions } of owners.values()) {
    let result: OwnerResult | null;
    const delivering: ClaimSubscription[] = [];
    try {
      // A team-covered personal rule delivers nothing (the dispatcher skips
      // it), so it neither claims nor takes a stamp.
      for (const sub of subscriptions) if (!(await deps.teamCovered(sub.id, args.event))) delivering.push(sub);
      result = await resolveOwner(deps, args, owner, delivering.length > 0);
    } catch (error) {
      decision.failedOwners += 1;
      console.error(`[event-claims] claim resolution failed for a ${owner.type} owner in org ${args.orgId}`, error);
      continue;
    }
    if (!result) continue;
    for (const [waiterId, choice] of result.waiters) decision.waiters.set(waiterId, choice);
    const destination = result.destination;
    if (!destination) continue;
    if (destination.kind === "target" && destination.reason === "claim_redirect") {
      // Two rules of one owner that redirect to one thread would give it two
      // turns. One delivery, the lowest subscription id, carries the
      // redirect. The others skip and name the thread.
      const [first, ...rest] = [...delivering].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (first) decision.deliveries.set(first.id, destination);
      for (const sub of rest) decision.deliveries.set(sub.id, { kind: "skip", reason: `claimed by thread ${destination.threadId}` });
    } else {
      for (const sub of delivering) decision.deliveries.set(sub.id, destination);
    }
  }
  return decision;
}

/** A subscription row, as far as the mention twin check reads it. */
export interface MentionRuleSubscription {
  enabled: boolean;
  orgId: string;
  ownerType: string;
  ownerId: string;
  createdBy: string;
  audience?: string | null;
  target: unknown;
  eventKeys: unknown;
  filters: unknown;
}

/**
 * Whether an enabled assistant subscription of `owner` among `subs` would
 * deliver the mention `twin` (Part C step 8). The subscription matcher
 * tests the twin's payload, then the dispatcher's own sender gate
 * (`mentionSenderActor`) runs without a drop log. A mention that the gate
 * refuses reaches no subscription, so the waiter receives the message as
 * an ordinary channel message. A personal rule that a team rule covers
 * (`teamCovered`, the dispatcher's `hasTeamCoverage`) does not count.
 */
export async function mentionCoveredBy<S extends MentionRuleSubscription>(
  db: AppDb,
  subs: ReadonlyArray<S>,
  owner: Principal,
  twin: NormalizedEvent,
  catalog: EventCatalogEntry[],
  teamCovered: (sub: S, twin: NormalizedEvent) => Promise<boolean>,
): Promise<boolean> {
  for (const sub of subs) {
    if (!sub.enabled || sub.ownerType !== owner.type || sub.ownerId !== owner.id || !isAssistantTarget(sub.target)) continue;
    if (!subscriptionMatchesEvent(sub, twin.key, twin.payload, catalog, isTeamAssistantMention(sub, twin.key), twin.subjects)) continue;
    if (await mentionSenderActor(db, sub, twin.key, twin.payload, false) === null) continue;
    // A personal rule that a team rule covers delivers nothing.
    if (await teamCovered(sub, twin)) continue;
    return true;
  }
  return false;
}
