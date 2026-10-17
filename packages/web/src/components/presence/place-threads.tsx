/**
 * The **Threads** section of a place page
 * (docs/specs/2026-10-16-presence-hub-design.md Part B step 3): the
 * place's own threads (one per channel, pull request, or issue), the threads following a Slack thread here, and the threads
 * active here now. Each row links to the Valet thread, and to the provider
 * when the place has a link.
 */
import { Link } from "@tanstack/react-router";
import type { ChannelConversation, PresencePlaceDetailResponse, PresencePlaceService } from "@valet/api/wire";
import { EmptyRow, WorkRow, cardClass } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { ProviderLink } from "~/components/channels/channel-parts";
import { SERVICE_NAMES } from "./places";

type PlaceThreadLists = PresencePlaceDetailResponse["threads"];

/** The three lists, in order. The first names the place, such as `Threads for acme/api`. */
function groups(label: string): readonly { key: keyof PlaceThreadLists; title: string }[] {
  return [
    { key: "subject", title: `Threads for ${label}` },
    { key: "following", title: "Following" },
    { key: "active", title: "Active now" },
  ];
}

export function threadCount(threads: PlaceThreadLists): number {
  return new Set([...threads.subject, ...threads.following, ...threads.active].map((t) => t.threadId)).size;
}

export function PlaceThreads({ threads, service, label }: {
  threads: PlaceThreadLists;
  service: PresencePlaceService;
  /** The place's concrete name, such as `#incidents`. */
  label: string;
}) {
  const total = threadCount(threads);
  return (
    <section aria-label="Threads">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg">Threads</h2>
        <span className="text-xs text-muted">{total}</span>
      </div>
      {total === 0 && <EmptyRow className="py-1">No Valet thread works here yet.</EmptyRow>}
      <div className="space-y-4">
        {groups(label).filter((group) => threads[group.key].length > 0).map((group) => (
          <div key={group.key}>
            <h3 className="mb-2 text-sm font-medium text-ink">{group.title}</h3>
            <ul aria-label={group.title} className={cn(cardClass, "list-none divide-y divide-line")}>
              {threads[group.key].map((thread) => (
                <li key={`${thread.sessionId}:${thread.threadId}`}>
                  <ThreadRow thread={thread} service={service} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function ThreadRow({ thread, service }: { thread: ChannelConversation; service: PresencePlaceService }) {
  return (
    <WorkRow
      title={<Link to="/threads/$threadId" params={{ threadId: thread.threadId }}>{thread.title}</Link>}
      time={thread.lastActivityAt}
      actions={thread.url && service !== "linear"
        ? <ProviderLink provider={service} href={thread.url} label={service === "slack" ? "Slack thread" : `Open on ${SERVICE_NAMES[service]}`} />
        : undefined}
    />
  );
}
