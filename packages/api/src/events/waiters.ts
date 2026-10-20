/**
 * Event waiter matching during ingest (spec 2026-10-15: event wakeups,
 * Part E). `ingestEvent` calls `evaluateWaiterCandidates` for every
 * normalized event, before the early return for an event that no
 * subscription matched, resolves claims over the candidates (spec
 * 2026-10-16: delivery threads and claims, Part C), then calls
 * `appendWaiterDigests`. Both run inside their own error boundary (INV-E2).
 *
 * The cost is one index lookup per event (`findEventWaiters`), independent
 * of the number of running waiters (INV-E6).
 */
import { eq } from "drizzle-orm";
import {
  EVENT_BUFFER_MAX_DIGESTS,
  EVENT_DELIVERED_MAX_KEYS,
  recordEventMatchFailed,
  type ChannelOrigin,
  recordEventWaiterMatch,
  type DeriveContext,
  type EventMatchDigest,
  type NormalizedEvent,
  type SessionStore,
  type ValetPlugin,
  type Wakeup,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { Providers } from "../providers/types.js";
import { agentSessions } from "../schema/index.js";
import type { ChannelVisibility } from "../services/channels.js";
import { channelVisibility, orgSlackCredential, slackEventChannel } from "../services/thread-access.js";
import { slackBotUserIdOf } from "../services/slack-bot-identity.js";
import { LINEAR_CLIENT_CREDENTIALS_GRANT, LINEAR_CREDENTIAL_SERVICE } from "../services/linear-app.js";
import { anyMatch, matchClauses, needsPreviousStatus, toDigest } from "./waiter-match.js";
import { channelOriginResolver } from "./channel-origin.js";

/** The counters the matcher writes (spec Part J). Tests replace them. */
export interface WaiterMatchMetrics {
  matched(service: string): void;
  failed(): void;
}

const DEFAULT_METRICS: WaiterMatchMetrics = {
  matched: recordEventWaiterMatch,
  failed: recordEventMatchFailed,
};

/** A candidate waiter's session, as `sessionOrg` loaded it. */
export interface WaiterSession {
  sessionId: string;
  orgId: string;
  ownerType: string;
  ownerId: string;
}

export interface WaiterMatchDeps {
  engineStore: SessionStore;
  /** The session's org and owner, or null when the session is gone. */
  sessionOrg(sessionId: string): Promise<{ orgId: string; ownerType: string; ownerId: string } | null>;
  plugins: ValetPlugin[];
  /** Whether the session may still read the Slack channel (spec Part E, step 4). */
  slackStillVisible(session: WaiterSession, channelId: string): Promise<boolean>;
  /** The event's previous status from provider state, or null when unknown. */
  resolvePreviousStatus(service: string, orgId: string, event: NormalizedEvent): Promise<string | null>;
  /** Wakes the WakeWatcher for the waiters that got a digest. */
  nudge?: (wakeupIds: string[]) => void;
  now(): number;
  /** Slack bot user id for the org, for the plugin's `conversationalTwin` hook. */
  slackBotUserId(orgId: string): Promise<string | undefined>;
  /**
   * The channel origin of an event, as the dispatcher resolves it. Claim
   * resolution reads it for the follow binding and the direct-message test.
   * Absent → no origin: no follow binding is found at ingest.
   */
  channelOrigin?: (service: string, eventKey: string, payload: unknown) => ChannelOrigin | null;
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
 * One running waiter that shares a subject with the event, in the event's
 * org. `accepted` is true when its clauses accept the event and the Slack
 * visibility check holds. `digests` holds what the waiter appends when
 * claim resolution lets it (spec 2026-10-16: delivery threads and claims,
 * Part C).
 */
export interface WaiterCandidate {
  waiter: Wakeup;
  session: WaiterSession;
  digests: EventMatchDigest[];
  accepted: boolean;
}

/** What claim resolution decided for one waiter. A waiter with no decision appends. */
export type WaiterDecision = "append" | "suppress";

/**
 * Evaluates the running event waiters that share one of the event's
 * subjects (spec Part E, steps 1 to 4) and returns them without appending.
 * A candidate from another org, or whose session is gone, is left out
 * (INV-E1).
 *
 * A failure for one candidate is logged and counted, and the other
 * candidates still evaluate. A failure before the candidate loop throws.
 */
export async function evaluateWaiterCandidates(
  deps: WaiterMatchDeps,
  orgId: string,
  service: string,
  event: NormalizedEvent,
  onError?: () => void,
): Promise<WaiterCandidate[]> {
  const subjects = event.subjects ?? [];
  if (subjects.length === 0) return [];
  const waiters = await deps.engineStore.findEventWaiters(subjects);
  if (waiters.length === 0) return [];

  const metrics = metricsOf(deps);
  const derived = deps.plugins.flatMap((plugin) => plugin.derivedEvents ?? []);
  // Each lookup below runs at most once per event, and only when a
  // candidate needs it.
  let previousStatus: Promise<string | null> | undefined;
  // Waiters of one owner share one visibility answer per channel.
  const visible = new Map<string, Promise<boolean>>();
  const stillVisible = (session: WaiterSession, channel: string) => {
    const key = `${session.orgId}\u0000${session.ownerType}\u0000${session.ownerId}\u0000${channel}`;
    let answer = visible.get(key);
    if (!answer) {
      answer = deps.slackStillVisible(session, channel);
      visible.set(key, answer);
    }
    return answer;
  };

  const evaluateOne = async (waiter: Wakeup): Promise<WaiterCandidate | null> => {
    const spec = waiter.eventMatch;
    if (!spec) return null;
    // INV-E1: drop a candidate from another org before clause evaluation.
    const owner = await deps.sessionOrg(waiter.sessionId);
    if (!owner || owner.orgId !== orgId) return null;
    const session: WaiterSession = { sessionId: waiter.sessionId, ...owner };
    const rejected: WaiterCandidate = { waiter, session, digests: [], accepted: false };

    let candidate = event;
    if (needsPreviousStatus(spec, derived) && event.previousStatus === undefined) {
      previousStatus ??= deps.resolvePreviousStatus(service, orgId, event);
      const previous = await previousStatus;
      if (previous !== null) candidate = { ...event, previousStatus: previous };
    }
    const result = matchClauses(spec, candidate, derived);
    if (!anyMatch(result)) return rejected;
    if (service === "slack") {
      const channel = slackEventChannel({ service, refs: event.refs, payload: event.payload });
      // A Slack event with no channel cannot be checked, so it is dropped.
      if (!channel || !(await stillVisible(session, channel))) return rejected;
    }
    // A direct match and each derived match append their own digest, so a
    // mid-run failure goes out now and the derive digest waits (Part E).
    const digests = [
      ...(result.direct ? [toDigest(candidate)] : []),
      ...result.derive.map((key) => toDigest(candidate, key)),
    ];
    return { waiter, session, digests, accepted: true };
  };

  const candidates: WaiterCandidate[] = [];
  for (const waiter of waiters) {
    try {
      const candidate = await evaluateOne(waiter);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      onError?.();
      metrics.failed();
      console.error(`[event-waiters] matching failed for waiter ${waiter.id}`, error);
    }
  }
  return candidates;
}

/**
 * Appends the digests of every accepted candidate whose decision is not
 * `suppress` (spec Part E, steps 5 and 6), then nudges the WakeWatcher
 * once. Returns counts of waiters, direct matches, sources, and failures. A redelivered
 * event that a waiter already holds or already delivered does not count
 * (INV-E4). A failed append for one waiter is logged and counted, and the
 * other waiters still append.
 */
export async function appendWaiterDigests(
  deps: WaiterMatchDeps,
  service: string,
  candidates: ReadonlyArray<WaiterCandidate>,
  decisions: ReadonlyMap<string, WaiterDecision> = new Map(),
): Promise<WaiterAppendResult> {
  const result: WaiterAppendResult = { waiters: 0, direct: 0, sources: 0, errors: 0 };
  const metrics = metricsOf(deps);
  const appended: string[] = [];
  const capped: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.accepted || decisions.get(candidate.waiter.id) === "suppress") continue;
    try {
      let any = false;
      for (const digest of candidate.digests) {
        if (await deps.engineStore.appendEventMatch(candidate.waiter.id, digest, deps.now())) {
          any = true;
          if (digest.derive) result.sources++;
          else result.direct++;
        }
      }
      const nearCap = (candidate.waiter.eventSeen?.length ?? 0) >= EVENT_DELIVERED_MAX_KEYS - EVENT_BUFFER_MAX_DIGESTS;
      if (nearCap) {
        const current = await deps.engineStore.getWakeup(candidate.waiter.id);
        const used = (current?.eventSeen?.length ?? 0) + (current?.eventBuffer ?? []).filter((digest) => !digest.derive).length;
        if (current && used >= EVENT_DELIVERED_MAX_KEYS) {
          result.outputCapped = (result.outputCapped ?? 0) + 1;
          if (!any) capped.push(candidate.waiter.id);
        }
      }
      if (any) {
        appended.push(candidate.waiter.id);
        metrics.matched(service);
      }
    } catch (error) {
      result.errors++;
      metrics.failed();
      console.error(`[event-waiters] matching failed for waiter ${candidate.waiter.id}`, error);
    }
  }
  if (appended.length + capped.length > 0) deps.nudge?.([...appended, ...capped]);
  return { ...result, waiters: appended.length };
}

export interface WaiterAppendResult {
  waiters: number;
  direct: number;
  sources: number;
  errors: number;
  outputCapped?: number;
}

/** Counts newly buffered direct matches and derivation sources separately. */
export function waiterMatchStage(result: WaiterAppendResult): { stage: string; outcome: string; detail: string } {
  return {
    stage: "waiter_match",
    outcome: result.errors > 0 ? "failed" : result.outputCapped ? "output_cap" : result.waiters > 0 ? "matched" : "none",
    detail: `Direct matches: ${result.direct}. Buffered derivation sources: ${result.sources}. Append failures: ${result.errors}.${result.outputCapped ? ` Output limit reached for ${result.outputCapped} ${result.outputCapped === 1 ? "wait" : "waits"}. Re-arm a new wait.` : ""}`,
  };
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

/** A session's org and owner, or null when the session is gone or deleted. */
export async function loadSessionOwner(
  db: AppDb,
  sessionId: string,
): Promise<{ orgId: string; ownerType: string; ownerId: string } | null> {
  const [row] = await db
    .select({ orgId: agentSessions.orgId, ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId, status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row || row.status === "deleted") return null;
  return { orgId: row.orgId, ownerType: row.ownerType, ownerId: row.ownerId };
}

type WaiterProviders = Pick<Providers, "db" | "engineStore" | "engineCredentials" | "plugins"> & {
  onePassword?: Providers["onePassword"];
  channelHost?: Providers["channelHost"];
};

/**
 * The longest time ingest waits for one provider call in the matcher: the
 * Linear state lookup or the Slack channel check. Ingest awaits the
 * matcher inside the webhook request, so a stalled provider must not stall
 * the response or the subscription deliveries after it (INV-E2).
 */
export const WAITER_PROVIDER_TIMEOUT_MS = 2_000;

/** Resolves to `fallback` when `work` does not settle within `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** `fetchImpl` with an abort after `ms`, combined with any caller signal. */
export function boundedFetch(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

export interface WaiterMatchDepsOptions {
  /** Wakes the WakeWatcher for the waiters that got a digest. */
  nudge?: (wakeupIds: string[]) => void;
  /** Overrides `WAITER_PROVIDER_TIMEOUT_MS`. Tests only. */
  providerTimeoutMs?: number;
  /** The fetch the Linear state lookup uses. Tests only. */
  fetch?: typeof fetch;
  /** Builds the Slack channel check for one viewer. Tests only. */
  channelVisibility?: (viewer: { orgId: string; userId: string | undefined }) => ChannelVisibility;
}

/** The org's Linear app-actor token, or null when Linear is not connected with an app. */
async function linearAppToken(providers: WaiterProviders, orgId: string): Promise<string | null> {
  const stored = await providers.engineCredentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  if (stored?.metadata?.grant !== LINEAR_CLIENT_CREDENTIALS_GRANT) return null;
  return stored.accessToken ?? null;
}

/** The production matcher deps over the API's providers. */
export function waiterMatchDeps(providers: WaiterProviders, opts: WaiterMatchDepsOptions = {}): WaiterMatchDeps {
  const timeoutMs = opts.providerTimeoutMs ?? WAITER_PROVIDER_TIMEOUT_MS;
  const linearFetch = boundedFetch(opts.fetch ?? fetch, timeoutMs);
  const visibilityFor = opts.channelVisibility ?? ((viewer) => channelVisibility(providers, viewer));
  // One channel check per viewer for the life of these deps, so the
  // credential and identity lookups it caches are shared.
  const viewers = new Map<string, ChannelVisibility>();
  return {
    engineStore: providers.engineStore,
    sessionOrg: (sessionId) => loadSessionOwner(providers.db, sessionId),
    plugins: providers.plugins,
    // A personal session sees what its owner may see. A team session sees
    // only public channels, the rule for content every member reads.
    // The live membership check takes no signal, so a slow Slack answer
    // fails closed after the timeout.
    async slackStillVisible(session, channelId) {
      const userId = session.ownerType === "user" ? session.ownerId : undefined;
      const viewerKey = `${session.orgId}\u0000${userId ?? ""}`;
      let canSee = viewers.get(viewerKey);
      if (!canSee) {
        canSee = visibilityFor({ orgId: session.orgId, userId });
        viewers.set(viewerKey, canSee);
      }
      return withTimeout(canSee(`slack:${channelId}`), timeoutMs, false);
    },
    async resolvePreviousStatus(service, orgId, event) {
      const resolver = providers.plugins.find((p) => p.name === service)?.statusResolver;
      if (!resolver || service !== "linear") return null;
      const ref = linearPreviousStatusRef(event.payload);
      if (!ref) return null;
      const ctx: DeriveContext = { orgId, appToken: () => linearAppToken(providers, orgId), fetch: linearFetch };
      // The fetch aborts after the timeout. The race also bounds a fetch
      // that ignores its signal. No previous status means no match.
      return withTimeout(resolver.resolve(ctx, ref), timeoutMs, null);
    },
    ...(opts.nudge ? { nudge: opts.nudge } : {}),
    ...(providers.channelHost ? { channelOrigin: channelOriginResolver(providers.channelHost) } : {}),
    now: Date.now,
    // The same resolution the Slack inbox drain gives the follow router
    // (`slackBotUserIdOf`), so both agree on which posts address the bot.
    async slackBotUserId(orgId) {
      return slackBotUserIdOf(providers.engineCredentials, orgId, await orgSlackCredential(providers, orgId));
    },
  };
}
