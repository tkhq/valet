import { createHash } from 'node:crypto';
import { slackGet } from './api.js';

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
 * Two callers fill the cache:
 *
 * - The private-channel guard. It reads `conversations.info` for every
 *   guarded action, so the name of the channel that is read costs no extra
 *   request. The guard runs on each read, so a channel rename reaches the
 *   cache on the next read.
 * - Channel mentions in message text. A mention can point at a channel that
 *   no guard checked, so `resolveChannelName` reads `conversations.info`
 *   when the cache has no entry.
 *
 * Each key holds a fingerprint of the token that read the name. One API
 * process serves more than one Slack workspace, and a name that one token
 * can read must not label a channel for a token that cannot read it.
 *
 * The cache holds a fixed number of entries and drops the oldest entry
 * first. A name is small and a workspace has a limited number of channels,
 * so the bound is a backstop against unbounded growth, not an expected
 * limit.
 */

/** Conversations held at once. */
const MAX_ENTRIES = 256;

/**
 * Cache key to name. A `null` value records a conversation that Slack gives
 * no name, such as a direct message. It keeps `resolveChannelName` from a
 * repeated lookup that cannot return a name.
 */
const names = new Map<string, string | null>();

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
  names.set(key, name);
}

/** The cached name, or undefined when this token has no cached name for the ID. */
export function cachedChannelName(token: string, channelId: string): string | undefined {
  return names.get(cacheKey(token, channelId)) ?? undefined;
}

/**
 * The name of a channel, from the cache or from `conversations.info`.
 *
 * Returns undefined when Slack has no name for the conversation, and when
 * the lookup fails. A caller must keep its result usable without the name:
 * a channel read is still correct when Valet cannot label it. A failed
 * lookup is not cached, so the next read can retry it.
 */
export async function resolveChannelName(
  token: string,
  channelId: string,
): Promise<string | undefined> {
  const hit = names.get(cacheKey(token, channelId));
  if (hit !== undefined) return hit ?? undefined;

  try {
    const res = await slackGet('conversations.info', token, { channel: channelId });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { ok: boolean; channel?: { name?: unknown } };
    if (!data.ok || !data.channel) return undefined;
    const name = typeof data.channel.name === 'string' ? data.channel.name : null;
    rememberChannelName(token, channelId, name);
    return name ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drop every entry. Tests call this between cases. */
export function clearChannelNameCache(): void {
  names.clear();
}
