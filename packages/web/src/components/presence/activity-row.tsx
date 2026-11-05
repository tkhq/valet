/**
 * One stored event on the Activity page, as one sentence
 * (docs/specs/2026-10-16-presence-hub-design.md Part E step 1):
 * `<event in words> in <place> → <outcome>`. The place and each thread read
 * as reference tokens (`Ref`), a thread in the outcome links to the thread, and a disclosure keeps the deliveries and the receipt
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
import { ArchivedThreadLink } from "./archived-thread-link";
import { Ref } from "./ref";
import { Sentence } from "./sentence";
import { activitySentenceParts, replies, type ActivityOutcome, type ActivitySentenceParts, type SentencePart } from "./sentences";

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
 * Whether each of the workspace's lines replies (`replies`), by listener id,
 * so a delivered row reads `replied in` only for a Reply line. A line that
 * is gone is not listed, and its rows fall back to the event key.
 */
export function useRepliesByListener(): Readonly<Record<string, boolean>> {
  const owner = useListOwner();
  const listeners = useEventSubscriptions(owner, { enabled: owner !== undefined });
  return Object.fromEntries((listeners.data?.subscriptions ?? []).map((sub) => [sub.id, replies(sub)]));
}

/**
 * One outcome. A thread reads as a thread token that links the thread. An
 * archived thread keeps its token in a disabled link, because it no longer
 * takes deliveries. A run outcome links the run.
 */
function Outcome({ outcome, parts }: { outcome: ActivityOutcome; parts: readonly SentencePart[] }) {
  if (outcome.runId !== undefined) {
    return <Link to="/workflows/runs/$runId" params={{ runId: outcome.runId }} className={textLinkClass}>{outcome.words}</Link>;
  }
  const thread = outcome.thread;
  if (thread?.ref.archived) {
    return (
      <>
        {outcome.words}{" "}
        <ArchivedThreadLink>
          <Ref kind="thread" text={thread.label} />
        </ArchivedThreadLink>
      </>
    );
  }
  return <Sentence parts={parts} />;
}

/**
 * An activity sentence from `activitySentenceParts`: the lead opens the
 * event page and names its place as a token, and each thread opens its
 * thread. The place token sits inside the lead's link, so it does not link
 * on its own. Outcomes key by their delivery.
 */
export function ActivitySentence({ eventId, sentence, className }: {
  eventId: string;
  sentence: ActivitySentenceParts;
  className?: string;
}) {
  return (
    <span className={className}>
      <Link to="/presence/events/$eventId" params={{ eventId }}><Sentence parts={sentence.lead} links={false} /></Link>
      {sentence.outcomes.length > 0 && " → "}
      {sentence.outcomes.map(({ key, outcome, parts }, index) => (
        <Fragment key={key}>
          {index > 0 && ", "}
          <Outcome outcome={outcome} parts={parts} />
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
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">Attempts and intake stages</summary>
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
export function ActivityRow({ item, workflowsByListener, repliesByListener }: {
  item: EventLogItem;
  workflowsByListener: Readonly<Record<string, string>>;
  /** Whether each known line replies, by listener id (`useRepliesByListener`). */
  repliesByListener?: Readonly<Record<string, boolean>>;
}) {
  const meta = LOG_STATUS_META[item.status];
  const event = { eventKey: item.eventKey };
  const names = {
    ...(item.place !== undefined ? { place: item.place } : {}),
    ...(item.placeKey !== undefined ? { placeKey: item.placeKey } : {}),
    workflowsByListener,
    ...(repliesByListener !== undefined ? { repliesByListener } : {}),
  };
  const deliveries = item.deliveries ?? [];
  const parts = activitySentenceParts(event, deliveries, names);
  // An older server sends no deliveries; the row then names no outcome it cannot see.
  const sentence = item.deliveries === undefined ? { lead: parts.lead, outcomes: [] } : parts;
  return (
    <div>
      <WorkRow
        title={<ActivitySentence eventId={item.id} sentence={sentence} />}
        badge={<Badge variant={meta.badge}>{meta.label}</Badge>}
        time={item.at}
        // A failed row names why, such as an assistant turn that failed.
        detail={[item.summary, item.actor, item.status === "failed" ? item.detail : null].filter(Boolean).join(" · ")}
      />
      <ReceiptDisclosure eventId={item.id} deliveries={deliveries} />
    </div>
  );
}
