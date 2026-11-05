import { createHash } from 'node:crypto';
import { slackGet, slackGetOnce } from './api.js';

/**
 * Bounded cache of Slack conversation names, held per credential.
 *
 * Slack reads take a channel ID, so a result that repeats the ID tells the
 * agent nothing it did not send. A name comes from `conversations.info` and
 * from nowhere else. A channel mention in message text carries a label, but
 * Slack keeps a label as the author wrote it at post time, and a sender can
 * put any text there. A label is therefore not a name, and it never reaches
 * this cache.
 *
 * Three callers fill the cache:
 *
 * - The private-channel guard. It reads `conversations.info` for every
 *   guarded action, so the name of the channel that is read costs no extra
 *   request. The guard runs on each read, so a channel rename reaches the
 *   cache on the next read.
 * - Channel mentions in message text. A mention can point at a channel that
 *   no guard checked, so `resolveChannelName` reads `conversations.info`
 *   when the cache has no entry.
 * - Event intake. A message event carries the channel ID only, and a
 *   `channel_name` subscription filter needs the name (`event-channel-name.ts`).
 *   A `channel_rename` or `channel_created` event records the new name.
 *
 * An entry answers for `CHANNEL_NAME_MAX_AGE_MS`. After that, the next read
 * asks Slack again. This bounds how long a rename that no event reported,
 * for example on another api process, keeps the old name.
 *
 * Each key holds a fingerprint of the token that read the name. One API
 * process serves more than one Slack workspace, and a name that one token
 * can read must not label a channel for a token that cannot read it.
 *
 * The cache holds a fixed number of entries and drops the oldest entry
 * first. A name is small and a workspace has a limited number of channels,
 * so the bound is a backstop against unbounded growth, not an expected
 * limit. Event intake reads every channel with traffic, so the bound is
 * larger than one page of reads needs.
 */

/** Conversations held at once. */
const MAX_ENTRIES = 1024;

/** How long a cached name answers before the next read asks Slack again. */
export const CHANNEL_NAME_MAX_AGE_MS = 5 * 60_000;

/**
 * Cache key to name, the time it was read, and its write number. A `null`
 * name records a conversation that Slack gives no name, such as a direct
 * message. It keeps `resolveChannelName` from a repeated lookup that cannot
 * return a name.
 */
const names = new Map<string, { name: string | null; at: number; write: number }>();

/** Counts cache writes, so a lookup can tell that a newer name arrived while it waited. */
let writes = 0;

/**
 * Lookups in progress, keyed by channel and request policy, so a burst of
 * events in one channel sends one request. A read never joins a lookup with
 * another policy: an event intake read with a timeout must not wait on an
 * action read that retries after a 429.
 */
const pending = new Map<string, Promise<string | undefined>>();

/**
 * The cache key for one channel as one credential sees it. The key holds a
 * one-way fingerprint of the token, so the cache keeps no token.
 */
function cacheKey(token: string, channelId: string): string {
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 32);
  return `${fingerprint}:${channelId}`;
}

/** Record a name that a `conversations.info` response gave for this token. */
export function rememberChannelName(token: string, channelId: string, name: string | null): void {
  const key = cacheKey(token, channelId);
  // Delete first so a re-record moves the entry to the newest position.
  names.delete(key);
  if (names.size >= MAX_ENTRIES) {
    const oldest = names.keys().next().value;
    if (oldest !== undefined) names.delete(oldest);
  }
  names.set(key, { name, at: Date.now(), write: ++writes });
}

/** The entry for a key while it is younger than `CHANNEL_NAME_MAX_AGE_MS`. */
function freshEntry(key: string): { name: string | null } | undefined {
  const entry = names.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.at < CHANNEL_NAME_MAX_AGE_MS) return entry;
  names.delete(key);
  return undefined;
}

/** The cached name, or undefined when this token has no current cached name for the ID. */
export function cachedChannelName(token: string, channelId: string): string | undefined {
  return freshEntry(cacheKey(token, channelId))?.name ?? undefined;
}

/**
 * The name of a channel, from the cache or from `conversations.info`.
 *
 * Returns undefined when Slack has no name for the conversation, and when
 * the lookup fails. A caller must keep its result usable without the name:
 * a channel read is still correct when Valet cannot label it. A failed
 * lookup is not cached, so the next read can retry it.
 *
 * With `timeoutMs`, the lookup sends one request with no retry and aborts
 * after that time. Event intake uses it, because a rate-limited lookup must
 * not hold up the events behind it.
 */
export async function resolveChannelName(
  token: string,
  channelId: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const key = cacheKey(token, channelId);
  const hit = freshEntry(key);
  if (hit !== undefined) return hit.name ?? undefined;
  const pendingKey = `${key}:${opts.timeoutMs ?? 'retry'}`;
  const inFlight = pending.get(pendingKey);
  if (inFlight) return inFlight;

  const startedAfter = writes;
  const lookup = (async () => {
    try {
      const res = opts.timeoutMs === undefined
        ? await slackGet('conversations.info', token, { channel: channelId })
        : await slackGetOnce('conversations.info', token, { channel: channelId }, opts.timeoutMs);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { ok: boolean; channel?: { name?: unknown } };
      if (!data.ok || !data.channel) return undefined;
      // A name written while this request waited, such as a rename event, is
      // newer than this response. Keep it.
      const newer = names.get(key);
      if (newer !== undefined && newer.write > startedAfter) return newer.name ?? undefined;
      const name = typeof data.channel.name === 'string' ? data.channel.name : null;
      rememberChannelName(token, channelId, name);
      return name ?? undefined;
    } catch {
      return undefined;
    } finally {
      pending.delete(pendingKey);
    }
  })();
  pending.set(pendingKey, lookup);
  return lookup;
}

/** Drop every entry. Tests call this between cases. */
export function clearChannelNameCache(): void {
  names.clear();
  pending.clear();
}
