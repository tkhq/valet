/**
 * One routine's page (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 2). It follows the line page's anatomy: the breadcrumb, the sentence
 * as the title with the clock mark, the status line (name, who set it up,
 * the switch, when it fires next, **Fire now**, **Edit**, and the overflow
 * menu with Delete), the health strip, the problem, How it works, and
 * Activity as its firings.
 *
 * A routine that runs a workflow reads its firings from the workflow's runs
 * this routine started. An assistant routine records only when it last
 * fired, so its Activity holds that one firing and its strip shows no
 * count. A routine the scheduler turned off for an archived thread shows its
 * problem with the thread picker inline; a pick repins the routine and
 * turns it on again. Edit's **Where** lists the routine owner's threads.
 */
import { useState } from "react";
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
import { LineEditor } from "./editor/line-editor";
import type { SectionId } from "./editor/section";
import { HealthStrip, perDayCounts } from "./health-strip";
import { HowItWorks, type HowColumn } from "./how-it-works";
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
import {
  firingParts, partsText, routineDoExplanation, routineDoParts, scheduleExplanation, scheduleInWords, text, tookInWords,
  whereExplanation, whereParts, type ThreadTitles, type WorkflowNames,
} from "./sentences";
import { ServiceMark } from "./service-mark";
import { useSentenceNames } from "./use-sentence-names";

/** The run id prefix the scheduler gives a routine's runs. The scheduler
 * mints its run ids from the same function (`scheduledRunId`). */
export { scheduleRunPrefix };

export { routineReadOnly } from "./routine-helpers";

const MONTH_MS = 30 * 86_400_000;

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

/** How it works for a routine: When (the schedule and its zone), Do, and Where (spec Part E step 2). */
export function routineColumns(routine: Routine, workflows: WorkflowNames, threads: ThreadTitles): HowColumn[] {
  const policy = routine.detail.thread ?? { mode: "own" };
  const where: HowColumn = routine.detail.targetKind === "workflow"
    ? { section: "where", value: [text("in a workflow run")], explanation: "A workflow run has no thread. Open the run from Activity to follow it." }
    : { section: "where", value: whereParts(policy, null, threads), explanation: whereExplanation(policy, null, "routine") };
  return [
    { section: "when", value: [text(scheduleInWords(routine.detail.cron, routine.detail.timezone))], explanation: scheduleExplanation(routine.detail.timezone) },
    { section: "do", value: routineDoParts(routine, workflows), explanation: routineDoExplanation(routine, workflows) },
    where,
  ];
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
  // The section the editor opens on, "form" for none, or null while it is closed.
  const [editing, setEditing] = useState<SectionId | "form" | null>(null);
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
  const now = Date.now();
  const times = workflowRoutine ? runs.map((run) => run.createdAt) : lastFired === null ? [] : [lastFired];
  const newestRun = runs.reduce<number | null>((max, run) => (max === null || run.createdAt > max ? run.createdAt : max), null);
  const lastAt = lastFired !== null && (newestRun === null || lastFired > newestRun) ? lastFired : newestRun;
  const fault = routineFault(routine.detail.disabledReason, pinThreadTitle);

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
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={readOnly || fire.isPending} onClick={fireNow}>Fire now</Button>
            <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setEditing("form")}>Edit</Button>
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
            count={workflowRoutine ? runs.filter((run) => now - run.createdAt < MONTH_MS).length : null}
            perDay={perDayCounts(times, now)}
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
            action={readOnly ? undefined : (
              <Button size="sm" variant="secondary" onClick={() => setEditing("form")}>Edit the routine</Button>
            )}
            pending={update.isPending}
          />
        )}
      </section>

      <HowItWorks columns={routineColumns(routine, workflowNames, pinTitles)} readOnly={readOnly} onChange={(section) => setEditing(section)} />

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

      <LineEditor
        open={editing !== null}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        mode={{ kind: "edit-routine", routine, ...(editing !== null && editing !== "form" ? { initialSection: editing } : {}) }}
      />
      <DeleteRoutineDialog
        routine={routine}
        teams={teams.data?.teams}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => { void navigate({ to: "/presence" }); }}
      />
    </div>
  );
}
