/** Exact keys or trailing `.*` patterns. The prefix includes the dot boundary. */
export function eventKeyMatches(eventKey: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => pattern === eventKey
    || (pattern.endsWith(".*") && eventKey.startsWith(pattern.slice(0, -1))));
}

export const SLACK_APP_MENTION = "slack.app_mention";

export function selectsSlackMention(eventKeys: readonly string[]): boolean {
  return eventKeyMatches(SLACK_APP_MENTION, eventKeys);
}

/** Fixed channel scope. Subscription validation checks the equality value separately. */
export function hasChannelScopeFilter(filters: readonly unknown[]): boolean {
  return filters.some(filter => {
    if (typeof filter !== "object" || filter === null
      || !("field" in filter) || filter.field !== "channel" || !("op" in filter)) return false;
    return filter.op === "eq" || (filter.op === "in" && "value" in filter
      && Array.isArray(filter.value) && filter.value.length > 0);
  });
}

/** Any-channel consent is represented by the absence of fixed channel filters. */
export function storedAnyChannel(eventKeys: readonly string[], filters: readonly unknown[]): boolean {
  return selectsSlackMention(eventKeys) && !hasChannelScopeFilter(filters);
}
