/**
 * Thread origin bucketing + search for the chat sidebar (V2 counterpart of
 * V1's `thread-origin-buckets.ts`). V2 encodes origin in the engine thread
 * KEY convention rather than persisted origin_* columns:
 *
 *   web:{nonce}              → chat    (created from the web UI)
 *   default / web:default    → chat    (the session's default thread)
 *   events                   → auto    (event-subscription + schedule deliveries)
 *   signal:workflow:{runId}  → auto    (workflow orchestrator/llm nodes)
 *   telegram:* / slack:* …   → channel (channel-transport conversations)
 *   signal:{senderId} / rest → other   (cross-orchestrator, unknown)
 *
 * Threads with NO key (older API responses) fall back to `chat` — the
 * conservative bucket, since the UI's own threads dominated before
 * automation existed.
 */
import type { ThreadSummary } from "@valet/api/wire";

export type ThreadOriginBucket = "all" | "chat" | "auto" | "channel" | "other";

export const THREAD_ORIGIN_FILTERS: readonly { id: ThreadOriginBucket; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chat" },
  { id: "auto", label: "Auto" },
  { id: "channel", label: "Channels" },
  { id: "other", label: "Other" },
];

const CHANNEL_KEY_PREFIXES = ["telegram:", "slack:", "discord:", "email:", "sms:"];

export function threadOriginBucket(thread: Pick<ThreadSummary, "key">): Exclude<ThreadOriginBucket, "all"> {
  const key = thread.key;
  if (!key || key === "default" || key.startsWith("web:")) return "chat";
  if (key === "events" || key.startsWith("signal:workflow:")) return "auto";
  if (CHANNEL_KEY_PREFIXES.some((p) => key.startsWith(p))) return "channel";
  return "other";
}

/** Per-bucket totals over the loaded threads (client-side; the V2
 * orchestrator's thread count is small enough to load in full). */
export function bucketCounts(threads: readonly Pick<ThreadSummary, "key">[]): Record<ThreadOriginBucket, number> {
  const counts: Record<ThreadOriginBucket, number> = { all: threads.length, chat: 0, auto: 0, channel: 0, other: 0 };
  for (const t of threads) counts[threadOriginBucket(t)] += 1;
  return counts;
}

/** Case-insensitive substring match over title, key, and id. */
export function threadMatchesSearch(
  thread: Pick<ThreadSummary, "id" | "title" | "key">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (thread.title ?? "").toLowerCase().includes(q) ||
    (thread.key ?? "").toLowerCase().includes(q) ||
    thread.id.toLowerCase().includes(q)
  );
}

/** The sidebar's combined filter: bucket + search, order-preserving. */
export function filterThreads<T extends Pick<ThreadSummary, "id" | "title" | "key">>(
  threads: readonly T[],
  bucket: ThreadOriginBucket,
  query: string,
): T[] {
  return threads.filter(
    (t) => (bucket === "all" || threadOriginBucket(t) === bucket) && threadMatchesSearch(t, query),
  );
}
