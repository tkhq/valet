/**
 * Derived event resolution for event waiters (spec 2026-10-15: event
 * wakeups, Part B, INV-E9, Part J).
 *
 * Ingest never calls `derive`. The matcher marks a digest `derive: <key>`
 * when a clause on a derived key matched one of its `sources`, and the
 * WakeWatcher calls `runDerive` for that digest before delivery. `runDerive`
 * is the one owner of the `valet_event_waiter_derive_total` counter: it
 * records exactly one result per call.
 */
import { eq } from "drizzle-orm";
import { DerivePermissionError, recordEventDerive, type DeriveContext, type DerivedEventDef, type EventDeriveResult, type EventMatchDigest, type NormalizedEvent, type ValetPlugin, type Wakeup } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { resolveInstallationApiToken, type GitHubTokenDeps } from "../services/github-tokens.js";
import { toDigest } from "./waiter-match.js";

export type RunDeriveResult =
  | { result: "event"; digest: EventMatchDigest }
  | { result: "null" }
  | { result: "error"; error: unknown; consumeSource?: boolean };

function findDerived(plugins: ValetPlugin[], key: string): DerivedEventDef | undefined {
  for (const plugin of plugins) {
    const def = plugin.derivedEvents?.find((d) => d.key === key);
    if (def) return def;
  }
  return undefined;
}

/**
 * The minimal source event a digest still describes. A digest keeps no raw
 * payload, so `derive` reads what it needs from `subjects` (the commit
 * subject carries the SHA) and its own `subject` argument.
 */
export function sourceEventFromDigest(digest: EventMatchDigest): NormalizedEvent {
  const event: NormalizedEvent = {
    key: digest.key,
    dedupeKey: digest.dedupeKey,
    occurredAt: digest.occurredAt,
    refs: {},
    summary: digest.summary,
    payload: null,
    subjects: digest.subjects,
  };
  if (digest.status !== undefined) event.status = digest.status;
  if (digest.previousStatus !== undefined) event.previousStatus = digest.previousStatus;
  return event;
}

/**
 * Resolves a digest marked `derive` (spec Part B, Part F). Returns:
 * - `event`: the derived condition holds; deliver `digest` in place of the source digest.
 * - `null`: the condition does not hold yet; drop the source digest and send no signal.
 * - `error`: a provider read failed or timed out, or no plugin declares the key.
 *   Permission denials consume the source; other errors keep it for retry.
 *
 * A digest with no `derive` mark is an `error` and makes no provider call (INV-E9).
 */
export async function runDerive(
  plugins: ValetPlugin[],
  orgId: string,
  digest: EventMatchDigest,
  subject: string,
  ctx: DeriveContext,
  record: (key: string, result: EventDeriveResult) => void = recordEventDerive,
): Promise<RunDeriveResult> {
  const key = digest.derive;
  if (key === undefined) {
    return { result: "error", error: new Error(`runDerive needs a digest marked derive; digest ${digest.dedupeKey} has none.`) };
  }
  const def = findDerived(plugins, key);
  if (!def) {
    record(key, "error");
    return { result: "error", error: new Error(`No plugin declares the derived event key ${key}.`) };
  }
  try {
    const derived = await def.derive({ ...ctx, orgId }, subject, sourceEventFromDigest(digest));
    if (derived === null) {
      record(key, "null");
      return { result: "null" };
    }
    record(key, "event");
    return { result: "event", digest: toDigest(derived) };
  } catch (error) {
    record(key, "error");
    return { result: "error", error, ...(error instanceof DerivePermissionError ? { consumeSource: true } : {}) };
  }
}

/** Mints the org's app token for a GitHub owner, or null when none resolves. */
export type GithubTokenFor = (orgId: string, owner: string | undefined) => Promise<string | null>;

/** The production `GithubTokenFor`: the org's GitHub App installation token for the owner. */
export function githubInstallationTokenFor(deps: GitHubTokenDeps): GithubTokenFor {
  return (orgId, owner) => resolveInstallationApiToken(deps, orgId, owner);
}

/**
 * The `DeriveContext` for a GitHub derived key on `subject`. `appToken` is
 * bound to the subject's owner, so a multi-installation org mints the
 * installation that can read that repository. The plugin bounds each
 * request with its own timeout.
 *
 * The WakeWatcher builds it as
 * `githubDeriveContext(orgId, subject, githubInstallationTokenFor(tokenDeps))`.
 */
export function githubDeriveContext(
  orgId: string,
  subject: string,
  tokenFor: GithubTokenFor,
  fetchImpl: typeof fetch = fetch,
): DeriveContext {
  const owner = /^github:([^/#@\s]+)/.exec(subject)?.[1]?.toLowerCase();
  return { orgId, appToken: () => tokenFor(orgId, owner), fetch: fetchImpl };
}

/**
 * The longest time the WakeWatcher waits for one derive call. One derive
 * can make about 22 sequential requests of up to 5 s each, and a pass
 * handles its rows one at a time. Past this, the call is an `error`, so
 * the source digest stays for the next tick.
 */
export const EVENT_DERIVE_DEADLINE_MS = 20_000;

/** Resolves one digest marked `derive` for a waiter row. The WakeWatcher's `deriveEvent` dep. */
export type EventWaiterDerive = (row: Wakeup, digest: EventMatchDigest) => Promise<RunDeriveResult>;

export interface EventWaiterDeriverDeps {
  plugins: ValetPlugin[];
  /** The session's org id, or null when the session is gone. */
  sessionOrg(sessionId: string): Promise<string | null>;
  /** The derive context for `key` on `subject`. Its `fetch` must honor `signal`. */
  contextFor(orgId: string, key: string, subject: string, signal: AbortSignal): DeriveContext;
  /** Overrides `EVENT_DERIVE_DEADLINE_MS`. Tests only. */
  deadlineMs?: number;
  /** Overrides `recordEventDerive`. Tests only. */
  record?: (key: string, result: EventDeriveResult) => void;
}

/**
 * Builds the WakeWatcher's derive step over `runDerive` (spec Part F step
 * 1). It bounds the whole call with one deadline: the deadline aborts the
 * context's requests, and a derive that ignores the abort still returns
 * `error` at the deadline. `runDerive` stays the one recorder of
 * `valet_event_waiter_derive_total`.
 */
export function eventWaiterDeriver(deps: EventWaiterDeriverDeps): EventWaiterDerive {
  const deadlineMs = deps.deadlineMs ?? EVENT_DERIVE_DEADLINE_MS;
  return async (row, digest) => {
    const subject = row.subjects?.[0];
    if (subject === undefined || digest.derive === undefined) {
      return { result: "error", error: new Error(`Waiter ${row.id} has no key, or digest ${digest.dedupeKey} has no derive key.`) };
    }
    const orgId = await deps.sessionOrg(row.sessionId);
    if (orgId === null) {
      return { result: "error", error: new Error(`The session ${row.sessionId} of waiter ${row.id} no longer exists.`) };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RunDeriveResult>((resolve) => {
      timer = setTimeout(() => {
        const error = new Error(`The derive of ${digest.derive} for waiter ${row.id} passed its ${deadlineMs} ms deadline.`);
        controller.abort(error);
        resolve({ result: "error", error });
      }, deadlineMs);
    });
    const ctx = deps.contextFor(orgId, digest.derive, subject, controller.signal);
    try {
      return await Promise.race([runDerive(deps.plugins, orgId, digest, subject, ctx, deps.record), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `fetchImpl` that also aborts when `signal` aborts. */
function abortableFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/**
 * The production derive step: the session's org from `agent_sessions`, and
 * the org's GitHub App token for a GitHub derived key. A key of another
 * service gets no app token.
 */
export function productionEventWaiterDeriver(deps: { db: AppDb; plugins: ValetPlugin[]; githubTokenDeps: GitHubTokenDeps }): EventWaiterDerive {
  const tokenFor = githubInstallationTokenFor(deps.githubTokenDeps);
  return eventWaiterDeriver({
    plugins: deps.plugins,
    async sessionOrg(sessionId) {
      const [row] = await deps.db
        .select({ orgId: agentSessions.orgId, status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      return row && row.status !== "deleted" ? row.orgId : null;
    },
    contextFor(orgId, key, subject, signal) {
      const bounded = abortableFetch(fetch, signal);
      if (key.startsWith("github.")) return githubDeriveContext(orgId, subject, tokenFor, bounded);
      return { orgId, appToken: async () => null, fetch: bounded };
    },
  });
}
