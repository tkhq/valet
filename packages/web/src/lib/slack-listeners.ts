/**
 * Which Slack channels already have a Valet listening for mentions. The team
 * channel picker shows these, so a team cannot add a second listener to a
 * channel another Valet already answers in. The server refuses that write
 * too (event subscription collisions); this shows it before anyone tries.
 */
import type { EventSubscriptionWire } from "@valet/api/wire";
import { selectsSlackMention } from "./slack-mention";

export type ChannelListener =
  | { kind: "this-team" }
  | { kind: "other"; owner: string };

/** `ALL_CHANNELS` marks a rule with no channel filter: it listens everywhere. */
export const ALL_CHANNELS = "*";

/**
 * Maps channel id → who listens there, from the enabled mention rules the
 * caller can see. `teamName` resolves another team's display name.
 */
export function slackChannelListeners(
  subscriptions: readonly EventSubscriptionWire[],
  teamId: string,
  teamName: (id: string) => string | undefined,
): Map<string, ChannelListener> {
  const listeners = new Map<string, ChannelListener>();
  for (const rule of subscriptions) {
    if (!rule.enabled || !selectsSlackMention(rule.eventKeys) || rule.target.kind !== "orchestrator") continue;
    const ownTeam = rule.ownerType === "team" && rule.ownerId === teamId;
    const listener: ChannelListener = ownTeam ? { kind: "this-team" }
      : { kind: "other", owner: rule.ownerType === "team" ? `${teamName(rule.ownerId) ?? "Another team"}'s Valet` : "A personal Valet" };
    const channels = rule.filters.filter((filter) => filter.field === "channel")
      .flatMap((filter) => (Array.isArray(filter.value) ? filter.value : [filter.value]));
    for (const channel of channels.length > 0 ? channels : [ALL_CHANNELS]) {
      // This team's own listener wins the label: it is the one it can edit.
      if (!listeners.has(channel) || listener.kind === "this-team") listeners.set(channel, listener);
    }
  }
  return listeners;
}

/** Who listens in one channel, counting a listener on every channel. */
export function listenerFor(listeners: Map<string, ChannelListener>, channel: string): ChannelListener | undefined {
  return listeners.get(channel) ?? listeners.get(ALL_CHANNELS);
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
} {
  const own = subscriptions.filter((rule) => rule.enabled && selectsSlackMention(rule.eventKeys)
    && rule.target.kind === "orchestrator" && rule.ownerType === "team" && rule.ownerId === teamId);
  const channelsOf = (rule: EventSubscriptionWire): ListeningChannel[] => rule.filters
    .filter((filter) => filter.field === "channel")
    .flatMap((filter) => {
      const ids = Array.isArray(filter.value) ? filter.value : [filter.value];
      const labels = Array.isArray(filter.labels) ? filter.labels : filter.label ? [filter.label] : [];
      return ids.map((id, index) => ({ id, label: labels[index] ?? id }));
    });
  const editable = own.find((rule) => rule.filters.length > 0 && rule.filters.every((filter) => filter.field === "channel"));
  const seen = new Map<string, ListeningChannel>();
  for (const rule of own) for (const channel of channelsOf(rule)) if (!seen.has(channel.id)) seen.set(channel.id, channel);
  return {
    ...(editable ? { editable } : {}),
    editableChannels: editable ? channelsOf(editable) : [],
    channels: [...seen.values()],
    everywhere: own.some((rule) => !rule.filters.some((filter) => filter.field === "channel")),
  };
}
