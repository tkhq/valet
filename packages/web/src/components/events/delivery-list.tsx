import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { EventDeliveryThreadRef, EventDeliveryWire, EventSummaryWire } from "@valet/api/wire";
import { Badge, textLinkClass } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { formatWhen } from "~/lib/format-when";
import { ArchivedThreadLink } from "~/components/presence/archived-thread-link";
import { deliveryStatusLine } from "./delivery-copy";

/** A delivery, with the event it carried when the list is one listener's. */
export type DeliveryRow = EventDeliveryWire & { event?: EventSummaryWire };

/** The title the API sends on the thread ref, or `thread` when it has none. */
function titleOf(ref: EventDeliveryThreadRef): string {
  return ref.title !== undefined && ref.title.trim().length > 0 ? ref.title : "thread";
}

/**
 * `failed` is amber, not red: the dispatcher is still going to retry it, and
 * painting it the same red as `dead` is what made the two states
 * indistinguishable. Red is reserved for a delivery that gave up.
 */
const DELIVERY_VARIANT: Record<EventDeliveryWire["status"], "neutral" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  delivered: "success",
  failed: "warning",
  dead: "danger",
  skipped: "neutral",
};

const destinationLinkClass = cn(textLinkClass, "min-h-11 text-xs sm:min-h-0");

/** A link to the thread a delivery reached or that claimed it. An archived thread's link is disabled. */
function ThreadLink({ thread, children }: { thread: EventDeliveryThreadRef; children: ReactNode }) {
  if (thread.archived) return <ArchivedThreadLink className="text-xs text-muted">{children}</ArchivedThreadLink>;
  return (
    <Link to="/threads/$threadId" params={{ threadId: thread.threadId }} className={destinationLinkClass}>
      {children}
    </Link>
  );
}

/**
 * The delivery attempts made for one event: what each one was trying to
 * reach, where it got to, and when it tries again. Shared by the feed row
 * and the event page so the two never drift. A delivery links to the thread
 * it reached, the thread whose waiter claimed it, or the workflow run it
 * started, when the API sends one (spec 2026-10-16: delivery threads and
 * claims, Part E step 2). An archived thread's link stays, disabled. A
 * dead delivery shows its dead-letter text.
 *
 * A row names its thread by the title on its thread ref. A row that
 * carries its event (a line's list) leads with the event. Otherwise it leads
 * with the line's name, linked to the line's page.
 */
export function DeliveryList({
  deliveries,
  now = Date.now(),
  empty,
}: {
  deliveries: DeliveryRow[];
  /** Injectable for tests; a delivery countdown is read against it. */
  now?: number;
  /** The text for an empty list. The default suits one event's list. */
  empty?: ReactNode;
}) {
  if (deliveries.length === 0) {
    return (
      <p className="text-xs text-muted">
        {empty ?? "Nothing in Presence matched this event. To act on events like it, select Listen for… on its place in Presence."}
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {deliveries.map((d) => (
        <li key={d.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={DELIVERY_VARIANT[d.status]}>{d.status}</Badge>
            {d.event ? (
              <Link to="/presence/events/$eventId" params={{ eventId: d.event.id }} className={cn(destinationLinkClass, "break-words")}>
                {d.event.summary}
              </Link>
            ) : (
              <Link to="/presence/rules/$id" params={{ id: d.subscriptionId }} className={cn(destinationLinkClass, "break-all")}>
                {d.subscriptionName ?? d.subscriptionId}
              </Link>
            )}
            {!d.claimedBy && <span className="text-xs text-muted">{deliveryStatusLine(d, now)}</span>}
            {d.deliveredAt !== null && (
              <span className="text-xs text-muted">delivered {formatWhen(d.deliveredAt)}</span>
            )}
            {d.thread && <ThreadLink thread={d.thread}>Delivered to {titleOf(d.thread)}</ThreadLink>}
            {d.claimedBy && <ThreadLink thread={d.claimedBy}>Claimed by {titleOf(d.claimedBy)}</ThreadLink>}
            {d.runId && (
              <Link to="/workflows/runs/$runId" params={{ runId: d.runId }} className={destinationLinkClass}>
                Open run
              </Link>
            )}
          </div>
          {d.status !== "skipped" && d.lastError != null && d.lastError.length > 0 && (
            // Never truncated. The error string is the one field a reader
            // needs whole to act on it.
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-danger-500">
              {d.lastError}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
