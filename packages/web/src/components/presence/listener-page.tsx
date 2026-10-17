/**
 * One listener's page (docs/specs/2026-10-16-presence-hub-design.md Part C
 * steps 4 to 6): the sentence, enable or disable, edit (the existing dialog,
 * where **Runs in** is editable), **Appears as**, the delivery list, and this
 * listener's receipts. A listener whose pinned thread no longer accepts
 * deliveries shows its problem with the thread picker inline.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventReceiptWire, EventSubscriptionWire, ReceiptSubscriptionDecision } from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import { useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import {
  useListenerDeliveries,
  useListenerReceipts,
  usePinnedThreadTitle,
} from "~/api/listener";
import { useMe } from "~/api/settings";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import { DeliveryList } from "~/components/events/delivery-list";
import { EditSubscriptionDialog } from "~/components/events/edit-subscription-dialog";
import { receiptLabel } from "~/components/events/receipts-panel";
import {
  Avatar, AvatarFallback, AvatarImage, Button, EmptyRow, ErrorRow, LoadingRow, Switch, WorkRow, WorkSection, cardClass,
} from "~/components/primitives";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { PresenceDetailPage } from "./page-shell";
import { ProblemBadge, ThreadProblem } from "./problem-badge";
import { eventInWords, listenerSentence } from "./sentences";

/** Coverage copy for a personal listener that a team listener paused (Part C step 6). */
export const PAUSED_BY_TEAM = "Paused: a team listener covers the same events.";

export function ListenerPage({ id }: { id: string }) {
  const subsQ = useEventSubscriptions();
  const sub = subsQ.data?.subscriptions.find((s) => s.id === id);
  return (
    <PresenceDetailPage back="/presence" backLabel="Places" title={sub?.name ?? "Listener"}>
      {subsQ.isPending && <LoadingRow />}
      {subsQ.isError && (
        <ErrorRow>{errorText(subsQ.error, "Could not load this listener. Reload the page to try again.")}</ErrorRow>
      )}
      {subsQ.isSuccess && sub === undefined && (
        <EmptyRow>This listener does not exist, or you cannot see it. Open Places and pick a listener.</EmptyRow>
      )}
      {sub !== undefined && <ListenerBody sub={sub} />}
    </PresenceDetailPage>
  );
}

/** The workspace key whose threads the picker lists: `user` or a team id.
 * The org assistant has no thread list here. */
function workspaceOf(sub: EventSubscriptionWire): string | undefined {
  if (sub.ownerType === "user") return "user";
  if (sub.ownerType === "team") return sub.ownerId;
  return undefined;
}

function storedPolicy(sub: EventSubscriptionWire): AssistantThreadPolicy | undefined {
  return sub.target.kind === "assistant" ? sub.target.thread ?? undefined : undefined;
}

/** What a workflow target or an assistant target does, for the edit dialog's read-only line. */
function targetLabel(sub: EventSubscriptionWire, workflowName: string | undefined): string {
  if (sub.target.kind === "workflow") return `Runs ${workflowName ?? "a workflow"}`;
  if (sub.target.assistant === "org") return "The organization's assistant";
  if (sub.target.assistant === "team") return "The team's assistant";
  return "Your assistant";
}

function ListenerBody({ sub }: { sub: EventSubscriptionWire }) {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const me = useMe();
  const patch = usePatchEventSubscription();
  const pinTitle = usePinnedThreadTitle(storedPolicy(sub));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workflowNames = workflows.data?.workflows ?? [];
  const sentence = listenerSentence(sub, catalog.data?.catalog, workflowNames, pinTitle);
  const workspace = workspaceOf(sub);
  const pausedByTeam = !sub.enabled && sub.target.kind === "assistant" && sub.target.overlapPausedAt !== undefined;
  // Mirrors the server's mutation gate for a personal rule. A team or org
  // rule is checked by the server, which names the problem when it refuses.
  const readOnly = sub.ownerType === "user" && me.data !== undefined && sub.ownerId !== me.data.id;
  const workflowId = sub.target.kind === "workflow" ? sub.target.workflowId : undefined;
  const workflowName = workflowNames.find((w) => w.id === workflowId)?.name;

  function save(body: Parameters<typeof patch.mutate>[0]["body"]) {
    setError(null);
    patch.mutate({ id: sub.id, body }, { onError: (err) => setError(errorText(err)) });
  }

  return (
    <div className="space-y-8">
      <section aria-label="Listener" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-base text-ink [overflow-wrap:anywhere]">{sentence}</p>
          <ProblemBadge problem={sub.problem} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <Switch
              checked={sub.enabled}
              disabled={readOnly || patch.isPending}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label={`${sub.enabled ? "Turn off" : "Turn on"} ${sub.name}`}
            />
            {sub.enabled ? "On" : "Off"}
          </label>
          <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setEditing(true)}>Edit</Button>
        </div>
        {pausedByTeam && <p role="status" className="text-sm text-warning-fg">{PAUSED_BY_TEAM}</p>}
        {readOnly && !sub.problem && <p className="text-xs text-muted">Only its owner can change this listener.</p>}
        {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
        {sub.problem && (
          <ThreadProblem
            problem={sub.problem}
            ruleKind="listener"
            workspace={workspace}
            readOnly={readOnly}
            onPick={(thread) => save({ thread })}
            pending={patch.isPending}
          />
        )}
      </section>

      <AppearsAs sub={sub} />
      <ListenerDeliveries id={sub.id} />
      <ListenerReceipts id={sub.id} admin={me.data?.orgRole === "admin"} />

      {editing && (
        <EditSubscriptionDialog
          open
          onOpenChange={setEditing}
          sub={sub}
          targetLabel={targetLabel(sub, workflowName)}
        />
      )}
    </div>
  );
}

function AppearsAs({ sub }: { sub: EventSubscriptionWire }) {
  const appearance = sub.target.appearance ?? {};
  const custom = appearance.displayName?.trim();
  const name = custom || "Valet";
  return (
    <WorkSection title="Appears as">
      <WorkRow
        title={(
          <span className="inline-flex items-center gap-2">
            <Avatar size="sm">
              {appearance.avatarUrl && <AvatarImage src={appearance.avatarUrl} alt="" />}
              <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            {name}
          </span>
        )}
        detail={custom ? "To change it, select Edit." : "The default name. To set another, select Edit."}
      />
    </WorkSection>
  );
}

function ListenerDeliveries({ id }: { id: string }) {
  const deliveriesQ = useListenerDeliveries(id);
  const deliveries = deliveriesQ.data?.deliveries ?? [];
  return (
    <section aria-label="Deliveries">
      <h2 className="mb-3 font-display text-lg">Deliveries</h2>
      <div className={cn(cardClass, "px-4 py-3")}>
        {deliveriesQ.isPending && <LoadingRow />}
        {deliveriesQ.isError && (
          <ErrorRow>{errorText(deliveriesQ.error, "Could not load the deliveries. Reload the page to try again.")}</ErrorRow>
        )}
        {deliveriesQ.isSuccess && (
          <DeliveryList deliveries={deliveries} empty="This listener has no deliveries yet." />
        )}
      </div>
    </section>
  );
}

const DECISION_WORDS: Record<ReceiptSubscriptionDecision["outcome"], string> = {
  matched: "matched",
  filter_excluded: "excluded by this listener's filters",
  authorization_denied: "the sender may not use this listener",
  disabled: "the listener was off",
  key_mismatch: "a different event",
};

/** One receipt as a line: the event, then what this listener decided. */
export function receiptLine(receipt: EventReceiptWire, listenerId: string): string {
  const decision = receipt.subscriptions.find((d) => d.id === listenerId);
  const event = eventInWords(receipt.eventKey);
  return decision ? `${event} · ${DECISION_WORDS[decision.outcome]}` : event;
}

/** The receipt's last stage and its outcome in words, such as `Delivery queue: Delivery queued`. */
export function lastStageInWords(receipt: EventReceiptWire): string | undefined {
  const last = receipt.stages.at(-1);
  return last ? `${receiptLabel(last.stage)}: ${receiptLabel(last.outcome)}` : undefined;
}

function ListenerReceipts({ id, admin }: { id: string; admin: boolean }) {
  const receiptsQ = useListenerReceipts(id, admin);
  const receipts = receiptsQ.data?.receipts ?? [];
  return (
    <WorkSection title="Receipts">
      {!admin && <EmptyRow className="px-4 py-3">Receipts are available to organization administrators.</EmptyRow>}
      {admin && receiptsQ.isPending && <LoadingRow className="px-4" />}
      {admin && receiptsQ.isError && (
        <ErrorRow className="px-4">{errorText(receiptsQ.error, "Could not load the receipts. Reload the page to try again.")}</ErrorRow>
      )}
      {admin && receiptsQ.isSuccess && receipts.length === 0 && (
        <EmptyRow className="px-4 py-3">No receipt names this listener in the last 7 days.</EmptyRow>
      )}
      {receipts.map((receipt) => (
        <WorkRow
          key={receipt.id}
          time={receipt.createdAt}
          title={receipt.eventId
            ? <Link to="/presence/events/$eventId" params={{ eventId: receipt.eventId }}>{receiptLine(receipt, id)}</Link>
            : receiptLine(receipt, id)}
          detail={lastStageInWords(receipt)}
        />
      ))}
    </WorkSection>
  );
}
