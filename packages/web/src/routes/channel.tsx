import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Ear } from "lucide-react";
import type { ChannelDetailResponse, ChannelListener, ChannelMessage, EventSubscriptionWire } from "@valet/api/wire";
import { useWorkspaceChannel } from "~/api/channels";
import { useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import { Badge, Button, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkSection, textLinkClass, cardClass, pageClass } from "~/components/primitives";
import { ChannelIcon, ProviderLink } from "~/components/channels/channel-parts";
import { EditSubscriptionDialog } from "~/components/events/edit-subscription-dialog";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { TeamSlackSetupModal } from "~/components/events/team-slack-setup";
import { useListOwner } from "~/lib/use-list-owner";
import { textParam } from "~/lib/search-params";
import { cn } from "~/lib/cn";

/**
 * `/channel?key=slack:C123` — one channel: who listens there, the Valet
 * threads that talk in it, and the messages sent and received, each linking
 * to both Valet and the provider (docs/specs/2026-09-30-channels-design.md).
 */
export const Route = createFileRoute("/channel")({
  component: ChannelPage,
  validateSearch: (raw: unknown): { key: string } => ({ key: textParam(raw, "key") ?? "" }),
});

function ChannelPage() {
  const { key } = Route.useSearch();
  const owner = useListOwner();
  const channel = useWorkspaceChannel(owner, key);
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <Link to="/events" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-ink sm:min-h-0">
          ← Channels
        </Link>
        {(channel.isPending && owner !== undefined) && <LoadingRow label="Loading channel…" />}
        {channel.error && (
          <ErrorRow>{channel.error.message || "Could not load this channel. Open Channels to find it again."}</ErrorRow>
        )}
        {channel.data && <ChannelBody data={channel.data} />}
      </div>
    </div>
  );
}

export function ChannelBody({ data }: { data: ChannelDetailResponse }) {
  const { channel, conversations, messages } = data;
  return (
    <div className="mt-4 space-y-8">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ChannelIcon provider={channel.provider} className="h-5 w-5" />
        <h1 className="min-w-0 break-words font-display text-2xl text-ink">{channel.name}</h1>
        {channel.state && <Badge variant={channel.state === "open" ? "success" : "neutral"}>{channel.state === "open" ? "Open" : channel.state === "merged" ? "Merged" : "Closed"}</Badge>}
        {channel.url && <ProviderLink provider={channel.provider} href={channel.url} className="ml-auto" />}
      </header>

      {channel.provider === "slack" && <Listening listeners={channel.listeners} />}
      {channel.provider === "github" && (
        <p className="text-sm text-muted">
          Comments and reviews on this pull request go to the thread that opened it. Valet answers with a pull request comment.
        </p>
      )}

      <WorkSection title="Threads" count={conversations.length}>
        {conversations.length === 0 && <EmptyRow className="px-4 py-3">No Valet thread talks here yet.</EmptyRow>}
        {conversations.map((conversation) => (
          <WorkRow
            key={`${conversation.sessionId}:${conversation.threadId}`}
            title={<Link to="/threads/$threadId" params={{ threadId: conversation.threadId }}>{conversation.title}</Link>}
            time={conversation.lastActivityAt}
            actions={conversation.url ? <ProviderLink provider={channel.provider} href={conversation.url} label={channel.provider === "slack" ? "Slack thread" : "Pull request"} /> : undefined}
          />
        ))}
      </WorkSection>

      <WorkSection title="Messages" count={messages.length}>
        {messages.length === 0 && <EmptyRow className="px-4 py-3">No messages recorded yet. Messages appear here as Valet sends and receives them.</EmptyRow>}
        {messages.map((message) => <MessageRow key={message.id} message={message} provider={channel.provider} />)}
      </WorkSection>
    </div>
  );
}

function MessageRow({ message, provider }: { message: ChannelMessage; provider: ChannelDetailResponse["channel"]["provider"] }) {
  return (
    <WorkRow
      title={message.direction === "out" ? "Valet" : message.author ?? "Someone"}
      badge={<Badge variant={message.direction === "out" ? "accent" : "neutral"}>{message.direction === "out" ? "Sent" : "Received"}</Badge>}
      time={message.createdAt}
      detail={message.text ? <span className="line-clamp-3">{message.text}</span> : undefined}
      actions={<>
        <Link to="/threads/$threadId" params={{ threadId: message.threadId }} className={`${textLinkClass} text-xs`}>Valet thread</Link>
        {message.url && <ProviderLink provider={provider} href={message.url} label={provider === "slack" ? "Slack" : "GitHub"} />}
      </>}
    />
  );
}

/**
 * Whether this workspace's Valet listens here. A workspace has one Valet, so
 * this is one line with its controls, not a list; another workspace's Valet
 * that also listens is noted under it.
 */
function Listening({ listeners }: { listeners: ChannelListener[] }) {
  const owner = useListOwner();
  const subscriptions = useEventSubscriptions(owner);
  const patch = usePatchEventSubscription();
  const [editing, setEditing] = useState<EventSubscriptionWire>();
  const [setup, setSetup] = useState(false);
  const team = owner?.ownerType === "team" ? owner.ownerId : undefined;
  const own = listeners.find((listener) => listener.editable);
  const rule = own ? subscriptions.data?.subscriptions.find((candidate) => candidate.id === own.subscriptionId) : undefined;
  const others = [...new Set(listeners.filter((listener) => !listener.editable).map((listener) => `${listener.ownerName}'s Valet`))];
  return (
    <section aria-label="Listening" className={cn(cardClass)}>
      <WorkRow
        title={own ? "Valet is listening here" : "Valet is not listening here"}
        detail={own
          ? own.everywhere ? "It answers mentions in every channel the Valet bot is in." : "It answers mentions here and follows each thread it joins."
          : "A mention here does not reach this workspace."}
        actions={<>
          {own && rule && <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(rule)}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ id: rule.id, body: { enabled: false } })}>Pause</Button>
          </>}
          {(!own || team) && (
            <Button size="sm" variant={own ? "secondary" : "primary"} onClick={() => setSetup(true)}>
              <Ear aria-hidden className="h-4 w-4" />{own ? "Edit channels" : "Listen here"}
            </Button>
          )}
        </>}
      />
      {others.length > 0 && <p className="border-t border-line px-4 py-2 text-xs text-muted">Also listening: {others.join(", ")}.</p>}
      {editing && (
        <EditSubscriptionDialog open onOpenChange={(open) => { if (!open) setEditing(undefined); }} sub={editing}
          targetLabel="Replies in the thread as this workspace's Valet" />
      )}
      {setup && team && <TeamSlackSetupModal teamId={team} onOpenChange={setSetup} />}
      {setup && !team && <AutomationWizard open onOpenChange={setSetup} />}
    </section>
  );
}
