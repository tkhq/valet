/**
 * Thread origin bucketing for the chat sidebar (V2 counterpart of
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
  { id: "all", label: "All threads" },
  { id: "chat", label: "Web chat" },
  { id: "channel", label: "Slack and other channels" },
  { id: "auto", label: "Automations" },
  { id: "other", label: "Other agents" },
];

const CHANNEL_KEY_PREFIXES = ["telegram:", "slack:", "discord:", "email:", "sms:"];

export function threadOriginBucket(thread: Pick<ThreadSummary, "key">): Exclude<ThreadOriginBucket, "all"> {
  const key = thread.key;
  if (!key || key === "default" || key.startsWith("web:")) return "chat";
  if (key === "events" || key.startsWith("signal:workflow:")) return "auto";
  if (CHANNEL_KEY_PREFIXES.some((p) => key.startsWith(p))) return "channel";
  return "other";
}

/** The channel a channel-owned thread lives in (`slack`, `telegram`, …),
 * read from its key prefix. Undefined for every other origin. */
export function threadChannelType(thread: Pick<ThreadSummary, "key">): string | undefined {
  const key = thread.key;
  if (!key) return undefined;
  const prefix = CHANNEL_KEY_PREFIXES.find((p) => key.startsWith(p));
  return prefix?.slice(0, -1);
}

/** Per-bucket totals over the loaded threads (client-side; the V2
 * orchestrator's thread count is small enough to load in full). */
export function bucketCounts(threads: readonly Pick<ThreadSummary, "key">[]): Record<ThreadOriginBucket, number> {
  const counts: Record<ThreadOriginBucket, number> = { all: threads.length, chat: 0, auto: 0, channel: 0, other: 0 };
  for (const t of threads) counts[threadOriginBucket(t)] += 1;
  return counts;
}
