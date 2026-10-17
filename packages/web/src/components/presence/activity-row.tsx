/**
 * One stored event in the Activity tab, as one sentence
 * (docs/specs/2026-10-16-presence-hub-design.md Part E step 1):
 * `<event in words> in <place> → <outcome>`. A thread in the outcome links
 * to the thread, and a disclosure keeps the deliveries and the receipt
 * stages (Part E step 2).
 */
import { Fragment, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventDeliveryWire, EventLogItem, EventLogStatus } from "@valet/api/wire";
import { useEventSubscriptions } from "~/api/events";
import { useWorkflows } from "~/api/workflows";
import { DeliveryList } from "~/components/events/delivery-list";
import { EventReceiptStages } from "~/components/events/receipts-panel";
import { Badge, WorkRow, textLinkClass } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { activityLead, activityOutcomes, type ActivityOutcome } from "./sentences";

/** The badge each Log status wears. Exported for the event-log problem rows. */
export const LOG_STATUS_META: Record<EventLogStatus, { label: string; badge: "success" | "warning" | "danger" | "neutral" | "accent" }> = {
  delivered: { label: "Delivered", badge: "success" },
  pending: { label: "In progress", badge: "accent" },
  failed: { label: "Failed", badge: "danger" },
  skipped: { label: "Skipped", badge: "neutral" },
  filtered: { label: "Filtered out", badge: "neutral" },
  no_match: { label: "No match", badge: "neutral" },
  rejected: { label: "Rejected", badge: "warning" },
};

/**
 * The workflow each of the workspace's listeners runs, by listener id, so a
 * delivery that started a run reads `started <workflow> run`.
 */
export function useWorkflowsByListener(): Readonly<Record<string, string>> {
  const owner = useListOwner();
  const listeners = useEventSubscriptions(owner, { enabled: owner !== undefined });
  const workflows = useWorkflows();
  const names = new Map((workflows.data?.workflows ?? []).map((w) => [w.id, w.name]));
  const byListener: Record<string, string> = {};
  for (const sub of listeners.data?.subscriptions ?? []) {
    if (sub.target.kind !== "workflow") continue;
    const name = names.get(sub.target.workflowId);
    if (name !== undefined) byListener[sub.id] = name;
  }
  return byListener;
}

/**
 * One outcome. A thread label links to the thread. An archived thread keeps
 * its name and a disabled link, because it no longer takes deliveries.
 */
function Outcome({ outcome }: { outcome: ActivityOutcome }) {
  if (outcome.runId !== undefined) {
    return <Link to="/workflows/runs/$runId" params={{ runId: outcome.runId }} className={textLinkClass}>{outcome.words}</Link>;
  }
  const thread = outcome.thread;
  if (!thread) return <>{outcome.words}</>;
  return (
    <>
      {outcome.words}{" "}
      {thread.ref.archived ? (
        <span role="link" aria-disabled="true" title="This thread is archived." className="text-muted">
          {thread.label}
        </span>
      ) : (
        <Link to="/threads/$threadId" params={{ threadId: thread.ref.threadId }} className={textLinkClass}>
          {thread.label}
        </Link>
      )}
    </>
  );
}

/** An activity sentence with links: the lead opens the event page, and each thread opens its thread. */
export function ActivitySentence({ eventId, lead, outcomes }: { eventId: string; lead: string; outcomes: readonly ActivityOutcome[] }) {
  return (
    <span>
      <Link to="/presence/events/$eventId" params={{ eventId }}>{lead}</Link>
      {" → "}
      {outcomes.map((outcome, index) => (
        <Fragment key={index}>
          {index > 0 && ", "}
          <Outcome outcome={outcome} />
        </Fragment>
      ))}
    </span>
  );
}

/** The deliveries and the receipt stages of one event, behind a disclosure. */
function ReceiptDisclosure({ eventId, deliveries }: { eventId: string; deliveries: EventDeliveryWire[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="px-4 pb-3 text-sm sm:pl-5" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">Deliveries and receipt stages</summary>
      {open && (
        <div className="mt-2 space-y-3">
          <DeliveryList deliveries={deliveries} />
          <EventReceiptStages eventId={eventId} open={open} />
        </div>
      )}
    </details>
  );
}

/** A stored event as an Activity row: the sentence, the status, when, and what the event said. */
export function ActivityRow({ item, workflowsByListener }: { item: EventLogItem; workflowsByListener: Readonly<Record<string, string>> }) {
  const meta = LOG_STATUS_META[item.status];
  const event = { eventKey: item.eventKey };
  const names = { ...(item.place !== undefined ? { place: item.place } : {}), workflowsByListener };
  const deliveries = item.deliveries ?? [];
  // An older server sends no deliveries; the row then names no outcome it cannot see.
  const outcomes = item.deliveries === undefined ? [] : activityOutcomes(event, deliveries, names);
  return (
    <div>
      <WorkRow
        title={outcomes.length > 0
          ? <ActivitySentence eventId={item.id} lead={activityLead(event, names)} outcomes={outcomes} />
          : <Link to="/presence/events/$eventId" params={{ eventId: item.id }}>{activityLead(event, names)}</Link>}
        badge={<Badge variant={meta.badge}>{meta.label}</Badge>}
        time={item.at}
        detail={[item.summary, item.actor].filter(Boolean).join(" · ")}
      />
      <ReceiptDisclosure eventId={item.id} deliveries={deliveries} />
    </div>
  );
}
