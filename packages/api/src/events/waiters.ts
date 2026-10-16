/**
 * Event waiter matching during ingest (spec 2026-10-15: event wakeups,
 * Part E). `ingestEvent` calls `matchEventWaiters` for every normalized
 * event, before the early return for an event that no subscription matched,
 * inside its own error boundary (INV-E2).
 *
 * The cost is one index lookup per event (`findEventWaiters`), independent
 * of the number of running waiters (INV-E6).
 */
import { and, eq } from "drizzle-orm";
import {
  recordEventMatchFailed,
  recordEventWaiterMatch,
  type DeriveContext,
  type NormalizedEvent,
  type SessionStore,
  type ValetPlugin,
  type Wakeup,
} from "@valet/engine";
import type { Providers } from "../providers/types.js";
import { agentSessions, eventSubscriptions } from "../schema/index.js";
import { channelVisibility, orgSlackCredential, slackEventChannel } from "../services/thread-access.js";
import { LINEAR_CLIENT_CREDENTIALS_GRANT, LINEAR_CREDENTIAL_SERVICE } from "../services/linear-app.js";
import { subscriptionMatchesEvent } from "./match.js";
import { isTeamAssistantMention } from "./team-slack-gate.js";
import { matchClauses, mentionsBot, needsPreviousStatus, toDigest } from "./waiter-match.js";

/** The counters the matcher writes (spec Part J). Tests replace them. */
export interface WaiterMatchMetrics {
  matched(service: string): void;
  failed(): void;
}

const DEFAULT_METRICS: WaiterMatchMetrics = {
  matched: recordEventWaiterMatch,
  failed: recordEventMatchFailed,
};

export interface WaiterMatchDeps {
  engineStore: SessionStore;
  /** The session's org and owner, or null when the session is gone. */
  sessionOrg(sessionId: string): Promise<{ orgId: string; ownerType: string; ownerId: string } | null>;
  plugins: ValetPlugin[];
  /** Whether the session may still read the Slack channel (spec Part E, step 4). */
  slackStillVisible(sessionId: string, channelId: string): Promise<boolean>;
  /** The event's previous status from provider state, or null when unknown. */
  resolvePreviousStatus(service: string, orgId: string, event: NormalizedEvent): Promise<string | null>;
  /** Wakes the WakeWatcher after an append. Absent until the WakeWatcher has a nudge. */
  nudge?: () => void;
  now(): number;
  /** Slack bot user id for the org, for the mention rule. */
  slackBotUserId(orgId: string): Promise<string | undefined>;
  /** True when an enabled slack.app_mention subscription matches this event's channel. */
  appMentionCovered(orgId: string, event: NormalizedEvent): Promise<boolean>;
  metrics?: Partial<WaiterMatchMetrics>;
}

function metricsOf(deps: Pick<WaiterMatchDeps, "metrics">): WaiterMatchMetrics {
  return { ...DEFAULT_METRICS, ...deps.metrics };
}

/** Counts a failed matching pass. `ingestEvent` calls it from its error boundary. */
export function recordWaiterMatchFailure(deps: Pick<WaiterMatchDeps, "metrics">): void {
  metricsOf(deps).failed();
}

/**
 * Matches `event` against the running event waiters that share one of its
 * subjects (spec Part E, steps 1 to 6). Returns the number of waiters that
 * got a new digest. A redelivered event that a waiter already holds or
 * already delivered does not count (INV-E4).
 *
 * A failure for one candidate is logged and counted, and the other
 * candidates still match. A failure before the candidate loop throws.
 */
export async function matchEventWaiters(
  deps: WaiterMatchDeps,
  orgId: string,
  service: string,
  event: NormalizedEvent,
): Promise<number> {
  const subjects = event.subjects ?? [];
  if (subjects.length === 0) return 0;
  const candidates = await deps.engineStore.findEventWaiters(subjects);
  if (candidates.length === 0) return 0;

  const metrics = metricsOf(deps);
  const derived = deps.plugins.flatMap((plugin) => plugin.derivedEvents ?? []);
  // Each lookup below runs at most once per event, and only when a
  // candidate needs it.
  let previousStatus: Promise<string | null> | undefined;
  let mentionSkipped: Promise<boolean> | undefined;
  const mentionRuleSkips = () => (mentionSkipped ??= (async () => {
    if (event.key !== "slack.message") return false;
    if (!mentionsBot(event, await deps.slackBotUserId(orgId))) return false;
    return deps.appMentionCovered(orgId, event);
  })());

  const matchOne = async (waiter: Wakeup): Promise<boolean> => {
    const spec = waiter.eventMatch;
    if (!spec) return false;
    // INV-E1: drop a candidate from another org before clause evaluation.
    const session = await deps.sessionOrg(waiter.sessionId);
    if (!session || session.orgId !== orgId) return false;

    let candidate = event;
    if (needsPreviousStatus(spec) && event.previousStatus === undefined) {
      previousStatus ??= deps.resolvePreviousStatus(service, orgId, event);
      const previous = await previousStatus;
      if (previous !== null) candidate = { ...event, previousStatus: previous };
    }
    const result = matchClauses(spec, candidate, derived);
    if (!result.matched) return false;

    // The mention reaches the agent once, through the app_mention subscription.
    if (await mentionRuleSkips()) return false;
    if (service === "slack") {
      const channel = slackEventChannel({ service, refs: event.refs, payload: event.payload });
      // A Slack event with no channel cannot be checked, so it is dropped.
      if (!channel || !(await deps.slackStillVisible(waiter.sessionId, channel))) return false;
    }
    return deps.engineStore.appendEventMatch(waiter.id, toDigest(candidate, result.derive), deps.now());
  };

  let appended = 0;
  for (const waiter of candidates) {
    try {
      if (await matchOne(waiter)) {
        appended++;
        metrics.matched(service);
      }
    } catch (error) {
      metrics.failed();
      console.error(`[event-waiters] matching failed for waiter ${waiter.id}`, error);
    }
  }
  if (appended > 0) deps.nudge?.();
  return appended;
}

/** The receipt stage for a matching pass (spec Part E, step 7). Metadata only. */
export function waiterMatchStage(count: number): { stage: string; outcome: string; detail: string } {
  return {
    stage: "waiter_match",
    outcome: count > 0 ? "matched" : "none",
    detail: `${count} event ${count === 1 ? "waiter" : "waiters"} matched.`,
  };
}

/**
 * Whether one of `subs` is an enabled `slack.app_mention` subscription that
 * matches the event's payload under the subscription matcher (the Part E
 * mention rule). The team mention gate's sender check is not run here.
 */
export function appMentionCoveredBy(
  subs: ReadonlyArray<{ enabled: boolean; ownerType: string; target: unknown; eventKeys: unknown; filters: unknown }>,
  event: NormalizedEvent,
  plugins: ValetPlugin[],
): boolean {
  const key = "slack.app_mention";
  const catalog = plugins.flatMap((p) => p.triggers ?? []).filter((t) => t.service === "slack").flatMap((t) => t.catalog);
  return subs.some((sub) => sub.enabled
    && subscriptionMatchesEvent(sub, key, event.payload, catalog, isTeamAssistantMention(sub, key)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The Linear state reference for a `from_status` lookup: the team key and
 * the previous state id from `updatedFrom.stateId`. Null when the update
 * did not change the state.
 */
export function linearPreviousStatusRef(payload: unknown): { teamKey?: string; stateId: string } | null {
  const root = asRecord(payload);
  const stateId = asRecord(root?.updatedFrom)?.stateId;
  if (typeof stateId !== "string" || !stateId) return null;
  const teamKey = asRecord(asRecord(root?.data)?.team)?.key;
  return typeof teamKey === "string" && teamKey ? { teamKey, stateId } : { stateId };
}

type WaiterProviders = Pick<Providers, "db" | "engineStore" | "engineCredentials" | "onePassword" | "plugins">;

/** The org's Linear app-actor token, or null when Linear is not connected with an app. */
async function linearAppToken(providers: WaiterProviders, orgId: string): Promise<string | null> {
  const stored = await providers.engineCredentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  if (stored?.metadata?.grant !== LINEAR_CLIENT_CREDENTIALS_GRANT) return null;
  return stored.accessToken ?? null;
}

/**
 * The production matcher deps over the API's providers. Ingest replaces
 * `appMentionCovered` with a check over the subscriptions it already read.
 */
export function waiterMatchDeps(providers: WaiterProviders, opts: { nudge?: () => void } = {}): WaiterMatchDeps {
  const sessionOrg: WaiterMatchDeps["sessionOrg"] = async (sessionId) => {
    const [row] = await providers.db
      .select({ orgId: agentSessions.orgId, ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId, status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (!row || row.status === "deleted") return null;
    return { orgId: row.orgId, ownerType: row.ownerType, ownerId: row.ownerId };
  };
  return {
    engineStore: providers.engineStore,
    sessionOrg,
    plugins: providers.plugins,
    // A personal session sees what its owner may see. A team session sees
    // only public channels, the rule for content every member reads.
    async slackStillVisible(sessionId, channelId) {
      const session = await sessionOrg(sessionId);
      if (!session) return false;
      const userId = session.ownerType === "user" ? session.ownerId : undefined;
      return channelVisibility(providers, { orgId: session.orgId, userId })(`slack:${channelId}`);
    },
    async resolvePreviousStatus(service, orgId, event) {
      const resolver = providers.plugins.find((p) => p.name === service)?.statusResolver;
      if (!resolver || service !== "linear") return null;
      const ref = linearPreviousStatusRef(event.payload);
      if (!ref) return null;
      const ctx: DeriveContext = { orgId, appToken: () => linearAppToken(providers, orgId), fetch };
      return resolver.resolve(ctx, ref);
    },
    ...(opts.nudge ? { nudge: opts.nudge } : {}),
    now: Date.now,
    // The Slack connection stores the bot user id in the credential's
    // metadata (`botUserId`), the same source the Slack inbox reads.
    async slackBotUserId(orgId) {
      const credential = await orgSlackCredential(providers, orgId);
      const botUserId = credential?.metadata?.botUserId;
      return typeof botUserId === "string" && botUserId ? botUserId : undefined;
    },
    async appMentionCovered(orgId, event) {
      const subs = await providers.db.select().from(eventSubscriptions)
        .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
      return appMentionCoveredBy(subs, event, providers.plugins);
    },
  };
}
