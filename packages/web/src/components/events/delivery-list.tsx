import { Link } from "@tanstack/react-router";
import type { EventDeliveryWire } from "@valet/api/wire";
import { Badge, textLinkClass } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { formatWhen } from "~/lib/format-when";
import { deliveryStatusLine } from "./delivery-copy";

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
 * or the workflow run it reached, when the API sends one.
 */
export function DeliveryList({
  deliveries,
  now = Date.now(),
}: {
  deliveries: EventDeliveryWire[];
  /** Injectable for tests; a delivery countdown is read against it. */
  now?: number;
}) {
  if (deliveries.length === 0) {
    return (
      <p className="text-xs text-muted">
        No subscription matched this event. Create one in the Subscriptions tab to act on it.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {deliveries.map((d) => (
        <li key={d.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={DELIVERY_VARIANT[d.status]}>{d.status}</Badge>
            <span className="break-all text-xs text-ink">{d.subscriptionName ?? d.subscriptionId}</span>
            <span className="text-xs text-muted">{deliveryStatusLine(d, now)}</span>
            {d.deliveredAt !== null && (
              <span className="text-xs text-muted">delivered {formatWhen(d.deliveredAt)}</span>
            )}
            {d.thread && (
              <Link to="/threads/$threadId" params={{ threadId: d.thread.threadId }} className={destinationLinkClass}>
                Open thread
              </Link>
            )}
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
