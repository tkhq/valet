/**
 * One line of presence on its own page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D): a breadcrumb to its place, the sentence as the title, a fact
 * strip (When, Do, Runs in, Appears as) with **Edit** (the existing dialog,
 * where **Runs in** is editable) and **Delete**, enable or disable, the
 * problem with the thread picker, the delivery list, and, for an
 * administrator, this line's receipts under a disclosure.
 *
 * A line the assistant proposed opens with its review: what turning it on
 * turns off, **Turn on** (the edit dialog in review mode) and **Delete**.
 * A viewer who may not change the line reads who may.
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { EventReceiptWire, EventSubscriptionWire, ReceiptSubscriptionDecision } from "@valet/api/wire";
import { useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import { placeOfSubject, usePlaceSubject } from "~/api/presence";
import {
  useRuleDeliveries,
  useRuleReceipts,
  usePinnedThreadTitle,
} from "~/api/rule";
import { useMe } from "~/api/settings";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import { DeliveryList } from "~/components/events/delivery-list";
import { EditSubscriptionDialog } from "~/components/events/edit-subscription-dialog";
import { receiptLabel } from "~/components/events/receipts-panel";
import {
  Button, EmptyRow, ErrorRow, LoadingRow, Switch, WorkRow, WorkList, cardClass,
} from "~/components/primitives";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { MissingPage, PRESENCE_CRUMB, PresenceDetailPage, type PresenceCrumb } from "./page-shell";
import { DeleteLineDialog, PausedLine } from "./presence-line";
import { ThreadProblem } from "./problem-badge";
import {
  OwnerBadge, isProposal, lineWorkspace, pausedByTeam, pinnedTitle, storedPolicy, targetLabel, useLineAccess,
} from "./presence-rows";
import { Ref } from "./ref";
import { Sentence } from "./sentence";
import {
  eventInWords, partsText, presenceAction, presenceSentenceParts, runsInLabel, type SentencePart, type ThreadTitles, type WorkflowNames,
} from "./sentences";
import { displayThreadPolicy, subjectKindForKeys } from "./thread-policy-copy";
import { useSentenceNames } from "./use-sentence-names";

/** The one place a line names in its filters, as a crumb label and a place
 * key. Null when no filter names exactly one place. A Slack channel filter
 * carries no Slack workspace id, so its key is `slack:<channel>`, and the
 * places list resolves it (`usePlaceSubject`). */
export function linePlace(sub: EventSubscriptionWire): { label: string; key: string } | null {
  for (const field of ["channel", "repo", "team"] as const) {
    const filter = sub.filters.find((f) => f.field === field && f.op === "eq");
    if (filter === undefined || typeof filter.value !== "string" || filter.value.length === 0) continue;
    const value = filter.value;
    if (field === "channel") {
      return { label: filter.label?.trim() || `#${value}`, key: `slack:${value}` };
    }
    const key = field === "repo" ? placeOfSubject(`github:${value}`) : placeOfSubject(`linear:team/${value}`);
    return key === null ? null : { label: value, key };
  }
  return null;
}

/** The parts with the line's own place token pointed at the resolved place
 * key, because a Slack channel filter names no Slack workspace. */
function withPlaceKey(parts: readonly SentencePart[], filterKey: string | undefined, resolved: string): SentencePart[] {
  if (filterKey === undefined || resolved === "") return [...parts];
  return parts.map((part) => (part.kind === "place" && part.subject === filterKey ? { ...part, subject: resolved } : part));
}

export function RulePage({ id }: { id: string }) {
  const subsQ = useEventSubscriptions();
  const sub = subsQ.data?.subscriptions.find((s) => s.id === id);
  if (sub !== undefined) return <RuleBody sub={sub} subs={subsQ.data?.subscriptions ?? []} />;
  const title = subsQ.isPending ? "Loading…" : "Not available";
  return (
    <PresenceDetailPage crumbs={[PRESENCE_CRUMB, { label: title }]} title={title}>
      {subsQ.isPending && <LoadingRow />}
      {subsQ.isError && (
        <ErrorRow>{errorText(subsQ.error, "Could not load this page. Reload the page to try again.")}</ErrorRow>
      )}
      {subsQ.isSuccess && <MissingPage />}
    </PresenceDetailPage>
  );
}

/** The fact strip's values (spec Part D step 1). Do names the action and
 * Runs in names the thread, so the strip says each fact once; the title
 * holds the whole sentence. */
function lineFacts(
  sub: EventSubscriptionWire,
  workflows: WorkflowNames,
  threads: ThreadTitles,
): readonly { term: string; value: string }[] {
  const facts = [
    { term: "When", value: sub.eventKeys.map((key) => eventInWords(key)).join(" or ") },
    { term: "Do", value: presenceAction(sub, workflows) },
  ];
  // A workflow target starts a run, not a thread, so it has no Runs in.
  if (sub.target.kind === "assistant") {
    const policy = displayThreadPolicy(sub.target, sub.eventKeys);
    facts.push({
      term: "Runs in",
      value: runsInLabel(policy, subjectKindForKeys(sub.eventKeys), "presence", pinnedTitle(sub, threads)),
    });
  }
  facts.push({ term: "Appears as", value: sub.target.appearance?.displayName?.trim() || "Valet" });
  return facts;
}

function RuleBody({ sub, subs }: { sub: EventSubscriptionWire; subs: readonly EventSubscriptionWire[] }) {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const me = useMe();
  const navigate = useNavigate();
  const patch = usePatchEventSubscription();
  const pinTitles = usePinnedThreadTitle(storedPolicy(sub));
  const names = useSentenceNames();
  const place = linePlace(sub);
  const placeKey = usePlaceSubject(place?.key ?? "");
  const { readOnly, readOnlyText, teams } = useLineAccess(sub);
  const [editing, setEditing] = useState<"edit" | "review" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workflowNames = workflows.data?.workflows ?? [];
  const sentenceParts = presenceSentenceParts(sub, catalog.data?.catalog, workflowNames, pinTitles, names);
  const sentence = partsText(sentenceParts);
  const proposal = isProposal(sub);
  const replacesId = sub.target.kind === "assistant" ? sub.target.replaces : undefined;
  const replaced = replacesId === undefined ? undefined : subs.find((other) => other.id === replacesId);
  const workflowId = sub.target.kind === "workflow" ? sub.target.workflowId : undefined;
  const workflowName = workflowNames.find((w) => w.id === workflowId)?.name;
  // `Presence`, then the line's place when it has one place, then the line.
  const crumbs: PresenceCrumb[] = place === null
    ? [PRESENCE_CRUMB, { label: sub.name }]
    : [PRESENCE_CRUMB, { label: place.label, to: "/presence/places/$subject", params: { subject: placeKey } }, { label: sub.name }];

  function save(body: Parameters<typeof patch.mutate>[0]["body"]) {
    setError(null);
    patch.mutate({ id: sub.id, body }, { onError: (err) => setError(errorText(err)) });
  }

  return (
    <PresenceDetailPage crumbs={crumbs} title={sentence} titleContent={<Sentence parts={withPlaceKey(sentenceParts, place?.key, placeKey)} />}>
      <div className="space-y-8">
        {proposal && (
          <section aria-label="Proposal" className="space-y-2 rounded-md border border-line px-3 py-2.5">
            <p className="text-sm text-ink">Proposed by the assistant.</p>
            {replaced !== undefined && (
              <p className="text-sm text-ink">
                Turning it on turns off{" "}
                <Ref kind="line" text={replaced.name} to="/presence/rules/$id" params={{ id: replaced.id }} />.
              </p>
            )}
            {readOnly
              ? <p className="text-xs text-muted">{readOnlyText}</p>
              : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setEditing("review")}>Turn on</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDeleting(true)}>Delete</Button>
                </div>
              )}
          </section>
        )}
        <section aria-label={sub.name} className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <dl aria-label="Facts" className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              {lineFacts(sub, workflowNames, pinTitles).map((fact) => (
                <div key={fact.term} className="contents">
                  <dt className="text-muted">{fact.term}</dt>
                  <dd className="text-ink [overflow-wrap:anywhere]">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <OwnerBadge ownerType={sub.ownerType} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setEditing("edit")}>Edit</Button>
              {!proposal && (
                <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setDeleting(true)}>Delete</Button>
              )}
            </div>
          </div>
          {!proposal && (
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <Switch
                checked={sub.enabled}
                disabled={readOnly || patch.isPending}
                onCheckedChange={(enabled) => save({ enabled })}
                aria-label={`${sub.enabled ? "Turn off" : "Turn on"} ${sub.name}`}
              />
              {sub.enabled ? "On" : "Off"}
            </label>
          )}
          {pausedByTeam(sub) && <PausedLine sub={sub} teams={teams} readOnly={readOnly} />}
          {readOnly && !sub.problem && !proposal && <p className="text-xs text-muted">{readOnlyText}</p>}
          {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
          {sub.problem && (
            <ThreadProblem
              problem={sub.problem}
              threadTitle={pinnedTitle(sub, pinTitles)}
              workspace={lineWorkspace(sub)}
              readOnly={readOnly}
              readOnlyText={readOnlyText}
              onPick={(thread) => save({ thread })}
              pending={patch.isPending}
            />
          )}
        </section>

        <RuleDeliveries id={sub.id} name={sub.name} />
        {me.data?.orgRole === "admin" && <RuleReceipts id={sub.id} name={sub.name} />}

        {editing !== null && (
          <EditSubscriptionDialog
            open
            onOpenChange={(open) => { if (!open) setEditing(null); }}
            sub={sub}
            targetLabel={targetLabel(sub, workflowName)}
            review={editing === "review"}
            replacesNote={editing === "review" ? replaced?.name : undefined}
            names={names}
            threadTitles={pinTitles}
            workflows={workflowNames}
          />
        )}
        <DeleteLineDialog
          sub={sub}
          teams={teams}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => { void navigate({ to: "/presence" }); }}
        />
      </div>
    </PresenceDetailPage>
  );
}

function RuleDeliveries({ id, name }: { id: string; name: string }) {
  const deliveriesQ = useRuleDeliveries(id);
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
          <DeliveryList deliveries={deliveries} empty={`${name} has no deliveries yet.`} />
        )}
      </div>
    </section>
  );
}

const DECISION_WORDS: Record<ReceiptSubscriptionDecision["outcome"], string> = {
  matched: "matched",
  filter_excluded: "excluded by its filters",
  authorization_denied: "the sender may not use it",
  disabled: "it was off",
  key_mismatch: "a different event",
};

/** One receipt as a line: the event, then what this line of presence decided. */
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

/** This line's receipts, for an administrator, under a closed disclosure. */
function RuleReceipts({ id, name }: { id: string; name: string }) {
  const receiptsQ = useRuleReceipts(id, true);
  const receipts = receiptsQ.data?.receipts ?? [];
  return (
    <details className="group">
      <summary className="cursor-pointer font-display text-lg">Receipts</summary>
      <div className="mt-3">
        <WorkList>
          {receiptsQ.isPending && <LoadingRow className="px-4" />}
          {receiptsQ.isError && (
            <ErrorRow className="px-4">{errorText(receiptsQ.error, "Could not load the receipts. Reload the page to try again.")}</ErrorRow>
          )}
          {receiptsQ.isSuccess && receipts.length === 0 && (
            <EmptyRow className="px-4 py-3">No receipt names {name} in the last 7 days.</EmptyRow>
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
        </WorkList>
      </div>
    </details>
  );
}
