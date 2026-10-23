/**
 * Which Slack channels already have a Valet listening for mentions. The team
 * channel picker shows these, so a team cannot add a second listener to a
 * channel another Valet already answers in. The server refuses that write
 * too (event subscription collisions); this shows it before anyone tries.
 */
import type { EventSubscriptionWire } from "@valet/api/wire";
import { selectsSlackMention } from "./slack-mention";

export type ChannelListener = (
  | { kind: "this-team" }
  | { kind: "other"; owner: string }
) & { conditional?: true };

/**
 * Mirrors api/src/events/match.ts, which is not a browser package export.
 * Keep its write-time regex policy and 2,000-character match bound here.
 */
function channelFilterMatches(filter: EventSubscriptionWire["filters"][number], actual: string | undefined): boolean {
  const { op, value } = filter;
  let regex: RegExp | undefined;
  if (op === "regex" || op === "not_regex") {
    if (typeof value !== "string" || value.length > 200 || /\([^()]*[*+][^()]*\)[*+]/.test(value)) return false;
    try { regex = new RegExp(value); } catch { return false; }
  }
  if (actual === undefined) return op === "not_in" || op === "not_prefix" || op === "not_regex";
  switch (op) {
    case "eq": return actual === value;
    case "in": return Array.isArray(value) && value.includes(actual);
    case "not_in": return Array.isArray(value) && !value.includes(actual);
    case "prefix": return typeof value === "string" && actual.startsWith(value);
    case "not_prefix": return typeof value === "string" && !actual.startsWith(value);
    case "contains": return typeof value === "string" && actual.includes(value);
    case "regex":
    case "not_regex": return regex !== undefined && regex.test(actual.slice(0, 2_000)) === (op === "regex");
    default: return false;
  }
}

/** Only channel regex conditions need isolated evaluation. Other fields remain potential coverage. */
export function hasSlackListenerRegex(subscriptions: readonly EventSubscriptionWire[]): boolean {
  return subscriptions.some((rule) => rule.enabled && selectsSlackMention(rule.eventKeys) && rule.target.kind === "assistant"
    && rule.filters.some((filter) => (filter.field === "channel" || filter.field === "channel_name")
      && (filter.op === "regex" || filter.op === "not_regex")));
}

/** Only an exact match names channels; a prefix or pattern reaches channels no id list shows. */
function isChannelIdFilter(filter: EventSubscriptionWire["filters"][number]): boolean {
  return filter.field === "channel" && (filter.op === "eq" || filter.op === "in");
}

/** `ALL_CHANNELS` marks potential coverage with no channel restrictions. */
export const ALL_CHANNELS = "*";

/**
 * Maps channel id → who listens there, from the enabled mention rules the
 * caller can see. `teamName` resolves another team's display name.
 * UI callers use useSlackChannelListeners to isolate regex execution.
 */
export function slackChannelListeners(
  subscriptions: readonly EventSubscriptionWire[],
  teamId: string,
  teamName: (id: string) => string | undefined,
  catalog: readonly { id: string; name?: string }[] = [],
): Map<string, ChannelListener> {
  const listeners = new Map<string, ChannelListener>();
  for (const rule of subscriptions) {
    if (!rule.enabled || !selectsSlackMention(rule.eventKeys) || rule.target.kind !== "assistant") continue;
    const ownTeam = rule.ownerType === "team" && rule.ownerId === teamId;
    const listener: ChannelListener = ownTeam ? { kind: "this-team" }
      : { kind: "other", owner: rule.ownerType === "team" ? `${teamName(rule.ownerId) ?? "Another team"}'s Valet` : "A personal Valet" };
    const channelFilters = rule.filters.filter((filter) => filter.field === "channel" || filter.field === "channel_name");
    // Other conditions can still match a future mention. Reserve the channel,
    // but do not describe that potential coverage as unconditional listening.
    if (channelFilters.length !== rule.filters.length) listener.conditional = true;
    const candidates = new Map(catalog.map((channel) => [channel.id, channel]));
    // Exact IDs remain useful before the catalog loads. Stored labels are not
    // current channel names, so never use them to evaluate name conditions.
    for (const filter of channelFilters.filter(isChannelIdFilter)) {
      for (const id of Array.isArray(filter.value) ? filter.value : [filter.value]) {
        if (!candidates.has(id)) candidates.set(id, { id });
      }
    }
    const channels = channelFilters.length === 0 ? [ALL_CHANNELS] : [...candidates.values()]
      .filter((channel) => channelFilters.every((filter) =>
        channelFilterMatches(filter, filter.field === "channel" ? channel.id : channel.name)))
      .map((channel) => channel.id);
    for (const channel of channels) {
      // This team's own listener wins the label: it is the one it can edit.
      if (!listeners.has(channel) || listener.kind === "this-team") listeners.set(channel, listener);
    }
  }
  return listeners;
}

/** Who listens in one channel, counting a listener on every channel. */
export function listenerFor(listeners: Map<string, ChannelListener>, channel: string): ChannelListener | undefined {
  const specific = listeners.get(channel);
  const everywhere = listeners.get(ALL_CHANNELS);
  // Own-team precedence applies across both entries, not just within one key.
  if (specific?.kind === "this-team") return specific;
  if (everywhere?.kind === "this-team") return everywhere;
  return specific ?? everywhere;
}

/** A channel this team listens in, with the name the rule stored for it. */
export interface ListeningChannel { id: string; label: string }

/**
 * This team's Slack listening: the one rule the channel picker edits, and
 * every channel the team listens in. The editable rule is an enabled mention
 * rule whose only filter is the channel. A rule with other filters, or with
 * no channel filter, came from advanced setup: its channels stay listed but
 * the picker leaves them alone.
 */
export function teamListening(subscriptions: readonly EventSubscriptionWire[], teamId: string): {
  editable?: EventSubscriptionWire;
  editableChannels: ListeningChannel[];
  channels: ListeningChannel[];
  everywhere: boolean;
  patterns: EventSubscriptionWire[];
} {
  const own = subscriptions.filter((rule) => rule.enabled && selectsSlackMention(rule.eventKeys)
    && rule.target.kind === "assistant" && rule.ownerType === "team" && rule.ownerId === teamId);
  const channelsOf = (rule: EventSubscriptionWire): ListeningChannel[] => rule.filters
    .filter(isChannelIdFilter)
    .flatMap((filter) => {
      const ids = Array.isArray(filter.value) ? filter.value : [filter.value];
      const labels = Array.isArray(filter.labels) ? filter.labels : filter.label ? [filter.label] : [];
      return ids.map((id, index) => ({ id, label: labels[index] ?? id }));
    });
  const editable = own.find((rule) => rule.filters.length === 1 && rule.filters.every(isChannelIdFilter));
  const seen = new Map<string, ListeningChannel>();
  for (const rule of own) for (const channel of channelsOf(rule)) if (!seen.has(channel.id)) seen.set(channel.id, channel);
  return {
    ...(editable ? { editable } : {}),
    editableChannels: editable ? channelsOf(editable) : [],
    channels: [...seen.values()],
    everywhere: own.some((rule) => rule.filters.length === 0),
    patterns: own.filter((rule) => rule.filters.some((filter) => filter.field === "channel_name" || (filter.field === "channel" && !isChannelIdFilter(filter)))),
  };
}
