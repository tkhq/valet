/**
 * The thread header's link to its channel: the channel name opens the channel
 * page in Valet, and the arrow opens this thread's conversation in the provider.
 */
import { Link } from "@tanstack/react-router";
import type { ThreadChannel } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { useWorkspaceChannels } from "~/api/channels";
import { usePlaceSubject } from "~/api/presence";
import { ChannelIcon, ProviderLink } from "./channel-parts";

export function ThreadChannelChip({ channel, owner }: { channel: ThreadChannel; owner?: OwnerFilter }) {
  const channels = useWorkspaceChannels(owner);
  const subject = usePlaceSubject(channel.key);
  const name = channels.data?.channels.find((candidate) => candidate.key === channel.key)?.name
    ?? (channel.provider === "slack" ? "Slack channel" : channel.key.replace(/^github:/, ""));
  return (
    <span className="hidden min-w-0 max-w-48 items-center gap-2 text-xs sm:flex lg:max-w-72">
      <Link to="/presence/places/$subject" params={{ subject }} title="Open this channel in Valet"
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-muted hover:bg-ink-wash hover:text-ink">
        <ChannelIcon provider={channel.provider} className="h-3.5 w-3.5" />
        <span className="truncate">{name}</span>
      </Link>
      {channel.conversationUrl && <ProviderLink provider={channel.provider} href={channel.conversationUrl} className="hidden sm:inline-flex" />}
    </span>
  );
}
