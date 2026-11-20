/**
 * Thread origin bucketing for the chat sidebar. The origin comes from the
 * engine thread key (`threadOrigin` in @valet/shared, which the server's
 * thread list also uses).
 */
import type { ThreadSummary } from "@valet/api/wire";
import { CHANNEL_THREAD_KEY_PREFIXES, threadOrigin } from "@valet/shared";

export type ThreadOriginBucket = "all" | "chat" | "auto" | "channel" | "other";

export const THREAD_ORIGIN_FILTERS: readonly { id: ThreadOriginBucket; label: string }[] = [
  { id: "all", label: "All threads" },
  { id: "chat", label: "Web chat" },
  { id: "channel", label: "Slack and other channels" },
  { id: "auto", label: "Automations" },
  { id: "other", label: "Other agents" },
];

export function threadOriginBucket(thread: Pick<ThreadSummary, "key">): Exclude<ThreadOriginBucket, "all"> {
  return threadOrigin(thread.key);
}

/** The channel a channel-owned thread lives in (`slack`, `telegram`, …),
 * read from its key prefix. Undefined for every other origin. */
export function threadChannelType(thread: Pick<ThreadSummary, "key">): string | undefined {
  const key = thread.key;
  if (!key) return undefined;
  const prefix = CHANNEL_THREAD_KEY_PREFIXES.find((p) => key.startsWith(p));
  return prefix?.slice(0, -1);
}

/** Per-bucket totals over the loaded threads (client-side; the V2
 * orchestrator's thread count is small enough to load in full). */
export function bucketCounts(threads: readonly Pick<ThreadSummary, "key">[]): Record<ThreadOriginBucket, number> {
  const counts: Record<ThreadOriginBucket, number> = { all: threads.length, chat: 0, auto: 0, channel: 0, other: 0 };
  for (const t of threads) counts[threadOriginBucket(t)] += 1;
  return counts;
}
