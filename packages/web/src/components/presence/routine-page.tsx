/**
 * One routine's page (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 2). It follows the line page's anatomy: the breadcrumb, the sentence
 * as the title with the clock mark, the status line (name, who set it up,
 * the switch, when it fires next, **Fire now**, and the overflow menu with
 * Delete), the health strip, the problem, How it works as the editor with
 * every section open, and Activity as its firings.
 *
 * A routine that runs a workflow reads its firings from the workflow's runs
 * this routine started. An assistant routine records only when it last
 * fired and the thread that firing landed on, so its Activity holds that
 * one firing and its strip shows no count. The title, Where, and the firing
 * link that thread when the viewer may open it. A routine the scheduler turned off for an archived thread shows its
 * problem with the thread picker inline; a pick repins the routine and
 * turns it on again. **Where** lists the routine owner's threads.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import type { WorkflowRunSummary } from "@valet/api/wire";
import { scheduleRunPrefix } from "@valet/shared";
import { usePinnedThreadTitle } from "~/api/rule";
import { useMe, useTeams } from "~/api/settings";
import { useRunScheduleNow, useUpdateSchedule, useWorkflowRuns, useWorkflowTriggers, useWorkflows } from "~/api/workflows";
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, ErrorRow, LoadingRow, Switch,
} from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { InlineEditor } from "./editor/inline-editor";
import { HealthStrip, perDayCounts } from "./health-strip";
import { ActivityTimeline, type TimelineEntry } from "./line-activity";
import { MissingPage, PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";
import { OwnerBadge } from "./presence-rows";
import { ThreadProblem, isPinProblem, pinProblemText } from "./problem-badge";
import { Ref } from "./ref";
import {
  isRoutine, routineReadOnly, routineReadOnlyText, routineWhen, routineWorkspace, useRoutineSentenceParts, type Routine,
} from "./routine-helpers";
import { DeleteRoutineDialog } from "./routine-row";
import { Sentence } from "./sentence";
import { firingParts, partsText, tookInWords, type ThreadTitles, type WorkflowNames } from "./sentences";
import { ServiceMark } from "./service-mark";
import { useSentenceNames } from "./use-sentence-names";

/** The run id prefix the scheduler gives a routine's runs. The scheduler
 * mints its run ids from the same function (`scheduledRunId`). */
export { scheduleRunPrefix };

export { routineReadOnly } from "./routine-helpers";

export function RoutinePage({ id }: { id: string }) {
  // Unscoped, so a routine of another workspace the caller can reach still opens.
  const triggersQ = useWorkflowTriggers();
  const routine = (triggersQ.data?.triggers ?? []).filter(isRoutine).find((r) => r.id === id);
  const sentenceFor = useRoutineSentenceParts(routine === undefined ? [] : [routine]);
  const name = routine?.name ?? "Routine";
  return (
    <PresenceDetailPage
      crumbs={[PRESENCE_CRUMB, { label: "On a schedule", to: "/presence", hash: "schedule" }, { label: name }]}
      title={routine === undefined ? name : partsText(sentenceFor(routine))}
      {...(routine !== undefined
        ? { titleContent: <Sentence parts={sentenceFor(routine)} />, mark: <ServiceMark service="schedule" size="lg" /> }
        : {})}
    >
      {triggersQ.isPending && <LoadingRow />}
      {triggersQ.isError && (
        <ErrorRow>{errorText(triggersQ.error, "Could not load this routine. Reload the page to try again.")}</ErrorRow>
      )}
      {triggersQ.isSuccess && routine === undefined && <MissingPage />}
      {routine !== undefined && <RoutineBody routine={routine} />}
    </PresenceDetailPage>
  );
}

/** A run this routine started, as a firing on its Activity. A settled run shows the time it took. */
export function runFiring(run: WorkflowRunSummary, routine: Routine, workflows: WorkflowNames, threads: ThreadTitles): TimelineEntry {
  const settled = run.status === "settled" && run.updatedAt >= run.createdAt;
  return {
    id: run.runId,
    kind: "acted",
    at: run.createdAt,
    parts: firingParts(routine, workflows, threads),
    ...(settled ? { took: tookInWords(run.updatedAt - run.createdAt) } : {}),
  };
}

/** The fault the health strip names: the archived pin, or the scheduler's reason as written. */
function routineFault(reason: string | undefined, pinTitle: string | undefined): { title: string; detail: string } | undefined {
  if (reason === undefined || reason.length === 0) return undefined;
  const detail = isPinProblem(reason) ? pinProblemText(pinTitle).replace(/ Pick another thread:$/, "").replace(/\.$/, "") : reason;
  return { title: "Needs attention", detail };
}

/**
 * True after the routine's pin problem clears while the routine stays off.
 * A new pin from the editor answers the pin reason but leaves the routine
 * off (api `patchAnswersReason`), so the page asks the reader to turn it
 * on. It reads the transition of the props, so it starts false and turns
 * false again once the routine is on.
 */
function useRepinnedWhileOff(reason: string | undefined, enabled: boolean): boolean {
  const [repinned, setRepinned] = useState(false);
  const previous = useRef(reason);
  useEffect(() => {
    const before = previous.current;
    previous.current = reason;
    if (enabled) setRepinned(false);
    else if (isPinProblem(before) && (reason === undefined || reason.length === 0)) setRepinned(true);
  }, [reason, enabled]);
  return repinned && !enabled;
}

function RoutineBody({ routine }: { routine: Routine }) {
  const workflows = useWorkflows();
  const pin = routine.detail.thread?.mode === "existing" ? routine.detail.thread : undefined;
  const pinTitles = usePinnedThreadTitle(pin);
  const pinThreadTitle = pin ? pinTitles[pin.threadId]?.title ?? undefined : undefined;
  const fire = useRunScheduleNow();
  const update = useUpdateSchedule();
  const me = useMe();
  const teams = useTeams();
  const names = useSentenceNames();
  const navigate = useNavigate();
  const readOnly = routineReadOnly(routine, me.data, teams.data?.teams);
  const readOnlyText = routineReadOnlyText(routine, teams.data?.teams);
  const workspace = routineWorkspace(routine);
  const workflowRoutine = routine.detail.targetKind === "workflow" && routine.workflowId !== undefined;
  const runsQ = useWorkflowRuns(workflowRoutine ? routine.workflowId ?? "" : "", { limit: 50 });
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const workflowNames = workflows.data?.workflows ?? [];
  // A personal routine's owner set it up. The api records no creator for a team routine.
  const owner = routine.detail.ownerType === "user" ? names.members?.[routine.detail.ownerId] ?? "someone" : undefined;

  const prefix = scheduleRunPrefix(routine.id);
  const runs = workflowRoutine ? (runsQ.data?.runs ?? []).filter((run) => run.runId.startsWith(prefix)) : [];
  const lastFired = routine.detail.lastFiredAt;
  const firings: TimelineEntry[] = workflowRoutine
    ? runs.map((run) => runFiring(run, routine, workflowNames, pinTitles))
    : lastFired === null
      ? []
      : [{ id: `fired:${lastFired}`, kind: "acted", at: lastFired, parts: firingParts(routine, workflowNames, pinTitles) }];
  const times = workflowRoutine ? runs.map((run) => run.createdAt) : lastFired === null ? [] : [lastFired];
  // The count is the sum of the bars, so the two always agree.
  const perDay = perDayCounts(times, Date.now());
  const newestRun = runs.reduce<number | null>((max, run) => (max === null || run.createdAt > max ? run.createdAt : max), null);
  const lastAt = lastFired !== null && (newestRun === null || lastFired > newestRun) ? lastFired : newestRun;
  const fault = routineFault(routine.detail.disabledReason, pinThreadTitle);
  const repinned = useRepinnedWhileOff(routine.detail.disabledReason, routine.enabled);

  function fireNow() {
    setMessage(null);
    fire.mutate(routine.id, {
      onSuccess: () => setMessage({ text: "Fired. The routine runs now.", error: false }),
      onError: (err) => setMessage({ text: errorText(err), error: true }),
    });
  }

  function save(body: Parameters<typeof update.mutate>[0]["body"]) {
    setMessage(null);
    update.mutate({ id: routine.id, body }, { onError: (err) => setMessage({ text: errorText(err), error: true }) });
  }

  return (
    <div className="space-y-8">
      <section aria-label={routine.name} className="space-y-5">
        <div className="-mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-sm text-muted">
          <span className="font-medium text-ink">{routine.name}</span>
          <OwnerBadge ownerType={routine.detail.ownerType} />
          {owner !== undefined && <span>set up by <Ref kind="person" text={owner} /></span>}
          <label className="inline-flex min-h-11 items-center gap-2 text-ink sm:min-h-0">
            <Switch
              checked={routine.enabled}
              disabled={readOnly || update.isPending}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`}
            />
            {routine.enabled ? "On" : "Off"}
          </label>
          {routine.enabled && <span>{routineWhen(routine, ": ")}</span>}
          {repinned && <span role="status" className="text-ink">Pinned. Turn the routine on to resume.</span>}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={readOnly || fire.isPending} onClick={fireNow}>Fire now</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={`More for ${routine.name}`}>
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={readOnly} className="text-danger-500" onSelect={() => setDeleting(true)}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        {readOnly && !routine.detail.disabledReason && <p className="text-xs text-muted">{readOnlyText}</p>}
        {message && (
          <p role={message.error ? "alert" : "status"} className={message.error ? "text-sm text-danger-500" : "text-sm text-muted"}>
            {message.text}
          </p>
        )}

        {(!workflowRoutine || runsQ.isSuccess) && (
          <HealthStrip
            lastAt={lastAt}
            count={workflowRoutine ? perDay.reduce((sum, n) => sum + n, 0) : null}
            perDay={perDay}
            {...(fault !== undefined ? { fault } : {})}
            labels={{ last: "last fired" }}
          />
        )}

        {routine.detail.disabledReason && (
          <ThreadProblem
            problem={routine.detail.disabledReason}
            threadTitle={pinThreadTitle}
            workspace={workspace}
            readOnly={readOnly}
            readOnlyText={readOnlyText}
            onPick={(thread) => save({ thread, enabled: true })}
            pending={update.isPending}
          />
        )}
      </section>

      <InlineEditor mode={{ kind: "edit-routine", routine }} readOnly={readOnly} />

      <ActivityTimeline
        entries={firings}
        chips={false}
        pending={workflowRoutine && runsQ.isPending}
        {...(workflowRoutine && runsQ.isError
          ? { error: errorText(runsQ.error, "Could not load the runs. Reload the page to try again.") }
          : {})}
        empty={workflowRoutine
          ? "Nothing yet. This routine has not started a run in the workflow's last 50 runs."
          : "Nothing yet. Activity appears here when the routine fires."}
      />

      <DeleteRoutineDialog
        routine={routine}
        teams={teams.data?.teams}
        open={deleting}
        onOpenChange={setDeleting}
        // The routine is gone, so the inline form's unsaved change has
        // nothing to save into, and its leave guard must not hold the page.
        onDeleted={() => { void navigate({ to: "/presence", ignoreBlocker: true }); }}
      />
    </div>
  );
}
