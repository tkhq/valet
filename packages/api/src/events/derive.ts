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
import { recordEventDerive, type DeriveContext, type DerivedEventDef, type EventDeriveResult, type EventMatchDigest, type NormalizedEvent, type ValetPlugin } from "@valet/engine";
import { resolveInstallationApiToken, type GitHubTokenDeps } from "../services/github-tokens.js";
import { toDigest } from "./waiter-match.js";

export type RunDeriveResult =
  | { result: "event"; digest: EventMatchDigest }
  | { result: "null" }
  | { result: "error"; error: unknown };

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
 *   Keep the source digest (Review Focus 4).
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
    return { result: "error", error };
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
