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
import type { ChannelOrigin, NormalizedEvent, PromptAuthor, SessionStore, SignalContent, ValetPlugin } from "@valet/engine";
import { readThreadPolicy } from "@valet/shared";
import type { RunHost, RunParams, WorkflowStore, WorkflowTriggerPayload } from "@valet/workflow";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "../workflows/definition-version.js";
import { findFollowedThread, upsertFollowedThread } from "./followed-threads.js";
import { hasTeamCoverage } from "./delivery-policy.js";
import { allCatalogEntries } from "./ingest.js";
import { buildPromptValues, hasPromptConfig, renderEventPrompt } from "./prompt-template.js";
import { inboundSlackMessage, isOwnPullRequestWrite, OWN_WRITE_SETTLE_MS, pullRequestComment, threadForPullRequest, type InboundChannelMessage } from "../services/channel-messages.js";
import {
  followBindingAuthorized,
  isTeamAssistantMention,
  mentionAudience,
  mentionSenderActor,
  channelMessageAuthor,
  newcomerAuthor,
} from "./team-slack-gate.js";
import { resolvePath } from "./match.js";
import { loadSessionOwner } from "./waiters.js";
import { findWatchingWaiter, slackEventTeam } from "./watching-waiter.js";
import { isDeliverableTarget, PinUnavailableError, PIN_UNAVAILABLE_MESSAGE, type DeliveredThread, type DeliveryDestination } from "./assistant-delivery.js";
import { resolveDestination, summaryTitle, type Destination } from "./destination.js";
import { appendReceiptStageForEvent, destinationReceiptStage } from "./receipts.js";
import { destinationMetricReason, recordDeliveryDestination } from "../observability/delivery-metrics.js";

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
    /** No person waits on the delivery (see `AssistantDeliveryArgs.unattended`). */
    unattended?: boolean;
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
   * The engine store, for incident mention routing
   * (`watching-waiter.ts`): a `slack.app_mention` in a channel that a stream
   * event waiter of the same owner watches goes to that waiter's thread.
   * Absent → every mention keeps the thread keyed by its own Slack post.
   */
  engineStore?: Pick<SessionStore, "findEventWaiters">;
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

/** A Slack direct message: a conversational event (spec Terminology). */
function isDirectMessage(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "channel_type" in payload && payload.channel_type === "im";
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

/** The `target` jsonb column's shape — written only by the subscriptions CRUD validator. */
interface SubscriptionTarget {
  kind: "workflow" | "orchestrator" | "signal";
  /** The assistant thread policy (spec 2026-10-16: delivery threads, Part
   * A). Read through `readThreadPolicy`; absent reads as `own`. */
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
        // A Slack event from a channel with no thread to reply into stays
        // with that channel's audience, not the shared events thread.
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
        const commentThread = parsedComment && sub.ownerType !== "org"
          ? await threadForPullRequest(db, event.orgId, { type: sub.ownerType, id: sub.ownerId }, parsedComment.pullRequestUrl)
          : null;
        const commentThreadKey = commentThread?.key ?? null;
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
        const prComment = parsedComment;
        const prThreadKey = prComment ? commentThreadKey : null;
        const inbound = origin
          ? inboundSlackMessage(origin.threadKey, origin.messageTs, attributes.sender, channelBody)
          : prThreadKey && prComment ? prComment.message : undefined;
        const owner = { type: sub.ownerType, id: sub.ownerId };
        // Destination precedence (spec 2026-10-16: delivery threads, Part B
        // step 1): a conversation binding, then a claim, then the policy.
        const follow = await this.followBinding(event, origin, owner);
        const binding = follow?.kind === "target"
          ? { sessionId: follow.sessionId, threadId: follow.threadId, via: "follow" as const }
          : prComment && commentThread
            ? { sessionId: commentThread.sessionId, threadId: commentThread.threadId, via: "pull_request" as const }
            : null;
        // A mention in a channel that this owner already watches goes to the
        // watching thread (spec 2026-10-15: incident mention routing, Part A).
        // The sender gate above has already run (Part C). This is today's
        // only claim source.
        const claim = binding || follow ? null : await this.watchingTarget(event, origin, slackChannel, owner);
        const destination: Destination = follow?.kind === "legacy"
          // A follow bound before follows stored their thread keeps the
          // Slack thread key it has always used.
          ? { kind: "key", key: follow.key, title: summaryTitle(event.summary), reason: "conversation_follow" }
          : resolveDestination({
            rule: { id: sub.id, kind: "subscription", name: sub.name, policy: readThreadPolicy(target.thread) },
            event: {
              deliveryId: delivery.id,
              summary: event.summary,
              naturalSubject: this.naturalSubject(event),
              conversational: binding !== null || event.eventKey === "slack.app_mention" || (origin !== null && isDirectMessage(event.payload)),
            },
            binding,
            claim,
          });
        const receiptIds = { subscriptionId: sub.id, deliveryId: delivery.id };
        if (destination.kind === "skip") {
          // A skip submits nothing and creates no thread (INV-D3).
          await db.update(eventDeliveries).set({ status: "skipped", lastError: `Skipped, ${destination.reason}.`, attempts: delivery.attempts + 1 })
            .where(eq(eventDeliveries.id, deliveryId));
          recordDeliveryDestination("claim_skip");
          await appendReceiptStageForEvent(db, event.orgId, event.id, destinationReceiptStage(receiptIds, destination));
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
            // A mention, or a PR comment on a thread Valet opened, is a person
            // talking to Valet in a place they can answer. Any other event,
            // including a comment that falls back to the shared events thread,
            // has no one to answer.
            ...(!origin && !(prComment && commentThread) ? { unattended: true } : {}),
          });
        } catch (err) {
          if (!(err instanceof PinUnavailableError) || destination.kind !== "target") throw err;
          // A pin that cannot receive deliveries dead-letters at once and
          // never falls back to another mode (spec Part B step 4). The
          // counter pages a person; no code repairs the rule.
          await db.update(eventDeliveries).set({ status: "dead", lastError: PIN_UNAVAILABLE_MESSAGE, attempts: delivery.attempts + 1 })
            .where(eq(eventDeliveries.id, deliveryId));
          recordDeliveryDestination("pin_unavailable");
          await appendReceiptStageForEvent(db, event.orgId, event.id, destinationReceiptStage(receiptIds,
            { kind: "pin_unavailable", sessionId: destination.sessionId, threadId: destination.threadId }));
          return;
        }
        recordDeliveryDestination(destinationMetricReason(destination));
        await appendReceiptStageForEvent(db, event.orgId, event.id, destinationReceiptStage(receiptIds, destination));
        // Bind the thread only AFTER the delivery lands, so a mention whose
        // delivery fails does not leave a followed thread with no listener. The
        // threadKey is `{channelType}:{channelId}:{threadTs}`.
        // Message subscriptions already deliver later replies. A second follow
        // binding would submit each reply twice and outlive the subscription.
        // A mention routed to a watching thread binds no follow: its event
        // waiter already receives the later replies (Part B, INV-M2).
        // The follow binds the Slack thread to the thread the delivery landed
        // in (spec 2026-10-16: delivery threads, Part B step 5).
        if (target.follow && origin && event.eventKey === "slack.app_mention" && destination.reason !== "claim_redirect") {
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

  /**
   * The follow binding of this owner for a channel event's Slack thread
   * (spec 2026-10-16: delivery threads, Part B step 1). `target` names the
   * thread the binding mention landed in. `legacy` is a follow bound before
   * follows stored their thread: it keeps the Slack thread key. A bound
   * thread that can no longer receive deliveries is no binding: the policy
   * decides, and a follow mention re-binds the Slack thread where it lands.
   */
  private async followBinding(
    event: typeof events.$inferSelect,
    origin: ChannelOrigin | null,
    owner: { type: "user" | "team" | "org"; id: string },
  ): Promise<{ kind: "target"; sessionId: string; threadId: string } | { kind: "legacy"; key: string } | null> {
    if (!origin) return null;
    const [, channelId, threadTs] = origin.threadKey.split(":");
    if (!channelId || !threadTs) return null;
    const db = this.deps.db;
    const bound = await findFollowedThread(db, { orgId: event.orgId, channelType: origin.channelType, channelId, threadTs });
    if (!bound || bound.ownerType !== owner.type || bound.ownerId !== owner.id) return null;
    if (bound.sessionId === null || bound.threadId === null) return { kind: "legacy", key: origin.threadKey };
    const target = { sessionId: bound.sessionId, threadId: bound.threadId };
    return await isDeliverableTarget({ db }, event.orgId, owner, target) ? { kind: "target", ...target } : null;
  }

  /** The event's natural subject from the plugin that owns its service, or null (spec Part D). */
  private naturalSubject(event: typeof events.$inferSelect): { subject: string; label: string } | null {
    const plugin = (this.deps.plugins ?? []).find((p) => (p.triggers ?? []).some((t) => t.service === event.service));
    return plugin?.naturalSubject?.(normalizedEventFromRow(event)) ?? null;
  }

  /** The watching waiter's thread for a Slack mention, or null (Part A).
   * The caller looks for a follow binding first, which outranks a claim. */
  private async watchingTarget(
    event: typeof events.$inferSelect,
    origin: ChannelOrigin | null,
    channel: string | undefined,
    owner: { type: "user" | "team" | "org"; id: string },
  ): Promise<{ sessionId: string; threadId: string; waiterId: string } | null> {
    const engineStore = this.deps.engineStore;
    if (!engineStore || !origin || !channel || event.eventKey !== "slack.app_mention") return null;
    const team = slackEventTeam(event.subjects, event.payload, channel);
    if (!team) return null;
    const db = this.deps.db;
    return findWatchingWaiter(
      {
        engineStore,
        sessionOwner: (sessionId) => loadSessionOwner(db, sessionId),
        isDeliverableTarget: (target) => isDeliverableTarget({ db }, event.orgId, owner, target),
      },
      event.orgId, owner, team, channel,
    );
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
