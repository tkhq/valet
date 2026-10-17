import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { EventDeliveryThreadRef, EventDeliveryWire, EventSummaryWire } from "@valet/api/wire";
import { Badge, textLinkClass } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { formatWhen } from "~/lib/format-when";
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

/**
 * The delivery attempts made for one event: what each one was trying to
 * reach, where it got to, and when it tries again. Shared by the feed row
 * and the event page so the two never drift. A delivery links to the thread
 * it reached, the thread whose waiter claimed it, or the workflow run it
 * started, when the API sends one (spec 2026-10-16: delivery threads and
 * claims, Part E step 2). A dead delivery shows its dead-letter text.
 *
 * A row names its thread by the title on its thread ref. A row that
 * carries its event (a listener's list) leads with the event, not the rule.
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
        {empty ?? "No listener matched this event. Add one in Presence."}
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
              <span className="break-all text-xs text-ink">{d.subscriptionName ?? d.subscriptionId}</span>
            )}
            {!d.claimedBy && <span className="text-xs text-muted">{deliveryStatusLine(d, now)}</span>}
            {d.deliveredAt !== null && (
              <span className="text-xs text-muted">delivered {formatWhen(d.deliveredAt)}</span>
            )}
            {d.thread && (
              <Link to="/threads/$threadId" params={{ threadId: d.thread.threadId }} className={destinationLinkClass}>
                Delivered to {titleOf(d.thread)}
              </Link>
            )}
            {d.claimedBy && (
              <Link to="/threads/$threadId" params={{ threadId: d.claimedBy.threadId }} className={destinationLinkClass}>
                Claimed by {titleOf(d.claimedBy)}
              </Link>
            )}
            {d.runId && (
              <Link to="/presence/runs/$runId" params={{ runId: d.runId }} className={destinationLinkClass}>
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
