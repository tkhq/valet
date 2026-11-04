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
import type { Appearance } from "@valet/shared";
import { slackEventChannel } from "../services/thread-access.js";
import type { EventHead } from "../services/event-columns.js";
import type { ChannelOrigin, NormalizedEvent, PluginEvent, PluginEventHandler, PluginThreads, Principal, PromptAuthor, SignalContent, ValetPlugin } from "@valet/engine";
import { readThreadPolicy, type AssistantThreadPolicy } from "@valet/shared";
import type { RunHost, RunParams, WorkflowStore, WorkflowTriggerPayload } from "@valet/workflow";
import { and, arrayContains, asc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "../workflows/definition-version.js";
import { findFollowedThread, repointFollowedThread, upsertFollowedThread } from "./followed-threads.js";
import { conversationBinding, isConversationalEvent } from "./conversation-binding.js";
import { hasTeamCoverage } from "./delivery-policy.js";
import { allCatalogEntries, conversationalTwinOf } from "./ingest.js";
import { mentionCoveredBy } from "./claims.js";
import { followRouteFor, followRouterPassed } from "../channels/follow-router.js";
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
import { readStoredTarget } from "./target-names.js";
import type { PluginThreadsScope } from "../plugins/plugin-threads.js";
import { pluginStore } from "../services/plugin-store.js";
import { buildPluginMemory } from "../plugins/plugin-memory.js";
import { pluginHandlerConfig } from "./subscription-write.js";
import { orgAllowsPluginForOwner } from "../services/plugin-entitlements.js";
import { actorUserIdFor } from "../workflows/engine-deps.js";
import { FAILED_TURN_SWEEP_WINDOW_MS, markFailedDeliveryTurns } from "./delivery-turn.js";
import { reportError } from "@valet/engine";

/** Retry backoff per failed attempt; a failure past the last entry is dead. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const POLL_MS = 1_000;
/** How often a poll also sweeps delivered rows for failed turns (`delivery-turn.ts`). */
const FAILED_TURN_SWEEP_MS = 60_000;
const BATCH = 20;
/** How long a claimed-but-unresolved row stays invisible to other polls. */
const CLAIM_LEASE_MS = 60_000;
/** Plugin handlers running at once in one process. */
const DEFAULT_PLUGIN_CONCURRENCY = 8;
/** When all plugin slots are busy, retry the delivery after this long. */
const PLUGIN_BUSY_RETRY_MS = 10_000;
/** Abort reason when a plugin line is turned off or deleted mid-run. */
const PLUGIN_LINE_OFF = "plugin-line-off";
/** Abort reason when another run re-claimed the delivery after this run's lease lapsed. */
const PLUGIN_LEASE_LOST = "plugin-lease-lost";
/** Abort reason when a newer event for the same subject superseded this run (`concurrency: "supersede"`). */
const PLUGIN_SUPERSEDED = "plugin-superseded";

/** The skip reason a superseded plugin delivery records. */
function supersededText(label: string): string {
  return `A newer event for ${label} superseded this one.`;
}

/** The services a plugin may ask app tokens for: its own and those it declares credentials for. */
function pluginServices(plugin: ValetPlugin): Set<string> {
  return new Set([plugin.name, ...(plugin.credentials ?? []).map((c) => c.service ?? plugin.name)]);
}

/** What the dispatcher needs to run plugin event handlers. */
export interface PluginHandlerHost {
  /** `PluginThreads` for one handler run (`buildPluginThreads` in production). */
  threads(scope: PluginThreadsScope): PluginThreads;
  /** The org's app credential for `service`, or null when it is not connected. */
  appToken(orgId: string, service: string, scope?: { owner?: string }): Promise<string | null>;
  /**
   * Stop the children recorded against these deliveries
   * (`stopPluginDeliveryChildren` in production). Called when deliveries
   * are cancelled for good: the line was turned off, or a newer event
   * superseded them, whether or not their run is live in this process.
   */
  stopDeliveryChildren(deliveryIds: string[]): Promise<void>;
  maxConcurrent?: number;
  /** How often a running handler renews its lease and checks its line. Tests shorten it. */
  leaseRenewMs?: number;
}
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
    appearance?: Appearance;
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
    /** The Slack channel the content came from, which the thread records for its read gate. */
    slackChannel?: string;
  }): Promise<DeliveredThread>;
}

export interface EventDispatcherDeps {
  /** Clear expired intent text without blocking event delivery. */
  retainExternalUsage?: () => Promise<void>;
  /** Drain the durable personal attention outbox on the existing event rail. */
  drainAttention?: () => Promise<void>;
  /** Bounded classification on the existing durable retry rail. */
  drainTagging?: () => Promise<void>;
  db: AppDb;
  workflowRunHost: RunHost;
  workflowStore: WorkflowStore;
  /**
   * Runs plugin event handlers (`target.kind: "plugin"`). Absent: a plugin
   * delivery fails with a configuration error and retries.
   */
  pluginHandlers?: PluginHandlerHost;
  /** Seam over the assistant runtime and the destination thread's `submitPrompt`. See `assistant-target.ts`. */
  deliverToAssistant: AssistantDeliverFn;
  /** Marks delivered rows whose turn failed (`delivery-turn.ts`). Absent → `markFailedDeliveryTurns`. */
  markFailedTurns?: typeof markFailedDeliveryTurns;
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
   * `conversationalTwin` hook. Production resolves it like the follow
   * router (`slackBotUserIdOf`). Absent: no message text counts as
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
 * threads, Part A step 3). A stored policy always wins. An absent policy
 * reads as:
 *
 * - `new` for a delivery with a channel origin, so each Slack conversation
 *   keeps its own assistant thread.
 * - `subject` for a Slack event with a channel but no reply origin (a
 *   reaction, a channel lifecycle event), so each channel keeps its own
 *   thread and a private channel's gate covers only that channel's thread.
 *   With no natural subject to group by, such an event reads as `new`: it
 *   must never share a thread with another channel's content.
 * - `own` otherwise.
 *
 * `own` for channel content stays an explicit owner choice.
 * `readThreadPolicy` stays shape-only.
 */
export function deliveryThreadPolicy(
  target: { thread?: unknown },
  delivery: { channelOrigin: boolean; slackChannel?: boolean; naturalSubject?: boolean },
): AssistantThreadPolicy {
  if (target.thread !== undefined && target.thread !== null) return readThreadPolicy(target.thread);
  if (delivery.channelOrigin) return { mode: "new" };
  if (delivery.slackChannel) return delivery.naturalSubject ? { mode: "subject" } : { mode: "new" };
  return { mode: "own" };
}

/** A stored event's natural subject from the plugin that owns its service, or null (spec Part D). */
export function eventNaturalSubject(plugins: readonly ValetPlugin[], event: EventHead & { payload?: unknown }): { subject: string; label: string } | null {
  const plugin = plugins.find((p) => (p.triggers ?? []).some((t) => t.service === event.service));
  return plugin?.naturalSubject?.(normalizedEventFromRow(event)) ?? null;
}

/** The stored event row as the plugin contract's `NormalizedEvent`, for
 * `naturalSubject`. A read that leaves the payload behind passes a null one:
 * the place plugins (GitHub, Linear, Slack) read only `subjects` and `refs`. */
function normalizedEventFromRow(event: EventHead & { payload?: unknown }): NormalizedEvent {
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
    payload: event.payload ?? null,
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

/** The `target` jsonb column's shape, read through `readStoredTarget` so old
 * names arrive renamed. Written only by the subscriptions CRUD validator. */
interface SubscriptionTarget {
  kind: "workflow" | "assistant" | "signal" | "plugin";
  /** Plugin targets: the plugin and its handler id. */
  plugin?: string;
  handler?: string;
  /** Plugin targets: the handler's settings, checked against its `configSchema`. */
  config?: unknown;
  /** The assistant thread policy (spec 2026-10-16: delivery threads, Part
   * A). Read through `deliveryThreadPolicy`; absent reads as `new` for a
   * delivery with a channel origin, `subject` for other Slack channel
   * events, else `own`. */
  thread?: unknown;
  workflowId?: string;
  appearance?: Appearance;
  /** When true, an assistant channel delivery follows the thread: later
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
  private lastFailedTurnSweepAt = 0;
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
    // Their rows keep the lease; a later process re-runs them.
    for (const run of this.pluginRuns.values()) run.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.draining) await new Promise((r) => setTimeout(r, 25));
    await this.ingressInFlight;
    // Attention sends hold durable leases. Shutdown leaves unfinished sends
    // for recovery instead of waiting for an external provider.
  }

  /** In-process nudge from the ingest path. Arrow property so callers can pass it unbound. */
  nudge = (): void => {
    if (this.stopped) return;
    if (this.ingressInFlight) this.ingressWakeRequested = true;
    if (this.draining) { this.wakeRequested = true; return; }
    void this.pollOnce().catch((err) => reportError({ area: "events", reason: "dispatch_poll" }, "event dispatcher poll failed", err));
  };

  async pollOnce(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      // Slack media and sandbox startup must not stall unrelated deliveries.
      // Keep one ingress drain in flight; durable claims cover process restarts.
      if (this.drainIngress && !this.ingressInFlight) {
        this.ingressInFlight = Promise.resolve().then(() => this.drainIngress?.())
          .catch(err => reportError({ area: "events", reason: "ingress_drain" }, "event ingress drain failed", err))
          .finally(() => {
            this.ingressInFlight = null;
            if (this.ingressWakeRequested) { this.ingressWakeRequested = false; this.nudge(); }
          });
      }
      // A slow provider must not delay unrelated event deliveries.
      if (this.deps.drainAttention) {
        // The outbox serializes each transport independently across ticks.
        void this.deps.drainAttention()
          .catch(err => reportError({ area: "events", reason: "attention_drain" }, "attention outbox drain failed", err));
      }
      void this.deps.retainExternalUsage?.().catch(() => reportError({ area: "events", reason: "intent_retention", level: "warn" }, "Intent retention failed. Check database availability."));
      if (this.deps.drainTagging) {
        void this.deps.drainTagging().catch(() => reportError({ area: "events", reason: "tagging_batch", level: "warn" }, "Tagging batch failed. Check the model provider and queued tagging attempts."));
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
        await this.deliverOne(row.id).catch((err) => reportError({ area: "events", reason: "dispatch_delivery" }, `event dispatch ${row.id}`, err));
      }
      if (now - this.lastFailedTurnSweepAt >= FAILED_TURN_SWEEP_MS) {
        this.lastFailedTurnSweepAt = now;
        await this.sweepFailedDeliveryTurns(now).catch((err) => reportError({ area: "events", reason: "failed_turn_sweep" }, "event failed-turn sweep", err));
      }
    } finally {
      this.draining = false;
      if (this.wakeRequested) { this.wakeRequested = false; this.nudge(); }
    }
  }

  /** Marks delivered rows whose turn failed and that the settle watcher missed. */
  async sweepFailedDeliveryTurns(now = Date.now()): Promise<number> {
    return (this.deps.markFailedTurns ?? markFailedDeliveryTurns)(this.deps.db, { deliveredSince: now - FAILED_TURN_SWEEP_WINDOW_MS });
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
      // A deleted rule delivers nothing: give the suppressed waiters the event back.
      if (event) await this.recoverClaimedDigest(delivery.destination, event);
      await db
        .update(eventDeliveries)
        .set({ status: "dead", lastError: "The event or its line was deleted. Nothing is left to send." })
        .where(eq(eventDeliveries.id, deliveryId));
      return;
    }

    // Set only by an assistant delivery: the queue item its prompt became.
    let queueItemId: string | undefined;
    try {
      // Both jsonb shapes are owned by their writers: `target` by the
      // subscriptions CRUD validator, `refs` by ingest (NormalizedEvent.refs
      // is Record<string, string>). Same narrowing convention as ingest.ts.
      const target = readStoredTarget(sub.target) as SubscriptionTarget;
      const refs = event.refs as Record<string, string>;
      if (event.orgId !== sub.orgId) throw new Error("The event and the line of presence belong to different organizations.");
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
        // and `appendEventMatch` refuses a digest the waiter already holds for
        // this event, so a crash loses nothing. Across the two halves of a
        // Slack mention, the waiter can still get two digests with different
        // dedupe keys. That duplication is accepted (spec Deviations).
        await this.recoverClaimedDigest(delivery.destination, event);
        await db.update(eventDeliveries).set({ status: "skipped", lastError: covered
          ? `The team already listens for this.${paused ? " This personal line is paused." : ""}`
          : "This line is off. Turn it on to receive these events." }).where(and(eq(eventDeliveries.id, delivery.id), eq(eventDeliveries.eventId, event.id)));
        // A plugin delivery waiting to retry may have children from an
        // earlier attempt; the line is off, so they stop too.
        if (target.kind === "plugin") await this.deps.pluginHandlers?.stopDeliveryChildren([delivery.id]);
        return;
      }

      if (target.kind === "workflow" && target.workflowId) {
        await this.startWorkflow(target.workflowId, sub.id, delivery.id, event, refs, sub.createdBy, target.appearance);
      } else if (target.kind === "assistant") {
        const teamMention = isTeamAssistantMention(sub, event.eventKey);
        const audience = mentionAudience(sub);
        // A verified mention carries a human actor. Other shared event work
        // acts as its owner, never as the member who created the rule. Claim
        // resolution reuses this gate (`mentionSenderActor`).
        const actorUserId = await mentionSenderActor(db, sub, event.eventKey, event.payload);
        if (event.orgId !== sub.orgId || actorUserId === null) {
          // Name the membership this rule's audience actually requires, the
          // same split the drop log makes in `team-slack-gate.ts`.
          // The delivery dies, so the waiters it suppressed get the event back.
          await this.recoverClaimedDigest(delivery.destination, event);
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
        // Ingest preserves the normalizer's bot flag. Payload fields cover older event rows.
        if (event.service === "slack") {
          const actorBot = event.actor !== null && typeof event.actor === "object" && "bot" in event.actor && event.actor.bot === true;
          attributes.senderBot = String(actorBot || event.eventKey === "slack.bot_message" ||
            !!resolvePath(event.payload, "bot_id") || !!resolvePath(event.payload, "bot_profile.id") ||
            resolvePath(event.payload, "subtype") === "bot_message");
        }
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
            ...(target.appearance ? { appearance: target.appearance } : {}),
            dispatchId: eventDeliveryDispatchId(delivery.id),
            destination,
            ...(inbound ? { inbound } : {}),
            ...(author ? { author } : {}),
            // A mention, or a PR comment on a thread Valet opened, is a person
            // talking to Valet in a place they can answer. Any other event,
            // including a comment that falls back to the shared events thread,
            // has no one to answer.
            ...(!origin && !(parsedComment && destination.kind === "target" && destination.reason === "conversation_pull_request") ? { unattended: true } : {}),
            ...(slackChannel ? { slackChannel } : {}),
          });
        } catch (err) {
          if (!(err instanceof PinUnavailableError) || destination.kind !== "target") throw err;
          // A pin that cannot receive deliveries dead-letters at once and
          // never falls back to another mode (spec Part B step 4). The
          // counter pages a person; no code repairs the rule.
          await db.update(eventDeliveries).set({ status: "dead", lastError: err.message, attempts: delivery.attempts + 1 })
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
        queueItemId = landed.queueItemId;
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
            // A kept binding whose thread was archived or deleted moves to
            // the thread this mention landed in (`followBinding` already
            // skipped it). Else every later reply would dead-letter.
            let preserveBinding = teamMention;
            if (preserveBinding) {
              const bound = await findFollowedThread(db, key);
              if (bound && !(await followBindingAuthorized(db, bound))) preserveBinding = false;
              else if (bound && bound.ownerType === owner.type && bound.ownerId === owner.id
                && bound.sessionId !== null && bound.threadId !== null) {
                const stale = { sessionId: bound.sessionId, threadId: bound.threadId };
                if (!(await isDeliverableTarget({ db }, event.orgId, owner, stale))) {
                  await repointFollowedThread(db, bound.id, stale, { sessionId: landed.sessionId, threadId: landed.threadId });
                }
              }
            }
            await upsertFollowedThread(this.deps.db, {
              ...key,
              ownerType: sub.ownerType,
              ownerId: sub.ownerId,
              createdBy: actorUserId,
              // Followed replies need the source rule for current appearance
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
      } else if (target.kind === "plugin") {
        // A handler can wait minutes on child sessions, so it runs beside
        // the loop and records its own outcome (`runPluginDelivery`).
        this.startPluginDelivery(delivery, event, sub, target);
        return;
      } else {
        throw new Error(`unknown target kind: ${target.kind}`);
      }
      await db
        .update(eventDeliveries)
        .set({ status: "delivered", deliveredAt: Date.now(), attempts: delivery.attempts + 1, ...(queueItemId ? { queueItemId } : {}) })
        .where(eq(eventDeliveries.id, deliveryId));
      // The turn can fail before this write lands; the settle watcher then
      // found the row still pending. Check once more now that it is delivered.
      // The delivery already succeeded, so a failed check only logs: the sweep
      // marks the row later.
      if (queueItemId) {
        await (this.deps.markFailedTurns ?? markFailedDeliveryTurns)(db, { deliveryId })
          .catch((err) => reportError({ area: "events", reason: "failed_turn_check" }, `event dispatch ${deliveryId}: failed-turn check`, err));
      }
    } catch (err) {
      await this.recordDeliveryFailure(delivery, event, err);
    }
  }

  private async recordDeliveryFailure(
    delivery: typeof eventDeliveries.$inferSelect,
    event: typeof events.$inferSelect,
    err: unknown,
    attempts = delivery.attempts + 1,
    /** Narrows the write, e.g. to a plugin run's fenced lease. Default: the row. */
    where: SQL | undefined = eq(eventDeliveries.id, delivery.id),
  ): Promise<void> {
    const backoff = BACKOFF_MS[attempts - 1];
    // The last attempt failed, so the waiters this delivery suppressed get
    // the event back before the row goes dead.
    if (backoff === undefined) await this.recoverClaimedDigest(delivery.destination, event);
    await this.deps.db
      .update(eventDeliveries)
      .set({
        status: backoff === undefined ? "dead" : "failed",
        attempts,
        nextAttemptAt: backoff === undefined ? delivery.nextAttemptAt : Date.now() + backoff,
        lastError: String(err).slice(0, MAX_ERROR_CHARS),
      })
      .where(where);
  }

  /** Plugin deliveries running in this process, by delivery id. */
  private readonly pluginRuns = new Map<string, AbortController>();

  /**
   * Start a plugin handler in the background. While it runs it renews the
   * claim lease, so no other poll re-claims the row. If this process dies,
   * the lease lapses and a later poll runs the handler again; handlers are
   * idempotent per event (`PluginThreads` dispatch ids).
   */
  private startPluginDelivery(
    delivery: typeof eventDeliveries.$inferSelect,
    event: typeof events.$inferSelect,
    sub: typeof eventSubscriptions.$inferSelect,
    target: SubscriptionTarget,
  ): void {
    const { db } = this.deps;
    if (this.pluginRuns.has(delivery.id)) return;
    const limit = this.deps.pluginHandlers?.maxConcurrent ?? DEFAULT_PLUGIN_CONCURRENCY;
    if (this.pluginRuns.size >= limit) {
      // Full: leave the row for a later poll instead of failing it.
      void db.update(eventDeliveries).set({ nextAttemptAt: Date.now() + PLUGIN_BUSY_RETRY_MS })
        .where(eq(eventDeliveries.id, delivery.id))
        .catch((err) => console.error(`plugin delivery ${delivery.id}: requeue failed:`, err));
      return;
    }
    const abort = new AbortController();
    this.pluginRuns.set(delivery.id, abort);
    // A run cancelled for good stops the children it started. Shutdown and
    // a lost lease do not: the next run finds those children by dispatch id.
    const cancelChildren = new AbortController();
    abort.signal.addEventListener("abort", () => {
      if (abort.signal.reason !== PLUGIN_LINE_OFF && abort.signal.reason !== PLUGIN_SUPERSEDED) return;
      cancelChildren.abort(abort.signal.reason);
      // A superseding run already stopped this delivery's children; stopping
      // twice finds nothing to stop.
      this.deps.pluginHandlers?.stopDeliveryChildren([delivery.id])
        .catch((err) => console.error(`plugin delivery ${delivery.id}: stopping children failed:`, err));
    }, { once: true });
    // The lease value is the fence. This run owns the row only while
    // `next_attempt_at` still holds the value it last wrote, so a run that
    // outlived its lease (and was re-claimed elsewhere) can neither renew
    // nor record an outcome over the new run.
    let lease = delivery.nextAttemptAt;
    const owned = () => and(
      eq(eventDeliveries.id, delivery.id),
      inArray(eventDeliveries.status, ["pending", "failed"]),
      eq(eventDeliveries.nextAttemptAt, lease),
    );
    // Lease writes run one at a time. Two renewals that both read the same
    // `lease` would race: one moves it, and the other misses the fence and
    // reads as a lost lease although this run still owns the row.
    let leaseWrites: Promise<unknown> = Promise.resolve();
    const serialLeaseWrite = <T>(write: () => Promise<T>): Promise<T> => {
      const next = leaseWrites.then(write);
      leaseWrites = next.catch(() => {});
      return next;
    };
    /** Move the lease to a new value, fenced on the current one. False when another run took the row. */
    const takeLease = (set: Partial<typeof eventDeliveries.$inferInsert> = {}): Promise<boolean> => serialLeaseWrite(async () => {
      // Jitter keeps two writes in the same millisecond from minting one value.
      const next = Date.now() + CLAIM_LEASE_MS + Math.floor(Math.random() * 1000);
      const moved = await db.update(eventDeliveries).set({ ...set, nextAttemptAt: next }).where(owned())
        .returning({ id: eventDeliveries.id });
      if (moved.length === 0) return false;
      lease = next;
      return true;
    });
    const finish = () => {
      clearInterval(renew);
      this.pluginRuns.delete(delivery.id);
    };
    /** True while a renewal tick runs. A slow tick makes the next ones skip, not pile up. */
    let renewing = false;
    const renew = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void (async () => {
        const [line] = await db.select({ enabled: eventSubscriptions.enabled }).from(eventSubscriptions)
          .where(eq(eventSubscriptions.id, sub.id)).limit(1);
        if (!line?.enabled) {
          abort.abort(PLUGIN_LINE_OFF);
          return;
        }
        if (!(await takeLease())) abort.abort(await this.lostLeaseReason(delivery.id));
      })()
        .catch((err) => console.error(`plugin delivery ${delivery.id}: lease renewal failed:`, err))
        .finally(() => { renewing = false; });
    }, this.deps.pluginHandlers?.leaseRenewMs ?? CLAIM_LEASE_MS / 3);

    void (async () => {
      // Count the attempt when it starts, so a handler that crashes the
      // process still uses up its retries instead of looping forever.
      const attempts = delivery.attempts + 1;
      if (attempts > BACKOFF_MS.length + 1) {
        await db.update(eventDeliveries).set({ status: "dead", lastError: `The handler did not finish after ${attempts - 1} attempts.` }).where(owned());
        return;
      }
      // Take the claim this poll made. A miss means another process
      // re-claimed the row between the claim and here.
      if (!(await takeLease({ attempts }))) return;
      // `concurrency: "supersede"`: only the newest event per subject runs.
      const superseding = this.supersedeSubject(target, event);
      if (superseding) {
        if (await this.newerSubjectDelivery(sub.id, event, superseding.subject)) {
          await serialLeaseWrite(() => db.update(eventDeliveries)
            .set({ status: "skipped", lastError: supersededText(superseding.label) }).where(owned()));
          return;
        }
        const superseded = await this.supersedeOlder(sub.id, event, superseding);
        for (const id of superseded) {
          // Same process: stop now. Another process finds its row skipped at
          // its next renewal and stops then.
          this.pluginRuns.get(id)?.abort(PLUGIN_SUPERSEDED);
        }
        // Children of a superseded delivery stop even when no run holds it,
        // such as one waiting to retry after a failed attempt.
        if (superseded.length > 0) await this.deps.pluginHandlers?.stopDeliveryChildren(superseded);
      }
      // The outcome is decided after the run, abort reason first: a handler
      // that ignores `ctx.signal` and returns normally after its line was
      // turned off must not read as delivered.
      let failure: { err: unknown } | undefined;
      try {
        await this.runPluginDelivery(delivery.id, event, sub, target, abort.signal, cancelChildren.signal);
      } catch (err) {
        failure = { err };
      }
      // No renewal may move the lease after this point: the outcome write
      // below is fenced on the last value, so it waits for any write in flight.
      clearInterval(renew);
      await leaseWrites;
      if (abort.signal.aborted && (abort.signal.reason === PLUGIN_LEASE_LOST || abort.signal.reason === PLUGIN_SUPERSEDED)) {
        // Another run owns the row now, or the superseding run already
        // marked it skipped; that outcome is the one that counts.
      } else if (abort.signal.aborted && abort.signal.reason === PLUGIN_LINE_OFF) {
        await db.update(eventDeliveries).set({ status: "skipped", lastError: "This line was turned off while its handler ran." }).where(owned());
      } else if (abort.signal.aborted && this.stopped) {
        // Shutdown is not the handler's fault. The lease lapses and a
        // later process runs it again.
      } else if (failure) {
        await this.recordDeliveryFailure(delivery, event, failure.err, attempts, owned());
      } else {
        await db.update(eventDeliveries).set({ status: "delivered", deliveredAt: Date.now() }).where(owned());
      }
    })()
      .catch((err) => console.error(`plugin delivery ${delivery.id}: outcome not recorded:`, err))
      .finally(finish);
  }

  /** The loaded handler a plugin target names, or undefined. */
  private pluginHandler(target: SubscriptionTarget): { plugin: ValetPlugin; handler: PluginEventHandler } | undefined {
    const plugin = (this.deps.plugins ?? []).find((p) => p.name === target.plugin);
    const handler = plugin?.eventHandlers?.find((h) => h.id === target.handler);
    return plugin && handler ? { plugin, handler } : undefined;
  }

  /** The subject this run supersedes on, or null when the handler runs in parallel or the event has none. */
  private supersedeSubject(target: SubscriptionTarget, event: typeof events.$inferSelect): { subject: string; label: string } | null {
    if (this.pluginHandler(target)?.handler.concurrency !== "supersede") return null;
    return this.naturalSubject(event);
  }

  /**
   * Whether a newer event for `subject` already has a live or finished
   * delivery on this line. Skipped deliveries do not count: a newer event
   * the line skipped never ran.
   */
  private async newerSubjectDelivery(subscriptionId: string, event: typeof events.$inferSelect, subject: string): Promise<boolean> {
    const rows = await this.subjectDeliveries(subscriptionId, subject, and(
      inArray(eventDeliveries.status, ["pending", "failed", "delivered", "dead"]),
      sql`(${events.occurredAt}, ${events.receivedAt}, ${events.id}) > (${event.occurredAt}, ${event.receivedAt}, ${event.id})`,
    ));
    return rows.length > 0;
  }

  /** Skip this line's unfinished deliveries of older events for the subject. Returns their ids. */
  private async supersedeOlder(subscriptionId: string, event: typeof events.$inferSelect, subject: { subject: string; label: string }): Promise<string[]> {
    const older = await this.subjectDeliveries(subscriptionId, subject.subject, and(
      inArray(eventDeliveries.status, ["pending", "failed"]),
      sql`(${events.occurredAt}, ${events.receivedAt}, ${events.id}) < (${event.occurredAt}, ${event.receivedAt}, ${event.id})`,
    ));
    if (older.length === 0) return [];
    const rows = await this.deps.db.update(eventDeliveries)
      .set({ status: "skipped", lastError: supersededText(subject.label) })
      .where(and(inArray(eventDeliveries.id, older), inArray(eventDeliveries.status, ["pending", "failed"])))
      .returning({ id: eventDeliveries.id });
    return rows.map((r) => r.id);
  }

  /**
   * This line's deliveries whose event has `subject` as its natural subject.
   * The SQL prefilter only finds events that carry the subject; an event
   * also carries broader subjects (a GitHub PR event names its repo too),
   * so each candidate's own natural subject must equal `subject`. Otherwise
   * a repo-level event would supersede every pull request in the repo.
   */
  private async subjectDeliveries(subscriptionId: string, subject: string, where: SQL | undefined): Promise<string[]> {
    const candidates = await this.deps.db.select({ id: eventDeliveries.id, event: events })
      .from(eventDeliveries)
      .innerJoin(events, eq(events.id, eventDeliveries.eventId))
      .where(and(eq(eventDeliveries.subscriptionId, subscriptionId), arrayContains(events.subjects, [subject]), where));
    return candidates.filter((row) => this.naturalSubject(row.event)?.subject === subject).map((row) => row.id);
  }

  /** Why a renewal missed its fence: a superseding run skipped the row, or another run re-claimed it. */
  private async lostLeaseReason(deliveryId: string): Promise<string> {
    const [row] = await this.deps.db.select({ status: eventDeliveries.status }).from(eventDeliveries)
      .where(eq(eventDeliveries.id, deliveryId)).limit(1);
    return row?.status === "skipped" ? PLUGIN_SUPERSEDED : PLUGIN_LEASE_LOST;
  }

  private async runPluginDelivery(
    deliveryId: string,
    event: typeof events.$inferSelect,
    sub: typeof eventSubscriptions.$inferSelect,
    target: SubscriptionTarget,
    signal: AbortSignal,
    cancelChildren: AbortSignal,
  ): Promise<void> {
    const host = this.deps.pluginHandlers;
    if (!host) throw new Error("Plugin handlers are not configured on this server. Restart the API with plugin handler support.");
    const loaded = this.pluginHandler(target);
    if (!loaded) {
      throw new Error(`Plugin handler ${target.plugin}/${target.handler} is not loaded. Enable the plugin or delete this line.`);
    }
    const { plugin, handler } = loaded;
    let config: Record<string, unknown> = {};
    if (handler.configSchema) {
      // Checked again here: the plugin's schema may have changed since the line was saved.
      const checked = pluginHandlerConfig(handler.configSchema, target.config);
      if (!checked.ok) {
        throw new Error(`This line's settings do not match ${plugin.name}/${handler.id}: ${checked.error}. Edit the line's settings.`);
      }
      config = checked.args;
    } else if (target.config !== undefined) {
      throw new Error(`Handler ${plugin.name}/${handler.id} no longer takes settings. Remove the settings from this line.`);
    }
    if (sub.ownerType !== "user" && sub.ownerType !== "team") {
      throw new Error("A plugin handler acts for a person or a team. Arm it from a personal or team workspace.");
    }
    const owner = { type: sub.ownerType, id: sub.ownerId } satisfies Principal;
    if (!(await orgAllowsPluginForOwner(this.deps.db, sub.orgId, owner, plugin.name))) {
      throw new Error(`Plugin ${plugin.name} is off for this workspace. An org admin can turn it on in Settings, or delete this line.`);
    }
    // The handler acts as the workspace that owns the line, as a workflow
    // run does, not as the member who armed it.
    const actorUserId = actorUserIdFor(owner);
    const services = pluginServices(plugin);
    const store = pluginStore(this.deps.db, plugin.name);
    await handler.handle(
      {
        id: event.id,
        key: event.eventKey,
        dedupeKey: event.dedupeKey,
        occurredAt: new Date(event.occurredAt).toISOString(),
        // Written by ingest from NormalizedEvent; same narrowing as `refs` above.
        ...(event.actor ? { actor: event.actor as NonNullable<PluginEvent["actor"]> } : {}),
        refs: event.refs as Record<string, string>,
        summary: event.summary,
        payload: event.payload,
        ...(event.subjects ? { subjects: event.subjects } : {}),
      },
      {
        orgId: sub.orgId,
        owner,
        actorUserId,
        threads: host.threads({ plugin, orgId: sub.orgId, owner, actorUserId, deliveryId, signal, cancelChildren }),
        config,
        store: owner.type === "team" ? store.team(owner.id) : store.user(owner.id),
        memory: buildPluginMemory(this.deps.db, owner, actorUserId, sub.orgId),
        appToken: async (service, scope) => {
          if (!services.has(service)) {
            throw new Error(`Plugin ${plugin.name} did not declare service ${service}. Declare a credential for it in the plugin manifest.`);
          }
          return host.appToken(sub.orgId, service, scope);
        },
        signal,
      },
    );
  }

  /** The event's natural subject from the plugin that owns its service, or null (spec Part D). */
  private naturalSubject(event: typeof events.$inferSelect): { subject: string; label: string } | null {
    return eventNaturalSubject(this.deps.plugins ?? [], event);
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
    const naturalSubject = this.naturalSubject(event);
    return resolveDestination({
      rule: { id: sub.id, kind: "subscription", name: sub.name, policy: deliveryThreadPolicy(target, {
        channelOrigin: origin !== null, slackChannel: slackEventChannel(event) !== undefined, naturalSubject: naturalSubject !== null,
      }) },
      event: {
        deliveryId,
        summary: event.summary,
        naturalSubject,
        conversational: isConversationalEvent(bindingEvent, origin, found),
      },
      binding: found,
      claim: null,
    });
  }

  /**
   * Why another path owns a `slack.message` delivery that follows a follow
   * binding, or null (spec Part C steps 4 and 8). One post gives one turn:
   * - The follow router delivers the reply to the bound thread, and its
   *   cursor has passed the reply, so the rule skips it (`follow_routed`).
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
    // A named repair for the router-before-binding window (CLAUDE.md,
    // "Invariants: alert, don't auto-repair", rule 3). The router runs at
    // webhook time and dispatch runs later. A binding can appear (the
    // mention's delivery binds the thread) or the sender can become admitted
    // in between, so the router dropped a reply that `followRouteFor` now
    // routes. That is normal operation, not a defect. The rule skips only a
    // reply that the router's cursor has passed. Otherwise the subscription
    // delivers it, or the reply reaches no thread.
    if (route && route.ownerType === sub.ownerType && route.ownerId === sub.ownerId && sameThread
      && followRouterPassed(route, event.payload)) {
      // The delivery-threads spec (C3b) names this stored text.
      // copy-lint: allow delivery
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
    // The delivery-threads spec (C2b, C5) names this stored text.
    // copy-lint: allow delivery
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
   * "Invariants: alert, don't auto-repair", rule 3). It runs on every
   * terminal path that delivers nothing: a skip decided after ingest, a
   * deleted rule, a sender gate denial, and the last failed attempt.
   * Ingest suppressed the digest of the waiters that the stamp names (a
   * claim redirect's target, or the waiters in a binding's thread), and the
   * delivery now ends without reaching them. That is expected in normal
   * operation: a rule or a membership can change at any moment, and a
   * delivery can fail. Without the repair the waiter would never see the
   * event (INV-D6). The counter's `claim_recovered`
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
      reportError({ area: "events", reason: "waiter_redirect_end" }, `event dispatch: ending waiter ${waiterId} after its redirect delivery failed; it stays running`, err);
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
    presence?: Appearance,
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
