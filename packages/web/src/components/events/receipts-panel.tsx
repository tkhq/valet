import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ListEventReceiptsResponse } from "@valet/api/wire";
import { useEventReceipts } from "~/api/events";
import { useMe } from "~/api/settings";
import { Badge, Button, EmptyRow, ErrorRow, LoadingRow, cardClass } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { SearchInput } from "~/components/search-input";
import { cn } from "~/lib/cn";

type Receipt = ListEventReceiptsResponse["receipts"][number];

const METADATA_LABELS: Record<string, string> = {
  channelId: "Channel", workspaceId: "Provider workspace", actorId: "Actor", botId: "Bot",
  appId: "App", rawType: "Provider event type", rawSubtype: "Provider event subtype",
  messageTs: "Message timestamp", threadTs: "Thread timestamp", retryNum: "Retry number",
  retryReason: "Retry reason", botIdentityAvailable: "Bot identity available",
  botUserIdentityAvailable: "Bot user identity available", payloadBytes: "Payload size (bytes)",
  configuredTriggerCount: "Configured listeners",
};
const LABELS: Record<string, string> = {
  // Receipts written before the rename record the old `orchestrator` kind.
  assistant: "Assistant", orchestrator: "Assistant", workflow: "Workflow",
  subscription_match: "Listener matching", persistence: "Event storage", dispatch: "Delivery queue",
  channel: "Channel processing", workspace: "Workspace check", ingestion: "Event ingestion",
  follow: "Follow-up check", fan_out: "Delivery preparation", completed: "Check completed",
  not_applicable: "Not applicable", filtered: "Excluded by listener filters", no_subscription: "No matching listener",
  started: "Started", stored: "Event stored", enqueued: "Delivery queued",
  receipt: "Receipt", received: "Received", verification: "Verification", verified: "Verified",
  classification: "Classification", classified: "Classified", ingest: "Event ingestion",
  subscription: "Listener matching", subscriptions: "Listener matching", routing: "Routing",
  accepted: "Accepted", rejected: "Rejected", ignored: "Ignored", matched: "Matched",
  no_match: "No match", unmatched: "No match", filter_excluded: "Excluded by filters",
  authorization_denied: "Authorization denied", key_mismatch: "Event key did not match", disabled: "Disabled", duplicate: "Duplicate", error: "Error", failed: "Failed",
  delivered: "Delivered", pending: "Pending", skipped: "Skipped", recorded: "Recorded",
};
/** A receipt stage or outcome identifier in words, such as `filter_excluded` → `Excluded by filters`. */
export function receiptLabel(value: string): string {
  return label(value);
}
function label(value: string): string {
  return LABELS[value] ?? value.replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}
function Timestamp({ value }: { value: number }) {
  const iso = new Date(value).toISOString();
  return <time dateTime={iso} className="font-mono text-xs text-muted">{iso}</time>;
}

/** Admin scope is checked here as well as at the tab boundary. */
export function ReceiptsPanel() {
  const me = useMe();
  const allowed = !me.error && me.data?.orgRole === "admin";
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const receiptsQ = useEventReceipts(me.data?.orgId, { q: query, cursor, limit: 25 }, allowed);
  if (me.error) return <ErrorRow>Could not check access. Reload this page to try again.</ErrorRow>;
  if (!me.data) return <LoadingRow label="Checking access…" />;
  if (!allowed) return <EmptyRow>The delivery log is available to organization administrators.</EmptyRow>;
  // Cached metadata must not survive an access error or a failed current-page request.
  const data = receiptsQ.error ? undefined : receiptsQ.data;
  return <div className="space-y-4">
    <p className="text-sm text-muted">Incoming events and how Valet processed them.</p>
    <details className="text-xs text-muted">
      <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-moss">About this log</summary>
      <div className="mt-2 space-y-2">
        <p>Organization-wide metadata only. No message bodies. Retained for up to 7 days or 10,000 receipts, whichever comes first.</p>
        <p>Open a matched event for delivery attempts and outcomes.</p>
        <p>Missing an event? Check Rejected and Failed in the Log for verification or credential errors, then the provider’s delivery logs. A missing receipt does not confirm a delivery failure.</p>
      </div>
    </details>
    {data && <p className="text-xs text-muted">{data.lastReceiptAt !== null ? `Last receipt ${relativeTime(data.lastReceiptAt)}.` : "No recent receipts."}</p>}
    <SearchInput aria-label="Search incoming events" placeholder="Search provider ID, channel, event key, or reference" value={query} maxLength={200} onSettled={next => { setQuery(next.trim()); setCursors([]); }} />
    {receiptsQ.isPending && <LoadingRow label="Loading incoming events…" />}
    {receiptsQ.error && <ErrorRow>Could not load delivery receipts. <button className="underline" onClick={() => void receiptsQ.refetch()}>Retry</button>{cursor && <> or <button className="underline" onClick={() => setCursors([])}>Return to the first page</button>.</>}</ErrorRow>}
    {data?.receipts.length === 0 && <EmptyRow>{query ? "No receipts match this search in the last 7 days." : "No receipts recorded in the last 7 days. Check the provider’s delivery logs for missing events."}</EmptyRow>}
    {data && data.receipts.length > 0 && <ul className={cn(cardClass, "divide-y divide-line")}>{data.receipts.map(receipt => <ReceiptRow key={receipt.id} receipt={receipt} />)}</ul>}
    <nav aria-label="Incoming event pages" className="flex gap-2">
      <Button variant="secondary" disabled={!cursor || receiptsQ.isFetching} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous</Button>
      <Button variant="secondary" disabled={!data?.nextCursor || receiptsQ.isFetching} onClick={() => { const next = data?.nextCursor; if (next) setCursors(previous => [...previous, next]); }}>Next</Button>
    </nav>
  </div>;
}

/** A receipt's stages in the order they happened. A stage without a time sorts at the receipt's creation. */
function orderedStages(receipt: Receipt) {
  return receipt.stages.map((stage, index) => ({ ...stage, index })).sort((a, b) => (a.at ?? receipt.createdAt) - (b.at ?? receipt.createdAt) || a.index - b.index);
}

/** One receipt's processing timeline: each stage, its outcome, its time, and its detail. */
export function ReceiptStages({ receipt }: { receipt: Receipt }) {
  const stages = orderedStages(receipt);
  return <section aria-label="Processing timeline">
    <h3 className="text-sm font-medium">Processing timeline</h3>
    {stages.length === 0 ? <p className="text-xs text-muted">No stages recorded.</p> : <ol className="mt-2 space-y-3 border-l border-line pl-3">{stages.map(stage => <li key={stage.index} className="text-sm"><span className="font-medium">{label(stage.stage)}: {label(stage.outcome)}</span>{stage.at !== undefined && <div><Timestamp value={stage.at} /></div>}<p className="text-muted">{stage.detail}</p></li>)}</ol>}
  </section>;
}

/**
 * The receipt stages of one stored event, for the Activity disclosure. Only
 * organization administrators read receipts, so the request waits for
 * `open` and for the admin check.
 */
export function EventReceiptStages({ eventId, open }: { eventId: string; open: boolean }) {
  const me = useMe();
  const allowed = !me.error && me.data?.orgRole === "admin";
  const receiptsQ = useEventReceipts(me.data?.orgId, { q: eventId, limit: 5 }, allowed && open);
  if (!open) return null;
  if (me.error) return <ErrorRow>Could not check access. Reload this page to try again.</ErrorRow>;
  if (!me.data) return <LoadingRow label="Checking access…" />;
  if (!allowed) return <p className="text-xs text-muted">Receipt stages are available to organization administrators.</p>;
  if (receiptsQ.isPending) return <LoadingRow label="Loading receipt stages…" />;
  if (receiptsQ.error) return <ErrorRow>Could not load the receipt stages. <button className="underline" onClick={() => void receiptsQ.refetch()}>Retry</button></ErrorRow>;
  const receipts = receiptsQ.data.receipts.filter(receipt => receipt.eventId === eventId);
  if (receipts.length === 0) return <p className="text-xs text-muted">No receipt recorded for this event. Receipts stay for up to 7 days.</p>;
  return <div className="space-y-3">{receipts.map(receipt => <ReceiptStages key={receipt.id} receipt={receipt} />)}</div>;
}

function ReceiptRow({ receipt }: { receipt: Receipt }) {
  const stages = orderedStages(receipt);
  // A later follow-up check must not hide rejection, filtering, or dispatch failures.
  const latest = stages.find(stage => stage.outcome === "failed")
    ?? stages.find(stage => ["classification", "workspace"].includes(stage.stage) && stage.outcome === "rejected")
    ?? stages.find(stage => stage.stage === "subscription_match")
    ?? stages.find(stage => stage.stage === "persistence")
    ?? stages.at(-1);
  const outcome = latest ? label(latest.outcome) : "Received";
  return <li className="px-4 py-3">
    <details>
      <summary className="cursor-pointer list-none rounded text-sm focus-visible:outline focus-visible:outline-moss">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 basis-full break-words font-medium sm:basis-auto sm:flex-1">{label(receipt.service)}{receipt.eventKey ? <> · <span className="font-mono text-xs">{receipt.eventKey}</span></> : " · Incoming delivery"}</span>
          <Badge variant={latest?.outcome === "failed" ? "danger" : latest?.outcome === "rejected" ? "warning" : "neutral"}>{outcome}{latest?.outcome === "started" ? " · no completion recorded" : ""}</Badge>
          <span className="text-xs text-muted" title={new Date(receipt.createdAt).toISOString()}>{relativeTime(receipt.createdAt)}</span>
        </span>
        {latest?.detail && <span className="mt-1 block break-words text-muted">{latest.detail}</span>}
        <span className="mt-1 block break-all text-xs text-muted">Reference: {receipt.id}{receipt.externalId ? ` · Provider ID: ${receipt.externalId}` : ""}</span>
      </summary>
      <div className="mt-3 space-y-4 break-words sm:pl-3">
        {receipt.eventId && <Link to="/presence/events/$eventId" params={{ eventId: receipt.eventId }} className="text-sm text-moss underline">View delivery attempts</Link>}
        <section aria-label="Receipt metadata">
          <h3 className="text-sm font-medium">Delivery metadata</h3>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
            {Object.entries(receipt.metadata).filter(([key]) => key in METADATA_LABELS).map(([key, value]) => <div className="contents" key={key}><dt className="text-muted">{METADATA_LABELS[key]}</dt><dd className="break-all">{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</dd></div>)}
          </dl>
        </section>
        <ReceiptStages receipt={receipt} />
        <section aria-label="Listener decisions">
          <h3 className="text-sm font-medium">Listener decisions</h3>
          {receipt.subscriptions.length === 0 ? <p className="text-xs text-muted">No decisions recorded.</p> : <ul className="mt-2 space-y-2">{receipt.subscriptions.map(subscription => <li key={subscription.id} className="text-sm"><p className="font-medium">{subscription.name || subscription.id}: {label(subscription.outcome)}</p>{subscription.failedFilters?.length ? <p className="text-xs text-muted">Filters that did not match: {subscription.failedFilters.map(filter => `${filter.field} (${filter.op})`).join(", ")}</p> : null}<p className="break-all text-xs text-muted">{label(subscription.ownerType)} {subscription.ownerId} · Target: {label(subscription.target)}{subscription.targetId ? ` (${subscription.targetId})` : ""} · {subscription.id}</p></li>)}</ul>}
        </section>
      </div>
    </details>
  </li>;
}
