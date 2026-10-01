/**
 * The Channels tab: every Slack channel and pull request this workspace talks
 * or listens in. A row opens the channel page, where listeners, conversations,
 * and messages link both ways between Valet and the provider.
 */
import { Link } from "@tanstack/react-router";
import type { ChannelSummary } from "@valet/api/wire";
import { useWorkspaceChannels } from "~/api/channels";
import { Badge, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkList } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { ChannelIcon, ProviderLink } from "./channel-parts";

export function ChannelsPanel() {
  const owner = useListOwner();
  const channels = useWorkspaceChannels(owner);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        A channel is a Slack channel or a pull request that Valet reads and writes. Open one to see who listens there, and the threads and messages on both sides.
      </p>
      {channels.isPending && <LoadingRow label="Loading channels…" />}
      {channels.error && <ErrorRow>Could not load channels. Reload the page to try again.</ErrorRow>}
      {channels.data && channels.data.channels.length === 0 && (
        <EmptyRow>No channels yet. Mention Valet in Slack, set a team to listen in a channel, or ask Valet to open a pull request.</EmptyRow>
      )}
      {channels.data && channels.data.channels.length > 0 && (
        <WorkList>
          {channels.data.channels.map((channel) => <ChannelRow key={channel.key} channel={channel} />)}
        </WorkList>
      )}
    </div>
  );
}

export function ChannelRow({ channel }: { channel: ChannelSummary }) {
  const own = channel.listeners.filter((listener) => listener.editable);
  const others = channel.listeners.filter((listener) => !listener.editable);
  const listening = own.length > 0;
  const detail = [
    listening ? "This workspace listens here" : channel.provider === "slack" ? "Replies only when mentioned" : null,
    others.length > 0 ? `Also: ${[...new Set(others.map((listener) => listener.ownerName))].join(", ")}` : null,
    `${channel.conversationCount} ${channel.conversationCount === 1 ? "thread" : "threads"}`,
    channel.messageCount > 0 ? `${channel.messageCount} ${channel.messageCount === 1 ? "message" : "messages"}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <WorkRow
      title={
        <Link to="/channel" search={{ key: channel.key }} className="flex min-w-0 items-center gap-2">
          <ChannelIcon provider={channel.provider} />
          <span className="min-w-0 truncate">{channel.name}</span>
        </Link>
      }
      badge={channel.state
        ? <Badge variant={channel.state === "open" ? "success" : "neutral"}>{channel.state === "open" ? "Open" : channel.state === "merged" ? "Merged" : "Closed"}</Badge>
        : listening ? <Badge variant="accent">Listening</Badge> : undefined}
      {...(channel.lastActivityAt !== null ? { time: channel.lastActivityAt } : {})}
      detail={detail}
      actions={channel.url ? <ProviderLink provider={channel.provider} href={channel.url} /> : undefined}
    />
  );
}
