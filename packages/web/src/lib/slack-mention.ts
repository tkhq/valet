/**
 * Client-side mirror of the server's mention-scope predicates
 * (packages/api/src/events/mention-scope.ts, TKAI-299). One home, so the
 * subscriptions list, the trigger dialog, and the wizard cannot drift from
 * each other on what counts as a mention rule or as channel scope.
 */

export const SLACK_APP_MENTION = "slack.app_mention";

/** Whether the eventKeys patterns select `slack.app_mention` — the exact key
 * or a trailing wildcard, mirroring the server's `eventKeyMatches`. */
export function selectsSlackMention(eventKeys: string[]): boolean {
  return eventKeys.some(
    (k) => k === SLACK_APP_MENTION || (k.endsWith(".*") && SLACK_APP_MENTION.startsWith(k.slice(0, -1))),
  );
}

/** Whether the filters constrain the channel to a non-empty fixed set —
 * field `channel` with op `eq`, or op `in` with at least one value. Accepts
 * the loose `unknown[]` the wire hands back. */
export function hasChannelScopeFilter(filters: unknown[]): boolean {
  return filters.some((f) => {
    if (typeof f !== "object" || f === null) return false;
    // Narrows the wire's unknown filter entry; shape is owned by the server's
    // subscription validator, the only writer of these rows.
    const r = f as Record<string, unknown>;
    if (r.field !== "channel") return false;
    if (r.op === "eq") return true;
    return r.op === "in" && Array.isArray(r.value) && r.value.length > 0;
  });
}
