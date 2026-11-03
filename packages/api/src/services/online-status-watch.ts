/**
 * The online-status watcher: the source of the `slack.user_online` event.
 *
 * Slack's Events API does not deliver `presence_change` (that needs RTM or
 * Socket Mode presence subscriptions), so this watcher polls
 * `users.getPresence` with the org's bot token for each person an enabled
 * line names, and ingests one event for each away to active change. The
 * event then runs through the normal pipeline (`events/ingest.ts`): line
 * matching, the per-line "once every N hours" limit, receipts, delivery.
 *
 * Bounds:
 * - Only people named by an enabled `slack.user_online` line are polled.
 *   The write validator refuses a line with no person (`subscription-write.ts`).
 * - At most `MAX_WATCHED_PER_ORG` people per org, polled at most once per
 *   `POLL_INTERVAL_MS` each, and at most `MAX_POLLS_PER_TICK` reads per tick.
 * - A failed read backs off exponentially up to `MAX_BACKOFF_MS`, or for as
 *   long as Slack's Retry-After asks.
 *
 * Debounce: an "active" read fires only after the person was seen away for
 * at least `MIN_AWAY_MS`. A short away blip, and the first read after boot
 * or after a line starts watching, set the baseline and fire nothing.
 *
 * Privacy: the state is in memory only, and holds the last presence and the
 * time the current away period started, per watched person. It keeps no
 * history, and it drops a person as soon as no enabled line names them. An
 * api restart loses the state, so a change that spans a restart is missed
 * rather than replayed.
 *
 * The api runs one process (the engine host keeps sessions in memory). The
 * event's dedupe key is the away period's start, so a repeated ingest of the
 * same change adds nothing.
 */
import { eq } from "drizzle-orm";
import { credentialSecret, type CredentialStore, type NormalizedEvent, type ValetPlugin } from "@valet/engine";
import { USER_ONLINE_EVENT_KEY, onlineEvent, readOnlineStatus } from "@valet/plugin-slack/actions";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions } from "../schema/index.js";
import { ingestEvent } from "../events/ingest.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";

export const POLL_INTERVAL_MS = 60_000;
export const TICK_MS = 15_000;
export const MIN_AWAY_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const MAX_WATCHED_PER_ORG = 25;
export const MAX_POLLS_PER_TICK = 40;

/** Errors that a retry soon cannot fix. The watcher waits the longest backoff. */
const PERMANENT_CODES = new Set([
  "missing_scope", "user_not_found", "user_not_visible", "other_workspace", "deleted_user",
  "not_authed", "invalid_auth", "account_inactive", "token_revoked", "missing_token",
]);

interface WatchState {
  presence?: "active" | "away";
  /** When the current away period started. Set only while away. */
  awaySince?: number;
  nextPollAt: number;
  failures: number;
  /** True after a full read confirmed the person is in the workspace. */
  verified: boolean;
}

export interface OnlineStatusWatchDeps {
  db: AppDb;
  plugins: ValetPlugin[];
  credentials: CredentialStore;
  onIngest?: () => void;
  now?: () => number;
  /** Tests replace the Slack read and the ingest. */
  readStatus?: typeof readOnlineStatus;
  ingest?: (orgId: string, event: NormalizedEvent) => Promise<void>;
}

/** The people each org's enabled lines watch, capped per org. Pure over rows. */
export function watchedUsers(rows: { orgId: string; eventKeys: unknown; filters: unknown; enabled: boolean }[]): Map<string, string[]> {
  const byOrg = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.enabled || !Array.isArray(row.eventKeys)) continue;
    const keys = row.eventKeys.filter((k): k is string => typeof k === "string");
    // The exact key only: a `slack.*` line with a `user` condition asked for
    // that person's messages, not for their online status to be polled.
    if (!keys.includes(USER_ONLINE_EVENT_KEY)) continue;
    const users = byOrg.get(row.orgId) ?? new Set<string>();
    for (const filter of Array.isArray(row.filters) ? row.filters : []) {
      if (typeof filter !== "object" || filter === null) continue;
      const f = filter as { field?: unknown; op?: unknown; value?: unknown };
      if (f.field !== "user") continue;
      if (f.op === "eq" && typeof f.value === "string") users.add(f.value);
      if (f.op === "in" && Array.isArray(f.value)) for (const v of f.value) if (typeof v === "string") users.add(v);
    }
    byOrg.set(row.orgId, users);
  }
  const out = new Map<string, string[]>();
  for (const [orgId, users] of byOrg) {
    const sorted = [...users].sort();
    if (sorted.length > MAX_WATCHED_PER_ORG) {
      console.warn(`[online-status] org ${orgId} watches ${sorted.length} people; only the first ${MAX_WATCHED_PER_ORG} are checked. Remove lines you do not need.`);
    }
    if (sorted.length > 0) out.set(orgId, sorted.slice(0, MAX_WATCHED_PER_ORG));
  }
  return out;
}

/** The delay before the next read after `failures` failed reads in a row. */
export function backoffMs(failures: number, retryAfterSeconds?: number, permanent = false): number {
  if (permanent) return MAX_BACKOFF_MS;
  const exponential = Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** Math.max(0, failures - 1));
  return Math.max(exponential, (retryAfterSeconds ?? 0) * 1000);
}

/**
 * Applies one presence read to a person's state. Returns the length of the
 * away period that just ended when the read is a change that fires, else null.
 */
export function applyPresence(state: WatchState, presence: "active" | "away", now: number): number | null {
  const previous = state.presence;
  state.presence = presence;
  if (presence === "away") {
    if (previous !== "away") state.awaySince = now;
    return null;
  }
  const awaySince = state.awaySince;
  state.awaySince = undefined;
  if (previous !== "away" || awaySince === undefined) return null;
  const away = now - awaySince;
  return away >= MIN_AWAY_MS ? away : null;
}

export class OnlineStatusWatcher {
  private readonly state = new Map<string, WatchState>();
  private timer: SweepTimer | null = null;

  constructor(private readonly deps: OnlineStatusWatchDeps) {}

  /** The people with state, as `org:user` keys. Tests read it. */
  watchedKeys(): string[] {
    return [...this.state.keys()];
  }

  async tick(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const rows = await this.deps.db
      .select({ orgId: eventSubscriptions.orgId, eventKeys: eventSubscriptions.eventKeys, filters: eventSubscriptions.filters, enabled: eventSubscriptions.enabled })
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.enabled, true));
    const watched = watchedUsers(rows);

    const live = new Set<string>();
    for (const [orgId, users] of watched) for (const user of users) live.add(`${orgId}:${user}`);
    for (const key of this.state.keys()) if (!live.has(key)) this.state.delete(key);

    let budget = MAX_POLLS_PER_TICK;
    for (const [orgId, users] of watched) {
      if (budget <= 0) break;
      const due = users.filter((user) => (this.state.get(`${orgId}:${user}`)?.nextPollAt ?? 0) <= now);
      if (due.length === 0) continue;
      const credential = await this.deps.credentials.get({ type: "org", id: orgId }, "slack");
      const token = credential ? credentialSecret(credential) : undefined;
      const teamId = typeof credential?.metadata?.teamId === "string" ? credential.metadata.teamId : undefined;
      for (const user of due) {
        if (budget <= 0) break;
        budget -= 1;
        await this.pollOne(orgId, user, token ?? "", teamId, now);
      }
    }
  }

  private async pollOne(orgId: string, user: string, token: string, teamId: string | undefined, now: number): Promise<void> {
    const key = `${orgId}:${user}`;
    const state = this.state.get(key) ?? { nextPollAt: 0, failures: 0, verified: false };
    this.state.set(key, state);
    const read = this.deps.readStatus ?? readOnlineStatus;
    const result = await read(token, user, { ...(teamId ? { teamId } : {}), profile: !state.verified });
    if (!result.ok) {
      state.failures += 1;
      const permanent = PERMANENT_CODES.has(result.code);
      state.nextPollAt = now + backoffMs(state.failures, result.retryAfterSeconds, permanent);
      if (state.failures === 1 || permanent) console.warn(`[online-status] org ${orgId} user ${user}: ${result.error}`);
      return;
    }
    state.failures = 0;
    state.verified = true;
    state.nextPollAt = now + POLL_INTERVAL_MS;
    const awaySince = state.awaySince;
    const away = applyPresence(state, result.status.presence, now);
    if (away === null || awaySince === undefined) return;
    const event = onlineEvent({
      user, ...(teamId ? { teamId } : {}), awayMs: away, observedAt: now,
      dedupeKey: `user_online:${teamId ?? orgId}:${user}:${awaySince}`,
      status: result.status,
    });
    try {
      if (this.deps.ingest) await this.deps.ingest(orgId, event);
      else await ingestEvent({ db: this.deps.db, plugins: this.deps.plugins, ...(this.deps.onIngest ? { onIngest: this.deps.onIngest } : {}) }, { orgId, service: "slack", event });
    } catch (error) {
      console.error(`[online-status] org ${orgId} user ${user}: ingest failed`, error);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = startSweepTimer("OnlineStatusWatcher", TICK_MS, () => this.tick());
  }

  async stop(): Promise<void> {
    const timer = this.timer;
    this.timer = null;
    await timer?.stop();
  }
}
