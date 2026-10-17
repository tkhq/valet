import type { Presence } from "@valet/shared";
/**
 * Event-delivery dispatcher: drains `event_deliveries` rows into their
 * subscription targets (workflow run start / assistant signal prompt /
 * parked-run workflow signals).
 *
 * Same lifecycle pattern as `LocalRunHost`: a poll loop (1s) that the
 * ingest path nudges in-process via `nudge()`, so the interval is a
 * staleness floor, not the delivery path.
 *
 * Claiming deviates from the design sketch's `SELECT ... FOR UPDATE SKIP
 * LOCKED`: a bare `FOR UPDATE` outside an enclosing transaction releases
 * its locks at statement end (autocommit), so it wouldn't fence anything
 * here — and this codebase's established row-claim pattern is a
 * single-statement CAS (`pg-store.ts` `claimRun`). The claim below is one
 * atomic `UPDATE ... RETURNING id` whose OUTER `WHERE` repeats the due
 * conditions (status + `next_attempt_at <= now`); the `id IN (<subquery>)`
 * part only provides ordering/LIMIT. That outer qual is the cross-process
 * fence: under READ COMMITTED, when two connections race, the loser's
 * EvalPlanQual recheck re-evaluates the outer predicate against the
 * winner's committed row — where `next_attempt_at` has already been
 * pushed forward by the lease — so the recheck fails and the loser skips
 * the row. (Fencing only via the `IN (subquery)` would NOT work: EPQ
 * rechecks the subquery against its original snapshot, so both sides
 * would claim the row.) A crash mid-delivery leaves the row pending; it
 * becomes due again when the lease lapses.
 */
import { slackEventChannel } from "../services/thread-access.js";
import type { ChannelOrigin, NormalizedEvent, PromptAuthor, SignalContent, ValetPlugin } from "@valet/engine";
import { readThreadPolicy, type AssistantThreadPolicy } from "@valet/shared";
import type { RunHost, RunParams, WorkflowStore, WorkflowTriggerPayload } from "@valet/workflow";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "../workflows/definition-version.js";
import { findFollowedThread, upsertFollowedThread } from "./followed-threads.js";
import { conversationBinding, isConversationalEvent } from "./conversation-binding.js";
import { hasTeamCoverage } from "./delivery-policy.js";
import { allCatalogEntries, conversationalTwinOf } from "./ingest.js";
import { mentionCoveredBy } from "./claims.js";
import { followRouteFor } from "../channels/follow-router.js";
import { buildPromptValues, hasPromptConfig, renderEventPrompt } from "./prompt-template.js";
import { inboundSlackMessage, isOwnPullRequestWrite, OWN_WRITE_SETTLE_MS, pullRequestComment, type InboundChannelMessage } from "../services/channel-messages.js";
import {
  followBindingAuthorized,
  isTeamAssistantMention,
  mentionAudience,
  mentionSenderActor,
  channelMessageAuthor,
  newcomerAuthor,
} from "./team-slack-gate.js";
import { resolvePath } from "./match.js";
import {
  PinUnavailableError,
  PIN_UNAVAILABLE_MESSAGE,
  isDeliverableTarget,
  type DeliveredThread,
  type DeliveryDestination,
} from "./assistant-delivery.js";
import { readDestinationStamp, resolveDestination, summaryTitle, suppressedWaiters, type Destination } from "./destination.js";
import { appendReceiptStageForEvent, destinationReceiptStage, destinationStageMarker } from "./receipts.js";
import {
  destinationMetricReason,
  recordDeliveryDestination,
  type DeliveryDestinationMetricReason,
  type DestinationRecorder,
} from "../observability/delivery-metrics.js";

/** Retry backoff per failed attempt; a failure past the last entry is dead. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const POLL_MS = 1_000;
const BATCH = 20;
/** How long a claimed-but-unresolved row stays invisible to other polls. */
const CLAIM_LEASE_MS = 60_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_BODY_EXCERPT_CHARS = 4_000;

export interface AssistantDeliverFn {
  (args: {
    orgId: string;
    ownerType: "user" | "team" | "org";
    ownerId: string;
    /**
     * The human the delivery acts for. NOT `ownerId`: on a team or org
     * subscription the owner is a team/org id, and this value is written to
     * `agent_sessions.user_id`, which holds a user. The subscription's
     * author is the actor for ordinary events. Team mentions use the linked
     * sender, after the live membership check.
     */
    actorUserId: string;
    signal: SignalContent;
  presence?: Presence;
    dispatchId: string;
    /** Where the delivery lands: the resolved destination (spec 2026-10-16:
     * delivery threads, Part B). A skip never reaches this seam. */
    destination: DeliveryDestination;
    /** The channel message this delivery carries, for the channel record. */
    inbound?: InboundChannelMessage;
    /** Who wrote the message, when that is not `actorUserId` (`newcomerAuthor`). */
    author?: PromptAuthor;
    /** The Slack channel the content came from, which the thread records for its read gate. */
    slackChannel?: string;
  }): Promise<DeliveredThread>;
}

export interface EventDispatcherDeps {
  db: AppDb;
  workflowRunHost: RunHost;
  workflowStore: WorkflowStore;
  /** Seam over the assistant runtime and the destination thread's `submitPrompt`. See `assistant-target.ts`. */
  deliverToAssistant: AssistantDeliverFn;
  /**
   * Where a channel-originated event should route a reply. Returns the origin
   * for a channel event that names a conversation (a Slack message or mention),
   * or `null` for a non-channel event (GitHub, Linear) or one with no
   * conversation. Wired from `channelHost.transportFor(...).threadKeyFromEvent`.
   */
  resolveChannelOrigin?: (service: string, eventKey: string, payload: unknown) => ChannelOrigin | null;
  /**
   * Resolve a channel message's sender display name and clean its text, so the
   * delivered signal names the person and drops raw ids / Slack markup. Wired
   * from `channelHost` (`channelMessageNormalizer`). Absent → the raw text and
   * id are used unchanged.
   */
  normalizeChannelMessage?: (
    service: string,
    msg: { userId?: string; text: string },
  ) => Promise<{ senderName?: string; text: string }>;
  /**
   * The loaded plugins, for the trigger catalog a `{{payload.<field>}}`
   * variable resolves through (`events/prompt-template.ts`), and for each
   * event's natural subject (`naturalSubject`, used by a `subject` thread
   * policy). A dispatcher built without plugins delivers every default body
   * unchanged, and a `subject` rule falls back to its own thread.
   */
  plugins?: ValetPlugin[];
  /**
   * Ends a once-mode waiter that a claim redirect delivered to, after the
   * delivery lands (spec 2026-10-16: delivery threads and claims, Part C
   * step 5). The WakeWatcher owns the end and its one terminal signal
   * (`WakeWatcher.endDeliveredWaiter`). Absent → the waiter stays running.
   */
  endMatchedWaiter?: (args: { waiterId: string; sessionId: string; threadId: string }) => Promise<boolean>;
  /**
   * Appends the event's digest to the waiter that a claim redirect named,
   * when the dispatcher skips that delivery for a reason decided after
   * ingest (`claim-recovery.ts`). Returns true when the waiter got a digest.
   * Absent → the waiter does not see the event.
   */
  recoverClaimedDigest?: (args: { waiterId: string; orgId: string; service: string; event: NormalizedEvent }) => Promise<boolean>;
  /**
   * The org's Slack bot user id, for the follow router's predicate and the
   * `conversationalTwin` hook. Absent: no message text counts as
   * addressed to the bot.
   */
  slackBotUserId?: (orgId: string) => Promise<string | undefined>;
  /**
   * Counts where a delivery landed (spec Part E step 3). Absent → the
   * `valet_event_delivery_destination` counter. Tests pass a recorder.
   */
  recordDestination?: DestinationRecorder;
}

/** The message text on a channel event payload (`text`), when present. */
function channelText(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null) {
    const t = (payload as Record<string, unknown>).text;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return undefined;
}

/** The dispatch id an assistant delivery is admitted under. The engine keeps
 * it on the queue item, so the item, and the thread it ran in, can be found
 * from the delivery. */
export function eventDeliveryDispatchId(deliveryId: string): string {
  return `event:${deliveryId}`;
}

/** The workflow run a delivery starts. Derived from the delivery, not
 * minted, so a retried delivery resolves to the same run (`startWorkflow`). */
export function eventDeliveryRunId(deliveryId: string): string {
  return `wfrun_evt_${deliveryId}`;
}

/**
 * One delivery's effective thread policy (spec 2026-10-16: delivery
 * threads, Part A step 3). An absent policy reads as `new` for a delivery
 * with a channel origin, so each Slack conversation keeps its own assistant
 * thread, and as `own` otherwise. A stored policy always wins.
 * `readThreadPolicy` stays shape-only.
 */
export function deliveryThreadPolicy(target: { thread?: unknown }, delivery: { channelOrigin: boolean }): AssistantThreadPolicy {
  if (target.thread === undefined || target.thread === null) return delivery.channelOrigin ? { mode: "new" } : { mode: "own" };
  return readThreadPolicy(target.thread);
}

/** The stored event row as the plugin contract's `NormalizedEvent`, for `naturalSubject`. */
function normalizedEventFromRow(event: typeof events.$inferSelect): NormalizedEvent {
  const actor = event.actor;
  const externalId = typeof actor === "object" && actor !== null && "externalId" in actor && typeof actor.externalId === "string"
    ? actor.externalId : undefined;
  const login = typeof actor === "object" && actor !== null && "login" in actor && typeof actor.login === "string" ? actor.login : undefined;
  return {
    key: event.eventKey,
    dedupeKey: event.dedupeKey,
    occurredAt: new Date(event.occurredAt).toISOString(),
    ...(externalId !== undefined ? { actor: { externalId, ...(login !== undefined ? { login } : {}) } } : {}),
    // `refs` is owned by ingest (NormalizedEvent.refs is Record<string, string>).
    refs: event.refs as Record<string, string>,
    summary: event.summary,
    payload: event.payload,
    ...(event.subjects ? { subjects: event.subjects } : {}),
  };
}

/**
 * Settle a delivery whose destination is a skip (spec 2026-10-16: delivery
 * threads, Part B step 3). It submits nothing and creates no thread
 * (INV-D3). The row, the counter, and the receipt record the reason.
 */
export async function recordSkippedDelivery(db: AppDb, args: {
  deliveryId: string;
  subscriptionId: string;
  attempts: number;
  orgId: string;
  eventId: string;
  destination: Extract<Destination, { kind: "skip" }>;
}, recordDestination: DestinationRecorder = recordDeliveryDestination): Promise<void> {
  await db.update(eventDeliveries).set({ status: "skipped", lastError: `Skipped, ${args.destination.reason}.`, attempts: args.attempts + 1 })
    .where(eq(eventDeliveries.id, args.deliveryId));
  const recorded = await appendReceiptStageForEvent(db, args.orgId, args.eventId,
    destinationReceiptStage({ subscriptionId: args.subscriptionId, deliveryId: args.deliveryId }, args.destination),
    destinationStageMarker(args.deliveryId));
  if (recorded !== "exists") recordDestination("claim_skip");
}

/** Why another path owns a delivery, as its skip text and counter reason. */
interface OwnedElsewhere {
  text: string;
  reason: "follow_routed" | "mention_covered";
}

/** The `target` jsonb column's shape — written only by the subscriptions CRUD validator. */
interface SubscriptionTarget {
  kind: "workflow" | "orchestrator" | "signal";
  /** The assistant thread policy (spec 2026-10-16: delivery threads, Part
   * A). Read through `deliveryThreadPolicy`; absent reads as `new` for a
   * delivery with a channel origin, else `own`. */
  thread?: unknown;
  workflowId?: string;
  presence?: Presence;
  /** When true, an orchestrator channel delivery follows the thread: later
   * messages route to the assistant without a re-mention. */
  follow?: boolean;
  pauseOnOverlap?: boolean;
  overlapPausedAt?: number;
  /** Standing instruction rendered above the event. Absent → no instruction. */
  systemPrompt?: string;
  /** The event message, in place of the default body. Absent → the default. */
  userPromptTemplate?: string;
}

export class EventDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private wakeRequested = false;
  private stopped = false;
  private drainIngress?: () => Promise<void>;
  private ingressInFlight: Promise<void> | null = null;
  private ingressWakeRequested = false;

  setIngressDrain(drain: () => Promise<void>): void { this.drainIngress = drain; }

  constructor(private readonly deps: EventDispatcherDeps) {}

  private recordDestination(reason: DeliveryDestinationMetricReason): void {
    (this.deps.recordDestination ?? recordDeliveryDestination)(reason);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(this.nudge, POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.draining) await new Promise((r) => setTimeout(r, 25));
    await this.ingressInFlight;
  }

  /** In-process nudge from the ingest path. Arrow property so callers can pass it unbound. */
  nudge = (): void => {
    if (this.stopped) return;
    if (this.ingressInFlight) this.ingressWakeRequested = true;
    if (this.draining) { this.wakeRequested = true; return; }
    void this.pollOnce().catch((err) => console.error("event dispatcher poll failed:", err));
  };

  async pollOnce(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      // Slack media and sandbox startup must not stall unrelated deliveries.
      // Keep one ingress drain in flight; durable claims cover process restarts.
      if (this.drainIngress && !this.ingressInFlight) {
        this.ingressInFlight = Promise.resolve().then(() => this.drainIngress?.())
          .catch(err => console.error("event ingress drain failed:", err))
          .finally(() => {
            this.ingressInFlight = null;
            if (this.ingressWakeRequested) { this.ingressWakeRequested = false; this.nudge(); }
          });
      }
      const now = Date.now();
      // Atomic claim (see file doc comment): lease the due rows by moving
      // next_attempt_at forward in the same statement that selects them.
      // The due conditions are repeated on the OUTER update — that's the
      // cross-process fence (a raced loser's EPQ recheck fails once the
      // winner bumps next_attempt_at); the subquery only orders and limits.
      const due = this.deps.db
        .select({ id: eventDeliveries.id })
        .from(eventDeliveries)
        .where(and(inArray(eventDeliveries.status, ["pending", "failed"]), lte(eventDeliveries.nextAttemptAt, now)))
        .orderBy(asc(eventDeliveries.nextAttemptAt))
        .limit(BATCH);
      const claimed = await this.deps.db
        .update(eventDeliveries)
        .set({ nextAttemptAt: now + CLAIM_LEASE_MS })
        .where(
          and(
            inArray(eventDeliveries.id, due),
            inArray(eventDeliveries.status, ["pending", "failed"]),
            lte(eventDeliveries.nextAttemptAt, now),
          ),
        )
        .returning({ id: eventDeliveries.id });

      for (const row of claimed) {
        await this.deliverOne(row.id).catch((err) => console.error(`event dispatch ${row.id}:`, err));
      }
    } finally {
      this.draining = false;
      if (this.wakeRequested) { this.wakeRequested = false; this.nudge(); }
    }
  }

  private async deliverOne(deliveryId: string): Promise<void> {
    const { db } = this.deps;
    const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, deliveryId)).limit(1);
    if (!delivery || delivery.status === "delivered" || delivery.status === "dead" || delivery.status === "skipped") return;
    const [event] = await db.select().from(events).where(eq(events.id, delivery.eventId)).limit(1);
    const [sub] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, delivery.subscriptionId))
      .limit(1);
    if (!event || !sub) {
      await db
        .update(eventDeliveries)
        .set({ status: "dead", lastError: "event or subscription vanished" })
        .where(eq(eventDeliveries.id, deliveryId));
      return;
    }

    try {
      // Both jsonb shapes are owned by their writers: `target` by the
      // subscriptions CRUD validator, `refs` by ingest (NormalizedEvent.refs
      // is Record<string, string>). Same narrowing convention as ingest.ts.
      const target = sub.target as SubscriptionTarget;
      const refs = event.refs as Record<string, string>;
      if (event.orgId !== sub.orgId) throw new Error("Event and subscription organizations differ.");
      const covered = sub.enabled && await hasTeamCoverage(db, sub, event, allCatalogEntries(this.deps.plugins ?? []));
      if (!sub.enabled || covered) {
        let paused = false;
        if (covered && target.pauseOnOverlap) {
          const changed = await db.update(eventSubscriptions)
            .set({ enabled: false, target: { ...target, overlapPausedAt: Date.now() }, updatedAt: Math.max(Date.now(), sub.updatedAt + 1) })
            .where(and(eq(eventSubscriptions.id, sub.id), eq(eventSubscriptions.orgId, event.orgId),
              eq(eventSubscriptions.updatedAt, sub.updatedAt), eq(eventSubscriptions.enabled, true)))
            .returning({ id: eventSubscriptions.id });
          paused = changed.length > 0;
        }
        // Recover first: a crash before the skipped write runs this again,
        // and `appendEventMatch` refuses a digest the waiter already holds,
        // so a crash duplicates nothing and loses nothing.
        await this.recoverClaimedDigest(delivery.destination, event);
        await db.update(eventDeliveries).set({ status: "skipped", lastError: covered
          ? `Skipped — matching team subscription.${paused ? " Personal subscription paused until you re-enable it." : ""}`
          : "Skipped — subscription is disabled." }).where(and(eq(eventDeliveries.id, delivery.id), eq(eventDeliveries.eventId, event.id)));
        return;
      }

      if (target.kind === "workflow" && target.workflowId) {
        await this.startWorkflow(target.workflowId, sub.id, delivery.id, event, refs, sub.createdBy, target.presence);
      } else if (target.kind === "orchestrator") {
        const teamMention = isTeamAssistantMention(sub, event.eventKey);
        const audience = mentionAudience(sub);
        // A verified mention carries a human actor. Other shared event work
        // acts as its owner, never as the member who created the rule. The
        // event waiter's mention rule reuses this gate (`mentionSenderActor`).
        const actorUserId = await mentionSenderActor(db, sub, event.eventKey, event.payload);
        if (event.orgId !== sub.orgId || actorUserId === null) {
          // Name the membership this rule's audience actually requires, the
          // same split the drop log makes in `team-slack-gate.ts`.
          const lastError = teamMention && audience === "organization"
            ? "Team mention denied. Check the sender's Slack identity link and organization membership."
            : "Team mention denied. Check the sender's Slack identity link and team membership.";
          await db.update(eventDeliveries).set({ status: "dead", lastError })
            .where(eq(eventDeliveries.id, deliveryId));
          return;
        }
        // A channel event routes a reply back: stamp the origin, and render the
        // message as the agent should read it — the sender's name and the clean
        // text, not the machine summary or raw `<@U…>` markup and ids.
        // A non-channel event keeps the compact JSON excerpt it always had.
        const origin = this.deps.resolveChannelOrigin?.(event.service, event.eventKey, event.payload) ?? null;
        // The Slack channel the event came from. The delivery thread records
        // it, so the channel's privacy gates reads of that thread.
        const slackChannel = slackEventChannel(event);
        const attributes: Record<string, string> = { ...refs, eventId: event.id, service: event.service };
        let body: string;
        let channelBody = "";
        if (origin) {
          // `actor` is untyped jsonb, owned by ingest (NormalizedEvent.actor is
          // `{ externalId, login? }`) — same narrowing convention as `refs`.
          const actor = event.actor as { externalId?: string; login?: string } | null;
          const rawText = channelText(event.payload) ?? "";
          const normalized = (await this.deps.normalizeChannelMessage?.(event.service, {
            userId: actor?.externalId,
            text: rawText,
          })) ?? { text: rawText };
          // The clean text is the body; fall back to the summary only when the
          // message carries no text of its own (e.g. a file-only post).
          body = (normalized.text || event.summary).slice(0, MAX_BODY_EXCERPT_CHARS);
          channelBody = normalized.text;
          const sender = normalized.senderName ?? actor?.login ?? actor?.externalId;
          if (sender) attributes.sender = sender;
        } else {
          body = `${event.summary}\n\n${JSON.stringify(event.payload).slice(0, MAX_BODY_EXCERPT_CHARS)}`;
        }
        // A rule that configures no template never reaches the renderer, so
        // the body above is the one every rule written before this feature
        // delivers. A configured rule renders deterministically over the
        // event's own fields (`events/prompt-template.ts`).
        if (hasPromptConfig(target)) {
          body = renderEventPrompt(
            target,
            buildPromptValues({
              eventKey: event.eventKey,
              summary: event.summary,
              body,
              refs,
              payload: event.payload,
              catalog: allCatalogEntries(this.deps.plugins ?? []),
            }),
            // The rule names a field this event does not carry, so the
            // template rendered to nothing. The default body goes out in its
            // place. Report it: a rule that selects several events, and a
            // field only some of them declare, is silent otherwise.
            () =>
              console.warn(
                `[events] subscription ${sub.id}: userPromptTemplate rendered empty for ${event.eventKey}. Delivered the default body.`,
              ),
          );
        }
        // A pull request comment continues in the thread that opened the
        // pull request, when that thread is in this owner's runtime.
        const parsedComment = origin ? null : pullRequestComment(event.eventKey, event.payload);
        // Valet posts with a person's GitHub token, so its own comment arrives
        // as that person. A comment it recorded as sent is its own: it never
        // wakes an assistant.
        const ownWrite = parsedComment !== null
          && await isOwnPullRequestWrite(db, event.orgId, event.eventKey, parsedComment);
        if (ownWrite) {
          await db.update(eventDeliveries).set({ status: "skipped", lastError: "Valet's own pull-request write", attempts: delivery.attempts + 1 })
            .where(eq(eventDeliveries.id, deliveryId));
          return;
        }
        // The webhook can arrive before Valet records its write. A fresh
        // comment waits for the record before any assistant wakes, then this
        // delivery runs again. It stays pending, so the attempt is not counted.
        const settledAt = (parsedComment?.postedAt ?? 0) + OWN_WRITE_SETTLE_MS;
        if (parsedComment !== null && settledAt > Date.now()) {
          await db.update(eventDeliveries).set({ nextAttemptAt: settledAt }).where(eq(eventDeliveries.id, deliveryId));
          return;
        }
        const owner = { type: sub.ownerType, id: sub.ownerId };
        // Ingest stamps the destination that a claim or a binding decided
        // (spec 2026-10-16: delivery threads, Part C step 6). A retry reads
        // the same stamp.
        const stamp = readDestinationStamp(delivery.destination);
        // A named repair for the window between ingest and dispatch (CLAUDE.md,
        // "Invariants: alert, don't auto-repair", rule 3). A stamped binding or
        // claim thread can be archived or deleted after ingest. The claimed
        // waiter already suppressed its digest, so a dead-letter would lose the
        // event (INV-D6). The delivery lands by the binding or the rule's
        // policy instead, and the counter's `claim_fallback` reason records
        // it. A pin is the person's explicit choice and keeps its dead-letter
        // (`PinUnavailableError`).
        const fallback = stamp?.kind === "target" && stamp.reason !== "policy_existing"
          && !(await isDeliverableTarget({ db }, event.orgId, owner, stamp));
        const destination = stamp && !fallback ? stamp : await this.unstampedDestination(sub, target, delivery.id, event, origin);
        const inbound = origin
          ? inboundSlackMessage(origin.threadKey, origin.messageTs, attributes.sender, channelBody)
          : parsedComment && destination.kind === "target" && destination.reason === "conversation_pull_request"
            ? parsedComment.message : undefined;
        const receiptIds = { subscriptionId: sub.id, deliveryId: delivery.id };
        if (destination.kind === "skip") {
          await recordSkippedDelivery(db, { ...receiptIds, attempts: delivery.attempts, orgId: event.orgId, eventId: event.id, destination },
            (reason) => this.recordDestination(reason));
          return;
        }
        const owned = await this.ownedElsewhere(sub, event, destination);
        if (owned) {
          await this.skipDelivery({ ...receiptIds, attempts: delivery.attempts, orgId: event.orgId, eventId: event.id }, owned);
          return;
        }
        const author = teamMention
          ? await newcomerAuthor(db, event.orgId, actorUserId, resolvePath(event.payload, "user"), attributes.sender)
          : sub.ownerType === "team" && event.service === "slack"
            ? await channelMessageAuthor(db, sub.ownerId, event.payload, attributes.sender)
            : undefined;
        let landed: DeliveredThread;
        try {
          landed = await this.deps.deliverToAssistant({
            orgId: event.orgId,
            ownerType: sub.ownerType,
            ownerId: sub.ownerId,
            actorUserId,
            signal: {
              kind: "signal",
              signalType: event.eventKey,
              body,
              attributes,
              origin: origin ?? undefined,
            },
            ...(target.presence ? { presence: target.presence } : {}),
            dispatchId: eventDeliveryDispatchId(delivery.id),
            destination,
            ...(inbound ? { inbound } : {}),
            ...(author ? { author } : {}),
            ...(slackChannel ? { slackChannel } : {}),
          });
        } catch (err) {
          if (!(err instanceof PinUnavailableError) || destination.kind !== "target") throw err;
          // A pin that cannot receive deliveries dead-letters at once and
          // never falls back to another mode (spec Part B step 4). The
          // counter pages a person; no code repairs the rule.
          await db.update(eventDeliveries).set({ status: "dead", lastError: PIN_UNAVAILABLE_MESSAGE, attempts: delivery.attempts + 1 })
            .where(eq(eventDeliveries.id, deliveryId));
          const recorded = await appendReceiptStageForEvent(db, event.orgId, event.id, destinationReceiptStage(receiptIds,
            { kind: "pin_unavailable", sessionId: destination.sessionId, threadId: destination.threadId }), destinationStageMarker(delivery.id));
          if (recorded !== "exists") this.recordDestination("pin_unavailable");
          return;
        }
        // A retry that recovers an admitted dispatch records nothing new when
        // the receipt already holds the stage. With no receipt, a recovered
        // retry is not counted. Accepted undercount: an attempt that was
        // admitted, then crashed before recording, on an event with no
        // receipt, is counted once at most and may be missed.
        const recorded = await appendReceiptStageForEvent(db, event.orgId, event.id,
          destinationReceiptStage(receiptIds, fallback ? { ...destination, reason: "claim_fallback" } : destination),
          destinationStageMarker(delivery.id));
        if (recorded === "appended" || (recorded === "no_receipt" && !landed.recovered)) {
          this.recordDestination(fallback ? "claim_fallback" : destinationMetricReason(destination));
        }
        // Bind the thread only AFTER the delivery lands, so a mention whose
        // delivery fails does not leave a followed thread with no listener. The
        // threadKey is `{channelType}:{channelId}:{threadTs}`.
        // Message subscriptions already deliver later replies. A second follow
        // binding would submit each reply twice and outlive the subscription.
        // The follow binds the Slack thread to the thread the delivery landed
        // in (spec 2026-10-16: delivery threads, Part B step 5). A claim
        // redirect binds too: the binding then carries the replies, and the
        // waiter in that thread appends no digest for them (Part C step 4).
        if (target.follow && origin && event.eventKey === "slack.app_mention") {
          const parts = origin.threadKey.split(":");
          if (parts.length === 3 && parts[1] !== "" && parts[2] !== "") {
            const key = {
              orgId: event.orgId,
              channelType: origin.channelType,
              channelId: parts[1],
              threadTs: parts[2],
            };
            // A team re-mention keeps the conversation's first binding, so a
            // second member's mention does not take the thread over. One
            // exception: a binding that authorizes NOBODY any more. Its rule
            // was disabled or deleted, or its actor lost the membership that
            // rule admitted them under, and the router drops every message in
            // the thread. This mention passed the gate, so it re-binds the
            // thread to its own actor and rule and the conversation resumes.
            let preserveBinding = teamMention;
            if (preserveBinding) {
              const bound = await findFollowedThread(db, key);
              if (bound && !(await followBindingAuthorized(db, bound))) preserveBinding = false;
            }
            await upsertFollowedThread(this.deps.db, {
              ...key,
              ownerType: sub.ownerType,
              ownerId: sub.ownerId,
              createdBy: actorUserId,
              // Followed replies need the source rule for current presence
              // settings and, for teams, audience authorization.
              subscriptionId: sub.id,
              preserveBinding,
              // The mention itself is the last message the assistant has seen,
              // so the follow-router's gap re-hydration starts right after it.
              lastSeenTs: origin.messageTs,
              target: landed,
            });
          }
        }
        // Only a claim redirect is a waiter's match. A binding delivery never
        // ends the waiters it suppressed.
        if (destination.kind === "target" && destination.reason === "claim_redirect" && destination.matchedWaiterId !== undefined) {
          await this.endMatchedWaiter(destination.matchedWaiterId, landed);
        }
      } else if (target.kind === "signal") {
        await this.signalParkedRuns(event, refs);
      } else {
        throw new Error(`unknown target kind: ${target.kind}`);
      }
      await db
        .update(eventDeliveries)
        .set({ status: "delivered", deliveredAt: Date.now(), attempts: delivery.attempts + 1 })
        .where(eq(eventDeliveries.id, deliveryId));
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const backoff = BACKOFF_MS[attempts - 1];
      await db
        .update(eventDeliveries)
        .set({
          status: backoff === undefined ? "dead" : "failed",
          attempts,
          nextAttemptAt: backoff === undefined ? delivery.nextAttemptAt : Date.now() + backoff,
          lastError: String(err).slice(0, MAX_ERROR_CHARS),
        })
        .where(eq(eventDeliveries.id, deliveryId));
    }
  }

  /** The event's natural subject from the plugin that owns its service, or null (spec Part D). */
  private naturalSubject(event: typeof events.$inferSelect): { subject: string; label: string } | null {
    const plugin = (this.deps.plugins ?? []).find((p) => (p.triggers ?? []).some((t) => t.service === event.service));
    return plugin?.naturalSubject?.(normalizedEventFromRow(event)) ?? null;
  }

  /**
   * The destination of a delivery that ingest did not stamp: a row from
   * before stamps, a resolver failure, or a delivery that no claim and no
   * waiter-owner binding decided. It resolves from the binding and the
   * policy only, never from waiters (spec Part C step 7), so a failure
   * duplicates a delivery but never loses one (INV-D6).
   */
  private async unstampedDestination(
    sub: typeof eventSubscriptions.$inferSelect,
    target: SubscriptionTarget,
    deliveryId: string,
    event: typeof events.$inferSelect,
    origin: ChannelOrigin | null,
  ): Promise<Destination> {
    const bindingEvent = { key: event.eventKey, payload: event.payload };
    const found = await conversationBinding(this.deps.db, event.orgId, { type: sub.ownerType, id: sub.ownerId }, bindingEvent, origin);
    // A follow bound before follows stored their thread keeps the Slack
    // thread key it has always used.
    if (found?.via === "legacy_follow") {
      return { kind: "key", key: found.key, title: summaryTitle(event.summary), reason: "conversation_follow" };
    }
    return resolveDestination({
      rule: { id: sub.id, kind: "subscription", name: sub.name, policy: deliveryThreadPolicy(target, { channelOrigin: origin !== null }) },
      event: {
        deliveryId,
        summary: event.summary,
        naturalSubject: this.naturalSubject(event),
        conversational: isConversationalEvent(bindingEvent, origin, found),
      },
      binding: found,
      claim: null,
    });
  }

  /**
   * Why another path owns a `slack.message` delivery that follows a follow
   * binding, or null (spec Part C steps 4 and 8). One post gives one turn:
   * - The follow router delivers the reply to the bound thread, so the
   *   rule skips it (`follow_routed`).
   * - The post addresses the bot, and an assistant rule of the owner
   *   delivers its `app_mention` half (sender gate and team coverage
   *   included), so the rule skips the message half (`mention_covered`).
   *   The mention's stamp names the suppressed waiters for recovery.
   */
  private async ownedElsewhere(
    sub: typeof eventSubscriptions.$inferSelect,
    event: typeof events.$inferSelect,
    destination: Destination,
  ): Promise<OwnedElsewhere | null> {
    if (event.eventKey !== "slack.message" || destination.kind === "skip" || destination.reason !== "conversation_follow") return null;
    const { db } = this.deps;
    const botUserId = await this.deps.slackBotUserId?.(event.orgId);
    const route = await followRouteFor(db, { orgId: event.orgId, ...(botUserId ? { botUserId } : {}), payload: event.payload });
    const sameThread = destination.kind === "key" || (route?.sessionId === destination.sessionId && route?.threadId === destination.threadId);
    if (route && route.ownerType === sub.ownerType && route.ownerId === sub.ownerId && sameThread) {
      return { text: "the followed thread delivers this reply", reason: "follow_routed" };
    }
    const plugins = this.deps.plugins ?? [];
    const twin = await conversationalTwinOf(plugins, { slackBotUserId: async () => botUserId }, event.orgId, event.service, normalizedEventFromRow(event));
    if (twin?.key !== "slack.app_mention") return null;
    const subs = await db.select().from(eventSubscriptions).where(and(eq(eventSubscriptions.orgId, event.orgId),
      eq(eventSubscriptions.ownerType, sub.ownerType), eq(eventSubscriptions.ownerId, sub.ownerId), eq(eventSubscriptions.enabled, true)));
    const catalog = allCatalogEntries(plugins);
    const covered = await mentionCoveredBy(db, subs, { type: sub.ownerType, id: sub.ownerId }, twin, catalog,
      (rule, mention) => hasTeamCoverage(db, rule, { eventKey: mention.key, payload: mention.payload, subjects: mention.subjects ?? null }, catalog));
    return covered ? { text: "the mention delivers this post", reason: "mention_covered" } : null;
  }

  /** Settles a delivery that another path owns: skipped, with its receipt stage and counter. */
  private async skipDelivery(
    args: { deliveryId: string; subscriptionId: string; attempts: number; orgId: string; eventId: string },
    owned: OwnedElsewhere,
  ): Promise<void> {
    const { db } = this.deps;
    await db.update(eventDeliveries).set({ status: "skipped", lastError: `Skipped, ${owned.text}.`, attempts: args.attempts + 1 })
      .where(eq(eventDeliveries.id, args.deliveryId));
    const recorded = await appendReceiptStageForEvent(db, args.orgId, args.eventId,
      destinationReceiptStage({ subscriptionId: args.subscriptionId, deliveryId: args.deliveryId }, { kind: "skip", reason: owned.text, outcome: owned.reason }),
      destinationStageMarker(args.deliveryId));
    if (recorded !== "exists") this.recordDestination(owned.reason);
  }

  /**
   * A named repair for the window between ingest and dispatch (CLAUDE.md,
   * "Invariants: alert, don't auto-repair", rule 3). Ingest suppressed the
   * digest of the waiters that the stamp names (a claim redirect's target,
   * or the waiters in a binding's thread), and a team rule or a
   * disabled rule now skips the delivery. That race is expected in normal
   * operation: a rule can change at any moment. Without the repair the
   * waiter would never see the event. The counter's `claim_recovered`
   * reason records each repair.
   */
  private async recoverClaimedDigest(stamp: unknown, event: typeof events.$inferSelect): Promise<void> {
    const destination = readDestinationStamp(stamp);
    const recover = this.deps.recoverClaimedDigest;
    if (!recover || !destination) return;
    for (const waiterId of suppressedWaiters(destination)) {
      try {
        const appended = await recover({ waiterId, orgId: event.orgId, service: event.service, event: normalizedEventFromRow(event) });
        if (appended) this.recordDestination("claim_recovered");
      } catch (err) {
        console.error(`event dispatch: recovering waiter ${waiterId}'s digest failed; the waiter misses this event:`, err);
      }
    }
  }

  /**
   * Ends the once-mode waiter that a claim redirect delivered to (spec Part
   * C step 5). The delivery has landed, so a failure here does not fail it:
   * the waiter stays running, and the log line is the record.
   */
  private async endMatchedWaiter(waiterId: string, landed: DeliveredThread): Promise<void> {
    const end = this.deps.endMatchedWaiter;
    if (!end) return;
    try {
      await end({ waiterId, sessionId: landed.sessionId, threadId: landed.threadId });
    } catch (err) {
      console.error(`event dispatch: ending waiter ${waiterId} after its redirect delivery failed; it stays running:`, err);
    }
  }

  private async startWorkflow(
    workflowId: string,
    subscriptionId: string,
    deliveryId: string,
    event: typeof events.$inferSelect,
    refs: Record<string, string>,
    /** Creator attribution applies only to personal workflows. */
    createdBy: string,
    presence?: Presence,
  ): Promise<void> {
    // Mirrors routes/workflows.ts POST /:id/runs: same run-id scheme, same
    // definitionVersionId, owner resolved from the definition row. The org
    // check is defensive — subscription validation (Task 7) enforces
    // ownership at write time; a cross-org drift dead-letters here.
    const rows = await this.deps.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, workflowId), eq(workflowDefinitions.orgId, event.orgId)))
      .limit(1);
    const def = rows[0];
    if (!def) throw new Error(`workflow ${workflowId} not found in org ${event.orgId}`);

    const trigger: WorkflowTriggerPayload = {
      type: "event",
      triggerId: subscriptionId,
      timestamp: new Date(event.occurredAt).toISOString(),
      data: { key: event.eventKey, summary: event.summary, refs, payload: event.payload },
      metadata: { eventId: event.id, service: event.service },
    };
    const params: RunParams = {
      workflowId,
      definitionVersionId: definitionVersionId(def.definition),
      triggerId: subscriptionId,
      input: trigger,
      ...(presence ? { presence } : {}),
    };
    // Idempotency across delivery retries: the runId is DERIVED from the
    // delivery row (not freshly minted), so a re-claim after a partially
    // failed attempt (run started, but the delivered-status UPDATE lost a
    // race with a DB blip and the claim lease lapsed) resolves to the same
    // run instead of starting a duplicate. If that run already exists, the
    // prior attempt got as far as starting it — nothing left to do.
    const runId = eventDeliveryRunId(deliveryId);
    const existing = await this.deps.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (existing.length > 0) return;
    await this.deps.workflowRunHost.start(runId, params, def.definition, {
      ownerType: def.ownerType,
      ownerId: def.ownerId,
      actorUserId: def.ownerType === "user" ? createdBy : `${def.ownerType}:${def.ownerId}`,
    });
  }

  private async signalParkedRuns(event: typeof events.$inferSelect, refs: Record<string, string>): Promise<void> {
    const signalType = `event:${event.eventKey}`;
    // Parked runs in the event's org waiting on this signal type. Org
    // scoping goes through the run's parent definition; the jsonb
    // containment matches partial objects, so the stored condition's extra
    // fields (nodeId, timeoutAt) don't matter.
    const rows = await this.deps.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
      .where(
        and(
          eq(workflowDefinitions.orgId, event.orgId),
          eq(workflowRuns.status, "parked"),
          sql`${workflowRuns.waitingOn} @> ${JSON.stringify([{ kind: "signal", signalType }])}::jsonb`,
        ),
      );
    for (const row of rows) {
      await this.deps.workflowStore.insertSignal({
        runId: row.id,
        signalId: `event:${event.id}:${row.id}`,
        signalType,
        payload: { key: event.eventKey, summary: event.summary, refs, payload: event.payload },
        createdAt: Date.now(),
      });
      await this.deps.workflowRunHost.wake(row.id);
    }
  }
}
