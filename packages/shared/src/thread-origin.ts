/**
 * Where a thread came from, read from its engine thread key:
 *
 *   web:{nonce}, default, no key        → chat    (the web UI)
 *   events, signal:workflow:{runId}      → auto    (workflow nodes, old event threads)
 *   sub:{line}…, schedule:{line}…        → auto    (Presence line deliveries)
 *   subject:{subject}                    → auto    (a line's subject thread)
 *   telegram:*, slack:*, …               → channel (channel conversations)
 *   signal:{senderId}, anything else     → other   (another agent)
 */
export type ThreadOrigin = "chat" | "auto" | "channel" | "other";

export const CHANNEL_THREAD_KEY_PREFIXES = ["telegram:", "slack:", "discord:", "email:", "sms:"] as const;
const AUTO_THREAD_KEY_PREFIXES = ["signal:workflow:", "sub:", "schedule:", "subject:"] as const;

export function threadOrigin(key: string | undefined): ThreadOrigin {
  if (!key || key === "default" || key.startsWith("web:")) return "chat";
  if (key === "events" || AUTO_THREAD_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return "auto";
  if (CHANNEL_THREAD_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return "channel";
  return "other";
}

/**
 * The sidebar group of a thread that a Presence line opened in `new` mode:
 * `sub:<line>` for `sub:<line>:<conversation or delivery>`, and
 * `schedule:<line>` for `schedule:<line>:<fire time>`. A line's own thread
 * (`sub:<line>`) and every other key have no group.
 */
export function threadLineGroupKey(key: string | undefined): string | undefined {
  const match = key?.match(/^(sub|schedule):([^:]+):./);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

/** The line a group key names: its kind and id. */
export function parseThreadLineGroupKey(groupKey: string): { kind: "subscription" | "schedule"; id: string } | undefined {
  const match = groupKey.match(/^(sub|schedule):([^:]+)$/);
  if (!match) return undefined;
  return { kind: match[1] === "sub" ? "subscription" : "schedule", id: match[2]! };
}
