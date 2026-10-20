/**
 * One line of presence on its own page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D). Its parts, in order: the breadcrumb, the sentence as the title
 * with the service mark, the status line (name, who set it up and when,
 * the switch, **Edit**, and the overflow menu with Appears as and Delete),
 * a proposal's review, the health strip, the problem with the thread
 * picker, How it works, Activity, and, for an organization admin,
 * Diagnostics.
 *
 * A line the assistant proposed shows its review above the health strip:
 * what turning it on turns off, **Turn on** (the editor in review
 * mode) and **Delete**. A viewer who may not change the line reads who may.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import type { EventSubscriptionWire, LineActivityEntryWire } from "@valet/api/wire";
import { useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import { useLineActivity } from "~/api/line-activity";
import { placeOfSubject, usePlaceSubject } from "~/api/presence";
import { usePinnedThreadTitle } from "~/api/rule";
import { useMe } from "~/api/settings";
import { useTriggerCatalog, useWorkflows } from "~/api/workflows";
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, ErrorRow, LoadingRow, Switch,
} from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { relativeTime } from "~/lib/relative-time";
import { selectsSlackMention } from "~/lib/slack-mention";
import { Diagnostics } from "./diagnostics";
import { LineEditor, type EditorMode } from "./editor/line-editor";
import type { SectionId } from "./editor/section";
import { staleProposalText, type StaleProposal } from "./editor/side-pane";
import { HealthStrip } from "./health-strip";
import { HowItWorks, type HowColumn } from "./how-it-works";
import { ActivityTimeline, type TimelineEntry } from "./line-activity";
import { MissingPage, PRESENCE_CRUMB, PresenceDetailPage, type PresenceCrumb } from "./page-shell";
import { DeleteLineDialog, PausedLine, TurnOnAnyway, switchFailure } from "./presence-line";
import { ThreadProblem, isPinProblem, pinProblemText } from "./problem-badge";
import {
  OwnerBadge, isProposal, lineWorkspace, pausedByTeam, pinnedTitle, storedPolicy, useLineAccess,
} from "./presence-rows";
import { Ref } from "./ref";
import { Sentence } from "./sentence";
import { ServiceMark } from "./service-mark";
import {
  deadErrorSentence, doExplanation, doParts, lineEntryParts, partsText, presenceSentenceParts, presenceWhenParts, replies, tookInWords,
  whenExplanation, whereExplanation, whereParts, type LineEntryNames, type SentencePart, type SentenceService, type ThreadTitles,
  type WorkflowNames,
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
      // The label when known, else the raw id, as the title's place token reads.
      return { label: filter.label?.trim() || value, key: `slack:${value}` };
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

/** The service a line listens to, for its title's mark. */
function lineService(sub: EventSubscriptionWire): SentenceService | null {
  for (const key of sub.eventKeys) {
    const prefix = key.split(".", 1)[0];
    if (prefix === "slack" || prefix === "github" || prefix === "linear") return prefix;
  }
  return null;
}

/** How it works for a line: When, Do, and Where, each with its explanation (spec Part D step 1.6). */
export function lineColumns(
  sub: EventSubscriptionWire,
  whenParts: readonly SentencePart[],
  workflows: WorkflowNames,
  threads: ThreadTitles,
): HowColumn[] {
  const subjectKind = subjectKindForKeys(sub.eventKeys);
  const where: HowColumn = sub.target.kind === "workflow"
    ? { section: "where", value: [{ kind: "text", text: "in a workflow run" }], explanation: "A workflow run has no thread. Open the run from Activity to follow it." }
    : (() => {
      const policy = displayThreadPolicy(sub.target, sub.eventKeys);
      return { section: "where", value: whereParts(policy, subjectKind, threads), explanation: whereExplanation(policy, subjectKind, "presence", { mention: selectsSlackMention(sub.eventKeys) }) };
    })();
  return [
    { section: "when", value: whenParts, explanation: whenExplanation(sub.filters, sub.eventKeys) },
    { section: "do", value: doParts(sub, workflows), explanation: doExplanation(sub, workflows) },
    where,
  ];
}

/** The right column of a dead entry: `gave up` for an archived pin, whose
 * left text names the thread, else the error once, as a sentence. */
function deadColumn(entry: LineActivityEntryWire, names: LineEntryNames): string | undefined {
  const text = entry.outcome?.deadText;
  if (text !== undefined && names.isPinText?.(text) === true) return "gave up";
  return deadErrorSentence(text) ?? undefined;
}

/** One entry of the line's Activity, ready for the timeline. */
export function lineTimelineEntry(entry: LineActivityEntryWire, names: LineEntryNames): TimelineEntry {
  const dead = entry.kind === "acted" && entry.outcome?.status === "dead";
  const took = dead ? deadColumn(entry, names) : entry.kind === "acted" && entry.tookMs !== undefined ? tookInWords(entry.tookMs) : undefined;
  return {
    id: entry.id,
    kind: entry.kind,
    at: entry.at,
    parts: lineEntryParts(entry, names),
    ...(took !== undefined ? { took } : {}),
    ...(dead ? { tookDanger: true } : {}),
  };
}

/** The fault the health strip names: the archived pin, or the problem as written. */
function lineFault(problem: string | undefined, pinTitle: string | undefined): { title: string; detail: string } | undefined {
  if (problem === undefined || problem.length === 0) return undefined;
  const detail = isPinProblem(problem) ? pinProblemText(pinTitle).replace(/ Pick another thread:$/, "").replace(/\.$/, "") : problem;
  return { title: "Needs attention", detail };
}

function RuleBody({ sub, subs }: { sub: EventSubscriptionWire; subs: readonly EventSubscriptionWire[] }) {
  const catalog = useTriggerCatalog();
  const workflows = useWorkflows();
  const me = useMe();
  const navigate = useNavigate();
  const patch = usePatchEventSubscription();
  const pinTitles = usePinnedThreadTitle(storedPolicy(sub));
  const names = useSentenceNames();
  const activityQ = useLineActivity(sub.id);
  const place = linePlace(sub);
  const placeKey = usePlaceSubject(place?.key ?? "");
  const { readOnly, readOnlyText, teams } = useLineAccess(sub);
  // What the editor opens on, or null while it is closed.
  const [editing, setEditing] = useState<{ review: boolean; section?: SectionId } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collision, setCollision] = useState<string | null>(null);

  const workflowNames = workflows.data?.workflows ?? [];
  const sentenceParts = presenceSentenceParts(sub, catalog.data?.catalog, workflowNames, pinTitles, names);
  const sentence = partsText(sentenceParts);
  const proposal = isProposal(sub);
  const replacesId = sub.target.kind === "assistant" ? sub.target.replaces : undefined;
  const replaced = replacesId === undefined ? undefined : subs.find((other) => other.id === replacesId);
  // The line a proposal replaces was deleted or turned off: Turn on would
  // fail (the api refuses it), so the review offers Delete only.
  const staleProposal: StaleProposal | undefined = replacesId === undefined || replaced?.enabled === true
    ? undefined
    : replaced === undefined ? { kind: "gone" } : { kind: "off", name: replaced.name };
  const workflowId = sub.target.kind === "workflow" ? sub.target.workflowId : undefined;
  const workflowName = workflowNames.find((w) => w.id === workflowId)?.name;
  const pinTitle = pinnedTitle(sub, pinTitles);
  const fault = lineFault(sub.problem, pinTitle);
  const service = lineService(sub);
  const creator = names.members?.[sub.createdBy] ?? "someone";
  // `Presence`, then the line's place when it has one place, then the line.
  const crumbs: PresenceCrumb[] = place === null
    ? [PRESENCE_CRUMB, { label: sub.name }]
    : [PRESENCE_CRUMB, { label: place.label, to: "/presence/places/$subject", params: { subject: placeKey } }, { label: sub.name }];

  const pages = activityQ.data?.pages ?? [];
  const first = pages[0];
  const entryNames: LineEntryNames = {
    ...(workflowId !== undefined && workflowName !== undefined ? { workflow: { id: workflowId, name: workflowName } } : {}),
    ...(pinTitle !== undefined ? { pinTitle } : {}),
    isPinText: isPinProblem,
    replies: replies(sub),
  };
  const entries = pages.flatMap((page) => page.entries).map((entry) => lineTimelineEntry(entry, entryNames));
  const columns = lineColumns(
    sub,
    withPlaceKey(presenceWhenParts(sub, catalog.data?.catalog, names), place?.key, placeKey),
    workflowNames,
    pinTitles,
  );

  function save(body: Parameters<typeof patch.mutate>[0]["body"]) {
    setError(null);
    setCollision(null);
    patch.mutate({ id: sub.id, body }, { onError: switchFailure(body, setError, setCollision) });
  }

  const editorMode: EditorMode = editing?.review === true
    ? { kind: "review", line: sub, ...(replaced !== undefined ? { replaces: { id: replaced.id, name: replaced.name } } : {}) }
    : { kind: "edit", line: sub, ...(editing?.section !== undefined ? { initialSection: editing.section } : {}) };

  return (
    <PresenceDetailPage
      crumbs={crumbs}
      title={sentence}
      titleContent={<Sentence parts={withPlaceKey(sentenceParts, place?.key, placeKey)} />}
      {...(service !== null ? { mark: <ServiceMark service={service} size="lg" /> } : {})}
    >
      <div className="space-y-8">
        <section aria-label={sub.name} className="space-y-5">
          <div className="-mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-sm text-muted">
            <span className="font-medium text-ink">{sub.name}</span>
            <OwnerBadge ownerType={sub.ownerType} />
            <span>set up by <Ref kind="person" text={creator} /> {relativeTime(sub.createdAt)}</span>
            {!proposal && (
              <label className="inline-flex min-h-11 items-center gap-2 text-ink sm:min-h-0">
                <Switch
                  checked={sub.enabled}
                  disabled={readOnly || patch.isPending}
                  onCheckedChange={(enabled) => save({ enabled })}
                  aria-label={`${sub.enabled ? "Turn off" : "Turn on"} ${sub.name}`}
                />
                {sub.enabled ? "On" : "Off"}
              </label>
            )}
            <span className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setEditing({ review: false })}>Edit</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" aria-label={`More for ${sub.name}`}>
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={readOnly} onSelect={() => setEditing({ review: false, section: "appears" })}>Appears as</DropdownMenuItem>
                  {!proposal && (
                    <DropdownMenuItem disabled={readOnly} className="text-danger-500" onSelect={() => setDeleting(true)}>
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
          {readOnly && !sub.problem && !proposal && <p className="text-xs text-muted">{readOnlyText}</p>}
          {pausedByTeam(sub) && <PausedLine sub={sub} teams={teams} readOnly={readOnly} />}
          {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
          {collision !== null && !sub.enabled && (
            <TurnOnAnyway text={collision} pending={patch.isPending} onTurnOn={() => save({ enabled: true, allowCollision: true })} />
          )}

          {proposal && (
            <section aria-label="Proposal" className="space-y-2 rounded-md border border-line px-3 py-2.5">
              <p className="text-sm text-ink">Proposed by the assistant.</p>
              {staleProposal !== undefined && <p className="text-sm text-ink">{staleProposalText(staleProposal)}</p>}
              {staleProposal === undefined && replaced !== undefined && (
                <p className="text-sm text-ink">
                  Turning it on turns off{" "}
                  <Ref kind="line" text={replaced.name} to="/presence/rules/$id" params={{ id: replaced.id }} />.
                </p>
              )}
              {readOnly
                ? <p className="text-xs text-muted">{readOnlyText}</p>
                : (
                  <div className="flex flex-wrap gap-2">
                    {staleProposal === undefined && <Button size="sm" onClick={() => setEditing({ review: true })}>Turn on</Button>}
                    <Button size="sm" variant={staleProposal !== undefined ? "primary" : "secondary"} onClick={() => setDeleting(true)}>Delete</Button>
                  </div>
                )}
            </section>
          )}

          {first !== undefined && (
            <HealthStrip
              lastAt={first.lastActedAt}
              count={first.actedLast30Days}
              perDay={first.perDay}
              {...(fault !== undefined ? { fault } : {})}
              labels={{ last: "last acted" }}
            />
          )}

          {sub.problem && (
            <ThreadProblem
              problem={sub.problem}
              threadTitle={pinTitle}
              workspace={lineWorkspace(sub)}
              readOnly={readOnly}
              readOnlyText={readOnlyText}
              onPick={(thread) => save({ thread })}
              pending={patch.isPending}
            />
          )}
        </section>

        <HowItWorks columns={columns} readOnly={readOnly} onChange={(section) => setEditing({ review: false, section })} />

        <ActivityTimeline
          entries={entries}
          pending={activityQ.isPending}
          {...(activityQ.isError
            ? { error: errorText(activityQ.error, "Could not load the activity. Reload the page to try again.") }
            : {})}
          hasMore={activityQ.hasNextPage}
          loadingMore={activityQ.isFetchingNextPage}
          onShowEarlier={() => { void activityQ.fetchNextPage(); }}
        />

        {me.data?.orgRole === "admin" && <Diagnostics id={sub.id} name={sub.name} />}

        <LineEditor
          open={editing !== null}
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          mode={editorMode}
          // The line itself refetches with the subscription list; the
          // Activity refetches here so the change reads at once.
          onSaved={() => { void activityQ.refetch(); }}
        />
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
