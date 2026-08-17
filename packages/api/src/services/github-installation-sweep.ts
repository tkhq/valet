/**
 * Automatic GitHub App installation refresh.
 *
 * `github_installations` is written by the setup callback, the connect-App
 * save, the manual "Refresh installations" button, and the `installation`
 * webhook. Every one of those needs an event: a click, or a delivery. An
 * instance with no public URL gets no deliveries (see `syncAllAppWebhookUrls`,
 * which logs exactly that), so a person had to press the button before Valet
 * could see a new installation. This sweep is the path that needs neither.
 *
 * ── Shape ────────────────────────────────────────────────────────────────
 * One `setInterval`, one handle with `stop()`, an `.unref()`'d timer — the
 * same shape as `engine/rotate-sweep.ts`, started in `main.ts` and stopped in
 * its shutdown path. The tick wakes every 60 s and calls
 * `discoverInstallations` for AT MOST ONE org that is due. N orgs therefore
 * spread over N minutes, and the sweep never holds more than one GitHub
 * request in flight.
 *
 * ── When an org is due ───────────────────────────────────────────────────
 * Freshness comes from `MAX(github_installations.updatedAt)` for the org. That
 * column is a true "last successful check" marker, because
 * `discoverInstallations` sets it on every upsert whether or not the row
 * changed. It also makes the manual button and the webhook suppress the sweep
 * for free: both write the same column.
 *
 *   - No installation rows           → 2 min. The known-incomplete state:
 *     someone created the App and is on GitHub installing it. An empty list
 *     is one request.
 *   - Rows, no webhook possible      → 15 min. Nothing else will ever tell us.
 *   - Rows, webhook live             → 6 h. Deliveries are the real path; the
 *     sweep only repairs a missed one.
 *
 * An org with no rows has no timestamp to date from, so the in-memory map
 * below holds its next due time — the same technique `github-tokens.ts`
 * already uses for its lazy per-process discovery throttle.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────
 * `GET /app/installations` is one request per 100 installations, so a check is
 * one request for any real org. The worst tier is 30 requests/hour for one
 * org, and it ends as soon as one installation appears. GitHub's App budget is
 * 5,000 requests/hour, and one sequential request per minute is 1/900 of the
 * documented per-minute secondary budget.
 *
 * ── Environment-supplied Apps sweep too (deliberate) ─────────────────────
 * `syncAppWebhookUrl` refuses to act unless the config source is `"org"`. That
 * guard is not a general "keep away from other people's Apps" rule: it exists
 * because `PATCH /app/hook/config` WRITES global App state, an App holds one
 * webhook URL, and a local instance asserting its own tunnel takes every
 * delivery away from the instance that owns the App.
 *
 * Discovery has none of that. `GET /app/installations` is a read, it changes
 * nothing on GitHub, and the write side is `github_installations` rows scoped
 * by `orgId` in this instance's own database. The decisive point runs the
 * other way: `"environment"` is how a deployment or a shared development App
 * arrives, and such an instance usually has no public URL, so the sweep is the
 * ONLY automatic path there. Copying the guard by reflex would leave the
 * manual button as the sole mechanism in the exact environment this is for.
 *
 * ── Candidate set (a limit inherited, not introduced) ────────────────────
 * `discoverInstallations(deps, orgId)` files EVERY installation under the org
 * it is called for — the single-org limitation `routes/github-app.ts`
 * documents. Sweeping every org on one environment-supplied App would repeat
 * identical GitHub calls and give each org a full copy of the list. So the
 * candidate set is: orgs with a `github_app` credential row, plus orgs that
 * already hold installation rows, plus — only when both sets are empty and an
 * environment config resolves — the oldest org, which is what
 * `resolveEnvFallbackOrgId` picks for the same case. A multi-org deployment on
 * one environment App still needs a real App-to-org mapping. This does not
 * pretend to solve that.
 *
 * ── No cross-instance lock ───────────────────────────────────────────────
 * Two api processes sweep independently, because a lock needs schema. At these
 * rates that doubles a negligible number. Each org's due time carries ±25%
 * jitter, so two processes (or two developer machines on a shared App) do not
 * phase-lock.
 */
import type { AppQueryable } from "../lib/drizzle.js";
import { githubInstallations, orgs } from "../schema/index.js";
import {
  discoverInstallations,
  listOrgsWithAppCredential,
  loadAppConfigWithSource,
  resolveGithubAppEnvConfig,
  type GithubAppDeps,
} from "./github-app.js";

/** How long an org of each kind stays fresh. */
export type SweepTier = "no-installations" | "webhook-absent" | "webhook-live";

export const SWEEP_DUE_MS: Record<SweepTier, number> = {
  "no-installations": 2 * 60_000,
  "webhook-absent": 15 * 60_000,
  "webhook-live": 6 * 60 * 60_000,
};

/** The shortest due time of any tier that applies to an org WITH rows. An org
 * checked more recently than this cannot be due, whatever its tier, so the
 * tick can skip it before it reads any credential. */
const MIN_ROWS_DUE_MS = Math.min(SWEEP_DUE_MS["webhook-absent"], SWEEP_DUE_MS["webhook-live"]);

const DEFAULT_INTERVAL_MS = 60_000;
/** A revoked key or a deleted App costs one request per this period, not one
 * per tier interval. */
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const MAX_BACKOFF_DOUBLINGS = 5;

export interface InstallationSweepDeps extends GithubAppDeps {
  /** This instance's public base URL (`publicUrlFromEnv`). Absent or empty
   * means GitHub cannot deliver webhooks here, so no org counts as
   * webhook-live. */
  publicUrl?: string;
  /** How often the tick wakes. Default: 60 s. */
  intervalMs?: number;
  /** Injectable randomness for the jitter; defaults to `Math.random`. */
  random?: () => number;
}

export interface InstallationSweepHandle {
  stop(): void;
}

/** Per-org scheduling state. It survives only in this process: a restart
 * re-checks the zero-row orgs once (one request each) and forgets one backoff
 * step per failing org. Both costs are one extra request. */
export interface SweepEntry {
  nextDueAt: number;
  failures: number;
}

export type SweepState = Map<string, SweepEntry>;

export interface SweepCandidate {
  orgId: string;
  /** `MAX(github_installations.updatedAt)`; `null` when the org has no rows. */
  lastCheckedAt: number | null;
  tier: SweepTier;
}

export function createSweepState(): SweepState {
  return new Map();
}

/** Spreads a due time by ±25% so two processes on one App do not phase-lock. */
export function jitterMs(ms: number, random: () => number): number {
  return Math.round(ms * (0.75 + random() * 0.5));
}

/** Wait after a failed check: the tier's own interval doubled once per
 * failure, capped at 6 h, then jittered. */
export function backoffDelayMs(tier: SweepTier, failures: number, random: () => number): number {
  const doublings = Math.min(Math.max(failures, 0), MAX_BACKOFF_DOUBLINGS);
  const base = Math.min(SWEEP_DUE_MS[tier] * 2 ** doublings, MAX_BACKOFF_MS);
  return jitterMs(base, random);
}

/** Picks the one org this tick checks: the least recently checked org that is
 * past both its tier's due time and any backoff the state map holds. `null`
 * when nothing is due, which is what most ticks answer. An org with no rows
 * sorts first, because it has no timestamp and is the state a person is
 * waiting on. */
export function selectDueOrg(candidates: SweepCandidate[], now: number, state: SweepState): SweepCandidate | null {
  let best: SweepCandidate | null = null;
  for (const candidate of candidates) {
    const entry = state.get(candidate.orgId);
    if (entry && entry.nextDueAt > now) continue;
    if (candidate.lastCheckedAt !== null && now - candidate.lastCheckedAt < SWEEP_DUE_MS[candidate.tier]) continue;
    if (best === null || (candidate.lastCheckedAt ?? 0) < (best.lastCheckedAt ?? 0)) best = candidate;
  }
  return best;
}

/**
 * Starts the sweep. Call it next to `startRotateSweep` in the api boot, and
 * call `handle.stop()` in the shutdown path.
 *
 * The interval is `.unref()`'d, so the sweep alone never keeps the process
 * alive. `runInstallationSweepTick` swallows every error it can reach; the
 * `.catch` is the last guard against a rejection nobody would otherwise see.
 */
export function startInstallationSweep(deps: InstallationSweepDeps): InstallationSweepHandle {
  const state = createSweepState();
  const timer = setInterval(() => {
    void runInstallationSweepTick(deps, state).catch((err) => {
      console.error("github installation sweep: tick failed (the next tick continues):", err);
    });
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Do not prevent the process from exiting if this is the only active handle.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * One sweep pass — exported for tests, and the only place that talks to
 * GitHub. Returns the org it checked, or `null` when it checked nothing.
 * NEVER throws: a broken org must not stop the sweep for the other orgs, and
 * must not surface as an unhandled rejection in the boot process.
 */
export async function runInstallationSweepTick(
  deps: InstallationSweepDeps,
  state: SweepState,
): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  const random = deps.random ?? Math.random;

  let candidates: SweepCandidate[];
  try {
    candidates = await collectCandidates(deps, now, state, random);
  } catch (err) {
    console.error(
      "github installation sweep: could not list the orgs to check. Check the database connection. The next tick tries again:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  const target = selectDueOrg(candidates, now, state);
  if (!target) return null;

  try {
    await discoverInstallations(deps, target.orgId);
  } catch (err) {
    recordFailure(state, target.orgId, target.tier, now, random, err, "read the installations of");
    return null;
  }

  state.set(target.orgId, { failures: 0, nextDueAt: now + jitterMs(SWEEP_DUE_MS[target.tier], random) });
  return target.orgId;
}

/** Applies the backoff and logs once. The first failure is an error the
 * operator must see; repeats drop to `debug`, so a long outage does not fill
 * the log with one line per interval. */
function recordFailure(
  state: SweepState,
  orgId: string,
  tier: SweepTier,
  now: number,
  random: () => number,
  err: unknown,
  action: string,
): void {
  const failures = (state.get(orgId)?.failures ?? 0) + 1;
  state.set(orgId, { failures, nextDueAt: now + backoffDelayMs(tier, failures, random) });
  const detail = err instanceof Error ? err.message : String(err);
  const message = `github installation sweep: could not ${action} org ${orgId} (${detail}). Open Settings, Organization, GitHub. Choose Refresh installations to see the error.`;
  if (failures === 1) {
    console.error(message);
  } else {
    console.debug(`${message} Failure ${failures}.`);
  }
}

/**
 * The orgs this tick may check, each with the freshness and tier that decide
 * whether it is due. Per-org failures are isolated here: a malformed
 * credential row makes `loadAppConfigWithSource` throw, and that org is
 * dropped from this tick rather than taking the whole tick down.
 */
async function collectCandidates(
  deps: InstallationSweepDeps,
  now: number,
  state: SweepState,
  random: () => number,
): Promise<SweepCandidate[]> {
  const [credentialOrgIds, freshness] = await Promise.all([
    listOrgsWithAppCredential(deps.db),
    readInstallationFreshness(deps.db),
  ]);

  const orgIds = new Set<string>([...credentialOrgIds, ...freshness.keys()]);
  if (orgIds.size === 0) {
    const envOrgId = await resolveEnvOnlyOrgId(deps);
    if (envOrgId) orgIds.add(envOrgId);
  }

  const candidates: SweepCandidate[] = [];
  for (const orgId of orgIds) {
    const entry = state.get(orgId);
    if (entry && entry.nextDueAt > now) continue;

    const lastCheckedAt = freshness.get(orgId) ?? null;
    // Cheapest filter first: an org checked inside the shortest interval
    // cannot be due, so it needs no credential read.
    if (lastCheckedAt !== null && now - lastCheckedAt < MIN_ROWS_DUE_MS) continue;

    let tier: SweepTier | null;
    try {
      tier = await resolveTier(deps, orgId, lastCheckedAt);
    } catch (err) {
      recordFailure(state, orgId, "webhook-absent", now, random, err, "read the App credential of");
      continue;
    }
    // No App config: the org has installation rows from an App that is gone.
    // There is nothing to discover, and deleting the rows is the removal
    // route's decision, not this sweep's. Park the org so it does not cost a
    // credential read on every tick from here on.
    if (!tier) {
      state.set(orgId, { failures: 0, nextDueAt: now + jitterMs(SWEEP_DUE_MS["webhook-absent"], random) });
      continue;
    }

    candidates.push({ orgId, lastCheckedAt, tier });
  }
  return candidates;
}

/** `null` when the org has no App at all. */
async function resolveTier(
  deps: InstallationSweepDeps,
  orgId: string,
  lastCheckedAt: number | null,
): Promise<SweepTier | null> {
  const loaded = await loadAppConfigWithSource(deps, orgId);
  if (!loaded) return null;
  if (lastCheckedAt === null) return "no-installations";
  // Both halves must hold: GitHub needs a URL it can reach, and an App with an
  // empty webhook secret signs nothing this instance would accept
  // (`verifyWebhookSignature` refuses an empty secret).
  const webhookLive = Boolean(deps.publicUrl) && loaded.config.webhookSecret !== "";
  return webhookLive ? "webhook-live" : "webhook-absent";
}

/** `MAX(github_installations.updatedAt)` per org. Read as rows and reduced in
 * JS rather than as a SQL aggregate: the table holds one row per installation
 * (a handful in any real deployment), and the drivers disagree on the type a
 * `max()` over a bigint column returns. */
async function readInstallationFreshness(db: AppQueryable): Promise<Map<string, number>> {
  const rows = await db
    .select({ orgId: githubInstallations.orgId, updatedAt: githubInstallations.updatedAt })
    .from(githubInstallations);
  const byOrg = new Map<string, number>();
  for (const row of rows) {
    const previous = byOrg.get(row.orgId);
    if (previous === undefined || row.updatedAt > previous) byOrg.set(row.orgId, row.updatedAt);
  }
  return byOrg;
}

/** The org an environment-supplied App belongs to when nothing else points at
 * one — the deployment's oldest org, matching `resolveEnvFallbackOrgId`.
 * `null` when there is no environment App or no org. A partial `GITHUB_APP_*`
 * config throws; the boot path already reports that loudly, so the sweep stays
 * quiet and simply has no candidate. */
async function resolveEnvOnlyOrgId(deps: InstallationSweepDeps): Promise<string | null> {
  let envConfig;
  try {
    envConfig = resolveGithubAppEnvConfig(deps.env ?? process.env);
  } catch {
    return null;
  }
  if (!envConfig) return null;
  const [oldest] = await deps.db.select({ id: orgs.id }).from(orgs).orderBy(orgs.createdAt).limit(1);
  return oldest?.id ?? null;
}
